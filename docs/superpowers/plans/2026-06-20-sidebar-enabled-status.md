# Sidebar Enabled Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change the OpenCode sidebar status to an independent two-line part with `Codex-LB` on the first line and `enabled: on/off` on the second line.

**Architecture:** Keep the existing `sidebar_content` slot and Solid signal mode update path. Only change the sidebar status element construction and copy, preserving provider gating, command behavior, routing behavior, and fail-closed behavior.

**Tech Stack:** JavaScript ESM, OpenCode TUI plugin API, OpenTUI Solid runtime, Node test runner.

## Global Constraints

- First line text must be exactly `Codex-LB`.
- Second line text must be exactly `enabled: on` in `codex-lb` mode.
- Second line text must be exactly `enabled: off` in native OpenAI mode.
- First line uses normal sidebar text color from `theme.text`.
- Second line uses muted sidebar text color from `theme.textMuted`.
- Keep the existing `sidebar_content` slot and independent `box` part.
- Do not change routing, fail-closed behavior, state file format, or `/codex-lb` command semantics.
- Keep OpenAI-only sidebar visibility behavior unchanged.
- Do not introduce prompt-right rendering or bare string prompt slot children.

---

## File Structure

- Modify `tui.js`: update `createSidebarStatusElement()` to return a two-line box and add a helper for `enabled: on/off` copy if useful.
- Modify `test/index.test.js`: update the existing sidebar element shape assertion and add native/codex-lb text coverage.
- Modify `README.md`: update sidebar status documentation from the old one-line copy to the new two-line copy.

---

### Task 1: Two-Line Sidebar Status

**Files:**
- Modify: `tui.js:117-122`
- Modify: `test/index.test.js:1010-1038`
- Modify: `README.md:59-63`

**Interfaces:**
- Consumes: `createSidebarStatusElement(api, mode, view)` where `mode` is `"openai" | "codex-lb"`.
- Produces: `sidebarStatusText(mode)` returning `"enabled: off" | "enabled: on"`; `createSidebarStatusElement()` returns a `box` containing two `text` children.

- [ ] **Step 1: Write the failing tests**

Update `test/index.test.js` sidebar status tests to assert the new two-line shape:

```js
test("sidebar status builds a real element shape for OpenAI sessions", async () => {
  const { createSidebarStatusElement } = await import("../tui.js")
  const api = makeTuiApi("/tmp/worktree")
  const view = makeOpenTuiView()

  const rendered = createSidebarStatusElement(api, "codex-lb", view)

  assert.deepEqual(rendered, {
    type: "box",
    props: { width: "100%", flexDirection: "column" },
    children: [
      {
        type: "text",
        props: { fg: "text" },
        children: ["Codex-LB"],
      },
      {
        type: "text",
        props: { fg: "muted" },
        children: ["enabled: on"],
      },
    ],
  })
})

test("sidebarStatusText labels enabled state", async () => {
  const { sidebarStatusText } = await import("../tui.js")

  assert.equal(sidebarStatusText("openai"), "enabled: off")
  assert.equal(sidebarStatusText("codex-lb"), "enabled: on")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern "sidebar status|sidebarStatusText" test/index.test.js`

Expected: FAIL because current output is `Codex LB: routing via codex-lb` on one line and `sidebarStatusText()` returns old copy.

- [ ] **Step 3: Implement minimal TUI change**

Update `tui.js`:

```js
export function sidebarStatusText(mode) {
  return mode === "codex-lb" ? "enabled: on" : "enabled: off"
}

export function createSidebarStatusElement(api, mode, view = defaultSolidView) {
  if (!view) throw new Error(`${SERVICE}: TUI runtime is not initialized`)
  const theme = api.theme?.current ?? api.theme ?? {}
  return elementNode(
    "box",
    { width: "100%", flexDirection: "column" },
    [
      textNode("Codex-LB", { fg: theme.text }, view),
      textNode(sidebarStatusText(mode), { fg: theme.textMuted }, view),
    ],
    view,
  )
}
```

- [ ] **Step 4: Update README copy**

Update `README.md` sidebar status section to say:

```md
For sessions whose current model provider is `openai`, the TUI hook also renders a small sidebar status:

```text
Codex-LB
enabled: off
```

In `codex-lb` mode the second line changes to `enabled: on`.
```

- [ ] **Step 5: Run full verification**

Run: `npm test`

Expected: all tests pass.

Run: `npm pack --dry-run --json`

Expected: package dry-run succeeds and includes `README.md`, `index.js`, `package.json`, `tui.js`, and `LICENSE`.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 6: Commit implementation**

```bash
git add tui.js test/index.test.js README.md docs/superpowers/specs/2026-06-20-sidebar-enabled-status-design.md docs/superpowers/plans/2026-06-20-sidebar-enabled-status.md
git commit -m "Render codex-lb sidebar enabled status"
```

- [ ] **Step 7: Update OpenCode pins and smoke test**

After pushing the commit, update both config files to the new full commit SHA:

- `/Users/ol125/.config/opencode/opencode.json`
- `/Users/ol125/.config/opencode/tui.json`

Run a fresh tmux smoke from `/Users/ol125/Documents/cosmos`:

```bash
tmux new-session -d -s oc-clb-enabled-status 'fish -lc "opencode"'
```

Verify:

- Native mode shows `Codex-LB` and `enabled: off`.
- Running `/codex-lb` updates the second line to `enabled: on`.
- Reset the workspace state to native OpenAI after smoke.
- Filter logs for plugin load errors, `Orphan text`, `Cannot find module`, and dummy-key/API-key errors.

---

## Self-Review

- Spec coverage: visual text, color, independent part, behavior preservation, tests, and smoke are covered by Task 1.
- Placeholder scan: no TODO/TBD placeholders remain.
- Type consistency: `sidebarStatusText(mode)` and `createSidebarStatusElement(api, mode, view)` match the existing code interfaces.
