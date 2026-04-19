import { useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";

import StatusBar from "./components/StatusBar.jsx";
import ResearchInput from "./components/ResearchInput.jsx";
import AgentCard from "./components/AgentCard.jsx";
import AgentFeed from "./components/AgentFeed.jsx";
import SourceList from "./components/SourceList.jsx";
import ReportViewer from "./components/ReportViewer.jsx";

import useResearch from "./hooks/useResearch.js";

/**
 * App — the full AutoResearcher shell.
 *
 * Owns no state of its own; everything is routed through `useResearch`.
 * Layout sequence, top-to-bottom:
 *   1. Header                    — brand mark, stream connection indicator
 *   2. StatusBar                 — global pipeline phase + elapsed time
 *   3. Hero (only when idle)     — directive headline & subtitle
 *   4. ResearchInput             — directive surface, embeds cancel button
 *   5. Result banner             — error / cancelled state with Start Over
 *   6. AgentCards ×3             — Search / Extract / Synthesize
 *   7. ReportViewer              — hidden until tokens begin streaming
 *   8. Feed + Sources            — 1/3 feed, 2/3 sources at lg breakpoint
 *   9. Footer                    — stack hints + stream status
 */

const AGENTS = [
  {
    id: "search",
    label: "Search",
    role: "Decompose the question. Run diverse web queries. Rank candidate URLs.",
    model: "mistral:7b-instruct",
  },
  {
    id: "extract",
    label: "Extract",
    role: "Scrape each URL. Clean HTML. Chunk, embed, and summarize.",
    model: "qwen2.5:7b",
  },
  {
    id: "synthesize",
    label: "Synthesize",
    role: "Retrieve chunks via RAG. Stream a cited, structured report.",
    model: "qwen2.5:7b",
  },
];

const STREAM_DOT_TONE = {
  open: { dot: "bg-state-done", label: "Live", pulse: true },
  connecting: { dot: "bg-cyan-400", label: "Connecting", pulse: true },
  error: { dot: "bg-state-cancelled", label: "Retrying", pulse: true },
  closed: { dot: "bg-ink-faint", label: "Offline", pulse: false },
  idle: { dot: "bg-ink-faint", label: "Idle", pulse: false },
};

function LogoMark({ className = "" }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
      role="presentation"
    >
      <defs>
        <linearGradient id="lm-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#00d4ff" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <circle
        cx="32"
        cy="32"
        r="20"
        fill="none"
        stroke="url(#lm-grad)"
        strokeWidth="2.5"
      />
      <circle cx="32" cy="32" r="6" fill="url(#lm-grad)" />
      <circle cx="32" cy="8" r="3" fill="#00d4ff" />
      <circle cx="56" cy="44" r="3" fill="#7c3aed" />
      <circle cx="10" cy="46" r="3" fill="#00d4ff" />
    </svg>
  );
}

function StreamIndicator({ status, attemptsVisible }) {
  const meta = STREAM_DOT_TONE[status] ?? STREAM_DOT_TONE.idle;
  return (
    <div
      className="flex items-center gap-2 rounded-full border border-bg-border bg-bg-panel/60 px-3 py-1.5 font-mono text-2xs uppercase tracking-terminal text-ink-muted backdrop-blur-sm"
      title={`SSE ${status}`}
    >
      <span className="relative flex h-2 w-2">
        {meta.pulse && (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${meta.dot}`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${meta.dot}`} />
      </span>
      <span>{meta.label}</span>
      {attemptsVisible > 0 && (
        <span className="text-ink-faint">· retry {attemptsVisible}</span>
      )}
    </div>
  );
}

function Hero() {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="text-center"
    >
      <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/5 px-4 py-1.5 font-mono text-2xs uppercase tracking-cyber text-cyan-300">
        <span className="h-1 w-1 rounded-full bg-cyan-400 shadow-glow-cyan-sm" />
        Multi-Agent Deep Research · Local-First
      </div>

      <h1 className="mt-6 bg-gradient-to-br from-white via-ink to-cyan-200 bg-clip-text text-4xl font-extrabold leading-[1.05] tracking-tight text-transparent md:text-6xl">
        Ask anything.
        <br />
        <span className="text-gradient-brand">Three agents investigate.</span>
      </h1>

      <p className="mx-auto mt-5 max-w-2xl text-sm text-ink-muted md:text-base">
        Search, extraction, and synthesis agents collaborate through a
        LangGraph state machine — producing a fully-cited report without a
        single token leaving your machine.
      </p>
    </motion.section>
  );
}

