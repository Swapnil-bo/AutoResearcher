"""Structured logging for agent events.

Provides two concerns:
1. Console logging — standard Python logging with structured formatting.
2. SSE event emission — builds typed event dicts, appends them to
   ResearchState["stream_events"], and logs them to console simultaneously.
"""

import logging
import time
from typing import Any


# ---------------------------------------------------------------------------
# Console logger setup
# ---------------------------------------------------------------------------

def get_logger(name: str) -> logging.Logger:
    """Return a named logger with a consistent format.

    Every module calls this once at import time:
        logger = get_logger(__name__)
    """
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler()
        formatter = logging.Formatter(
            "[%(asctime)s] %(levelname)-8s %(name)s — %(message)s",
            datefmt="%H:%M:%S",
        )
        handler.setFormatter(formatter)
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
    return logger


_log = get_logger("autoresearcher.events")


# ---------------------------------------------------------------------------
# SSE event helpers
# ---------------------------------------------------------------------------

def _make_event(event_type: str, **fields: Any) -> dict:
    """Build a timestamped SSE event dict."""
    return {
        "type": event_type,
        "timestamp": time.time(),
        **fields,
    }


def emit_event(state: dict, event_type: str, **fields: Any) -> dict:
    """Create an event, append it to state['stream_events'], and log it.

    Returns the event dict so callers can also forward it to an SSE queue
    if needed.
    """
    event = _make_event(event_type, **fields)
    state.setdefault("stream_events", []).append(event)
    _log.info("%s | %s", event_type, _summarize(fields))
    return event


def _summarize(fields: dict) -> str:
    """One-line summary of event payload for the console."""
    parts: list[str] = []
    for key, value in fields.items():
        if isinstance(value, str):
            truncated = value if len(value) <= 120 else value[:117] + "..."
            parts.append(f"{key}={truncated}")
        elif isinstance(value, list):
            parts.append(f"{key}=[{len(value)} items]")
        else:
            parts.append(f"{key}={value}")
    return ", ".join(parts) if parts else "(no payload)"


# ---------------------------------------------------------------------------
# Convenience emitters for every SSE event type in the catalog
# ---------------------------------------------------------------------------

def emit_agent_update(
    state: dict, agent: str, status: str, message: str,
) -> dict:
    """agent_update — when any agent starts or finishes."""
    return emit_event(
        state, "agent_update",
        agent=agent, status=status, message=message,
    )


def emit_search_queries(state: dict, queries: list[str]) -> dict:
    """search_queries — after Search Agent generates queries."""
    return emit_event(state, "search_queries", queries=queries)


def emit_search_results(state: dict, results: list[dict]) -> dict:
    """search_results — after Search Agent finishes."""
    return emit_event(state, "search_results", results=results)


def emit_source_progress(
    state: dict, url: str, status: str, reason: str = "",
) -> dict:
    """source_progress — as each URL is being scraped."""
    return emit_event(
        state, "source_progress",
        url=url, status=status, reason=reason,
    )


def emit_source_summary(
    state: dict, url: str, title: str, summary: str,
) -> dict:
    """source_summary — after each source is fully processed."""
    return emit_event(
        state, "source_summary",
        url=url, title=title, summary=summary,
    )


def emit_report_token(state: dict, token: str) -> dict:
    """report_token — during Synthesis Agent LLM streaming."""
    return emit_event(state, "report_token", data=token)


def emit_report_complete(state: dict, citations: list[dict]) -> dict:
    """report_complete — after Synthesis Agent finishes streaming."""
    return emit_event(state, "report_complete", citations=citations)


def emit_pipeline_complete(
    state: dict, pipeline_duration: float, sources_processed: int,
) -> dict:
    """pipeline_complete — after Format Node finishes."""
    return emit_event(
        state, "pipeline_complete",
        pipeline_duration=pipeline_duration,
        sources_processed=sources_processed,
    )


def emit_error(state: dict, message: str) -> dict:
    """error — on any fatal pipeline error."""
    _log.error("PIPELINE ERROR: %s", message)
    return emit_event(state, "error", message=message)


def emit_cancelled(state: dict) -> dict:
    """cancelled — when a cancel request is processed."""
    return emit_event(
        state, "cancelled",
        message="Pipeline cancelled by user",
    )
