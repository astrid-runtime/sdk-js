# Changelog

All notable changes to `@astrid-runtime/sdk` and `@astrid-runtime/build` are documented
in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.0] - 2026-08-05

### Added

- **Rust SDK behavioral parity with JavaScript-native APIs.** Added semantic lifecycle hooks through `@hook`, the `hooks` module, and `HookEvent`; `astrid:http@1.1.0` request controls and metadata; `astrid:process@1.1.0` read-only child file injection; and schema-versioned KV reads/migrations. The canonical surface is idiomatic JavaScript: `http.fetch()` returns a genuine WHATWG `Response`, the Rust-style fluent form is explicitly named `RequestBuilder`, `process.spawn()` returns a `ChildProcess` while `spawnSync()` captures output, KV results narrow on a camelCase `kind`, and hook events expose `payload`/`canReply`.
- **SDK parity regression tests.** Host-mocked Node tests verify exact WIT record encoding, response metadata, process injection placement, versioned KV migration, and fail-open scoped hook replies.

- **`capabilities.enumerate` — list the calling capsule's own held capability names.** Mirrors the Rust SDK's `capabilities::enumerate`. The list dual of `capabilities.check`: returns the capability categories declared in this capsule's `[capabilities]` manifest block (`host_process`, `net_connect`, `fs_read`, …) — the names, not the scoped arguments within them (allowlists, `host:port`, paths). Argument-free (the kernel already knows the caller) and infallible — an empty array is the valid "no capabilities" answer — so a reusable capsule can ground its behaviour in what it can actually do instead of hard-coding it, avoiding code-vs-manifest drift. Backed by unicity-astrid/wit#13's `astrid:sys/host.enumerate-capabilities`; contracts submodule bumped accordingly (the `astrid:contracts` events bundle is unchanged).
- **`process` persistent-process tier — `spawnPersistent`, `PersistentProcess`, and `process.{attach, listProcesses, statusMany}`.** Mirrors the Rust SDK and the host `astrid:process@1.1.0` persistent tier: a background child that **outlives the pooled, stateless instance** that started it (unlike `BackgroundProcessHandle`, whose kernel resource is reaped on instance reset). `spawnPersistent(cmd, args, options)` takes the persistent knobs (`label`, `keepStdinOpen`, `overflow`, `logRingBytes`, `maxLifetimeMs`, `idleTimeoutMs`, `exitRetentionMs`, `limits`) and returns a `PersistentProcess` keyed by an opaque id. `PersistentProcess` exposes `status` / `readLogs` (drain) / `readSince` (non-draining cursor → byte-faithful `LogChunkResult`; start with `logCursorStart()`) / `writeStdin` / `closeStdin` / `signal` / `wait` (bounded) / `stop` (SIGTERM→grace→SIGKILL, frees the slot) / `release`. Persist `proc.id` (e.g. in KV) and `process.attach(id)` from a later invocation to reattach — `attach` is a thin id-wrapper, so it works without the host's deferred `attach` resource fn; the first id-keyed call validates ownership. `process.listProcesses` / `statusMany` enumerate the capsule+principal's persistent processes. New types: `PersistentProcessInfo`, `SpawnPersistentOptions`, `LogChunkResult`, `ResourceLimits`, `ProcessPhase`, `LogStream`, `LogCursor`, `OverflowPolicy`; `ProcessSignal` gains `"stop"` / `"cont"`. The host's `watch` / `unwatch` lifecycle-event channel and resource-limit enforcement are not yet wired (poll via `status` + bounded `wait`). The persistent surface originated in unicity-astrid/wit#12 and now lives in the additive `@1.1.0` package alongside file injection.

### Changed

