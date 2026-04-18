"""LangGraph StateGraph — definition, edge wiring, and compilation.

Defines the research pipeline as a directed graph:

    START
      ↓
    search_node ──► should_continue? ─── error ──► error_node ──► END
      │                                    │
      ▼ continue                           │
    extraction_node ► should_continue? ────┤
      │                                    │
      ▼ continue                           │
    synthesis_node ►  should_continue? ────┘
      │
      ▼ continue
    format_node ──► END

Models run sequentially through Ollama (6 GB VRAM constraint — no
parallel agent invocation). LangGraph's linear execution guarantees
only one node is active at a time.

Public API:
    build_pipeline()   → compiled StateGraph (call once at startup)
    run_pipeline(state) → final state dict (blocking, synchronous)
"""

from __future__ import annotations

from typing import Any

from langgraph.graph import StateGraph, START, END

from backend.graph.state import ResearchState
from backend.graph.nodes import (
    search_node,
    extraction_node,
    synthesis_node,
    format_node,
    error_node,
    should_continue,
)
from backend.utils.logger import get_logger

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

# Module-level cache so the graph is compiled exactly once.
_compiled_pipeline = None


def build_pipeline():
    """Build and compile the LangGraph research pipeline.

    Returns a compiled StateGraph ready for ``.invoke()`` or ``.stream()``.
    The result is cached — subsequent calls return the same compiled graph.
    """
    global _compiled_pipeline
    if _compiled_pipeline is not None:
        return _compiled_pipeline

    graph = StateGraph(ResearchState)

    # --- Nodes ---
    graph.add_node("search_node", search_node)
    graph.add_node("extraction_node", extraction_node)
    graph.add_node("synthesis_node", synthesis_node)
    graph.add_node("format_node", format_node)
    graph.add_node("error_node", error_node)

    # --- Entry edge ---
    graph.add_edge(START, "search_node")

    # --- Conditional edges after each agent node ---
    # should_continue returns "continue" or "error".
    # "continue" → next agent node, "error" → error_node.
    graph.add_conditional_edges(
        "search_node",
        should_continue,
        {"continue": "extraction_node", "error": "error_node"},
    )
    graph.add_conditional_edges(
        "extraction_node",
        should_continue,
        {"continue": "synthesis_node", "error": "error_node"},
    )
    graph.add_conditional_edges(
        "synthesis_node",
        should_continue,
        {"continue": "format_node", "error": "error_node"},
    )

    # --- Terminal edges ---
    graph.add_edge("format_node", END)
    graph.add_edge("error_node", END)

    # --- Compile ---
    _compiled_pipeline = graph.compile()
    logger.info("Research pipeline compiled successfully")

    return _compiled_pipeline


# ---------------------------------------------------------------------------
# Execution helpers
# ---------------------------------------------------------------------------

def run_pipeline(state: dict[str, Any]) -> dict[str, Any]:
    """Execute the full research pipeline synchronously.

    Args:
        state: An initialized ResearchState dict (from ``create_initial_state``).

    Returns:
        The final state dict after all nodes have executed (or after
        error/cancellation routing).

    This is the primary entry point used by the FastAPI background task.
    It blocks until the pipeline reaches END.
    """
    pipeline = build_pipeline()

    logger.info(
        "Pipeline starting — session=%s query='%s'",
        state.get("session_id", "?"),
        state.get("query", "")[:80],
    )

    try:
        final_state = pipeline.invoke(state)
    except Exception as exc:
        # This should never happen — nodes catch their own errors.
        # But if LangGraph itself fails, we handle it here.
        logger.exception("Pipeline invoke failed catastrophically: %s", exc)
        state["error"] = f"Pipeline infrastructure failure: {exc}"
        state["status"] = "error"
        return state

    logger.info(
        "Pipeline finished — session=%s status=%s duration=%ss",
        final_state.get("session_id", "?"),
        final_state.get("status", "?"),
        final_state.get("pipeline_duration", "?"),
    )

    return final_state
