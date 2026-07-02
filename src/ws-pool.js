// Session-keyed WebSocket connection pool that presents itself as a fetch().
// One socket per conversation (session-id / x-session-affinity header) keeps codex-lb
// pinned to a single upstream account for the whole turn-sequence — the property the
// load balancer needs. Ineligible requests fall through to plain HTTP.
//
// Ownership model: while a turn is streaming the bridge owns the socket's events;
// between turns the pool attaches an idle watcher that drops the pooled socket if
// the server closes it. Pool-initiated closes use application close code 4002.
//
// Adapted from OpenCode's packages/opencode/src/plugin/openai/ws-pool.ts.

import { connectResponsesWebSocket, isAbortError, streamResponsesWebSocket } from "./ws-bridge.js"

const DEFAULT_CONNECT_TIMEOUT = 15_000
const DEFAULT_POOL_IDLE_TIMEOUT = 90_000
const DEFAULT_STREAM_INACTIVITY_TIMEOUT = 5 * 60 * 1000
const DEFAULT_MAX_CONNECTION_AGE = 55 * 60 * 1000
const TITLE_HEADER = "x-opencode-title"
const OPEN = 1
const CLOSE_CODE_POOL_INVALIDATE = 4002
// Clean/ambiguous server-side closes before the first event of a turn: the request
// raced a socket the server was tearing down, so it is safe to retry once.
const RETRYABLE_PRE_EVENT_CLOSE_CODES = new Set([1001, 1005, 1006])

export function normalizeHeaders(headersInit) {
  const out = {}
  if (!headersInit) return out
  if (typeof Headers !== "undefined" && headersInit instanceof Headers) {
    for (const [key, value] of headersInit) out[key.toLowerCase()] = value
    return out
  }
  if (Array.isArray(headersInit)) {
    for (const [key, value] of headersInit) out[String(key).toLowerCase()] = value
    return out
  }
  for (const [key, value] of Object.entries(headersInit)) out[key.toLowerCase()] = value
  return out
}

