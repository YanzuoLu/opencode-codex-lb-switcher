# Action Command And Global Fetch Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `opencode-codex-lb-switcher` so `/codex-lb` is an action-only TUI slash command and codex-lb mode routes all OpenAI/ChatGPT Responses traffic, including `opencode-websearch`, through codex-lb without polluting conversation context.

**Architecture:** The server plugin installs transparent fetch routers instead of prompt commands or instance disposal. Native mode returns upstream fetch calls unchanged; codex-lb mode rewrites only OpenAI/ChatGPT API URLs to the configured codex-lb `baseURL` and replaces `Authorization`. The TUI plugin owns `/codex-lb` via `api.command.register(... onSelect ...)`, writes workspace mode immediately when idle, and queues only within the TUI until the active session emits `session.idle`.

**Tech Stack:** ESM JavaScript, Node `node --test`, OpenCode server plugin hooks, OpenCode TUI plugin API, Node `fs/promises`, `path`, and `crypto`.

## Global Constraints

- Plugin options remain exactly `baseURL` and `apiKey`.
- Do not edit `~/.local/share/opencode/auth.json`.
- Do not persist `baseURL` or `apiKey` outside user config.
- Do not inject `config.command`; `/codex-lb` must not create prompt parts or conversation messages.
- Do not call `client.instance.dispose()` for switching.
- Native mode must not alter any outgoing request object, URL, headers, body, method, or signal.
- codex-lb mode must rewrite both `https://api.openai.com/v1/...` and `https://chatgpt.com/backend-api/codex/...` to codex-lb.
- Non-OpenAI/ChatGPT requests must pass through unchanged.
- Preserve existing `opencode-websearch` config such as `provider.openai.models.*.options.websearch`.

---

## File Structure

- `index.js`: state helpers, mode-routing fetch helpers, server plugin config hook, and global fetch install/restore logic.
- `tui.js`: action-only `/codex-lb` command registration, idle queue, and toast feedback.
- `test/index.test.js`: unit coverage for fetch routing, no prompt command injection, TUI action toggling, and package helper behavior.
- `README.md`: document global fetch routing, websearch behavior, action-only slash command, and restart requirements.

### Task 1: Global Fetch Router

**Files:**
- Modify: `index.js`
- Modify: `test/index.test.js`

**Interfaces:**
- Produces: `shouldRewriteURL(input): boolean`, `rewriteCodexLbURL(input, baseURL): URL`, `createModeRoutingFetch({ directory, stateRoot, options, upstream })`, `installGlobalFetchRouter({ directory, stateRoot, options, fetchGlobal })`.

- [ ] Write failing tests that native mode calls upstream with exactly the original `input` and `init` object references.
- [ ] Write failing tests that codex-lb mode rewrites `https://api.openai.com/v1/responses?stream=true` to `<baseURL>/responses?stream=true` and replaces `Authorization`.
- [ ] Write failing tests that codex-lb mode rewrites `https://chatgpt.com/backend-api/codex/responses` to `<baseURL>/responses` for `opencode-websearch` ChatGPT requests.
- [ ] Write failing tests that non-OpenAI requests pass through unchanged.
- [ ] Implement URL classification and rewrite helpers.
- [ ] Implement mode-routing fetch with strict native passthrough.
- [ ] Implement global fetch install/restore without breaking existing wrapper chains.
- [ ] Run `npm test` and verify the new router tests pass.

### Task 2: Remove Prompt Command And Dispose Switching

**Files:**
- Modify: `index.js`
- Modify: `test/index.test.js`

**Interfaces:**
- Removes: `injectCommand`, `parseCommand`, `switchMessage`, `command.execute.before`, `switchMode` disposal behavior.
- Produces: `writeMode(directory, mode, stateRoot)` remains the only mode persistence path.

- [ ] Write failing tests that `server().config(cfg)` does not add `cfg.command.codex-lb`.
- [ ] Write failing tests that server hooks do not expose `command.execute.before`.
- [ ] Write failing tests that changing mode does not call `client.instance.dispose()`.
- [ ] Remove prompt command injection and command hook code.
- [ ] Remove instance disposal from mode switching helpers.
- [ ] Keep provider config limited to `provider.openai.options.fetch` only; do not set `baseURL` or `apiKey`.
- [ ] Run `npm test` and verify no prompt-command tests remain.

### Task 3: TUI Action-Only Slash Command

**Files:**
- Modify: `tui.js`
- Modify: `test/index.test.js`

**Interfaces:**
- Produces: `registerCodexLbCommand(api, { directory, stateRoot })`, `currentSessionID(api)`, and `isSessionBusy(api, sessionID)`.

- [ ] Write failing tests that `tui(api)` registers a command with `slash.name === "codex-lb"` and an `onSelect` handler.
- [ ] Write failing tests that `onSelect` on an idle session writes the toggled mode immediately and shows a toast.
- [ ] Write failing tests that `onSelect` on a busy session does not write mode until matching `session.idle`.
- [ ] Write failing tests that no output parts or prompt command config are produced by the TUI action path.
- [ ] Implement TUI command registration using `api.command.register` when available.
- [ ] Implement pending idle queue via `api.event.on("session.idle", ...)`.
- [ ] Do not register prompt-right slots unless they return a real OpenTUI renderable; bare strings can crash the TUI.
- [ ] Run `npm test`.

### Task 4: Documentation And Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-06-20-action-global-fetch-rewrite.md` if implementation details change.

**Interfaces:**
- Documents one-line plugin entry, codex-lb mode network routing, websearch compatibility, and limitations.

- [ ] Update README to say codex-lb mode routes native OpenAI and `opencode-websearch` OpenAI/ChatGPT Responses traffic through codex-lb.
- [ ] Document that `/codex-lb` is action-only and requires OpenCode TUI plugin loading.
- [ ] Run `npm test`.
- [ ] Run `npm pack --dry-run` and verify only `LICENSE`, `README.md`, `index.js`, `package.json`, and `tui.js` are included.
- [ ] Request code review before committing.
- [ ] Commit and push when verification passes.

---

## Self-Review

- Spec coverage: The plan covers action-only slash command, global OpenAI/ChatGPT fetch rewrite for main model and websearch, native passthrough, no dispose, no auth file writes, package docs, and verification.
- Placeholder scan: No placeholders or deferred implementation steps remain.
- Type consistency: Function names and behavior are consistent across tasks and match the current ESM JavaScript project structure.
