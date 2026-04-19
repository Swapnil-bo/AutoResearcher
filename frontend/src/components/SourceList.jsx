import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

/**
 * SourceList — the sources panel.
 *
 * Accepts a single unified `sources` array, where each entry has:
 *   {
 *     url:      string
 *     title?:   string                      — optional until the page fetches
 *     summary?: string                      — present when status === "success"
 *     reason?:  string                      — present when status === "failed"
 *     status:   "fetching" | "success" | "failed"
 *     timestamp?: number                    — optional unix seconds
 *   }
 *
 * The parent (useResearch) assembles this list from SSE events:
 *   · source_progress { url, status:"fetching"|"done"|"failed", reason }
 *   · source_summary  { url, title, summary }   → marks that entry success
 *   · scraping_errors come in as { url, reason } during extraction        → failed
 */

const STATUS_META = {
  fetching: {
    label: "Fetching",
    pill: "border-cyan-400/40 bg-cyan-400/10 text-cyan-300",
    stripe: "from-cyan-400 to-violet-400",
    border: "border-bg-border",
    glow: "",
  },
  success: {
    label: "Done",
    pill: "border-state-done/40 bg-state-done/10 text-state-done",
    stripe: "from-state-done to-emerald-300",
    border: "border-state-done/30",
    glow: "",
  },
  failed: {
    label: "Failed",
    pill: "border-state-error/40 bg-state-error/10 text-state-error",
    stripe: "from-state-error to-rose-400",
    border: "border-state-error/30",
    glow: "",
  },
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "success", label: "Success" },
  { id: "failed", label: "Failed" },
  { id: "fetching", label: "Fetching" },
];

function parseDomain(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    // URL was malformed — fall back to a best-effort substring.
    return String(url).replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
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

function CopyIcon({ className = "h-3 w-3" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <rect
        x="8"
        y="8"
        width="12"
        height="12"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"
        stroke="currentColor"
        strokeWidth="1.75"
      />
    </svg>
  );
}

function SpinnerIcon({ className = "h-3.5 w-3.5" }) {
  return (
    <svg viewBox="0 0 24 24" className={`animate-spin ${className}`} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon({ className = "h-3 w-3" }) {
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

function CrossIcon({ className = "h-3 w-3" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
    </svg>
  );
}

function StatusPill({ status }) {
  const meta = STATUS_META[status] ?? STATUS_META.fetching;
  return (
    <span
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-2xs uppercase tracking-terminal ${meta.pill}`}
    >
      {status === "fetching" ? (
        <SpinnerIcon className="h-3 w-3" />
      ) : status === "success" ? (
        <CheckIcon />
      ) : (
        <CrossIcon />
      )}
      {meta.label}
    </span>
  );
}

function SkeletonLine({ w = "100%", delay = 0 }) {
  return (
    <div
      className="h-3 rounded bg-gradient-to-r from-bg-border/40 via-bg-border/80 to-bg-border/40"
      style={{
        width: w,
        backgroundSize: "200% 100%",
        animation: `shimmer 1.6s ease-in-out ${delay}s infinite`,
      }}
    />
  );
}

function SourceCard({ source, index, onCopy }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const status = source.status ?? "fetching";
  const meta = STATUS_META[status] ?? STATUS_META.fetching;
  const domain = parseDomain(source.url);

  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(source.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
      onCopy?.(source.url);
    } catch {
      /* silent */
    }
  };

  const summary = source.summary ?? "";
  const needsClamp = summary.length > 260;

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1], delay: Math.min(index * 0.03, 0.2) }}
      className={`group relative flex h-full flex-col overflow-hidden rounded-xl border bg-bg-panel/70 shadow-panel backdrop-blur-sm transition-colors duration-300 hover:border-cyan-400/30 ${meta.border}`}
    >
      {/* Top stripe — color tracks status. */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r ${meta.stripe}`}
      />

      {/* Fetching shimmer wash */}
      {status === "fetching" && (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(90deg, transparent 0%, rgba(0, 212, 255, 0.07) 50%, transparent 100%)",
            backgroundSize: "200% 100%",
          }}
          animate={{ backgroundPositionX: ["-200%", "200%"] }}
          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
        />
      )}

      {/* Header */}
      <header className="relative flex items-center justify-between gap-2 px-4 pt-4">
        <span
          className="code-chip max-w-[60%] truncate"
          title={domain}
        >
          {domain || "unknown"}
        </span>
        <StatusPill status={status} />
      </header>

      {/* Title / URL */}
      <div className="relative px-4 pt-3">
        {status === "fetching" && !source.title ? (
          <div className="space-y-2 py-1">
            <SkeletonLine w="92%" />
            <SkeletonLine w="70%" delay={0.15} />
          </div>
        ) : (
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer noopener"
            className="block text-sm font-semibold leading-snug text-ink-bright transition-colors hover:text-cyan-200"
            title={source.url}
          >
            <span className="line-clamp-2">
              {source.title || source.url}
            </span>
          </a>
        )}
      </div>

      {/* Body */}
      <div className="relative flex flex-1 flex-col px-4 pt-3 pb-3">
        {status === "fetching" ? (
          <div className="space-y-2 pt-1">
            <SkeletonLine w="100%" />
            <SkeletonLine w="95%" delay={0.1} />
            <SkeletonLine w="80%" delay={0.2} />
          </div>
        ) : status === "failed" ? (
          <div className="flex items-start gap-2 rounded-lg border border-state-error/20 bg-state-error/5 px-3 py-2 font-mono text-xs text-state-error/90">
            <CrossIcon className="mt-0.5 h-3 w-3 flex-shrink-0" />
            <span className="break-words">
              {source.reason || "Extraction failed"}
            </span>
          </div>
        ) : (
          <div className="relative">
            <p
              className={`text-sm leading-relaxed text-ink-muted ${
                expanded ? "" : "line-clamp-4"
              }`}
            >
              {summary || <span className="italic text-ink-faint">No summary generated.</span>}
            </p>
            {needsClamp && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-2 font-mono text-2xs uppercase tracking-terminal text-cyan-400/80 transition-colors hover:text-cyan-300"
              >
                {expanded ? "— Collapse" : "+ Expand"}
              </button>
            )}
          </div>
        )}

        {/* Footer actions */}
        <div className="mt-4 flex items-center justify-between gap-2 border-t border-bg-border/60 pt-3">
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center gap-1.5 font-mono text-2xs uppercase tracking-terminal text-ink-muted transition-colors hover:text-cyan-300"
          >
            <ExternalIcon />
            Open
          </a>
          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copy URL"
            className={`flex items-center gap-1.5 font-mono text-2xs uppercase tracking-terminal transition-colors ${
              copied
                ? "text-state-done"
                : "text-ink-muted hover:text-cyan-300"
            }`}
            title={copied ? "Copied" : "Copy URL"}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy URL"}
          </button>
        </div>
      </div>
    </motion.article>
  );
}

