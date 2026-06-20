import { COMMAND, readMode, toggleMode, writeMode } from "./index.js"

const SERVICE = "opencode-codex-lb-switcher"
const modeListeners = new Map()

function modeKey(directory, stateRoot) {
  return `${stateRoot ?? ""}\0${directory}`
}

function subscribeMode(directory, stateRoot, listener) {
  const key = modeKey(directory, stateRoot)
  const listeners = modeListeners.get(key) ?? new Set()
  listeners.add(listener)
  modeListeners.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) modeListeners.delete(key)
  }
}

function notifyMode(directory, stateRoot, mode) {
  for (const listener of modeListeners.get(modeKey(directory, stateRoot)) ?? []) listener(mode)
}

export function indicatorText(mode) {
  return mode === "codex-lb" ? "codex-lb" : ""
}

export function sidebarStatusText(mode) {
  return mode === "codex-lb" ? "enabled: on" : "enabled: off"
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
  return status?.type === "busy" || status?.type === "retry"
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
  return false
}

export function sidebarSessionID(api, props = {}) {
  return props.session_id ?? currentSessionID(api)
}

let defaultSolidView

async function loadSolidView() {
  if (defaultSolidView) return defaultSolidView
  let solid
  let solidJs
  if (typeof Bun !== "undefined") {
    await import("@opentui/solid/runtime-plugin-support")
    solid = await import("opentui:runtime-module:%40opentui%2Fsolid")
    solidJs = await import("opentui:runtime-module:solid-js")
  } else {
    solid = await import("@opentui/solid")
    solidJs = await import("solid-js")
  }
  const { createElement, insert, setProp } = solid
  const { createSignal } = solidJs
  defaultSolidView = { createElement, createSignal, insert, setProp }
  return defaultSolidView
}

function elementNode(type, props = {}, children = [], view = defaultSolidView) {
  const element = view.createElement(type)
  for (const [key, prop] of Object.entries(props)) {
    if (prop !== undefined) view.setProp(element, key, prop)
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) view.insert(element, child)
  }
  return element
}

function textNode(value, props = {}, view = defaultSolidView) {
  return elementNode("text", props, [value], view)
}

export function createSidebarStatusElement(api, mode, view = defaultSolidView) {
  if (!view) throw new Error(`${SERVICE}: TUI runtime is not initialized`)
  const theme = api.theme?.current ?? api.theme ?? {}
  return elementNode(
    "box",
    { width: "100%", flexDirection: "column" },
    [textNode("Codex-LB", { fg: theme.text }, view), textNode(sidebarStatusText(mode), { fg: theme.textMuted }, view)],
    view,
  )
}

async function applyMode(api, directory, mode, stateRoot) {
  await writeMode(directory, mode, stateRoot)
  notifyMode(directory, stateRoot, mode)
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

export async function registerSidebarStatus(api, { directory, stateRoot, view: runtimeView }) {
  if (typeof api.slots?.register !== "function") return () => {}

  const view = runtimeView ?? (await loadSolidView())
  const initialMode = await readMode(directory, stateRoot)
  let fallbackMode = initialMode
  const [mode, setMode] =
    typeof view.createSignal === "function"
      ? view.createSignal(initialMode)
      : [
          () => fallbackMode,
          (nextMode) => {
            fallbackMode = nextMode
          },
        ]
  let disposed = false
  let inFlight = false

  const unsubscribeMode = subscribeMode(directory, stateRoot, (nextMode) => {
    if (nextMode === mode()) return
    setMode(nextMode)
    requestRender(api)
  })

  async function refresh() {
    if (disposed || inFlight) return
    inFlight = true
    try {
      const next = await readMode(directory, stateRoot)
      if (next !== mode()) {
        setMode(next)
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
        const sessionID = sidebarSessionID(api, props)
        if (!isOpenAISession(api, sessionID)) return null
        return createSidebarStatusElement(api, mode(), view)
      },
    },
  })

  const timer = setInterval(refresh, 1000)
  const dispose = () => {
    disposed = true
    unsubscribeMode()
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
