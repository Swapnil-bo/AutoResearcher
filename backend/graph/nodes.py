"""LangGraph node functions wrapping each agent.

Each node function takes a ResearchState dict and returns it (mutated).
Nodes follow a strict contract:

1. Check ``state["cancelled"]`` at entry — return immediately if True.
2. Update ``state["status"]`` at entry.
3. Emit SSE events at entry and exit via the logger helpers.
4. Handle all exceptions internally — write to ``state["error"]``, never raise.
5. Return the state dict (LangGraph expects this).

Public API:
    search_node(state)      — wraps Search Agent
    extraction_node(state)  — wraps Extraction Agent
    synthesis_node(state)   — wraps Synthesis Agent
    format_node(state)      — citation repair, markdown cleanup, metadata, ChromaDB teardown
    error_node(state)       — terminal error/cancel handler with cleanup
    should_continue(state)  — conditional edge: "continue" or "error"
"""

from __future__ import annotations

import time

from backend.agents import search_agent, extraction_agent, synthesis_agent
from backend.rag.vectorstore import delete_session_collection
from backend.utils.formatters import finalize_report
from backend.utils.logger import (
    get_logger,
    emit_agent_update,
    emit_pipeline_complete,
    emit_error,
    emit_cancelled,
)

logger = get_logger(__name__)


# ============================================================================
# Agent wrapper nodes
# ============================================================================

def search_node(state: dict) -> dict:
    """Run the Search Agent. Updates status to 'searching'."""
    if state.get("cancelled"):
        return state

    state["status"] = "searching"

    try:
        state = search_agent.run(state)
    except Exception as exc:
        msg = f"Search agent crashed unexpectedly: {exc}"
        logger.exception(msg)
        state["error"] = msg
        state["status"] = "error"
        emit_error(state, msg)
        emit_agent_update(state, "search", "error", msg)

    return state


def extraction_node(state: dict) -> dict:
    """Run the Extraction Agent. Updates status to 'extracting'."""
    if state.get("cancelled"):
        return state

    state["status"] = "extracting"

    try:
        state = extraction_agent.run(state)
    except Exception as exc:
        msg = f"Extraction agent crashed unexpectedly: {exc}"
        logger.exception(msg)
        state["error"] = msg
        state["status"] = "error"
        emit_error(state, msg)
        emit_agent_update(state, "extract", "error", msg)

    return state


def synthesis_node(state: dict) -> dict:
    """Run the Synthesis Agent. Updates status to 'synthesizing'."""
    if state.get("cancelled"):
        return state

    state["status"] = "synthesizing"

    try:
        state = synthesis_agent.run(state)
    except Exception as exc:
        msg = f"Synthesis agent crashed unexpectedly: {exc}"
        logger.exception(msg)
        state["error"] = msg
        state["status"] = "error"
        emit_error(state, msg)
        emit_agent_update(state, "synthesize", "error", msg)

    return state


# ============================================================================
# Format node — post-processing, citation repair, cleanup
# ============================================================================

def format_node(state: dict) -> dict:
    """Post-process the raw LLM report: repair citations, rebuild references,
    clean markdown, inject metadata, update final state, and tear down the
    session's ChromaDB collection.

    This is the last node before END on the happy path.
    """
    if state.get("cancelled"):
        return state

    state["status"] = "formatting"
    emit_agent_update(state, "format", "running", "Cleaning up report...")

    session_id = state.get("session_id", "")
    report = state.get("final_report", "")
    citations = state.get("citations", [])

    try:
        # Compute duration first so inject_metadata uses the true pipeline time
        duration = time.time() - state.get("session_start_time", time.time())
        state["pipeline_duration"] = round(duration, 2)

        # Run the full formatting pipeline:
        #   normalize → repair citations → rebuild references → clean → metadata
        report, citations = finalize_report(report, citations, state)

        state["final_report"] = report
        state["citations"] = citations
        state["status"] = "complete"

        emit_pipeline_complete(
            state,
            pipeline_duration=state["pipeline_duration"],
            sources_processed=state.get("sources_processed", 0),
        )
        emit_agent_update(
            state, "format", "done",
            f"Report finalized — {len(report)} chars, {len(citations)} citations",
        )

    except Exception as exc:
        msg = f"Format node failed: {exc}"
        logger.exception(msg)
        # Still try to save whatever report we have
        state["final_report"] = report or state.get("final_report", "")
        state["pipeline_duration"] = round(
            time.time() - state.get("session_start_time", time.time()), 2,
        )
        state["status"] = "complete"  # partial but usable
        emit_agent_update(state, "format", "done", f"Format completed with errors: {exc}")

    # ---------------------------------------------------------------
    # 6. ChromaDB cleanup (always, even if formatting had errors)
    # ---------------------------------------------------------------
    _cleanup_chromadb(session_id)

    return state


# ============================================================================
# Error / cancel terminal node
# ============================================================================

def error_node(state: dict) -> dict:
    """Terminal node for error and cancellation paths.

    Emits the appropriate SSE event, sets final status, and cleans up
    the session's ChromaDB collection.
    """
    session_id = state.get("session_id", "")

    if state.get("cancelled"):
        state["status"] = "cancelled"
        emit_cancelled(state)
        emit_agent_update(
            state, "pipeline", "cancelled", "Pipeline cancelled by user",
        )
        logger.info("Pipeline cancelled for session %s", session_id)
    else:
        error_msg = state.get("error", "Unknown pipeline error")
        state["status"] = "error"
        emit_error(state, error_msg)
        emit_agent_update(state, "pipeline", "error", error_msg)
        logger.error("Pipeline error for session %s: %s", session_id, error_msg)

    # Record duration even on error
    state["pipeline_duration"] = round(
        time.time() - state.get("session_start_time", time.time()), 2,
    )

    # Clean up ChromaDB — collection may or may not exist depending on
    # where in the pipeline the error occurred
    _cleanup_chromadb(session_id)

    return state


# ============================================================================
# Conditional edge
# ============================================================================

def should_continue(state: dict) -> str:
    """Conditional routing function for LangGraph edges.

    Returns:
        "error"    — if state has an error or was cancelled
        "continue" — otherwise (proceed to the next node)
    """
    if state.get("cancelled"):
        logger.info("Routing to error_node: pipeline cancelled")
        return "error"
    if state.get("error"):
        logger.info("Routing to error_node: %s", state["error"][:100])
        return "error"
    return "continue"


# ============================================================================
# ChromaDB cleanup
# ============================================================================

def _cleanup_chromadb(session_id: str) -> None:
    """Delete the session's ChromaDB collection. Log but never crash."""
    if not session_id:
        return
    success = delete_session_collection(session_id)
    if success:
        logger.info("ChromaDB cleanup complete for session %s", session_id)
    else:
        logger.warning("ChromaDB cleanup failed for session %s — may need manual cleanup", session_id)
