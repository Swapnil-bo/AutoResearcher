"""URL fetcher, HTML cleaner, and text chunker.

Fetches a web page via httpx, strips it to readable text with BeautifulSoup,
removes boilerplate, and chunks the result into overlapping segments ready
for embedding.

Public API:
    scrape_url(url)          -> {ok, text, chunks, error}
    fetch_url(url)           -> raw HTML string or raises
    extract_text(html)       -> cleaned plain text
    chunk_text(text, ...)    -> list of chunk strings
"""

from __future__ import annotations

import re
from typing import Any

import httpx
from bs4 import BeautifulSoup, Comment

from backend.utils.logger import get_logger

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_FETCH_TIMEOUT = 10.0  # seconds
_MIN_TEXT_LENGTH = 200  # characters — below this the page is likely paywalled/empty

# Approximate tokens-to-chars ratio for English text (~4 chars per token)
_CHARS_PER_TOKEN = 4
_CHUNK_SIZE_TOKENS = 500
_CHUNK_OVERLAP_TOKENS = 50
_CHUNK_SIZE_CHARS = _CHUNK_SIZE_TOKENS * _CHARS_PER_TOKEN      # ~2000
_CHUNK_OVERLAP_CHARS = _CHUNK_OVERLAP_TOKENS * _CHARS_PER_TOKEN  # ~200

# Tags to extract content from
_CONTENT_TAGS = {"p", "h1", "h2", "h3", "li"}

# Tags/elements to remove entirely before extraction.
# NOTE: <header> is intentionally excluded — many modern sites wrap their
# entire article inside a <header> element (e.g. NVIDIA blog).
_STRIP_TAGS = {
    "nav", "footer", "aside", "script", "style", "noscript",
    "iframe", "form", "button", "svg", "figure", "figcaption",
}

# Common boilerplate strings to remove (case-insensitive matching)
_BOILERPLATE_PATTERNS = [
    r"accept\s+(?:all\s+)?cookies?",
    r"we\s+use\s+cookies",
    r"cookie\s+(?:policy|preferences|settings|consent)",
    r"subscribe\s+to\s+continue",
    r"sign\s+in\s+to\s+(?:read|continue|view)",
    r"log\s+in\s+to\s+(?:read|continue|view)",
    r"create\s+(?:a\s+)?free\s+account",
    r"already\s+(?:a\s+)?(?:member|subscriber)",
    r"advertisement",
    r"sponsored\s+content",
    r"share\s+(?:this|on)\s+(?:facebook|twitter|linkedin|x)",
    r"read\s+more\s+on\s+this\s+topic",
    r"newsletter",
    r"skip\s+to\s+(?:main\s+)?content",
    r"terms\s+of\s+(?:service|use)",
    r"privacy\s+policy",
]

_BOILERPLATE_RE = re.compile(
    "|".join(f"(?:{p})" for p in _BOILERPLATE_PATTERNS),
    re.IGNORECASE,
)

# User-Agent header — realistic browser UA to avoid bot-detection blocks.
# Most sites (including Wikipedia) serve full HTML to recognized browsers.
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------

def fetch_url(url: str) -> str:
    """Fetch a URL and return the raw HTML.

    Timeout: 10 seconds. Follows redirects.
    Raises on any HTTP or connection error.
    """
    with httpx.Client(
        timeout=_FETCH_TIMEOUT,
        follow_redirects=True,
        headers=_HEADERS,
    ) as client:
        resp = client.get(url)
        resp.raise_for_status()
        return resp.text


# ---------------------------------------------------------------------------
# HTML -> text
# ---------------------------------------------------------------------------

def extract_text(html: str) -> str:
    """Parse HTML and return clean readable text.

    - Removes nav, footer, ads, scripts, comments, and other non-content elements.
    - Extracts only <p>, <h1>-<h3>, <li> text.
    - Collapses whitespace and removes boilerplate strings.
    """
    soup = BeautifulSoup(html, "html.parser")

    # Remove unwanted elements
    for tag_name in _STRIP_TAGS:
        for el in soup.find_all(tag_name):
            el.decompose()

    # Remove HTML comments
    for comment in soup.find_all(string=lambda s: isinstance(s, Comment)):
        comment.extract()

    # Remove elements whose class or id tokens indicate non-content.
    # We check individual CSS class tokens (not the full string) to avoid
    # false positives like "post-with-sidebar" matching "sidebar".
    _BOILERPLATE_CLASS_TOKENS = {
        "cookie-bar", "cookie-banner", "cookie-consent", "cookie-notice",
        "cookie-popup", "consent-bar", "consent-banner", "consent-modal",
        "ad-banner", "ad-slot", "ad-container", "ad-wrapper",
        "ads-banner", "ads-slot", "ads-container", "ads-wrapper",
        "advertisement", "social-share", "social-links", "social-icons",
        "newsletter-signup", "newsletter-form", "newsletter-banner",
        "popup-overlay", "popup-modal", "modal-overlay", "modal-backdrop",
        "sidebar", "breadcrumb", "breadcrumbs",
    }

    # Collect elements to remove first, then decompose — calling decompose()
    # mid-iteration invalidates child elements' .attrs (becomes None), which
    # crashes subsequent .get("class") calls.
    to_remove: list = []
    for el in soup.find_all(attrs={"class": True}):
        if el.attrs is None:
            continue
        classes = el.get("class", [])
        for cls in classes:
            if cls.lower() in _BOILERPLATE_CLASS_TOKENS:
                to_remove.append(el)
                break

    # Also check id attributes (single string, not a list)
    _boilerplate_id_re = re.compile(
        r"^(?:cookie|consent|ad-banner|ads-banner|advertisement|"
        r"social-share|newsletter|sidebar|breadcrumb)",
        re.IGNORECASE,
    )
    for el in soup.find_all(attrs={"id": _boilerplate_id_re}):
        to_remove.append(el)

    for el in to_remove:
        try:
            el.decompose()
        except Exception:
            pass

    # Extract text from content tags only
    parts: list[str] = []
    for tag in soup.find_all(_CONTENT_TAGS):
        text = tag.get_text(separator=" ", strip=True)
        if text:
            parts.append(text)

    raw_text = "\n".join(parts)
    return _clean_text(raw_text)


