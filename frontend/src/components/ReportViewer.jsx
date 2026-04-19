import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";

/**
 * ReportViewer — the payoff surface.
 *
 * Hidden entirely until a report exists or streaming begins. Renders the
 * progressive markdown while tokens arrive, then reveals a canonical
 * References panel built from the citations payload.
 *
 * Props:
 *   · content            — accumulated markdown string (from report_token events)
 *   · streaming          — true while tokens are actively arriving
 *   · complete           — true once pipeline_complete fires
 *   · citations          — [{ citation_id, url, title }] from report_complete
 *   · query              — original research question (used for export filename)
 *   · sessionId          — used as an export-filename fallback
 *   · pipelineDuration   — seconds, shown in the header once complete
 *   · sourcesProcessed   — shown in the header once complete
 */

const WORDS_PER_MINUTE = 220;

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function slugify(text, max = 60) {
  if (!text) return "report";
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, max) || "report"
  );
}

function todayStamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("");
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/**
 * Preprocess the markdown string:
 *   1. Strip any trailing "## References" section — we render our own panel
 *      from `citations` to guarantee anchored, clickable entries.
 *   2. Linkify inline "[Source N]" markers so they jump to #ref-N.
 * Returns the body markdown ready to pass to ReactMarkdown.
 */
function prepareBody(raw, citationIds) {
  if (!raw) return "";
  let body = raw;

  // Strip the last "References" section to avoid duplicating what our
  // bottom panel already owns. Matches "## References", "### References", etc.
  const refHeadingMatch = body.match(/\n#{1,6}\s*References\s*\n/i);
  if (refHeadingMatch && refHeadingMatch.index != null) {
    body = body.slice(0, refHeadingMatch.index);
  }

  // Wrap valid [Source N] markers with anchor links. We only linkify ids
  // that actually exist in the citations list so stray markers degrade to
  // plain text instead of broken jumps.
  if (citationIds.size > 0) {
    body = body.replace(/\[Source\s+(\d+)\]/g, (match, num) => {
      return citationIds.has(Number(num)) ? `[[Source ${num}]](#ref-${num})` : match;
    });
  }

  return body.trimEnd();
}

function extractCitationId(citation, fallback) {
  // Accept either a numeric id or a string like "Source 3".
  if (typeof citation.citation_id === "number") return citation.citation_id;
  const m = String(citation.citation_id ?? "").match(/\d+/);
  return m ? Number(m[0]) : fallback;
}

/* ── Icons ─────────────────────────────────────────────────────────── */

function CopyIcon({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"
        stroke="currentColor"
        strokeWidth="1.75"
      />
    </svg>
  );
}

function DownloadIcon({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M4 12l5 5L20 6"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ArrowUpIcon({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M12 19V5M6 11l6-6 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExternalIcon({ className = "h-3 w-3" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M14 4h6v6M10 14L20 4M20 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ── React-Markdown component overrides ───────────────────────────── */

const MD_COMPONENTS = {
  a({ href = "", children, ...rest }) {
    const isInternal = href.startsWith("#");
    if (isInternal) {
      return (
        <a href={href} className="citation" {...rest}>
          {children}
        </a>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        {...rest}
      >
        {children}
        <ExternalIcon className="ml-1 inline h-3 w-3 opacity-70" />
      </a>
    );
  },
};

/* ── Component ────────────────────────────────────────────────────── */

export default function ReportViewer({
  content = "",
  streaming = false,
  complete = false,
  citations = [],
  query = "",
  sessionId = null,
  pipelineDuration = null,
  sourcesProcessed = null,
  className = "",
}) {
  const scrollRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const [exported, setExported] = useState(false);
  const [scrollPct, setScrollPct] = useState(0);
  const [followLatest, setFollowLatest] = useState(true);

  const hasContent = content && content.length > 0;
  const visible = hasContent || streaming;

  const citationIds = useMemo(
    () =>
      new Set(
        citations
          .map((c, i) => extractCitationId(c, i + 1))
          .filter((n) => Number.isFinite(n))
      ),
    [citations]
  );

  const body = useMemo(
    () => prepareBody(content, citationIds),
    [content, citationIds]
  );

  const words = useMemo(() => countWords(body), [body]);
  const readMinutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));

  const orderedCitations = useMemo(() => {
    return [...citations]
      .map((c, i) => ({
        ...c,
        _id: extractCitationId(c, i + 1),
      }))
      .sort((a, b) => a._id - b._id);
  }, [citations]);

  /* Copy / Export ─────────────────────────────────────────────────── */

  const handleCopy = useCallback(async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* silent — clipboard can refuse without reason on some browsers */
    }
  }, [content]);

  const handleExport = useCallback(() => {
    if (!content) return;
    const filename = `autoresearcher-${slugify(query) || sessionId || "report"}-${todayStamp()}.md`;
    try {
      const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke on next tick so the download has time to start.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setExported(true);
      setTimeout(() => setExported(false), 1400);
    } catch {
      /* silent */
    }
  }, [content, query, sessionId]);

  /* Scroll tracking ───────────────────────────────────────────────── */

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const pct = max > 0 ? (el.scrollTop / max) * 100 : 0;
    setScrollPct(pct);
    const distanceFromBottom = max - el.scrollTop;
    setFollowLatest(distanceFromBottom <= 96);
  }, []);

  // Auto-follow the stream if the user hasn't scrolled away.
  useEffect(() => {
    if (!streaming || !followLatest) return;
    const el = scrollRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [body.length, streaming, followLatest]);

  const scrollToTop = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  /* ── Hidden until content exists ─────────────────────────────────── */

  if (!visible) return null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
      className={`relative overflow-hidden rounded-xl2 border border-bg-border bg-bg-panel/70 shadow-panel backdrop-blur-sm ${className}`}
      aria-label="Research report"
    >
      {/* Reading-progress bar — top edge, gradient fill */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[2px] bg-bg-border/60">
        <motion.div
          className="h-full bg-gradient-to-r from-cyan-400 via-cyan-300 to-violet-400"
          style={{ width: `${scrollPct}%` }}
          transition={{ duration: 0.15 }}
        />
      </div>

      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-bg-border/60 bg-bg-deep/30 px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex items-center gap-2 font-mono text-2xs uppercase tracking-cyber text-ink-muted">
            <span className="text-cyan-400">▸</span>
            Research Report
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-2xs tracking-terminal text-ink-faint">
            {words > 0 && (
              <span className="tabular-nums text-ink-muted">
                {words.toLocaleString()} <span className="text-ink-faint">words</span>
              </span>
            )}
            {words > 0 && (
              <span className="text-ink-faint">· ~{readMinutes} min read</span>
            )}
            {complete && sourcesProcessed != null && (
              <span className="text-state-done">· {sourcesProcessed} sources</span>
            )}
            {complete && pipelineDuration != null && (
              <span className="text-ink-muted">
                · {formatDuration(pipelineDuration)}
              </span>
            )}
            {streaming && (
              <span className="flex items-center gap-1 text-cyan-300">
                <span className="h-1 w-1 animate-pulse rounded-full bg-cyan-400 shadow-glow-cyan-sm" />
                streaming
              </span>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            disabled={!hasContent}
            className="btn-ghost"
            aria-label="Copy report markdown"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={!hasContent}
            className="btn-ghost"
            aria-label="Export report as markdown"
          >
            {exported ? <CheckIcon /> : <DownloadIcon />}
            {exported ? "Saved" : "Export .md"}
          </button>
        </div>
      </header>

      {/* Body */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative max-h-[65vh] overflow-y-auto px-6 py-8 sm:px-10"
      >
        {query && (
          <div className="mb-8 border-l-2 border-cyan-400/40 bg-cyan-400/5 px-4 py-3 font-mono text-xs text-ink-muted">
            <div className="mb-1 text-2xs uppercase tracking-cyber text-cyan-300">
              Directive
            </div>
            <div className="text-ink">{query}</div>
          </div>
        )}

        <article className="report-prose">
          {body ? (
            <ReactMarkdown components={MD_COMPONENTS}>{body}</ReactMarkdown>
          ) : streaming ? (
            <p className="font-mono text-xs uppercase tracking-terminal text-ink-faint">
              Awaiting first token…
            </p>
          ) : (
            <p className="rounded-lg border border-state-cancelled/30 bg-state-cancelled/5 px-4 py-3 font-mono text-xs text-state-cancelled/90">
              The synthesis agent returned no content. This usually means the
              retrieved context was empty — check the agent feed for details.
            </p>
          )}
          {streaming && body && (
            <span className="stream-caret" aria-hidden="true" />
          )}
        </article>

        {/* References panel — appears once citations exist */}
        {orderedCitations.length > 0 && (
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="mt-12 border-t border-bg-border/70 pt-8"
          >
            <h2 className="mb-4 flex items-center gap-2 font-mono text-xs uppercase tracking-cyber text-cyan-300">
              <span className="text-cyan-400">§</span>
              References
            </h2>
            <ol className="space-y-2">
              {orderedCitations.map((c) => (
                <li
                  key={c._id}
                  id={`ref-${c._id}`}
                  className="flex items-start gap-3 rounded-lg border border-bg-border/60 bg-bg-deep/50 px-3 py-2 text-sm"
                >
                  <span className="mt-0.5 flex-shrink-0 font-mono text-2xs uppercase tracking-terminal text-cyan-300">
                    [{c._id}]
                  </span>
                  <div className="min-w-0 flex-1">
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block truncate font-medium text-ink-bright transition-colors hover:text-cyan-200"
                      title={c.title || c.url}
                    >
                      {c.title || c.url}
                    </a>
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block truncate font-mono text-2xs text-ink-muted transition-colors hover:text-cyan-300"
                    >
                      {c.url}
                    </a>
                  </div>
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-0.5 flex-shrink-0 text-ink-faint transition-colors hover:text-cyan-300"
                    aria-label={`Open ${c.title || c.url} in a new tab`}
                  >
                    <ExternalIcon className="h-3.5 w-3.5" />
                  </a>
                </li>
              ))}
            </ol>
          </motion.section>
        )}

        {/* Scroll-to-top FAB — sticky inside the scroll container */}
        <AnimatePresence>
          {scrollPct > 12 && (
            <motion.button
              type="button"
              onClick={scrollToTop}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18 }}
              aria-label="Scroll to top"
              className="sticky bottom-4 ml-auto mr-0 flex h-9 w-9 translate-y-0 items-center justify-center rounded-full border border-cyan-400/40 bg-bg-panel/90 text-cyan-300 shadow-glow-cyan-sm backdrop-blur transition-colors hover:bg-bg-hover"
            >
              <ArrowUpIcon />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Completion hairline */}
      {complete && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-state-done/60 to-transparent" />
      )}
    </motion.section>
  );
}
