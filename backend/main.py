"""FastAPI application — HTTP API layer for AutoResearcher.

Exposes five endpoints:
    POST   /api/research                     Start a new research session
    GET    /api/research/{session_id}/stream  SSE stream of pipeline events
    DELETE /api/research/{session_id}         Cancel a running session
    GET    /api/research/{session_id}/report  Fetch the final report
    GET    /api/health                        Service health check

Session state lives in memory (v1 limitation — documented in CLAUDE.md).
Pipelines run in background threads because LangGraph's invoke is synchronous
and our LLM calls are sync httpx.

Run with:
    uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from backend.config import (
    OLLAMA_BASE_URL,
    MAX_CONCURRENT_SESSIONS,
    SESSION_TTL_SECONDS,
    validate_config,
)
from backend.graph.pipeline import build_pipeline, run_pipeline
from backend.graph.state import create_initial_state
from backend.rag.vectorstore import list_collections
from backend.utils.logger import get_logger

logger = get_logger(__name__)


# ============================================================================
# Session store — in-memory, thread-safe
# ============================================================================

class SessionStore:
    """Thread-safe in-memory session registry.

    Maps session_id -> ResearchState dict. Cleaned up on TTL expiry.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def add(self, session_id: str, state: dict[str, Any]) -> None:
        with self._lock:
            self._sessions[session_id] = state

    def get(self, session_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._sessions.get(session_id)

    def remove(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def active_count(self) -> int:
        """Return count of sessions that aren't in a terminal state."""
        terminal = {"complete", "error", "cancelled"}
        with self._lock:
            return sum(
                1 for s in self._sessions.values()
                if s.get("status") not in terminal
            )

    def total_count(self) -> int:
        with self._lock:
            return len(self._sessions)

    def sweep_expired(self, ttl_seconds: int) -> int:
        """Remove sessions older than ttl_seconds. Returns count removed."""
        now = time.time()
        removed = 0
        with self._lock:
            expired_ids = [
                sid for sid, s in self._sessions.items()
                if now - s.get("session_start_time", now) > ttl_seconds
            ]
            for sid in expired_ids:
                del self._sessions[sid]
                removed += 1
        if removed > 0:
            logger.info("Session sweep: removed %d expired sessions", removed)
        return removed


sessions = SessionStore()


# ============================================================================
# Pipeline background runner
# ============================================================================

def _run_pipeline_in_thread(session_id: str) -> None:
    """Run the full LangGraph pipeline on the session's state.

    This is called from a threading.Thread so it doesn't block the API loop.
    The pipeline mutates state in-place; SSE consumers read state['stream_events']
    to follow progress.
    """
    state = sessions.get(session_id)
    if state is None:
        logger.error("Pipeline runner: session %s not found", session_id)
        return

    try:
        run_pipeline(state)
    except Exception as exc:
        logger.exception("Pipeline thread crashed for %s: %s", session_id, exc)
        state["error"] = f"Pipeline thread crashed: {exc}"
        state["status"] = "error"


# ============================================================================
# Background cleanup task
# ============================================================================

_cleanup_stop_event = threading.Event()


async def _periodic_cleanup_loop() -> None:
    """Every 10 minutes, sweep expired sessions from the store."""
    while not _cleanup_stop_event.is_set():
        try:
            await asyncio.sleep(600)  # 10 minutes
            if _cleanup_stop_event.is_set():
                break
            sessions.sweep_expired(SESSION_TTL_SECONDS)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Cleanup loop error: %s", exc)


# ============================================================================
# App lifecycle
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: validate config + compile pipeline. Shutdown: stop cleanup."""
    # --- Startup ---
    logger.info("AutoResearcher starting up...")
    try:
        validate_config()
    except RuntimeError as exc:
        logger.error("Startup config validation failed: %s", exc)
        # Don't crash — the /api/health endpoint and 503 responses will
        # surface the issue. Log it clearly.

    # Pre-compile the pipeline so the first request doesn't pay the cost
    try:
        build_pipeline()
        logger.info("Pipeline pre-compiled at startup")
    except Exception as exc:
        logger.error("Failed to pre-compile pipeline: %s", exc)

    # Start background cleanup task
    cleanup_task = asyncio.create_task(_periodic_cleanup_loop())
    logger.info("AutoResearcher ready.")

    yield

    # --- Shutdown ---
    logger.info("AutoResearcher shutting down...")
    _cleanup_stop_event.set()
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass


# ============================================================================
# FastAPI app
# ============================================================================

app = FastAPI(
    title="AutoResearcher",
    description="Multi-agent deep research system — local-first, LangGraph-orchestrated.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",  # Vite dev
        "http://localhost:4173",  # Vite preview
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# Request / response models
# ============================================================================

class ResearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)


class ResearchStartResponse(BaseModel):
    session_id: str
    status: str


class CancelResponse(BaseModel):
    session_id: str
    status: str


class ReportResponse(BaseModel):
    report: str
    citations: list[dict]
    sources: list[dict]
    scraping_errors: list[dict]
    pipeline_duration: float
    status: str


class HealthResponse(BaseModel):
    ollama: bool
    chromadb: bool
    models_available: list[str]


# ============================================================================
# Endpoints
# ============================================================================

@app.post("/api/research", response_model=ResearchStartResponse)
def start_research(payload: ResearchRequest) -> ResearchStartResponse:
    """Start a new research session.

    Validates the query, runs config pre-flight, checks capacity, then
    kicks off the LangGraph pipeline in a background thread.
    """
    # --- Validate query ---
    query = payload.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query cannot be empty.")
    if len(query) > 500:
        raise HTTPException(
            status_code=400,
            detail=f"Query too long ({len(query)} chars). Max: 500.",
        )

    # --- Capacity check ---
    active = sessions.active_count()
    if active >= MAX_CONCURRENT_SESSIONS:
        raise HTTPException(
            status_code=429,
            detail="System at capacity. Please wait and try again.",
        )

    # --- Pre-flight: config + dependencies ---
    try:
        validate_config()
    except RuntimeError as exc:
        logger.error("Pre-flight validation failed: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc))

    # --- Create session ---
    session_id = str(uuid.uuid4())
    state = create_initial_state(
        query=query,
        session_id=session_id,
        session_start_time=time.time(),
    )
    sessions.add(session_id, state)

    # --- Launch pipeline in background thread ---
    thread = threading.Thread(
        target=_run_pipeline_in_thread,
        args=(session_id,),
        name=f"pipeline-{session_id[:8]}",
        daemon=True,
    )
    thread.start()

    logger.info(
        "Session %s started — query='%s' active=%d",
        session_id, query[:60], active + 1,
    )

    return ResearchStartResponse(session_id=session_id, status="started")


@app.get("/api/research/{session_id}/stream")
async def stream_research(session_id: str, request: Request):
    """SSE endpoint — streams pipeline events as they happen.

    Replays any events already in state['stream_events'] if the client
    reconnects mid-session. Closes when status reaches a terminal state.
    """
    state = sessions.get(session_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    terminal_statuses = {"complete", "error", "cancelled"}

    async def event_generator():
        last_index = 0
        idle_ticks = 0
        # Emit an initial "connected" comment for the client
        yield {"event": "connected", "data": json.dumps({"session_id": session_id})}

        while True:
            # Client disconnect detection
            if await request.is_disconnected():
                logger.info("SSE client disconnected from %s", session_id)
                break

            # Grab current state (fresh dict lookup each iteration)
            current_state = sessions.get(session_id)
            if current_state is None:
                # Session got swept — tell the client and exit
                yield {
                    "event": "error",
                    "data": json.dumps({"message": "Session expired."}),
                }
                break

            events = current_state.get("stream_events", [])
            new_events = events[last_index:]
            if new_events:
                for ev in new_events:
                    yield {
                        "event": ev.get("type", "message"),
                        "data": json.dumps(ev),
                    }
                last_index = len(events)
                idle_ticks = 0
            else:
                idle_ticks += 1

            # Check terminal state AFTER flushing any final events
            status = current_state.get("status", "")
            if status in terminal_statuses:
                # Drain any lingering events added after the status flip
                events = current_state.get("stream_events", [])
                for ev in events[last_index:]:
                    yield {
                        "event": ev.get("type", "message"),
                        "data": json.dumps(ev),
                    }
                logger.info(
                    "SSE stream closing for %s — status=%s", session_id, status,
                )
                break

            # Heartbeat every ~15 seconds of idle to keep the connection warm
            if idle_ticks >= 75:  # 75 * 0.2s = 15s
                yield {"event": "heartbeat", "data": json.dumps({"ts": time.time()})}
                idle_ticks = 0

            await asyncio.sleep(0.2)

    return EventSourceResponse(event_generator())


@app.delete("/api/research/{session_id}", response_model=CancelResponse)
def cancel_research(session_id: str) -> CancelResponse:
    """Cancel a running session.

    Sets state['cancelled'] = True. The pipeline's conditional edges will
    route to error_node on the next node boundary.
    """
    state = sessions.get(session_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    terminal = {"complete", "error", "cancelled"}
    if state.get("status") in terminal:
        raise HTTPException(
            status_code=409,
            detail=f"Session already {state.get('status')}.",
        )

    state["cancelled"] = True
    logger.info("Session %s flagged for cancellation", session_id)

    return CancelResponse(session_id=session_id, status="cancelling")


@app.get("/api/research/{session_id}/report")
def get_report(session_id: str):
    """Fetch the final report for a completed session.

    Returns 202 with in-progress status if the pipeline hasn't finished yet.
    """
    state = sessions.get(session_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    status = state.get("status", "")
    if status != "complete":
        # 202 Accepted — request is valid but the report isn't ready
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=202,
            content={"status": status or "in_progress"},
        )

    return ReportResponse(
        report=state.get("final_report", ""),
        citations=state.get("citations", []),
        sources=state.get("source_summaries", []),
        scraping_errors=state.get("scraping_errors", []),
        pipeline_duration=state.get("pipeline_duration", 0.0),
        status=status,
    )


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Service health check.

    Never raises. Returns boolean flags for each dependency and the list
    of models available from Ollama.
    """
    # --- Ollama ---
    ollama_up = False
    models: list[str] = []
    try:
        resp = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=3.0)
        resp.raise_for_status()
        data = resp.json()
        models = [m.get("name", "") for m in data.get("models", [])]
        ollama_up = True
    except Exception as exc:
        logger.warning("Ollama health check failed: %s", exc)

    # --- ChromaDB ---
    chromadb_up = False
    try:
        list_collections()  # triggers client init + connectivity check
        chromadb_up = True
    except Exception as exc:
        logger.warning("ChromaDB health check failed: %s", exc)

    return HealthResponse(
        ollama=ollama_up,
        chromadb=chromadb_up,
        models_available=models,
    )


# ============================================================================
# Root
# ============================================================================

@app.get("/")
def root():
    """Minimal landing response — mostly for sanity-checking the server."""
    return {
        "service": "AutoResearcher",
        "version": "1.0.0",
        "docs": "/docs",
        "health": "/api/health",
    }