function parseBody(init) {
  if (typeof init?.body !== "string") return undefined
  try {
    const parsed = JSON.parse(init.body)
    return typeof parsed === "object" && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

function failedResponse(error) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error)
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

export function createWebSocketFetch(options = {}) {
  const httpFetch = options.httpFetch ?? globalThis.fetch
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket
  const connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
  const poolIdleTimeout = options.poolIdleTimeout ?? DEFAULT_POOL_IDLE_TIMEOUT
  const streamInactivityTimeout = options.streamInactivityTimeout ?? DEFAULT_STREAM_INACTIVITY_TIMEOUT
  const maxConnectionAge = options.maxConnectionAge ?? DEFAULT_MAX_CONNECTION_AGE
  const streamRetries = options.streamRetries ?? 5
  const pool = new Map()

  const pruneTimer = setInterval(prune, Math.min(poolIdleTimeout, 60_000))
  pruneTimer.unref?.()

  function now() {
    return options.now ? options.now() : Date.now()
  }
  function releaseIdleWatcher(entry) {
    const watcher = entry.idleWatcher
    if (!watcher) return
    entry.idleWatcher = undefined
    watcher.socket.removeEventListener?.("close", watcher.onDown)
    watcher.socket.removeEventListener?.("error", watcher.onDown)
  }
  // Pool takes ownership of an idle socket: if the server closes it between turns,
  // drop it from the entry so the next turn reconnects instead of failing.
  function watchIdleSocket(entry) {
    releaseIdleWatcher(entry)
    const socket = entry.socket
    if (!socket || socket.readyState !== OPEN) return
    const onDown = () => {
      if (entry.idleWatcher?.socket === socket) entry.idleWatcher = undefined
      if (entry.socket === socket) {
        entry.socket = undefined
        entry.connectedAt = undefined
      }
    }
    entry.idleWatcher = { socket, onDown }
    socket.addEventListener("close", onDown, { once: true })
    socket.addEventListener("error", onDown, { once: true })
  }
  function invalidate(entry) {
    releaseIdleWatcher(entry)
    if (entry.socket) {
      try {
        entry.socket.close(CLOSE_CODE_POOL_INVALIDATE, "pool invalidate")
      } catch {}
      entry.socket = undefined
    }
    entry.connectedAt = undefined
  }
  function recordStreamFailure(entry) {
    entry.streamFailures++
    if (entry.streamFailures > streamRetries) entry.fallback = true
  }
  function prune() {
    const ts = now()
    for (const [key, entry] of pool) {
      if (entry.busy || entry.fallback) continue
      if (ts - entry.lastUsedAt < poolIdleTimeout) continue
      invalidate(entry)
      pool.delete(key)
    }
  }
  async function getSocket(entry, url, headers, signal) {
    if (entry.socket?.readyState === OPEN && entry.connectedAt && now() - entry.connectedAt < maxConnectionAge) {
      return entry.socket
    }
    invalidate(entry)
    const socket = await connectResponsesWebSocket({ url, headers, timeout: connectTimeout, signal, WebSocketImpl })
    entry.connectedAt = now()
    return socket
  }

  async function websocketFetch(input, init) {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url
    const headers = normalizeHeaders(init?.headers)

    if (init?.method !== "POST" || !new URL(url).pathname.endsWith("/responses")) return httpFetch(input, init)
    const body = parseBody(init)
    if (!body?.stream) return httpFetch(input, init)
    if (headers[TITLE_HEADER] === "true") return httpFetch(input, init)

    const sessionID = headers["x-session-affinity"] ?? headers["session-id"]
    if (!sessionID) return httpFetch(input, init)
    const key = `${sessionID}:conversation`

    const entry =
      pool.get(key) ??
      {
        socket: undefined,
        connectedAt: undefined,
        lastUsedAt: now(),
        busy: false,
        fallback: false,
        streamFailures: 0,
        idleWatcher: undefined,
      }
    pool.set(key, entry)
    if (entry.fallback) return httpFetch(input, init)
    if (entry.busy) return httpFetch(input, init)

    try {
      for (let attempt = 0; ; attempt++) {
        entry.busy = true
        entry.lastUsedAt = now()
        try {
          entry.socket = await getSocket(entry, url, headers, init?.signal ?? undefined)
        } catch (error) {
          // Handshake-phase clean/ambiguous close: retry once on a fresh socket
          // without counting a stream failure. Everything else (incl. AbortError)
          // falls through to the outer catch unchanged.
          if (
            attempt === 0 &&
            !isAbortError(error) &&
            error?.code === "WS_CLOSED" &&
            RETRYABLE_PRE_EVENT_CLOSE_CODES.has(error?.closeCode)
          ) {
            invalidate(entry)
            continue
          }
          throw error
        }
        // Hand ownership of the socket to the bridge for the duration of the turn.
        releaseIdleWatcher(entry)

        let emittedFirst = false
        let invalidError
        let resolveFirst = () => {}
        let rejectFirst = () => {}
        const firstEvent = new Promise((resolve, reject) => {
          resolveFirst = resolve
          rejectFirst = reject
        })

        const response = streamResponsesWebSocket({
          socket: entry.socket,
          body,
          inactivityTimeout: streamInactivityTimeout,
          signal: init?.signal ?? undefined,
          onFirstEvent: (wrapped) => {
            emittedFirst = true
            resolveFirst(wrapped ?? true)
          },
          onComplete: () => {},
          onTerminal: (event) => {
            entry.busy = false
            entry.lastUsedAt = now()
            entry.streamFailures = 0
            if (event?.type !== "response.completed" && event?.type !== "response.done") invalidate(entry)
            else watchIdleSocket(entry) // ownership back to the pool
          },
          onConnectionInvalid: (error) => {
            entry.busy = false
            entry.lastUsedAt = now()
            invalidError = error
            if (emittedFirst && !entry.fallback) recordStreamFailure(entry)
            invalidate(entry)
            resolveFirst(false)
          },
          onAbort: (error) => {
            entry.busy = false
            entry.lastUsedAt = now()
            entry.streamFailures = 0
            invalidate(entry)
            rejectFirst(error)
          },
          onCancel: () => {
            entry.busy = false
            entry.lastUsedAt = now()
            invalidate(entry)
          },
        })

        const first = await firstEvent
        if (first === false) {
          // Connection died before any event. Clean/ambiguous closes get one retry
          // on a fresh socket and do not count as a stream failure; a 1000 close
          // (and anything else) is terminal.
          if (attempt === 0 && RETRYABLE_PRE_EVENT_CLOSE_CODES.has(invalidError?.closeCode)) continue
          if (!entry.fallback) recordStreamFailure(entry)
          if (entry.fallback) return httpFetch(input, init)
          return response
        }
        if (first !== true && typeof first?.status === "number" && first.status >= 400 && first.status <= 599) {
          // Wrapped upstream error before the first event: restore it as a real
          // HTTP response with the original status instead of a 200 stream error.
          // Only 4xx/5xx are restorable (Response rejects out-of-range statuses and
          // bodies on 204/205/304); anything else keeps the bridge's errored stream,
          // which already carries WS_UPSTREAM_ERROR plus the status.
          return new Response(first.body, { status: first.status, headers: { "content-type": "application/json" } })
        }
        return response
      }
    } catch (error) {
      entry.busy = false
      entry.lastUsedAt = now()
      if (isAbortError(error)) {
        entry.streamFailures = 0
        invalidate(entry)
        throw error
      }
      recordStreamFailure(entry)
      invalidate(entry)
      if (entry.fallback) return httpFetch(input, init)
      return failedResponse(error instanceof Error ? error : new Error(String(error)))
    }
  }

  function close() {
    clearInterval(pruneTimer)
    for (const entry of pool.values()) invalidate(entry)
    pool.clear()
  }
  function remove(sessionID) {
    const key = `${sessionID}:conversation`
    const entry = pool.get(key)
    if (!entry) return
    invalidate(entry)
    pool.delete(key)
  }

  return Object.assign(websocketFetch, { close, remove })
}
