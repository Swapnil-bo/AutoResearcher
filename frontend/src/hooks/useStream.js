import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useStream — low-level, reusable SSE primitive.
 *
 * Wraps the browser's EventSource with:
 *   · lifecycle management (connect, disconnect, cleanup on unmount)
 *   · exponential-backoff reconnection after transient drops
 *   · typed-event routing — every server-named event (e.g. `event: agent_update`)
 *     fires the single onEvent(type, data, raw) callback with parsed JSON
 *   · duplicate suppression by monotonic `timestamp` field — critical because
 *     the AutoResearcher backend replays state["stream_events"] from index 0
 *     on every reconnect
 *
 * It deliberately knows nothing about research state. Consumers (useResearch)
 * build domain behaviour on top.
 *
 * Options:
 *   · events              — list of named event types to subscribe to. The
 *                            backend catalog is the default (plus "connected"
 *                            and "heartbeat"). Must include every event you
 *                            care about — untyped SSE messages fall back to
 *                            the "message" event, which is listed by default.
 *   · onEvent(type,data,e) — fired for every received event after JSON parsing
 *   · onOpen / onError / onClose — connection lifecycle hooks
 *   · enabled             — gates whether the hook connects at all
 *   · autoReconnect       — if true, reconnect after transient drops (default true)
 *   · maxReconnectAttempts— caps reconnect attempts before giving up (default 5)
 *   · reconnectBaseDelay  — base delay in ms for backoff (default 500)
 *   · maxReconnectDelay   — upper bound on backoff (default 10s)
 *   · dedupByTimestamp    — skip events whose `timestamp` <= the last one seen,
 *                            protecting against replay-on-reconnect (default true)
 *
 * Returns:
 *   { status, lastEventType, lastTimestamp, attempts, connect, disconnect }
 *   status ∈ "idle" | "connecting" | "open" | "error" | "closed"
 */

const DEFAULT_EVENT_TYPES = [
  "connected",
  "heartbeat",
  "agent_update",
  "search_queries",
  "search_results",
  "source_progress",
  "source_summary",
  "report_token",
  "report_complete",
  "pipeline_complete",
  "error",
  "cancelled",
  "message",
];

function safeParse(raw) {
  if (typeof raw !== "string") return raw;
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function useStream(
  url,
  {
    events = DEFAULT_EVENT_TYPES,
    onEvent,
    onOpen,
    onError,
    onClose,
    enabled = true,
    autoReconnect = true,
    maxReconnectAttempts = 5,
    reconnectBaseDelay = 500,
    maxReconnectDelay = 10000,
    dedupByTimestamp = true,
  } = {}
) {
  const [status, setStatus] = useState("idle");
  const [lastEventType, setLastEventType] = useState(null);
  const [lastTimestamp, setLastTimestamp] = useState(null);
  const [attempts, setAttempts] = useState(0);

  // Stable refs so new callback identities don't trigger re-connection.
  const onEventRef = useRef(onEvent);
  const onOpenRef = useRef(onOpen);
  const onErrorRef = useRef(onError);
  const onCloseRef = useRef(onClose);
  const eventsRef = useRef(events);

  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  useEffect(() => { onOpenRef.current = onOpen; }, [onOpen]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { eventsRef.current = events; }, [events]);

  const esRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const attemptsRef = useRef(0);
  const manualCloseRef = useRef(false);
  const lastTsRef = useRef(null);

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const teardown = useCallback(() => {
    clearReconnectTimer();
    const es = esRef.current;
    if (es) {
      // Null out handlers so a late-firing onerror doesn't trigger reconnect.
      es.onopen = null;
      es.onerror = null;
      es.onmessage = null;
      try { es.close(); } catch { /* ignore */ }
      esRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!autoReconnect) return false;
    if (attemptsRef.current >= maxReconnectAttempts) return false;

    const n = attemptsRef.current;
    // Exponential backoff with jitter — caps at maxReconnectDelay.
    const raw = reconnectBaseDelay * 2 ** n;
    const jitter = raw * (0.25 * Math.random());
    const delay = Math.min(raw + jitter, maxReconnectDelay);

    attemptsRef.current = n + 1;
    setAttempts(attemptsRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectRef.current?.();
    }, delay);
    return true;
  }, [autoReconnect, maxReconnectAttempts, reconnectBaseDelay, maxReconnectDelay]);

  // Forward-declare connect via ref so scheduleReconnect can call it without
  // a circular dependency in the closures above.
  const connectRef = useRef(null);

  const connect = useCallback(() => {
    if (!url) return;
    teardown();
    manualCloseRef.current = false;
    setStatus("connecting");

    let es;
    try {
      es = new EventSource(url);
    } catch (err) {
      setStatus("error");
      onErrorRef.current?.(err);
      scheduleReconnect();
      return;
    }

    esRef.current = es;

    es.onopen = () => {
      attemptsRef.current = 0;
      setAttempts(0);
      setStatus("open");
      onOpenRef.current?.();
    };

    es.onerror = (evt) => {
      // EventSource collapses every failure mode into one event with no
      // detail. readyState is our only signal — CLOSED means the browser
      // gave up. CONNECTING means it's mid-retry and will self-heal.
      const readyState = es.readyState;
      onErrorRef.current?.(evt);

      if (manualCloseRef.current) return;

      if (readyState === EventSource.CLOSED) {
        setStatus("error");
        const rescheduled = scheduleReconnect();
        if (!rescheduled) {
          setStatus("closed");
          onCloseRef.current?.();
        }
      } else {
        // Still CONNECTING — browser retrying on its own. Stay in connecting.
        setStatus("connecting");
      }
    };

    const handleNamed = (type) => (evt) => {
      const data = safeParse(evt.data);

      // Drop replays on reconnect — timestamp is monotonically increasing
      // per-session on the backend.
      if (
        dedupByTimestamp &&
        data &&
        typeof data === "object" &&
        typeof data.timestamp === "number" &&
        lastTsRef.current != null &&
        data.timestamp <= lastTsRef.current
      ) {
        return;
      }

      if (
        data &&
        typeof data === "object" &&
        typeof data.timestamp === "number"
      ) {
        lastTsRef.current = data.timestamp;
        setLastTimestamp(data.timestamp);
      }

      setLastEventType(type);
      onEventRef.current?.(type, data, evt);
    };

    for (const type of eventsRef.current) {
      es.addEventListener(type, handleNamed(type));
    }
  }, [url, teardown, scheduleReconnect, dedupByTimestamp]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const disconnect = useCallback(() => {
    manualCloseRef.current = true;
    attemptsRef.current = 0;
    setAttempts(0);
    teardown();
    setStatus("closed");
    onCloseRef.current?.();
  }, [teardown]);

  // Drive the connection lifecycle from (url, enabled).
  useEffect(() => {
    if (!enabled || !url) {
      manualCloseRef.current = true;
      teardown();
      setStatus("idle");
      lastTsRef.current = null;
      return undefined;
    }

    // Fresh connection — reset dedup cursor so a brand-new URL replays cleanly.
    lastTsRef.current = null;
    setLastTimestamp(null);
    attemptsRef.current = 0;
    setAttempts(0);
    connect();

    return () => {
      manualCloseRef.current = true;
      teardown();
    };
  }, [url, enabled, connect, teardown]);

  return {
    status,
    lastEventType,
    lastTimestamp,
    attempts,
    connect,
    disconnect,
  };
}

export default useStream;
