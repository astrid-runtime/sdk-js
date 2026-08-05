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
| `fs` | `astrid_sdk::fs` (mirrors `std::fs`) | `node:fs/promises` shape: `readFile`/`writeFile`/`mkdir`/`stat` (returns `Stats` with `isFile()`/`isDirectory()`/`mtimeMs`)/`readdir`/`opendir` (AsyncIterable) |
| `net` | `astrid_sdk::net` (mirrors `std::sync::mpsc`) | mpsc-shaped errors (`RecvError` / `TryRecvError::{Empty,Closed}` / `SendError`) + `Symbol.asyncIterator` streams |
| `process` | `astrid_sdk::process` | `node:child_process` conventions: `spawnSync(cmd, args, options) → ProcessResult` (`spawn` retained for parity), `spawnBackground` returns a disposable handle; `injectedFiles` is an object-union option rather than a Rust builder |
| `env` | `astrid_sdk::env` (mirrors `std::env`) | `env.get(key)`, `CONFIG_SOCKET_PATH` constant |
| `time` | `astrid_sdk::time` | `now() → Date`, `nowMs() → bigint` |
| `log` | `astrid_sdk::log` (mirrors `log` crate) | `log.{trace,debug,info,warn,error}`. **No** `globalThis.console` shadowing — the engine may already wire it. |
| `ipc` | `astrid_sdk::ipc` | `publish`/`publishJson`; `subscribe(topic)` returns a `Subscription` with `.poll()`/`.recv(timeoutMs)` (full parity, surfaces `lagged`/`dropped`) AND `Symbol.asyncIterator` for convenience |
| `kv` | `astrid_sdk::kv` | Map-shaped `get<T>(key)`/`set<T>`/`has`/`del`; versioned reads return a TypeScript discriminated union; raw byte variants remain available |
| `http` | `astrid_sdk::http` (mirrors reqwest) | WHATWG-style `http.fetch()` plus the existing fluent `Request`/`send`/`streamStart` surface; host-specific deadlines, redirects, size caps, HTTPS-only and integrity controls use camel-cased option objects |
| `runtime` | `astrid_sdk::runtime` | `signalReady()`, `caller() → CallerContext`, `socketPath()` |
| `capabilities` | `astrid_sdk::capabilities` | `check(sourceUuid, capability) → boolean` |
| `elicit` | `astrid_sdk::elicit` | `secret`/`hasSecret`/`text`/`textWithDefault`/`select`/`array` (install/upgrade only) |
| `identity` | `astrid_sdk::identity` | `resolve`/`link`/`unlink`/`createUser`/`listLinks` |
| `approval` | `astrid_sdk::approval` | `request(action, resource) → boolean` |
| `uplink` | `astrid_sdk::uplink` | `register(name, platform, profile) → UplinkId`, `send(id, userId, content) → boolean` |
| `interceptors` | `astrid_sdk::interceptors` | `bindings()` / `poll(bindings, handler)` — usually unneeded; `@interceptor` decorator handles dispatch |
| `hooks` | `astrid_sdk::hook` | `HookEvent` with properties, `.json()`, `.reply()`, `.skip()`, `.respond()`; `@hook` handles fail-open dispatch and scoped replies |

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

`kv.setVersioned` writes the same `{"__sv": version, "data": value}` envelope as Rust. `kv.getVersioned` returns a discriminated union (`current`, `needs-migration`, `unversioned`, or `not-found`) for exhaustive narrowing. `kv.getVersionedOrMigrate` writes a successful migration back at the current version and rejects forward-version data.

## Lifecycle hooks

`@hook("before_tool_call")` receives a `HookEvent`. Return `{ skip: true }` or `{ data: "..." }` to publish on the correlation-scoped response topic, or return `undefined` to observe without replying. Fire-and-forget events make manual reply helpers no-ops. Malformed payloads and handler/reply failures are logged and return `continue`, preserving the hook bridge's fail-open contract.

## Async model

The Rust SDK is synchronous because WASM exports are synchronous. The JS SDK is async (`await fs.readFile(...)`) because that's what Node developers expect. ComponentizeJS's syncify makes awaits backed by host imports settle synchronously at the WASM boundary. Use `await` freely inside `@tool` / `@interceptor` / `@run` handlers — the engine settles them before the host returns.

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
