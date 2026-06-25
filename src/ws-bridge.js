// codex-lb WebSocket bridge: speaks the OpenAI Responses-over-WebSocket protocol
// and exposes it to the AI SDK as a normal streaming fetch Response.
//
// Adapted from OpenCode's packages/opencode/src/plugin/openai/ws.ts, rewritten
// against the WHATWG WebSocket API (globalThis.WebSocket) so it runs on Bun with
// zero runtime dependencies. The WebSocket constructor is injectable for tests.

const PROTOCOL_HEADER = "responses_websockets=2026-02-06"
const OPEN = 1
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
          reject(new Error("WebSocket connect timed out"))
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
      reject(new Error(`WebSocket closed before open (code ${event?.code ?? "?"})`))
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
// a 200 text/event-stream Response. Callbacks let the pool observe lifecycle.
export function streamResponsesWebSocket({
  socket,
  body,
  idleTimeout,
  signal,
  onFirstEvent,
  onComplete,
  onTerminal,
  onConnectionInvalid,
  onAbort,
  onRetryableTerminal,
}) {
  let controller
  let completed = false
  let emitted = false
  let idleTimer

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = undefined
  }
  function resetIdle(message) {
    if (completed || !idleTimeout) return
    clearIdle()
    idleTimer = setTimeout(() => invalidate(new Error(message)), idleTimeout)
  }
  function detach() {
    clearIdle()
    socket.removeEventListener?.("message", onMessage)
    socket.removeEventListener?.("error", onError)
    socket.removeEventListener?.("close", onClose)
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
        controller?.error(new Error(wrapped.message))
      } catch {}
      return
    }

    if (!emitted) onFirstEvent?.()
    emitted = true
    enqueueFrame(text)
    resetIdle("idle timeout waiting for websocket")

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
    invalidate(event?.error instanceof Error ? event.error : new Error(event?.message ?? "WebSocket error"))
  }
  function onClose(event) {
    if (completed) return
    invalidate(new Error(`WebSocket closed before response.completed (code ${event?.code ?? "?"})`))
  }
  function handleAbort() {
    if (completed) return
    completed = true
    detach()
    try {
      socket.close()
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
    resetIdle("idle timeout sending websocket request")
    socket.send(JSON.stringify({ type: "response.create", ...payload }))
    resetIdle("idle timeout waiting for websocket")
  }

  // expose retryable handler hook for the pool (unused in the base path)
  void onRetryableTerminal

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
          invalidate(new Error("WebSocket is not open"))
          return
        }
        attach()
      },
      cancel() {
        if (completed) return
        completed = true
        detach()
        try {
          socket.close()
        } catch {}
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}
