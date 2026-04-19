import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStream } from "./useStream";

/**
 * useResearch — application-level research session state.
 *
 * Owns:
 *   · session lifecycle: POST /api/research, DELETE cancel, GET final report fallback
 *   · the SSE stream subscription via useStream
 *   · canonical derived state:
 *       - status (mirrors ResearchState.status)
 *       - agentStatuses { search, extract, synthesize, format }
 *       - feedEvents   (assembled from every SSE event the UI cares about)
 *       - sources      (unified list: fetching → success → with summary)
 *       - searchQueries / searchResults / citations / scrapingErrors
 *       - reportContent (progressively assembled from report_token events)
 *       - sessionStartTime / pipelineDuration / sourcesProcessed
 *       - error / lastMessage / isCancelling
 *
 * Exposes: startResearch(query), cancelResearch(), reset()
 *
 * Every SSE event routes through a single reducer so the ordering guarantees
 * the backend provides (timestamps monotonic, status transitions linear) are
 * mirrored faithfully in the UI without rendering races.
 */

const AGENT_CARD_SET = new Set(["search", "extract", "synthesize", "format"]);

const TERMINAL_STATUSES = new Set(["complete", "error", "cancelled"]);

const INITIAL_AGENT_STATUSES = Object.freeze({
  search: { status: "idle", message: null, metrics: null },
  extract: { status: "idle", message: null, metrics: null },
  synthesize: { status: "idle", message: null, metrics: null },
  format: { status: "idle", message: null, metrics: null },
});

const INITIAL_STATE = Object.freeze({
  sessionId: null,
  query: "",
  status: "idle",
  sessionStartTime: null,
  pipelineDuration: null,
  sourcesProcessed: 0,
  agentStatuses: INITIAL_AGENT_STATUSES,
  feedEvents: [],
  sources: [],
  searchQueries: [],
  searchResults: [],
  reportContent: "",
  citations: [],
  reportStreaming: false,
  reportComplete: false,
  scrapingErrors: [],
  error: null,
  lastMessage: null,
  isCancelling: false,
  streamStatus: "idle",
});

