"""Report formatting utilities — citation repair, markdown cleanup, exports.

These functions power the ``format_node`` post-processing stage and the
``/report`` export path. They are pure (no I/O, no state mutation) and
composable — each takes a string and returns a transformed string.

The high-level entry point is ``finalize_report()``, which applies the
full pipeline in the correct order:

    raw LLM output
        → normalize_citations      (unify citation formats)
        → repair_citations         (strip orphaned markers)
        → rebuild_references       (replace LLM's References section)
        → clean_markdown           (fix headers, fences, whitespace)
        → inject_metadata          (append query/duration/timestamp footer)
    → clean, cited markdown report

Public API:
    finalize_report(report, citations, state) → cleaned report string
    normalize_citations(report)                → report with unified markers
    repair_citations(report, citations)        → (report, used_ids) tuple
    rebuild_references(report, citations)      → report with canonical refs
    clean_markdown(report)                     → markdown-tidy report
    inject_metadata(report, state)             → report + metadata footer
    build_export_markdown(state)               → fully-formed export string
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any

from backend.utils.logger import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Citation patterns
# ---------------------------------------------------------------------------

# Canonical citation marker: [Source 3]
_CANONICAL_CITATION_RE = re.compile(r"\[Source\s+(\d+)\]")

# Case-insensitive marker variations the LLM sometimes produces.
# Covers: [source 3], [SOURCE 3], [Source3], [Source: 3], [src 3], (Source 3)
_LOOSE_CITATION_RE = re.compile(
    r"""
    [\[\(]                      # opening bracket or paren
    \s*
    (?:source|src|ref|reference)
    \s*[:\s]\s*                 # colon or just whitespace
    (\d+)                       # the number — capture
    \s*
    [\]\)]                      # closing bracket or paren
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Multi-number citations: [Source 1, 2, 3] or [Sources 1, 2, 3] or [Source 1,2]
_MULTI_CITATION_RE = re.compile(
    r"""
    \[
    \s*
    sources?                    # "source" or "sources"
    \s+
    (                           # capture the number list
        \d+
        (?:\s*,\s*\d+)+         # at least one ", N" to qualify as multi
    )
    \s*
    \]
    """,
    re.IGNORECASE | re.VERBOSE,
)


# ---------------------------------------------------------------------------
# Normalize — unify citation formats
# ---------------------------------------------------------------------------

def normalize_citations(report: str) -> str:
    """Convert all citation marker variations into the canonical ``[Source N]``.

    Handles:
      - ``[source 3]``, ``[SOURCE 3]``, ``[Source3]``, ``[Source: 3]`` → ``[Source 3]``
      - ``(Source 3)`` → ``[Source 3]``
      - ``[Source 1, 2, 3]`` → ``[Source 1][Source 2][Source 3]``
      - ``[Sources 1, 2]`` → ``[Source 1][Source 2]``

    Runs BEFORE ``repair_citations`` so the repair pass sees a consistent format.
    """
    if not report:
        return report

    # Step 1: expand multi-number citations first (they must be handled
    # before the loose single-marker regex can misinterpret them).
    def _expand_multi(match: re.Match) -> str:
        numbers_raw = match.group(1)
        numbers = re.findall(r"\d+", numbers_raw)
        return "".join(f"[Source {n}]" for n in numbers)

    report = _MULTI_CITATION_RE.sub(_expand_multi, report)

    # Step 2: normalize any remaining single-marker variations.
    def _canon(match: re.Match) -> str:
        return f"[Source {match.group(1)}]"

    report = _LOOSE_CITATION_RE.sub(_canon, report)

    return report


# ---------------------------------------------------------------------------
# Repair — strip orphans, track usage
# ---------------------------------------------------------------------------

