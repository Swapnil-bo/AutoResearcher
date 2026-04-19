import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

/**
 * AgentFeed — live terminal-style log panel.
 *
 * Props:
 *   · events     — Array<{ id, timestamp, agent, level, message }>
 *                  agent:  'search' | 'extract' | 'synthesize' | 'format' | 'system'
 *                  level:  'info'   | 'success' | 'warn' | 'error'
 *                  timestamp: unix seconds (float) or ms — auto-detected
 *   · active     — bool, true while the pipeline is running (drives header dot)
 *   · onClear    — optional handler for the clear button (hidden if absent)
 *   · className  — optional outer override
 *
 * Behaviour:
 *   · Auto-scrolls to latest when the user is near the bottom.
 *   · If the user scrolls up, autoscroll pauses and a "Jump to latest" pill appears.
 *   · Agent filter chips toggle visibility per agent.
 *   · Copy button serialises the *visible* log to the clipboard.
 */

const AGENT_META = {
  search: {
    label: "SRCH",
    full: "Search",
    text: "text-cyan-300",
    dot: "bg-cyan-400",
    border: "border-cyan-400/40",
    fill: "bg-cyan-400/10",
  },
  extract: {
    label: "EXTR",
    full: "Extract",
    text: "text-violet-300",
    dot: "bg-violet-400",
    border: "border-violet-400/40",
    fill: "bg-violet-400/10",
  },
  synthesize: {
    label: "SYNTH",
    full: "Synthesize",
    text: "text-cyan-200",
    dot: "bg-cyan-200",
    border: "border-cyan-200/40",
    fill: "bg-cyan-200/10",
  },
  format: {
    label: "FMT",
    full: "Format",
    text: "text-cyan-300",
    dot: "bg-cyan-300",
    border: "border-cyan-300/40",
    fill: "bg-cyan-300/10",
  },
  system: {
    label: "SYS",
    full: "System",
    text: "text-ink-muted",
    dot: "bg-ink-muted",
    border: "border-bg-border",
    fill: "bg-bg-deep/60",
  },
};

const LEVEL_META = {
  info: { prefix: "▸", tone: "text-ink-muted", accent: "" },
  success: {
    prefix: "✓",
    tone: "text-ink",
    accent: "border-l-state-done/50",
  },
  warn: {
    prefix: "!",
    tone: "text-state-cancelled/90",
    accent: "border-l-state-cancelled/60",
  },
  error: {
    prefix: "✗",
    tone: "text-state-error",
    accent: "border-l-state-error/60",
  },
};

const SCROLL_FOLLOW_THRESHOLD = 48;

