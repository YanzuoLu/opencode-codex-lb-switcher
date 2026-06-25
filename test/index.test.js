import test from "node:test"
import assert from "node:assert/strict"

import plugin, { PROVIDER_ID, buildProviderConfig, defaultModels, normalizeOptions, server } from "../index.js"

function recordingFetch() {
  const calls = []
  const fn = Object.assign(() => {}, {
    calls,
    remove: (id) => calls.push(["remove", id]),
    close: () => calls.push(["close"]),
  })
  return fn
}

test("normalizeOptions requires baseURL and apiKey, strips trailing slash, rejects unknown", () => {
  assert.deepEqual(normalizeOptions({ baseURL: "https://lb/v1/", apiKey: " sk " }), {
    baseURL: "https://lb/v1",
    apiKey: "sk",
  })
  assert.throws(() => normalizeOptions({ baseURL: "https://lb/v1", apiKey: "sk", oops: 1 }), /unsupported option/)
  assert.throws(() => normalizeOptions({ baseURL: "", apiKey: "sk" }), /baseURL/)
  assert.throws(() => normalizeOptions({ baseURL: "https://lb", apiKey: "" }), /apiKey/)
})

test("defaultModels returns a non-empty catalog including gpt-5.5", () => {
  const models = defaultModels()
  assert.ok(Object.keys(models).length > 0)
  assert.ok(models["gpt-5.5"])
  assert.equal(models["gpt-5.5"].reasoning, true)
})

test("buildProviderConfig produces an @ai-sdk/openai provider scoped to codex-lb", () => {
  const fetchFn = recordingFetch()
  const cfg = buildProviderConfig({ baseURL: "https://lb/v1", apiKey: "sk-clb" }, fetchFn)
  assert.equal(cfg.npm, "@ai-sdk/openai")
  assert.equal(cfg.options.baseURL, "https://lb/v1")
  assert.equal(cfg.options.apiKey, "sk-clb")
  assert.equal(cfg.options.setCacheKey, true)
  assert.equal(cfg.options.headerTimeout, 10000)
  assert.equal(cfg.options.fetch, fetchFn)
  assert.ok(Object.keys(cfg.models).length > 0)
})

test("server config hook registers the codex-lb provider and leaves openai untouched", async () => {
  const fetchFn = recordingFetch()
  const hooks = await server({ directory: "/tmp/x" }, { baseURL: "https://lb/v1/", apiKey: "sk-clb" }, { websocketFetch: fetchFn })
  const config = { provider: { openai: { models: { "gpt-5.5": { options: { websearch: "auto" } } } } } }

  await hooks.config(config)

  const p = config.provider[PROVIDER_ID]
  assert.equal(p.npm, "@ai-sdk/openai")
  assert.equal(p.options.baseURL, "https://lb/v1")
  assert.equal(p.options.fetch, fetchFn)
  assert.equal(p.options.setCacheKey, true)
  assert.deepEqual(config.provider.openai.models["gpt-5.5"].options, { websearch: "auto" })
})

test("server config hook creates provider map when absent", async () => {
  const hooks = await server({ directory: "/tmp/x" }, { baseURL: "https://lb/v1", apiKey: "sk" }, { websocketFetch: recordingFetch() })
  const config = {}
  await hooks.config(config)
  assert.ok(config.provider[PROVIDER_ID])
})

test("chat.headers injects session-id for codex-lb requests only", async () => {
  const hooks = await server({ directory: "/tmp/x" }, { baseURL: "https://lb/v1", apiKey: "sk" }, { websocketFetch: recordingFetch() })

  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: "ses1", provider: { info: { id: PROVIDER_ID } }, model: {} }, out)
  assert.equal(out.headers["session-id"], "ses1")

  const other = { headers: {} }
  await hooks["chat.headers"]({ sessionID: "ses1", provider: { info: { id: "anthropic" } }, model: {} }, other)
  assert.equal("session-id" in other.headers, false)
})

test("session.deleted removes the pooled socket and dispose closes the pool", async () => {
  const fetchFn = recordingFetch()
  const hooks = await server({ directory: "/tmp/x" }, { baseURL: "https://lb/v1", apiKey: "sk" }, { websocketFetch: fetchFn })

  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "sesD" } } } })
  await hooks.dispose()

  assert.deepEqual(fetchFn.calls, [["remove", "sesD"], ["close"]])
})

test("plugin default export is a server module, not a tui module", () => {
  assert.equal(typeof plugin.server, "function")
  assert.equal(plugin.tui, undefined)
  assert.equal(typeof plugin.id, "string")
})
