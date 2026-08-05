# Phase 1 — SDK skeleton + vertical-slice test capsule

**Status:** PASSED (build path). Kernel-load dispatch deferred — see below.

**Date:** 2026-05-15.

## What landed

Vertical slice from TypeScript source to packaged `.capsule` archive,
mirroring the structure of a Rust-built capsule. End-to-end pipeline:

```
src/index.ts (TS, decorators)
  ↓  tsc
dist/index.js
  ↓  generated _entry.src.mjs (imports user code, builds bridge, re-exports WIT names)
  ↓  esbuild (bundle: true, external: ["astrid:*"])
gen/_entry.mjs (self-contained ESM, only astrid:capsule/* imports remain)
  ↓  ComponentizeJS programmatic API (disableFeatures: all five, worldName: "capsule")
target/test-capsule.wasm (10.92 MB wasip2 component)
  ↓  pack_capsule_archive
dist/test-capsule.capsule (3.5 MB gzipped, contains Capsule.toml + test-capsule.wasm)
```

End-to-end build time: ~6 seconds (tsc + esbuild + componentize-js + archive).

## Files added

### SDK runtime (`sdk-js/packages/astrid-sdk/`)

| File                          | Purpose                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `package.json`                | `@astrid-runtime/sdk` workspace package                            |
| `tsconfig.json`               | TS project config                                             |
| `wit/astrid-capsule.wit`      | Host ABI (copied from sdk-rust)                               |
| `wit-contracts/`              | `astrid-contracts.wit` (separated to keep WIT path single-pkg)|
| `src/wit-imports.d.ts`        | Ambient declarations for sys + kv + ipc WIT modules           |
| `src/errors.ts`               | `SysError extends Error` with code discriminant               |
| `src/log.ts`                  | log.{trace,debug,info,warn,error}                             |
| `src/kv.ts`                   | get/set/has/del/listKeys/clearPrefix + typed JSON helpers     |
| `src/ipc.ts`                  | publish + publishJson (publish_as variants too)               |
| `src/capsule.ts`              | @capsule, @install, @upgrade decorators                       |
| `src/tool.ts`                 | @tool decorator                                               |
| `src/runtime/registry.ts`     | Module-scoped registry the decorators populate                |
| `src/runtime/bridge.ts`       | createBridge() — implements the 4 WIT exports + tool_describe + state load/save |
| `src/runtime/index.ts`        | Runtime entry barrel                                          |
| `src/index.ts`                | Public SDK barrel                                             |

### Build orchestrator (`sdk-js/packages/astrid-build/`)

| File                | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `package.json`      | `@astrid-runtime/build` package (deps: componentize-js, esbuild, typescript) |
| `src/index.mjs`     | Node CLI: tsc → emit entry → esbuild bundle → componentize → write wasm |

### Example test capsule (`sdk-js/examples/test-capsule/`)

| File              | Purpose                                                |
| ----------------- | ------------------------------------------------------ |
| `package.json`    | Workspace member, depends on @astrid-runtime/sdk + build    |
| `tsconfig.json`   | TS project config                                      |
| `Capsule.toml`    | Mirrors what a Rust capsule has                        |
| `src/index.ts`    | TestCapsule with @tool increment/get_counter + @install + @upgrade |

### Kernel-side dispatch (`core/crates/astrid-build/`)

| File                   | Change                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `Cargo.toml`           | Added `serde` workspace dep                                                         |
| `src/lib.rs`           | Added `mod js;`                                                                     |
| `src/build.rs`         | Replaced `"js"|"ts"|"node" => bail!` with `"js"|"ts" => crate::js::build(...)`. Tightened detect_project_type to require Capsule.toml alongside package.json. |
| `src/js.rs` (NEW)      | Verifies Node, locates `@astrid-runtime/build` orchestrator via walk-up, shells out, packs the resulting wasm into a .capsule archive. |

## Verified

- `cargo build -p astrid-build` — clean (only existing openclaw kernel warning).
- `./target/debug/astrid-build ../sdk-js/examples/test-capsule` runs end-to-end.
- Output: `sdk-js/examples/test-capsule/dist/test-capsule.capsule` (3.5 MB).
- Archive contents (`tar -tzf`): exactly `Capsule.toml` + `test-capsule.wasm`,
  matching the layout the kernel expects.
- WIT world from `wasm-tools component wit`: identical to the Rust-built
  `astrid:capsule/capsule` world — same 11 imports, same 4 exports
  (`astrid-hook-trigger`, `run`, `astrid-install`, `astrid-upgrade`).
