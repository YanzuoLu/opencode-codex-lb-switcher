# opencode-codex-lb-switcher

Toggle an OpenCode workspace between native OpenAI mode and codex-lb mode with one command.

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

Use one command:

```text
/codex-lb
```

It toggles the current workspace instance:

- Native OpenAI mode -> codex-lb mode
- codex-lb mode -> native OpenAI mode

Switching is always queued until the current session becomes idle. The plugin does not support a force switch, so it will not dispose an in-flight model response.

## TUI Indicator

The package exports an optional `./tui` entry that can render a small `codex-lb` prompt-right hint on OpenCode versions that load TUI plugin subpaths. The core `/codex-lb` switching behavior does not depend on this hint.

## Behavior

The plugin stores only the selected mode per workspace under `~/.local/share/opencode-codex-lb-switcher/`.

In native OpenAI mode it does not mutate `provider.openai` at all, so OpenCode's built-in OpenAI OAuth and Responses path stays intact.

In codex-lb mode it mutates only the in-memory config object passed to the plugin `config` hook:

- `provider.openai.options.baseURL`
- `provider.openai.options.apiKey`
- `provider.openai.options.fetch`

It does not persist those values into `opencode.json` and does not edit `~/.local/share/opencode/auth.json`.

## Limitations

- Switching is workspace-instance scoped, not per parallel session.
- Switching waits for the matching `session.idle` event before reloading.
- Visible conversation context is preserved by OpenCode session storage, but provider-specific hidden Responses state is not intentionally reused across OpenAI and codex-lb modes.

## Development

```bash
npm test
```
