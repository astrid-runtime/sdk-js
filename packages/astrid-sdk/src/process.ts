/**
 * Host process spawning over `astrid:process/host@1.1.0`. Mirrors
 * `astrid_sdk::process`. Capsules need the
 * `host_process` capability for the specific command being invoked; the
 * kernel runs the process under platform sandboxing (sandbox-exec on macOS,
 * bwrap on Linux).
 *
 * Per-capsule cap: 8 concurrent background processes. `ProcessHandle` is a
 * Component Model resource — drop releases the slot and reaps the child.
 *
 * **Desktop-kernel only.** Unikernel targets (hermit-rs, etc.) do not implement
 * this package; capsules importing `astrid:process` will fail to load there.
 */

import {
  spawn as hostSpawn,
  spawnBackground as hostSpawnBackground,
  spawnPersistent as hostSpawnPersistent,
  listProcesses as hostListProcesses,
  status as hostStatus,
  statusMany as hostStatusMany,
  readLogs as hostReadLogsById,
  readSince as hostReadSince,
  writeStdin as hostWriteStdinById,
  closeStdin as hostCloseStdinById,
  signal as hostSignalById,
  wait as hostWaitById,
  stop as hostStop,
  releaseProcess as hostReleaseProcess,
  type ProcessHandle as WitProcessHandle,
  type ProcessSignal,
  type SpawnRequest,
  type ExitInfo,
  type ProcessInfo as WitProcessInfo,
  type ProcessPhase,
  type LogStream,
  type LogCursor,
  type OverflowPolicy,
  type FileInjection as WitFileInjection,
} from "astrid:process/host@1.1.0";
import { SysError, callHost } from "./errors.js";

export type {
  ProcessSignal,
  EnvVar,
  ProcessPhase,
  LogStream,
  LogCursor,
  OverflowPolicy,
} from "astrid:process/host@1.1.0";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  /** Exit code if exited normally; `undefined` if killed by signal. */
  exitCode: number | undefined;
  /** Unix signal number if killed by signal; `undefined` otherwise. */
  signal: number | undefined;
}

export interface ProcessLogs {
  stdout: string;
  stderr: string;
  running: boolean;
  exitCode: number | undefined;
  signal: number | undefined;
}

export interface KillResult {
  killed: boolean;
  exitCode: number | undefined;
  signal: number | undefined;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  /** Working directory relative to the workspace. */
  cwd?: string;
  /** Environment variables to pass to the child. */
  env?: Record<string, string>;
  /** Stdin bytes piped to the child on spawn. */
  stdin?: Uint8Array;
  /** Host-owned, read-only files exposed only inside the spawned child. */
  injectedFiles?: readonly InjectedFile[];
}

/**
 * A host-verified file snapshot for a child process. `env` is portable across
 * Linux and macOS; `path` is a fixed in-sandbox path and is Linux-only.
 */
export type InjectedFile =
  | { content: string | Uint8Array; env: string; path?: never }
  | { content: string | Uint8Array; path: string; env?: never };

function buildSpawnRequest(
  cmd: string,
  args: string[],
  options: SpawnOptions | undefined,
): SpawnRequest {
  return {
    cmd,
    args,
    stdin: options?.stdin,
    env: options?.env
      ? Object.entries(options.env).map(([key, value]) => ({ key, value }))
      : [],
    cwd: options?.cwd,
    fileInjections: (options?.injectedFiles ?? []).map(toWitFileInjection),
    // Persistent-only fields — left unset for the ephemeral `spawn` /
    // `spawnBackground` paths (the host ignores them there anyway).
    limits: undefined,
    label: undefined,
    keepStdinOpen: undefined,
    overflow: undefined,
    logRingBytes: undefined,
    maxLifetimeMs: undefined,
    idleTimeoutMs: undefined,
    exitRetentionMs: undefined,
  };
}

function toWitFileInjection(file: InjectedFile): WitFileInjection {
  const content = typeof file.content === "string"
    ? new TextEncoder().encode(file.content)
    : file.content;
  if ("env" in file && typeof file.env === "string" && file.env.length > 0) {
    return { content, placement: { tag: "env-pointer", val: file.env } };
  }
  if ("path" in file && typeof file.path === "string" && file.path.length > 0) {
    return { content, placement: { tag: "fixed-path", val: file.path } };
  }
  throw SysError.api("each injected file must specify one non-empty env or path");
}

function unpackExit(exit: ExitInfo): { exitCode: number | undefined; signal: number | undefined } {
  return { exitCode: exit.exitCode, signal: exit.signal };
}

/** Spawn a process and block until it exits. */
export function spawn(
  cmd: string,
  args: string[] = [],
  options?: SpawnOptions,
): ProcessResult {
  const request = buildSpawnRequest(cmd, args, options);
  const result = callHost(`process.spawn(${JSON.stringify(cmd)})`, () =>
    hostSpawn(request),
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    ...unpackExit(result.exit),
  };
}

