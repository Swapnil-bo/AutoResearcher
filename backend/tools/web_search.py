"""Web search wrapper — DuckDuckGo (default) or Tavily (if API key set).

The search backend is chosen once at module load based on config.TAVILY_API_KEY.
If Tavily is configured but its key turns out to be invalid at runtime, we
fall back to DuckDuckGo for that call and log a warning.

Public API:
    search(query, max_results) → list[{url, title, snippet}]
    search_multiple(queries, max_results_per_query) → deduplicated list
"""

from __future__ import annotations

import time
import warnings
from typing import Any

from backend.config import TAVILY_API_KEY, MAX_SEARCH_RESULTS
from backend.utils.logger import get_logger

logger = get_logger(__name__)

# Suppress the duckduckgo_search rename warning
warnings.filterwarnings("ignore", message=".*duckduckgo_search.*renamed.*")

# ---------------------------------------------------------------------------
# Retry helper
# ---------------------------------------------------------------------------

_RETRY_DELAYS = [2, 4, 8]  # exponential backoff: 3 attempts


def _retry_with_backoff(fn, *args, **kwargs) -> Any:
    """Call *fn* with up to 3 retries on failure (delays: 2s, 4s, 8s)."""
    last_exc: Exception | None = None
    for attempt, delay in enumerate(_RETRY_DELAYS, start=1):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            last_exc = exc
            logger.warning(
                "Search attempt %d/3 failed: %s — retrying in %ds",
                attempt, exc, delay,
            )
            time.sleep(delay)
    logger.error("All 3 search attempts failed. Last error: %s", last_exc)
    return None


# ---------------------------------------------------------------------------
# DuckDuckGo backend
# ---------------------------------------------------------------------------

def _search_ddg(query: str, max_results: int) -> list[dict[str, str]]:
    """Execute a single DuckDuckGo search. Returns raw DDG result dicts."""
    try:
        from ddgs import DDGS
    except ImportError:
        from duckduckgo_search import DDGS

    with DDGS() as ddgs:
        results = ddgs.text(query, max_results=max_results)
    return results if results else []


def _ddg_to_standard(results: list[dict[str, str]]) -> list[dict[str, str]]:
    """Normalize DDG results to {url, title, snippet}."""
    normalized: list[dict[str, str]] = []
    for r in results:
        url = r.get("href", "")
        if not url:
            continue
        normalized.append({
            "url": url,
            "title": r.get("title", ""),
            "snippet": r.get("body", ""),
        })
    return normalized


# ---------------------------------------------------------------------------
# Tavily backend
# ---------------------------------------------------------------------------

_tavily_client = None
_tavily_failed = False  # sticky flag: if auth fails once, don't retry


def _get_tavily_client():
    """Lazy-init Tavily client. Returns None if unavailable."""
    global _tavily_client, _tavily_failed
    if _tavily_failed:
        return None
    if _tavily_client is None:
        try:
            from tavily import TavilyClient
            _tavily_client = TavilyClient(api_key=TAVILY_API_KEY)
        except Exception as exc:
            logger.error("Tavily client init failed: %s — falling back to DDG", exc)
            _tavily_failed = True
            return None
    return _tavily_client


def _search_tavily(query: str, max_results: int) -> list[dict[str, str]]:
    """Execute a single Tavily search. Returns normalized results."""
    global _tavily_failed
    client = _get_tavily_client()
    if client is None:
        return _search_ddg_normalized(query, max_results)

    try:
        response = client.search(query=query, max_results=max_results)
        results: list[dict[str, str]] = []
        for r in response.get("results", []):
            url = r.get("url", "")
            if not url:
                continue
            results.append({
                "url": url,
                "title": r.get("title", ""),
                "snippet": r.get("content", ""),
            })
        return results
    except Exception as exc:
        logger.error(
            "Tavily search failed: %s — falling back to DuckDuckGo for this query", exc,
        )
        # If it's an auth error, mark Tavily as permanently failed for session
        exc_str = str(exc).lower()
        if "unauthorized" in exc_str or "invalid api key" in exc_str or "401" in exc_str:
            logger.warning("Tavily API key appears invalid. Disabling Tavily for this session.")
            _tavily_failed = True
        return _search_ddg_normalized(query, max_results)


def _search_ddg_normalized(query: str, max_results: int) -> list[dict[str, str]]:
    """DDG search with retry, returning normalized results."""
    raw = _retry_with_backoff(_search_ddg, query, max_results)
    if raw is None:
        return []
    return _ddg_to_standard(raw)


# ---------------------------------------------------------------------------
# Determine search backend at module load
# ---------------------------------------------------------------------------

_USE_TAVILY: bool = bool(TAVILY_API_KEY)
if _USE_TAVILY:
    logger.info("Search backend: Tavily (API key set)")
else:
    logger.info("Search backend: DuckDuckGo (no Tavily key)")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def search(query: str, max_results: int | None = None) -> list[dict[str, str]]:
    """Run a single search query.

    Returns a list of ``{url, title, snippet}`` dicts.
    Never raises — returns an empty list on total failure.
    """
    if max_results is None:
        max_results = MAX_SEARCH_RESULTS

    if _USE_TAVILY and not _tavily_failed:
        results = _retry_with_backoff(_search_tavily, query, max_results)
        if results is None:
            results = []
    else:
        results = _search_ddg_normalized(query, max_results)

    logger.info("Search '%s' → %d results", query[:60], len(results))
    return results


def search_multiple(
    queries: list[str],
    max_results_per_query: int | None = None,
    inter_query_delay: float = 1.0,
) -> list[dict[str, str]]:
    """Run multiple search queries, deduplicate by URL, return combined results.

    A 1-second delay is inserted between queries to avoid rate limiting
    (configurable via *inter_query_delay*).

    Returns a deduplicated list of ``{url, title, snippet}`` dicts,
    preserving the order in which URLs were first encountered.
    """
    if max_results_per_query is None:
        max_results_per_query = MAX_SEARCH_RESULTS

    all_results: list[dict[str, str]] = []
    seen_urls: set[str] = set()

    for i, query in enumerate(queries):
        if i > 0:
            time.sleep(inter_query_delay)

        results = search(query, max_results=max_results_per_query)
        for r in results:
            url = r["url"]
            if url not in seen_urls:
                seen_urls.add(url)
                all_results.append(r)

    logger.info(
        "search_multiple: %d queries → %d unique results",
        len(queries), len(all_results),
    )
    return all_results
