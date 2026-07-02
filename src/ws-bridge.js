// codex-lb WebSocket bridge: speaks the OpenAI Responses-over-WebSocket protocol
// and exposes it to the AI SDK as a normal streaming fetch Response.
//
// Adapted from OpenCode's packages/opencode/src/plugin/openai/ws.ts, rewritten
// against the WHATWG WebSocket API (globalThis.WebSocket) so it runs on Bun with
// zero runtime dependencies. The WebSocket constructor is injectable for tests.
//
// Client-initiated closes use application close codes:
//   4000 client abort (request signal aborted)
//   4001 client cancel (response body stream cancelled)

const PROTOCOL_HEADER = "responses_websockets=2026-02-06"
const OPEN = 1
const CLOSE_CODE_ABORT = 4000
const CLOSE_CODE_CANCEL = 4001
const encoder = new TextEncoder()

export function toWebSocketUrl(url) {
  return url.replace(/^http/, "ws")
}

export function frameToString(data) {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data)
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return data.toString("utf8")
  return String(data)
}

function abortError(signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  return new DOMException("The operation was aborted.", "AbortError")
}

export function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError"
}

// Structured diagnostic error: `code` identifies the failure class, extra fields
// (closeCode, closeReason, wasClean, status, emitted, elapsedMs) let the pool make
// retry decisions and make logs distinguish pre-first-event from mid-stream deaths.
function streamError(message, info) {
  return Object.assign(new Error(message), info)
}

