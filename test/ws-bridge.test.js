import test from "node:test"
import assert from "node:assert/strict"
import WebSocket from "ws"

import { connectResponsesWebSocket, streamResponsesWebSocket, toWebSocketUrl } from "../src/ws-bridge.js"
import { startMockCodexLb } from "./helpers/mock-codex-lb.js"

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
