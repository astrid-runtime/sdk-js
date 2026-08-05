#!/usr/bin/env node
/**
 * Astrid JS/TS capsule build orchestrator.
 *
 * Invoked by `core/crates/astrid-build/src/js.rs`. Reads a project
 * directory, produces a wasm32-wasip2 component.
 *
 * Pipeline:
 *   1. Read package.json metadata (name, version, main / source entry).
 *   2. tsc compile the project (if tsconfig.json present).
 *   3. Resolve the SDK's `wit/` directory so componentize sees astrid-capsule.wit.
 *   4. Emit gen/_entry.mjs: imports the user's compiled entry (decorators
 *      fire), constructs the bridge, re-exports the four WIT export names.
 *   5. Bundle gen/_entry.mjs (resolves @astrid-runtime/sdk into the bundle so
 *      componentize sees one self-contained ESM file).
 *   6. Invoke ComponentizeJS programmatic API.
 *   7. Write the .wasm to the requested output path.
 *
 * CLI: `astrid-js-build <project-dir> --out <wasm-path>`
 */

import { componentize } from "@bytecodealliance/componentize-js";
import * as esbuild from "esbuild";
import { codegenWitEvents } from "./wit-codegen.mjs";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, stat, rm, copyFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK_PKG_DIR = resolve(HERE, "..", "..", "astrid-sdk");
// Canonical host ABI lives in the astrid-runtime/wit submodule (mounted at
// repo-root/contracts/). Post per-domain WIT split (PR #752), each domain
// is a separate versioned `astrid:<domain>/host` package plus the foundation
// `astrid:io/*@1.0.0` interfaces; componentize-js resolves the world the
// capsule declares by reading every file in this directory.
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CANONICAL_WIT_DIR = process.env.ASTRID_HOST_WIT_DIR
  ? resolve(process.env.ASTRID_HOST_WIT_DIR)
  : resolve(REPO_ROOT, "contracts", "host");

