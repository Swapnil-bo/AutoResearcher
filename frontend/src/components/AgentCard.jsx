import { memo, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";

/**
 * AgentCard — per-agent status tile.
 *
 * One of three rendered side-by-side in App: Search, Extract, Synthesize.
 * Driven from useResearch.agentStatuses[id]:
 *   · status:   "idle" | "running" | "done" | "error" | "cancelled"
 *   · message:  latest log line from this agent (optional)
 *   · metrics:  freeform { primary, secondary } strings for quick telemetry
 *
 * Visual contract matches the spec:
 *   idle     → gray border, no glow
 *   running  → cyan border, pulse-glow animation
 *   done     → green border, static
 *   error    → red border, static
 *   cancelled→ amber border, static
 */

const AGENT_ICONS = {
  search: ({ className = "h-4 w-4" }) => (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M20 20l-3.8-3.8"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  ),
  extract: ({ className = "h-4 w-4" }) => (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M6 3h9l4 4v14H6z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path d="M15 3v4h4" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
      <path
        d="M9 11h6M9 14h6M9 17h4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  synthesize: ({ className = "h-4 w-4" }) => (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <circle cx="5" cy="6" r="2" stroke="currentColor" strokeWidth="1.75" />
      <circle cx="5" cy="18" r="2" stroke="currentColor" strokeWidth="1.75" />
      <circle cx="19" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M7 7l10 4M7 17l10-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
};

const STATUS_META = {
  idle: {
    label: "Idle",
    borderClass: "agent-border-idle",
    accentFrom: "from-ink-faint/0",
    accentTo: "to-ink-faint/20",
    textTone: "text-ink-muted",
    pillTone: "border-bg-border text-ink-dim bg-bg-deep/40",
  },
  running: {
    label: "Running",
    borderClass: "agent-border-running",
    accentFrom: "from-cyan-400",
    accentTo: "to-violet-400",
    textTone: "text-cyan-300",
    pillTone: "border-cyan-400/40 text-cyan-300 bg-cyan-400/10",
  },
  done: {
    label: "Done",
    borderClass: "agent-border-done",
    accentFrom: "from-state-done",
    accentTo: "to-emerald-300",
    textTone: "text-state-done",
    pillTone: "border-state-done/40 text-state-done bg-state-done/10",
  },
  error: {
    label: "Error",
    borderClass: "agent-border-error",
    accentFrom: "from-state-error",
    accentTo: "to-rose-300",
    textTone: "text-state-error",
    pillTone: "border-state-error/40 text-state-error bg-state-error/10",
  },
  cancelled: {
    label: "Cancelled",
    borderClass: "agent-border-cancelled",
    accentFrom: "from-state-cancelled",
    accentTo: "to-amber-300",
    textTone: "text-state-cancelled",
    pillTone: "border-state-cancelled/40 text-state-cancelled bg-state-cancelled/10",
  },
};

function RunningDots() {
  return (
    <div className="flex items-center gap-1" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-cyan-400"
          animate={{ opacity: [0.25, 1, 0.25], scale: [0.85, 1.1, 0.85] }}
          transition={{
            duration: 1.2,
            repeat: Infinity,
            ease: "easeInOut",
            delay: i * 0.16,
          }}
          style={{ boxShadow: "0 0 6px rgba(0, 212, 255, 0.6)" }}
        />
      ))}
    </div>
  );
}

function StatusPill({ status, meta }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={status}
        initial={{ opacity: 0, y: -3 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 3 }}
        transition={{ duration: 0.2 }}
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-2xs uppercase tracking-terminal ${meta.pillTone}`}
      >
        {status === "running" ? (
          <RunningDots />
        ) : status === "done" ? (
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" aria-hidden="true">
            <path
              d="M4 12l5 5L20 6"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : status === "error" ? (
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" aria-hidden="true">
            <path
              d="M12 7v6m0 3.5h.01"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
          </svg>
        ) : status === "cancelled" ? (
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" aria-hidden="true">
            <path
              d="M5 12h14"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
        )}
        {meta.label}
      </motion.div>
    </AnimatePresence>
  );
}

function AgentCardInner({
  id = "search",
  label = "Search",
  role = "",
  model = "",
  index = 0,
  status = "idle",
  message = null,
  metrics = null,
}) {
  const meta = STATUS_META[status] ?? STATUS_META.idle;
  const Icon = AGENT_ICONS[id] ?? AGENT_ICONS.search;

  const numericIndex = useMemo(
    () => String(index + 1).padStart(2, "0"),
    [index]
  );

  return (
    <motion.article
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1], delay: 0.05 * index }}
      className={`group relative flex h-full flex-col overflow-hidden rounded-xl2 border bg-bg-panel/70 shadow-panel backdrop-blur-sm transition-colors duration-300 ${meta.borderClass}`}
      aria-label={`${label} agent — ${meta.label}`}
    >
      {/* Left accent bar — colour + intensity track status */}
      <div
        className={`pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b ${meta.accentFrom} ${meta.accentTo} ${
          status === "running" ? "opacity-100" : "opacity-60"
        }`}
      />

      {/* Header */}
      <header className="flex items-center justify-between gap-2 border-b border-bg-border/60 px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="font-mono text-2xs tracking-cyber text-ink-faint">
            {numericIndex}
          </span>
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-md border border-bg-border/70 bg-bg-deep/60 ${meta.textTone}`}
          >
            <Icon className="h-4 w-4" />
          </span>
          <span className="truncate font-mono text-xs uppercase tracking-cyber text-ink-bright">
            {label}
          </span>
        </div>
        <StatusPill status={status} meta={meta} />
      </header>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-3 px-5 py-4">
        {role && <p className="text-sm text-ink">{role}</p>}

        {model && (
          <div className="flex items-center gap-2">
            <span className="code-chip">{model}</span>
            {metrics?.primary && (
              <span className="font-mono text-2xs uppercase tracking-terminal text-ink-muted">
                · {metrics.primary}
              </span>
            )}
            {metrics?.secondary && (
              <span className="font-mono text-2xs uppercase tracking-terminal text-ink-faint">
                · {metrics.secondary}
              </span>
            )}
          </div>
        )}

        {/* Latest log line — cross-fades when a new one arrives */}
        <div className="mt-auto min-h-[2.5rem] rounded-lg border border-bg-border/60 bg-bg-deep/50 px-3 py-2">
          <AnimatePresence mode="wait" initial={false}>
            {message ? (
              <motion.div
                key={message}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.22 }}
                className="flex items-start gap-2 font-mono text-xs text-ink-muted"
              >
                <span
                  className={`mt-0.5 flex-shrink-0 ${
                    status === "error" ? "text-state-error" : "text-cyan-400"
                  }`}
                >
                  ▸
                </span>
                <span className="line-clamp-3 break-words">{message}</span>
              </motion.div>
            ) : (
              <motion.div
                key="placeholder"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="font-mono text-xs text-ink-faint"
              >
                {status === "idle"
                  ? "Waiting for directive…"
                  : status === "running"
                    ? "Working…"
                    : status === "done"
                      ? "Task complete."
                      : status === "cancelled"
                        ? "Cancelled."
                        : "No output."}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Running-state scanline wash — only painted while running */}
      {status === "running" && (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(180deg, transparent 0%, rgba(0, 212, 255, 0.08) 50%, transparent 100%)",
            backgroundSize: "100% 220%",
          }}
          animate={{ backgroundPositionY: ["-110%", "110%"] }}
          transition={{ duration: 3.2, repeat: Infinity, ease: "linear" }}
        />
      )}
    </motion.article>
  );
}

export default memo(AgentCardInner);