function formatClock(ts) {
  if (!Number.isFinite(ts)) return "--:--:--";
  // Accept either unix seconds (backend-native) or ms.
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  return [
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join(":");
}

function serialiseEvents(events) {
  return events
    .map((e) => {
      const meta = AGENT_META[e.agent] ?? AGENT_META.system;
      return `[${formatClock(e.timestamp)}] [${meta.label}] ${e.message ?? ""}`;
    })
    .join("\n");
}

function CopyIcon({ className = "h-3.5 w-3.5" }) {
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

function TrashIcon({ className = "h-3.5 w-3.5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ArrowDownIcon({ className = "h-3.5 w-3.5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M12 5v14M6 13l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FilterChip({ agentId, enabled, count, onToggle }) {
  const meta = AGENT_META[agentId] ?? AGENT_META.system;
  return (
    <button
      type="button"
      onClick={() => onToggle(agentId)}
      aria-pressed={enabled}
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-2xs uppercase tracking-terminal transition-colors ${
        enabled
          ? `${meta.border} ${meta.fill} ${meta.text}`
          : "border-bg-border bg-bg-deep/40 text-ink-faint hover:text-ink-muted"
      }`}
    >
      <span className={`h-1 w-1 rounded-full ${enabled ? meta.dot : "bg-ink-faint/60"}`} />
      {meta.label}
      {count > 0 && (
        <span className={`tabular-nums ${enabled ? "opacity-90" : "opacity-60"}`}>
          {count}
        </span>
      )}
    </button>
  );
}

function FeedRow({ event, lineNumber }) {
  const agentMeta = AGENT_META[event.agent] ?? AGENT_META.system;
  const levelMeta = LEVEL_META[event.level] ?? LEVEL_META.info;

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 6 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={`group flex items-start gap-3 border-l-2 border-transparent py-1 pl-3 pr-2 font-mono text-xs leading-relaxed hover:bg-bg-hover/40 ${levelMeta.accent}`}
    >
      <span className="w-8 flex-shrink-0 select-none text-ink-faint/70 tabular-nums">
        {String(lineNumber).padStart(3, "0")}
      </span>
      <span className="w-[4.5rem] flex-shrink-0 text-ink-dim tabular-nums">
        {formatClock(event.timestamp)}
      </span>
      <span
        className={`w-[3.25rem] flex-shrink-0 font-semibold ${agentMeta.text}`}
        title={agentMeta.full}
      >
        {agentMeta.label}
      </span>
      <span className={`flex-shrink-0 ${levelMeta.tone}`}>{levelMeta.prefix}</span>
      <span className={`min-w-0 flex-1 break-words ${levelMeta.tone}`}>
        {event.message}
      </span>
    </motion.li>
  );
}

export default function AgentFeed({
  events = [],
  active = false,
  onClear,
  className = "",
}) {
  const scrollRef = useRef(null);
  const [followLatest, setFollowLatest] = useState(true);
  const [copied, setCopied] = useState(false);

  const [filters, setFilters] = useState(() => ({
    search: true,
    extract: true,
    synthesize: true,
    format: true,
    system: true,
  }));

  const perAgentCounts = useMemo(() => {
    const c = { search: 0, extract: 0, synthesize: 0, format: 0, system: 0 };
    for (const e of events) {
      const key = c.hasOwnProperty(e.agent) ? e.agent : "system";
      c[key] += 1;
    }
    return c;
  }, [events]);

  const visibleEvents = useMemo(
    () => events.filter((e) => filters[e.agent] ?? filters.system),
    [events, filters]
  );

  const toggleFilter = (id) =>
    setFilters((f) => ({ ...f, [id]: !f[id] }));

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
    setFollowLatest(distance <= SCROLL_FOLLOW_THRESHOLD);
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
    setFollowLatest(true);
  }, []);

  // Keep the feed pinned to the latest entry when the user hasn't scrolled away.
  useEffect(() => {
    if (!followLatest) return;
    const el = scrollRef.current;
    if (!el) return;
    // rAF lets the new row mount first so scrollHeight reflects it.
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [visibleEvents.length, followLatest]);

  const handleCopy = useCallback(async () => {
    const text = serialiseEvents(visibleEvents);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard permission denied — silent fail is fine here.
    }
  }, [visibleEvents]);

  const hiddenCount = events.length - visibleEvents.length;

  return (
    <section
      className={`flex h-[28rem] flex-col overflow-hidden rounded-xl2 border border-bg-border bg-bg-panel/70 shadow-panel backdrop-blur-sm ${className}`}
      aria-label="Agent activity feed"
    >
      {/* Header */}
      <header className="flex items-center justify-between gap-3 border-b border-bg-border/60 bg-bg-deep/30 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            {active && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60" />
            )}
            <span
              className={`relative inline-flex h-2 w-2 rounded-full ${
                active ? "bg-cyan-400 shadow-glow-cyan-sm" : "bg-ink-faint"
              }`}
            />
          </span>
          <span className="font-mono text-2xs uppercase tracking-cyber text-ink-muted">
            Agent Feed
          </span>
          <span className="font-mono text-2xs tracking-terminal text-ink-faint">
            · {events.length} events
            {hiddenCount > 0 && (
              <span className="ml-1 text-ink-dim">({hiddenCount} hidden)</span>
            )}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleCopy}
            disabled={visibleEvents.length === 0}
            aria-label="Copy log to clipboard"
            className="flex h-6 w-6 items-center justify-center rounded-md border border-bg-border bg-bg-deep/60 text-ink-muted transition-colors hover:border-cyan-400/40 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
            title={copied ? "Copied" : "Copy log"}
          >
            {copied ? (
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                <path
                  d="M4 12l5 5L20 6"
                  stroke="currentColor"
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <CopyIcon />
            )}
          </button>
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              disabled={events.length === 0}
              aria-label="Clear feed"
              className="flex h-6 w-6 items-center justify-center rounded-md border border-bg-border bg-bg-deep/60 text-ink-muted transition-colors hover:border-state-error/50 hover:text-state-error disabled:cursor-not-allowed disabled:opacity-40"
              title="Clear feed"
            >
              <TrashIcon />
            </button>
          )}
        </div>
      </header>

      {/* Filter row */}
      <div className="flex items-center gap-2 overflow-x-auto border-b border-bg-border/60 bg-bg-deep/20 px-4 py-2 no-scrollbar">
        {["search", "extract", "synthesize", "format", "system"].map((id) => (
          <FilterChip
            key={id}
            agentId={id}
            enabled={filters[id]}
            count={perAgentCounts[id]}
            onToggle={toggleFilter}
          />
        ))}
      </div>

      {/* Log body */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative flex-1 overflow-y-auto bg-bg-deep/40 py-2"
      >
        {visibleEvents.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="space-y-2">
              <div className="font-mono text-2xs uppercase tracking-cyber text-ink-faint">
                {events.length === 0 ? "Stream Quiet" : "No matches"}
              </div>
              <div className="font-mono text-xs text-ink-dim">
                {events.length === 0
                  ? "Awaiting agent events…"
                  : "All visible agents are filtered out."}
              </div>
            </div>
          </div>
        ) : (
          <ul className="space-y-0.5">
            <AnimatePresence initial={false}>
              {visibleEvents.map((event, i) => (
                <FeedRow key={event.id} event={event} lineNumber={i + 1} />
              ))}
            </AnimatePresence>
          </ul>
        )}

        {/* Jump-to-latest pill — appears only when the user has scrolled away */}
        <AnimatePresence>
          {!followLatest && visibleEvents.length > 0 && (
            <motion.button
              type="button"
              onClick={() => scrollToBottom(true)}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18 }}
              className="pointer-events-auto sticky bottom-3 ml-auto mr-4 flex w-fit items-center gap-1.5 rounded-full border border-cyan-400/40 bg-bg-panel/90 px-3 py-1 font-mono text-2xs uppercase tracking-terminal text-cyan-300 shadow-glow-cyan-sm backdrop-blur"
            >
              <ArrowDownIcon />
              Jump to Latest
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