function die(msg) {
  console.error(`astrid-js-build: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  if (argv.length < 1) die("usage: astrid-js-build <project-dir> [--out <wasm-path>]");
  const projectDir = resolve(argv[0]);
  let out;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--out" && i + 1 < argv.length) {
      out = resolve(argv[++i]);
    } else {
      die(`unknown argument: ${argv[i]}`);
    }
  }
  return { projectDir, out };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    die(`failed to read ${path}: ${err.message}`);
  }
}

async function resolveProjectMetadata(projectDir) {
  const pkgPath = join(projectDir, "package.json");
  if (!existsSync(pkgPath)) die(`no package.json at ${pkgPath}`);
  const pkg = await readJson(pkgPath);
  if (typeof pkg.name !== "string" || pkg.name.length === 0) {
    die("package.json must have a non-empty 'name'");
  }
  return { name: pkg.name, version: pkg.version ?? "0.0.0", pkg };
}

function compileTypeScript(projectDir) {
  const tsconfigPath = join(projectDir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    console.log("astrid-js-build: no tsconfig.json — skipping tsc compile");
    return null;
  }
  // Use tsc CLI for full project-references support. The programmatic API
  // would require us to re-implement project references; the CLI is the
  // contract-tested path.
  const tscBin = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const result = spawnSync(process.execPath, [tscBin, "-p", projectDir], { stdio: "inherit" });
  if (result.status !== 0) die("tsc failed");
  // Read tsconfig to find outDir.
  const raw = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (raw.error) die(`tsconfig parse error: ${raw.error.messageText}`);
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, projectDir);
  return parsed.options.outDir ?? join(projectDir, "dist");
}

function resolveEntry(projectDir, outDir) {
  // Prefer compiled JS in outDir; fall back to package.json main.
  const candidates = [
    outDir ? join(outDir, "index.js") : undefined,
    join(projectDir, "dist", "index.js"),
    join(projectDir, "index.js"),
    join(projectDir, "index.mjs"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  die("could not locate compiled entry. Expected dist/index.js after tsc or index.js/.mjs at project root.");
}

function resolveSdkRuntime() {
  const candidate = join(SDK_PKG_DIR, "dist", "runtime", "index.js");
  if (!existsSync(candidate)) {
    die(
      `SDK runtime not found at ${candidate}. ` +
        `Build @astrid-runtime/sdk first (npx tsc -b packages/astrid-sdk in the workspace root).`,
    );
  }
  return candidate;
}

async function emitEntry(projectDir, userEntry) {
  const genDir = join(projectDir, "gen");
  await mkdir(genDir, { recursive: true });
  const entryPath = join(genDir, "_entry.src.mjs");

  // ComponentizeJS's splicer rejects file:// URL imports — it treats the
  // entire URL as a relative path. Use POSIX-style relative paths instead.
  const userEntryRel = posixRelative(genDir, userEntry);
  const sdkRuntimeRel = posixRelative(genDir, resolveSdkRuntime());

  const entrySource = `// Auto-generated by @astrid-runtime/build. Do not edit by hand.
//
// This file gets bundled with esbuild before componentize. Importing the
// user module fires the @capsule / @tool / @install / @upgrade decorators,
// which populate the SDK registry. We then build the bridge and re-export
// the four WIT-required guest export names.

import "${userEntryRel}";
import { createBridge } from "${sdkRuntimeRel}";

const bridge = createBridge();

export function astridHookTrigger(action, payload) {
  return bridge.astridHookTrigger(action, payload);
}

export function run() {
  bridge.run();
}

export function astridInstall() {
  bridge.astridInstall();
}

export function astridUpgrade() {
  bridge.astridUpgrade();
}
`;
  await writeFile(entryPath, entrySource);
  return entryPath;
}

/**
 * Bundle the generated entry into a single ESM file. ComponentizeJS can't
 * resolve bare-specifier imports (`@astrid-runtime/sdk`); esbuild inlines
 * everything except the WIT-resolved `astrid:*` imports.
 */
/**
 * esbuild plugin that resolves Node builtins (`fs`, `path`, `crypto`,
 * `zlib`, …) and a small allowlist of Node-flavoured packages (`ws`)
 * to a synthetic module that returns throw-on-call Proxies for every
 * access. The capsule runtime (StarlingMonkey) doesn't provide
 * `node:*` builtins; libraries written for both Node and the browser
 * commonly carry a `node:crypto` import for paths that never run on
 * non-Node platforms. Without this plugin, those imports fail the
 * bundle. With it, the bundle succeeds and any unreached path stays
 * unreached at runtime — the proxy throws if a capsule actually
 * touches them.
 *
 * Throwing lazily (on first call, not on import) matters: many
 * sphere-sdk classes bind `crypto.createHmac` at top level via
 * destructuring, but only call it down a code path that's never
 * exercised in the capsule's actual usage (admin tooling, etc).
 */
function nodeBuiltinStubPlugin() {
  // Per-module named-export lists. esbuild does static analysis of
  // named imports against the stub module's actual exports, so the
  // stub file must explicitly declare every name that could be
  // destructure-imported by an upstream library. Growing this list
  // is benign — unused entries cost nothing at bundle or runtime.
  // Add new entries when a build surfaces "No matching export in
  // 'astrid-node-stub:<X>' for import 'Y'".
  const namedExports = {
    assert: ["ok", "strict", "strictEqual", "deepEqual", "deepStrictEqual", "notEqual", "fail"],
    buffer: ["Buffer", "Blob", "File", "constants", "kMaxLength", "kStringMaxLength", "atob", "btoa", "isAscii", "isUtf8"],
    child_process: ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
    constants: [],
    crypto: ["createHmac", "createHash", "createCipher", "createCipheriv", "createDecipher", "createDecipheriv", "createSign", "createVerify", "createDiffieHellman", "createECDH", "randomBytes", "randomUUID", "randomInt", "randomFillSync", "scrypt", "scryptSync", "pbkdf2", "pbkdf2Sync", "timingSafeEqual", "constants", "webcrypto", "subtle", "X509Certificate", "KeyObject", "generateKeySync", "generateKey", "generateKeyPair", "generateKeyPairSync", "createPublicKey", "createPrivateKey", "createSecretKey", "sign", "verify", "publicEncrypt", "privateDecrypt", "privateEncrypt", "publicDecrypt", "hkdf", "hkdfSync", "getCiphers", "getHashes", "getCurves", "getRandomValues"],
    dgram: ["createSocket", "Socket"],
    dns: ["lookup", "resolve", "resolve4", "resolve6", "resolveTxt", "promises"],
    events: ["EventEmitter", "once", "on", "captureRejectionSymbol", "defaultMaxListeners", "errorMonitor", "setMaxListeners"],
    fs: ["readFileSync", "writeFileSync", "existsSync", "statSync", "lstatSync", "readdirSync", "mkdirSync", "rmSync", "rmdirSync", "unlinkSync", "renameSync", "promises", "constants", "createReadStream", "createWriteStream", "watch", "watchFile", "openSync", "closeSync", "readSync", "writeSync", "fstatSync", "ftruncateSync", "appendFileSync", "accessSync", "copyFileSync", "linkSync", "symlinkSync", "readlinkSync", "realpathSync", "utimesSync", "chmodSync", "chownSync"],
    "fs/promises": ["readFile", "writeFile", "stat", "lstat", "readdir", "mkdir", "rm", "rmdir", "unlink", "rename", "open", "access", "copyFile", "appendFile", "link", "symlink", "readlink", "realpath", "utimes", "chmod", "chown"],
    http: ["createServer", "request", "get", "Agent", "globalAgent", "STATUS_CODES", "METHODS"],
    https: ["createServer", "request", "get", "Agent", "globalAgent"],
    module: ["createRequire", "builtinModules", "Module", "isBuiltin"],
    net: ["createServer", "createConnection", "connect", "Socket", "Server", "isIP", "isIPv4", "isIPv6"],
    os: ["arch", "platform", "type", "release", "hostname", "homedir", "tmpdir", "cpus", "endianness", "freemem", "totalmem", "uptime", "userInfo", "EOL", "constants"],
    path: ["join", "resolve", "basename", "dirname", "extname", "sep", "delimiter", "isAbsolute", "normalize", "relative", "parse", "format", "posix", "win32", "toNamespacedPath"],
    perf_hooks: ["performance", "PerformanceObserver"],
    process: ["env", "argv", "platform", "arch", "version", "versions", "stdout", "stderr", "stdin", "cwd", "chdir", "exit", "nextTick", "pid", "ppid"],
    querystring: ["parse", "stringify", "escape", "unescape"],
    readline: ["createInterface", "Interface"],
    stream: ["Readable", "Writable", "Transform", "PassThrough", "Duplex", "pipeline", "finished", "promises"],
    "stream/web": ["ReadableStream", "WritableStream", "TransformStream", "ByteLengthQueuingStrategy", "CountQueuingStrategy"],
    tls: ["createServer", "connect", "createSecureContext", "TLSSocket", "Server", "checkServerIdentity", "rootCertificates", "DEFAULT_CIPHERS", "DEFAULT_MIN_VERSION", "DEFAULT_MAX_VERSION"],
    tty: ["isatty", "ReadStream", "WriteStream"],
    url: ["URL", "URLSearchParams", "fileURLToPath", "pathToFileURL", "format", "parse", "resolve", "domainToASCII", "domainToUnicode"],
    util: ["promisify", "inspect", "format", "deprecate", "callbackify", "TextDecoder", "TextEncoder", "types", "isDeepStrictEqual"],
    vm: ["createContext", "runInContext", "runInNewContext", "runInThisContext", "Script"],
    worker_threads: ["Worker", "isMainThread", "parentPort", "workerData", "threadId"],
    zlib: ["gzip", "gunzip", "gzipSync", "gunzipSync", "deflate", "inflate", "deflateSync", "inflateSync", "createGzip", "createGunzip", "createDeflate", "createInflate", "constants", "brotliCompress", "brotliDecompress", "brotliCompressSync", "brotliDecompressSync"],
    ws: ["WebSocket", "WebSocketServer", "Server", "createWebSocketStream"],
  };
  return {
    name: "astrid-node-builtin-stub",
    setup(build) {
      build.onResolve({ filter: /^(node:)?[^./].*$/ }, (args) => {
        const stripped = args.path.startsWith("node:")
          ? args.path.slice(5)
          : args.path;
        if (Object.prototype.hasOwnProperty.call(namedExports, stripped)) {
          return { path: stripped, namespace: "astrid-node-stub" };
        }
        return null;
      });
      build.onLoad(
        { filter: /.*/, namespace: "astrid-node-stub" },
        (args) => {
          const names = namedExports[args.path] ?? [];
          const exportLines = names
            .map((n) => `export const ${n} = makeStub(${JSON.stringify(n)});`)
            .join("\n");
          return {
            loader: "js",
            contents: `
const importPath = ${JSON.stringify(args.path)};
const throwUnavailable = (member) => {
  throw new Error(
    "Capsule reached node-builtin stub: " + importPath +
    (member ? "." + member : "") +
    " is not available on wasm32. The capsule must avoid this code path " +
    "or replace the import with a web-equivalent (e.g. globalThis.crypto " +
    "for WebCrypto, astrid_sdk net for sockets)."
  );
};
const makeStub = (member) => new Proxy(function () {}, {
  get(_target, prop) {
    if (typeof prop === "symbol") return undefined;
    return makeStub((member ? member + "." : "") + String(prop));
  },
  apply() { throwUnavailable(member); },
  construct() { throwUnavailable(member); },
});
${exportLines}
export default makeStub("");
`,
          };
        },
      );
    },
  };
}

async function bundle(entryPath, projectDir) {
  const genDir = dirname(entryPath);
  const bundlePath = join(genDir, "_entry.mjs");
  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    // Browser platform so esbuild honors the `browser` field in package.json
    // (node-forge maps `crypto`/`buffer`/`process` to empty modules; libp2p
    // maps its node:crypto-using files to .browser.js variants that use
    // WebCrypto). StarlingMonkey provides WebCrypto via globalThis.crypto
    // but does NOT provide node:crypto/node:events/etc., so the Node
    // variants of these packages would fail at bundle time. The capsule
    // runtime surface is web-like, not Node-like, on every axis that
    // matters for bundling.
    platform: "browser",
    target: "es2022",
    outfile: bundlePath,
    // Mark WIT module specifiers as external so esbuild doesn't try to
    // resolve them — ComponentizeJS owns those imports. Post per-domain WIT
    // split, the specifiers are versioned `astrid:<domain>/host` modules and
    // `astrid:io/<iface>@1.0.0`; the bare `astrid:*` glob covers both.
    external: ["astrid:*"],
    // Working dir resolution: esbuild needs to look in the project's
    // node_modules to find @astrid-runtime/sdk via the workspace symlink.
    absWorkingDir: projectDir,
    // Conditional exports: prefer ESM, then browser-conditional entries
    // (Sphere SDK's `./impl/browser` etc.). `node` is intentionally
    // omitted — the capsule runtime can't satisfy node:* builtins.
    conditions: ["import", "module", "browser"],
    // Stub Node builtins + Node-adjacent packages that may leak in from
    // dual-target dependencies (libp2p, sphere-sdk, etc.). See plugin doc.
    plugins: [nodeBuiltinStubPlugin()],
    // Don't minify — we want readable error messages during development.
    // Componentize will be the one stripping for size.
    minify: false,
    sourcemap: false,
  });
  return bundlePath;
}

function resolveWitPath() {
  // Read straight from the canonical `astrid-runtime/wit` submodule. The
  // kernel side (cargo-published `astrid-sys` crate) keeps an in-tree copy
  // because `cargo package` only bundles files inside the crate dir; the
  // JS SDK has no such constraint, so we consume the submodule directly
  // and skip the drift surface entirely. Sanity-check that the per-domain
  // split landed — `ipc@1.0.0.wit` is the canary file that appears on the
  // new layout but never the old.
  if (!existsSync(join(CANONICAL_WIT_DIR, "ipc@1.0.0.wit"))) {
    die(
      `canonical host WIT missing or pre-split at ${CANONICAL_WIT_DIR}. ` +
        `Expected per-domain layout from astrid-runtime/wit; run 'git submodule update --init --recursive' from the sdk-js repo root.`,
    );
  }
  return CANONICAL_WIT_DIR;
}

/**
 * Stage the canonical host WIT files into a synthesized deps tree that
 * componentize-js can resolve, then emit a single `astrid-sdk:capsule` world
 * that imports every per-domain host package and includes every guest export
 * world. Mirrors the Rust SDK's `astrid-sys` synthetic world (see
 * `sdk-rust/astrid-sys/src/lib.rs`) so the two SDKs target the same world.
 *
 * Layout produced under `<projectDir>/gen/wit/`:
 *
 *   capsule.wit                    (the synthetic world)
 *   deps/astrid-io@1.0.0/io@1.0.0.wit
 *   deps/astrid-fs@1.0.0/fs@1.0.0.wit
 *   deps/astrid-ipc@1.0.0/ipc@1.0.0.wit
 *   ... (one dir per per-domain package)
 *   deps/astrid-guest/guest@1.0.0.wit
 *
 * The deps/ dir is the WIT convention componentize-js / wit-bindgen uses to
 * find external packages.
 */
async function stageCapsuleWit(projectDir) {
  const witDir = join(projectDir, "gen", "wit");
  const depsDir = join(witDir, "deps");
  await rm(witDir, { recursive: true, force: true });
  await mkdir(depsDir, { recursive: true });

  // Keep each frozen package version in its own dependency directory.
  // WIT rejects two versions of the same package in one directory.
  const hostFiles = await readdir(CANONICAL_WIT_DIR);
  for (const fname of hostFiles) {
    if (!fname.endsWith(".wit")) continue;
    // `ipc@1.0.0.wit` → `astrid-ipc@1.0.0`
    const packageVersion = fname.slice(0, -".wit".length);
    const subdir = join(depsDir, `astrid-${packageVersion}`);
    await mkdir(subdir, { recursive: true });
    await copyFile(join(CANONICAL_WIT_DIR, fname), join(subdir, fname));
  }

  const world = `// Auto-generated by @astrid-runtime/build. Do not edit by hand.
//
// Synthetic capsule world combining every frozen per-domain host import
// plus every guest export world. Mirrors the Rust SDK's astrid-sys
// synthetic world so capsules built with either SDK target the same world.

package astrid-sdk:capsule;

world capsule {
    import astrid:io/error@1.0.0;
    import astrid:io/poll@1.0.0;
    import astrid:io/streams@1.0.0;

    import astrid:fs/host@1.0.0;
    import astrid:ipc/host@1.0.0;
    import astrid:kv/host@1.0.0;
    import astrid:net/host@1.0.0;
    import astrid:http/host@1.1.0;
    import astrid:sys/host@1.0.0;
    import astrid:process/host@1.1.0;
    import astrid:uplink/host@1.0.0;
    import astrid:elicit/host@1.0.0;
    import astrid:approval/host@1.0.0;
    import astrid:identity/host@1.0.0;

    include astrid:guest/interceptor@1.0.0;
    include astrid:guest/background@1.0.0;
    include astrid:guest/installable@1.0.0;
    include astrid:guest/upgradable@1.0.0;
}
`;
  await writeFile(join(witDir, "capsule.wit"), world);
  return witDir;
}

async function runComponentize(entryPath, outPath, projectDir) {
  // Sanity-check the canonical host WIT exists before staging.
  resolveWitPath();
  const witPath = await stageCapsuleWit(projectDir);
  const t0 = performance.now();
  const { component, imports } = await componentize({
    sourcePath: entryPath,
    witPath,
    worldName: "capsule",
    // Phase 0 finding: ALL features must be disabled to avoid pulling in
    // WASI 0.2 imports the Astrid kernel doesn't satisfy.
    disableFeatures: ["stdio", "random", "clocks", "http", "fetch-event"],
  });
  const elapsedMs = performance.now() - t0;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, component);
  const info = await stat(outPath);
  return {
    bytes: info.size,
    componentizeSec: (elapsedMs / 1000).toFixed(2),
    importCount: imports.length,
  };
}

async function main() {
  const { projectDir, out } = parseArgs(process.argv.slice(2));
  if (!existsSync(projectDir)) die(`project directory does not exist: ${projectDir}`);

  const { name } = await resolveProjectMetadata(projectDir);
  const outPath = out ?? join(projectDir, "target", `${name}.wasm`);

  // WIT events codegen runs BEFORE tsc so the generated .d.ts files are
  // visible during type-checking. Idempotent: if there's no wit/ dir,
  // returns { files: 0, types: 0 } and skips the work.
  const witResult = await codegenWitEvents(projectDir);
  if (witResult.files > 0) {
    console.log(
      `astrid-js-build: wit-events emitted ${witResult.types} type(s) from ${witResult.files} file(s)`,
    );
  }

  const outDir = compileTypeScript(projectDir);
  const userEntry = resolveEntry(projectDir, outDir);
  console.log(`astrid-js-build: user entry = ${userEntry}`);
  const entrySrcPath = await emitEntry(projectDir, userEntry);
  console.log(`astrid-js-build: generated entry = ${entrySrcPath}`);
  const bundledPath = await bundle(entrySrcPath, projectDir);
  console.log(`astrid-js-build: bundled = ${bundledPath}`);
  console.log("astrid-js-build: running componentize-js...");
  const result = await runComponentize(bundledPath, outPath, projectDir);
  console.log(
    `astrid-js-build: wrote ${outPath} (${(result.bytes / 1024 / 1024).toFixed(2)} MB, ${result.componentizeSec}s, ${result.importCount} host imports)`,
  );
  // The kernel-side Rust caller can parse this JSON for the binary path
  // without scraping logs.
  console.log(
    `astrid-js-build-result: ${JSON.stringify({ wasmPath: outPath, bytes: result.bytes })}`,
  );
}

function posixRelative(fromDir, toFile) {
  let rel = relative(fromDir, toFile);
  if (sep !== "/") rel = rel.split(sep).join("/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

main().catch((err) => {
  console.error("astrid-js-build: FAILED");
  console.error(err?.stack ?? err);
  process.exit(1);
});
