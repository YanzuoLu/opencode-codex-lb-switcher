# Sidebar Enabled Status Design

## Goal

Change the OpenCode sidebar status from one line to an independent two-line part:

```text
Codex-LB
enabled: off
```

## Visual Behavior

- The first line is `Codex-LB` and uses the normal sidebar text color (`theme.text`).
- The second line is `enabled: on` or `enabled: off` and uses muted sidebar text color (`theme.textMuted`).
- `enabled: on` means the workspace is in `codex-lb` mode.
- `enabled: off` means the workspace is in native OpenAI mode.

## Functional Behavior

- Keep the status in the existing `sidebar_content` slot as its own `box` part.
- Keep existing provider gating: show only for OpenAI sessions.
- Keep existing mode state, routing, fail-closed behavior, and `/codex-lb` command behavior unchanged.
- Keep existing Solid signal update path so the second line updates immediately after `/codex-lb`.

## Testing

- Update unit tests for the new element shape and text.
- Keep existing command, sidebar visibility, signal update, and routing tests passing.
- Verify in a real OpenCode TUI smoke that the sidebar shows `Codex-LB` plus `enabled: off`, then changes to `enabled: on` after `/codex-lb`.
