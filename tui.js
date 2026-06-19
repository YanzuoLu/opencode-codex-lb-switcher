import { readMode } from "./index.js"

const SERVICE = "opencode-codex-lb-switcher"

export function indicatorText(mode) {
  return mode === "codex-lb" ? "codex-lb" : ""
}

function directoryFor(api) {
  return api.state.path.directory || api.state.path.worktree
}

export async function tui(api) {
  const directory = directoryFor(api)
  let mode = await readMode(directory)
  let disposed = false
  let inFlight = false

  async function refresh() {
    if (disposed || inFlight) return
    inFlight = true
    try {
      const next = await readMode(directory)
      if (next !== mode) {
        mode = next
        api.renderer.requestRender()
      }
    } finally {
      inFlight = false
    }
  }

  const timer = setInterval(refresh, 1000)
  api.lifecycle.onDispose(() => {
    disposed = true
    clearInterval(timer)
  })

  api.slots.register({
    order: 900,
    slots: {
      home_prompt_right() {
        return indicatorText(mode)
      },
      session_prompt_right() {
        return indicatorText(mode)
      },
    },
  })
}

export default {
  id: `${SERVICE}:tui`,
  tui,
}
