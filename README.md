# opencode-codex-lb-switcher

An OpenCode plugin that adds a **`codex-lb` provider** which routes the OpenAI
**Responses API over codex-lb's WebSocket transport**. One WebSocket per
conversation keeps codex-lb pinned to a single upstream account for the whole
turn-sequence — the session/account consistency the load balancer needs — so long
turns stop dropping silently.

You switch to it by picking `codex-lb/<model>` in the model picker. Your native
`openai` provider (OAuth) is left completely untouched.

> **v0.2.0 is a rewrite.** Earlier versions toggled a global `fetch` rewrite with a
> `/codex-lb` command. That sent Responses traffic over stateless HTTP, so the load
> balancer could route turns to different accounts and a turn would sometimes end
> with no reply. See [Migrating from 0.1.x](#migrating-from-01x).

## Why WebSocket

codex-lb's models advertise `prefer_websockets: true`, and codex-lb documents that
it "needs WebSocket for session/account consistency". OpenCode's built-in `openai`
codex path already streams over a WebSocket. This plugin gives a dedicated `codex-lb`
provider the same treatment: it reuses OpenCode's built-in `@ai-sdk/openai`
**Responses** code path (so reasoning / `encrypted_content` behave exactly like native
OpenAI) and upgrades each streaming Responses request to a `wss://…/v1/responses`
WebSocket via a provider-scoped `fetch`. Nothing else in OpenCode is patched.

## Install

Add the plugin to `opencode.json` (server plugin), pinned to a **version tag**:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-codex-lb-switcher@git+https://github.com/YanzuoLu/opencode-codex-lb-switcher.git#v0.2.0",
      {
        "baseURL": "https://your-codex-lb-host/v1",
        "apiKey": "{env:CODEX_LB_API_KEY}"
      }
    ]
  ]
}
```

- `baseURL` is your codex-lb `/v1` endpoint. The plugin opens `wss://…/v1/responses`
  (derived from `baseURL`).
- `apiKey` is a codex-lb key (`sk-clb-…`), sent as a plain `Authorization: Bearer`.
- No `tui.json` entry is needed — this version has no TUI command or sidebar.
- No runtime dependencies and no build step. OpenCode loads the plugin's `index.js`
  and `src/` directly. Restart OpenCode after changing config.

Use a version tag (`#v0.2.0`), not a commit SHA, so upgrades are a one-line bump.

## Usage

Open the model picker and choose a `codex-lb/<model>` (shown as **Codex-LB**), e.g.
`codex-lb/gpt-5.5`. That conversation now runs over codex-lb's WebSocket. Pick a
native `openai/…` model to switch back. There is no command and nothing is added to
your conversation context.

## Models

The plugin registers a default catalog (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`,
`gpt-5.3-codex-spark`) as reasoning models. Override or extend it by declaring
`provider["codex-lb"].models` in your `opencode.json`, or pass a `models` object in
the plugin options.

## How it works

- **Provider registration** (`config` hook): registers `provider["codex-lb"]` with
  `npm: "@ai-sdk/openai"` and `options` `{ baseURL, apiKey, setCacheKey: true,
  headerTimeout: 10000, fetch }`. Using the `@ai-sdk/openai` package means OpenCode
  drives it through the **Responses API** with full reasoning handling, identical to
  native `openai`. `setCacheKey`/`headerTimeout` restore the only two behaviors
  OpenCode otherwise reserves for the literal provider id `openai`.
- **WebSocket transport** (`src/ws-bridge.js` + `src/ws-pool.js`, the provider's
  `fetch`): a streaming Responses POST is upgraded to a `wss://…/v1/responses`
  WebSocket. It sends `{ "type": "response.create", … }` and translates the
  `response.*` frames back into the SSE stream the AI SDK expects. A session-keyed
  pool (via a `session-id` header injected by the `chat.headers` hook) reuses one
  socket per conversation — the account-stickiness property. Non-streaming or
  non-`/responses` requests pass through over plain HTTP.
- **Fail-closed errors**: codex-lb degraded states (e.g. `429 account_stream_cap`,
  "No available accounts") arrive as WebSocket `error` frames and are surfaced as a
  real error in OpenCode instead of a silent, empty turn.
- **Lifecycle**: while a turn is streaming, the bridge owns the socket; between
  turns ownership hands back to a pool watcher that drops the pooled socket if the
  server closes it, so the next turn transparently reconnects. Idle sockets are
  pruned after 90s (`poolIdleTimeout`); a running stream that receives no frames
  for 5 minutes is invalidated (`streamInactivityTimeout`). If the server closes
  the socket cleanly before the first event of a turn (close code 1001/1005/1006),
  the turn is retried once on a fresh socket without counting as a stream failure;
  a pre-event 1000 close is terminal and never retried. Upstream error frames that
  carry an HTTP status (e.g. `429 account_stream_cap`) are returned as a real HTTP
  response with that status. Client-initiated closes use application close codes:
  4000 (request aborted), 4001 (stream cancelled), 4002 (pool invalidate). Sockets
  are closed on `dispose` and dropped per session on `session.deleted`.

## Migrating from 0.1.x

- Replace the old plugin entry (and its commit-SHA pin) with the `#v0.2.0` entry
  above.
- **Remove** the `opencode-codex-lb-switcher` entry from `tui.json` — it is no longer
  a TUI plugin.
- There is no `/codex-lb` command, sidebar, or per-workspace mode file anymore.
  Switching is done by selecting `codex-lb/<model>` in the model picker.

## Development

```bash
npm test
```

Unit tests run against a local mock codex-lb (`test/helpers/mock-codex-lb.js`), which
also runs standalone for manual end-to-end checks:

```bash
node test/helpers/mock-codex-lb.js 8531 ok "HELLO"   # ok | error429 | closeEarly | closeEarlyClean | close1000PreEvent | close1001Idle | terminate1006Idle | closeAfterComplete | hang
```

## Releases

Releases are tagged `vX.Y.Z` matching `package.json`. Install by referencing the tag.
