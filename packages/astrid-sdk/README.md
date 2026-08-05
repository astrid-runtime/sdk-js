# @unicity-astrid/sdk

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-blue.svg)](../../LICENSE-MIT)
[![Node: >=20](https://img.shields.io/badge/Node-%3E%3D20-blue)](https://nodejs.org)
[![TypeScript: 5.2+](https://img.shields.io/badge/TypeScript-5.2%2B-blue)](https://www.typescriptlang.org)

**The system library for Astrid OS user space, in JavaScript / TypeScript.**

Sibling of [`astrid-sdk`](https://github.com/astrid-runtime/sdk-rust) (Rust). Same host ABI, same WIT contract, same `.capsule` archive shape — the kernel can't tell which language built the binary. Where the Rust SDK mirrors `std`, this one mirrors Node + WHATWG. Same semantics, idiom translated.

## Where it fits

```text
Capsule code (TypeScript or JavaScript)
    |
  @unicity-astrid/sdk           typed modules: fs, net, ipc, kv, http, ...
    |
  WIT-imported bindings    versioned "astrid:<domain>/host" + "astrid:io/*@1.0.0" (ComponentizeJS-generated)
    |
  Kernel                   capability checks, VFS, IPC bus, audit
```

The SDK never reaches the network, filesystem, or any external service directly. Every operation is a WIT host call into the kernel. The kernel decides whether to allow it.

## Module layout

| Module | Rust SDK | Node / WHATWG idiom |
|---|---|---|
| `fs` | `astrid_sdk::fs` (mirrors `std::fs`) | `node:fs/promises` shape: overload-aware `readFile`, recursive `mkdir`/`rm`, real `Dirent` predicates, `copyFile`/`realpath`/`readlink`/`link`, and disposable `FileHandle` objects |
| `net` | `astrid_sdk::net` (mirrors `std::sync::mpsc`) | mpsc-shaped errors (`RecvError` / `TryRecvError::{Empty,Closed}` / `SendError`) + `Symbol.asyncIterator` streams |
| `process` | `astrid_sdk::process` | `node:child_process` conventions: `spawn()` returns a disposable `ChildProcess`; `spawnSync()` captures output; `injectedFiles` is a discriminated object union |
| `env` | `astrid_sdk::env` (mirrors `std::env`) | `env.get(key) → string \| undefined`, `env.getOrThrow(key)`, `CONFIG_SOCKET_PATH` |
| `time` | `astrid_sdk::time` | `now() → Date`, `sleep(ms) → Promise<void>`, plus precise bigint clocks |
| `log` | `astrid_sdk::log` (mirrors `log` crate) | `log.{trace,debug,info,warn,error}`. **No** `globalThis.console` shadowing — the engine may already wire it. |
| `ipc` | `astrid_sdk::ipc` | `publish`/`publishJson`; `subscribe(topic)` returns a `Subscription` with `.poll()`/`.recv(timeoutMs)` (full parity, surfaces `lagged`/`dropped`) AND `Symbol.asyncIterator` for convenience |
| `kv` | `astrid_sdk::kv` | Map-shaped `get<T>(key)`/`set<T>`/`has`/`delete`; versioned reads narrow on `kind`; raw byte variants remain available |
| `http` | `astrid_sdk::http` (mirrors reqwest) | `http.fetch()` returns a genuine WHATWG `Response`; the separate `RequestBuilder`/`send` surface provides fluent buffered calls without shadowing web-platform names |
| `runtime` | `astrid_sdk::runtime` | `signalReady()`, `caller() → CallerContext`, `socketPath()` |
| `capabilities` | `astrid_sdk::capabilities` | `check(sourceUuid, capability) → boolean` |
| `elicit` | `astrid_sdk::elicit` | `secret`/`hasSecret`/`text`/`textWithDefault`/`select`/`array` (install/upgrade only) |
| `identity` | `astrid_sdk::identity` | `resolve`/`link`/`unlink`/`createUser`/`listLinks` |
| `approval` | `astrid_sdk::approval` | `request(action, resource) → boolean` |
| `uplink` | `astrid_sdk::uplink` | `register(name, platform, profile) → UplinkId`, `send(id, userId, content) → boolean` |
| `interceptors` | `astrid_sdk::interceptors` | `bindings()` / `poll(bindings, handler)` — usually unneeded; `@interceptor` decorator handles dispatch |
| `hooks` | `astrid_sdk::hook` | `HookEvent` with `.payload`, `.json()`, `.canReply`, `.reply()`, `.skip()`, `.respond()`; `@hook` handles fail-open dispatch and scoped replies |

## Decorators (replaces `#[capsule]` macro)

| Rust attribute | TypeScript decorator |
|---|---|
| `#[capsule]` on impl block | `@capsule` on class |
| `#[astrid::tool("name")]` | `@tool("name", { mutable?, description?, inputSchema? })` |
| `#[astrid::interceptor("topic")]` | `@interceptor("topic", { mutable? })` |
| `#[astrid::hook("name")]` | `@hook("name", { mutable? })` |
| `#[astrid::command("name")]` | `@command("name", { mutable? })` |
| `#[astrid::install]` | `@install` |
| `#[astrid::upgrade]` | `@upgrade` |
| `#[astrid::run]` | `@run` |

TypeScript 5.2+ standard decorators (TC39 Stage 3). No `experimentalDecorators` flag — default behaviour.

## Quick start

```bash
npm install @unicity-astrid/sdk
npm install --save-dev @unicity-astrid/build typescript
```

```typescript
import { capsule, tool, install, log, kv } from "@unicity-astrid/sdk";

@capsule
export class MyCapsule {
  greetings = 0;

  @tool("greet", { mutable: true })
  greet({ name }: { name: string }): { message: string; count: number } {
    this.greetings++;
    log.info(`greeting ${name} (#${this.greetings})`);
    return { message: `Hello, ${name}!`, count: this.greetings };
  }

  @install
  onInstall(): void {
    log.info("my-capsule installed");
  }
}
```

`astrid build` (from the Rust kernel CLI) detects `package.json + Capsule.toml`, shells out to the `@unicity-astrid/build` Node orchestrator, and emits a `.capsule` archive packaged identically to a Rust capsule's.

## Error model: throw, don't `Result`

The Rust SDK returns `Result<T, SysError>`. This SDK **throws** a `SysError extends Error`. Its `kind` records the origin (`HostError`, `JsonError`, or `ApiError`) and `code` preserves a typed host error such as `quota` or `capability-denied`. Fighting JS to add Rust-shaped result values would be the opposite of "feels native".

## Versioned KV storage

`kv.setVersioned` writes the same `{"__sv": version, "data": value}` envelope as Rust. `kv.getVersioned` returns a `kind`-discriminated union (`current`, `needsMigration`, `unversioned`, or `notFound`) for exhaustive narrowing. `kv.getVersionedOrMigrate` writes a successful migration back at the current version and rejects forward-version data.

```typescript
const settings = kv.getVersioned<Settings>("settings", 3);
switch (settings.kind) {
  case "current":
    return settings.value;
  case "needsMigration":
    return migrate(settings.value, settings.storedVersion);
  case "unversioned":
  case "notFound":
    return defaults;
}
```

## HTTP and child processes

The main HTTP path uses web-platform objects. Astrid controls are additive and
the returned value remains an ordinary `Response`, so `bodyUsed`, `clone()`,
`text()`, `json()`, `blob()`, and stream consumption behave normally.

```typescript
const response = await http.fetch("https://api.example/v1/items", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "capsule" }),
  timeoutMs: 5_000,
  maxResponseBytes: 1_000_000,
  httpsOnly: true,
});

if (!response.ok) throw new Error(`HTTP ${response.status}`);
const item = await response.json();

using child = process.spawn("worker", ["--serve"]);
child.writeStdin(new TextEncoder().encode("ready\n"));
const exit = child.wait(10_000);

const captured = process.spawnSync("worker", ["--version"]);
```

## Lifecycle hooks

`@hook("before_tool_call")` receives a `HookEvent`. Return `{ skip: true }` or `{ data: "..." }` to publish on the correlation-scoped response topic, or return `undefined` to observe without replying. `event.canReply` identifies fire-and-forget events; `reply`, `skip`, and `respond` return whether they published. Malformed payloads and handler/reply failures are logged and return `continue`, preserving the hook bridge's fail-open contract.

## Async model

The Rust SDK is synchronous because WASM exports are synchronous. APIs that are conventionally promise-based in JavaScript, such as `fs.readFile`, `http.fetch`, and `time.sleep`, retain that shape. Explicitly synchronous APIs say so (`process.spawnSync`); resource methods expose the underlying bounded host operation directly. ComponentizeJS's syncify settles promises at the WASM boundary, so `await` works normally inside `@tool`, `@interceptor`, and `@run` handlers.

`@run` handlers that loop forever (`while (true) { await ipc.recv(...) }`) block the WIT `run` export until the loop exits, matching the Rust SDK's daemon-style capsules exactly.

## `tool_describe` and `tool_execute_<name>`

The bridge auto-generates the `tool_describe` aggregated schema payload (lazy, cached) on first invocation, matching what `schemars::schema_for!` produces from Rust capsules. Tool input schemas come from the decorator's `inputSchema` option or, at build time, from `ts-json-schema-generator` walking the parameter types. Schemas may differ in subtle ways from Rust's `schemars` output (e.g. `Option<T>` vs `T | undefined` representation) — acceptable for LLM tool-calling, monitored via a conformance test.

`tool_execute_<name>` dispatch handles `mutable: true` tools by loading `__state` from KV before the call and persisting after on success, matching the Rust macro's behaviour exactly. Result is published to `tool.v1.execute.<name>.result` via IPC.

## Subpath exports

| Import | Contents |
|---|---|
| `@unicity-astrid/sdk` | Public API barrel |
| `@unicity-astrid/sdk/runtime` | Internal registry + bridge — exposed for advanced authors only |
| `@unicity-astrid/sdk/contracts` | Auto-generated TS types from `astrid-contracts.wit` (`Message`, `ToolCall`, `GenerateRequest`, `StreamEvent`, etc.) |

## Status

Alpha. End-to-end build + install + kernel-lifecycle execution proven. See `../../notes/phase-{0,1,2,3-install}.md`.

## License

Dual MIT/Apache-2.0. See [LICENSE-MIT](../../LICENSE-MIT) and [LICENSE-APACHE](../../LICENSE-APACHE).
