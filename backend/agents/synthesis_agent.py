"""Synthesis Agent — RAG retrieval + streamed report generation.

Model: qwen2.5:7b (via Ollama)

Responsibility: Use RAG to retrieve the most relevant chunks from ChromaDB
and synthesize a structured, cited research report. The report is streamed
token-by-token to the frontend as it is generated — no buffering.

This module exposes a single entry point: ``run(state) -> state``.
"""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

from backend.config import (
    OLLAMA_BASE_URL,
    SYNTHESIS_AGENT_MODEL,
    RAG_TOP_K,
    RAG_RETRIEVAL_QUERIES,
)
from backend.rag.embedder import embed_text
from backend.rag.vectorstore import query_chunks
from backend.utils.logger import (
    get_logger,
    emit_agent_update,
    emit_report_token,
    emit_report_complete,
    emit_error,
)

logger = get_logger(__name__)

# Maximum unique chunks to include in the synthesis context window.
_MAX_CONTEXT_CHUNKS = 20


# ---------------------------------------------------------------------------
# Ollama helpers
# ---------------------------------------------------------------------------

def _ollama_generate(prompt: str, max_tokens: int = 512) -> str:
    """Non-streaming Ollama generate. Used for retrieval query generation."""
    resp = httpx.post(
        f"{OLLAMA_BASE_URL}/api/generate",
        json={
            "model": SYNTHESIS_AGENT_MODEL,
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


def _ollama_stream(prompt: str, max_tokens: int = 4096):
    """Streaming Ollama generate. Yields individual token strings.

    Uses httpx streaming to read newline-delimited JSON from the
    /api/generate endpoint with stream=True. Each JSON object contains
    a "response" field with one or more tokens.
    """
    with httpx.Client(timeout=httpx.Timeout(600.0, connect=30.0)) as client:
        with client.stream(
            "POST",
            f"{OLLAMA_BASE_URL}/api/generate",
            json={
                "model": SYNTHESIS_AGENT_MODEL,
                "prompt": prompt,
                "stream": True,
                "options": {
                    "num_predict": max_tokens,
                    "temperature": 0.4,
                },
            },
        ) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                token = data.get("response", "")
                if token:
                    yield token
                # Ollama signals completion with "done": true
                if data.get("done", False):
                    return


# ---------------------------------------------------------------------------
# Retrieval query generation
# ---------------------------------------------------------------------------

_RETRIEVAL_QUERY_PROMPT = """You are a research analyst preparing to write a comprehensive report. Given the research question below, generate {count} diverse retrieval queries to find all relevant information from a document database.

Each query should target a different aspect:
1. Core definition and overview
2. Key mechanisms, methods, or technical details
3. Real-world applications and use cases
4. Recent developments, trends, or breakthroughs
5. Limitations, challenges, and criticisms
6. Comparisons with alternatives or competing approaches

Research question: {question}

Respond with ONLY a JSON array of query strings, nothing else. Example:
["query one", "query two", "query three"]

Your JSON array:"""


def _generate_retrieval_queries(question: str) -> list[str]:
    """Use the LLM to generate diverse retrieval queries for ChromaDB.

    Falls back to variations of the raw question if the LLM fails.
    """
    prompt = _RETRIEVAL_QUERY_PROMPT.format(
        count=RAG_RETRIEVAL_QUERIES,
        question=question,
    )

    try:
        raw = _ollama_generate(prompt, max_tokens=400)
        queries = _parse_query_list(raw)
        if queries:
            logger.info("Generated %d retrieval queries via LLM", len(queries))
            return queries[:RAG_RETRIEVAL_QUERIES]
    except Exception as exc:
        logger.warning("LLM retrieval query generation failed: %s", exc)

    # Fallback: construct basic query variations from the raw question
    logger.warning("Falling back to manual retrieval query variations")
    return _fallback_retrieval_queries(question)


def _fallback_retrieval_queries(question: str) -> list[str]:
    """Build simple query variations when the LLM fails."""
    queries = [
        question,
        f"overview of {question}",
        f"technical details {question}",
        f"applications and use cases {question}",
        f"recent developments {question}",
        f"limitations and challenges {question}",
    ]
    return queries[:RAG_RETRIEVAL_QUERIES]


def _parse_query_list(raw: str) -> list[str]:
    """Extract a list of strings from LLM output. JSON first, then regex."""
    # Try direct JSON parse
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list) and all(isinstance(q, str) for q in parsed):
            return [q.strip() for q in parsed if q.strip()]
    except (json.JSONDecodeError, TypeError):
        pass

    # Try to find a JSON array embedded in the text
    match = re.search(r"\[.*?\]", raw, re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group())
            if isinstance(parsed, list):
                return [str(q).strip() for q in parsed if str(q).strip()]
        except (json.JSONDecodeError, TypeError):
            pass

    # Extract quoted strings
    quoted = re.findall(r'"([^"]{5,})"', raw)
    if quoted:
        return quoted

    # Extract numbered/bulleted list items
    lines = re.findall(r"(?:^|\n)\s*(?:\d+[.)]\s*|-\s*)(.+)", raw)
    if lines:
        return [line.strip().strip('"').strip("'") for line in lines if len(line.strip()) > 5]

    return []


# ---------------------------------------------------------------------------
# RAG retrieval + deduplication
# ---------------------------------------------------------------------------

def _retrieve_chunks(
    session_id: str,
    retrieval_queries: list[str],
) -> list[dict[str, Any]]:
    """Embed each retrieval query, query ChromaDB, and return deduplicated chunks.

    Returns up to _MAX_CONTEXT_CHUNKS unique chunks ordered by relevance
    (lowest cosine distance first).
    """
    all_chunks: list[dict[str, Any]] = []

    for query_text in retrieval_queries:
        try:
            query_embedding = embed_text(query_text)
        except Exception as exc:
            logger.warning("Failed to embed retrieval query '%s': %s", query_text[:50], exc)
            continue

        chunks = query_chunks(session_id, query_embedding, top_k=RAG_TOP_K)
        all_chunks.extend(chunks)

    if not all_chunks:
        return []

    # Deduplicate by exact text match (sufficient for v1 per spec)
    seen_texts: set[str] = set()
    unique_chunks: list[dict[str, Any]] = []
    for chunk in all_chunks:
        text = chunk["text"]
        if text not in seen_texts:
            seen_texts.add(text)
            unique_chunks.append(chunk)

    # Sort by distance ascending (most relevant first)
    unique_chunks.sort(key=lambda c: c.get("distance", 1.0))

    # Cap at the maximum context window size
    result = unique_chunks[:_MAX_CONTEXT_CHUNKS]

    logger.info(
        "Retrieved %d total chunks -> %d unique -> %d after cap",
        len(all_chunks), len(unique_chunks), len(result),
    )
    return result


# ---------------------------------------------------------------------------
# Citation map construction
# ---------------------------------------------------------------------------

def _build_citation_map(
    chunks: list[dict[str, Any]],
) -> tuple[list[dict[str, str]], dict[str, str]]:
    """Assign citation IDs to unique source URLs found in the retrieved chunks.

    Returns:
        citations: list of {citation_id, url, title} — the canonical citation list
        url_to_id:  dict mapping URL -> "[Source N]" for prompt construction
    """
    url_to_id: dict[str, str] = {}
    citations: list[dict[str, str]] = []
    counter = 0

    for chunk in chunks:
        meta = chunk.get("metadata", {})
        url = meta.get("source_url", "")
        if not url or url in url_to_id:
            continue
        counter += 1
        citation_id = f"[Source {counter}]"
        url_to_id[url] = citation_id
        citations.append({
            "citation_id": citation_id,
            "url": url,
            "title": meta.get("source_title", url),
        })

    logger.info("Built citation map with %d unique sources", len(citations))
    return citations, url_to_id


# ---------------------------------------------------------------------------
# Context window + prompt construction
# ---------------------------------------------------------------------------

def _build_context_block(
    chunks: list[dict[str, Any]],
    url_to_id: dict[str, str],
) -> str:
    """Format retrieved chunks into a numbered context block for the prompt.

    Each chunk is tagged with its citation ID so the LLM can reference it.
    """
    lines: list[str] = []
    for i, chunk in enumerate(chunks, 1):
        meta = chunk.get("metadata", {})
        url = meta.get("source_url", "")
        citation_id = url_to_id.get(url, "[Unknown]")
        title = meta.get("source_title", "")
        text = chunk["text"]
        lines.append(
            f"--- Chunk {i} {citation_id} (from: {title}) ---\n{text}"
        )
    return "\n\n".join(lines)


def _build_citation_reference(citations: list[dict[str, str]]) -> str:
    """Build the citation reference legend for the prompt."""
    lines = []
    for c in citations:
        lines.append(f"  {c['citation_id']} = {c['title']} ({c['url']})")
    return "\n".join(lines)


_SYNTHESIS_PROMPT = """You are a research analyst writing a structured, well-cited research report. You must follow these rules strictly:

RULES:
1. You must ONLY use information from the provided source chunks below. Do NOT use your training knowledge or make up facts.
2. Every factual claim must include a citation using the provided citation IDs (e.g., [Source 1], [Source 2]).
3. If the source chunks do not contain enough information to answer a specific sub-question, explicitly state: "The available sources do not cover this aspect."
4. Write in a clear, professional, analytical tone.

CITATION MAP:
{citation_reference}

SOURCE CHUNKS:
{context_block}

RESEARCH QUESTION: {question}

Write a structured research report with EXACTLY these sections:

## Executive Summary
Write 2-3 paragraphs providing a high-level overview of the findings. Cite sources.

## Key Findings
Write 3-5 subsections, each with a clear descriptive heading (### level). Each subsection should cover a distinct theme or aspect of the research question. Every paragraph must cite at least one source.

## Contradictions or Uncertainties
Identify areas where sources disagree, present conflicting data, or where the available evidence is insufficient. If all sources agree, note that consensus exists and on what points.

## Conclusion
Synthesize the key takeaways in 1-2 paragraphs. Restate the most important findings and any gaps in the available evidence.

## References
List all sources you cited using their citation IDs and URLs, one per line.

Begin your report now:"""


def _build_synthesis_prompt(
    question: str,
    chunks: list[dict[str, Any]],
    citations: list[dict[str, str]],
    url_to_id: dict[str, str],
) -> str:
    """Assemble the full synthesis prompt with context and citation map."""
    context_block = _build_context_block(chunks, url_to_id)
    citation_reference = _build_citation_reference(citations)

    return _SYNTHESIS_PROMPT.format(
        question=question,
        context_block=context_block,
        citation_reference=citation_reference,
    )


# ---------------------------------------------------------------------------
# Token streaming
# ---------------------------------------------------------------------------

def _stream_report(
    state: dict,
    prompt: str,
) -> str:
    """Stream the LLM response token-by-token, emitting SSE events.

    Returns the fully assembled report string.
    """
    report_tokens: list[str] = []

    try:
        for token in _ollama_stream(prompt, max_tokens=4096):
            # Check cancellation mid-stream
            if state.get("cancelled"):
                logger.info("Synthesis streaming cancelled by user")
                break

            report_tokens.append(token)
            emit_report_token(state, token)

    except httpx.TimeoutException:
        logger.error("Synthesis LLM streaming timed out")
        if report_tokens:
            # We have partial output — salvage it
            logger.warning(
                "Salvaging partial report (%d tokens received before timeout)",
                len(report_tokens),
            )
        else:
            raise
    except Exception as exc:
        logger.error("Synthesis LLM streaming failed: %s", exc)
        if report_tokens:
            logger.warning(
                "Salvaging partial report (%d tokens before error)",
                len(report_tokens),
            )
        else:
            raise

    return "".join(report_tokens)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(state: dict) -> dict:
    """Execute the Synthesis Agent.

    1. Generate 5-7 diverse retrieval queries via LLM
    2. Embed queries and retrieve top chunks from ChromaDB
    3. Deduplicate and rank chunks by relevance
    4. Build citation map from unique source URLs
    5. Construct synthesis prompt with all context + citation instructions
    6. Stream report token-by-token, emitting SSE events in real-time
    7. Emit report_complete with citation list

    Updates state in-place and returns it.
    """
    # --- Cancellation check ---
    if state.get("cancelled"):
        return state

    session_id = state["session_id"]
    question = state["query"]

    emit_agent_update(
        state, "synthesize", "running",
        "Starting synthesis — generating retrieval queries...",
    )

    # ------------------------------------------------------------------
    # Step 1: Generate retrieval queries
    # ------------------------------------------------------------------
    retrieval_queries = _generate_retrieval_queries(question)
    state["retrieval_queries"] = retrieval_queries

    logger.info("Retrieval queries: %s", retrieval_queries)
    emit_agent_update(
        state, "synthesize", "running",
        f"Generated {len(retrieval_queries)} retrieval queries — searching knowledge base...",
    )

    if state.get("cancelled"):
        return state

    # ------------------------------------------------------------------
    # Step 2: Retrieve and deduplicate chunks
    # ------------------------------------------------------------------
    chunks = _retrieve_chunks(session_id, retrieval_queries)
    state["retrieved_chunks"] = chunks

    if not chunks:
        msg = (
            "ChromaDB returned zero chunks — extraction may have failed entirely. "
            "Cannot synthesize a report without source material."
        )
        logger.error(msg)
        state["error"] = msg
        state["status"] = "error"
        emit_error(state, msg)
        emit_agent_update(state, "synthesize", "error", msg)
        return state

    logger.info("Retrieved %d unique chunks for synthesis", len(chunks))
    emit_agent_update(
        state, "synthesize", "running",
        f"Retrieved {len(chunks)} relevant chunks — building report...",
    )

    if state.get("cancelled"):
        return state

    # ------------------------------------------------------------------
    # Step 3: Build citation map
    # ------------------------------------------------------------------
    citations, url_to_id = _build_citation_map(chunks)
    state["citations"] = citations

    logger.info(
        "Citation map: %s",
        {c["citation_id"]: c["url"][:60] for c in citations},
    )

    # ------------------------------------------------------------------
    # Step 4: Build synthesis prompt
    # ------------------------------------------------------------------
    prompt = _build_synthesis_prompt(question, chunks, citations, url_to_id)
    logger.debug("Synthesis prompt length: %d chars", len(prompt))

    # ------------------------------------------------------------------
    # Step 5: Stream the report
    # ------------------------------------------------------------------
    emit_agent_update(
        state, "synthesize", "running",
        f"Synthesizing report from {len(chunks)} chunks across {len(citations)} sources...",
    )

    try:
        report = _stream_report(state, prompt)
    except Exception as exc:
        msg = f"Report generation failed: {exc}"
        logger.error(msg)
        state["error"] = msg
        state["status"] = "error"
        emit_error(state, msg)
        emit_agent_update(state, "synthesize", "error", msg)
        return state

    if state.get("cancelled"):
        # Partial report may exist — store what we have
        if report:
            state["final_report"] = report
        return state

    # ------------------------------------------------------------------
    # Step 6: Finalize
    # ------------------------------------------------------------------
    state["final_report"] = report

    emit_report_complete(state, citations)
    emit_agent_update(
        state, "synthesize", "done",
        f"Report complete — {len(report)} chars, {len(citations)} sources cited",
    )

    logger.info(
        "Synthesis complete: %d chars, %d citations, %d chunks used",
        len(report), len(citations), len(chunks),
    )

    return state
