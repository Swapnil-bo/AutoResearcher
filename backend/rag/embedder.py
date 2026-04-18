"""Sentence-transformers embedding wrapper.

Loads the model specified by config.EMBEDDING_MODEL (default: all-MiniLM-L6-v2)
onto CPU and exposes a simple embed interface for single texts and batches.
The model is loaded lazily on first use so import alone costs nothing.
"""

from __future__ import annotations

from sentence_transformers import SentenceTransformer

from backend.config import EMBEDDING_MODEL
from backend.utils.logger import get_logger

logger = get_logger(__name__)

_model: SentenceTransformer | None = None


def _get_model() -> SentenceTransformer:
    """Lazy-load the embedding model onto CPU."""
    global _model
    if _model is None:
        logger.info("Loading embedding model '%s' on CPU...", EMBEDDING_MODEL)
        try:
            _model = SentenceTransformer(EMBEDDING_MODEL, device="cpu")
            logger.info("Embedding model loaded successfully.")
        except Exception as exc:
            raise RuntimeError(
                f"Failed to load embedding model '{EMBEDDING_MODEL}': {exc}"
            ) from exc
    return _model


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts and return a list of float vectors.

    Args:
        texts: Non-empty list of strings to embed.

    Returns:
        List of embedding vectors, one per input text.
        Each vector is a plain Python list[float] suitable for ChromaDB upsert.

    Raises:
        RuntimeError: If the model fails to load.
        ValueError: If texts is empty.
    """
    if not texts:
        raise ValueError("embed_texts called with empty list.")

    model = _get_model()
    try:
        embeddings = model.encode(texts, show_progress_bar=False, convert_to_numpy=True)
        return embeddings.tolist()
    except Exception as exc:
        logger.error("Embedding failed for batch of %d texts: %s", len(texts), exc)
        raise


def embed_text(text: str) -> list[float]:
    """Embed a single text string. Convenience wrapper around embed_texts."""
    return embed_texts([text])[0]
