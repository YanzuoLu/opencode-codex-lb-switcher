# opencode-codex-lb-switcher

Toggle an OpenCode workspace between native OpenAI mode and codex-lb mode with one action-only command.

## Usage

Add one plugin entry to `opencode.json`:

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

Restart OpenCode after changing `opencode.json`; plugins are loaded at startup.

No manual package installation is required. OpenCode installs GitHub plugin specs at startup.

## Command

Use one command in the TUI:

```text
/codex-lb
```

It toggles the current workspace mode without adding prompt parts or conversation messages:

- Native OpenAI mode -> codex-lb mode
- codex-lb mode -> native OpenAI mode

If the current session is idle, the mode is written immediately. If the current session is busy, the switch is queued until that session emits `session.idle`. The plugin does not support a force switch and does not dispose an in-flight model response.

## TUI Indicator

The package registers `/codex-lb` from its TUI hook and renders a small `codex-lb` prompt-right hint while codex-lb mode is active. Restart OpenCode after adding or updating the plugin entry so the updated plugin code is loaded.

## Behavior

The plugin stores only the selected mode per workspace under `~/.local/share/opencode-codex-lb-switcher/`.

In native OpenAI mode requests pass through unchanged, including the original request object, headers, body, method, and signal.

In codex-lb mode it installs in-memory fetch routers that rewrite only OpenAI/ChatGPT API traffic to the configured codex-lb `baseURL` and replace `Authorization` with the configured `apiKey`:

- `https://api.openai.com/v1/...`
- `https://chatgpt.com/backend-api/codex/...`

Non-OpenAI requests pass through unchanged. The plugin preserves existing provider/model options such as `provider.openai.models.*.options.websearch`, and codex-lb mode also routes supported `opencode-websearch` OpenAI/ChatGPT Responses requests through codex-lb.

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
