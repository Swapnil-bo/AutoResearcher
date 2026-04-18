"""Search Agent — query generation + web search execution.

Model: mistral:7b-instruct (via Ollama)

Responsibility: Turn the user's raw research question into 3-5 targeted
search queries, execute them via DuckDuckGo/Tavily, deduplicate, rank by
relevance, and return the top 10 URLs.

This module exposes a single entry point: ``run(state) -> state``.
"""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

from backend.config import (
    OLLAMA_BASE_URL,
    SEARCH_AGENT_MODEL,
    MAX_SEARCH_RESULTS,
)
from backend.tools.web_search import search_multiple
from backend.utils.logger import (
    get_logger,
    emit_agent_update,
    emit_search_queries,
    emit_search_results,
    emit_error,
)

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# Ollama helpers
# ---------------------------------------------------------------------------

def _ollama_generate(prompt: str, max_tokens: int = 512) -> str:
    """Call Ollama's generate endpoint (non-streaming).

    Returns the raw text response. Raises on any failure.
    """
    resp = httpx.post(
        f"{OLLAMA_BASE_URL}/api/generate",
        json={
            "model": SEARCH_AGENT_MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"num_predict": max_tokens, "temperature": 0.4},
        },
        timeout=120.0,
    )
    resp.raise_for_status()
    data = resp.json()
    if "error" in data:
        raise RuntimeError(f"Ollama error: {data['error']}")
    return data.get("response", "").strip()


def _preflight_check() -> str | None:
    """Verify Ollama is reachable and the search model is available.

    Returns None on success, or an error message string on failure.
    """
    try:
        resp = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5.0)
        resp.raise_for_status()
        models = [m["name"] for m in resp.json().get("models", [])]
    except Exception as exc:
        return f"Ollama is not reachable at {OLLAMA_BASE_URL}: {exc}"

    # Normalize model names for comparison (strip :latest suffix)
    normalized = {m.split(":")[0] + ":" + m.split(":")[1] if ":" in m else m for m in models}
    target = SEARCH_AGENT_MODEL
    if target not in models and target not in normalized:
        return (
            f"Model '{SEARCH_AGENT_MODEL}' not found in Ollama. "
            f"Available: {models}"
        )

    return None


# ---------------------------------------------------------------------------
# Query generation
# ---------------------------------------------------------------------------

_QUERY_GENERATION_PROMPT = """You are a research assistant. Given a research question, generate {count} diverse search queries to find comprehensive information.

Each query should target a different angle:
1. A broad overview query
2. A query about recent developments or news
3. A technically detailed query
4. A query seeking opposing views or limitations
5. A practical/use-case focused query

Research question: {question}

Respond with ONLY a JSON array of strings, no explanation. Example:
["query one", "query two", "query three"]

Your JSON array:"""


def _generate_search_queries(question: str) -> list[str]:
    """Use the LLM to decompose the research question into search queries.

    Falls back to using the raw question if the LLM fails or returns
    unparseable output.
    """
    prompt = _QUERY_GENERATION_PROMPT.format(
        count=5,
        question=question,
    )

    try:
        raw = _ollama_generate(prompt, max_tokens=300)
        queries = _parse_query_list(raw)
        if queries:
            logger.info("Generated %d search queries via LLM", len(queries))
            return queries[:5]  # Cap at 5
    except Exception as exc:
        logger.warning("LLM query generation failed: %s", exc)

    # Fallback: use the raw question directly
    logger.warning("Falling back to raw question as search query")
    return [question]


def _parse_query_list(raw: str) -> list[str]:
    """Extract a list of strings from LLM output.

    Tries JSON parsing first, then falls back to regex extraction.
    """
    # Try direct JSON parse
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list) and all(isinstance(q, str) for q in parsed):
            return [q.strip() for q in parsed if q.strip()]
    except (json.JSONDecodeError, TypeError):
        pass

    # Try to find a JSON array in the text
    match = re.search(r"\[.*?\]", raw, re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group())
            if isinstance(parsed, list):
                return [str(q).strip() for q in parsed if str(q).strip()]
        except (json.JSONDecodeError, TypeError):
            pass

    # Last resort: extract quoted strings
    quoted = re.findall(r'"([^"]{5,})"', raw)
    if quoted:
        return quoted

    # Extract numbered list items: "1. query text" or "- query text"
    lines = re.findall(r"(?:^|\n)\s*(?:\d+[.)]\s*|-\s*)(.+)", raw)
    if lines:
        return [l.strip().strip('"').strip("'") for l in lines if len(l.strip()) > 5]

    return []


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------

