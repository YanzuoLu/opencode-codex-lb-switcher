// opencode-codex-lb-switcher
//
// Registers a `codex-lb` provider that reuses OpenCode's built-in @ai-sdk/openai
// Responses code path (so reasoning/encrypted-content behaves like native OpenAI)
// but routes each turn through codex-lb's `/v1/responses` WebSocket. One socket per
// conversation keeps codex-lb pinned to a single upstream account, which is what the
// load balancer needs for session/account consistency. Switch by picking
// `codex-lb/<model>` in the model picker; native `openai` (OAuth) is left untouched.

import { createWebSocketFetch } from "./src/ws-pool.js"

const SERVICE = "opencode-codex-lb-switcher"
export const PROVIDER_ID = "codex-lb"
const ALLOWED_OPTIONS = new Set(["baseURL", "apiKey", "models", "providerID"])

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
  const result = {
    baseURL: readStringOption(options, "baseURL").replace(/\/+$/, ""),
    apiKey: readStringOption(options, "apiKey"),
  }
  if (options.models !== undefined) {
    if (!options.models || typeof options.models !== "object" || Array.isArray(options.models)) {
      throw new Error(`${SERVICE}: models must be an object`)
    }
    result.models = options.models
  }
  if (options.providerID !== undefined) result.providerID = readStringOption(options, "providerID")
  return result
}

function reasoningModel(name, { context = 272000, output = 128000, attachment = true } = {}) {
  return {
    name,
    reasoning: true,
    tool_call: true,
    attachment,
    release_date: "2026-01-01",
    options: { reasoningEffort: "medium", reasoningSummary: "auto", textVerbosity: "low" },
    limit: { context, output },
  }
}

export function defaultModels() {
  return {
    "gpt-5.5": reasoningModel("GPT-5.5"),
    "gpt-5.4": reasoningModel("GPT-5.4"),
    "gpt-5.4-mini": reasoningModel("GPT-5.4-Mini"),
    "gpt-5.3-codex-spark": reasoningModel("GPT-5.3-Codex-Spark", { context: 128000, attachment: false }),
  }
}

export function buildProviderConfig(options, websocketFetch) {
  return {
    npm: "@ai-sdk/openai",
    name: "Codex-LB",
    options: {
      baseURL: options.baseURL,
      apiKey: options.apiKey,
      // Restore the two behaviors OpenCode otherwise reserves for providerID "openai".
      setCacheKey: true,
      headerTimeout: 10000,
      fetch: websocketFetch,
    },
    models: options.models ?? defaultModels(),
  }
}

function providerIDOf(input) {
  return input?.provider?.info?.id ?? input?.model?.providerID
}

export async function server(_input, rawOptions, testOptions = {}) {
  const options = normalizeOptions(rawOptions)
  const providerID = options.providerID ?? PROVIDER_ID
  const websocketFetch = testOptions.websocketFetch ?? createWebSocketFetch({ WebSocketImpl: testOptions.WebSocketImpl })

  return {
    async config(config) {
      if (!config.provider || typeof config.provider !== "object") config.provider = {}
      config.provider[providerID] = buildProviderConfig(options, websocketFetch)
    },
    async "chat.headers"(input, output) {
      const pid = providerIDOf(input)
      if (pid !== undefined && pid !== providerID) return
      if (!output?.headers || typeof output.headers !== "object") return
      output.headers["session-id"] = input.sessionID
    },
    async event({ event }) {
      if (event?.type !== "session.deleted") return
      const id = event.properties?.info?.id ?? event.properties?.sessionID ?? event.sessionID
      if (id) websocketFetch.remove(id)
    },
    async dispose() {
      websocketFetch.close()
    },
  }
}

export default { id: SERVICE, server }