- **npm scope migration.** The packages now publish as `@astrid-runtime/sdk` and `@astrid-runtime/build`. The former `@unicity-astrid/*` packages remain at 0.1.0 only and will be deprecated on npm after the new packages are published.
- **JavaScript standard-library makeover.** HTTP ABI conversion is no longer exposed on request objects; WHATWG request input, body consumption, abort, cloning, headers, and URL behavior are preserved. `env.get()` now distinguishes a missing key with `undefined`; `fs` gained Node-compatible recursive options, aliases, file-handle method names, overloads, and real `Dirent` predicates; `time.sleep()` supplies the promise-shaped timer path. Resource constructors are private and public declarations define language-native types instead of importing generated `astrid:*` host-binding modules. Deprecated aliases retain straightforward source migration where their semantics are not misleading.
- **Intentional API breaks before stabilization.** `process.spawn()` now has Node background semantics (use `spawnSync()` for the previous captured behavior), process signals use Node names such as `SIGTERM`, `fs.open()` uses familiar `r`/`r+`/`w`/`a` flags, `UplinkId` is an opaque string rather than a Rust-style wrapper object, and versioned KV discriminants changed from `status: "needs-migration" | "not-found"` to `kind: "needsMigration" | "notFound"`. The misleading HTTP `Request`/`Response` builder aliases were removed in favor of `RequestBuilder`/`BufferedResponse`; `installGlobalFetch()` replaces the old polyfill-named installer.
- The build world now imports `astrid:http/host@1.1.0` and `astrid:process/host@1.1.0`, and stages each WIT package version in a separate dependency directory so frozen 1.0 and 1.1 contracts can coexist.
- Canonical IPC contract types were regenerated from the same WIT revision used by current Rust SDK main, including the additive session-management records.

### Security

- Upgraded the build toolchain to patched `componentize-js` and `esbuild` lines, pinned the compatible audit-clean JCO release, and added a required dependency-audit CI job. This removes the vulnerable `weval → decompress` archive-extraction chain and the affected esbuild development-server version from both the workspace and downstream `@astrid-runtime/build` installations.

## [0.1.0] - 2026-05-26

First non-prerelease. `0.1.0-alpha.0` was the test version; this is the
first release intended for capsule consumers. The contract surface is
the per-domain WIT host ABI introduced alongside the merged
`unicity-astrid/wit` 1.0.0 packages.

### Breaking

- **Per-domain WIT host ABI.** The monolithic `astrid:capsule@0.1.0` world has
  been split into per-domain frozen packages at `@1.0.0`:
  `astrid:fs/host`, `astrid:ipc/host`, `astrid:kv/host`, `astrid:net/host`,
  `astrid:http/host`, `astrid:sys/host`, `astrid:process/host`,
  `astrid:uplink/host`, `astrid:elicit/host`, `astrid:approval/host`,
  `astrid:identity/host`. Foundation I/O is Astrid-owned (no `wasi:io`
  dependency) and lives in `astrid:io/{error,poll,streams}@1.0.0`. Guest
  exports are split into per-export worlds under `astrid:guest@1.0.0`.
- **Resource-backed handles.** Previously-opaque `u64` handles
  (`Subscription`, `FileHandle`, `TcpStream`, `UnixListener`, `ProcessHandle`,
  `HttpStream`, `Pollable`, `InputStream`, `OutputStream`, `Error`) are now
  Component Model resources. SDK wrappers expose them as TypeScript classes
  implementing `Symbol.dispose` so `using sub = ipc.subscribe(...)` releases
  the resource on scope exit. An explicit `.close()` remains available for
  codebases not yet on the explicit-resource-management proposal.
- **Typed `ErrorCode` enums per domain.** Every host fn now returns
  `result<T, error-code>` where `error-code` is a domain-specific variant
  (`astrid:fs/host.error-code`, `astrid:net/host.error-code`, …). `SysError`
  now carries the WIT variant tag on `code` — downstream code can branch
  `if (err.code === "quota") ...` without losing the typed kind. The legacy
  origin classification moved to `SysError.kind`.
- **`fs` module gained the full POSIX surface.** `open` returns a
  `FileHandle` resource with `readAt`/`writeAt`/`syncData`/`syncAll`/`stat`/
  `setLen`. New top-level helpers: `mkdirAll`, `appendFile`, `copy`, `rename`,
  `removeDirAll`, `canonicalize`, `readLink`, `hardLink`, `lstat`. `Stats`
  now exposes `kind`, `mode`, `birthtimeMs`, `atimeMs`, `isSymbolicLink()`.
- **`net` module split into `UnixListener` / `TcpListener` / `TcpStream` /
  `UdpSocket` resources.** New surface: `bindTcp`, `udpBind`, `lookupHost`,
  `TcpStream.{setHopLimit, setKeepalive, setLinger, setReuseaddr,
  readStream, writeStream}`, `UdpSocket.{sendTo, recvFrom, connect, send,
  recv}`. `StreamHandle`/`ListenerHandle` survive as aliases for source
  compatibility.