_RANKING_PROMPT = """You are evaluating search results for relevance to a research question.

Research question: {question}

Search results (title | snippet):
{results_text}

Score each result from 1 (not relevant) to 10 (highly relevant) based on whether the title and snippet suggest the page contains useful, substantive information for the research question. Prefer authoritative sources (academic, official docs, established publications) over forums or thin content.

Respond with ONLY a JSON array of objects, one per result, in the same order. Each object must have "index" (0-based) and "score" (1-10). Example:
[{{"index": 0, "score": 8}}, {{"index": 1, "score": 5}}]

Your JSON array:"""


def _rank_results(
    question: str, results: list[dict[str, str]],
) -> list[dict[str, str]]:
    """Use the LLM to rank results by relevance. Falls back to original order."""
    if len(results) <= 1:
        return results

    # Build compact text for the prompt
    lines = []
    for i, r in enumerate(results):
        title = r.get("title", "")[:80]
        snippet = r.get("snippet", "")[:120]
        lines.append(f"{i}. {title} | {snippet}")
    results_text = "\n".join(lines)

    try:
        raw = _ollama_generate(
            _RANKING_PROMPT.format(question=question, results_text=results_text),
            max_tokens=400,
        )
        scores = _parse_scores(raw, len(results))
        if scores:
            # Sort by score descending
            indexed = list(enumerate(results))
            indexed.sort(key=lambda x: scores.get(x[0], 0), reverse=True)
            ranked = [r for _, r in indexed]
            logger.info("Ranked %d results via LLM", len(ranked))
            return ranked
    except Exception as exc:
        logger.warning("LLM ranking failed: %s — using original order", exc)

    return results


def _parse_scores(raw: str, expected_count: int) -> dict[int, int] | None:
    """Parse LLM ranking output into {index: score} dict."""
    # Try JSON parse
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            scores = {}
            for item in parsed:
                if isinstance(item, dict) and "index" in item and "score" in item:
                    scores[int(item["index"])] = int(item["score"])
            if scores:
                return scores
    except (json.JSONDecodeError, TypeError, ValueError):
        pass

    # Try to find JSON array in text
    match = re.search(r"\[.*?\]", raw, re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group())
            if isinstance(parsed, list):
                scores = {}
                for item in parsed:
                    if isinstance(item, dict) and "index" in item and "score" in item:
                        scores[int(item["index"])] = int(item["score"])
                if scores:
                    return scores
        except (json.JSONDecodeError, TypeError, ValueError):
            pass

    # Try regex: look for index-score pairs
    pairs = re.findall(r'"?index"?\s*:\s*(\d+)\s*,\s*"?score"?\s*:\s*(\d+)', raw)
    if pairs:
        return {int(idx): int(score) for idx, score in pairs}

    return None


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(state: dict) -> dict:
    """Execute the Search Agent.

    1. Pre-flight check (Ollama reachable, model available)
    2. Generate 3-5 diverse search queries via LLM
    3. Execute all queries with deduplication
    4. Rank results by LLM-scored relevance
    5. Return top MAX_SEARCH_RESULTS URLs

    Updates state in-place and returns it.
    """
    emit_agent_update(state, "search", "running", "Starting search agent...")

    # --- Pre-flight ---
    error = _preflight_check()
    if error:
        logger.error("Search agent pre-flight failed: %s", error)
        state["error"] = error
        state["status"] = "error"
        emit_error(state, error)
        emit_agent_update(state, "search", "error", error)
        return state

    query = state["query"]

    # --- Generate queries ---
    emit_agent_update(state, "search", "running", "Generating search queries...")
    search_queries = _generate_search_queries(query)
    state["search_queries"] = search_queries
    emit_search_queries(state, search_queries)
    logger.info("Search queries: %s", search_queries)

    # --- Execute searches ---
    emit_agent_update(
        state, "search", "running",
        f"Executing {len(search_queries)} search queries...",
    )
    all_results = search_multiple(
        search_queries,
        max_results_per_query=MAX_SEARCH_RESULTS,
        inter_query_delay=1.0,
    )

    # --- Handle empty results ---
    if not all_results:
        msg = "Search returned no results. Try a more specific query."
        logger.error(msg)
        state["error"] = msg
        state["status"] = "error"
        emit_error(state, msg)
        emit_agent_update(state, "search", "error", msg)
        return state

    logger.info("Raw search results: %d unique URLs", len(all_results))

    # --- Rank results ---
    emit_agent_update(
        state, "search", "running",
        f"Ranking {len(all_results)} results by relevance...",
    )
    ranked = _rank_results(query, all_results)

    # --- Take top N ---
    top_results = ranked[:MAX_SEARCH_RESULTS]
    state["search_results"] = top_results

    emit_search_results(state, top_results)
    emit_agent_update(
        state, "search", "done",
        f"Found {len(top_results)} relevant sources",
    )

    logger.info(
        "Search agent complete: %d queries -> %d raw -> %d ranked results",
        len(search_queries), len(all_results), len(top_results),
    )

    return state
