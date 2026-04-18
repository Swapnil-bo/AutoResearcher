"""ResearchState — the single shared state object flowing through all nodes.

Every agent reads from and writes to this TypedDict. It is initialized once
when a research session starts and passed through the LangGraph pipeline.
"""

from __future__ import annotations

from typing import TypedDict


class ResearchState(TypedDict, total=False):
    """Shared state for the LangGraph research pipeline.

    Fields marked as required (present in every initialized state) use the
    ``total=False`` escape hatch — callers must still provide them at init
    time via ``create_initial_state()``.
    """

    # --- Session identity ---
    query: str                      # Original user research question
    session_id: str                 # UUID4 for this research session
    session_start_time: float       # Unix timestamp at session creation

    # --- Search Agent outputs ---
    search_queries: list[str]       # Generated search queries
    search_results: list[dict]      # Raw search results: [{url, title, snippet}] (top 10)

    # --- Extraction Agent outputs ---
    sources_processed: int          # Count of successfully scraped sources
    scraping_errors: list[dict]     # [{url, reason}] for every skipped URL
    source_summaries: list[dict]    # Per-source LLM summaries: [{url, title, summary}]

    # --- Synthesis Agent outputs ---
    retrieval_queries: list[str]    # Queries used for ChromaDB retrieval
    retrieved_chunks: list[dict]    # Chunks from ChromaDB with relevance scores

    # --- Final report ---
    final_report: str               # Synthesized and cleaned markdown report
    citations: list[dict]           # Citation map: [{citation_id, url, title}]

    # --- Pipeline metadata ---
    pipeline_duration: float        # Total pipeline runtime in seconds (set by format_node)
    stream_events: list[dict]       # Log of all SSE events emitted during the pipeline

    # --- Control flow ---
    cancelled: bool                 # True if the user cancels mid-pipeline
    error: str | None               # Pipeline-level error message, or None
    status: str                     # "searching" | "extracting" | "synthesizing" |
                                    # "formatting" | "complete" | "error" | "cancelled"


def create_initial_state(query: str, session_id: str, session_start_time: float) -> ResearchState:
    """Create a fully initialized ResearchState with all fields set to defaults."""
    return ResearchState(
        query=query,
        session_id=session_id,
        session_start_time=session_start_time,
        search_queries=[],
        search_results=[],
        sources_processed=0,
        scraping_errors=[],
        source_summaries=[],
        retrieval_queries=[],
        retrieved_chunks=[],
        final_report="",
        citations=[],
        pipeline_duration=0.0,
        stream_events=[],
        cancelled=False,
        error=None,
        status="searching",
    )
