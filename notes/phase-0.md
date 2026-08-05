# Phase 0 — Toolchain & kernel validation

**Status:** PASSED. Proceed to Phase 1.

**Date:** 2026-05-15.

## What Phase 0 was for

The plan (`/Users/joshuaj.bouw/.claude/plans/hey-claude-got-task-rippling-harbor.md`)
made five unverified assumptions before any SDK code lands. Phase 0 tested each:

1. ComponentizeJS still exists, is installable, has a usable programmatic Node API.
2. It can produce a `wasm32-wasip2` component that imports *zero* WASI surfaces
   (so the Astrid kernel doesn't need to implement WASI 0.2).
3. The JS-side binding shape ComponentizeJS emits is discoverable and documentable.
4. It can componentize a JS guest against the real `astrid-capsule.wit`
   (49 host imports across 11 interfaces, 4 guest exports).
5. The produced component's WIT-exported world exactly matches what the
   kernel loads from a Rust-built capsule.

All five hold.

## Toolchain (recorded)

| Tool                                | Version   | Source                                              |
| ----------------------------------- | --------- | --------------------------------------------------- |
| Node.js                             | 20.19.6   | System (Homebrew or asdf)                           |
| npm                                 | 10.8.2    | Bundled with Node                                   |
| `@bytecodealliance/componentize-js` | 0.18.5    | npm registry                                        |
| `@bytecodealliance/jco`             | 1.19.0    | npm registry                                        |
| Bundled engine                      | StarlingMonkey (`starlingmonkey_embedding.wasm`) + SpiderMonkey splicer (`spidermonkey-embedding-splicer.core.wasm`) co-installed | Inside the componentize-js package |
| `wasm-tools`                        | Cargo-installed                  | `~/.cargo/bin/wasm-tools`        |

The README still leads with "SpiderMonkey embedding" but the artifact ships
both engines side-by-side. The default componentize path uses StarlingMonkey
with weval AOT pre-init (`starlingmonkey_embedding_weval.wasm` +
`starlingmonkey_ics.wevalcache`).

## Binary size

Larger than the plan's hand-wave estimate (6–8 MB). Recorded actual figures:

| Scenario                                                       | Size      | Componentize time |
| -------------------------------------------------------------- | --------- | ----------------- |
| One trivial export, all WASI features disabled                 | 10.58 MB  | 5.12 s            |
| Two host imports + two exports                                 | 10.58 MB  | 5.48 s            |
| Full `astrid-capsule.wit` (49 imports / 4 exports)             | 10.86 MB  | 5.28 s            |

So **~11 MB per JS capsule, plus ~5–6 s build time**. The plan called for
this number to be validated; it's higher than estimated but acceptable. The
binary is gzip-compressible (componentize-js README claims ~2 MB compressed,
not verified here).

## WASI imports: disable everything to keep the kernel WASI-free

By default, `componentize` emits a component that imports a large WASI 0.2
surface (`wasi:io/streams`, `wasi:cli/stdout`, `wasi:clocks/monotonic-clock`,
`wasi:filesystem/types`, `wasi:random/random`, etc). The Astrid kernel does
**not** provide WASI 0.2 today — those imports would be unsatisfiable and the
component would refuse to instantiate.

**Pass `disableFeatures: ["stdio", "random", "clocks", "http", "fetch-event"]`**
to the componentize call. With all five disabled, the component's WIT world
contains ZERO WASI imports — only the Astrid imports we declared in our WIT.
Verified via `wasm-tools component wit`.

This must be the default in our build pipeline.

Note: even with `stdio` disabled, the `console` global remains available to
JS code (per componentize-js's README "Platform APIs" section). So we don't
need a polyfill for `console.log` to work inside a capsule.

## Host-import binding shape (the integration-shape question)

ComponentizeJS makes host functions available as standard JS module imports.
The import specifier is constructed from the WIT package + interface name +
version (if the WIT package has a version). Function names are converted
kebab-case → camelCase.

For the actual Astrid host ABI (`package astrid:capsule@0.1.0`):

```js
import { log, getCaller, getConfig, clockMs, signalReady, triggerHook,
         checkCapsuleCapability } from "astrid:capsule/sys@0.1.0";
import { ipcPublish, ipcPublishAs, ipcSubscribe, ipcUnsubscribe,
         ipcPoll, ipcRecv, getInterceptorHandles } from "astrid:capsule/ipc@0.1.0";
import { kvGet, kvSet, kvDelete, kvListKeys, kvClearPrefix }
       from "astrid:capsule/kv@0.1.0";
// ... etc., one module per WIT interface.
```

Variant types arrive as discriminated unions tagged with a `tag` field
(`{ tag: "info" }` for the `log-level` enum, for example). Records arrive
as objects with kebab-case field names converted to camelCase. The plan's
table mapping for the SDK wrapper layer can rely on this exact shape.

**Critical caveat: package versions in import specifiers.** Componentize-js
0.18.5 will fail with `Error loading module "..."` if the WIT declares a
versioned package (`package foo:bar@1.0.0;`) but the JS import omits the
version (`import { x } from "foo:bar/iface"`). The import path **must
include the version**: `import { x } from "foo:bar/iface@1.0.0"`. Since
`astrid-capsule.wit` declares `package astrid:capsule@0.1.0`, every JS
import in the SDK must include `@0.1.0`.

This is a real correctness gotcha. The SDK build step should mechanically
emit the right specifiers; capsule authors will never type these directly.

## Guest exports

The `capsule` world declares four guest exports. They map to JS exports
with kebab-case → camelCase conversion:

| WIT export             | JS export name       |
| ---------------------- | -------------------- |
| `astrid-hook-trigger`  | `astridHookTrigger`  |
| `run`                  | `run`                |
| `astrid-install`       | `astridInstall`      |
| `astrid-upgrade`       | `astridUpgrade`      |

The `capsule-result` record returned by `astrid-hook-trigger` maps to a JS
object `{ action: string, data: string | undefined }`.

Verified via the Phase 0 `full-wit-stub.js` + `build-full-wit.mjs` build:
componentize emits a component whose `wasm-tools component wit` output is
an exact superset of the real `astrid-capsule.wit` world (imports + exports
both match line-for-line modulo the `package root:component` wrapper).

## Imports list reflects the WIT contract, not actual JS usage

`componentize`'s return value includes a `declaredImports` field. With the
full astrid-capsule.wit, this listed all 49 host functions — even though
the JS source only `import`s two of them. The component declares all 49
as required from the host.

The Astrid kernel already implements all 49 (this is the same WIT contract
Rust capsules use), so this is fine for our case. But it means JS capsules
have no tree-shaking of host imports at the WIT-contract level — they pay
the full surface area regardless of what they call. Acceptable.

## Decisions locked in for Phase 1

- **ComponentizeJS programmatic Node API**, not the CLI. (Confirmed working;
  the CLI flag surface is less stable.)
- **`disableFeatures: ["stdio", "random", "clocks", "http", "fetch-event"]`**
  is the default. The SDK provides Astrid-routed implementations of any
  functionality these features would otherwise offer (notably `fetch` via the
  `astrid:capsule/http` interface).
- **Import path format**: `"astrid:capsule/<iface>@0.1.0"`. The SDK ships
  pre-written wrapper modules with these specifiers baked in; capsule authors
  import from `@astrid-runtime/sdk` and never see the raw WIT paths.
- **JS engine**: StarlingMonkey (with weval AOT). Bundled by default.
- **Binary size budget**: 11 MB per capsule. Plan section "Out of scope"
  already says we revisit AssemblyScript only if this becomes a real problem.

## Plan updates triggered by Phase 0

- The plan said "~6-8 MB per JS capsule binary". Update to **~11 MB**.
- The plan's `disableFeatures` invocation in `astrid build` should be
  explicit and locked: all five features disabled.
- The `@0.1.0` suffix on every host-import path is a hard requirement, not a
  detail. Document loudly in the SDK build code.

## Deferred to Phase 1

The original Phase 0 plan included loading a JS-built component in the actual
kernel and dispatching a tool. That has been **deferred to Phase 1** because:

- Phase 0 has already proved the toolchain produces a binary whose WIT-exported
  world matches the kernel's contract exactly (verified via `wasm-tools
  component wit`).
- The remaining question — does the kernel's specific wasmtime configuration
  instantiate the component cleanly — is most efficiently answered by going
  through the real install pipeline (pack `.capsule`, `astrid install`,
  dispatch via the kernel), which is exactly the first deliverable of Phase 1.
- Writing a one-off wasmtime harness in Rust to test this in isolation would
  duplicate Phase 1 work for no information gain.

If Phase 1's vertical slice fails at the kernel-instantiation step, we'll
reconsider whether a more isolated bisection harness is worth building.

## Files produced in Phase 0

```
sdk-js/
├── notes/
│   └── phase-0.md                    # this document
└── scratch/
    └── phase0/
        ├── package.json              # componentize-js + jco dependencies
        ├── hello.wit                 # trivial world, one export
        ├── hello.js
        ├── build-hello.mjs           # first componentize, validates toolchain
        ├── with-import.wit           # world with one custom host interface
        ├── with-import.js            # JS that imports + calls host fns
        ├── build-with-import.mjs     # validates binding shape
        ├── wit-real/
        │   └── astrid-capsule.wit    # copy of sdk-rust/astrid-sys/wit/astrid-capsule.wit
        ├── full-wit-stub.js          # stub guest implementing all 4 exports
        ├── build-full-wit.mjs        # componentizes against real WIT
        └── dist/
            ├── hello.wasm            # 10.58 MB
            ├── with-import.wasm      # 10.58 MB
            └── full-wit-stub.wasm    # 10.86 MB
```

The `scratch/` tree is throwaway — once Phase 1's `sdk-js/packages/` layout
lands, these can be deleted. Keeping them through Phase 1 in case we need to
re-verify a toolchain detail.
