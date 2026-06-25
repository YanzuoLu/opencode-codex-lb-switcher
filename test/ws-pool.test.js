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
  } finally {
    wsFetch.close()
    await mock.close()
  }
})
