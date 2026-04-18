"""Configuration — single source of truth for all settings.

Loads from .env via python-dotenv, resolves paths, and exposes a
validate_config() function that confirms external dependencies are live.
"""

import os
from pathlib import Path

import httpx
from dotenv import load_dotenv

from backend.utils.logger import get_logger

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# Load .env from the project root (one level above backend/)
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_env_path = _PROJECT_ROOT / ".env"
load_dotenv(_env_path)

# ---------------------------------------------------------------------------
# Ollama
# ---------------------------------------------------------------------------
OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
SEARCH_AGENT_MODEL: str = os.getenv("SEARCH_AGENT_MODEL", "mistral:7b-instruct")
EXTRACTION_AGENT_MODEL: str = os.getenv("EXTRACTION_AGENT_MODEL", "qwen2.5:7b")
SYNTHESIS_AGENT_MODEL: str = os.getenv("SYNTHESIS_AGENT_MODEL", "qwen2.5:7b")
EMBEDDING_MODEL: str = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")

# ---------------------------------------------------------------------------
# ChromaDB
# ---------------------------------------------------------------------------
_chroma_raw = os.getenv("CHROMA_PERSIST_DIR", "./chroma_db")
CHROMA_PERSIST_DIR: Path = Path(_chroma_raw).resolve()

# ---------------------------------------------------------------------------
# Search / Scraping / RAG tuning
# ---------------------------------------------------------------------------
TAVILY_API_KEY: str = os.getenv("TAVILY_API_KEY", "").strip()
MAX_SEARCH_RESULTS: int = int(os.getenv("MAX_SEARCH_RESULTS", "10"))
MAX_SOURCES_TO_SCRAPE: int = int(os.getenv("MAX_SOURCES_TO_SCRAPE", "8"))
RAG_TOP_K: int = int(os.getenv("RAG_TOP_K", "5"))
RAG_RETRIEVAL_QUERIES: int = int(os.getenv("RAG_RETRIEVAL_QUERIES", "6"))

# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------
MAX_CONCURRENT_SESSIONS: int = int(os.getenv("MAX_CONCURRENT_SESSIONS", "3"))
SESSION_TTL_SECONDS: int = int(os.getenv("SESSION_TTL_SECONDS", "3600"))


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_config() -> None:
    """Validate all required configuration and external dependencies.

    Called once at application startup and once before each pipeline launch.
    Raises RuntimeError with a descriptive message on failure.
    """
    errors: list[str] = []

    # --- Required string settings ---
    if not OLLAMA_BASE_URL:
        errors.append("OLLAMA_BASE_URL is empty or not set.")
    if not SEARCH_AGENT_MODEL:
        errors.append("SEARCH_AGENT_MODEL is empty or not set.")
    if not EXTRACTION_AGENT_MODEL:
        errors.append("EXTRACTION_AGENT_MODEL is empty or not set.")
    if not SYNTHESIS_AGENT_MODEL:
        errors.append("SYNTHESIS_AGENT_MODEL is empty or not set.")

    # --- Numeric settings ---
    if MAX_CONCURRENT_SESSIONS < 1:
        errors.append(
            f"MAX_CONCURRENT_SESSIONS must be a positive integer, got {MAX_CONCURRENT_SESSIONS}."
        )
    if SESSION_TTL_SECONDS < 1:
        errors.append(
            f"SESSION_TTL_SECONDS must be a positive integer, got {SESSION_TTL_SECONDS}."
        )

    # --- ChromaDB path ---
    try:
        CHROMA_PERSIST_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        errors.append(
            f"CHROMA_PERSIST_DIR '{CHROMA_PERSIST_DIR}' cannot be created: {exc}"
        )

    # --- Ollama connectivity ---
    try:
        resp = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5.0)
        resp.raise_for_status()
        logger.info("Ollama reachable at %s", OLLAMA_BASE_URL)
    except (httpx.HTTPError, httpx.ConnectError, OSError) as exc:
        errors.append(
            f"Ollama is not reachable at {OLLAMA_BASE_URL}: {exc}"
        )

    # --- Tavily (optional) ---
    if TAVILY_API_KEY:
        logger.info("TAVILY_API_KEY is set — Tavily search enabled.")
    else:
        logger.info("TAVILY_API_KEY not set — using DuckDuckGo.")

    # --- Report and raise ---
    if errors:
        combined = "\n  - ".join(errors)
        raise RuntimeError(f"Configuration validation failed:\n  - {combined}")

    logger.info("Configuration validated successfully.")
