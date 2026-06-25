# OpenCode Codex-LB Smoke Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the released `opencode-codex-lb-switcher` end-to-end in a real OpenCode process, fixing and releasing new commits until `/codex-lb`, mode switching, native OpenAI OAuth, and codex-lb routing all work.

**Architecture:** The controller runs the release loop and owns writes to git/config/tmux. Fresh subagents are used for independent review and log interpretation so the controller does not rationalize failures. If smoke reveals a bug, the controller returns to TDD: write a failing regression test, implement the smallest fix, run tests, commit, push, update the plugin pin, and rerun smoke.

**Tech Stack:** OpenCode 1.17.8, fish environment variable substitution, tmux TUI smoke tests, Node `node --test`, npm packaging, GitHub git plugin specs pinned by commit hash.

## Global Constraints

- Do not print or persist `CODEX_LB_API_KEY` outside the user's shell/config substitution path.
- Do not edit `~/.local/share/opencode/auth.json`.
- Do not modify OpenCode core.
- Do not use OpenCode `config.command` for `/codex-lb`.
- Do not call `client.instance.dispose()` for switching.
- Native OpenAI/ChatGPT OAuth must not be overridden by `provider.openai.options.fetch`.
- Only write plugin release commits after tests pass.
- Use a separate tmux session for smoke tests; do not inject keys into the active user session.
- On every bug: first reproduce and identify root cause, then write a failing test, then fix.
- Completion requires fresh-session toggle coverage: before any conversation exists in the smoke session, `/codex-lb` must toggle `openai -> codex-lb -> openai` successfully.
- Completion requires post-conversation interleave coverage: after a session has received at least one assistant response, `/codex-lb` must toggle `on -> off -> on -> off` and a prompt sent after those toggles must send successfully and receive a response.

---

### Task 1: Preflight State And Subagent Review

**Files:**
- Read: `/Users/ol125/.config/opencode/opencode.json`
- Read: `/Users/ol125/Documents/opencode-codex-lb-switcher/index.js`
- Read: `/Users/ol125/Documents/opencode-codex-lb-switcher/tui.js`
- Read: `/Users/ol125/Documents/opencode-codex-lb-switcher/test/index.test.js`

**Interfaces:**
- Consumes: released commit hash `4a77210`.
- Produces: preflight evidence and independent review findings.

- [ ] **Step 1: Run release verification**

Run from `/Users/ol125/Documents/opencode-codex-lb-switcher`:

```bash
npm test
npm pack --dry-run
git status --short
git log --oneline -3
```

Expected: tests pass, pack succeeds, only known untracked plan docs remain.

- [ ] **Step 2: Dispatch subagent review**

Dispatch a fresh `general` subagent. Requirements: read the current plugin diff/release state, verify no path writes `provider.openai.options.fetch`, verify TUI command shape, and return findings only. The subagent must not edit files.

- [ ] **Step 3: Resolve any Critical/Important review findings**

If findings exist, write a failing test in `test/index.test.js`, confirm it fails, fix `index.js` or `tui.js`, run `npm test`, commit, push, record new hash, and continue with that hash.

### Task 2: Configure Plugin Pin Safely

**Files:**
- Modify: `/Users/ol125/.config/opencode/opencode.json`

**Interfaces:**
- Consumes: plugin commit hash from Task 1.
- Produces: global OpenCode config with pinned plugin entry and env-substituted `apiKey`.

- [ ] **Step 1: Confirm environment variable exists without printing it**

Run:

```bash
node -e 'console.log(process.env.CODEX_LB_API_KEY ? "CODEX_LB_API_KEY=SET" : "CODEX_LB_API_KEY=UNSET")'
```

Expected: `CODEX_LB_API_KEY=SET`. If unset, stop and report the blocker.

- [ ] **Step 2: Ensure tmux server will inherit the variable**

Run:

```bash
tmux set-environment -g CODEX_LB_API_KEY "$CODEX_LB_API_KEY"
tmux show-environment -g CODEX_LB_API_KEY >/dev/null && printf 'CODEX_LB_API_KEY=SET\n'
```

Expected: output shows `CODEX_LB_API_KEY=SET`; do not print the value.

- [ ] **Step 3: Add plugin entry**

Edit `/Users/ol125/.config/opencode/opencode.json` to include:

```json
[
  "opencode-codex-lb-switcher@git+https://github.com/YanzuoLu/opencode-codex-lb-switcher.git#4a77210",
  {
    "baseURL": "https://coding-agent-api.mvp-lab.ai/v1",
    "apiKey": "{env:CODEX_LB_API_KEY}"
  }
]
```

Preserve all existing plugin entries, provider settings, agent settings, and permissions.

- [ ] **Step 4: Validate JSON**

Run:

```bash
node -e 'JSON.parse(require("fs").readFileSync("/Users/ol125/.config/opencode/opencode.json", "utf8")); console.log("valid json")'
```

Expected: `valid json`.

### Task 3: Tmux TUI Smoke

**Files:**
- Read: `/Users/ol125/.local/share/opencode/log/opencode.log`
- Read/write through OpenCode only: workspace state under `~/.local/share/opencode-codex-lb-switcher/`

**Interfaces:**
- Consumes: configured plugin pin.
- Produces: evidence that `/codex-lb` is registered, fresh-session on/off toggles work, post-conversation interleaved toggles work, and a prompt sent after toggles receives a response.

- [ ] **Step 1: Start isolated tmux session**

Run:

