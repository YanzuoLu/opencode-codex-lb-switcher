import test from "node:test"
import assert from "node:assert/strict"
import WebSocket from "ws"

import { createWebSocketFetch } from "../src/ws-pool.js"
import { startMockCodexLb } from "./helpers/mock-codex-lb.js"

async function readAll(res) {
  return await res.text()
}

function streamingInit(sessionID, extra = {}) {
  return {
    method: "POST",
    headers: { authorization: "Bearer test", ...(sessionID ? { "session-id": sessionID } : {}), ...extra.headers },
    body: JSON.stringify({ model: "gpt-5.5", input: "hi", stream: true }),
  }
}

test("routes a streaming /responses POST over WebSocket and streams the reply", async () => {
  const mock = await startMockCodexLb({ mode: "ok", reply: "PONG" })
  const wsFetch = createWebSocketFetch({ WebSocketImpl: WebSocket, httpFetch: async () => new Response("HTTP") })
  try {
    const res = await wsFetch(mock.responsesUrl, streamingInit("ses1"))
    const text = await readAll(res)
    assert.equal(res.headers.get("content-type"), "text/event-stream")
    assert.match(text, /"delta":"PONG"/)
    assert.ok(text.trim().endsWith("data: [DONE]"))
    assert.equal(mock.connectionCount(), 1)
  } finally {
    wsFetch.close()
    await mock.close()
  }
})

test("passes non-streaming requests through to httpFetch unchanged", async () => {
  const mock = await startMockCodexLb({ mode: "ok" })
  const calls = []
  const wsFetch = createWebSocketFetch({
    WebSocketImpl: WebSocket,
    httpFetch: async (input, init) => {
      calls.push({ input, init })
      return new Response("HTTP-PASSTHROUGH", { status: 200 })
    },
  })
  try {
    const init = { method: "POST", headers: { "session-id": "ses1" }, body: JSON.stringify({ model: "gpt-5.5", input: "hi" }) }
    const res = await wsFetch(mock.responsesUrl, init)
    assert.equal(await readAll(res), "HTTP-PASSTHROUGH")
    assert.equal(calls.length, 1)
    assert.equal(mock.connectionCount(), 0)
  } finally {
    wsFetch.close()
    await mock.close()
  }
})

test("passes through when no session-id header is present", async () => {
  const mock = await startMockCodexLb({ mode: "ok" })
  const calls = []
  const wsFetch = createWebSocketFetch({
    WebSocketImpl: WebSocket,
    httpFetch: async (input, init) => {
      calls.push({ input, init })
      return new Response("HTTP")
    },
  })
  try {
    await wsFetch(mock.responsesUrl, streamingInit(undefined))
    assert.equal(calls.length, 1)
    assert.equal(mock.connectionCount(), 0)
  } finally {
    wsFetch.close()
    await mock.close()
  }
})

test("reuses one socket across turns with the same session-id", async () => {
  const mock = await startMockCodexLb({ mode: "ok", reply: "OK" })
  const wsFetch = createWebSocketFetch({ WebSocketImpl: WebSocket, httpFetch: async () => new Response("HTTP") })
  try {
    await readAll(await wsFetch(mock.responsesUrl, streamingInit("sesX")))
    await readAll(await wsFetch(mock.responsesUrl, streamingInit("sesX")))
    assert.equal(mock.connectionCount(), 1)
    assert.equal(mock.totalConnections(), 1)
  } finally {
    wsFetch.close()
    await mock.close()
  }
})

test("retries once on a pre-event 1001 close and succeeds on a fresh socket", async () => {
  const mock = await startMockCodexLb({ mode: "close1001Idle", reply: "RETRY-OK" })
  const wsFetch = createWebSocketFetch({ WebSocketImpl: WebSocket, httpFetch: async () => new Response("HTTP") })
  try {
    const res = await wsFetch(mock.responsesUrl, streamingInit("sesR"))
    const text = await readAll(res)
    assert.match(text, /"delta":"RETRY-OK"/)
    assert.ok(text.trim().endsWith("data: [DONE]"))
    assert.equal(mock.totalConnections(), 2)
    assert.equal(mock.lastPayload().model, "gpt-5.5")
  } finally {
    wsFetch.close()
    await mock.close()
  }
})

test("retries once on a pre-event 1006 abnormal close and succeeds on a fresh socket", async () => {
  const mock = await startMockCodexLb({ mode: "terminate1006Idle", reply: "RETRY-1006" })
  const wsFetch = createWebSocketFetch({ WebSocketImpl: WebSocket, httpFetch: async () => new Response("HTTP") })
  try {
    const res = await wsFetch(mock.responsesUrl, streamingInit("ses6"))
    const text = await readAll(res)
    assert.match(text, /"delta":"RETRY-1006"/)
    assert.ok(text.trim().endsWith("data: [DONE]"))
    assert.equal(mock.totalConnections(), 2)
  } finally {
    wsFetch.close()
    await mock.close()
  }
})

