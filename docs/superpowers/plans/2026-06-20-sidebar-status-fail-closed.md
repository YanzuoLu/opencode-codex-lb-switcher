# Sidebar Status And Fail-Closed Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OpenAI-only sidebar status indicator and make codex-lb mode fail closed instead of silently falling back to native OpenAI/ChatGPT traffic.

**Architecture:** The TUI plugin registers a safe `sidebar_content` slot that renders real JSX only for sessions whose model provider is `openai`. The server-side global fetch router continues to preserve native OpenAI mode, but when the workspace mode is `codex-lb`, target OpenAI/ChatGPT API requests must either rewrite to codex-lb or fail; codex-lb errors are propagated and never retried against native upstream URLs.

**Tech Stack:** ESM JavaScript, Node `node --test`, OpenCode TUI slot API, OpenCode global plugin fetch routing, Git-pinned OpenCode plugin install.

## Global Constraints

- Do not modify OpenCode core.
- Plugin options remain exactly `baseURL` and `apiKey`.
- Expose exactly one command: `/codex-lb`.
- Do not write or edit `~/.local/share/opencode/auth.json`.
- Do not set `provider.openai.options.fetch`.
- Do not call `client.instance.dispose()` for switching.
- Do not register prompt-right slots returning bare strings.
- Native OpenAI mode must pass upstream fetch `input/init` references unchanged.
- In codex-lb mode, OpenAI/ChatGPT API target requests must not fall back to native upstream.
- Config pins must use full Git commit specs after release.

---

## File Structure

- `index.js`: tighten mode-routing fetch semantics and keep native passthrough unchanged.
- `tui.js`: add sidebar status slot helpers and render OpenAI-only status.
- `test/index.test.js`: add RED tests for fail-closed routing and sidebar rendering.
- `README.md`: document sidebar status and fail-closed behavior.

### Task 1: Fail-Closed Routing Tests And Implementation

**Files:**
- Modify: `test/index.test.js`
- Modify: `index.js`

**Interfaces:**
- Consumes: `createModeRoutingFetch({ directory, stateRoot, options, upstream })`, `writeMode(directory, mode, stateRoot)`.
- Produces: codex-lb mode routing that propagates codex-lb failures and never calls native upstream after a codex-lb target rewrite has been selected.

- [ ] **Step 1: Write failing tests**

Add tests proving codex-lb mode target requests do not fall back to native OpenAI after rewrite failure, and that native mode still preserves byte-for-byte passthrough.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --test-name-pattern "codex-lb mode propagates codex-lb fetch failures|native OpenAI mode byte-for-byte"`
Expected: the new codex-lb failure test fails before implementation; existing native passthrough remains green.

- [ ] **Step 3: Implement minimal routing change**

Keep native mode unchanged. In codex-lb mode, route target URLs through rewritten codex-lb fetch exactly once and let thrown errors propagate.

- [ ] **Step 4: Verify GREEN**

Run: `npm test`
Expected: all tests pass.

### Task 2: OpenAI-Only Sidebar Status Tests And Implementation

**Files:**
- Modify: `test/index.test.js`
- Modify: `tui.js`

**Interfaces:**
- Consumes: `api.slots.register`, `api.state.session.get(sessionID)`, `readMode(directory, stateRoot)`.
- Produces: `registerSidebarStatus(api, { directory, stateRoot })` and helper functions that render `Codex LB` status only for OpenAI sessions.

- [ ] **Step 1: Write failing tests**

Add tests that `sidebar_content` is registered, returns null for non-OpenAI sessions, and returns a real JSX-like element for OpenAI sessions in both `openai` and `codex-lb` modes.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --test-name-pattern "sidebar"`
Expected: tests fail because sidebar registration does not exist yet.

- [ ] **Step 3: Implement minimal sidebar slot**

Register `sidebar_content`; check `api.state.session.get(session_id)?.model.providerID`; render only when provider is `openai`; use element objects/JSX-compatible values, never bare strings.

- [ ] **Step 4: Verify GREEN**

Run: `npm test`
Expected: all tests pass and prompt-right regression remains green.

### Task 3: Documentation, Release, Pin, And Smoke

**Files:**
- Modify: `README.md`
- Modify: `/Users/ol125/.config/opencode/opencode.json`
- Modify: `/Users/ol125/.config/opencode/tui.json`

**Interfaces:**
- Consumes: committed plugin SHA.
- Produces: global OpenCode config pinned to the new commit and documented runtime behavior.

- [ ] **Step 1: Update README**

Document the sidebar status and codex-lb fail-closed behavior.

- [ ] **Step 2: Verify package and tests**

Run: `npm test && npm pack --dry-run --json && git diff --check`.
Expected: tests pass, package contains only published files, diff check is clean.

- [ ] **Step 3: Commit and push**

Commit only intended plugin files and the plan if desired; push `main`.

- [ ] **Step 4: Update global pins**

Update both OpenCode config files to the new full commit SHA without printing secrets.

- [ ] **Step 5: Smoke test**

Start an independent OpenCode tmux session, confirm `/codex-lb` still toggles, confirm sidebar status appears only for OpenAI sessions, and confirm codex-lb endpoint failure reports an error instead of native OpenAI success.

## Self-Review

- Spec coverage: Covers OpenAI-only sidebar status, codex-lb fail-closed behavior, no prompt-right bare strings, no provider fetch override, no auth file writes, release pin update, and smoke verification.
- Placeholder scan: No TBD/TODO placeholders remain.
- Type consistency: Function names and existing OpenCode TUI API names match current `tui.d.ts` and plugin code.