export function connectResponsesWebSocket({ url, headers = {}, timeout, signal, WebSocketImpl = globalThis.WebSocket }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const finalHeaders = { ...headers }
    if (!finalHeaders["openai-beta"]) finalHeaders["openai-beta"] = PROTOCOL_HEADER
    delete finalHeaders["content-length"]

    const socket = new WebSocketImpl(toWebSocketUrl(url), { headers: finalHeaders })
    const timer = timeout
      ? setTimeout(() => {
          cleanup()
          try {
            socket.close()
          } catch {}
          reject(streamError("WebSocket connect timed out", { code: "WS_CONNECT_TIMEOUT" }))
        }, timeout)
      : undefined

    function cleanup() {
      if (timer) clearTimeout(timer)
      socket.removeEventListener?.("open", onOpen)
      socket.removeEventListener?.("error", onError)
      socket.removeEventListener?.("close", onClose)
      signal?.removeEventListener("abort", onAbort)
    }
    function onOpen() {
      cleanup()
      resolve(socket)
    }
    function onError(event) {
      cleanup()
      const message = event?.message ?? event?.error?.message ?? "WebSocket error"
      reject(event?.error instanceof Error ? event.error : new Error(message))
    }
    function onClose(event) {
      cleanup()
      const reason = event?.reason ?? ""
      reject(
        streamError(`WebSocket closed before open (code ${event?.code ?? "?"}, reason ${JSON.stringify(reason)})`, {
          code: "WS_CLOSED",
          closeCode: event?.code,
          closeReason: reason,
        }),
      )
    }
    function onAbort() {
      cleanup()
      try {
        socket.close()
      } catch {}
      reject(abortError(signal))
    }
    socket.addEventListener("open", onOpen, { once: true })
    socket.addEventListener("error", onError, { once: true })
    socket.addEventListener("close", onClose, { once: true })
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function parseWrappedError(event, body) {
  if (event?.type !== "error") return undefined
  const status = event.status ?? event.status_code
  if (typeof status !== "number" || (status >= 200 && status < 300)) return undefined
  const message =
    (event.error && typeof event.error.message === "string" && event.error.message) ||
    (typeof event.message === "string" && event.message) ||
    `${status}`
  return { status, body, message }
}

// Streams an OpenAI Responses turn over an already-connected WebSocket and returns
// a 200 text/event-stream Response. Callbacks let the pool observe lifecycle:
//   onFirstEvent(wrapped?)  first frame arrived (wrapped error object if it was one)
//   onComplete(event)       response.completed / response.done
//   onTerminal(event)       any terminal frame (completed/failed/incomplete/error)
//   onConnectionInvalid(e)  socket died mid-turn (structured error with closeCode)
//   onAbort(e)              request signal aborted (socket closed 4000)
//   onCancel()              response body cancelled by the reader (socket closed 4001)
export function streamResponsesWebSocket({
  socket,
  body,
  inactivityTimeout,
  signal,
  onFirstEvent,
  onComplete,
  onTerminal,
  onConnectionInvalid,
  onAbort,
  onCancel,
}) {
  let controller
  let completed = false
  let emitted = false
  let inactivityTimer
  let startedAt

  // Progress diagnostics shared by all stream-phase errors: how long the turn has
  // been running and whether any frame arrived (pre-first-event vs mid-stream).
  function progressInfo() {
    const elapsedMs = startedAt === undefined ? undefined : Date.now() - startedAt
    const parts = [emitted ? "after first event" : "no events"]
    if (elapsedMs !== undefined) parts.push(`${elapsedMs}ms elapsed`)
    return { emitted, elapsedMs, text: parts.join(", ") }
  }

  function clearInactivity() {
    if (inactivityTimer) clearTimeout(inactivityTimer)
    inactivityTimer = undefined
  }
  function resetInactivity(message) {
    if (completed || !inactivityTimeout) return
    clearInactivity()
    inactivityTimer = setTimeout(() => {
      const progress = progressInfo()
      invalidate(
        streamError(`${message} (${progress.text})`, {
          code: "WS_INACTIVITY",
          emitted: progress.emitted,
          elapsedMs: progress.elapsedMs,
        }),
      )
    }, inactivityTimeout)
  }
  function detach() {
    clearInactivity()
    socket.removeEventListener?.("message", onMessage)
    socket.removeEventListener?.("error", onError)
    socket.removeEventListener?.("close", onClose)
    signal?.removeEventListener("abort", handleAbort)
  }
  function invalidate(error) {
    if (completed) return
    completed = true
    detach()
    onConnectionInvalid?.(error)
    try {
      controller?.error(error)
    } catch {}
  }
  function closeCompleted() {
    detach()
    try {
      controller?.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller?.close()
    } catch {}
  }
  function enqueueFrame(text) {
    controller?.enqueue(encoder.encode(`${text.split(/\r?\n/).map((line) => `data: ${line}`).join("\n")}\n\n`))
  }

  function onMessage(event) {
    if (completed) return
    const text = frameToString(event.data)
    const parsed = (() => {
      try {
        const value = JSON.parse(text)
        return typeof value === "object" && value !== null ? value : undefined
      } catch {
        return undefined
      }
    })()

    const wrapped = parseWrappedError(parsed, text)
    if (wrapped) {
      if (!emitted) onFirstEvent?.(wrapped)
      completed = true
      detach()
      onTerminal?.(parsed)
      try {
        controller?.error(streamError(wrapped.message, { code: "WS_UPSTREAM_ERROR", status: wrapped.status }))
      } catch {}
      return
    }

    if (!emitted) onFirstEvent?.()
    emitted = true
    enqueueFrame(text)
    resetInactivity("inactivity timeout waiting for websocket frames")

    if (!parsed) return
    if (parsed.type === "response.completed" || parsed.type === "response.done") {
      completed = true
      onComplete?.(parsed)
      onTerminal?.(parsed)
      closeCompleted()
      return
    }
    if (parsed.type === "response.failed" || parsed.type === "response.incomplete" || parsed.type === "error") {
      completed = true
      onTerminal?.(parsed)
      closeCompleted()
    }
  }
  function onError(event) {
    const error = event?.error instanceof Error ? event.error : new Error(event?.message ?? "WebSocket error")
    if (error.code === undefined) error.code = "WS_ERROR"
    const progress = progressInfo()
    error.message = `${error.message} (${progress.text})`
    error.emitted = progress.emitted
    error.elapsedMs = progress.elapsedMs
    invalidate(error)
  }
  function onClose(event) {
    if (completed) return
    const reason = event?.reason ?? ""
    const progress = progressInfo()
    invalidate(
      streamError(
        `WebSocket closed before response.completed (code ${event?.code ?? "?"}, reason ${JSON.stringify(reason)}, ${progress.text})`,
        {
          code: "WS_CLOSED",
          closeCode: event?.code,
          closeReason: reason,
          wasClean: event?.wasClean,
          emitted: progress.emitted,
          elapsedMs: progress.elapsedMs,
        },
      ),
    )
  }
  function handleAbort() {
    if (completed) return
    completed = true
    detach()
    try {
      socket.close(CLOSE_CODE_ABORT, "client abort")
    } catch {}
    const error = abortError(signal)
    onAbort?.(error)
    try {
      controller?.error(error)
    } catch {}
  }
  function attach() {
    socket.addEventListener("message", onMessage)
    socket.addEventListener("error", onError, { once: true })
    socket.addEventListener("close", onClose, { once: true })
    const { stream: _stream, background: _background, ...payload } = body ?? {}
    startedAt = Date.now()
    resetInactivity("inactivity timeout sending websocket request")
    socket.send(JSON.stringify({ type: "response.create", ...payload }))
    resetInactivity("inactivity timeout waiting for websocket frames")
  }

  return new Response(
    new ReadableStream({
      start(next) {
        controller = next
        if (signal?.aborted) {
          handleAbort()
          return
        }
        signal?.addEventListener("abort", handleAbort, { once: true })
        if (socket.readyState !== OPEN) {
          invalidate(streamError("WebSocket is not open", { code: "WS_NOT_OPEN" }))
          return
        }
        attach()
      },
      cancel() {
        if (completed) return
        completed = true
        detach()
        try {
          socket.close(CLOSE_CODE_CANCEL, "client cancel")
        } catch {}
        onCancel?.()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}
