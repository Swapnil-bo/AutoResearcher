"""Extraction Agent — scrape + chunk + embed + summarize.

Model: qwen2.5:7b (via Ollama)

Responsibility: Visit each URL from the Search Agent, extract clean text,
chunk it, embed it into a session-scoped ChromaDB collection, and generate
a per-source summary via LLM.

This module exposes a single entry point: ``run(state) -> state``.
"""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

from backend.config import (
    OLLAMA_BASE_URL,
    EXTRACTION_AGENT_MODEL,
    MAX_SOURCES_TO_SCRAPE,
)
from backend.tools.scraper import scrape_url
from backend.rag.embedder import embed_texts
from backend.rag.vectorstore import (
    create_session_collection,
    upsert_chunks,
)
from backend.utils.logger import (
    get_logger,
    emit_agent_update,
    emit_source_progress,
    emit_source_summary,
    emit_error,
)

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Ollama helper
# ---------------------------------------------------------------------------

def _ollama_generate(prompt: str, max_tokens: int = 512) -> str:
    """Call Ollama's generate endpoint (non-streaming) with the extraction model.

    Returns the raw text response. Raises on any failure.
    """
    resp = httpx.post(
        f"{OLLAMA_BASE_URL}/api/generate",
        json={
            "model": EXTRACTION_AGENT_MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"num_predict": max_tokens, "temperature": 0.3},
        },
        timeout=180.0,
    )
    resp.raise_for_status()
    data = resp.json()
    if "error" in data:
        raise RuntimeError(f"Ollama error: {data['error']}")
    return data.get("response", "").strip()


# ---------------------------------------------------------------------------
# Per-source summarization
# ---------------------------------------------------------------------------

_SUMMARY_PROMPT = """You are a research assistant. Read the following text extracted from a web page and write a concise summary in 3 to 5 sentences. Focus on the key facts, findings, and arguments. Do not add your own opinions or outside knowledge.

Source title: {title}
Source URL: {url}

Extracted text (may be truncated):
{text}

Your summary (3-5 sentences):"""

# Max characters of source text to feed into the summary prompt.
# qwen2.5:7b context is limited; keep the prompt under ~3k tokens (~12k chars).
_MAX_SUMMARY_INPUT_CHARS = 10_000


def _generate_summary(url: str, title: str, text: str) -> str:
    """Generate a 3-5 sentence summary of a source using the LLM.

    Falls back to the first 3 sentences of the raw text if the LLM fails.
    """
    truncated_text = text[:_MAX_SUMMARY_INPUT_CHARS]
    prompt = _SUMMARY_PROMPT.format(
        title=title,
        url=url,
        text=truncated_text,
    )

    try:
        summary = _ollama_generate(prompt, max_tokens=256)
        if summary and len(summary) > 20:
            return summary
    except Exception as exc:
        logger.warning("LLM summary failed for [%s]: %s", url, exc)

    # Fallback: first 3 sentences of raw text
    return _fallback_summary(text)


def _fallback_summary(text: str) -> str:
    """Extract the first 3 sentences as a fallback summary."""
    sentences = re.split(r'(?<=[.!?])\s+', text)
    first_three = sentences[:3]
    summary = " ".join(first_three)
    # Cap at 500 chars to keep it reasonable
    if len(summary) > 500:
        summary = summary[:497] + "..."
    return summary


# ---------------------------------------------------------------------------
# Embedding with retry
# ---------------------------------------------------------------------------

def _embed_chunks_safe(chunk_texts: list[str]) -> list[list[float] | None]:
    """Embed a list of chunk texts with per-chunk retry on failure.

    Returns a list of embeddings (or None for chunks that failed twice).
    Processes in batches to avoid overwhelming CPU memory.
    """
    batch_size = 32
    results: list[list[float] | None] = []

    for start in range(0, len(chunk_texts), batch_size):
        batch = chunk_texts[start:start + batch_size]
        try:
            embeddings = embed_texts(batch)
            results.extend(embeddings)
        except Exception as exc:
            logger.warning(
                "Batch embedding failed for chunks [%d:%d]: %s — retrying individually",
                start, start + len(batch), exc,
            )
            # Retry each chunk individually
            for chunk_text in batch:
                try:
                    embedding = embed_texts([chunk_text])[0]
                    results.append(embedding)
                except Exception as inner_exc:
                    logger.warning(
                        "Individual chunk embedding failed (skipping): %s",
                        inner_exc,
                    )
                    results.append(None)

    return results


# ---------------------------------------------------------------------------
# Single source processing
# ---------------------------------------------------------------------------