/** Map backend agent_update.status → frontend agent card status. */
function normalizeAgentStatus(raw) {
  switch (raw) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

/** Promote an agent-level status into a pipeline-level phase, if applicable. */
function phaseFromAgentUpdate(agent, status) {
  if (status !== "running") return null;
  switch (agent) {
    case "search":
      return "searching";
    case "extract":
      return "extracting";
    case "synthesize":
      return "synthesizing";
    case "format":
      return "formatting";
    default:
      return null;
  }
}

/** agent_update.status → feed log level. */
function levelFromStatus(status) {
  if (status === "error") return "error";
  if (status === "cancelled") return "warn";
  if (status === "done") return "success";
  return "info";
}

/** Pick a feed "agent" bucket, defaulting anything unknown to 'system'. */
function feedAgentBucket(agent) {
  if (AGENT_CARD_SET.has(agent)) return agent;
  return "system";
}

function truncate(text, n = 120) {
  if (typeof text !== "string") return "";
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

/** Append a feed event with a stable unique id. */
function appendFeed(prev, eventSeq, partial) {
  const id = `fe-${eventSeq}`;
  const entry = {
    id,
    timestamp: partial.timestamp ?? Date.now() / 1000,
    agent: partial.agent ?? "system",
    level: partial.level ?? "info",
    message: partial.message ?? "",
  };
  return [...prev, entry];
}

/** Upsert a source entry keyed by URL. */
function upsertSource(list, url, patch) {
  if (!url) return list;
  const i = list.findIndex((s) => s.url === url);
  if (i === -1) {
    return [
      ...list,
      {
        url,
        title: patch.title ?? null,
        summary: patch.summary ?? null,
        reason: patch.reason ?? null,
        status: patch.status ?? "fetching",
        timestamp: patch.timestamp ?? Date.now() / 1000,
      },
    ];
  }
  const next = list.slice();
  const cur = next[i];
  next[i] = {
    ...cur,
    ...patch,
    // Prefer existing non-null fields when patch nulls them out.
    title: patch.title ?? cur.title,
    summary: patch.summary ?? cur.summary,
    reason: patch.reason ?? cur.reason,
    status: patch.status ?? cur.status,
  };
  return next;
}

function cleanup(controllers) {
  for (const c of controllers) {
    try { c.abort(); } catch { /* ignore */ }
  }
}

export function useResearch() {
  const [state, setState] = useState(INITIAL_STATE);
  const seqRef = useRef(0);
  const abortRef = useRef([]);

  /* ── SSE url derivation ─────────────────────────────────────────── */

  const streamUrl = useMemo(() => {
    if (!state.sessionId) return null;
    return `/api/research/${state.sessionId}/stream`;
  }, [state.sessionId]);

  const streamEnabled = useMemo(
    () => !!state.sessionId && !TERMINAL_STATUSES.has(state.status),
    [state.sessionId, state.status]
  );

  /* ── Event reducer ──────────────────────────────────────────────── */

  const handleEvent = useCallback((type, data) => {
    if (type === "heartbeat" || type === "connected") return;

    const payload = data && typeof data === "object" ? data : {};
    const ts = typeof payload.timestamp === "number"
      ? payload.timestamp
      : Date.now() / 1000;

    seqRef.current += 1;
    const seq = seqRef.current;

    setState((prev) => {
      switch (type) {
        case "agent_update": {
          const agent = payload.agent ?? "pipeline";
          const rawStatus = payload.status ?? "running";
          const normalized = normalizeAgentStatus(rawStatus);
          const message = payload.message ?? null;
          const phase = phaseFromAgentUpdate(agent, normalized);

          const agentStatuses = AGENT_CARD_SET.has(agent)
            ? {
                ...prev.agentStatuses,
                [agent]: {
                  ...prev.agentStatuses[agent],
                  status: normalized,
                  message,
                },
              }
            : prev.agentStatuses;

          // Don't let a late agent_update override a terminal pipeline status.
          const nextStatus = TERMINAL_STATUSES.has(prev.status)
            ? prev.status
            : phase ?? prev.status;

          return {
            ...prev,
            agentStatuses,
            status: nextStatus,
            lastMessage: message ?? prev.lastMessage,
            feedEvents: appendFeed(prev.feedEvents, seq, {
              timestamp: ts,
              agent: feedAgentBucket(agent),
              level: levelFromStatus(rawStatus),
              message: message ?? `${agent} → ${rawStatus}`,
            }),
          };
        }

        case "search_queries": {
          const queries = Array.isArray(payload.queries) ? payload.queries : [];
          return {
            ...prev,
            searchQueries: queries,
            feedEvents: appendFeed(prev.feedEvents, seq, {
              timestamp: ts,
              agent: "search",
              level: "info",
              message: `Generated ${queries.length} search ${queries.length === 1 ? "query" : "queries"}`,
            }),
          };
        }

        case "search_results": {
          const results = Array.isArray(payload.results) ? payload.results : [];
          return {
            ...prev,
            searchResults: results,
            feedEvents: appendFeed(prev.feedEvents, seq, {
              timestamp: ts,
              agent: "search",
              level: "success",
              message: `Ranked ${results.length} candidate URLs`,
            }),
          };
        }

        case "source_progress": {
          const url = payload.url;
          const rawStatus = payload.status ?? "fetching";
          const reason = payload.reason ?? null;

          // Map backend statuses onto the SourceList contract:
          //   fetching → still in progress
          //   done     → HTML fetched; summary may still be pending
          //   failed   → terminal failure
          let mapped;
          if (rawStatus === "failed") mapped = "failed";
          else if (rawStatus === "done") mapped = "fetching"; // summary arrives next
          else mapped = "fetching";

          const sources = upsertSource(prev.sources, url, {
            status: mapped,
            reason: mapped === "failed" ? reason || "Fetch failed" : null,
            timestamp: ts,
          });

          const scrapingErrors =
            mapped === "failed"
              ? [
                  ...prev.scrapingErrors.filter((e) => e.url !== url),
                  { url, reason: reason || "Fetch failed" },
                ]
              : prev.scrapingErrors;

          const level = mapped === "failed" ? "warn" : "info";
          const host = (() => {
            try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
          })();

          return {
            ...prev,
            sources,
            scrapingErrors,
            feedEvents: appendFeed(prev.feedEvents, seq, {
              timestamp: ts,
              agent: "extract",
              level,
              message:
                mapped === "failed"
                  ? `Skipped ${host} — ${reason || "fetch failed"}`
                  : rawStatus === "done"
                    ? `Fetched ${host}`
                    : `Fetching ${host}…`,
            }),
          };
        }

        case "source_summary": {
          const url = payload.url;
          const title = payload.title ?? null;
          const summary = payload.summary ?? null;

          const sources = upsertSource(prev.sources, url, {
            title,
            summary,
            status: "success",
            timestamp: ts,
          });

          return {
            ...prev,
            sources,
            sourcesProcessed: sources.filter((s) => s.status === "success").length,
            feedEvents: appendFeed(prev.feedEvents, seq, {
              timestamp: ts,
              agent: "extract",
              level: "success",
              message: `Summarized: ${truncate(title || url, 100)}`,
            }),
          };
        }

        case "report_token": {
          const token = typeof payload.data === "string" ? payload.data : "";
          if (!token) return prev;
          return {
            ...prev,
            reportContent: prev.reportContent + token,
            reportStreaming: true,
            reportComplete: false,
          };
        }

        case "report_complete": {
          const citations = Array.isArray(payload.citations)
            ? payload.citations
            : [];
          return {
            ...prev,
            citations,
            reportStreaming: false,
            reportComplete: true,
            feedEvents: appendFeed(prev.feedEvents, seq, {
              timestamp: ts,
              agent: "synthesize",
              level: "success",
              message: `Report drafted — ${citations.length} citations`,
            }),
          };
        }

        case "pipeline_complete": {
          const duration =
            typeof payload.pipeline_duration === "number"
              ? payload.pipeline_duration
              : null;
          const sourcesProcessed =
            typeof payload.sources_processed === "number"
              ? payload.sources_processed
              : prev.sourcesProcessed;
          return {
            ...prev,
            status: "complete",
            pipelineDuration: duration,
            sourcesProcessed,
            reportStreaming: false,
            reportComplete: true,
            feedEvents: appendFeed(prev.feedEvents, seq, {
              timestamp: ts,
              agent: "format",
              level: "success",
              message: `Pipeline complete in ${duration != null ? `${duration.toFixed(1)}s` : "—"}`,
            }),
          };
        }

        case "error": {
          const message = payload.message ?? "Pipeline error";
          return {
            ...prev,
            status: "error",
            error: message,
            reportStreaming: false,
            lastMessage: message,
            feedEvents: appendFeed(prev.feedEvents, seq, {
              timestamp: ts,
              agent: "system",
              level: "error",
              message,
            }),
          };
        }

        case "cancelled": {
          const message = payload.message ?? "Pipeline cancelled by user";
          return {
            ...prev,
            status: "cancelled",
            reportStreaming: false,
            isCancelling: false,
            lastMessage: message,
            feedEvents: appendFeed(prev.feedEvents, seq, {
              timestamp: ts,
              agent: "system",
              level: "warn",
              message,
            }),
          };
        }

        default:
          // Unknown event type — surface it in the feed for debuggability,
          // but never crash the UI over unexpected payloads.
          return {
            ...prev,
            feedEvents: appendFeed(prev.feedEvents, seq, {
              timestamp: ts,
              agent: "system",
              level: "info",
              message: `Unhandled event: ${type}`,
            }),
          };
      }
    });
  }, []);

  /* ── Stream connection ──────────────────────────────────────────── */

  const stream = useStream(streamUrl, {
    enabled: streamEnabled,
    onEvent: handleEvent,
    autoReconnect: true,
    maxReconnectAttempts: 4,
  });

  // Mirror the stream's connection status into state so downstream
  // components can react to disconnects without subscribing to useStream
  // directly. Effect-driven so we never setState during render.
  useEffect(() => {
    setState((prev) => (
      prev.streamStatus === stream.status
        ? prev
        : { ...prev, streamStatus: stream.status }
    ));
  }, [stream.status]);

  /* ── Actions ────────────────────────────────────────────────────── */

  const reset = useCallback(() => {
    cleanup(abortRef.current);
    abortRef.current = [];
    seqRef.current = 0;
    setState(INITIAL_STATE);
  }, []);

  const startResearch = useCallback(
    async (query) => {
      const trimmed = (query ?? "").trim();
      if (!trimmed) {
        setState((p) => ({ ...p, error: "Enter a research question first." }));
        return null;
      }

      // Fresh slate — otherwise stale feed events and tokens bleed across runs.
      cleanup(abortRef.current);
      abortRef.current = [];
      seqRef.current = 0;

      setState({
        ...INITIAL_STATE,
        query: trimmed,
        status: "searching",
        sessionStartTime: Date.now() / 1000,
      });

      const controller = new AbortController();
      abortRef.current.push(controller);

      try {
        const resp = await fetch("/api/research", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: trimmed }),
          signal: controller.signal,
        });

        if (!resp.ok) {
          let detail = `Request failed (${resp.status})`;
          try {
            const body = await resp.json();
            if (body?.detail) detail = body.detail;
          } catch { /* ignore parse errors */ }
          setState((p) => ({
            ...p,
            status: "error",
            error: detail,
          }));
          return null;
        }

        const body = await resp.json();
        const sessionId = body?.session_id;
        if (!sessionId) {
          setState((p) => ({
            ...p,
            status: "error",
            error: "Server did not return a session id.",
          }));
          return null;
        }

        setState((p) => ({
          ...p,
          sessionId,
          status: "searching",
        }));
        return sessionId;
      } catch (err) {
        if (err?.name === "AbortError") return null;
        setState((p) => ({
          ...p,
          status: "error",
          error: err?.message
            ? `Could not start research: ${err.message}`
            : "Could not start research.",
        }));
        return null;
      }
    },
    []
  );

  const cancelResearch = useCallback(async () => {
    const sid = state.sessionId;
    if (!sid) return;
    if (TERMINAL_STATUSES.has(state.status)) return;

    setState((p) => ({ ...p, isCancelling: true }));

    const controller = new AbortController();
    abortRef.current.push(controller);

    try {
      const resp = await fetch(`/api/research/${sid}`, {
        method: "DELETE",
        signal: controller.signal,
      });
      if (!resp.ok && resp.status !== 409) {
        let detail = `Cancel failed (${resp.status})`;
        try {
          const body = await resp.json();
          if (body?.detail) detail = body.detail;
        } catch { /* ignore */ }
        setState((p) => ({
          ...p,
          isCancelling: false,
          lastMessage: detail,
        }));
      }
      // On 2xx / 409 we wait for the SSE `cancelled` event to flip status.
    } catch (err) {
      if (err?.name === "AbortError") return;
      setState((p) => ({
        ...p,
        isCancelling: false,
        lastMessage: err?.message
          ? `Cancel failed: ${err.message}`
          : "Cancel failed.",
      }));
    }
  }, [state.sessionId, state.status]);

  const clearFeed = useCallback(() => {
    setState((p) => ({ ...p, feedEvents: [] }));
  }, []);

  /* ── Derived conveniences for consumers ─────────────────────────── */

  const isActive = !TERMINAL_STATUSES.has(state.status) && state.status !== "idle";

  return {
    // session
    sessionId: state.sessionId,
    query: state.query,
    status: state.status,
    isActive,
    sessionStartTime: state.sessionStartTime,
    pipelineDuration: state.pipelineDuration,

    // agents
    agentStatuses: state.agentStatuses,

    // feed
    feedEvents: state.feedEvents,
    clearFeed,

    // sources
    sources: state.sources,
    sourcesProcessed: state.sourcesProcessed,
    scrapingErrors: state.scrapingErrors,

    // search
    searchQueries: state.searchQueries,
    searchResults: state.searchResults,

    // report
    reportContent: state.reportContent,
    reportStreaming: state.reportStreaming,
    reportComplete: state.reportComplete,
    citations: state.citations,

    // status / errors
    error: state.error,
    lastMessage: state.lastMessage,
    isCancelling: state.isCancelling,
    streamStatus: state.streamStatus,

    // actions
    startResearch,
    cancelResearch,
    reset,
  };
}

export default useResearch;
