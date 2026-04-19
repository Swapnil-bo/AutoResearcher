import { useEffect, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";

/**
 * StatusBar — global pipeline indicator.
 *
 * Driven entirely by props from useResearch. Accepts the canonical
 * ResearchState.status values ("idle" | "searching" | "extracting" |
 * "synthesizing" | "formatting" | "complete" | "error" | "cancelled")
 * and renders:
 *   · a pulsing state light + current step label
 *   · an optional inline message (latest agent event)
 *   · a 4-segment progress meter matching the LangGraph nodes
 *   · live elapsed timer while active, final duration once complete
 *   · sources-processed counter once extraction has emitted anything
 */

const PIPELINE_STEPS = [
  { id: "searching", label: "Search", code: "01" },
  { id: "extracting", label: "Extract", code: "02" },
  { id: "synthesizing", label: "Synthesize", code: "03" },
  { id: "formatting", label: "Format", code: "04" },
];

const STATUS_META = {
  idle: {
    label: "Ready",
    sub: "Awaiting directive",
    dot: "bg-ink-dim",
    ring: "ring-ink-faint/30",
    tone: "text-ink-muted",
    pulse: false,
  },
  searching: {
    label: "Searching",
    sub: "Decomposing query · running search",
    dot: "bg-cyan-400",
    ring: "ring-cyan-400/40",
    tone: "text-cyan-300",
    pulse: true,
  },
  extracting: {
    label: "Extracting",
    sub: "Scraping · chunking · embedding",
    dot: "bg-cyan-400",
    ring: "ring-cyan-400/40",
    tone: "text-cyan-300",
    pulse: true,
  },
  synthesizing: {
    label: "Synthesizing",
    sub: "RAG retrieval · streaming report",
    dot: "bg-violet-400",
    ring: "ring-violet-400/40",
    tone: "text-violet-200",
    pulse: true,
  },
  formatting: {
    label: "Formatting",
    sub: "Repairing citations · finalizing",
    dot: "bg-cyan-400",
    ring: "ring-cyan-400/40",
    tone: "text-cyan-300",
    pulse: true,
  },
  complete: {
    label: "Complete",
    sub: "Report ready",
    dot: "bg-state-done",
    ring: "ring-state-done/40",
    tone: "text-state-done",
    pulse: false,
  },
  error: {
    label: "Error",
    sub: "Pipeline failed",
    dot: "bg-state-error",
    ring: "ring-state-error/40",
    tone: "text-state-error",
    pulse: false,
  },
  cancelled: {
    label: "Cancelled",
    sub: "Pipeline aborted by user",
    dot: "bg-state-cancelled",
    ring: "ring-state-cancelled/40",
    tone: "text-state-cancelled",
    pulse: false,
  },
};

const TERMINAL_STATES = new Set(["idle", "complete", "error", "cancelled"]);

function stepIndex(status) {
  switch (status) {
    case "searching":
      return 0;
    case "extracting":
      return 1;
    case "synthesizing":
      return 2;
    case "formatting":
      return 3;
    case "complete":
      return 4;
    default:
      return -1;
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Ticks once a second while the pipeline is active; stops at terminal states. */
function useElapsedSeconds(startTime, active) {
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    if (!active || !startTime) return undefined;
    setNow(Date.now() / 1000);
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [active, startTime]);

  if (!startTime) return null;
  return Math.max(0, now - startTime);
}

function StateLight({ meta }) {
  return (
    <span className="relative inline-flex h-2.5 w-2.5 items-center justify-center">
      {meta.pulse && (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${meta.dot}`}
        />
      )}
      <span
        className={`relative inline-flex h-2.5 w-2.5 rounded-full ring-2 ${meta.dot} ${meta.ring}`}
      />
    </span>
  );
}

function ProgressSegment({ step, state }) {
  const base =
    "relative flex-1 overflow-hidden rounded-sm border font-mono text-2xs uppercase tracking-terminal";
  const tone = {
    pending: "border-bg-border/70 bg-bg-deep/40 text-ink-faint",
    active: "border-cyan-400/50 bg-cyan-400/10 text-cyan-200",
    done: "border-state-done/50 bg-state-done/10 text-state-done",
    skipped: "border-state-error/30 bg-state-error/5 text-state-error/80",
  }[state];

  return (
    <div className={`${base} ${tone}`}>
      {state === "active" && (
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(90deg, transparent 0%, rgba(0, 212, 255, 0.35) 50%, transparent 100%)",
            backgroundSize: "200% 100%",
          }}
          animate={{ backgroundPositionX: ["-200%", "200%"] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "linear" }}
        />
      )}
      <div className="relative flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="text-ink-dim">{step.code}</span>
        <span className="truncate">{step.label}</span>
        <span className="flex h-1.5 w-1.5 items-center justify-center">
          {state === "done" && (
            <span className="h-1.5 w-1.5 rounded-full bg-state-done shadow-glow-success" />
          )}
          {state === "active" && (
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shadow-glow-cyan-sm" />
          )}
          {state === "skipped" && (
            <span className="h-1.5 w-1.5 rounded-full bg-state-error/70" />
          )}
        </span>
      </div>
    </div>
  );
}

export default function StatusBar({
  status = "idle",
  sessionStartTime = null,
  pipelineDuration = null,
  sourcesProcessed = 0,
  scrapingErrorsCount = 0,
  error = null,
  message = null,
}) {
  const meta = STATUS_META[status] ?? STATUS_META.idle;
  const active = !TERMINAL_STATES.has(status);
  const currentStep = stepIndex(status);
  const elapsed = useElapsedSeconds(sessionStartTime, active);

  const displaySub = useMemo(() => {
    if (status === "error" && error) return error;
    if (message) return message;
    return meta.sub;
  }, [status, error, message, meta.sub]);

  const displayDuration = useMemo(() => {
    if (pipelineDuration != null && !active) return formatDuration(pipelineDuration);
    if (elapsed != null) return formatDuration(elapsed);
    return null;
  }, [pipelineDuration, active, elapsed]);

  const segmentState = (i) => {
    if (status === "error" || status === "cancelled") {
      if (currentStep === -1) return i === 0 ? "skipped" : "pending";
      return i < currentStep ? "done" : i === currentStep ? "skipped" : "pending";
    }
    if (status === "complete") return "done";
    if (i < currentStep) return "done";
    if (i === currentStep) return "active";
    return "pending";
  };

  const hairline =
    status === "error"
      ? "bg-gradient-to-r from-transparent via-state-error/70 to-transparent"
      : status === "complete"
        ? "bg-gradient-to-r from-transparent via-state-done/70 to-transparent"
        : status === "cancelled"
          ? "bg-gradient-to-r from-transparent via-state-cancelled/70 to-transparent"
          : "bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent";

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="relative overflow-hidden rounded-xl border border-bg-border bg-bg-panel/70 shadow-panel backdrop-blur-sm"
    >
      <div className={`pointer-events-none absolute inset-x-0 top-0 h-px ${hairline}`} />

      <div className="flex flex-col gap-4 px-5 py-4 md:flex-row md:items-center md:gap-6">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <StateLight meta={meta} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className={`font-mono text-xs uppercase tracking-cyber ${meta.tone}`}>
                {meta.label}
              </span>
              {currentStep >= 0 && currentStep < PIPELINE_STEPS.length && (
                <span className="font-mono text-2xs uppercase tracking-terminal text-ink-faint">
                  · step {currentStep + 1}/4
                </span>
              )}
            </div>
            <AnimatePresence mode="wait">
              <motion.div
                key={displaySub}
                initial={{ opacity: 0, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -2 }}
                transition={{ duration: 0.2 }}
                className={`truncate font-mono text-xs ${
                  status === "error" ? "text-state-error/90" : "text-ink-muted"
                }`}
              >
                {displaySub}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        <div className="flex items-center gap-4 font-mono text-2xs uppercase tracking-terminal text-ink-dim">
          {sourcesProcessed > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="h-1 w-1 rounded-full bg-cyan-400/70" />
              <span className="text-ink-muted">{sourcesProcessed}</span>
              <span>src</span>
              {scrapingErrorsCount > 0 && (
                <span className="text-state-error/80">
                  · {scrapingErrorsCount} failed
                </span>
              )}
            </span>
          )}
          {displayDuration && (
            <span
              className={`tabular-nums ${active ? "text-cyan-300" : "text-ink-muted"}`}
              title="Elapsed"
            >
              {displayDuration}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-stretch gap-1.5 border-t border-bg-border/60 bg-bg-deep/30 px-5 py-3">
        {PIPELINE_STEPS.map((step, i) => (
          <ProgressSegment key={step.id} step={step} state={segmentState(i)} />
        ))}
      </div>
    </div>
  );
}
