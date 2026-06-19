import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  COMMAND,
  applyCodexLbConfig,
  createCodexLbFetch,
  injectCommand,
  normalizeOptions,
  parseCommand,
  readMode,
  server,
  stateFileFor,
  switchMode,
  toggleMode,
  writeMode,
} from "../index.js"
import { indicatorText } from "../tui.js"

async function tempDir() {
  return mkdtemp(join(tmpdir(), "oc-clb-"))
}

function makeClient() {
  const calls = []
  return {
    calls,
    instance: {
      async dispose(input) {
        calls.push(input ?? null)
        return true
      },
    },
  }
}

test("normalizeOptions accepts only baseURL and apiKey", () => {
  assert.deepEqual(normalizeOptions({ baseURL: "http://127.0.0.1:2455/v1/", apiKey: " sk " }), {
    baseURL: "http://127.0.0.1:2455/v1",
    apiKey: "sk",
  })
  assert.throws(() => normalizeOptions({ baseURL: "http://x", apiKey: "sk", models: [] }), /unsupported option/)
  assert.throws(() => normalizeOptions({ baseURL: "", apiKey: "sk" }), /baseURL/)
  assert.throws(() => normalizeOptions({ baseURL: "http://x", apiKey: "" }), /apiKey/)
})

test("state defaults to openai and persists codex-lb", async () => {
  const dir = await tempDir()
  const root = await tempDir()
  try {
    assert.equal(await readMode(dir, root), "openai")
    await writeMode(dir, "codex-lb", root)
    assert.equal(await readMode(dir, root), "codex-lb")
    assert.equal(stateFileFor(dir, root).startsWith(root), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("toggleMode flips between openai and codex-lb", () => {
  assert.equal(toggleMode("openai"), "codex-lb")
  assert.equal(toggleMode("codex-lb"), "openai")
})

test("injectCommand only adds /codex-lb", () => {
  const cfg = { command: { existing: { template: "Keep", description: "Keep" } } }
  injectCommand(cfg)
  assert.deepEqual(Object.keys(cfg.command).sort(), [COMMAND, "existing"].sort())
  assert.equal(cfg.command[COMMAND].description, "Toggle codex-lb mode for this workspace")
  assert.equal(cfg.command[COMMAND].template, "Toggle codex-lb mode for this workspace.")
  assert.equal("prompt" in cfg.command[COMMAND], false)
})

test("parseCommand toggles current mode and rejects arguments", () => {
  assert.deepEqual(parseCommand("codex-lb", "", "openai"), { from: "openai", to: "codex-lb" })
  assert.deepEqual(parseCommand("codex-lb", "--force", "codex-lb"), { error: "usage" })
  assert.equal(parseCommand("codex-lb-status", "", "openai"), undefined)
  assert.equal(parseCommand("codex-lb-on", "", "openai"), undefined)
  assert.equal(parseCommand("codex-lb-off", "", "openai"), undefined)
})

test("createCodexLbFetch rewrites v1 URLs and injects bearer auth", async () => {
  const calls = []
  const upstream = async (input, init) => {
    const request = new Request(input, init)
    calls.push({ url: request.url, auth: request.headers.get("authorization") })
    return new Response("{}", { status: 200 })
  }
  const wrapped = createCodexLbFetch({ baseURL: "http://127.0.0.1:2455/v1", apiKey: "sk-clb" }, upstream)

  await wrapped("https://api.openai.com/v1/responses", { method: "POST" })
  await wrapped("https://api.openai.com/v1/models")

  assert.deepEqual(calls, [
    { url: "http://127.0.0.1:2455/v1/responses", auth: "Bearer sk-clb" },
    { url: "http://127.0.0.1:2455/v1/models", auth: "Bearer sk-clb" },
  ])
})

test("createCodexLbFetch preserves Request method, body, signal, and query", async () => {
  const controller = new AbortController()
  const calls = []
  const upstream = async (input, init) => {
    const request = new Request(input, init)
    calls.push({
      url: request.url,
      method: request.method,
      auth: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      body: await request.text(),
      signal: request.signal,
    })
    return new Response("{}", { status: 200 })
  }
  const wrapped = createCodexLbFetch({ baseURL: "http://127.0.0.1:2455/v1", apiKey: "sk-clb" }, upstream)
  const request = new Request("https://api.openai.com/v1/responses?stream=true", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hello" }),
    signal: controller.signal,
  })

  await wrapped(request)

  assert.equal(calls[0].url, "http://127.0.0.1:2455/v1/responses?stream=true")
  assert.equal(calls[0].method, "POST")
  assert.equal(calls[0].auth, "Bearer sk-clb")
  assert.equal(calls[0].contentType, "application/json")
  assert.equal(calls[0].body, JSON.stringify({ input: "hello" }))
  assert.equal(calls[0].signal.aborted, false)
  controller.abort()
  assert.equal(calls[0].signal.aborted, true)
})

test("applyCodexLbConfig mutates only runtime openai options", () => {
  const cfg = {}
  applyCodexLbConfig(cfg, { baseURL: "http://127.0.0.1:2455/v1", apiKey: "sk-clb" })
  assert.equal(cfg.provider.openai.options.baseURL, "http://127.0.0.1:2455/v1")
  assert.equal(cfg.provider.openai.options.apiKey, "sk-clb")
  assert.equal(typeof cfg.provider.openai.options.fetch, "function")
})

test("plugin does not mutate provider config in openai mode", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  try {
    const hooks = await server({ client: makeClient(), directory: dir }, { baseURL: "http://127.0.0.1:2455/v1", apiKey: "sk" }, { stateRoot })
    const cfg = {}
    await hooks.config(cfg)
    assert.deepEqual(cfg.provider, undefined)
    assert.equal(Object.keys(cfg.command).includes(COMMAND), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("plugin mutates provider config in codex-lb mode", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  try {
    await writeMode(dir, "codex-lb", stateRoot)
    const hooks = await server({ client: makeClient(), directory: dir }, { baseURL: "http://127.0.0.1:2455/v1", apiKey: "sk" }, { stateRoot })
    const cfg = {}
    await hooks.config(cfg)
    assert.equal(cfg.provider.openai.options.baseURL, "http://127.0.0.1:2455/v1")
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("/codex-lb queues switch until the matching session is idle", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const client = makeClient()
  try {
    const hooks = await server({ client, directory: dir }, { baseURL: "http://127.0.0.1:2455/v1", apiKey: "sk" }, { stateRoot })
    const output = { parts: [] }

    await hooks["command.execute.before"]({ command: "codex-lb", arguments: "", sessionID: "ses" }, output)
    assert.equal(client.calls.length, 0)
    assert.match(output.parts[0].text, /queued/)

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "other" } } })
    assert.equal(client.calls.length, 0)
    assert.equal(await readMode(dir, stateRoot), "openai")

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses" } } })
    assert.equal(client.calls.length, 1)
    assert.equal(await readMode(dir, stateRoot), "codex-lb")
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("/codex-lb mutates the existing output parts array", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  try {
    const hooks = await server({ client: makeClient(), directory: dir }, { baseURL: "http://127.0.0.1:2455/v1", apiKey: "sk" }, { stateRoot })
    const parts = []
    const output = { parts }

    await hooks["command.execute.before"]({ command: "codex-lb", arguments: "", sessionID: "ses" }, output)

    assert.equal(output.parts, parts)
    assert.equal(parts.length, 1)
    assert.match(parts[0].text, /queued/)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("/codex-lb waits for all queued sessions to become idle", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const client = makeClient()
  try {
    const hooks = await server({ client, directory: dir }, { baseURL: "http://127.0.0.1:2455/v1", apiKey: "sk" }, { stateRoot })

    await hooks["command.execute.before"]({ command: "codex-lb", arguments: "", sessionID: "a" }, { parts: [] })
    await hooks["command.execute.before"]({ command: "codex-lb", arguments: "", sessionID: "b" }, { parts: [] })

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "a" } } })
    assert.equal(client.calls.length, 0)
    assert.equal(await readMode(dir, stateRoot), "openai")

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "b" } } })
    assert.equal(client.calls.length, 1)
    assert.equal(await readMode(dir, stateRoot), "codex-lb")
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("/codex-lb does not switch if a queued session becomes busy again", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const client = makeClient()
  try {
    const hooks = await server({ client, directory: dir }, { baseURL: "http://127.0.0.1:2455/v1", apiKey: "sk" }, { stateRoot })

    await hooks["command.execute.before"]({ command: "codex-lb", arguments: "", sessionID: "a" }, { parts: [] })
    await hooks["command.execute.before"]({ command: "codex-lb", arguments: "", sessionID: "b" }, { parts: [] })

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "a" } } })
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "a", status: { type: "busy" } } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "b" } } })

    assert.equal(client.calls.length, 0)
    assert.equal(await readMode(dir, stateRoot), "openai")

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "a" } } })
    assert.equal(client.calls.length, 1)
    assert.equal(await readMode(dir, stateRoot), "codex-lb")
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("/codex-lb rejects arguments and does not switch", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const client = makeClient()
  try {
    const hooks = await server({ client, directory: dir }, { baseURL: "http://127.0.0.1:2455/v1", apiKey: "sk" }, { stateRoot })
    const output = { parts: [] }
    await hooks["command.execute.before"]({ command: "codex-lb", arguments: "--force", sessionID: "ses" }, output)
    assert.equal(client.calls.length, 0)
    assert.match(output.parts[0].text, /usage: \/codex-lb/)

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses" } } })
    assert.equal(client.calls.length, 0)
    assert.equal(await readMode(dir, stateRoot), "openai")
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("switchMode writes the next mode and disposes the instance", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const client = makeClient()
  try {
    await switchMode({ client, directory: dir, mode: "codex-lb", stateRoot })
    assert.equal(client.calls.length, 1)
    assert.equal(await readMode(dir, stateRoot), "codex-lb")
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("indicatorText only shows codex-lb mode", () => {
  assert.equal(indicatorText("openai"), "")
  assert.equal(indicatorText("codex-lb"), "codex-lb")
})
