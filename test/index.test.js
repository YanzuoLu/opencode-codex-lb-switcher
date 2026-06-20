import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import plugin, {
  COMMAND,
  createCodexLbFetch,
  createModeRoutingFetch,
  installGlobalFetchRouter,
  normalizeOptions,
  readMode,
  server,
  shouldRewriteURL,
  stateFileFor,
  toggleMode,
  rewriteCodexLbURL,
  writeMode,
} from "../index.js"
import tuiPlugin, { indicatorText, registerCodexLbCommand } from "../tui.js"

async function tempDir() {
  return mkdtemp(join(tmpdir(), "oc-clb-"))
}

function makeRouteOptions() {
  return { baseURL: "http://127.0.0.1:2455/v1", apiKey: "sk-clb" }
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

function makeTuiApi(
  directory,
  statusBySession = new Map([["ses", { type: "idle" }]]),
  sessionByID = new Map([["ses", { model: { providerID: "openai" } }]]),
  messagesBySession = new Map(),
) {
  const commands = []
  const events = new Map()
  const toasts = []
  const renders = []
  const slots = []
  const disposers = []
  return {
    commands,
    events,
    toasts,
    renders,
    slotRegistrations: slots,
    disposers,
    state: {
      path: { directory, worktree: directory },
      session: {
        get(sessionID) {
          return sessionByID.get(sessionID)
        },
        status(sessionID) {
          return statusBySession.get(sessionID)
        },
        messages(sessionID) {
          return messagesBySession.get(sessionID) ?? []
        },
      },
    },
    route: { current: { name: "session", params: { sessionID: "ses" } } },
    command: {
      register(callback) {
        commands.push(callback)
        return () => {}
      },
    },
    event: {
      on(type, handler) {
        events.set(type, handler)
        return () => {}
      },
    },
    ui: {
      toast(input) {
        toasts.push(input)
      },
    },
    renderer: {
      requestRender() {
        renders.push(true)
      },
    },
    theme: {
      current: {
        text: "text",
        textMuted: "muted",
        success: "success",
        warning: "warning",
        error: "error",
      },
    },
    lifecycle: {
      onDispose(fn) {
        disposers.push(fn)
        return () => {}
      },
    },
    slots: {
      register(registration) {
        slots.push(registration)
        return "slot"
      },
    },
  }
}

function makeKeymapTuiApi(directory, statusBySession = new Map([["ses", { type: "idle" }]])) {
  const api = makeTuiApi(directory, statusBySession)
  const layers = []
  delete api.command
  api.keymap = {
    registerLayer(layer) {
      layers.push(layer)
      return () => {}
    },
  }
  api.layers = layers
  return api
}

function makeOpenTuiView() {
  return {
    createElement(type) {
      return { type, props: {}, children: [] }
    },
    insert(parent, child) {
      parent.children.push(child)
    },
    setProp(element, key, value) {
      element.props[key] = value
    },
  }
}

function makeReactiveOpenTuiView() {
  const view = makeOpenTuiView()
  view.signals = []
  view.createSignal = (initial) => {
    let value = initial
    const calls = []
    const getter = () => value
    const setter = (next) => {
      value = next
      calls.push(next)
    }
    view.signals.push({ getter, setter, calls })
    return [getter, setter]
  }
  return view
}

function assertOpenCodeV1PluginShape(value, kind) {
  if (!value || typeof value !== "object") throw new TypeError(`Plugin must default export an object with ${kind}()`)
  if (value.server !== undefined && typeof value.server !== "function") throw new TypeError("invalid server export")
  if (value.tui !== undefined && typeof value.tui !== "function") throw new TypeError("invalid tui export")
  if (value.server !== undefined && value.tui !== undefined) throw new TypeError("must default export either server() or tui(), not both")
  if (kind === "server" && value.server === undefined) throw new TypeError("missing server")
  if (kind === "tui" && value.tui === undefined) throw new TypeError("missing tui")
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

test("server and TUI plugin entries are separate OpenCode modules", () => {
  assert.equal(plugin.server, server)
  assert.equal(plugin.tui, undefined)
  assert.equal(tuiPlugin.server, undefined)
  assert.equal(typeof tuiPlugin.tui, "function")
  assert.doesNotThrow(() => assertOpenCodeV1PluginShape(plugin, "server"))
  assert.doesNotThrow(() => assertOpenCodeV1PluginShape(tuiPlugin, "tui"))
})

test("package includes TUI runtime dependencies", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))

  assert.equal(pkg.dependencies?.["@opentui/solid"], "0.3.4")
  assert.equal(pkg.dependencies?.["solid-js"], "1.9.12")
})