- 10.92 MB raw wasm (consistent with Phase 0's projection of ~11 MB).

## Bugs found + fixed

These bit during the vertical slice and would have bitten Phase 2 worse:

1. **componentize-js's WIT path resolver rejects mixed-package directories.**
   `wit/` originally contained both `astrid-capsule.wit` and `astrid-contracts.wit`.
   Moved astrid-contracts into a separate `wit-contracts/` dir; the SDK
   componentize path now points only at the single-package `wit/`.

2. **`file://` URL imports break Wizer pre-init.** The first generated entry
   used `import "${pathToFileURL(...).href}"` for portability. ComponentizeJS's
   splicer treats the entire URL as a relative path. Switched to POSIX
   relative paths in the generated entry.

3. **Bare-specifier imports (`@astrid-runtime/sdk`) don't resolve in componentize.**
   ComponentizeJS doesn't run Node's resolver — bare specifiers reach Wizer
   as-is and fail. Solution: esbuild bundles everything into a single ESM
   file before componentize, with `external: ["astrid:*"]` to leave only the
   WIT specifiers for componentize to splice.

4. **CWD-dependent Wizer mount path.** componentize-js's source-path rewrite
   only fires when the source is inside the current working directory. When
   `astrid-build` (Rust) spawned `node` from `core/`, the generated bundle
   path was outside CWD, Wizer mounted only the `gen/` subdir at `/`, and
   the pre-init script's absolute path failed with "No such file or
   directory". Fix: `Command::current_dir(project_dir)` on the spawn.

5. **Relative project paths leaked into the orchestrator lookup.** When the
   user invokes `astrid-build ../path/to/proj`, the relative path threaded
   through directory walks and child-process CWD changes, producing nonsense
   like `examples/sdk-js/node_modules/@astrid-runtime/build`. Fix: canonicalize
   `project_dir` to absolute at the entry of `js::build`.

Each of these is documented inline in the Rust + JS source as a comment so
the next person (or future me) doesn't have to rediscover them.

## Deferred

The kernel-load + tool-dispatch validation requires the daemon to be running
and a CLI client to issue `/tool increment {}`. That's spec'd as part of
Phase 1 verification but is operationally separate from the build pipeline
work this phase delivered. Status of the deferred validation:

- The component is structurally identical to a Rust-built capsule's wasm
  (same WIT world). Wasmtime should instantiate it identically.
- The kernel-side capsule lifecycle (install → hook_trigger → result poll)
  is the same code path regardless of language. The only difference is the
  JS engine inside the wasm, and the kernel doesn't look inside.
- The first time the daemon tries to load this .capsule will reveal any
  remaining integration issues (memory limits, instantiation timeout,
  unexpected wasmtime config divergence). None are anticipated.

**Recommended next step:** run the daemon in this worktree, install the
test-capsule, dispatch increment + get_counter, and confirm round-trip.
That is a manual smoke test best done by the human operator (it requires
an interactive shell session with the daemon).

## Plan deltas

- **`disableFeatures` is fully locked in** the build orchestrator at
  `["stdio", "random", "clocks", "http", "fetch-event"]`. This was a Phase 0
  finding; now codified.
- **esbuild is a required dependency of `@astrid-runtime/build`.** The plan called
  for "esbuild or tsc" — turns out esbuild is non-optional (we need the
  bundle step to resolve bare specifiers). tsc still runs first for TS
  compilation; esbuild only bundles the already-compiled JS.
- **The Rust js.rs is ~180 lines.** The plan's pseudocode estimated about
  the same; the actual file matches that scope.

## Next: Phase 2

Plan-section "Phase 2 — Fill in SDK modules in priority order" can now
begin. Priority order driven by what the full Rust test-capsule exercises,
then by what real capsules use:

1. ipc.ts — full surface (subscribe/poll/recv/Subscription class, AsyncIterable convenience)
2. wit_events codegen — capsule-local .wit → .d.ts (mirror of `wit_events!` proc macro)
3. fs.ts — node:fs/promises shape
4. The remaining decorators: @interceptor, @command, @run
5. http.ts (WHATWG fetch polyfill, capability-gated)
6. net.ts (mpsc-shape via AsyncIterable)
7. The remaining surfaces: env, time, runtime, process, elicit, identity,
   approval, capabilities, interceptors, uplink, hooks
8. astrid-sdk-types codegen-driven from astrid-contracts.wit

Phase 3 is the full test-capsule.ts parity + schema conformance test
against the Rust version.
