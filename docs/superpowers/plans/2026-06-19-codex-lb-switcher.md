# Codex LB Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an external OpenCode plugin that toggles a workspace between native OpenAI mode and codex-lb mode with one `/codex-lb` command and no manual reload.

**Architecture:** The plugin persists a workspace-scoped mode file. In OpenAI mode it leaves the OpenAI provider untouched; in codex-lb mode it mutates only the in-memory config object during plugin initialization with codex-lb `baseURL`, `apiKey`, and fetch. `/codex-lb` flips the mode by queuing the change, then disposes/reloads only after the matching session emits `session.idle`.

**Tech Stack:** ESM JavaScript, Node `node --test`, OpenCode plugin API, OpenCode SDK client injected through `PluginInput.client`, Node `fs/promises`, `path`, and `crypto`.

## Global Constraints

- Do not modify OpenCode core.
- Plugin options are exactly `baseURL` and `apiKey`; do not add `models`, `defaultRoute`, or route policy options.
- Expose exactly one user command: `/codex-lb`; do not expose `/codex-lb-on`, `/codex-lb-off`, or `/codex-lb-status`.
- `/codex-lb` toggles: OpenAI mode -> codex-lb mode; codex-lb mode -> OpenAI mode.
- Do not write or delete `~/.local/share/opencode/auth.json`.
- Do not persist codex-lb `baseURL` or `apiKey` into `provider.openai.options`; only mutate the in-memory config object passed to the plugin `config` hook.
- Do not switch while a session is actively running; switching always queues until the matching `session.idle` event.
- When codex-lb mode is enabled, show a small TUI hint if the TUI plugin surface supports it; when codex-lb mode is not enabled, show nothing.
- Preserve visible conversation context; do not attempt to preserve or reuse provider-specific hidden Responses state across OpenAI and codex-lb modes.
- Keep the package self-contained under `/Users/ol125/Documents/opencode-codex-lb-switcher`.

---

## File Structure

- `package.json`: package metadata, exports, files, and `test` script.
- `index.js`: server plugin entrypoint plus state, command, fetch, config, and idle-switch helpers.
- `tui.js`: optional TUI plugin export that renders a right-side hint only when codex-lb mode is enabled.
- `test/index.test.js`: Node tests for each behavior.
- `README.md`: installation, config, command behavior, and limitations.

---

### Task 1: Scaffold Project

**Files:**
- Create: `package.json`
- Create: `index.js`

**Interfaces:**
- Produces: mode strings, switch intent objects, plugin options, and `normalizeOptions(options)`.

- [ ] Create package metadata and test script.
- [ ] Add strict option validation that accepts only `baseURL` and `apiKey` as required non-empty strings.
- [ ] Run `npm test`.

### Task 2: State Persistence

**Files:**
- Modify: `index.js`
- Modify: `test/index.test.js`

**Interfaces:**
- Produces: `stateFileFor(directory: string): string`, `readMode(directory: string): Promise<Mode>`, `writeMode(directory: string, mode: Mode): Promise<void>`, `toggleMode(mode: Mode): Mode`, `makeSwitchState()`.

- [ ] Write failing tests for default OpenAI mode, codex-lb persistence, invalid state fallback, toggle behavior, and queued-switch state.
- [ ] Implement minimal state helpers.
- [ ] Run `npm test`.

### Task 3: codex-lb Fetch Wrapper

**Files:**
- Modify: `index.js`
- Modify: `test/index.test.js`

**Interfaces:**
- Produces: `createCodexLbFetch(options: PluginOptions, upstream?: typeof fetch): typeof fetch`.

- [ ] Write failing tests for URL rewriting and auth header injection.
- [ ] Implement the fetch wrapper.
- [ ] Run `npm test`.

### Task 4: Single Toggle Command

**Files:**
- Modify: `index.js`
- Modify: `test/index.test.js`

**Interfaces:**
- Produces: `COMMAND = "codex-lb"`, `injectCommand(config)`, `parseCommand(command: string, args?: string)`, `switchMessage(from: Mode, to: Mode)`.

- [ ] Write failing tests that only `/codex-lb` is injected.
- [ ] Write failing tests that `/codex-lb` toggles based on current mode and rejects arguments.
- [ ] Implement command parsing and messages.
- [ ] Run `npm test`.

### Task 5: Plugin Entrypoint And Auto Dispose

**Files:**
- Modify: `index.js`
- Modify: `test/index.test.js`

**Interfaces:**
- Consumes all prior task interfaces.
- Produces default server plugin export.

- [ ] Write failing tests for config mutation only in codex-lb mode.
- [ ] Write failing tests that `/codex-lb` queues until the matching `session.idle` event before calling `client.instance.dispose()`.
- [ ] Implement server plugin entrypoint.
- [ ] Run `npm test`.

### Task 6: Optional TUI Hint

**Files:**
- Create: `tui.js`
- Modify: `test/index.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces an optional TUI plugin export if the installed `@opencode-ai/plugin` TUI surface can render status/sidebar content.

- [ ] Inspect installed plugin type definitions for the current TUI hook names.
- [ ] If a suitable right-side/status hook exists, write failing tests for showing a codex-lb hint only when mode is `codex-lb`.
- [ ] If no suitable TUI hook exists, document the limitation and do not fake the hint through command output.
- [ ] Run `npm test` when implemented.

### Task 7: Documentation And Verification

**Files:**
- Create: `README.md`

**Interfaces:**
- Documents config, command, automatic reload behavior, and limitations.

- [ ] Document plugin config with only `baseURL` and `apiKey`.
- [ ] Document `/codex-lb`.
- [ ] Document idle-only switching and workspace-instance scope.
- [ ] Run `npm test && npm pack --dry-run`.

---

## Self-Review

- Spec coverage: Covers single `/codex-lb` toggle, no status command, TUI hint only when enabled, no core changes, only `baseURL/apiKey`, runtime-only provider mutation, idle-only automatic dispose/reload, and visible-context preservation.
- Placeholder scan: No placeholder requirements remain; Task 6 explicitly gates implementation on available OpenCode TUI plugin surface.
- Type consistency: `Mode`, `PluginOptions`, `SwitchIntent`, command, state, fetch, and plugin entrypoint names are consistent.
