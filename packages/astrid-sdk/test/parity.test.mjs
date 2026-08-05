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

test("HTTP 1.1 request controls and response metadata use canonical WIT records", async () => {
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

  const request = http.Request.get("https://example.test")
    .timeout(5_000)
    .connectTimeout(200)
    .firstByteTimeout(300)
    .readTimeout(400)
    .redirect("follow")
    .maxRedirects(3)
    .maxResponseBytes(1_024)
    .maxDecompressedBytes(2_048n)
    .autoDecompress(false)
    .httpsOnly()
    .integrity("sha256-abc");
  assert.deepEqual(http.Request.get("https://example.test").toWitOptions(), {
    timeouts: undefined,
    redirect: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    maxDecompressedBytes: undefined,
    autoDecompress: undefined,
    httpsOnly: undefined,
    integrity: undefined,
  });
  const response = http.send(request);

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
  assert.deepEqual(response.json(), { ok: true });
});

test("process options encode portable and fixed-path file injections", async () => {
  globalThis.__astridSpawnRequest = undefined;
  const process = await loadModule("process.js", {
    "astrid:process/host@1.1.0": `
      export function spawn(request) {
        globalThis.__astridSpawnRequest = request;
        return { stdout: "", stderr: "", exit: { exitCode: 0, signal: undefined } };
      }
      export function spawnBackground() { throw new Error("not used"); }
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

  process.spawn("agent", [], {
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
    status: "needs-migration",
    value: { name: "old" },
    storedVersion: 1,
  });
  const migrated = kv.getVersionedOrMigrate("settings", 2, (value, version) => ({
    ...value,
    migratedFrom: version,
  }));
  assert.deepEqual(migrated, { name: "old", migratedFrom: 1 });
  assert.deepEqual(kv.getVersioned("settings", 2), { status: "current", value: migrated });
  assert.throws(() => kv.getVersioned("settings", 1), /newer than current version/);
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

  const { HookEvent } = await loadModule("hooks.js", {
    "astrid:ipc/host@1.0.0": ipcMock,
    "astrid:sys/host@1.0.0": sysMock,
  });
  const publishCount = globalThis.__astridPublishes.length;
  new HookEvent({ hook: "session_end", payload: "{}" }).skip();
  assert.equal(globalThis.__astridPublishes.length, publishCount);
});
