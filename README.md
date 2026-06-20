# opencode-codex-lb-switcher

Toggle an OpenCode workspace between native OpenAI mode and codex-lb mode with one action-only command.

## Usage

Add the server plugin entry with options to `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-codex-lb-switcher@git+https://github.com/YanzuoLu/opencode-codex-lb-switcher.git",
      {
        "baseURL": "http://127.0.0.1:2455/v1",
        "apiKey": "{env:CODEX_LB_API_KEY}"
      }
    ]
  ]
}
```

OpenCode 1.17.8 also needs the TUI target listed in `tui.json` so `/codex-lb` appears in the command palette:

```jsonc
{
  "plugin": [
    "opencode-codex-lb-switcher@git+https://github.com/YanzuoLu/opencode-codex-lb-switcher.git"
  ]
}
```

Alternatively, run `opencode plugin opencode-codex-lb-switcher@git+https://github.com/YanzuoLu/opencode-codex-lb-switcher.git --global` once to let OpenCode add the TUI entry, then keep `baseURL` and `apiKey` in `opencode.json`.

Restart OpenCode after changing config files; plugins are loaded at startup.

No npm install step is required. OpenCode installs GitHub plugin specs at startup.

## Command

Use one command in the TUI:

```text
/codex-lb
```

It toggles the current workspace mode without adding prompt parts or conversation messages:

- Native OpenAI mode -> codex-lb mode
- codex-lb mode -> native OpenAI mode

If the current session is idle, the mode is written immediately. If the current session is busy, the switch is queued until that session emits `session.idle`. The plugin does not support a force switch and does not dispose an in-flight model response.

## TUI Registration

The package registers `/codex-lb` from its TUI hook. It does not render a prompt-right hint; that slot is intentionally avoided because bare text children can crash OpenTUI.

For sessions whose current model provider is `openai`, the TUI hook also renders a small sidebar status:

- `Codex LB / native OpenAI` in native mode.
- `Codex LB / routing via codex-lb` in codex-lb mode.

The sidebar status is hidden for non-OpenAI providers.

## Behavior

The plugin stores only the selected mode per workspace under `~/.local/share/opencode-codex-lb-switcher/`.

In native OpenAI mode requests pass through unchanged, including the original request object, headers, body, method, and signal.

In codex-lb mode it installs in-memory fetch routers that rewrite only OpenAI/ChatGPT API traffic to the configured codex-lb `baseURL` and replace `Authorization` with the configured `apiKey`:

- `https://api.openai.com/v1/...`
- `https://chatgpt.com/backend-api/codex/...`

Non-OpenAI requests pass through unchanged. The plugin preserves existing provider/model options such as `provider.openai.models.*.options.websearch`, and codex-lb mode also routes supported `opencode-websearch` OpenAI/ChatGPT Responses requests through codex-lb.

codex-lb mode is fail-closed for OpenAI/ChatGPT API traffic. If a request has been selected for codex-lb routing and codex-lb fails, the error is surfaced to OpenCode; the plugin does not retry the same request against native OpenAI/ChatGPT. If the router has already observed `codex-lb` mode and the workspace mode file becomes temporarily unreadable, it keeps routing target requests through codex-lb instead of silently falling back to native OpenAI.

It does not set `provider.openai.options.fetch`, so OpenCode's built-in OpenAI/ChatGPT OAuth fetch path remains intact in native mode.

It does not persist `baseURL` or `apiKey` outside your plugin config and does not edit `~/.local/share/opencode/auth.json`.

## Limitations

- Switching is workspace-scoped, not per parallel session.
- The `/codex-lb` action requires OpenCode TUI plugin hooks to be available.
- Existing running OpenCode processes keep the already-loaded plugin code until restarted.

## Development

```bash
npm test
```