def repair_citations(
    report: str,
    citations: list[dict],
) -> tuple[str, set[str]]:
    """Remove orphaned citation markers from the report.

    An orphan is a ``[Source N]`` marker whose N doesn't appear in the
    provided citations list. These get stripped (along with any trailing
    whitespace/comma they leave behind) to avoid confusing the reader.

    Returns:
        (cleaned_report, used_citation_ids_set)
    """
    if not report:
        return report, set()

    valid_ids = {c["citation_id"] for c in citations}
    found_markers = set(_CANONICAL_CITATION_RE.findall(report))
    found_ids = {f"[Source {n}]" for n in found_markers}

    orphans = found_ids - valid_ids
    used_ids = found_ids & valid_ids

    if orphans:
        logger.warning(
            "Removing %d orphaned citation markers: %s",
            len(orphans), sorted(orphans),
        )
        for orphan in orphans:
            # Remove the marker and any surrounding cruft it leaves
            escaped = re.escape(orphan)
            # Case A: marker preceded by a space and followed by punctuation
            #   "claim [Source 9]." → "claim."
            report = re.sub(rf"\s+{escaped}(?=[.,;:!?\)\]])", "", report)
            # Case B: standalone marker
            #   "claim [Source 9] next" → "claim next"
            report = re.sub(rf"\s*{escaped}\s*", " ", report)

        # Collapse double spaces and space-before-punctuation left by removals
        report = re.sub(r"  +", " ", report)
        report = re.sub(r" ([.,;:!?])", r"\1", report)

    if not used_ids:
        logger.warning("Report contains zero valid citation markers")
    elif len(used_ids) < len(valid_ids):
        unused = len(valid_ids) - len(used_ids)
        logger.info(
            "%d/%d citations unused in body — still listed in references",
            unused, len(valid_ids),
        )

    return report, used_ids


# ---------------------------------------------------------------------------
# References — rebuild from citation map
# ---------------------------------------------------------------------------

# Match a References section heading (##, ###, or bold) through to the next
# same-or-higher-level heading, or end-of-string. Tolerates LLM variations:
#   "## References", "### References", "**References**", "## Sources"
_REFERENCES_SECTION_RE = re.compile(
    r"""
    (^|\n)                       # line start
    (?:                          # one of these heading formats:
        \#{1,6}\s*               #   markdown heading
        |                        #   OR
        \*\*                     #   bold opener
    )
    \s*
    (?:references?|sources?|bibliography|citations?)
    \s*
    (?:\*\*)?                    # optional bold closer
    \s*\n                        # end of heading line
    .*?                          # section body (non-greedy)
    (?=                          # stop before:
        \n\#{1,6}\s              #   next markdown heading
        |                        #   OR
        \Z                       #   end of string
    )
    """,
    re.DOTALL | re.IGNORECASE | re.VERBOSE,
)


def _escape_markdown(text: str) -> str:
    """Escape characters that would break a markdown list-item line."""
    # Only escape characters that actively cause problems in a list context.
    # Pipe escaping matters inside tables; keep it conservative.
    return text.replace("|", "\\|").replace("\n", " ").strip()


def rebuild_references(report: str, citations: list[dict]) -> str:
    """Replace the LLM-generated References section with a canonical one.

    The LLM is unreliable at listing references — it sometimes hallucinates
    URLs, reorders citations, or drops sources entirely. This function
    rewrites the References section programmatically from the citations map.

    If no References section is found, one is appended.
    """
    ref_lines = ["## References", ""]
    if citations:
        for c in citations:
            title = _escape_markdown(c.get("title", ""))
            url = c.get("url", "")
            cid = c.get("citation_id", "[Source ?]")
            ref_lines.append(f"- {cid} — {title}: {url}")
    else:
        ref_lines.append("*No sources were cited.*")

    ref_block = "\n".join(ref_lines)

    match = _REFERENCES_SECTION_RE.search(report)
    if match:
        # Preserve the leading newline captured by group(1) if present
        leading = match.group(1) or ""
        replacement = f"{leading}{ref_block}"
        report = report[:match.start()] + replacement + report[match.end():]
    else:
        report = report.rstrip() + "\n\n" + ref_block

    return report


# ---------------------------------------------------------------------------
# Markdown cleanup
# ---------------------------------------------------------------------------

