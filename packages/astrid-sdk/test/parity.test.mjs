import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

async function loadModule(entry, mocks) {
  const result = await build({
    entryPoints: [join(PACKAGE_DIR, "dist", entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
    plugins: [hostMocks(mocks)],
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

async function loadSource(source, mocks) {
  const result = await build({
    stdin: { contents: source, resolveDir: PACKAGE_DIR, sourcefile: "parity-entry.mjs" },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
    plugins: [hostMocks(mocks)],
  });
  const bundled = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(bundled).toString("base64")}`);
}

function hostMocks(modules) {
  return {
    name: "astrid-test-host",
    setup(context) {
      context.onResolve({ filter: /^astrid:/ }, ({ path }) => ({ path, namespace: "astrid" }));
      context.onLoad({ filter: /.*/, namespace: "astrid" }, ({ path }) => ({
        contents: modules[path] ?? "export {};",
        loader: "js",
      }));
    },
  };
}

const ipcMock = `
export function publish(topic, payload) { globalThis.__astridPublishes.push({ topic, payload }); }
export function publishAs(topic, payload, principal) { publish(topic, payload, principal); }
export function subscribe() { throw new Error("not used"); }
export function getInterceptorBindings() { return []; }
`;

const sysMock = `
export function randomBytes(length) { return new Uint8Array(Number(length)); }
export function log(level, message) { globalThis.__astridLogs.push({ level, message }); }
export function getConfig() { return undefined; }
`;

test("HTTP fetch is WHATWG-native and carries Astrid request controls", async () => {
  globalThis.__astridHttpCalls = [];
  const http = await loadModule("http.js", {
    "astrid:http/host@1.1.0": `
      export function httpRequestOpts(request, options) {
        globalThis.__astridHttpCalls.push({ request, options });
        return {
          status: 200,
          headers: [{ key: "content-type", value: "application/json" }],
          body: new TextEncoder().encode('{"ok":true}'),
          meta: { finalUrl: "https://example.test/final", redirectCount: 1,
                  elapsedMs: 27n, wireBytes: 123n },
        };
      }
      export function httpStreamStartOpts() { throw new Error("not used"); }
    `,
  });

  const response = await http.fetch(new URL("https://example.test"), {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ hello: "world" }),
    timeoutMs: 5_000,
    connectTimeoutMs: 200,
    firstByteTimeoutMs: 300,
    readTimeoutMs: 400,
    redirect: "follow",
    maxRedirects: 3,
    maxResponseBytes: 1_024,
    maxDecompressedBytes: 2_048n,
    autoDecompress: false,
    httpsOnly: true,
    integrity: "sha256-abc",
  });

  assert.deepEqual(globalThis.__astridHttpCalls[0].request, {
    url: "https://example.test/",
    method: { tag: "post" },
    headers: [{ key: "content-type", value: "application/json" }],
    body: new TextEncoder().encode('{"hello":"world"}'),
  });
  assert.deepEqual(globalThis.__astridHttpCalls[0].options, {
    timeouts: { connectMs: 200n, firstByteMs: 300n, betweenBytesMs: 400n, totalMs: 5_000n },
    redirect: "follow",
    maxRedirects: 3,
    maxResponseBytes: 1_024n,
    maxDecompressedBytes: 2_048n,
    autoDecompress: false,
    httpsOnly: true,
    integrity: "sha256-abc",
  });
  assert.equal(response.url, "https://example.test/final");
  assert.equal(response.redirected, true);
  assert.equal(response.redirectCount, 1);
  assert.equal(response.elapsedMs, 27);
  assert.equal(response.wireBytes, 123n);
  assert.equal(response instanceof Response, true);
  assert.deepEqual(await response.clone().json(), { ok: true });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.bodyUsed, true);
});

test("HTTP builder is explicitly named and keeps host ABI details private", async () => {
  globalThis.__astridHttpCalls = [];
  const http = await loadModule("http.js", {
    "astrid:http/host@1.1.0": `
      export function httpRequestOpts(request, options) {
        globalThis.__astridHttpCalls.push({ request, options });
        return {
          status: 204, headers: [], body: new Uint8Array(),
          meta: { finalUrl: request.url, redirectCount: 0, elapsedMs: 1n, wireBytes: 0n },
        };
      }
      export function httpStreamStartOpts() { throw new Error("not used"); }
    `,
  });

  const request = http.RequestBuilder.post("https://example.test/items")
    .json({ name: "capsule" })
    .timeout(50);
  assert.equal("toWit" in request, false);
  assert.equal("toWitOptions" in request, false);
  assert.equal("_snapshot" in request, false);
  const response = http.send(request);
  assert.equal(response.status, 204);
  assert.equal(response.ok, true);
  assert.deepEqual(globalThis.__astridHttpCalls[0].options.timeouts.totalMs, 50n);
});

test("HTTP fetch preserves Request consumption, abort, and body rules", async () => {
  globalThis.__astridHttpCalls = [];
  const http = await loadModule("http.js", {
    "astrid:http/host@1.1.0": `
      export function httpRequestOpts(request, options) {
        globalThis.__astridHttpCalls.push({ request, options });
        return {
          status: 200, headers: [], body: new Uint8Array(),
          meta: { finalUrl: request.url, redirectCount: 0, elapsedMs: 0n, wireBytes: 0n },
        };
      }
      export function httpStreamStartOpts() { throw new Error("not used"); }
    `,
  });

  const request = new Request("https://example.test/items", {
    method: "POST",
    body: "hello",
    redirect: "error",
  });
  await http.fetch(request);
  assert.equal(request.bodyUsed, true);
  assert.equal(globalThis.__astridHttpCalls[0].options.redirect, "error");
  assert.deepEqual(globalThis.__astridHttpCalls[0].request.headers, [
    { key: "content-type", value: "text/plain;charset=UTF-8" },
  ]);

  await assert.rejects(
    http.fetch("https://example.test", { method: "GET", body: "nope" }),
    /cannot have a body/,
  );
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(http.fetch("https://example.test", { signal: controller.signal }), /cancelled/);
  await assert.rejects(http.fetch("https://user:secret@example.test"), /cannot include credentials/);
  for (const field of ["timeoutMs", "connectTimeoutMs", "firstByteTimeoutMs", "readTimeoutMs"]) {
    await assert.rejects(
      http.fetch("https://example.test", { [field]: Number.POSITIVE_INFINITY }),
      new RegExp(field),
    );
  }
  assert.equal(globalThis.__astridHttpCalls.length, 1);
});

test("process spawn follows Node background semantics and spawnSync captures output", async () => {
  globalThis.__astridSpawnRequest = undefined;
  const process = await loadModule("process.js", {
    "astrid:process/host@1.1.0": `
      export function spawn(request) {
        globalThis.__astridSpawnRequest = request;
        return { stdout: "", stderr: "", exit: { exitCode: 0, signal: undefined } };
      }
      export function spawnBackground(request) {
        globalThis.__astridBackgroundRequest = request;
        return {
          readLogs() { return { stdout: "", stderr: "", running: true, exit: undefined }; },
          writeStdin(data) { return data.length; }, closeStdin() {},
          signal(sig) { globalThis.__astridSignal = sig; },
          kill() { return { killed: true, stdout: "", stderr: "", exit: undefined }; },
          wait() { return { exitCode: 0, signal: undefined }; },
          waitWithOutput() { return { stdout: "", stderr: "", exit: { exitCode: 0, signal: undefined } }; },
          osPid() { return 42; }, [Symbol.dispose]() {},
        };
      }
      export function spawnPersistent() { throw new Error("not used"); }
      export function listProcesses() { return []; }
      export function status() { throw new Error("not used"); }
      export function statusMany() { return []; }
      export function readLogs() { throw new Error("not used"); }
      export function readSince() { throw new Error("not used"); }
      export function writeStdin() { throw new Error("not used"); }
      export function closeStdin() { throw new Error("not used"); }
      export function signal() { throw new Error("not used"); }
      export function wait() { throw new Error("not used"); }
      export function stop() { throw new Error("not used"); }
      export function releaseProcess() { throw new Error("not used"); }
    `,
  });

  const result = process.spawnSync("agent", [], {
    injectedFiles: [
      { env: "AGENT_POLICY", content: "deny = true" },
      { path: "/etc/agent/policy.toml", content: new Uint8Array([1, 2]) },
    ],
  });
  assert.deepEqual(globalThis.__astridSpawnRequest.fileInjections, [
    {
      content: new TextEncoder().encode("deny = true"),
      placement: { tag: "env-pointer", val: "AGENT_POLICY" },
    },
    {
      content: new Uint8Array([1, 2]),
      placement: { tag: "fixed-path", val: "/etc/agent/policy.toml" },
    },
  ]);
  assert.equal(result.exitCode, 0);

  const child = process.spawn("agent", ["--serve"]);
  assert.equal(child.pid, 42);
  assert.equal(child.kill(), true);
  assert.equal(globalThis.__astridSignal, "term");
  assert.deepEqual(globalThis.__astridBackgroundRequest.args, ["--serve"]);
  child.close();
  assert.throws(() => new process.ChildProcess(Symbol(), {}), /cannot be constructed directly/);
});

test("uplink IDs are opaque strings instead of wrapper objects", async () => {
  globalThis.__astridUplinkSend = undefined;
  const uplink = await loadModule("uplink.js", {
    "astrid:uplink/host@1.0.0": `
      export function uplinkRegister() { return "uplink-1"; }
      export function uplinkSend(id, user, content) {
        globalThis.__astridUplinkSend = { id, user, content };
        return true;
      }
    `,
  });
  const id = uplink.register("chat", "matrix", "interactive");
  assert.equal(id, "uplink-1");
  assert.equal(uplink.send(id, "user-1", "hello"), true);
  assert.deepEqual(globalThis.__astridUplinkSend, {
    id: "uplink-1", user: "user-1", content: "hello",
  });
});

test("filesystem and environment helpers follow familiar JS standard-library shapes", async () => {
  globalThis.__astridFsCalls = [];
  const fs = await loadModule("fs.js", {
    "astrid:fs/host@1.0.0": `
      export function fsReaddir() { return ["file.txt", "dir"]; }
      export function fsStatSymlink(path) {
        return { size: 0n, mode: 0, kind: path.endsWith("dir") || path.endsWith("nested") ? "directory" : "regular",
                 modified: undefined, created: undefined, accessed: undefined };
      }
      export function fsMkdirAll(path) { globalThis.__astridFsCalls.push(["mkdirAll", path]); }
      export function fsMkdir(path) { globalThis.__astridFsCalls.push(["mkdir", path]); }
      export function fsRemoveDirAll(path) { globalThis.__astridFsCalls.push(["removeDirAll", path]); return 2n; }
      export function fsUnlink(path) { globalThis.__astridFsCalls.push(["unlink", path]); }
      export function fsOpen() { throw new Error("not used"); }
      export function fsExists() { return false; }
      export function fsStat() { throw new Error("not used"); }
      export function readFile() { throw new Error("not used"); }
      export function writeFile() { throw new Error("not used"); }
      export function fsAppend() { throw new Error("not used"); }
      export function fsCopy() { throw new Error("not used"); }
      export function fsRename() { throw new Error("not used"); }
      export function fsCanonicalize() { throw new Error("not used"); }
      export function fsReadLink() { throw new Error("not used"); }
      export function fsHardLink() { throw new Error("not used"); }
    `,
  });
  const entries = await fs.readdir("home://data", { withFileTypes: true });
  assert.equal(entries[0].isFile(), true);
  assert.equal(entries[1].isDirectory(), true);
  await fs.mkdir("home://nested/path", { recursive: true });
  await fs.rm("home://nested", { recursive: true });
  await fs.unlink("home://file.txt");
  assert.deepEqual(globalThis.__astridFsCalls, [
    ["mkdirAll", "home://nested/path"],
    ["removeDirAll", "home://nested"],
    ["unlink", "home://file.txt"],
  ]);

  const env = await loadModule("env.js", {
    "astrid:sys/host@1.0.0": `
      export function getConfig(key) { return key === "PRESENT" ? "" : undefined; }
    `,
  });
  assert.equal(env.get("PRESENT"), "");
  assert.equal(env.get("MISSING"), undefined);
  assert.throws(() => env.getOrThrow("MISSING"), /Missing required Astrid config/);
});

test("versioned KV distinguishes migration states and writes migrated data", async () => {
  globalThis.__astridKv = new Map();
  const kv = await loadModule("kv.js", {
    "astrid:kv/host@1.0.0": `
      export function kvGet(key) { return globalThis.__astridKv.get(key); }
      export function kvSet(key, value) { globalThis.__astridKv.set(key, value); }
      export function kvDelete(key) { globalThis.__astridKv.delete(key); }
      export function kvListKeys() { return []; }
      export function kvListKeysPage() { return { keys: [], nextCursor: undefined }; }
      export function kvClearPrefix() { return 0n; }
      export function kvCas() {}
    `,
  });

  kv.setVersioned("settings", { name: "old" }, 1);
  assert.deepEqual(kv.getVersioned("settings", 2), {
    kind: "needsMigration",
    value: { name: "old" },
    storedVersion: 1,
  });
  const migrated = kv.getVersionedOrMigrate("settings", 2, (value, version) => ({
    ...value,
    migratedFrom: version,
  }));
  assert.deepEqual(migrated, { name: "old", migratedFrom: 1 });
  assert.deepEqual(kv.getVersioned("settings", 2), { kind: "current", value: migrated });
  assert.throws(() => kv.getVersioned("settings", 1), /newer than current version/);
  kv.delete("settings");
  assert.deepEqual(kv.getVersioned("settings", 2), { kind: "notFound" });
});

test("hook events reply on scoped topics and bridge dispatch remains fail-open", async () => {
  globalThis.__astridPublishes = [];
  globalThis.__astridLogs = [];
  const module = await loadSource(`
    import { createBridge } from "./dist/runtime/bridge.js";
    import { registerCapsule, recordHook } from "./dist/runtime/registry.js";
    class Capsule {
      before(event) {
        globalThis.__astridHookPayload = event.json();
        return { skip: true };
      }
    }
    registerCapsule(Capsule);
    recordHook(Capsule, { name: "before_tool_call", methodName: "before", mutable: false });
    export const bridge = createBridge();
  `, {
    "astrid:ipc/host@1.0.0": ipcMock,
    "astrid:sys/host@1.0.0": sysMock,
    "astrid:kv/host@1.0.0": `
      export function kvGet() { return undefined; }
      export function kvSet() {}
      export function kvDelete() {}
      export function kvListKeys() { return []; }
      export function kvListKeysPage() { return { keys: [], nextCursor: undefined }; }
      export function kvClearPrefix() { return 0n; }
      export function kvCas() {}
    `,
  });

  const payload = new TextEncoder().encode(JSON.stringify({
    hook: "before_tool_call",
    payload: '{"tool":"shell"}',
    correlation_id: "corr-1",
  }));
  assert.deepEqual(module.bridge.astridHookTrigger("before_tool_call", payload), {
    action: "continue",
    data: undefined,
  });
  assert.deepEqual(globalThis.__astridHookPayload, { tool: "shell" });
  assert.deepEqual(globalThis.__astridPublishes, [{
    topic: "hook.v1.response.before_tool_call.corr-1",
    payload: '{"skip":true}',
  }]);

  assert.deepEqual(
    module.bridge.astridHookTrigger("before_tool_call", new TextEncoder().encode("bad json")),
    { action: "continue", data: undefined },
  );
  assert.match(globalThis.__astridLogs.at(-1).message, /malformed event/);

  const publishCountBeforeMismatch = globalThis.__astridPublishes.length;
  assert.deepEqual(
    module.bridge.astridHookTrigger("before_tool_call", new TextEncoder().encode(JSON.stringify({
      hook: "after_tool_call",
      payload: "{}",
      correlation_id: "corr-mismatch",
    }))),
    { action: "continue", data: undefined },
  );
  assert.equal(globalThis.__astridPublishes.length, publishCountBeforeMismatch);
  assert.match(globalThis.__astridLogs.at(-1).message, /hook: "before_tool_call"/);

  const { HookEvent } = await loadModule("hooks.js", {
    "astrid:ipc/host@1.0.0": ipcMock,
    "astrid:sys/host@1.0.0": sysMock,
  });
  const publishCount = globalThis.__astridPublishes.length;
  const event = new HookEvent({ hook: "session_end", payload: "{}" });
  assert.equal(event.payload, "{}");
  assert.equal(event.canReply, false);
  assert.equal(event.skip(), false);
  assert.equal(globalThis.__astridPublishes.length, publishCount);
});
