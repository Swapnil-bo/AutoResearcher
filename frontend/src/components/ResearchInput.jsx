import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

/**
 * ResearchInput — the directive surface.
 *
 * Driven by useResearch via three props:
 *   · onSubmit(query)  — called with a trimmed, validated query string
 *   · onCancel()       — fired when the user aborts an active pipeline
 *   · status           — ResearchState.status; drives disabled/active visuals
 *   · isCancelling     — shows "CANCELLING…" state on the cancel button
 *
 * Behaviour:
 *   · Enter submits, Shift+Enter inserts a newline, Ctrl/Cmd+Enter also submits
 *   · 1–500 char validation (matches POST /api/research server-side rules)
 *   · Auto-growing textarea, clears inline errors on input
 *   · Cancel button fades in only while the pipeline is active
 *   · Example chips below the panel pre-fill the textarea when idle
 */

const MAX_LENGTH = 500;
const MIN_LENGTH = 1;
const WARN_THRESHOLD = 450;

const EXAMPLE_QUERIES = [
  "What is retrieval-augmented generation, and where does it break down?",
  "How do mixture-of-experts models reduce inference cost?",
  "Compare LangGraph, CrewAI, and AutoGen for multi-agent orchestration.",
  "Latest research on long-context LLM evaluation benchmarks.",
];

const TERMINAL_STATES = new Set(["idle", "complete", "error", "cancelled"]);

