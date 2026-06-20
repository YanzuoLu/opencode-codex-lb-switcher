import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const COMMAND = "codex-lb"
const SERVICE = "opencode-codex-lb-switcher"
const ALLOWED_OPTIONS = new Set(["baseURL", "apiKey"])
const FETCH_ROUTER_STATE = Symbol.for(`${SERVICE}.fetch-router-state`)

function defaultStateRoot() {
  return join(homedir(), ".local", "share", SERVICE)
}

function workspaceKey(directory) {
  return createHash("sha256").update(directory).digest("hex").slice(0, 24)
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

function toURL(input) {
  if (input instanceof URL) return input
  if (typeof input === "string") return new URL(input)
  return new URL(input.url)
}

export function shouldRewriteURL(input) {
  let url
  try {
    url = toURL(input)
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  if (url.hostname === "api.openai.com" && url.pathname.startsWith("/v1/")) return true
  if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex/")) return true
  return false
}

function rewriteSuffix(url) {
  if (url.hostname === "api.openai.com") return url.pathname.replace(/^\/v1\/?/, "")
  if (url.hostname === "chatgpt.com") return url.pathname.replace(/^\/backend-api\/codex\/?/, "")
  return url.pathname.replace(/^\/+/, "")
}

export function rewriteCodexLbURL(input, baseURL) {
  const original = toURL(input)
  const base = new URL(baseURL.endsWith("/") ? baseURL : `${baseURL}/`)
  return new URL(`${rewriteSuffix(original)}${original.search}`, base)
}

function hasInit(init) {
  return init && Object.keys(init).length > 0
}

function callFetch(upstream, input, init) {
  return init === undefined ? upstream(input) : upstream(input, init)
}

function rewriteFetchArgs(input, init, options) {
  const rewritten = rewriteCodexLbURL(input, options.baseURL)
  if (input instanceof Request) {
    let request = new Request(rewritten, input)
    if (hasInit(init)) request = new Request(request, init)
    const headers = new Headers(request.headers)
    headers.set("authorization", `Bearer ${options.apiKey}`)
    return [new Request(request, { headers }), undefined]
  }

  const headers = new Headers(init?.headers)
  headers.set("authorization", `Bearer ${options.apiKey}`)
  return [rewritten, { ...init, headers }]
}

export function createCodexLbFetch(options, upstream = fetch) {
  return async (input, init) => {
    if (!shouldRewriteURL(input)) return callFetch(upstream, input, init)

    const [nextInput, nextInit] = rewriteFetchArgs(input, init, options)
    return callFetch(upstream, nextInput, nextInit)
  }
}

export function createModeRoutingFetch({ directory, stateRoot, options, upstream = fetch }) {
  return async (input, init) => {
    if ((await readMode(directory, stateRoot)) !== "codex-lb") return callFetch(upstream, input, init)
    if (!shouldRewriteURL(input)) return callFetch(upstream, input, init)

    const [nextInput, nextInit] = rewriteFetchArgs(input, init, options)
    return callFetch(upstream, nextInput, nextInit)
  }
}

function createGlobalFetchDispatcher(fetchGlobal, state) {
  return async (input, init) => {
    let upstream = (nextInput, nextInit) => callFetch((finalInput, finalInit) => state.original.call(fetchGlobal, finalInput, finalInit), nextInput, nextInit)
    for (const layer of state.layers) upstream = createModeRoutingFetch({ ...layer, upstream })
    return callFetch(upstream, input, init)
  }
}

function createGlobalFetchState(fetchGlobal) {
  const state = {
    original: fetchGlobal.fetch,
    layers: [],
    dispatcher: undefined,
  }
  state.dispatcher = createGlobalFetchDispatcher(fetchGlobal, state)
  return state
}

function enableGlobalFetchDispatcher(fetchGlobal, state) {
  if (fetchGlobal.fetch === state.original || fetchGlobal.fetch === state.dispatcher) fetchGlobal.fetch = state.dispatcher
}

export function installGlobalFetchRouter({ directory, stateRoot, options, fetchGlobal = globalThis }) {
  const state = fetchGlobal[FETCH_ROUTER_STATE] ?? createGlobalFetchState(fetchGlobal)
  fetchGlobal[FETCH_ROUTER_STATE] = state

  const layer = { directory, stateRoot, options }
  state.layers.push(layer)
  enableGlobalFetchDispatcher(fetchGlobal, state)

  return async () => {
    const index = state.layers.indexOf(layer)
    if (index === -1) return
    state.layers.splice(index, 1)
    if (state.layers.length === 0 && fetchGlobal.fetch === state.dispatcher) {
      fetchGlobal.fetch = state.original
      delete fetchGlobal[FETCH_ROUTER_STATE]
    }
  }
}

export async function server({ directory }, rawOptions, testOptions = {}) {
  const options = normalizeOptions(rawOptions)
  const stateRoot = testOptions.stateRoot
  const restoreFetch = installGlobalFetchRouter({ directory, stateRoot, options, fetchGlobal: testOptions.fetchGlobal ?? globalThis })

  return {
    async dispose() {
      await restoreFetch()
    },
  }
}

export default {
  id: SERVICE,
  server,
}
