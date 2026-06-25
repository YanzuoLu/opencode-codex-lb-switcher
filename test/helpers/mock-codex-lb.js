// A real local stand-in for codex-lb: HTTP GET /v1/models, HTTP POST /v1/responses
// (SSE), and a WebSocket at /v1/responses speaking the OpenAI Responses protocol
// (codex.rate_limits + response.* frames). Injectable failure modes for tests and
// for the tmux end-to-end harness. NOT a mock object — an actual server.
//
// Run standalone:  node test/helpers/mock-codex-lb.js <port> <mode> [reply]
import { createServer } from "node:http"
import { WebSocketServer } from "ws"

function userText(body) {
  const input = body?.input
  if (typeof input === "string") return input
  if (!Array.isArray(input)) return ""
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i]
    if (item?.role !== "user") continue
    const content = item.content
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      const part = content.find((p) => typeof p?.text === "string")
      if (part) return part.text
    }
  }
  return ""
}

function* okFrames(body, reply) {
  const rid = "resp_mock_1"
  const mid = "msg_mock_1"
  const baseResponse = {
    id: rid,
    object: "response",
    status: "in_progress",
    model: body?.model ?? "gpt-5.5",
    output: [],
  }
  yield { type: "codex.rate_limits", plan_type: "pro", rate_limits: { primary: { used_percent: 1 } } }
  yield { type: "response.created", response: { ...baseResponse } }
  yield { type: "response.in_progress", response: { ...baseResponse } }
  yield {
    type: "response.output_item.added",
    output_index: 0,
    sequence_number: 1,
    item: { id: mid, type: "message", status: "in_progress", role: "assistant", content: [] },
  }
  yield {
    type: "response.content_part.added",
    item_id: mid,
    output_index: 0,
    content_index: 0,
    sequence_number: 2,
    part: { type: "output_text", text: "", annotations: [] },
  }
  yield {
    type: "response.output_text.delta",
    item_id: mid,
    output_index: 0,
    content_index: 0,
    sequence_number: 3,
    delta: reply,
  }
  yield {
    type: "response.output_text.done",
    item_id: mid,
    output_index: 0,
    content_index: 0,
    sequence_number: 4,
    text: reply,
  }
  yield {
    type: "response.content_part.done",
    item_id: mid,
    output_index: 0,
    content_index: 0,
    sequence_number: 5,
    part: { type: "output_text", text: reply, annotations: [] },
  }
  yield {
    type: "response.output_item.done",
    output_index: 0,
    sequence_number: 6,
    item: {
      id: mid,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: reply, annotations: [] }],
    },
  }
  yield {
    type: "response.completed",
    sequence_number: 7,
    response: {
      ...baseResponse,
      status: "completed",
      output: [
        { id: mid, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: reply, annotations: [] }] },
      ],
      usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
    },
  }
}

function errorFrame() {
  return {
    type: "error",
    status: 429,
    error: {
      message: "No available accounts. Service is operating in degraded mode: all upstream accounts are unavailable",
      type: "rate_limit_error",
      code: "account_stream_cap",
    },
  }
}

const MODELS = {
  object: "list",
  data: [
    { id: "gpt-5.5", object: "model", owned_by: "codex-lb" },
    { id: "gpt-5.4", object: "model", owned_by: "codex-lb" },
    { id: "gpt-5.4-mini", object: "model", owned_by: "codex-lb" },
  ],
}

export function startMockCodexLb({ port = 0, mode = "ok", reply = "OK" } = {}) {
  const connections = new Set()
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(MODELS))
      return
    }
    if (req.method === "POST" && req.url.startsWith("/v1/responses")) {
      // HTTP/SSE fallback path
      let raw = ""
      req.on("data", (c) => (raw += c))
      req.on("end", () => {
        const body = (() => {
          try {
            return JSON.parse(raw)
          } catch {
            return {}
          }
        })()
        if (mode === "error429") {
          res.writeHead(429, { "content-type": "application/json" })
          res.end(JSON.stringify(errorFrame()))
          return
        }
        res.writeHead(200, { "content-type": "text/event-stream" })
        for (const frame of okFrames(body, reply)) res.write(`data: ${JSON.stringify(frame)}\n\n`)
        res.write("data: [DONE]\n\n")
        res.end()
      })
      return
    }
    res.writeHead(404)
    res.end("not found")
  })

  const wss = new WebSocketServer({ server, path: "/v1/responses" })
  wss.on("connection", (socket, req) => {
    connections.add(socket)
    socket.on("close", () => connections.delete(socket))
    socket.authHeader = req.headers["authorization"] ?? ""
    socket.betaHeader = req.headers["openai-beta"] ?? ""
    socket.on("message", (data) => {
      const body = (() => {
        try {
          return JSON.parse(data.toString())
        } catch {
          return {}
        }
      })()
      if (body?.type !== "response.create") return
      if (mode === "hang") return
      if (mode === "error429") {
        socket.send(JSON.stringify(errorFrame()))
        return
      }
      if (mode === "closeEarly") {
        socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_mock_1", object: "response", status: "in_progress" } }))
        setTimeout(() => socket.terminate(), 20)
        return
      }
      for (const frame of okFrames(body, reply)) socket.send(JSON.stringify(frame))
    })
  })

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port
      resolve({
        port: actual,
        httpUrl: `http://127.0.0.1:${actual}`,
        wsUrl: `ws://127.0.0.1:${actual}/v1/responses`,
        responsesUrl: `http://127.0.0.1:${actual}/v1/responses`,
        connectionCount: () => connections.size,
        async close() {
          for (const s of connections) s.terminate()
          wss.close()
          await new Promise((r) => server.close(r))
        },
      })
    })
  })
}

// Standalone entrypoint for the tmux harness.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8499)
  const mode = process.argv[3] ?? "ok"
  const reply = process.argv[4] ?? process.env.MOCK_REPLY ?? "OK"
  startMockCodexLb({ port, mode, reply }).then((s) => {
    console.log(`mock-codex-lb listening http=${s.httpUrl} ws=${s.wsUrl} mode=${mode} reply=${JSON.stringify(reply)}`)
  })
}
