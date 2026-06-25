# codex-lb WebSocket Provider — Design

**Date:** 2026-06-25
**Status:** Approved (user directed full implementation)

## Problem

The current plugin monkey-patches `globalThis.fetch` and rewrites OpenAI/ChatGPT
**HTTP/SSE** Responses traffic to codex-lb by swapping the URL and `Authorization`
header. Symptom reported: "sometimes a message gets no reply and the turn ends on
its own," intermittently.

**Root cause (validated):** codex-lb is a multi-account load balancer. Its models
advertise `prefer_websockets: true`, and codex-lb documents that it "needs WebSocket
for session/account consistency." OpenCode's native `openai` codex path already
streams over a **WebSocket** (one socket pins one upstream account for the whole
conversation). The current plugin downgrades that to stateless HTTP, so the load
balancer can route turns to different accounts, breaking reasoning/session
consistency and surfacing as dropped/empty turns. codex-lb's degraded states (e.g.
`429 account_stream_cap`, "No available accounts") also arrive as WS `error` frames
that the HTTP rewrite path does not surface cleanly.

## Validated facts (probed against the real backend + source)

- `wss://<host>/v1/responses` accepts a WebSocket upgrade with only
  `Authorization: Bearer <sk-clb>` (`openai-beta`/`originator` not required; we still
  default `openai-beta: responses_websockets=2026-02-06` like OpenCode, harmless).
- The WS speaks the OpenAI **Responses** protocol: client sends
  `{type:"response.create", ...body}`; server streams `response.created`,
  `response.in_progress`, `response.output_item.added`, `response.content_part.*`,
  `response.output_text.delta`, `...done`, `response.output_item.done`,
  `response.completed`. A leading vendor frame `codex.rate_limits` may precede it.
- Bun's global `WebSocket` supports `new WebSocket(url, { headers })` + WHATWG events.
  OpenCode runs on Bun. **OpenCode does NOT install a plugin's own `dependencies`**
  (the host runtime only exposes `@opencode-ai/plugin` + bundled modules), so the
  bridge must use `globalThis.WebSocket` and carry **zero runtime deps**. `ws` is a
  dev-only dependency used by tests.
- A custom provider with `npm: "@ai-sdk/openai"` automatically uses the **Responses
  API** and inherits all reasoning handling (effort tiers, `reasoningSummary`,
  `include: reasoning.encrypted_content`, `store:false`, item-id stripping) because
  OpenCode keys those on the npm package, not the provider id.
- `provider.<id>.options.fetch` is honored and forwarded to the AI SDK factory; a
  plugin `config` hook can inject a live function. So the SSE→WS bridge can be
  **provider-scoped** (native `openai` untouched) and **plugin-only** (no source patch).
- Only two `providerID === "openai"` divergences affect a custom provider:
  `promptCacheKey` (mitigate with `setCacheKey: true`) and `headerTimeout: 10000`
  (set explicitly). Everything else is identical.
- Multi-turn reasoning does not depend on server-side `previous_response_id`
  (OpenCode uses `store:false` + encrypted reasoning resent in-band), but the
  encrypted reasoning + account context still require **account stickiness**, which a
  reused per-session socket provides.

## Approach

Replace the global-fetch rewrite with a **custom `codex-lb` provider** the user
selects from the model picker. Switching is "pick `codex-lb/<model>`"; native
`openai` (OAuth) is left fully intact for fallback.

### Modules

- `src/ws-bridge.js` — protocol (adapted from OpenCode `ws.ts`, WHATWG API):
  `toWebSocketUrl`, `connectResponsesWebSocket`, `streamResponsesWebSocket`. Sends
  `{type:"response.create", ...body}` (minus `stream`/`background`); translates each
  text frame to SSE by prefixing lines with `data: `; terminal on
  `response.completed|done|failed|incomplete|error`; turns `type:"error"` frames with
  status outside 200–299 into a thrown API error (so `429 account_stream_cap`
  surfaces); honors abort + idle/connect timeouts; returns a `200 text/event-stream`
  `Response` whose `ReadableStream` is fed translated bytes and closed with
  `data: [DONE]`.
- `src/ws-pool.js` — `createWebSocketFetch` (adapted from `ws-pool.ts`):
  session-keyed pool (`session-id` / `x-session-affinity` header → one socket per
  conversation, reused within `maxConnectionAge`); HTTP passthrough for
  non-`POST`/non-`/responses`/non-streaming/title/busy/fallback; counts stream
  failures and falls back to HTTP after `streamRetries`. `WebSocketImpl` injectable
  (default `globalThis.WebSocket`).
- `index.js` — server plugin. `config` hook registers `provider["codex-lb"]`
  (`npm:@ai-sdk/openai`, `options:{ baseURL, apiKey, setCacheKey:true,
  headerTimeout:10000, fetch: websocketFetch }`, a static model catalog mirroring
  codex-lb's `/v1/models`). `chat.headers` hook injects `session-id` for codex-lb
  requests (enables pool affinity). `dispose` closes sockets; `event(session.deleted)`
  removes that session's socket. Plugin options stay `{ baseURL, apiKey }`.

### Removed

Global fetch router, `/codex-lb` toggle command, sidebar, mode-file persistence,
`@opentui/solid` + `solid-js` deps, `tui.js`.

## Testing & release

- `node --test`: ws-bridge frame→SSE translation, terminal/error handling, abort,
  timeouts; pool routing/affinity/fallback; config-hook provider shape; header
  injection; lifecycle. Tests run against a local **mock codex-lb** WS server.
- End-to-end: drive real `opencode` via **tmux + send-keys** in a temp workspace
  whose `opencode.json` loads the local plugin pointed at the mock backend; verify
  `codex-lb/<model>` appears, a prompt streams a reply, and an injected
  `429 account_stream_cap` surfaces as an error (not a silent end). One optional
  smoke against the real backend when it is not rate-capped.
- **Releases are tagged `vX.Y.Z` matching `package.json`** (no commit-sha installs).
  This rewrite ships as `v0.2.0`.

## Risks

- codex-lb's WS frame protocol could change; the bridge forwards unknown frames
  verbatim (AI SDK tolerates `unknown_chunk`), limiting breakage.
- Static model catalog may drift from codex-lb's `/v1/models`; users can override via
  `provider["codex-lb"].models` in their config.