function ResultBanner({ status, error, onReset }) {
  if (status !== "error" && status !== "cancelled" && status !== "complete") {
    return null;
  }

  const isError = status === "error";
  const isCancelled = status === "cancelled";

  const palette = isError
    ? {
        border: "border-state-error/40",
        bg: "bg-state-error/10",
        text: "text-state-error",
        glow: "shadow-glow-error",
        title: "Pipeline Error",
        dot: "bg-state-error",
      }
    : isCancelled
      ? {
          border: "border-state-cancelled/40",
          bg: "bg-state-cancelled/10",
          text: "text-state-cancelled",
          glow: "",
          title: "Pipeline Cancelled",
          dot: "bg-state-cancelled",
        }
      : {
          border: "border-state-done/40",
          bg: "bg-state-done/5",
          text: "text-state-done",
          glow: "shadow-glow-success",
          title: "Research Complete",
          dot: "bg-state-done",
        };

  const body = isError
    ? error || "Pipeline failed. Check the agent feed below for details."
    : isCancelled
      ? "The pipeline was aborted. Any partial output has been preserved below."
      : "Your report is ready below — copy it or export to markdown.";

  return (
    <motion.div
      key={status}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className={`relative overflow-hidden rounded-xl border ${palette.border} ${palette.bg} ${palette.glow} backdrop-blur-sm`}
      role={isError ? "alert" : "status"}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="relative mt-1 flex h-2 w-2">
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${palette.dot}`} />
            <span className={`relative inline-flex h-2 w-2 rounded-full ${palette.dot}`} />
          </span>
          <div className="min-w-0">
            <div className={`font-mono text-xs uppercase tracking-cyber ${palette.text}`}>
              {palette.title}
            </div>
            <div className="mt-0.5 break-words text-sm text-ink-muted">{body}</div>
          </div>
        </div>

        <button type="button" onClick={onReset} className="btn-ghost">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
            <path
              d="M4 12a8 8 0 1 0 3-6.2M4 4v5h5"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Start Over
        </button>
      </div>
    </motion.div>
  );
}

function Footer({ streamStatus, sessionId, sourcesProcessed, scrapingErrorsCount }) {
  return (
    <footer className="relative z-10 mt-16 border-t border-bg-border/60 bg-bg-deep/40 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4 font-mono text-2xs uppercase tracking-terminal text-ink-dim md:px-8">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>Ollama · localhost:11434</span>
          <span className="text-ink-faint">│</span>
          <span>ChromaDB · session-scoped</span>
          <span className="text-ink-faint">│</span>
          <span>
            SSE ·{" "}
            <span
              className={
                streamStatus === "open"
                  ? "text-state-done"
                  : streamStatus === "error"
                    ? "text-state-cancelled"
                    : streamStatus === "connecting"
                      ? "text-cyan-300"
                      : "text-ink-dim"
              }
            >
              {streamStatus}
            </span>
          </span>
          {sourcesProcessed > 0 && (
            <>
              <span className="text-ink-faint">│</span>
              <span className="text-ink-muted">
                {sourcesProcessed} sources
                {scrapingErrorsCount > 0 && (
                  <span className="text-state-error/80">
                    {" "}
                    · {scrapingErrorsCount} failed
                  </span>
                )}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 text-ink-muted">
          <span className="text-cyan-400">◇</span>
          <span>No cloud · no keys · no telemetry</span>
          {sessionId && (
            <span
              className="ml-3 rounded border border-bg-border bg-bg-deep/70 px-1.5 py-0.5 text-ink-faint"
              title={sessionId}
            >
              {sessionId.slice(0, 8)}
            </span>
          )}
        </div>
      </div>
    </footer>
  );
}

export default function App() {
  const r = useResearch();

  const scrapingErrorsCount = r.scrapingErrors.length;
  const showReport = r.reportContent.length > 0 || r.reportStreaming;
  const showSources = r.sources.length > 0;
  const hasStarted = !!r.sessionId || r.feedEvents.length > 0;
  const showHero = r.status === "idle" && !hasStarted;
  const showTelemetry = hasStarted;
  const showStreamDrop = r.isActive && r.streamStatus === "closed";

  const handleSubmit = useCallback((query) => r.startResearch(query), [r]);
  const handleCancel = useCallback(() => r.cancelResearch(), [r]);
  const handleReset = useCallback(() => r.reset(), [r]);

  const mainAgents = useMemo(
    () =>
      AGENTS.map((a, index) => ({
        ...a,
        index,
        status: r.agentStatuses[a.id]?.status ?? "idle",
        message: r.agentStatuses[a.id]?.message ?? null,
      })),
    [r.agentStatuses]
  );

  return (
    <div className="relative min-h-screen text-ink">
      {/* Top hairline accent */}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-0 h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />

      {/* Ambient scanline — a slow cyan wash drifting top-to-bottom. Only
          paints while a pipeline is active; honours prefers-reduced-motion via
          the media query below (the animation class no-ops under reduce). */}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-0 h-full overflow-hidden motion-reduce:hidden">
        {r.isActive && (
          <div
            aria-hidden="true"
            className="absolute inset-x-0 h-24 animate-scan-line"
            style={{
              backgroundImage:
                "linear-gradient(180deg, transparent 0%, rgba(0, 212, 255, 0.05) 50%, transparent 100%)",
              filter: "blur(1px)",
            }}
          />
        )}
      </div>

      {/* Header */}
      <motion.header
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 flex items-center justify-between px-6 py-5 md:px-8"
      >
        <div className="flex items-center gap-3">
          <LogoMark className="h-8 w-8" />
          <div className="flex flex-col leading-none">
            <span className="font-mono text-xs uppercase tracking-cyber text-ink-dim">
              v1.0 · local-first
            </span>
            <span className="mt-1 font-sans text-sm font-semibold tracking-wide text-ink-bright">
              AutoResearcher
            </span>
          </div>
        </div>
        <StreamIndicator
          status={r.streamStatus}
          attemptsVisible={r.status !== "idle" && r.streamStatus === "error" ? 1 : 0}
        />
      </motion.header>

      {/* Main */}
      <main className="relative z-10 mx-auto w-full max-w-6xl px-6 pb-16 md:px-8">
        {/* StatusBar */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1], delay: 0.05 }}
          className="mb-6"
        >
          <StatusBar
            status={r.status}
            sessionStartTime={r.sessionStartTime}
            pipelineDuration={r.pipelineDuration}
            sourcesProcessed={r.sourcesProcessed}
            scrapingErrorsCount={scrapingErrorsCount}
            error={r.error}
            message={r.lastMessage}
          />
        </motion.div>

        {/* Hero — only while the app is genuinely fresh */}
        <AnimatePresence>
          {showHero && (
            <motion.div
              key="hero"
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3 }}
              className="mb-10 mt-2"
            >
              <Hero />
            </motion.div>
          )}
        </AnimatePresence>

        {/* ResearchInput */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1], delay: 0.08 }}
          className="mx-auto max-w-3xl"
        >
          <ResearchInput
            onSubmit={handleSubmit}
            onCancel={handleCancel}
            status={r.status}
            isCancelling={r.isCancelling}
          />
        </motion.div>

        {/* Stream-dropped inline warning — only when reconnects have been
            exhausted mid-pipeline. The header StreamIndicator covers transient
            drops; this covers the terminal "we gave up" case. */}
        <AnimatePresence>
          {showStreamDrop && (
            <motion.div
              key="stream-drop"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.3 }}
              role="alert"
              className="mx-auto mt-5 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border border-state-cancelled/40 bg-state-cancelled/10 px-4 py-3 backdrop-blur-sm"
            >
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-state-cancelled" />
                <div className="min-w-0">
                  <div className="font-mono text-2xs uppercase tracking-cyber text-state-cancelled">
                    Stream Disconnected
                  </div>
                  <div className="mt-0.5 text-sm text-ink-muted">
                    Live updates paused — the pipeline is still running on the
                    server. You can wait for reconnection or start over.
                  </div>
                </div>
              </div>
              <button type="button" onClick={handleReset} className="btn-ghost">
                Start Over
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Result banner */}
        <AnimatePresence mode="wait">
          {(r.status === "error" || r.status === "cancelled" || r.status === "complete") && (
            <motion.div
              key={`banner-${r.status}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.3 }}
              className="mx-auto mt-5 max-w-3xl"
            >
              <ResultBanner
                status={r.status}
                error={r.error}
                onReset={handleReset}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Agent cards */}
        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
          className="mt-10 grid gap-4 md:grid-cols-3"
          aria-label="Agent pipeline"
        >
          {mainAgents.map((a) => (
            <AgentCard
              key={a.id}
              id={a.id}
              label={a.label}
              role={a.role}
              model={a.model}
              index={a.index}
              status={a.status}
              message={a.message}
            />
          ))}
        </motion.section>

        {/* Report */}
        <AnimatePresence>
          {showReport && (
            <motion.div
              key="report"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
              className="mt-10"
            >
              <ReportViewer
                content={r.reportContent}
                streaming={r.reportStreaming}
                complete={r.reportComplete}
                citations={r.citations}
                query={r.query}
                sessionId={r.sessionId}
                pipelineDuration={r.pipelineDuration}
                sourcesProcessed={r.sourcesProcessed}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Feed + Sources — only once a session has actually been started */}
        <AnimatePresence>
          {showTelemetry && (
            <motion.section
              key="telemetry"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="mt-10 grid gap-6 lg:grid-cols-3"
              aria-label="Pipeline telemetry"
            >
              <div className="lg:col-span-1">
                <AgentFeed
                  events={r.feedEvents}
                  active={r.isActive}
                  onClear={r.feedEvents.length > 0 ? r.clearFeed : undefined}
                />
              </div>
              <div className="lg:col-span-2">
                <AnimatePresence mode="wait">
                  {showSources ? (
                    <motion.div
                      key="sources"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <SourceList sources={r.sources} active={r.isActive} />
                    </motion.div>
                  ) : (
                    <motion.div
                      key="sources-empty"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.3 }}
                      className="flex h-full min-h-[14rem] items-center justify-center rounded-xl2 border border-dashed border-bg-border/80 bg-bg-panel/30 p-6 text-center"
                    >
                      <div>
                        <div className="font-mono text-2xs uppercase tracking-cyber text-ink-faint">
                          {r.isActive ? "Awaiting Extraction" : "Sources"}
                        </div>
                        <div className="mt-1 max-w-sm font-mono text-xs text-ink-dim">
                          {r.isActive
                            ? "The extraction agent will populate this panel as URLs are processed."
                            : "Sources will appear once extraction finishes."}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.section>
          )}
        </AnimatePresence>
      </main>

      <Footer
        streamStatus={r.streamStatus}
        sessionId={r.sessionId}
        sourcesProcessed={r.sourcesProcessed}
        scrapingErrorsCount={scrapingErrorsCount}
      />
    </div>
  );
}