def _process_source(
    state: dict,
    url: str,
    title: str,
    session_id: str,
    source_index: int,
) -> dict[str, Any] | None:
    """Process a single source URL: scrape -> chunk -> embed -> upsert -> summarize.

    Returns a summary dict {url, title, summary} on success, or None on failure.
    Side-effects: appends to state["scraping_errors"], emits SSE events,
    upserts chunks into ChromaDB.
    """
    # --- Scrape ---
    emit_source_progress(state, url, "fetching")
    scrape_result = scrape_url(url)

    if not scrape_result["ok"]:
        reason = scrape_result["error"] or "Unknown scraping error"
        state["scraping_errors"].append({"url": url, "reason": reason})
        emit_source_progress(state, url, "failed", reason=reason)
        logger.warning(
            "Source %d/%d failed [%s]: %s",
            source_index + 1, MAX_SOURCES_TO_SCRAPE, url, reason,
        )
        return None

    text = scrape_result["text"]
    chunks = scrape_result["chunks"]

    logger.info(
        "Source %d/%d scraped [%s]: %d chars, %d chunks",
        source_index + 1, MAX_SOURCES_TO_SCRAPE, url, len(text), len(chunks),
    )

    # --- Embed ---
    embeddings = _embed_chunks_safe(chunks)

    # Build chunk dicts for ChromaDB upsert, skipping any that failed embedding
    chunk_records: list[dict[str, Any]] = []
    skipped_embeddings = 0
    for i, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
        if embedding is None:
            skipped_embeddings += 1
            continue
        chunk_records.append({
            "text": chunk_text,
            "embedding": embedding,
            "source_url": url,
            "source_title": title,
            "chunk_index": i,
        })

    if skipped_embeddings > 0:
        logger.warning(
            "Skipped %d/%d chunks with failed embeddings for [%s]",
            skipped_embeddings, len(chunks), url,
        )

    # --- Upsert into ChromaDB ---
    if chunk_records:
        upserted = upsert_chunks(session_id, chunk_records)
        logger.info(
            "Upserted %d chunks for [%s] into session %s",
            upserted, url, session_id,
        )
    else:
        logger.warning("No embeddable chunks for [%s] — nothing upserted", url)

    # --- Summarize ---
    summary = _generate_summary(url, title, text)

    # --- Emit success events ---
    emit_source_progress(state, url, "done")
    emit_source_summary(state, url, title, summary)

    return {"url": url, "title": title, "summary": summary}


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(state: dict) -> dict:
    """Execute the Extraction Agent.

    1. Create session-scoped ChromaDB collection
    2. For each of the top MAX_SOURCES_TO_SCRAPE URLs:
       - Scrape, chunk, embed, upsert to ChromaDB
       - Generate LLM summary
       - Emit SSE events per source
    3. Update state with results and error counts

    Updates state in-place and returns it.
    """
    # --- Cancellation check ---
    if state.get("cancelled"):
        return state

    session_id = state["session_id"]
    search_results = state.get("search_results", [])

    # Take top N sources to scrape
    sources_to_process = search_results[:MAX_SOURCES_TO_SCRAPE]

    emit_agent_update(
        state, "extract", "running",
        f"Starting extraction of {len(sources_to_process)} sources...",
    )

    if not sources_to_process:
        msg = "No search results to extract — search may have failed."
        logger.error(msg)
        state["error"] = msg
        state["status"] = "error"
        emit_error(state, msg)
        emit_agent_update(state, "extract", "error", msg)
        return state

    # --- Create ChromaDB collection for this session ---
    try:
        create_session_collection(session_id)
    except RuntimeError as exc:
        msg = f"Failed to create ChromaDB collection: {exc}"
        logger.error(msg)
        state["error"] = msg
        state["status"] = "error"
        emit_error(state, msg)
        emit_agent_update(state, "extract", "error", msg)
        return state

    # --- Initialize state tracking ---
    state.setdefault("source_summaries", [])
    state.setdefault("scraping_errors", [])
    state["sources_processed"] = 0

    # --- Process each source sequentially ---
    for i, result in enumerate(sources_to_process):
        # Check cancellation between sources
        if state.get("cancelled"):
            logger.info("Extraction cancelled after %d sources", i)
            emit_agent_update(
                state, "extract", "cancelled",
                f"Cancelled after processing {i} sources",
            )
            return state

        url = result.get("url", "")
        title = result.get("title", url)

        if not url:
            logger.warning("Source %d has no URL — skipping", i)
            state["scraping_errors"].append({
                "url": "(empty)", "reason": "No URL in search result",
            })
            continue

        emit_agent_update(
            state, "extract", "running",
            f"Processing source {i + 1}/{len(sources_to_process)}: {title[:60]}",
        )

        summary_result = _process_source(state, url, title, session_id, i)

        if summary_result is not None:
            state["source_summaries"].append(summary_result)
            state["sources_processed"] += 1

    # --- Post-processing checks ---
    processed = state["sources_processed"]
    failed = len(state["scraping_errors"])
    total = len(sources_to_process)

    logger.info(
        "Extraction complete: %d/%d succeeded, %d failed",
        processed, total, failed,
    )

    if processed == 0:
        # All sources failed — this is a critical problem but per spec we don't abort
        msg = (
            f"All {total} sources failed to scrape. "
            "The report will have no source material."
        )
        logger.error(msg)
        state["error"] = msg
        state["status"] = "error"
        emit_error(state, msg)
        emit_agent_update(state, "extract", "error", msg)
        return state

    if processed < 3:
        # Fewer than 3 sources — warn but continue
        logger.warning(
            "Only %d sources processed (minimum recommended: 3). "
            "Continuing with limited data.",
            processed,
        )
        emit_agent_update(
            state, "extract", "running",
            f"Warning: only {processed} sources available — continuing with limited data",
        )

    emit_agent_update(
        state, "extract", "done",
        f"Extracted {processed} sources ({failed} failed)",
    )

    return state
