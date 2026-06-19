import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const COMMAND = "codex-lb"
const SERVICE = "opencode-codex-lb-switcher"
const ALLOWED_OPTIONS = new Set(["baseURL", "apiKey"])

function defaultStateRoot() {
  return join(homedir(), ".local", "share", SERVICE)
}

function workspaceKey(directory) {
  return createHash("sha256").update(directory).digest("hex").slice(0, 24)
}

function textPart(text) {
  return { type: "text", text }
}

function setOutputParts(output, parts) {
  output.parts.splice(0, output.parts.length, ...parts)
}

function readStringOption(record, key) {
  const value = record[key]
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${SERVICE}: ${key} must be a non-empty string`)
  }
  return value.trim()
}

export function normalizeOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error(`${SERVICE}: options must be an object`)
  }
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.has(key)) throw new Error(`${SERVICE}: unsupported option ${key}`)
  }
  return {
    baseURL: readStringOption(options, "baseURL").replace(/\/+$/, ""),
    apiKey: readStringOption(options, "apiKey"),
  }
}

export function stateFileFor(directory, stateRoot = defaultStateRoot()) {
  return join(stateRoot, `${workspaceKey(directory)}.json`)
}

export async function readMode(directory, stateRoot = defaultStateRoot()) {
  try {
    const parsed = JSON.parse(await readFile(stateFileFor(directory, stateRoot), "utf8"))
    return parsed.mode === "codex-lb" ? "codex-lb" : "openai"
  } catch {
    return "openai"
  }
}

export async function writeMode(directory, mode, stateRoot = defaultStateRoot()) {
  await mkdir(stateRoot, { recursive: true })
  await writeFile(stateFileFor(directory, stateRoot), JSON.stringify({ mode }, null, 2))
}

export function toggleMode(mode) {
  return mode === "codex-lb" ? "openai" : "codex-lb"
}

export function injectCommand(config) {
  config.command ??= {}
  config.command[COMMAND] = {
    description: "Toggle codex-lb mode for this workspace",
    template: "Toggle codex-lb mode for this workspace.",
  }
}

export function parseCommand(command, args = "", currentMode = "openai") {
  if (command !== COMMAND) return undefined
  if (String(args).trim() !== "") return { error: "usage" }
  return { from: currentMode, to: toggleMode(currentMode) }
}

export function switchMessage(from, to) {
  const target = to === "codex-lb" ? "codex-lb" : "native OpenAI"
  const source = from === "codex-lb" ? "codex-lb" : "native OpenAI"
  return `${SERVICE}: switching from ${source} to ${target}; reload queued until this session is idle.`
}

function toURL(input) {
  if (input instanceof URL) return input
  if (typeof input === "string") return new URL(input)
  return new URL(input.url)
}

function rewriteURL(input, baseURL) {
  const original = toURL(input)
  const base = new URL(baseURL.endsWith("/") ? baseURL : `${baseURL}/`)
  const suffix = `${original.pathname.replace(/^\/v1\/?/, "")}${original.search}`
  return new URL(suffix, base)
}

export function createCodexLbFetch(options, upstream = fetch) {
  return async (input, init = {}) => {
    const rewritten = rewriteURL(input, options.baseURL)
    let request = input instanceof Request ? new Request(rewritten, input) : new Request(rewritten, init)
    if (input instanceof Request && Object.keys(init).length > 0) request = new Request(request, init)
    const headers = new Headers(request.headers)
    headers.set("authorization", `Bearer ${options.apiKey}`)
    return upstream(new Request(request, { headers }))
  }
}

export function applyCodexLbConfig(config, options) {
  config.provider ??= {}
  config.provider.openai ??= {}
  config.provider.openai.options ??= {}
  config.provider.openai.options.baseURL = options.baseURL
  config.provider.openai.options.apiKey = options.apiKey
  config.provider.openai.options.fetch = createCodexLbFetch(options)
}

async function disposeInstance(client) {
  const dispose = client?.instance?.dispose
  if (typeof dispose !== "function") throw new Error(`${SERVICE}: OpenCode client does not expose instance.dispose`)
  try {
    await dispose({})
  } catch (error) {
    if (error instanceof TypeError) await dispose()
    else throw error
  }
}

export async function switchMode({ client, directory, mode, stateRoot }) {
  await writeMode(directory, mode, stateRoot)
  await disposeInstance(client)
}

export async function server({ client, directory }, rawOptions, testOptions = {}) {
  const options = normalizeOptions(rawOptions)
  const stateRoot = testOptions.stateRoot
  let mode = await readMode(directory, stateRoot)
  const pending = new Map()
  const busy = new Set()
  let readyMode = undefined

  async function switchAndDispose(nextMode) {
    await switchMode({ client, directory, mode: nextMode, stateRoot })
    mode = nextMode
    readyMode = undefined
  }

  async function maybeSwitch() {
    if (!readyMode) return
    if (pending.size > 0) return
    if (busy.size > 0) return
    await switchAndDispose(readyMode)
  }

  async function markIdle(sessionID) {
    busy.delete(sessionID)
    const nextMode = pending.get(sessionID)
    if (nextMode) {
      pending.delete(sessionID)
      if (pending.size === 0) readyMode = nextMode
    }
    await maybeSwitch()
  }

  return {
    async config(config) {
      injectCommand(config)
      if (mode === "codex-lb") applyCodexLbConfig(config, options)
    },
    async "command.execute.before"(input, output) {
      const parsed = parseCommand(input.command, input.arguments, mode)
      if (!parsed) return
      if (parsed.error) {
        setOutputParts(output, [textPart(`${SERVICE}: usage: /${COMMAND}`)])
        return
      }

      setOutputParts(output, [textPart(switchMessage(parsed.from, parsed.to))])
      pending.set(input.sessionID, parsed.to)
      busy.add(input.sessionID)
      readyMode = undefined
    },
    async event(input) {
      if (input.event.type === "session.status") {
        const sessionID = input.event.properties?.sessionID
        if (input.event.properties?.status?.type === "idle") await markIdle(sessionID)
        else if (sessionID) busy.add(sessionID)
        return
      }
      if (input.event.type !== "session.idle") return
      await markIdle(input.event.properties?.sessionID)
    },
  }
}

export default {
  id: SERVICE,
  server,
}