/** Node-compatible name for the blocking spawn helper. */
export const spawnSync = spawn;

/** Spawn a background process. Returns a resource handle. */
export function spawnBackground(
  cmd: string,
  args: string[] = [],
  options?: SpawnOptions,
): BackgroundProcessHandle {
  const request = buildSpawnRequest(cmd, args, options);
  const inner = callHost(`process.spawnBackground(${JSON.stringify(cmd)})`, () =>
    hostSpawnBackground(request),
  );
  return new BackgroundProcessHandle(inner);
}

export class BackgroundProcessHandle {
  #inner: WitProcessHandle | undefined;

  constructor(inner: WitProcessHandle) {
    this.#inner = inner;
  }

  /** Drain buffered stdout/stderr since the last read. */
  readLogs(): ProcessLogs {
    const result = callHost("process.readLogs", () => this.#requireInner().readLogs());
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      running: result.running,
      exitCode: result.exit?.exitCode,
      signal: result.exit?.signal,
    };
  }

  /** Write to stdin. Returns bytes actually written. */
  writeStdin(data: Uint8Array): number {
    return callHost("process.writeStdin", () => this.#requireInner().writeStdin(data));
  }

  /** Close the stdin pipe (child observes EOF). */
  closeStdin(): void {
    callHost("process.closeStdin", () => this.#requireInner().closeStdin());
  }

  /** Send a signal (fire-and-forget). Use {@link kill} for SIGKILL + log drainage. */
  signal(sig: ProcessSignal): void {
    callHost(`process.signal(${sig})`, () => this.#requireInner().signal(sig));
  }

  /** Send SIGKILL and drain remaining output. */
  kill(): KillResult {
    const result = callHost("process.kill", () => this.#requireInner().kill());
    return {
      killed: result.killed,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exit?.exitCode,
      signal: result.exit?.signal,
    };
  }

  /**
   * Wait for the process to exit. `timeoutMs = undefined` waits indefinitely;
   * a bounded value throws `wait-timeout` if the timeout elapses first.
   */
  wait(timeoutMs?: number): { exitCode: number | undefined; signal: number | undefined } {
    const ms = timeoutMs === undefined ? undefined : BigInt(Math.max(0, Math.floor(timeoutMs)));
    const exit = callHost(`process.wait(${timeoutMs ?? "∞"})`, () =>
      this.#requireInner().wait(ms),
    );
    return unpackExit(exit);
  }

  /** Wait for the process AND drain remaining stdout/stderr atomically. */
  waitWithOutput(timeoutMs?: number): ProcessResult {
    const ms = timeoutMs === undefined ? undefined : BigInt(Math.max(0, Math.floor(timeoutMs)));
    const result = callHost(`process.waitWithOutput(${timeoutMs ?? "∞"})`, () =>
      this.#requireInner().waitWithOutput(ms),
    );
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      ...unpackExit(result.exit),
    };
  }

  /** OS-level PID. Throws if the process has already been reaped. */
  osPid(): number {
    return callHost("process.osPid", () => this.#requireInner().osPid());
  }

  close(): void {
    if (this.#inner === undefined) return;
    const inner = this.#inner;
    this.#inner = undefined;
    try {
      inner[Symbol.dispose]();
    } catch {
      // already released
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #requireInner(): WitProcessHandle {
    if (this.#inner === undefined) throw SysError.api("ProcessHandle is closed");
    return this.#inner;
  }
}

// ============================================================
// Persistent tier
//
// A persistent process survives the pooled, stateless instance that spawned
// it (unlike the ephemeral `BackgroundProcessHandle`, whose kernel resource is
// reaped on instance reset). It is keyed by an opaque process id that any
// later invocation of the same capsule+principal can `attach` to.
// ============================================================

/** Per-child OS resource ceilings. (Host enforcement is not yet wired.) */
export interface ResourceLimits {
  maxMemoryBytes?: number;
  maxCpuSecs?: number;
  maxPids?: number;
  maxOpenFiles?: number;
}

/** Options for {@link spawnPersistent} — `SpawnOptions` plus persistent knobs. */
export interface SpawnPersistentOptions extends SpawnOptions {
  /** Operator-readable label surfaced in {@link listProcesses} / status. */
  label?: string;
  /** Keep stdin open after the prelude so {@link PersistentProcess.writeStdin} works. */
  keepStdinOpen?: boolean;
  /** Per-stream ring overflow policy (default `drop-oldest`). */
  overflow?: OverflowPolicy;
  /** Per-stream output ring capacity in bytes. */
  logRingBytes?: number;
  /** Wall-clock lifetime ceiling (ms). Clamped DOWN to the host ceiling. */
  maxLifetimeMs?: number;
  /** Reap if untouched for this long (ms) — anti-leak backstop. */
  idleTimeoutMs?: number;
  /** Retain id + log tail this long (ms) after exit. */
  exitRetentionMs?: number;
  /** Per-child OS resource ceilings. */
  limits?: ResourceLimits;
}

/** A non-draining status snapshot of one persistent process. */
export interface PersistentProcessInfo {
  /** Reattach key, stable across invocations / instances. */
  id: string;
  label: string;
  command: string;
  /** OS PID while running; `undefined` once reaped. Advisory only. */
  osPid: number | undefined;
  phase: ProcessPhase;
  exitCode: number | undefined;
  signal: number | undefined;
  ageMs: number;
  idleMs: number;
  bufferedBytes: number;
  bytesDropped: number;
  stdinOpen: boolean;
  /** Cumulative CPU ms. `undefined` until the host populates it. */
  cpuMs: number | undefined;
  /** Peak resident memory. `undefined` until the host populates it. */
  memBytesPeak: number | undefined;
}

/** A non-draining, cursor-addressed slice of a persistent process's stream. */
export interface LogChunkResult {
  /** Byte-faithful bytes in `[requested-cursor, next)`. */
  data: Uint8Array;
  /** Opaque cursor to pass to the next {@link PersistentProcess.readSince}. */
  next: LogCursor;
  /** Bytes evicted before delivery through this cursor (0 unless behind). */
  bytesDropped: number;
  /** `true` once the child exited AND all retained output was delivered. */
  drainedEof: boolean;
}

/** An opaque cursor positioned at the oldest retained byte. */
export function logCursorStart(): LogCursor {
  return { token: undefined };
}

/**
 * Convert an optional millisecond / byte / count knob to a host `bigint`.
 * Non-finite input (`Infinity` / `NaN`) becomes `undefined` — read as "no
 * caller limit, use the host default/ceiling" — rather than throwing a cryptic
 * `RangeError` from `BigInt(Infinity)`. Negatives clamp to 0. Used for the
 * soft, host-clamped knobs (TTLs, resource limits, stop grace); a required
 * bounded value like `wait`'s timeout validates and throws instead.
 */
function toSafeBigInt(val: number | undefined): bigint | undefined {
  return val === undefined || !Number.isFinite(val)
    ? undefined
    : BigInt(Math.max(0, Math.floor(val)));
}

function buildPersistentRequest(
  cmd: string,
  args: string[],
  options: SpawnPersistentOptions | undefined,
): SpawnRequest {
  const base = buildSpawnRequest(cmd, args, options);
  return {
    ...base,
    label: options?.label,
    keepStdinOpen: options?.keepStdinOpen,
    overflow: options?.overflow,
    logRingBytes: options?.logRingBytes,
    maxLifetimeMs: toSafeBigInt(options?.maxLifetimeMs),
    idleTimeoutMs: toSafeBigInt(options?.idleTimeoutMs),
    exitRetentionMs: toSafeBigInt(options?.exitRetentionMs),
    limits: options?.limits
      ? {
          maxMemoryBytes: toSafeBigInt(options.limits.maxMemoryBytes),
          maxCpuSecs: toSafeBigInt(options.limits.maxCpuSecs),
          maxPids: options.limits.maxPids,
          maxOpenFiles: options.limits.maxOpenFiles,
        }
      : undefined,
  };
}

function unpackInfo(i: WitProcessInfo): PersistentProcessInfo {
  return {
    id: i.id,
    label: i.label,
    command: i.command,
    osPid: i.osPid,
    phase: i.phase,
    exitCode: i.exit?.exitCode,
    signal: i.exit?.signal,
    ageMs: Number(i.ageMs),
    idleMs: Number(i.idleMs),
    bufferedBytes: Number(i.bufferedBytes),
    bytesDropped: Number(i.bytesDropped),
    stdinOpen: i.stdinOpen,
    cpuMs: i.cpuMs === undefined ? undefined : Number(i.cpuMs),
    memBytesPeak: i.memBytesPeak === undefined ? undefined : Number(i.memBytesPeak),
  };
}

/**
 * Spawn a PERSISTENT background process whose lifetime is decoupled from the
 * calling instance. Returns a {@link PersistentProcess} keyed by an opaque id
 * that any LATER invocation of the same capsule+principal can {@link attach}
 * to — unlike {@link spawnBackground}, it survives the pooled instance being
 * reset between tool invocations.
 */
export function spawnPersistent(
  cmd: string,
  args: string[] = [],
  options?: SpawnPersistentOptions,
): PersistentProcess {
  const request = buildPersistentRequest(cmd, args, options);
  const id = callHost(`process.spawnPersistent(${JSON.stringify(cmd)})`, () =>
    hostSpawnPersistent(request),
  );
  return new PersistentProcess(id);
}

/**
 * A handle to a PERSISTENT background process, keyed by its opaque id.
 *
 * Unlike {@link BackgroundProcessHandle}, this does NOT reap the underlying
 * process when it goes out of scope — it is a detached view. The process is
 * reaped only by {@link stop}, {@link release}, or the host's idle /
 * max-lifetime / exit-retention TTLs. Obtain one from {@link spawnPersistent}
 * or {@link attach}.
 */
export class PersistentProcess {
  readonly #id: string;

  constructor(id: string) {
    this.#id = id;
  }

  /** The opaque process id — persist it (e.g. in KV) to {@link attach} later. */
  get id(): string {
    return this.#id;
  }

  /** Non-draining status snapshot. */
  status(): PersistentProcessInfo {
    return unpackInfo(callHost("process.status", () => hostStatus(this.#id)));
  }

  /**
   * Drain newly-buffered stdout/stderr since the last read. Drains the single
   * shared ring — for independent multi-reader or byte-faithful reads use
   * {@link readSince}.
   */
  readLogs(): ProcessLogs {
    const r = callHost("process.readLogs", () => hostReadLogsById(this.#id));
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      running: r.running,
      exitCode: r.exit?.exitCode,
      signal: r.exit?.signal,
    };
  }

  /**
   * Non-draining, cursor-addressed, byte-faithful read of one stream. Start
   * with {@link logCursorStart}; pass {@link LogChunkResult.next} back to resume.
   */
  readSince(stream: LogStream, cursor: LogCursor, maxBytes: number): LogChunkResult {
    const r = callHost("process.readSince", () =>
      hostReadSince(this.#id, stream, cursor, maxBytes),
    );
    return {
      data: r.data,
      next: r.next,
      bytesDropped: Number(r.bytesDropped),
      drainedEof: r.drainedEof,
    };
  }

  /** Write to stdin (requires `keepStdinOpen`). Returns bytes written. */
  writeStdin(data: Uint8Array): number {
    return callHost("process.writeStdin", () => hostWriteStdinById(this.#id, data));
  }

  /** Close stdin; the child observes EOF on read. */
  closeStdin(): void {
    callHost("process.closeStdin", () => hostCloseStdinById(this.#id));
  }

  /** Send a fire-and-forget signal. */
  signal(sig: ProcessSignal): void {
    callHost(`process.signal(${sig})`, () => hostSignalById(this.#id, sig));
  }

  /**
   * Wait up to `timeoutMs` for the process to exit. Bounded by design — an
   * unbounded wait would pin the pooled instance. Does NOT reap.
   */
  wait(timeoutMs: number): { exitCode: number | undefined; signal: number | undefined } {
    if (!Number.isFinite(timeoutMs)) {
      throw SysError.api(
        `timeoutMs must be a finite number (got ${timeoutMs}); wait is bounded by design`,
      );
    }
    const ms = BigInt(Math.max(0, Math.floor(timeoutMs)));
    const exit = callHost(`process.wait(${timeoutMs})`, () => hostWaitById(this.#id, ms));
    return unpackExit(exit);
  }

  /**
   * Graceful terminal stop: SIGTERM, wait up to `graceMs`, then SIGKILL, and
   * REMOVE the id (frees the slot). `graceMs` undefined uses the host default.
   * To keep a child's last output, drain it with {@link readSince} BEFORE stop.
   */
  stop(graceMs?: number): { exitCode: number | undefined; signal: number | undefined } {
    const ms = toSafeBigInt(graceMs);
    const exit = callHost(`process.stop(${graceMs ?? "default"})`, () =>
      hostStop(this.#id, ms),
    );
    return unpackExit(exit);
  }

  /**
   * Drop the host's retention of an ALREADY-EXITED process (frees the slot +
   * discards the buffered tail). Throws if still running — use {@link stop}.
   */
  release(): void {
    callHost("process.releaseProcess", () => hostReleaseProcess(this.#id));
  }
}

/**
 * Reattach to a persistent process by id — e.g. one saved in KV across tool
 * invocations. Wraps the id; the first id-keyed call validates ownership, so
 * an id that is unknown / not yours / reaped surfaces `no-such-process` on use.
 */
export function attach(id: string): PersistentProcess {
  return new PersistentProcess(id);
}

/**
 * List the calling capsule+principal's persistent processes, optionally
 * filtered by a label substring. Empty is normal (post-reap recovery signal).
 */
export function listProcesses(labelFilter?: string): PersistentProcessInfo[] {
  return callHost("process.listProcesses", () => hostListProcesses(labelFilter)).map(
    unpackInfo,
  );
}

/** Batch status for many ids in one host call. Unknown / unowned ids are absent. */
export function statusMany(ids: string[]): PersistentProcessInfo[] {
  return callHost("process.statusMany", () => hostStatusMany(ids)).map(unpackInfo);
}