test("pre-event retry is not counted as a stream failure (streamRetries: 0)", async () => {
  const mock = await startMockCodexLb({ mode: "close1001Idle", reply: "OK" })
  const wsFetch = createWebSocketFetch({
    WebSocketImpl: WebSocket,
    streamRetries: 0,
    httpFetch: async () => new Response("HTTP-FALLBACK"),
  })
  try {
    // Turn 1: pre-event 1001 close → single retry succeeds over WebSocket.
    const t1 = await readAll(await wsFetch(mock.responsesUrl, streamingInit("sesZ")))
    assert.match(t1, /"delta":"OK"/)
    // If the retry had been mis-counted, streamRetries: 0 would flip the entry to
    // fallback and this turn would return the HTTP passthrough instead.
    const t2 = await readAll(await wsFetch(mock.responsesUrl, streamingInit("sesZ")))
    assert.match(t2, /"delta":"OK"/)
  } finally {
    wsFetch.close()
    await mock.close()
  }
})

test("treats a pre-event 1000 close as terminal and does not retry", async () => {
  const mock = await startMockCodexLb({ mode: "close1000PreEvent" })
  const wsFetch = createWebSocketFetch({ WebSocketImpl: WebSocket, httpFetch: async () => new Response("HTTP") })
  try {
    const res = await wsFetch(mock.responsesUrl, streamingInit("sesT"))
    await assert.rejects(() => res.text(), /closed before response\.completed \(code 1000, reason "clean close", no events/)
    assert.equal(mock.totalConnections(), 1)
  } finally {
    wsFetch.close()
    await mock.close()
  }
})

test("mid-stream clean close after the first event errors the stream without retry", async () => {
  const mock = await startMockCodexLb({ mode: "closeEarlyClean" })
  const wsFetch = createWebSocketFetch({ WebSocketImpl: WebSocket, httpFetch: async () => new Response("HTTP") })
  try {
    const res = await wsFetch(mock.responsesUrl, streamingInit("sesM"))
    await assert.rejects(() => res.text(), /closed before response\.completed/)
    assert.equal(mock.totalConnections(), 1)
  } finally {
    wsFetch.close()
    await mock.close()
  }
})

test("wrapped upstream error becomes a real HTTP response with the original status", async () => {
  const mock = await startMockCodexLb({ mode: "ok", reply: "OK" })
  const wsFetch = createWebSocketFetch({ WebSocketImpl: WebSocket, httpFetch: async () => new Response("HTTP") })
  try {
    await readAll(await wsFetch(mock.responsesUrl, streamingInit("sesE")))
    mock.setMode("error429")
    const res = await wsFetch(mock.responsesUrl, streamingInit("sesE"))
    assert.equal(res.status, 429)
    assert.match(await res.text(), /account_stream_cap/)
    mock.setMode("ok")
    const text = await readAll(await wsFetch(mock.responsesUrl, streamingInit("sesE")))
    assert.match(text, /"delta":"OK"/)
  } finally {
    wsFetch.close()
    await mock.close()
  }
})

test("idle watcher drops a pooled socket the server closed and the next turn reconnects", async () => {
  const mock = await startMockCodexLb({ mode: "closeAfterComplete", reply: "OK" })
  const wsFetch = createWebSocketFetch({ WebSocketImpl: WebSocket, httpFetch: async () => new Response("HTTP") })
  try {
    const t1 = await readAll(await wsFetch(mock.responsesUrl, streamingInit("sesW")))
    assert.match(t1, /"delta":"OK"/)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(mock.connectionCount(), 0)
    const t2 = await readAll(await wsFetch(mock.responsesUrl, streamingInit("sesW")))
    assert.match(t2, /"delta":"OK"/)
    assert.equal(mock.totalConnections(), 2)
  } finally {
    wsFetch.close()
    await mock.close()
  }
})

test("cancelling a stream frees the session so the next turn still works", async () => {
  const mock = await startMockCodexLb({ mode: "ok", reply: "OK" })
  const wsFetch = createWebSocketFetch({ WebSocketImpl: WebSocket, httpFetch: async () => new Response("HTTP") })
  try {
    const res = await wsFetch(mock.responsesUrl, streamingInit("sesC"))
    await res.body.cancel()
    const text = await readAll(await wsFetch(mock.responsesUrl, streamingInit("sesC")))
    assert.match(text, /"delta":"OK"/)
  } finally {
    wsFetch.close()
    await mock.close()
  }
})