function FilterPill({ id, label, count, active, onClick }) {
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-2xs uppercase tracking-terminal transition-colors ${
        active
          ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-300"
          : "border-bg-border bg-bg-deep/40 text-ink-muted hover:text-ink-bright"
      }`}
    >
      {label}
      {count > 0 && (
        <span
          className={`tabular-nums ${active ? "text-cyan-300" : "text-ink-faint"}`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export default function SourceList({ sources = [], active = false, className = "" }) {
  const [filter, setFilter] = useState("all");

  const counts = useMemo(() => {
    const c = { success: 0, failed: 0, fetching: 0 };
    for (const s of sources) {
      const key = c.hasOwnProperty(s.status) ? s.status : "fetching";
      c[key] += 1;
    }
    return c;
  }, [sources]);

  const totalAll = sources.length;

  const visible = useMemo(() => {
    if (filter === "all") return sources;
    return sources.filter((s) => (s.status ?? "fetching") === filter);
  }, [sources, filter]);

  // Keep failures at the end so the eye lands on successful sources first,
  // but preserve insertion order within each bucket.
  const ordered = useMemo(() => {
    const bucket = { success: [], fetching: [], failed: [] };
    for (const s of visible) {
      const key = bucket.hasOwnProperty(s.status) ? s.status : "fetching";
      bucket[key].push(s);
    }
    return [...bucket.success, ...bucket.fetching, ...bucket.failed];
  }, [visible]);

  const showEmptyState = totalAll === 0;

  return (
    <section
      className={`rounded-xl2 border border-bg-border bg-bg-panel/60 shadow-panel backdrop-blur-sm ${className}`}
      aria-label="Sources"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-bg-border/70 px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 font-mono text-2xs uppercase tracking-cyber text-ink-muted">
            <span className="text-cyan-400">▸</span>
            Sources
          </span>
          <span className="font-mono text-2xs tracking-terminal text-ink-faint">
            {totalAll} total
            {counts.success > 0 && (
              <span className="ml-2 text-state-done">· {counts.success} ok</span>
            )}
            {counts.failed > 0 && (
              <span className="ml-2 text-state-error/80">
                · {counts.failed} failed
              </span>
            )}
            {counts.fetching > 0 && (
              <span className="ml-2 text-cyan-300">
                · {counts.fetching} fetching
              </span>
            )}
          </span>
        </div>

        {totalAll > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {FILTERS.map((f) => (
              <FilterPill
                key={f.id}
                id={f.id}
                label={f.label}
                count={f.id === "all" ? totalAll : counts[f.id] ?? 0}
                active={filter === f.id}
                onClick={setFilter}
              />
            ))}
          </div>
        )}
      </header>

      <div className="p-5">
        {showEmptyState ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <div className="font-mono text-2xs uppercase tracking-cyber text-ink-faint">
              {active ? "Awaiting extraction…" : "No sources yet"}
            </div>
            <div className="max-w-sm font-mono text-xs text-ink-dim">
              {active
                ? "Sources will appear here as the extraction agent processes them."
                : "Run a research query to populate this panel."}
            </div>
          </div>
        ) : ordered.length === 0 ? (
          <div className="flex items-center justify-center py-10 font-mono text-xs text-ink-dim">
            No sources match the current filter.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <AnimatePresence initial={false}>
              {ordered.map((s, i) => (
                <SourceCard
                  key={s.url ?? `src-${i}`}
                  source={s}
                  index={i}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </section>
  );
}