```bash
tmux new-session -d -s oc-codex-lb-smoke -c /Users/ol125/Documents/cosmos 'fish -lc "opencode"'
```

Expected: session exists and OpenCode starts.

- [ ] **Step 2: Wait and capture UI**

Run:

```bash
tmux capture-pane -pt oc-codex-lb-smoke -S -200
```

Expected: OpenCode TUI is visible, with no config crash.

- [ ] **Step 3: Fresh-session toggle on before any conversation**

Run:

```bash
tmux send-keys -t oc-codex-lb-smoke '/codex-lb' Enter
```

Expected: command is accepted as an action, not inserted into the conversation prompt.

- [ ] **Step 4: Verify state file changed to codex-lb**

Read `~/.local/share/opencode-codex-lb-switcher/*.json` for the cosmos workspace.

Expected: mode is `codex-lb`.

- [ ] **Step 5: Fresh-session toggle off before any conversation**

Run:

```bash
tmux send-keys -t oc-codex-lb-smoke '/codex-lb' Enter
```

Expected: mode is `openai`; no conversation message containing `/codex-lb` appears.

- [ ] **Step 6: Establish a conversation and receive a response**

Run a short prompt in native mode:

```bash
tmux send-keys -t oc-codex-lb-smoke 'Reply exactly: smoke-native-ok' Enter
```

Expected: UI/logs show the prompt sends successfully and an assistant response is received.

- [ ] **Step 7: Post-conversation interleaved toggles**

Run four toggles in the same conversation:

```bash
tmux send-keys -t oc-codex-lb-smoke '/codex-lb' Enter
tmux send-keys -t oc-codex-lb-smoke '/codex-lb' Enter
tmux send-keys -t oc-codex-lb-smoke '/codex-lb' Enter
tmux send-keys -t oc-codex-lb-smoke '/codex-lb' Enter
```

Expected: state changes `openai -> codex-lb -> openai -> codex-lb -> openai`; no `failed to send prompt`; no `/codex-lb` prompt content is inserted into the conversation.

- [ ] **Step 8: Send after interleaved toggles and receive response**

Run:

```bash
tmux send-keys -t oc-codex-lb-smoke 'Reply exactly: smoke-after-toggle-ok' Enter
```

Expected: prompt sends successfully and an assistant response is received after the interleaved toggles.

### Task 4: Log And Native OAuth Verification

**Files:**
- Read: `/Users/ol125/.local/share/opencode/log/opencode.log`

**Interfaces:**
- Consumes: running smoke OpenCode process.
- Produces: evidence that `#4a77210` loaded, no plugin load error, and native OpenAI no longer errors with the OAuth dummy key.

- [ ] **Step 1: Dispatch log-review subagent**

Dispatch a fresh `general` subagent with read-only instructions. It must inspect the latest `opencode.log` section for `oc-codex-lb-smoke`, `opencode-codex-lb-switcher`, `4a77210`, `failed to load plugin`, `must default export`, `does not expose`, `opencode-oauth-dummy-key`, and `Incorrect API key provided`. It returns findings and exact line references only.

- [ ] **Step 2: If native OAuth fails, root-cause before fixing**

If logs show dummy key direct-to-OpenAI or failed plugin load, stop normal loop, identify the boundary that failed, and write a regression test before modifying code.

### Task 5: Bugfix Release Loop

**Files:**
- Modify only if needed: `/Users/ol125/Documents/opencode-codex-lb-switcher/index.js`
- Modify only if needed: `/Users/ol125/Documents/opencode-codex-lb-switcher/tui.js`
- Modify only if needed: `/Users/ol125/Documents/opencode-codex-lb-switcher/test/index.test.js`
- Modify only after new commit: `/Users/ol125/.config/opencode/opencode.json`

**Interfaces:**
- Consumes: a concrete smoke failure.
- Produces: new commit hash and updated config pin.

- [ ] **Step 1: Reproduce and classify failure**

Collect exact UI capture, state file, and log lines. State one hypothesis only.

- [ ] **Step 2: Write failing test first**

Add a minimal `node:test` regression to `test/index.test.js`. Run the focused test and confirm it fails for the expected reason.

- [ ] **Step 3: Implement minimal fix**

Patch only the file needed for the root cause. Do not refactor adjacent code.

- [ ] **Step 4: Verify and release**

Run:

```bash
npm test
npm pack --dry-run
git diff --check
git status --short
git diff
git log --oneline -10
```

Then commit only intended files and push:

```bash
git add index.js tui.js test/index.test.js README.md
git commit -m "Fix <specific issue>"
git push origin main
```

Update `/Users/ol125/.config/opencode/opencode.json` to the new hash and return to Task 3.

### Task 6: Completion Gate

**Files:**
- Read: config, logs, state file, plugin git status.

**Interfaces:**
- Consumes: successful Task 3 and Task 4 evidence.
- Produces: final status report.

- [ ] **Step 1: Final verification commands**

Run:

```bash
npm test
npm pack --dry-run
git status --short
git ls-remote origin refs/heads/main
node -e 'JSON.parse(require("fs").readFileSync("/Users/ol125/.config/opencode/opencode.json", "utf8")); console.log("valid json")'
```

Expected: all pass; local release commit equals remote main; config valid.

- [ ] **Step 2: Final subagent review**

Dispatch a read-only final reviewer to inspect release hash, global config pin, and latest log evidence. Fix Critical/Important findings before final report.

- [ ] **Step 3: Report completion**

Report the final plugin commit, config pin, tests, tmux smoke result, and any residual risks.