function Spinner({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={`animate-spin ${className}`} aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SendIcon({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <path
        d="M5 12h14M13 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CancelIcon({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ClearIcon({ className = "h-3.5 w-3.5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.5" />
      <path
        d="M9 9l6 6M15 9l-6 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function ResearchInput({
  onSubmit,
  onCancel,
  status = "idle",
  isCancelling = false,
}) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef(null);

  const isActive = !TERMINAL_STATES.has(status);
  const trimmed = query.trim();
  const length = query.length;
  const remaining = MAX_LENGTH - length;
  const nearLimit = length >= WARN_THRESHOLD;
  const overLimit = length > MAX_LENGTH;
  const canSubmit = trimmed.length >= MIN_LENGTH && !isActive && !overLimit;

  // Auto-grow the textarea to fit its content, capped so it never takes over.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [query]);

  // Clear the validation error the moment the user starts typing again.
  useEffect(() => {
    if (error && query.length > 0) setError(null);
  }, [query, error]);

  const submit = useCallback(() => {
    if (isActive) return;
    if (trimmed.length < MIN_LENGTH) {
      setError("Enter a research question first.");
      textareaRef.current?.focus();
      return;
    }
    if (trimmed.length > MAX_LENGTH) {
      setError(`Query is too long — keep it under ${MAX_LENGTH} characters.`);
      return;
    }
    setError(null);
    onSubmit?.(trimmed);
  }, [trimmed, isActive, onSubmit]);

  const handleKeyDown = (e) => {
    // Enter submits; Shift+Enter lets users compose multi-line queries.
    // Ctrl/Cmd+Enter also submits — belt-and-suspenders for power users.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleExample = (text) => {
    if (isActive) return;
    setQuery(text);
    setError(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const ringClass = useMemo(() => {
    if (error) return "border-state-error/60 shadow-glow-error";
    if (focused) return "border-cyan-400/60 shadow-glow-cyan-sm";
    return "border-bg-border hover:border-cyan-400/30";
  }, [focused, error]);

  return (
    <div className="w-full">
      {/* Panel */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className={`relative rounded-2xl border bg-bg-panel/70 shadow-panel backdrop-blur-sm transition-[border-color,box-shadow] duration-300 ${ringClass}`}
      >
        {/* Label strip */}
        <div className="flex items-center justify-between border-b border-bg-border/70 px-5 py-2.5">
          <div className="flex items-center gap-2 font-mono text-2xs uppercase tracking-cyber text-ink-dim">
            <span className="text-cyan-400">▸</span>
            Research Directive
          </div>
          <div className="flex items-center gap-2 font-mono text-2xs uppercase tracking-terminal">
            <span
              className={`tabular-nums ${
                overLimit
                  ? "text-state-error"
                  : nearLimit
                    ? "text-state-cancelled"
                    : "text-ink-faint"
              }`}
            >
              {length}/{MAX_LENGTH}
            </span>
          </div>
        </div>

        {/* Textarea */}
        <div className="relative px-5 pt-4 pb-3">
          <textarea
            ref={textareaRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={isActive}
            maxLength={MAX_LENGTH + 40 /* allow brief overshoot so the counter can warn */}
            rows={3}
            placeholder="Ask anything. The three agents will handle the rest…"
            aria-label="Research question"
            aria-invalid={!!error}
            aria-describedby={error ? "research-input-error" : undefined}
            className="w-full resize-none bg-transparent font-sans text-base leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            style={{ minHeight: "4.5rem" }}
          />

          {/* Clear-to-empty affordance — sits top-right inside the text area. */}
          <AnimatePresence>
            {query && !isActive && (
              <motion.button
                type="button"
                onClick={() => {
                  setQuery("");
                  setError(null);
                  textareaRef.current?.focus();
                }}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.15 }}
                aria-label="Clear query"
                className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:text-ink-muted"
              >
                <ClearIcon />
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {/* Action bar */}
        <div className="flex items-center justify-end gap-3 border-t border-bg-border/70 px-4 py-3 sm:justify-between sm:px-5">
          <div className="hidden min-w-0 items-center gap-3 font-mono text-2xs uppercase tracking-terminal text-ink-faint sm:flex">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-bg-border bg-bg-deep/70 px-1.5 py-0.5 text-ink-muted">
                Enter
              </kbd>
              <span>to run</span>
            </span>
            <span className="text-ink-faint/60">·</span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-bg-border bg-bg-deep/70 px-1.5 py-0.5 text-ink-muted">
                Shift
              </kbd>
              <span>+</span>
              <kbd className="rounded border border-bg-border bg-bg-deep/70 px-1.5 py-0.5 text-ink-muted">
                Enter
              </kbd>
              <span>newline</span>
            </span>
          </div>

          <div className="flex items-center gap-2">
            <AnimatePresence>
              {isActive && (
                <motion.button
                  key="cancel"
                  type="button"
                  onClick={onCancel}
                  disabled={isCancelling}
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 10 }}
                  transition={{ duration: 0.2 }}
                  className="btn-danger"
                  aria-label="Cancel research"
                >
                  {isCancelling ? (
                    <>
                      <Spinner className="h-4 w-4" />
                      Cancelling
                    </>
                  ) : (
                    <>
                      <CancelIcon />
                      Cancel
                    </>
                  )}
                </motion.button>
              )}
            </AnimatePresence>

            <motion.button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              whileTap={canSubmit ? { scale: 0.97 } : undefined}
              className="btn-primary min-w-[8.5rem]"
              aria-label="Start research"
            >
              {isActive ? (
                <>
                  <Spinner className="h-4 w-4" />
                  Running
                </>
              ) : (
                <>
                  Research
                  <SendIcon />
                </>
              )}
            </motion.button>
          </div>
        </div>
      </motion.div>

      {/* Inline error */}
      <AnimatePresence>
        {error && (
          <motion.div
            id="research-input-error"
            role="alert"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            className="mt-2 flex items-center gap-2 px-1 font-mono text-2xs uppercase tracking-terminal text-state-error"
          >
            <span className="h-1 w-1 rounded-full bg-state-error" />
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Example chips — only while idle, so they don't distract during a run. */}
      <AnimatePresence>
        {!isActive && !query && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.25, delay: 0.05 }}
            className="mt-4"
          >
            <div className="mb-2 flex items-center gap-2 font-mono text-2xs uppercase tracking-cyber text-ink-faint">
              <span className="h-px w-6 bg-ink-faint/50" />
              Try an example
            </div>
            <div className="flex flex-wrap gap-2">
              {EXAMPLE_QUERIES.map((text, i) => (
                <motion.button
                  key={text}
                  type="button"
                  onClick={() => handleExample(text)}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: 0.08 * i }}
                  className="group rounded-full border border-bg-border bg-bg-deep/60 px-3 py-1.5 text-xs text-ink-muted transition-all hover:-translate-y-0.5 hover:border-cyan-400/40 hover:bg-bg-hover hover:text-ink-bright"
                >
                  <span className="font-mono text-cyan-400/70 group-hover:text-cyan-300">
                    ▸
                  </span>{" "}
                  {text}
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
