import test from "node:test"
import assert from "node:assert/strict"
import WebSocket from "ws"

import { connectResponsesWebSocket, isAbortError, streamResponsesWebSocket, toWebSocketUrl } from "../src/ws-bridge.js"
import { startMockCodexLb } from "./helpers/mock-codex-lb.js"

// Minimal WHATWG-ish WebSocket test double for driving the bridge deterministically.
function fakeSocket() {
  const listeners = new Map()
  const socket = {
    readyState: 1,
    sent: [],
    closed: [],
    addEventListener(type, fn, opts) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push({ fn, once: !!opts?.once })
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type)
      if (!arr) return
      const i = arr.findIndex((l) => l.fn === fn)
      if (i >= 0) arr.splice(i, 1)
    },
    send(data) {
      socket.sent.push(data)
    },
    close(code, reason) {
      socket.closed.push({ code, reason })
    },
    emit(type, event) {
      for (const l of [...(listeners.get(type) ?? [])]) {
        if (l.once) socket.removeEventListener(type, l.fn)
        l.fn(event)
      }
    },
  }
  return socket
}

const BODY = { model: "gpt-5.5", input: "hi", stream: true }

async function readAll(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}

test("toWebSocketUrl maps http to ws and https to wss, preserving host/path/query", () => {
  assert.equal(toWebSocketUrl("https://coding-agent-api.mvp-lab.ai/v1/responses"), "wss://coding-agent-api.mvp-lab.ai/v1/responses")
  assert.equal(toWebSocketUrl("http://127.0.0.1:2455/v1/responses?x=1"), "ws://127.0.0.1:2455/v1/responses?x=1")
})