- **`http.HttpStreamHandle` is now a resource handle** with `subscribeReadable`
  and `bodyStream` for splice-based body forwarding. `HttpMethod` is now a
  variant tag at the WIT layer; the SDK still accepts uppercase strings.
- **`process.BackgroundProcessHandle` gained the full lifecycle surface**:
  `writeStdin`, `closeStdin`, `signal`, `wait`, `waitWithOutput`, `osPid`,
  `subscribeExit`, `subscribeLogs`. `ProcessResult.exitCode` is now
  `number | undefined` (a Unix-signal kill returns `undefined` exit code and
  populates the new `signal` field).
- **`identity` module returns typed `PlatformLink[]` directly** rather than
  a JSON-encoded `linksJson` blob. `IdentityOkResponse` is removed; errors
  surface as `SysError` with the WIT variant on `code`.
- **`approval` module returns the typed `ApprovalDecision`** (one-shot /
  session / always / allowance-hit / denied). New `requestDecision` surfaces
  the full decision; `request` continues to collapse to a boolean.
- **`uplink.UplinkProfile` is now an enum** (`"chat" | "interactive" |
  "notify" | "bridge"`); profile strings outside that set return
  `invalid-profile` from the host.
- **`hooks` module removed.** The `sys::trigger-hook` host fn no longer
  exists in the per-domain WIT. Hook fan-out is now performed via
  `ipc.requestResponse`. Callers that previously used `hooks.trigger(json)`
  should publish on the hook's IPC topic and await the typed response.
- **`SysError.code` semantics changed.** The legacy `code: "HostError" |
  "JsonError" | "ApiError"` field moved to `SysError.kind`; `code` now
  carries the typed WIT variant (e.g. `"capability-denied"`, `"quota"`,
  `"timeout"`). `SysErrorCode` is renamed to `SysErrorKind`.

### Added

- **`ipc.requestResponse<Req, Resp>(requestTopic, responseNamespace, request,
  timeoutMs)`** — mirrors the Rust SDK's `astrid_sdk::ipc::request_response`.
  Pre-subscribes to `<responseNamespace>.<correlationId>` before publishing,
  injects a UUIDv4 `correlation_id` into the request payload, races against
  `timeoutMs`, and always tears down the subscription. Rejects non-object
  payloads synchronously with `SysError.api`.
- **`ipc.publishAs(topic, payload, principal)` and
  `ipc.publishJsonAs(topic, value, principal)`** for uplinks asserting an
  end-user principal. Subscribers see the principal as `claimed`, not
  `verified`.
- **`ipc.IpcMessage.principal`** is now a typed `PrincipalAttribution`
  variant (`verified` / `claimed` / `system`) rather than a bare
  `string | undefined`.
- **`kv.cas(key, expected, newValue)`** for atomic compare-and-swap on
  shared keys, and `kv.listKeysPage(prefix, cursor, limit)` for paginated
  enumeration of unbounded stores.
- **`fs.open(path, mode)` + `FileHandle` resource** for streaming /
  random-access I/O without buffering the whole file.
- **`net.bindTcp`, `net.udpBind`, `net.lookupHost`** for outbound /
  inbound TCP listeners, UDP sockets, and DNS resolution.
- **`runtime.randomBytes(length)`** wrapping the host CSPRNG (audited
  via `sys::random-bytes`).
- **`time.sleepMs`, `time.sleepNs`, `time.monotonicNs`** wrapping the
  host clock / sleep primitives.
- **`env.tryGet(key)`** returns `string | undefined` so callers can
  distinguish "not set" from "set to empty string".

### Changed

- **Build orchestrator** (`@unicity-astrid/build`) synthesises a capsule world
  in `<projectDir>/gen/wit/capsule.wit` mirroring the Rust SDK's
  `astrid-sys` synthetic world. Capsules no longer need to declare their
  own world for the common case.
- **Contracts submodule** (`unicity-astrid/wit`) bumped to commit
  `324d4ab`, which introduces the Astrid-owned `astrid:io@1.0.0`
  foundation primitives.