def clean_markdown(report: str) -> str:
    """Tidy up common markdown issues produced by LLM output.

    Fixes:
      - excessive blank lines (4+ → 3)
      - headers missing a space after ``#`` (``##Heading`` → ``## Heading``)
      - unclosed code fences (adds a trailing ``\\`\\`\\``)
      - trailing whitespace on lines
      - stray bare ``**`` markers with no matching pair (best-effort)
      - leading/trailing whitespace on the whole document
    """
    if not report:
        return report

    # Collapse 4+ consecutive newlines into 3 (at most two blank lines).
    report = re.sub(r"\n{4,}", "\n\n\n", report)

    # Header hygiene: ensure space after # on heading lines.
    report = re.sub(r"^(#{1,6})([^ #\n])", r"\1 \2", report, flags=re.MULTILINE)

    # Close unclosed fenced code blocks.
    fence_count = len(re.findall(r"^```", report, re.MULTILINE))
    if fence_count % 2 != 0:
        report = report.rstrip() + "\n```"

    # Strip trailing whitespace from every line.
    report = re.sub(r"[ \t]+$", "", report, flags=re.MULTILINE)

    # Best-effort fix for odd-count `**` markers on a single line:
    # if a line has a lone `**` at the end with no pair, drop it.
    def _fix_bold_line(line: str) -> str:
        if line.count("**") % 2 != 0 and line.rstrip().endswith("**"):
            return line.rstrip()[:-2].rstrip()
        return line

    report = "\n".join(_fix_bold_line(line) for line in report.split("\n"))

    # Strip leading/trailing whitespace on the whole doc and guarantee
    # exactly one trailing newline.
    return report.strip() + "\n"


# ---------------------------------------------------------------------------
# Metadata footer
# ---------------------------------------------------------------------------

def inject_metadata(report: str, state: dict[str, Any]) -> str:
    """Append a metadata footer describing the research run."""
    query = state.get("query", "")
    sources_processed = state.get("sources_processed", 0)
    scraping_errors = state.get("scraping_errors", [])
    citations_count = len(state.get("citations", []))

    # Prefer pre-computed duration if present (set by format_node).
    if state.get("pipeline_duration"):
        duration = round(float(state["pipeline_duration"]), 1)
    else:
        start_time = state.get("session_start_time") or time.time()
        duration = round(time.time() - start_time, 1)

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    footer = [
        "",
        "---",
        "",
        "*Report metadata:*",
        f"- **Query**: {query}",
        f"- **Sources scraped**: {sources_processed}",
        f"- **Sources failed**: {len(scraping_errors)}",
        f"- **Citations**: {citations_count}",
        f"- **Pipeline duration**: {duration}s",
        f"- **Generated**: {timestamp}",
        "- **Engine**: AutoResearcher v1.0",
    ]

    return report.rstrip() + "\n" + "\n".join(footer) + "\n"


# ---------------------------------------------------------------------------
# Finalize — orchestrator
# ---------------------------------------------------------------------------

def finalize_report(
    report: str,
    citations: list[dict],
    state: dict[str, Any],
) -> tuple[str, list[dict]]:
    """Apply the full formatting pipeline to raw LLM output.

    Order:
      1. normalize_citations
      2. repair_citations
      3. rebuild_references
      4. clean_markdown
      5. inject_metadata

    Returns:
        (cleaned_report, citations) — citations are returned unchanged for v1
        (they're kept in full so the References section includes every source
        the agent retrieved, even those the LLM didn't cite inline).
    """
    if not report:
        # Produce a stub report so downstream consumers have something to show.
        stub = "# Research Report\n\n*The pipeline produced no content.*\n"
        stub = rebuild_references(stub, citations)
        stub = inject_metadata(stub, state)
        return stub, citations

    report = normalize_citations(report)
    report, _used = repair_citations(report, citations)
    report = rebuild_references(report, citations)
    report = clean_markdown(report)
    report = inject_metadata(report, state)

    return report, citations


# ---------------------------------------------------------------------------
# Export builder
# ---------------------------------------------------------------------------

def build_export_markdown(state: dict[str, Any]) -> str:
    """Assemble a polished markdown document suitable for download.

    Prepends a ``# <Query>`` title if the report doesn't already begin with
    an H1. This is what the frontend downloads when the user clicks
    "Export as Markdown".
    """
    report = state.get("final_report", "").strip()
    query = state.get("query", "").strip()

    if not report:
        return f"# {query or 'Research Report'}\n\n*No report was generated.*\n"

    # If the report doesn't start with an H1, inject one based on the query.
    if not report.lstrip().startswith("# "):
        title = f"# Research Report: {query}" if query else "# Research Report"
        report = f"{title}\n\n{report}"

    return report if report.endswith("\n") else report + "\n"
