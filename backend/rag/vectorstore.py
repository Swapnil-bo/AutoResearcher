"""ChromaDB client — session-scoped collection management.

Every research session gets its own collection named ``research_{session_id}``.
Collections are created at extraction time and deleted by the format_node
(or error_node) once the pipeline terminates.

Public API:
    get_client()                    → persistent ChromaDB client (singleton)
    create_session_collection(sid)  → new collection for the session
    get_session_collection(sid)     → existing collection (or None)
    upsert_chunks(sid, chunks)      → batch-upsert embedded chunks
    query_chunks(sid, query_emb, k) → top-k similar chunks
    delete_session_collection(sid)  → tear down the session collection
    list_collections()              → all collection names (for health check)
"""

from __future__ import annotations

import time
from typing import Any

import chromadb
from chromadb.api.models.Collection import Collection

from backend.config import CHROMA_PERSIST_DIR
from backend.utils.logger import get_logger

logger = get_logger(__name__)

_client: chromadb.ClientAPI | None = None


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

def get_client() -> chromadb.ClientAPI:
    """Return (or create) the persistent ChromaDB client singleton."""
    global _client
    if _client is None:
        logger.info("Initializing ChromaDB client at '%s'", CHROMA_PERSIST_DIR)
        try:
            CHROMA_PERSIST_DIR.mkdir(parents=True, exist_ok=True)
            _client = chromadb.PersistentClient(path=str(CHROMA_PERSIST_DIR))
            logger.info("ChromaDB client ready.")
        except Exception as exc:
            raise RuntimeError(
                f"Failed to initialize ChromaDB at '{CHROMA_PERSIST_DIR}': {exc}"
            ) from exc
    return _client


def _collection_name(session_id: str) -> str:
    """Canonical collection name for a session."""
    return f"research_{session_id}"


# ---------------------------------------------------------------------------
# Collection lifecycle
# ---------------------------------------------------------------------------

def create_session_collection(session_id: str) -> Collection:
    """Create a fresh collection for a research session.

    Uses cosine similarity — the default distance metric for
    sentence-transformer embeddings.
    """
    name = _collection_name(session_id)
    client = get_client()
    try:
        collection = client.get_or_create_collection(
            name=name,
            metadata={"hnsw:space": "cosine"},
        )
        logger.info("Created collection '%s'", name)
        return collection
    except Exception as exc:
        raise RuntimeError(
            f"Failed to create ChromaDB collection '{name}': {exc}"
        ) from exc


def get_session_collection(session_id: str) -> Collection | None:
    """Return an existing session collection, or None if it doesn't exist."""
    name = _collection_name(session_id)
    client = get_client()
    try:
        return client.get_collection(name=name)
    except Exception:
        logger.warning("Collection '%s' not found.", name)
        return None


def delete_session_collection(session_id: str) -> bool:
    """Delete a session's collection. Returns True on success, False on error.

    Callers (format_node, error_node) should log but never crash on failure.
    """
    name = _collection_name(session_id)
    client = get_client()
    try:
        client.delete_collection(name=name)
        logger.info("Deleted collection '%s'", name)
        return True
    except Exception as exc:
        logger.error("Failed to delete collection '%s': %s", name, exc)
        return False


# ---------------------------------------------------------------------------
# Chunk upsert
# ---------------------------------------------------------------------------

def upsert_chunks(
    session_id: str,
    chunks: list[dict[str, Any]],
) -> int:
    """Batch-upsert embedded chunks into the session collection.

    Each chunk dict must contain:
        text         (str)   — the chunk text
        embedding    (list[float]) — pre-computed embedding vector
        source_url   (str)
        source_title (str)
        chunk_index  (int)

    The function assigns deterministic IDs (``{session_id}_{i}``) and
    attaches the required metadata: source_url, source_title, chunk_index,
    session_id, timestamp.

    Returns the number of chunks successfully upserted.
    """
    collection = get_session_collection(session_id)
    if collection is None:
        collection = create_session_collection(session_id)

    if not chunks:
        return 0

    now = time.time()

    ids: list[str] = []
    documents: list[str] = []
    embeddings: list[list[float]] = []
    metadatas: list[dict[str, Any]] = []

    # Determine current count so IDs are globally unique within the session
    existing_count = collection.count()

    for i, chunk in enumerate(chunks):
        idx = existing_count + i
        ids.append(f"{session_id}_{idx}")
        documents.append(chunk["text"])
        embeddings.append(chunk["embedding"])
        metadatas.append({
            "source_url": chunk["source_url"],
            "source_title": chunk["source_title"],
            "chunk_index": chunk["chunk_index"],
            "session_id": session_id,
            "timestamp": now,
        })

    # ChromaDB supports batch upsert; chunk into batches of 100 to avoid
    # oversized payloads on very large scrapes.
    batch_size = 100
    upserted = 0
    for start in range(0, len(ids), batch_size):
        end = start + batch_size
        try:
            collection.upsert(
                ids=ids[start:end],
                documents=documents[start:end],
                embeddings=embeddings[start:end],
                metadatas=metadatas[start:end],
            )
            upserted += end - start
        except Exception as exc:
            logger.error(
                "Upsert failed for batch [%d:%d] in session %s: %s",
                start, end, session_id, exc,
            )

    upserted = min(upserted, len(ids))
    logger.info(
        "Upserted %d/%d chunks into '%s'",
        upserted, len(ids), _collection_name(session_id),
    )
    return upserted


# ---------------------------------------------------------------------------
# Chunk query
# ---------------------------------------------------------------------------

def query_chunks(
    session_id: str,
    query_embedding: list[float],
    top_k: int = 5,
) -> list[dict[str, Any]]:
    """Query the session collection for the most relevant chunks.

    Returns a list of dicts, each with:
        text       (str)
        metadata   (dict)   — source_url, source_title, chunk_index, etc.
        distance   (float)  — cosine distance (lower = more similar)
    Ordered by relevance (most similar first).
    """
    collection = get_session_collection(session_id)
    if collection is None:
        logger.warning("query_chunks: no collection for session %s", session_id)
        return []

    if collection.count() == 0:
        logger.warning("query_chunks: collection is empty for session %s", session_id)
        return []

    try:
        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=min(top_k, collection.count()),
            include=["documents", "metadatas", "distances"],
        )
    except Exception as exc:
        logger.error("ChromaDB query failed for session %s: %s", session_id, exc)
        return []

    # Unpack ChromaDB's nested list format (one list per query embedding)
    documents = results.get("documents", [[]])[0]
    metadatas = results.get("metadatas", [[]])[0]
    distances = results.get("distances", [[]])[0]

    chunks: list[dict[str, Any]] = []
    for doc, meta, dist in zip(documents, metadatas, distances):
        chunks.append({
            "text": doc,
            "metadata": meta,
            "distance": dist,
        })

    logger.debug(
        "Retrieved %d chunks for session %s (top distance=%.4f)",
        len(chunks),
        session_id,
        chunks[0]["distance"] if chunks else 0.0,
    )
    return chunks


# ---------------------------------------------------------------------------
# Health / utility
# ---------------------------------------------------------------------------

def list_collections() -> list[str]:
    """Return all collection names. Used by the /api/health endpoint."""
    try:
        client = get_client()
        return [c.name for c in client.list_collections()]
    except Exception as exc:
        logger.error("Failed to list ChromaDB collections: %s", exc)
        return []
