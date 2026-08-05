# sdk-js

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-blue.svg)](LICENSE-MIT)
[![Node: >=20](https://img.shields.io/badge/Node-%3E%3D20-blue)](https://nodejs.org)
[![TypeScript: 5.2+](https://img.shields.io/badge/TypeScript-5.2%2B-blue)](https://www.typescriptlang.org)

**The JavaScript / TypeScript SDK for building [Astrid](https://github.com/astrid-runtime/astrid) capsules.**

Companion to [sdk-rust](https://github.com/astrid-runtime/sdk-rust). Same WIT contract, same wasip2 Component Model output, same `.capsule` archive format — your kernel can't tell which language built the binary. Where the Rust SDK feels like writing against `std`, this one feels like writing against `node:fs/promises` / WHATWG / Node's `EventEmitter`. Same host ABI, idiom translated.

## Packages

| Package | Role |
|---|---|
| `@unicity-astrid/sdk` | The capsule author API. Module-by-module mirror of `astrid-sdk`'s prelude — `fs`, `net`, `process`, `env`, `time`, `log`, plus Astrid-specific `ipc`, `kv`, `http`, `hooks`, `uplink`, `identity`, `approval`, `runtime`, `elicit`, `capabilities`, `interceptors`. TypeScript decorators (`@capsule`, `@tool`, `@interceptor`, `@hook`, `@command`, `@install`, `@upgrade`, `@run`) replace Rust attributes. |
| `@unicity-astrid/build` | Build orchestrator. Runs `tsc` + esbuild + ComponentizeJS programmatic API. Emits a `wasm32-wasip2` component that the Rust-side `astrid-build` packs into a `.capsule` archive. |
| `@unicity-astrid/sdk/contracts` | Auto-generated TS types from `astrid-contracts.wit` — IPC event types (`Message`, `ToolCall`, `GenerateRequest`, `StreamEvent`, etc.) usable on both ends of cross-capsule IPC. |

## Quick start

```bash
mkdir my-capsule && cd my-capsule
npm init -y
npm install @unicity-astrid/sdk
npm install --save-dev @unicity-astrid/build typescript
```

`Capsule.toml`:

```toml
[package]
name = "my-capsule"
version = "0.1.0"

[[component]]
id = "my-capsule"
file = "my-capsule.wasm"
type = "executable"

[capabilities]
kv = ["*"]

[publish]
"tool.v1.execute.*" = { wit = "opaque" }
```

`src/index.ts`:

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

Build:

```bash
astrid build           # or: astrid capsule install .
```

That's it. `tsc` compiles your TypeScript, esbuild bundles in the SDK, ComponentizeJS produces a `wasip2` component, the Rust-side `astrid-build` packs it into `dist/my-capsule.capsule`.

## Building capsules

End-to-end pipeline:

```
src/*.ts
   ↓  tsc (typecheck + emit dist/*.js)
   ↓  esbuild (bundle dist/ + @unicity-astrid/sdk into one ESM, mark astrid:* WIT specifiers external)
   ↓  ComponentizeJS programmatic API (StarlingMonkey + your bundle → wasip2 Component)
target/<name>.wasm
   ↓  pack_capsule_archive (Rust side)
dist/<name>.capsule (Capsule.toml + .wasm + wit/, gzipped tar)
```

`tsc` and esbuild run from `@unicity-astrid/build/src/index.mjs` — a small Node CLI invoked by Rust's `astrid build` when it detects a `package.json + Capsule.toml` project.

## Trade-off: binary size

JS capsules cost ~11 MB raw (3.5 MB gzipped in the `.capsule` archive). That's the StarlingMonkey embed. Rust capsules are ~200 KB. Acceptable for daemon-mode workloads (capsules load once); if size matters more than ergonomics, write Rust.

The host ABI is identical, so a hot capsule can be ported between languages without kernel changes.

## Repository layout

```
sdk-js/
├── packages/
│   ├── astrid-sdk/        @unicity-astrid/sdk — public API
│   ├── astrid-build/      @unicity-astrid/build — build orchestrator
│   └── ...
├── examples/
│   └── test-capsule/      Minimal end-to-end example mirroring sdk-rust/examples/test-capsule
├── notes/                 Phase-by-phase development notes (Phase 0–3)
├── package.json           npm workspace root
└── tsconfig.base.json
```

## Development

```bash
npm install
npm --workspace @unicity-astrid/sdk run build
node packages/astrid-build/src/index.mjs examples/test-capsule
```

Or, from a kernel checkout with the JS dispatch wired into `astrid-build`:

```bash
cd core
cargo build -p astrid-build
./target/debug/astrid-build ../sdk-js/examples/test-capsule
```

## Status

Alpha. The vertical slice (TypeScript → wasip2 component → `.capsule` → installed by `astrid capsule install` → kernel lifecycle hook execution) is proven end-to-end. Daemon-mode tool-dispatch round-trip (`/tool greet { "name": "world" }`) is on the same code path as install — same wasmtime instantiation, same linker contract — and ready for human-operator smoke testing.

See `notes/phase-{0,1,2,3-install}.md` for development history, design decisions, and known follow-ups.

## License

Dual-licensed under [MIT](LICENSE-MIT) and [Apache 2.0](LICENSE-APACHE).

Copyright (c) 2025-2026 Joshua J. Bouw and Unicity Labs.