test("createCodexLbFetch rewrites v1 URLs and injects bearer auth", async () => {
  const calls = []
  const upstream = async (input, init) => {
    const request = new Request(input, init)
    calls.push({ url: request.url, auth: request.headers.get("authorization") })
    return new Response("{}", { status: 200 })
  }
  const wrapped = createCodexLbFetch(makeRouteOptions(), upstream)

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
  const wrapped = createCodexLbFetch(makeRouteOptions(), upstream)
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

test("createCodexLbFetch leaves non-target URLs untouched", async () => {
  const originalInput = "https://example.com/v1/responses"
  const originalInit = { method: "POST", headers: { authorization: "Bearer original" }, body: "{}" }
  const calls = []
  const upstream = async (input, init) => {
    calls.push({ input, init })
    return new Response("{}", { status: 200 })
  }
  const wrapped = createCodexLbFetch(makeRouteOptions(), upstream)

  await wrapped(originalInput, originalInit)

  assert.equal(calls[0].input, originalInput)
  assert.equal(calls[0].init, originalInit)
})

test("shouldRewriteURL only matches OpenAI and ChatGPT codex APIs", () => {
  assert.equal(shouldRewriteURL("https://api.openai.com/v1/responses"), true)
  assert.equal(shouldRewriteURL("https://api.openai.com/v1/models?limit=1"), true)
  assert.equal(shouldRewriteURL("https://chatgpt.com/backend-api/codex/responses"), true)
  assert.equal(shouldRewriteURL("http://api.openai.com/v1/responses"), false)
  assert.equal(shouldRewriteURL("/v1/responses"), false)
  assert.equal(shouldRewriteURL("https://example.com/v1/responses"), false)
  assert.equal(shouldRewriteURL("https://api.githubcopilot.com/chat/completions"), false)
})

test("rewriteCodexLbURL maps OpenAI and ChatGPT paths to codex-lb baseURL", () => {
  assert.equal(
    rewriteCodexLbURL("https://api.openai.com/v1/responses?stream=true", "http://127.0.0.1:2455/v1").toString(),
    "http://127.0.0.1:2455/v1/responses?stream=true",
  )
  assert.equal(
    rewriteCodexLbURL("https://chatgpt.com/backend-api/codex/responses", "http://127.0.0.1:2455/v1").toString(),
    "http://127.0.0.1:2455/v1/responses",
  )
})

test("createModeRoutingFetch leaves native OpenAI mode byte-for-byte passthrough", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  try {
    const originalInput = "https://api.openai.com/v1/responses"
    const originalInit = { method: "POST", headers: { authorization: "Bearer openai" }, body: "{}" }
    const calls = []
    const upstream = async (input, init) => {
      calls.push({ input, init })
      return new Response("{}", { status: 200 })
    }
    const routed = createModeRoutingFetch({ directory: dir, stateRoot, options: makeRouteOptions(), upstream })

    await routed(originalInput, originalInit)

    assert.equal(calls[0].input, originalInput)
    assert.equal(calls[0].init, originalInit)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("createModeRoutingFetch routes OpenAI API requests through codex-lb in codex-lb mode", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const calls = []
  const upstream = async (input, init) => {
    const request = new Request(input, init)
    calls.push({
      url: request.url,
      method: request.method,
      auth: request.headers.get("authorization"),
      xTest: request.headers.get("x-test"),
      body: await request.text(),
    })
    return new Response("{}", { status: 200 })
  }
  try {
    await writeMode(dir, "codex-lb", stateRoot)
    const routed = createModeRoutingFetch({ directory: dir, stateRoot, options: makeRouteOptions(), upstream })

    await routed("https://api.openai.com/v1/responses?stream=true", {
      method: "POST",
      headers: { authorization: "Bearer openai", "x-test": "1" },
      body: "{}",
    })

    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:2455/v1/responses?stream=true",
        method: "POST",
        auth: "Bearer sk-clb",
        xTest: "1",
        body: "{}",
      },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("createModeRoutingFetch keeps codex-lb fail-closed after state read failure", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const calls = []
  const upstream = async (input, init) => {
    const request = new Request(input, init)
    calls.push({ url: request.url, auth: request.headers.get("authorization") })
    return new Response("{}", { status: 200 })
  }
  try {
    await writeMode(dir, "codex-lb", stateRoot)
    const routed = createModeRoutingFetch({ directory: dir, stateRoot, options: makeRouteOptions(), upstream })

    await routed("https://api.openai.com/v1/responses", { headers: { authorization: "Bearer openai" } })
    await writeFile(stateFileFor(dir, stateRoot), "{")
    await routed("https://api.openai.com/v1/responses", { headers: { authorization: "Bearer openai" } })

    assert.deepEqual(calls, [
      { url: "http://127.0.0.1:2455/v1/responses", auth: "Bearer sk-clb" },
      { url: "http://127.0.0.1:2455/v1/responses", auth: "Bearer sk-clb" },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("createModeRoutingFetch propagates codex-lb failures without native retry", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const calls = []
  const upstream = async (input, init) => {
    const request = new Request(input, init)
    calls.push(request.url)
    throw new Error("codex-lb unavailable")
  }
  try {
    await writeMode(dir, "codex-lb", stateRoot)
    const routed = createModeRoutingFetch({ directory: dir, stateRoot, options: makeRouteOptions(), upstream })

    await assert.rejects(
      () => routed("https://api.openai.com/v1/responses", { headers: { authorization: "Bearer openai" } }),
      /codex-lb unavailable/,
    )

    assert.deepEqual(calls, ["http://127.0.0.1:2455/v1/responses"])
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("createModeRoutingFetch routes opencode-websearch ChatGPT Responses through codex-lb", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const calls = []
  const upstream = async (input, init) => {
    const request = new Request(input, init)
    calls.push({ url: request.url, auth: request.headers.get("authorization"), userAgent: request.headers.get("user-agent") })
    return new Response("{}", { status: 200 })
  }
  try {
    await writeMode(dir, "codex-lb", stateRoot)
    const routed = createModeRoutingFetch({ directory: dir, stateRoot, options: makeRouteOptions(), upstream })

    await routed("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers: { authorization: "Bearer chatgpt", "user-agent": "opencode-websearch" },
      body: "{}",
    })

    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:2455/v1/responses",
        auth: "Bearer sk-clb",
        userAgent: "opencode-websearch",
      },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("createModeRoutingFetch leaves non-OpenAI requests untouched in codex-lb mode", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  try {
    await writeMode(dir, "codex-lb", stateRoot)
    const originalInput = "https://api.githubcopilot.com/chat/completions"
    const originalInit = { method: "POST", headers: { authorization: "Bearer copilot" }, body: "{}" }
    const calls = []
    const upstream = async (input, init) => {
      calls.push({ input, init })
      return new Response("{}", { status: 200 })
    }
    const routed = createModeRoutingFetch({ directory: dir, stateRoot, options: makeRouteOptions(), upstream })

    await routed(originalInput, originalInit)

    assert.equal(calls[0].input, originalInput)
    assert.equal(calls[0].init, originalInit)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("createModeRoutingFetch leaves relative URLs untouched in codex-lb mode", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  try {
    await writeMode(dir, "codex-lb", stateRoot)
    const originalInput = "/relative/path"
    const originalInit = { method: "GET" }
    const calls = []
    const upstream = async (input, init) => {
      calls.push({ input, init })
      return new Response("{}", { status: 200 })
    }
    const routed = createModeRoutingFetch({ directory: dir, stateRoot, options: makeRouteOptions(), upstream })

    await routed(originalInput, originalInit)

    assert.equal(calls[0].input, originalInput)
    assert.equal(calls[0].init, originalInit)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("installGlobalFetchRouter wraps and restores global fetch safely", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const fetchGlobal = { fetch: async () => new Response("{}", { status: 200 }) }
  const originalFetch = fetchGlobal.fetch
  try {
    const dispose = installGlobalFetchRouter({ directory: dir, stateRoot, options: makeRouteOptions(), fetchGlobal })
    assert.notEqual(fetchGlobal.fetch, originalFetch)
    await dispose()
    assert.equal(fetchGlobal.fetch, originalFetch)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("installGlobalFetchRouter keeps codex-lb fail-closed after state read failure", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const calls = []
  const fetchGlobal = {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push({ url: request.url, auth: request.headers.get("authorization") })
      return new Response("{}", { status: 200 })
    },
  }
  try {
    await writeMode(dir, "codex-lb", stateRoot)
    const dispose = installGlobalFetchRouter({ directory: dir, stateRoot, options: makeRouteOptions(), fetchGlobal })

    await fetchGlobal.fetch("https://api.openai.com/v1/responses", { headers: { authorization: "Bearer openai" } })
    await writeFile(stateFileFor(dir, stateRoot), "{")
    await fetchGlobal.fetch("https://api.openai.com/v1/responses", { headers: { authorization: "Bearer openai" } })
    await dispose()

    assert.deepEqual(calls, [
      { url: "http://127.0.0.1:2455/v1/responses", auth: "Bearer sk-clb" },
      { url: "http://127.0.0.1:2455/v1/responses", auth: "Bearer sk-clb" },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("installGlobalFetchRouter restores original fetch after out-of-order disposals", async () => {
  const dirA = await tempDir()
  const dirB = await tempDir()
  const stateRoot = await tempDir()
  const fetchGlobal = { fetch: async () => new Response("{}", { status: 200 }) }
  const originalFetch = fetchGlobal.fetch
  try {
    const disposeA = installGlobalFetchRouter({ directory: dirA, stateRoot, options: makeRouteOptions(), fetchGlobal })
    const disposeB = installGlobalFetchRouter({ directory: dirB, stateRoot, options: makeRouteOptions(), fetchGlobal })

    await disposeA()
    assert.notEqual(fetchGlobal.fetch, originalFetch)

    await disposeB()
    assert.equal(fetchGlobal.fetch, originalFetch)
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("installGlobalFetchRouter disables routing captured by later external wrappers", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const calls = []
  const fetchGlobal = {
    fetch: async (input, init) => {
      calls.push({ input, init })
      return new Response("{}", { status: 200 })
    },
  }
  try {
    await writeMode(dir, "codex-lb", stateRoot)
    const dispose = installGlobalFetchRouter({ directory: dir, stateRoot, options: makeRouteOptions(), fetchGlobal })
    const pluginFetch = fetchGlobal.fetch
    fetchGlobal.fetch = async (input, init) => pluginFetch(input, init)

    await dispose()
    await fetchGlobal.fetch("https://api.openai.com/v1/responses", { headers: { authorization: "Bearer openai" } })

    assert.equal(calls[0].input, "https://api.openai.com/v1/responses")
    assert.deepEqual(calls[0].init, { headers: { authorization: "Bearer openai" } })
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("installGlobalFetchRouter does not overwrite a later external wrapper on another install", async () => {
  const dirA = await tempDir()
  const dirB = await tempDir()
  const stateRoot = await tempDir()
  const fetchGlobal = { fetch: async () => new Response("{}", { status: 200 }) }
  try {
    const disposeA = installGlobalFetchRouter({ directory: dirA, stateRoot, options: makeRouteOptions(), fetchGlobal })
    const pluginFetch = fetchGlobal.fetch
    const externalFetch = async (input, init) => pluginFetch(input, init)
    fetchGlobal.fetch = externalFetch

    const disposeB = installGlobalFetchRouter({ directory: dirB, stateRoot, options: makeRouteOptions(), fetchGlobal })

    assert.equal(fetchGlobal.fetch, externalFetch)
    await disposeB()
    await disposeA()
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("server installs global fetch router but does not inject prompt command or codex-lb credentials", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const fetchGlobal = { fetch: async () => new Response("{}", { status: 200 }) }
  const originalFetch = fetchGlobal.fetch
  try {
    const hooks = await server({ client: makeClient(), directory: dir }, makeRouteOptions(), { stateRoot, fetchGlobal })
    const cfg = { provider: { openai: { models: { "gpt-5.5": { options: { websearch: "auto" } } } } } }
    await hooks.config?.(cfg)

    assert.notEqual(fetchGlobal.fetch, originalFetch)
    assert.equal(cfg.command, undefined)
    assert.equal(cfg.provider.openai.models["gpt-5.5"].options.websearch, "auto")
    assert.equal(cfg.provider.openai.options, undefined)
    assert.equal(typeof hooks["command.execute.before"], "undefined")
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("server config does not override OpenCode OAuth provider fetch", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const fetchGlobal = { fetch: async () => new Response("{}", { status: 200 }) }
  try {
    const hooks = await server({ client: makeClient(), directory: dir }, makeRouteOptions(), { stateRoot, fetchGlobal })
    const oauthFetch = async () => new Response("oauth")
    const cfg = { provider: { openai: { options: { fetch: oauthFetch } } } }

    await hooks.config?.(cfg)

    assert.equal(cfg.provider.openai.options.fetch, oauthFetch)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("server preserves OAuth fetch while global router captures ChatGPT codex traffic", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const calls = []
  const fetchGlobal = {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push({ url: request.url, auth: request.headers.get("authorization") })
      return new Response("{}", { status: 200 })
    },
  }
  try {
    const hooks = await server({ client: makeClient(), directory: dir }, makeRouteOptions(), { stateRoot, fetchGlobal })
    const oauthFetch = async (_input, init) => {
      const headers = new Headers(init?.headers)
      headers.set("authorization", "Bearer oauth")
      return fetchGlobal.fetch("https://chatgpt.com/backend-api/codex/responses", { ...init, headers })
    }
    const cfg = { provider: { openai: { options: { fetch: oauthFetch } } } }

    await hooks.config?.(cfg)
    await writeMode(dir, "codex-lb", stateRoot)
    await cfg.provider.openai.options.fetch("https://api.openai.com/v1/responses", { headers: { authorization: "Bearer dummy" } })

    assert.equal(cfg.provider.openai.options.fetch, oauthFetch)
    assert.deepEqual(calls, [{ url: "http://127.0.0.1:2455/v1/responses", auth: "Bearer sk-clb" }])
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("server dispose restores global fetch without disposing OpenCode instance", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const client = makeClient()
  const fetchGlobal = { fetch: async () => new Response("{}", { status: 200 }) }
  const originalFetch = fetchGlobal.fetch
  try {
    const hooks = await server({ client, directory: dir }, makeRouteOptions(), { stateRoot, fetchGlobal })
    assert.notEqual(fetchGlobal.fetch, originalFetch)

    await hooks.dispose()

    assert.equal(fetchGlobal.fetch, originalFetch)
    assert.equal(client.calls.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("registerCodexLbCommand registers action-only slash command", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  try {
    const api = makeTuiApi(dir)
    await registerCodexLbCommand(api, { directory: dir, stateRoot })

    const command = api.commands[0]()[0]
    assert.equal(command.title, "Toggle codex-lb")
    assert.equal(command.value, COMMAND)
    assert.equal(command.description, "Toggle codex-lb mode")
    assert.equal(command.slash.name, COMMAND)
    assert.equal(command.slash.description, undefined)
    assert.equal(typeof command.onSelect, "function")
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("registerCodexLbCommand registers keymap command when legacy command API is absent", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  try {
    const api = makeKeymapTuiApi(dir)
    await registerCodexLbCommand(api, { directory: dir, stateRoot })

    const command = api.layers[0].commands[0]
    assert.equal(command.namespace, "palette")
    assert.equal(command.name, COMMAND)
    assert.equal(command.title, "Toggle codex-lb")
    assert.equal(command.value, COMMAND)
    assert.equal(command.desc, "Toggle codex-lb mode")
    assert.equal(command.description, "Toggle codex-lb mode")
    assert.equal(command.slashName, COMMAND)
    assert.equal(command.slash.name, COMMAND)
    assert.equal(typeof command.run, "function")

    await command.run()

    assert.equal(await readMode(dir, stateRoot), "codex-lb")
    assert.equal(api.toasts[0].variant, "success")
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("registerCodexLbCommand keymap command queues while current session is busy", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const statuses = new Map([["ses", { type: "busy" }]])
  try {
    const api = makeKeymapTuiApi(dir, statuses)
    await registerCodexLbCommand(api, { directory: dir, stateRoot })
    const command = api.layers[0].commands[0]

    await command.run()
    assert.equal(await readMode(dir, stateRoot), "openai")
    assert.equal(api.toasts[0].variant, "info")

    await api.events.get("session.idle")({ properties: { sessionID: "ses" } })
    assert.equal(await readMode(dir, stateRoot), "codex-lb")
    assert.equal(api.toasts.at(-1).variant, "success")
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("registerCodexLbCommand toggles immediately when current session is idle", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  try {
    const api = makeTuiApi(dir, new Map([["ses", { type: "idle" }]]))
    await registerCodexLbCommand(api, { directory: dir, stateRoot })
    const command = api.commands[0]()[0]

    await command.onSelect()

    assert.equal(await readMode(dir, stateRoot), "codex-lb")
    assert.equal(api.toasts[0].variant, "success")
    assert.equal(api.toasts[0].message, "codex-lb mode enabled")
    assert.equal("description" in api.toasts[0], false)
    assert.equal(api.renders.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("registerCodexLbCommand queues while current session is busy until matching idle", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  const statuses = new Map([["ses", { type: "busy" }]])
  try {
    const api = makeTuiApi(dir, statuses)
    await registerCodexLbCommand(api, { directory: dir, stateRoot })
    const command = api.commands[0]()[0]

    await command.onSelect()
    assert.equal(await readMode(dir, stateRoot), "openai")
    assert.equal(api.toasts[0].variant, "info")
    assert.equal(api.toasts[0].message, "Switch queued until this session is idle")
    assert.equal("description" in api.toasts[0], false)

    await api.events.get("session.idle")({ properties: { sessionID: "other" } })
    assert.equal(await readMode(dir, stateRoot), "openai")

    await api.events.get("session.idle")({ properties: { sessionID: "ses" } })
    assert.equal(await readMode(dir, stateRoot), "codex-lb")
    assert.equal(api.toasts.at(-1).variant, "success")
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("tui does not register prompt-right slots with bare string children", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  let api
  try {
    api = makeTuiApi(dir)
    await tuiPlugin.tui(api, undefined, { stateRoot })

    assert.equal(api.slotRegistrations.some((registration) => registration.slots?.session_prompt_right), false)
  } finally {
    for (const dispose of api?.disposers ?? []) dispose()
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("registerSidebarStatus registers sidebar_content slot", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  let api
  try {
    const { registerSidebarStatus } = await import("../tui.js")
    assert.equal(typeof registerSidebarStatus, "function")
    api = makeTuiApi(dir)

    await registerSidebarStatus(api, { directory: dir, stateRoot })

    assert.equal(api.slotRegistrations.length, 1)
    assert.equal(api.slotRegistrations[0].order, 160)
    assert.equal(typeof api.slotRegistrations[0].slots.sidebar_content, "function")
  } finally {
    for (const dispose of api?.disposers ?? []) dispose()
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("registerSidebarStatus renders status with injected OpenTUI view", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  let api
  try {
    const { registerSidebarStatus } = await import("../tui.js")
    api = makeTuiApi(dir)
    await registerSidebarStatus(api, { directory: dir, stateRoot, view: makeOpenTuiView() })

    const rendered = api.slotRegistrations[0].slots.sidebar_content({}, { session_id: "ses" })

    assert.equal(rendered.type, "box")
    assert.equal(rendered.children[0].children[0], "Codex LB: native OpenAI")
  } finally {
    for (const dispose of api?.disposers ?? []) dispose()
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("registerSidebarStatus updates mode through a Solid signal", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  let api
  try {
    const { registerSidebarStatus } = await import("../tui.js")
    const view = makeReactiveOpenTuiView()
    api = makeTuiApi(dir)
    await registerSidebarStatus(api, { directory: dir, stateRoot, view })

    assert.equal(view.signals[0].getter(), "openai")

    await writeMode(dir, "codex-lb", stateRoot)
    await new Promise((resolve) => setTimeout(resolve, 1100))

    assert.deepEqual(view.signals[0].calls, ["codex-lb"])
  } finally {
    for (const dispose of api?.disposers ?? []) dispose()
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("sidebar status renders only for OpenAI sessions", async () => {
  const dir = await tempDir()
  const stateRoot = await tempDir()
  let api
  try {
    const { registerSidebarStatus } = await import("../tui.js")
    api = makeTuiApi(dir, new Map([["ses", { type: "idle" }]]), new Map([["ses", { model: { providerID: "anthropic" } }]]))
    await registerSidebarStatus(api, { directory: dir, stateRoot })

    const rendered = api.slotRegistrations[0].slots.sidebar_content({}, { session_id: "ses" })

    assert.equal(rendered, null)
  } finally {
    for (const dispose of api?.disposers ?? []) dispose()
    await rm(dir, { recursive: true, force: true })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("sidebar status uses current route session when slot props are empty", async () => {
  const { sidebarSessionID } = await import("../tui.js")
  const api = makeTuiApi("/tmp/worktree")

  assert.equal(sidebarSessionID(api), "ses")
})

test("sidebar status detects OpenAI provider from session messages", async () => {
  const { isOpenAISession } = await import("../tui.js")
  const api = makeTuiApi(
    "/tmp/worktree",
    new Map([["ses", { type: "idle" }]]),
    new Map([["ses", { id: "ses" }]]),
    new Map([["ses", [{ role: "assistant", providerID: "openai", modelID: "gpt-5.5" }]]]),
  )

  assert.equal(isOpenAISession(api, "ses"), true)
})

test("sidebar status detects OpenAI provider from config model", async () => {
  const { isOpenAISession } = await import("../tui.js")
  const api = makeTuiApi("/tmp/worktree", new Map([["ses", { type: "idle" }]]), new Map([["ses", { id: "ses" }]]))
  api.state.config = { model: "openai/gpt-5.5" }

  assert.equal(isOpenAISession(api, "ses"), true)
})

test("sidebar status stays visible when OpenCode has no provider signal", async () => {
  const { isOpenAISession } = await import("../tui.js")
  const api = makeTuiApi("/tmp/worktree", new Map([["ses", { type: "idle" }]]), new Map([["ses", { id: "ses" }]]))

  assert.equal(isOpenAISession(api, "ses"), true)
})

test("sidebar status builds a real element shape for OpenAI sessions", async () => {
  const { createSidebarStatusElement } = await import("../tui.js")
  const api = makeTuiApi("/tmp/worktree")
  const view = makeOpenTuiView()

  const rendered = createSidebarStatusElement(api, "codex-lb", view)

  assert.deepEqual(rendered, {
    type: "box",
    props: { width: "100%", flexDirection: "column" },
    children: [
      {
        type: "text",
        props: { fg: "success" },
        children: ["Codex LB: routing via codex-lb"],
      },
    ],
  })
})

test("sidebar status reads direct TUI theme shape", async () => {
  const { createSidebarStatusElement } = await import("../tui.js")
  const api = makeTuiApi("/tmp/worktree")
  api.theme = { text: "text", textMuted: "muted", success: "success" }

  const rendered = createSidebarStatusElement(api, "codex-lb", makeOpenTuiView())

  assert.equal(rendered.children[0].props.fg, "success")
})

test("sidebarStatusText labels native and codex-lb modes", async () => {
  const { sidebarStatusText } = await import("../tui.js")

  assert.equal(sidebarStatusText("openai"), "native OpenAI")
  assert.equal(sidebarStatusText("codex-lb"), "routing via codex-lb")
})

test("indicatorText only shows codex-lb mode", () => {
  assert.equal(indicatorText("openai"), "")
  assert.equal(indicatorText("codex-lb"), "codex-lb")
})