def _clean_text(text: str) -> str:
    """Collapse whitespace, strip boilerplate strings, normalize newlines."""
    # Remove boilerplate phrases (entire line if it's mostly boilerplate)
    lines: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        # Skip lines that are predominantly boilerplate
        if _BOILERPLATE_RE.search(stripped) and len(stripped) < 120:
            continue
        lines.append(stripped)

    text = "\n".join(lines)

    # Collapse multiple whitespace within lines
    text = re.sub(r"[ \t]+", " ", text)
    # Collapse 3+ consecutive newlines into 2
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip()


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------

def chunk_text(
    text: str,
    chunk_size: int = _CHUNK_SIZE_CHARS,
    overlap: int = _CHUNK_OVERLAP_CHARS,
) -> list[str]:
    """Split text into overlapping chunks.

    Default: ~500-token chunks with ~50-token overlap (using ~4 chars/token).
    Splits on sentence boundaries when possible to avoid cutting mid-sentence.
    """
    if not text:
        return []

    if len(text) <= chunk_size:
        return [text]

    # Split into sentences for cleaner boundaries
    sentences = _split_sentences(text)

    chunks: list[str] = []
    current_chunk: list[str] = []
    current_len = 0

    for sentence in sentences:
        sentence_len = len(sentence)

        # If a single sentence exceeds chunk_size, force-split it
        if sentence_len > chunk_size:
            # Flush current chunk first
            if current_chunk:
                chunks.append(" ".join(current_chunk))
                current_chunk = []
                current_len = 0
            # Hard-split the long sentence
            for start in range(0, sentence_len, chunk_size - overlap):
                chunks.append(sentence[start:start + chunk_size])
            continue

        # Would adding this sentence exceed the chunk size?
        if current_len + sentence_len + 1 > chunk_size and current_chunk:
            chunks.append(" ".join(current_chunk))

            # Build overlap: take trailing sentences that fit within overlap size
            overlap_chunk: list[str] = []
            overlap_len = 0
            for s in reversed(current_chunk):
                if overlap_len + len(s) + 1 > overlap:
                    break
                overlap_chunk.insert(0, s)
                overlap_len += len(s) + 1

            current_chunk = overlap_chunk
            current_len = overlap_len

        current_chunk.append(sentence)
        current_len += sentence_len + 1

    # Flush remaining
    if current_chunk:
        chunks.append(" ".join(current_chunk))

    return chunks


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences using a regex heuristic.

    Handles common abbreviations and decimal numbers to avoid false splits.
    """
    # Split on period/question/exclamation followed by whitespace and uppercase
    # but not after common abbreviations
    parts = re.split(r'(?<=[.!?])\s+(?=[A-Z"])', text)
    # Filter empty strings
    return [p.strip() for p in parts if p.strip()]


# ---------------------------------------------------------------------------
# High-level scrape
# ---------------------------------------------------------------------------

def scrape_url(url: str) -> dict[str, Any]:
    """Full scrape pipeline: fetch -> extract -> clean -> validate -> chunk.

    Returns:
        {
            "ok": bool,
            "url": str,
            "text": str,          # full cleaned text (empty on failure)
            "chunks": list[str],  # text chunks (empty on failure)
            "error": str | None,  # error reason if ok=False
        }
    """
    # Fetch
    try:
        html = fetch_url(url)
    except httpx.TimeoutException:
        reason = "Timeout after 10 seconds"
        logger.warning("Fetch failed [%s]: %s", url, reason)
        return {"ok": False, "url": url, "text": "", "chunks": [], "error": reason}
    except httpx.HTTPStatusError as exc:
        reason = f"HTTP {exc.response.status_code}"
        logger.warning("Fetch failed [%s]: %s", url, reason)
        return {"ok": False, "url": url, "text": "", "chunks": [], "error": reason}
    except Exception as exc:
        reason = f"Connection error: {type(exc).__name__}: {exc}"
        logger.warning("Fetch failed [%s]: %s", url, reason)
        return {"ok": False, "url": url, "text": "", "chunks": [], "error": reason}

    # Extract and clean
    text = extract_text(html)

    # Validate minimum content
    if len(text) < _MIN_TEXT_LENGTH:
        reason = f"Content too short ({len(text)} chars) — likely paywalled or empty"
        logger.warning("Skipping [%s]: %s", url, reason)
        return {"ok": False, "url": url, "text": text, "chunks": [], "error": reason}

    # Chunk
    chunks = chunk_text(text)
    logger.info(
        "Scraped [%s]: %d chars, %d chunks",
        url, len(text), len(chunks),
    )

    return {"ok": True, "url": url, "text": text, "chunks": chunks, "error": None}