test("streamResponsesWebSocket relays Responses frames as SSE and ends with [DONE]", async () => {
  const mock = await startMockCodexLb({ mode: "ok", reply: "OK" })
  try {
    const socket = await connectResponsesWebSocket({
      url: mock.wsUrl,
      headers: { authorization: "Bearer test" },
      WebSocketImpl: WebSocket,
    })
    const res = streamResponsesWebSocket({ socket, body: { model: "gpt-5.5", input: "hi", stream: true } })

    assert.equal(res.status, 200)
    assert.equal(res.headers.get("content-type"), "text/event-stream")
    const text = await readAll(res.body)
    assert.match(text, /data: \{"type":"response\.output_text\.delta".*"delta":"OK"/)
    assert.match(text, /data: \{"type":"response\.completed"/)
    assert.ok(text.trim().endsWith("data: [DONE]"))
  } finally {
    await mock.close()
  }
})

test("streamResponsesWebSocket surfaces a 429 error frame as a stream error", async () => {
  const mock = await startMockCodexLb({ mode: "error429" })
  try {
    const socket = await connectResponsesWebSocket({ url: mock.wsUrl, headers: {}, WebSocketImpl: WebSocket })
    const res = streamResponsesWebSocket({ socket, body: { model: "gpt-5.5", input: "hi", stream: true } })
    await assert.rejects(() => readAll(res.body), /account_stream_cap|degraded|429/)
  } finally {
    await mock.close()
  }
})

test("close before the first event yields a structured error with full diagnostics", async () => {
  const socket = fakeSocket()
  let invalid
  const res = streamResponsesWebSocket({ socket, body: BODY, onConnectionInvalid: (e) => (invalid = e) })
  socket.emit("close", { code: 1006, reason: "" })
  await assert.rejects(
    () => readAll(res.body),
    /closed before response\.completed \(code 1006, reason "", no events, \d+ms elapsed\)/,
  )
  assert.equal(invalid.code, "WS_CLOSED")
  assert.equal(invalid.closeCode, 1006)
  assert.equal(invalid.closeReason, "")
  assert.equal(invalid.emitted, false)
  assert.equal(typeof invalid.elapsedMs, "number")
  assert.ok(invalid.elapsedMs >= 0)
})

test("mid-stream close carries closeReason, elapsedMs and emitted diagnostics", async () => {
  const socket = fakeSocket()
  let invalid
  const res = streamResponsesWebSocket({ socket, body: BODY, onConnectionInvalid: (e) => (invalid = e) })
  socket.emit("message", { data: JSON.stringify({ type: "response.created", response: { status: "in_progress" } }) })
  socket.emit("close", { code: 1011, reason: "server restart" })
  await assert.rejects(
    () => readAll(res.body),
    /closed before response\.completed \(code 1011, reason "server restart", after first event, \d+ms elapsed\)/,
  )
  assert.equal(invalid.closeCode, 1011)
  assert.equal(invalid.closeReason, "server restart")
  assert.equal(invalid.emitted, true)
  assert.ok(invalid.elapsedMs >= 0)
})

test("wrapped error frames report status/body to onFirstEvent and error with status", async () => {
  const socket = fakeSocket()
  let first
  let terminal
  const res = streamResponsesWebSocket({
    socket,
    body: BODY,
    onFirstEvent: (w) => (first = w),
    onTerminal: (e) => (terminal = e),
  })
  const frame = JSON.stringify({ type: "error", status: 429, error: { message: "no accounts" } })
  socket.emit("message", { data: frame })
  await assert.rejects(() => readAll(res.body), (e) => e.message === "no accounts" && e.status === 429)
  assert.equal(first.status, 429)
  assert.equal(first.body, frame)
  assert.equal(terminal.type, "error")
})

test("abort closes the socket with 4000 and rejects with an AbortError", async () => {
  const socket = fakeSocket()
  const ac = new AbortController()
  let aborted
  const res = streamResponsesWebSocket({ socket, body: BODY, signal: ac.signal, onAbort: (e) => (aborted = e) })
  ac.abort()
  await assert.rejects(() => readAll(res.body), (e) => isAbortError(e))
  assert.equal(socket.closed[0].code, 4000)
  assert.ok(isAbortError(aborted))
})

test("cancel closes the socket with 4001 and fires onCancel", async () => {
  const socket = fakeSocket()
  let cancelled = false
  const res = streamResponsesWebSocket({ socket, body: BODY, onCancel: () => (cancelled = true) })
  await res.body.cancel()
  assert.equal(socket.closed[0].code, 4001)
  assert.equal(cancelled, true)
})

test("completion detaches the abort listener so a late abort does not close the socket", async () => {
  const socket = fakeSocket()
  const ac = new AbortController()
  let aborted = false
  const res = streamResponsesWebSocket({ socket, body: BODY, signal: ac.signal, onAbort: () => (aborted = true) })
  socket.emit("message", { data: JSON.stringify({ type: "response.completed", response: { status: "completed" } }) })
  const text = await readAll(res.body)
  assert.match(text, /response\.completed/)
  assert.ok(text.trim().endsWith("data: [DONE]"))
  ac.abort()
  assert.equal(socket.closed.length, 0)
  assert.equal(aborted, false)
})

test("inactivityTimeout invalidates the stream with WS_INACTIVITY", async () => {
  const socket = fakeSocket()
  let invalid
  const res = streamResponsesWebSocket({ socket, body: BODY, inactivityTimeout: 20, onConnectionInvalid: (e) => (invalid = e) })
  await assert.rejects(() => readAll(res.body), /inactivity timeout .+ \(no events, \d+ms elapsed\)/)
  assert.equal(invalid.code, "WS_INACTIVITY")
  assert.equal(invalid.emitted, false)
  assert.equal(typeof invalid.elapsedMs, "number")
})

test("send strips stream/background flags and frames the payload as response.create", async () => {
  const socket = fakeSocket()
  streamResponsesWebSocket({ socket, body: { ...BODY, background: true } })
  const sent = JSON.parse(socket.sent[0])
  assert.equal(sent.type, "response.create")
  assert.equal(sent.model, "gpt-5.5")
  assert.equal("stream" in sent, false)
  assert.equal("background" in sent, false)
})
