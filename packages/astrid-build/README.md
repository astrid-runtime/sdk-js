# @unicity-astrid/build

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-blue.svg)](../../LICENSE-MIT)
[![Node: >=20](https://img.shields.io/badge/Node-%3E%3D20-blue)](https://nodejs.org)

**The compiler that turns a TypeScript class into a WASM capsule.**

JavaScript counterpart of [`astrid-sdk-macros`](https://github.com/astrid-runtime/sdk-rust/tree/main/astrid-sdk-macros). Rust uses a proc macro that runs at `cargo build` time; JavaScript needs the same work done by external tooling that runs at `astrid build` time. This package is that tooling.

Do not depend on this package directly from capsule code. It is invoked by the Rust kernel's `astrid-build` binary when it detects a `package.json + Capsule.toml` project, and emits the `wasm32-wasip2` component that the Rust side packs into the `.capsule` archive.

## Pipeline

```
sdk-js/packages/astrid-build/src/index.mjs <project-dir> --out <wasm-path>

1. Read package.json (name, version)
2. wit-events codegen: walk project/wit/, emit project/gen/*.d.ts mirroring `wit_events!`
3. tsc: compile src/*.ts → dist/*.js, using project's tsconfig.json
4. Emit gen/_entry.src.mjs that imports the user's compiled entry,
   constructs the SDK bridge, re-exports the four WIT export names
5. esbuild bundle: gen/_entry.src.mjs + @unicity-astrid/sdk → gen/_entry.mjs
   (one self-contained ESM file, "astrid:*" specifiers marked external)
6. ComponentizeJS programmatic API: gen/_entry.mjs + wit/ → target/<name>.wasm
   (with disableFeatures: all five, so the output has zero WASI imports)
7. Print {wasmPath, bytes} as the final stdout line for the caller to parse
```

The Rust `astrid-build` then calls `pack_capsule_archive` on the resulting `.wasm` to produce a `dist/<name>.capsule` archive structurally identical to a Rust-built capsule.

## What the bridge generates

The `gen/_entry.mjs` is a thin wrapper that:

- **Imports the user code** (decorators fire and populate the SDK registry)
- **Builds the bridge** via `createBridge()` from `@unicity-astrid/sdk/runtime`
- **Re-exports the four WIT-required guest functions**: `astridHookTrigger`, `run`, `astridInstall`, `astridUpgrade`

The bridge runtime in `@unicity-astrid/sdk` dispatches:

- `tool_describe` → lazy-built aggregated schema list (`{ tools: [...], description: "..." }`)
- `tool_execute_<name>` → optional KV `__state` load → user handler → optional state save → IPC publish to `tool.v1.execute.<name>.result` → return `{ action: "continue", data: undefined }`
- interceptor topic name → user handler → return result via `capsule-result.data`
- command name → same as interceptor

This mirrors `astrid-sdk-macros::capsule_impl` exactly, including the runnable-vs-hook-driven duality from `#[astrid::run]`.

## Compile-time enforcement

Decorator violations are caught at **registration time** (when the class first evaluates), not deferred to runtime:

- Two `@install` methods on one class → throws at module load
- Two `@upgrade` methods → throws
- Two `@run` methods → throws
- Two `@tool("name")` with the same name → throws
- Two `@interceptor("topic")` with the same topic → throws
- `@install` / `@upgrade` / `@run` on a private or static method → throws

Schema input types are typechecked by `tsc` at build time. WIT event types are checked against generated `gen/<file>.d.ts`.

## Configuration

The orchestrator currently accepts:

| Flag | Description |
|---|---|
| `<project-dir>` | Path to the capsule project (required) |
| `--out <wasm-path>` | Where to write the componentized wasm (defaults to `<project>/target/<name>.wasm`) |

The Rust kernel locates this script via:

1. `$ASTRID_JS_BUILD` environment variable (absolute path override, dev-only)
2. `<project>/node_modules/@unicity-astrid/build/src/index.mjs` (walked up like Node's resolver, so npm-workspaces hoisting works)

## ComponentizeJS configuration

The orchestrator pins:

- `worldName: "capsule"` (the world declared in `astrid-capsule.wit`)
- `disableFeatures: ["stdio", "random", "clocks", "http", "fetch-event"]` — strips all WASI imports so the kernel doesn't need to provide WASI. Without this, the component would fail to instantiate against the kernel's linker.

These are not configurable — they are correctness requirements, not options.

## Development

```bash
npm install
node src/index.mjs ../../examples/test-capsule
```

## License

Dual MIT/Apache-2.0. See [LICENSE-MIT](../../LICENSE-MIT) and [LICENSE-APACHE](../../LICENSE-APACHE).
