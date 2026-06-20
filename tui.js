import { COMMAND, readMode, toggleMode, writeMode } from "./index.js"

const SERVICE = "opencode-codex-lb-switcher"

export function indicatorText(mode) {
  return mode === "codex-lb" ? "codex-lb" : ""
}

function directoryFor(api) {
  return api.state.path.directory || api.state.path.worktree
}

export function currentSessionID(api) {
  return api.route?.current?.params?.sessionID
}

export function isSessionBusy(api, sessionID) {
  if (!sessionID) return false
  const status = api.state?.session?.status?.(sessionID)
  return status?.type !== "idle"
}

function showToast(api, variant, title, message) {
  api.ui?.toast?.({ variant, title, message })
}

function requestRender(api) {
  api.renderer?.requestRender?.()
}

async function applyMode(api, directory, mode, stateRoot) {
  await writeMode(directory, mode, stateRoot)
  showToast(api, "success", "codex-lb", mode === "codex-lb" ? "codex-lb mode enabled" : "native OpenAI mode enabled")
  requestRender(api)
}

export async function registerCodexLbCommand(api, { directory, stateRoot }) {
  if (typeof api.command?.register !== "function") return () => {}

  const pendingBySession = new Map()
  const unregisterIdle = api.event?.on?.("session.idle", async (event = {}) => {
    const sessionID = event.properties?.sessionID ?? event.sessionID
    const nextMode = pendingBySession.get(sessionID)
    if (!nextMode) return
    pendingBySession.delete(sessionID)
    await applyMode(api, directory, nextMode, stateRoot)
  })

  const unregisterCommand = api.command.register(() => [
    {
      title: "Toggle codex-lb",
      value: COMMAND,
      description: "Toggle codex-lb mode",
      slash: {
        name: COMMAND,
      },
      async onSelect() {
        const mode = await readMode(directory, stateRoot)
        const nextMode = toggleMode(mode)
        const sessionID = currentSessionID(api)
        if (isSessionBusy(api, sessionID)) {
          pendingBySession.set(sessionID, nextMode)
          showToast(api, "info", "codex-lb", "Switch queued until this session is idle")
          return
        }
        await applyMode(api, directory, nextMode, stateRoot)
      },
    },
  ])

  api.lifecycle?.onDispose?.(() => {
    unregisterCommand?.()
    unregisterIdle?.()
    pendingBySession.clear()
  })

  return () => {
    unregisterCommand?.()
    unregisterIdle?.()
    pendingBySession.clear()
  }
}

export async function tui(api) {
  const directory = directoryFor(api)
  let mode = await readMode(directory)
  let disposed = false
  let inFlight = false

  await registerCodexLbCommand(api, { directory })

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
