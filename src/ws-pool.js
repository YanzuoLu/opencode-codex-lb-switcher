// Session-keyed WebSocket connection pool that presents itself as a fetch().
// One socket per conversation (session-id / x-session-affinity header) keeps codex-lb
// pinned to a single upstream account for the whole turn-sequence — the property the
// load balancer needs. Ineligible requests fall through to plain HTTP.
//
// Adapted from OpenCode's packages/opencode/src/plugin/openai/ws-pool.ts.

import { connectResponsesWebSocket, isAbortError, streamResponsesWebSocket } from "./ws-bridge.js"

const DEFAULT_CONNECT_TIMEOUT = 15_000
const DEFAULT_IDLE_TIMEOUT = 5 * 60 * 1000
const DEFAULT_MAX_CONNECTION_AGE = 55 * 60 * 1000
const TITLE_HEADER = "x-opencode-title"
const OPEN = 1

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
  const idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
  const maxConnectionAge = options.maxConnectionAge ?? DEFAULT_MAX_CONNECTION_AGE
  const streamRetries = options.streamRetries ?? 5
  const pool = new Map()

  const pruneTimer = setInterval(prune, Math.min(idleTimeout, 60_000))
  pruneTimer.unref?.()

  function now() {
    return options.now ? options.now() : Date.now()
  }
  function invalidate(entry) {
    if (entry.socket) {
      try {
        entry.socket.close()
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
      if (ts - entry.lastUsedAt < idleTimeout) continue
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

    const entry = pool.get(key) ?? { socket: undefined, connectedAt: undefined, lastUsedAt: now(), busy: false, fallback: false, streamFailures: 0 }
    pool.set(key, entry)
    if (entry.fallback) return httpFetch(input, init)
    if (entry.busy) return httpFetch(input, init)

    entry.busy = true
    entry.lastUsedAt = now()
    try {
      entry.socket = await getSocket(entry, url, headers, init?.signal ?? undefined)

      let resolveFirst = () => {}
      let rejectFirst = () => {}
      const firstEvent = new Promise((resolve, reject) => {
        resolveFirst = resolve
        rejectFirst = reject
      })
      const response = streamResponsesWebSocket({
        socket: entry.socket,
        body,
        idleTimeout,
        signal: init?.signal ?? undefined,
        onFirstEvent: (error) => resolveFirst(error ?? true),
        onComplete: () => {},
        onTerminal: (event) => {
          entry.busy = false
          entry.lastUsedAt = now()
          entry.streamFailures = 0
          if (event?.type !== "response.completed" && event?.type !== "response.done") invalidate(entry)
        },
        onConnectionInvalid: () => {
          entry.busy = false
          entry.lastUsedAt = now()
          if (!entry.fallback) recordStreamFailure(entry)
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
      })

      const first = await firstEvent
      if (first !== false) return response
      if (!entry.fallback) return response
      return httpFetch(input, init)
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
