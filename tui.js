import { createElement, insert, setProp } from "@opentui/solid"

import { COMMAND, readMode, toggleMode, writeMode } from "./index.js"

const SERVICE = "opencode-codex-lb-switcher"

export function indicatorText(mode) {
  return mode === "codex-lb" ? "codex-lb" : ""
}

export function sidebarStatusText(mode) {
  return mode === "codex-lb" ? "routing via codex-lb" : "native OpenAI"
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

function messageProviderID(message) {
  return message?.providerID ?? message?.model?.providerID
}

function modelProviderID(model) {
  if (typeof model === "string") return model.split("/", 1)[0]
  return model?.providerID
}

export function isOpenAISession(api, sessionID) {
  if (!sessionID) return false
  const sessionProviderID = api.state?.session?.get?.(sessionID)?.model?.providerID
  if (sessionProviderID) return sessionProviderID === "openai"
  const messages = api.state?.session?.messages?.(sessionID) ?? []
  for (let index = messages.length - 1; index >= 0; index--) {
    const providerID = messageProviderID(messages[index])
    if (providerID) return providerID === "openai"
  }
  const configProviderID = modelProviderID(api.state?.config?.model)
  if (configProviderID) return configProviderID === "openai"
  return true
}

const solidView = { createElement, insert, setProp }

function textNode(value, props = {}, view = solidView) {
  const element = view.createElement("text")
  for (const [key, prop] of Object.entries(props)) view.setProp(element, key, prop)
  view.insert(element, value)
  return element
}

export function createSidebarStatusElement(api, mode, view = solidView) {
  const theme = api.theme?.current ?? {}
  const detailColor = mode === "codex-lb" ? theme.success : theme.textMuted
  return textNode(`Codex LB: ${sidebarStatusText(mode)}`, { fg: detailColor }, view)
}

async function applyMode(api, directory, mode, stateRoot) {
  await writeMode(directory, mode, stateRoot)
  showToast(api, "success", "codex-lb", mode === "codex-lb" ? "codex-lb mode enabled" : "native OpenAI mode enabled")
  requestRender(api)
}

async function toggleCodexLbMode(api, directory, stateRoot, pendingBySession) {
  const mode = await readMode(directory, stateRoot)
  const nextMode = toggleMode(mode)
  const sessionID = currentSessionID(api)
  if (isSessionBusy(api, sessionID)) {
    pendingBySession.set(sessionID, nextMode)
    showToast(api, "info", "codex-lb", "Switch queued until this session is idle")
    return
  }
  await applyMode(api, directory, nextMode, stateRoot)
}

function commandFields() {
  return {
    title: "Toggle codex-lb",
    value: COMMAND,
    description: "Toggle codex-lb mode",
    slash: {
      name: COMMAND,
    },
  }
}

export async function registerCodexLbCommand(api, { directory, stateRoot }) {
  const pendingBySession = new Map()
  const unregisterIdle = api.event?.on?.("session.idle", async (event = {}) => {
    const sessionID = event.properties?.sessionID ?? event.sessionID
    const nextMode = pendingBySession.get(sessionID)
    if (!nextMode) return
    pendingBySession.delete(sessionID)
    await applyMode(api, directory, nextMode, stateRoot)
  })

  let unregisterCommand
  if (typeof api.keymap?.registerLayer === "function") {
    unregisterCommand = api.keymap.registerLayer({
      priority: 900,
      commands: [
        {
          namespace: "palette",
          name: COMMAND,
          desc: "Toggle codex-lb mode",
          slashName: COMMAND,
          ...commandFields(),
          async run() {
            await toggleCodexLbMode(api, directory, stateRoot, pendingBySession)
            return true
          },
        },
      ],
    })
  } else if (typeof api.command?.register === "function") {
    unregisterCommand = api.command.register(() => [
      {
        ...commandFields(),
        async onSelect() {
          await toggleCodexLbMode(api, directory, stateRoot, pendingBySession)
        },
      },
    ])
  } else {
    unregisterIdle?.()
    return () => {}
  }

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

export async function registerSidebarStatus(api, { directory, stateRoot }) {
  if (typeof api.slots?.register !== "function") return () => {}

  let mode = await readMode(directory, stateRoot)
  let disposed = false
  let inFlight = false

  async function refresh() {
    if (disposed || inFlight) return
    inFlight = true
    try {
      const next = await readMode(directory, stateRoot)
      if (next !== mode) {
        mode = next
        requestRender(api)
      }
    } finally {
      inFlight = false
    }
  }

  api.slots.register({
    order: 160,
    slots: {
      sidebar_content(_ctx, props = {}) {
        if (!isOpenAISession(api, props.session_id)) return null
        return createSidebarStatusElement(api, mode)
      },
    },
  })

  const timer = setInterval(refresh, 1000)
  const dispose = () => {
    disposed = true
    clearInterval(timer)
  }
  api.lifecycle?.onDispose?.(dispose)
  return dispose
}

export async function tui(api) {
  const directory = directoryFor(api)

  await registerCodexLbCommand(api, { directory })
  await registerSidebarStatus(api, { directory })
}

export default {
  id: `${SERVICE}:tui`,
  tui,
}
