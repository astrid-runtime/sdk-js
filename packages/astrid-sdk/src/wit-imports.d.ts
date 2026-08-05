// Ambient type declarations for the Astrid host imports that ComponentizeJS
// resolves at componentize time. After PR #752 (kernel) the host ABI is split
// into per-domain frozen packages at @1.0.0, and foundation I/O lives in the
// dedicated `astrid:io` package.
//
// The JS-side import shape is `"astrid:<domain>/host@1.0.0"` (or
// `"astrid:io/<iface>@1.0.0"` for foundation primitives), with kebab-case WIT
// names mapped to camelCase per the ComponentizeJS bindgen convention. WIT
// resources surface as JS classes with private constructors, instance methods,
// and a `[Symbol.dispose]` registered automatically by the host runtime.
//
// Per-domain `error-code` variants are imported as discriminated `{ tag, val }`
// objects matching the bindgen output. Throwing host calls reject with the
// same shape — `errors.ts` catches and rewraps into `SysError` so capsules see
// a unified error class with a typed `code`.
//
// One ambient module per WIT interface and frozen version. Most domains are
// `@1.0.0`; additive HTTP and process surfaces use `@1.1.0` while the older
// declarations remain available for source compatibility. Omitting a version
// causes a Wizer-time "module not found" error (see Phase 0 findings).

// ────────────────────────────────────────────────────────────────────
// astrid:io/error — downcastable error resource
// ────────────────────────────────────────────────────────────────────
declare module "astrid:io/error@1.0.0" {
  export class Error {
    private constructor();
    toDebugString(): string;
    [Symbol.dispose](): void;
  }
}

// ────────────────────────────────────────────────────────────────────
// astrid:io/poll — readiness multiplexing
// ────────────────────────────────────────────────────────────────────
declare module "astrid:io/poll@1.0.0" {
  export type ErrorCode =
    | { tag: "invalid-input" }
    | { tag: "closed" }
    | { tag: "too-large" }
    | { tag: "cancelled" }
    | { tag: "unknown"; val: string };

  export class Pollable {
    private constructor();
    ready(): boolean;
    block(): void;
    [Symbol.dispose](): void;
  }

  export function poll(pollables: Pollable[]): Uint32Array;
}

// ────────────────────────────────────────────────────────────────────
// astrid:io/streams — byte streams
// ────────────────────────────────────────────────────────────────────
declare module "astrid:io/streams@1.0.0" {
  import type { Error as IoError } from "astrid:io/error@1.0.0";
  import type { Pollable } from "astrid:io/poll@1.0.0";

  export type StreamError =
    | { tag: "last-operation-failed"; val: IoError }
    | { tag: "closed" };

  export class InputStream {
    private constructor();
    read(len: bigint): Uint8Array;
    blockingRead(len: bigint): Uint8Array;
    skip(len: bigint): bigint;
    blockingSkip(len: bigint): bigint;
    subscribe(): Pollable;
    [Symbol.dispose](): void;
  }

  export class OutputStream {
    private constructor();
    checkWrite(): bigint;
    write(contents: Uint8Array): void;
    blockingWriteAndFlush(contents: Uint8Array): void;
    flush(): void;
    blockingFlush(): void;
    subscribe(): Pollable;
    writeZeroes(len: bigint): void;
    blockingWriteZeroesAndFlush(len: bigint): void;
    splice(src: InputStream, len: bigint): bigint;
    blockingSplice(src: InputStream, len: bigint): bigint;
    [Symbol.dispose](): void;
  }
}

// ────────────────────────────────────────────────────────────────────
// astrid:ipc/host
// ────────────────────────────────────────────────────────────────────
declare module "astrid:ipc/host@1.0.0" {
  import type { Pollable } from "astrid:io/poll@1.0.0";

  export type ErrorCode =
    | { tag: "capability-denied" }
    | { tag: "invalid-input" }
    | { tag: "closed" }
    | { tag: "rate-limited" }
    | { tag: "backpressure" }
    | { tag: "quota" }
    | { tag: "timeout" }
    | { tag: "unknown"; val: string };

  export type PrincipalAttribution =
    | { tag: "verified"; val: string }
    | { tag: "claimed"; val: string }
    | { tag: "system" };

  export interface IpcMessage {
    topic: string;
    payload: string;
    sourceId: string;
    principal: PrincipalAttribution;
  }

  export interface IpcEnvelope {
    messages: IpcMessage[];
    dropped: bigint;
    lagged: bigint;
  }

  export interface InterceptorBinding {
    handleId: bigint;
    action: string;
    topic: string;
  }

  export class Subscription {
    private constructor();
    poll(): IpcEnvelope;
    recv(timeoutMs: bigint): IpcEnvelope;
    subscribeReadiness(): Pollable;
    [Symbol.dispose](): void;
  }

  export function publish(topic: string, payload: string): void;
  export function publishAs(topic: string, payload: string, principal: string): void;
  export function subscribe(topicPattern: string): Subscription;
  export function getInterceptorBindings(): InterceptorBinding[];
}

// ────────────────────────────────────────────────────────────────────
// astrid:kv/host
// ────────────────────────────────────────────────────────────────────
declare module "astrid:kv/host@1.0.0" {
  export type ErrorCode =
    | { tag: "invalid-key" }
    | { tag: "too-large" }
    | { tag: "quota" }
    | { tag: "cas-mismatch" }
    | { tag: "unknown"; val: string };

  export interface KeyPage {
    keys: string[];
    nextCursor: string | undefined;
  }

  export function kvGet(key: string): Uint8Array | undefined;
  export function kvSet(key: string, value: Uint8Array): void;
  export function kvDelete(key: string): void;
  export function kvListKeys(prefix: string): string[];
  export function kvListKeysPage(
    prefix: string,
    cursor: string | undefined,
    limit: number,
  ): KeyPage;
  export function kvClearPrefix(prefix: string): bigint;
  export function kvCas(
    key: string,
    expected: Uint8Array | undefined,
    newValue: Uint8Array,
  ): boolean;
}

// ────────────────────────────────────────────────────────────────────
// astrid:fs/host
// ────────────────────────────────────────────────────────────────────
declare module "astrid:fs/host@1.0.0" {
  export type ErrorCode =
    | { tag: "not-found" }
    | { tag: "access" }
    | { tag: "capability-denied" }
    | { tag: "boundary-escape" }
    | { tag: "invalid-path" }
    | { tag: "would-block" }
    | { tag: "is-directory" }
    | { tag: "not-directory" }
    | { tag: "not-empty" }
    | { tag: "too-large" }
    | { tag: "quota" }
    | { tag: "cross-vfs" }
    | { tag: "already-exists" }
    | { tag: "closed" }
    | { tag: "unknown"; val: string };

  export type FileType =
    | "type-unknown"
    | "regular"
    | "directory"
    | "symlink"
    | "block-device"
    | "character-device"
    | "fifo"
    | "socket";

  export type OpenMode = "read" | "write" | "append" | "read-write";

  export interface Datetime {
    seconds: bigint;
    nanoseconds: number;
  }

  export interface FileStat {
    size: bigint;
    kind: FileType;
    mode: number;
    modified: Datetime | undefined;
    created: Datetime | undefined;
    accessed: Datetime | undefined;
  }

  export class FileHandle {
    private constructor();
    readAt(offset: bigint, maxBytes: number): Uint8Array;
    writeAt(offset: bigint, data: Uint8Array): number;
    syncData(): void;
    syncAll(): void;
    stat(): FileStat;
    setLen(size: bigint): void;
    [Symbol.dispose](): void;
  }

  export function fsOpen(path: string, mode: OpenMode): FileHandle;
  export function fsExists(path: string): boolean;
  export function fsMkdir(path: string): void;
  export function fsMkdirAll(path: string): void;
  export function fsReaddir(path: string): string[];
  export function fsStat(path: string): FileStat;
  export function fsStatSymlink(path: string): FileStat;
  export function fsUnlink(path: string): void;
  export function readFile(path: string): Uint8Array;
  export function writeFile(path: string, content: Uint8Array): void;
  export function fsAppend(path: string, content: Uint8Array): void;
  export function fsCopy(src: string, dst: string): void;
  export function fsRename(src: string, dst: string): void;
  export function fsRemoveDirAll(path: string): bigint;
  export function fsCanonicalize(path: string): string;
  export function fsReadLink(path: string): string;
  export function fsHardLink(src: string, linkPath: string): void;
}

// ────────────────────────────────────────────────────────────────────
// astrid:net/host
// ────────────────────────────────────────────────────────────────────
declare module "astrid:net/host@1.0.0" {
  import type { Pollable } from "astrid:io/poll@1.0.0";
  import type { InputStream, OutputStream } from "astrid:io/streams@1.0.0";

  export type ErrorCode =
    | { tag: "would-block" }
    | { tag: "closed" }
    | { tag: "capability-denied" }
    | { tag: "airlock-rejected" }
    | { tag: "connection-refused" }
    | { tag: "connection-reset" }
    | { tag: "timeout" }
    | { tag: "address-in-use" }
    | { tag: "address-not-available" }
    | { tag: "name-unresolvable" }
    | { tag: "invalid-handle" }
    | { tag: "not-tcp" }
    | { tag: "quota" }
    | { tag: "unknown"; val: string };

  export type NetReadStatus =
    | { tag: "data"; val: Uint8Array }
    | { tag: "closed" }
    | { tag: "pending" };

  export type ShutdownHow = "receive" | "send" | "both";

  export interface UdpDatagram {
    data: Uint8Array;
    peerHost: string;
    peerPort: number;
  }

  export class UnixListener {
    private constructor();
    accept(): TcpStream;
    pollAccept(timeoutMs: bigint): TcpStream | undefined;
    subscribeReadiness(): Pollable;
    [Symbol.dispose](): void;
  }

  export class TcpListener {
    private constructor();
    accept(): TcpStream;
    pollAccept(timeoutMs: bigint): TcpStream | undefined;
    localAddr(): string;
    subscribeReadiness(): Pollable;
    [Symbol.dispose](): void;
  }

  export class TcpStream {
    private constructor();
    read(): NetReadStatus;
    write(data: Uint8Array): void;
    readBytes(maxBytes: number): Uint8Array;
    writeBytes(data: Uint8Array): number;
    peek(maxBytes: number): Uint8Array;
    shutdown(how: ShutdownHow): void;
    peerAddr(): string;
    localAddr(): string;
    setNodelay(nodelay: boolean): void;
    nodelay(): boolean;
    setReadTimeout(timeoutMs: bigint | undefined): void;
    readTimeout(): bigint | undefined;
    setWriteTimeout(timeoutMs: bigint | undefined): void;
    writeTimeout(): bigint | undefined;
    setHopLimit(hops: number): void;
    hopLimit(): number;
    setKeepalive(keepaliveSecs: bigint | undefined): void;
    keepalive(): bigint | undefined;
    setLinger(lingerMs: bigint | undefined): void;
    linger(): bigint | undefined;
    setReuseaddr(reuse: boolean): void;
    reuseaddr(): boolean;
    subscribeReadable(): Pollable;
    readStream(): InputStream;
    writeStream(): OutputStream;
    [Symbol.dispose](): void;
  }

  export class UdpSocket {
    private constructor();
    sendTo(data: Uint8Array, peerHost: string, peerPort: number): number;
    recvFrom(maxBytes: number): UdpDatagram | undefined;
    connect(peerHost: string, peerPort: number): void;
    disconnect(): void;
    send(data: Uint8Array): number;
    recv(maxBytes: number): Uint8Array | undefined;
    peerAddr(): string | undefined;
    setReadTimeout(timeoutMs: bigint | undefined): void;
    localAddr(): string;
    subscribeReadable(): Pollable;
    [Symbol.dispose](): void;
  }

  export function bindUnix(): UnixListener;
  export function bindTcp(host: string, port: number): TcpListener;
  export function connectTcp(host: string, port: number): TcpStream;
  export function udpBind(host: string, port: number): UdpSocket;
  export function lookupHost(host: string): string[];
}

// ────────────────────────────────────────────────────────────────────
// astrid:http/host
// ────────────────────────────────────────────────────────────────────
declare module "astrid:http/host@1.0.0" {
  import type { Pollable } from "astrid:io/poll@1.0.0";
  import type { InputStream } from "astrid:io/streams@1.0.0";

  export type ErrorCode =
    | { tag: "capability-denied" }
    | { tag: "invalid-request" }
    | { tag: "dns-error" }
    | { tag: "airlock-rejected" }
    | { tag: "tls-error" }
    | { tag: "timeout" }
    | { tag: "connection-error" }
    | { tag: "body-too-large" }
    | { tag: "closed" }
    | { tag: "quota" }
    | { tag: "protocol"; val: string }
    | { tag: "unknown"; val: string };

  export type HttpMethod =
    | { tag: "get" }
    | { tag: "head" }
    | { tag: "post" }
    | { tag: "put" }
    | { tag: "delete" }
    | { tag: "connect" }
    | { tag: "options" }
    | { tag: "trace" }
    | { tag: "patch" }
    | { tag: "other"; val: string };

  export interface KeyValuePair {
    key: string;
    value: string;
  }

  export interface HttpRequestData {
    url: string;
    method: HttpMethod;
    headers: KeyValuePair[];
    body: Uint8Array | undefined;
  }

  export interface HttpResponseData {
    status: number;
    headers: KeyValuePair[];
    body: Uint8Array;
  }

  export class HttpStream {
    private constructor();
    status(): number;
    headers(): KeyValuePair[];
    readChunk(): Uint8Array;
    close(): void;
    subscribeReadable(): Pollable;
    bodyStream(): InputStream;
    [Symbol.dispose](): void;
  }

  export function httpRequest(request: HttpRequestData): HttpResponseData;
  export function httpStreamStart(request: HttpRequestData): HttpStream;
}

declare module "astrid:http/host@1.1.0" {
  import type { Pollable } from "astrid:io/poll@1.0.0";
  import type { InputStream, OutputStream } from "astrid:io/streams@1.0.0";

  export type ErrorCode =
    | { tag: "capability-denied" }
    | { tag: "invalid-request" }
    | { tag: "dns-error" }
    | { tag: "airlock-rejected" }
    | { tag: "tls-error" }
    | { tag: "timeout" }
    | { tag: "connection-error" }
    | { tag: "body-too-large" }
    | { tag: "closed" }
    | { tag: "quota" }
    | { tag: "redirect-blocked" }
    | { tag: "too-many-redirects" }
    | { tag: "integrity-mismatch" }
    | { tag: "scheme-denied" }
    | { tag: "decompression-bomb" }
    | { tag: "protocol"; val: string }
    | { tag: "unknown"; val: string };

  export type HttpMethod = import("astrid:http/host@1.0.0").HttpMethod;
  export type RedirectPolicy = "follow" | "error" | "manual";

  export interface KeyValuePair {
    key: string;
    value: string;
  }

  export interface HttpRequestData {
    url: string;
    method: HttpMethod;
    headers: KeyValuePair[];
    body: Uint8Array | undefined;
  }

  export interface TimeoutConfig {
    connectMs: bigint | undefined;
    firstByteMs: bigint | undefined;
    betweenBytesMs: bigint | undefined;
    totalMs: bigint | undefined;
  }

  export interface RequestOptions {
    timeouts: TimeoutConfig | undefined;
    redirect: RedirectPolicy | undefined;
    maxRedirects: number | undefined;
    maxResponseBytes: bigint | undefined;
    maxDecompressedBytes: bigint | undefined;
    autoDecompress: boolean | undefined;
    httpsOnly: boolean | undefined;
    integrity: string | undefined;
  }

  export interface ResponseMeta {
    finalUrl: string;
    redirectCount: number;
    elapsedMs: bigint;
    wireBytes: bigint;
  }

  export interface HttpResponseData {
    status: number;
    headers: KeyValuePair[];
    body: Uint8Array;
    meta: ResponseMeta;
  }

  export class HttpStream {
    private constructor();
    status(): number;
    headers(): KeyValuePair[];
    readChunk(): Uint8Array;
    close(): void;
    subscribeReadable(): Pollable;
    bodyStream(): InputStream;
    trailers(): KeyValuePair[] | undefined;
    [Symbol.dispose](): void;
  }

  export class HttpUpload {
    private constructor();
    bodySink(): OutputStream;
    subscribeWritable(): Pollable;
    finish(): HttpStream;
    [Symbol.dispose](): void;
  }

  export function httpRequest(request: HttpRequestData): HttpResponseData;
  export function httpRequestOpts(
    request: HttpRequestData,
    options: RequestOptions,
  ): HttpResponseData;
  export function httpStreamStart(request: HttpRequestData): HttpStream;
  export function httpStreamStartOpts(
    request: HttpRequestData,
    options: RequestOptions,
  ): HttpStream;
  export function httpUploadStart(
    request: HttpRequestData,
    options: RequestOptions,
  ): HttpUpload;
}

// ────────────────────────────────────────────────────────────────────
// astrid:sys/host
// ────────────────────────────────────────────────────────────────────
declare module "astrid:sys/host@1.0.0" {
  export type ErrorCode =
    | { tag: "capability-denied" }
    | { tag: "config-key-reserved" }
    | { tag: "too-large" }
    | { tag: "registry-unavailable" }
    | { tag: "cancelled" }
    | { tag: "unknown"; val: string };

  export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

  export interface CallerContext {
    principal: string | undefined;
    sourceId: string;
    timestamp: string;
  }

  export interface CapabilityCheckRequest {
    sourceUuid: string;
    capability: string;
  }

  export interface CapabilityCheckResponse {
    allowed: boolean;
  }

  export function getConfig(key: string): string | undefined;
  export function getCaller(): CallerContext;
  export function log(level: LogLevel, message: string): void;
  export function signalReady(): void;
  export function clockMs(): bigint;
  export function clockMonotonicNs(): bigint;
  export function sleepNs(durationNs: bigint): void;
  export function randomBytes(length: bigint): Uint8Array;
  export function checkCapsuleCapability(
    request: CapabilityCheckRequest,
  ): CapabilityCheckResponse;
  export function enumerateCapabilities(): string[];
}

// ────────────────────────────────────────────────────────────────────
// astrid:process/host
// ────────────────────────────────────────────────────────────────────
declare module "astrid:process/host@1.0.0" {
  import type { Pollable } from "astrid:io/poll@1.0.0";

  export type ErrorCode =
    | { tag: "capability-denied" }
    | { tag: "invalid-input" }
    | { tag: "boundary-escape" }
    | { tag: "quota" }
    | { tag: "too-large" }
    | { tag: "closed" }
    | { tag: "cancelled" }
    | { tag: "wait-timeout" }
    | { tag: "no-such-process" }
    | { tag: "registry-full" }
    | { tag: "persist-unsupported" }
    | { tag: "unknown"; val: string };

  export type ProcessSignal =
    | "term"
    | "hup"
    | "usr1"
    | "usr2"
    | "int"
    | "stop"
    | "cont";

  export type OverflowPolicy = "drop-oldest" | "backpressure";

  export type ProcessPhase = "starting" | "running" | "exited";

  export type LogStream = "stdout" | "stderr";

  export interface EnvVar {
    key: string;
    value: string;
  }

  export interface ResourceLimits {
    maxMemoryBytes: bigint | undefined;
    maxCpuSecs: bigint | undefined;
    maxPids: number | undefined;
    maxOpenFiles: number | undefined;
  }

  export interface SpawnRequest {
    cmd: string;
    args: string[];
    stdin: Uint8Array | undefined;
    env: EnvVar[];
    cwd: string | undefined;
    limits: ResourceLimits | undefined;
    label: string | undefined;
    keepStdinOpen: boolean | undefined;
    overflow: OverflowPolicy | undefined;
    logRingBytes: number | undefined;
    maxLifetimeMs: bigint | undefined;
    idleTimeoutMs: bigint | undefined;
    exitRetentionMs: bigint | undefined;
  }

  export interface ExitInfo {
    exitCode: number | undefined;
    signal: number | undefined;
  }

  export interface ProcessResult {
    stdout: string;
    stderr: string;
    exit: ExitInfo;
  }

  export interface ReadLogsResult {
    stdout: string;
    stderr: string;
    running: boolean;
    exit: ExitInfo | undefined;
  }

  export interface KillResult {
    killed: boolean;
    exit: ExitInfo | undefined;
    stdout: string;
    stderr: string;
  }

  export interface LogCursor {
    token: string | undefined;
  }

  export interface LogChunk {
    data: Uint8Array;
    next: LogCursor;
    bytesDropped: bigint;
    drainedEof: boolean;
  }

  export interface ProcessInfo {
    id: string;
    label: string;
    command: string;
    osPid: number | undefined;
    phase: ProcessPhase;
    exit: ExitInfo | undefined;
    ageMs: bigint;
    idleMs: bigint;
    bufferedBytes: bigint;
    bytesDropped: bigint;
    stdinOpen: boolean;
    cpuMs: bigint | undefined;
    memBytesPeak: bigint | undefined;
  }

  export class ProcessHandle {
    private constructor();
    readLogs(): ReadLogsResult;
    writeStdin(data: Uint8Array): number;
    closeStdin(): void;
    signal(sig: ProcessSignal): void;
    kill(): KillResult;
    wait(timeoutMs: bigint | undefined): ExitInfo;
    waitWithOutput(timeoutMs: bigint | undefined): ProcessResult;
    osPid(): number;
    subscribeExit(): Pollable;
    subscribeLogs(): Pollable;
    [Symbol.dispose](): void;
  }

  export function spawn(request: SpawnRequest): ProcessResult;
  export function spawnBackground(request: SpawnRequest): ProcessHandle;

  // Persistent tier — free functions. Every id-keyed call re-checks the
  // caller's (principal, capsule) against the recorded creator host-side;
  // unknown / wrong-owner / reaped all surface as `no-such-process`.
  export function spawnPersistent(request: SpawnRequest): string;
  export function attach(id: string): ProcessHandle;
  export function listProcesses(labelFilter: string | undefined): ProcessInfo[];
  export function status(id: string): ProcessInfo;
  export function statusMany(ids: string[]): ProcessInfo[];
  export function readLogs(id: string): ReadLogsResult;
  export function readSince(
    id: string,
    whichStream: LogStream,
    cursor: LogCursor,
    maxBytes: number,
  ): LogChunk;
  export function writeStdin(id: string, data: Uint8Array): number;
  export function closeStdin(id: string): void;
  export function signal(id: string, sig: ProcessSignal): void;
  export function wait(id: string, timeoutMs: bigint): ExitInfo;
  export function stop(id: string, graceMs: bigint | undefined): ExitInfo;
  export function releaseProcess(id: string): void;
  export function watch(id: string, suffix: string | undefined): void;
  export function unwatch(id: string): void;
}

declare module "astrid:process/host@1.1.0" {
  import type { Pollable } from "astrid:io/poll@1.0.0";

  export type ErrorCode = import("astrid:process/host@1.0.0").ErrorCode;
  export type ProcessSignal = import("astrid:process/host@1.0.0").ProcessSignal;
  export type OverflowPolicy = import("astrid:process/host@1.0.0").OverflowPolicy;
  export type ProcessPhase = import("astrid:process/host@1.0.0").ProcessPhase;
  export type LogStream = import("astrid:process/host@1.0.0").LogStream;
  export type EnvVar = import("astrid:process/host@1.0.0").EnvVar;
  export type ResourceLimits = import("astrid:process/host@1.0.0").ResourceLimits;
  export type ExitInfo = import("astrid:process/host@1.0.0").ExitInfo;
  export type ProcessResult = import("astrid:process/host@1.0.0").ProcessResult;
  export type ReadLogsResult = import("astrid:process/host@1.0.0").ReadLogsResult;
  export type KillResult = import("astrid:process/host@1.0.0").KillResult;
  export type LogCursor = import("astrid:process/host@1.0.0").LogCursor;
  export type LogChunk = import("astrid:process/host@1.0.0").LogChunk;
  export type ProcessInfo = import("astrid:process/host@1.0.0").ProcessInfo;

  export type InjectionPlacement =
    | { tag: "env-pointer"; val: string }
    | { tag: "fixed-path"; val: string };

  export interface FileInjection {
    content: Uint8Array;
    placement: InjectionPlacement;
  }

  export interface SpawnRequest {
    cmd: string;
    args: string[];
    stdin: Uint8Array | undefined;
    env: EnvVar[];
    cwd: string | undefined;
    limits: ResourceLimits | undefined;
    fileInjections: FileInjection[];
    label: string | undefined;
    keepStdinOpen: boolean | undefined;
    overflow: OverflowPolicy | undefined;
    logRingBytes: number | undefined;
    maxLifetimeMs: bigint | undefined;
    idleTimeoutMs: bigint | undefined;
    exitRetentionMs: bigint | undefined;
  }

  export class ProcessHandle {
    private constructor();
    readLogs(): ReadLogsResult;
    writeStdin(data: Uint8Array): number;
    closeStdin(): void;
    signal(sig: ProcessSignal): void;
    kill(): KillResult;
    wait(timeoutMs: bigint | undefined): ExitInfo;
    waitWithOutput(timeoutMs: bigint | undefined): ProcessResult;
    osPid(): number;
    subscribeExit(): Pollable;
    subscribeLogs(): Pollable;
    [Symbol.dispose](): void;
  }

  export function spawn(request: SpawnRequest): ProcessResult;
  export function spawnBackground(request: SpawnRequest): ProcessHandle;
  export function spawnPersistent(request: SpawnRequest): string;
  export function attach(id: string): ProcessHandle;
  export function listProcesses(labelFilter: string | undefined): ProcessInfo[];
  export function status(id: string): ProcessInfo;
  export function statusMany(ids: string[]): ProcessInfo[];
  export function readLogs(id: string): ReadLogsResult;
  export function readSince(
    id: string,
    whichStream: LogStream,
    cursor: LogCursor,
    maxBytes: number,
  ): LogChunk;
  export function writeStdin(id: string, data: Uint8Array): number;
  export function closeStdin(id: string): void;
  export function signal(id: string, sig: ProcessSignal): void;
  export function wait(id: string, timeoutMs: bigint): ExitInfo;
  export function stop(id: string, graceMs: bigint | undefined): ExitInfo;
  export function releaseProcess(id: string): void;
  export function watch(id: string, suffix: string | undefined): void;
  export function unwatch(id: string): void;
}

// ────────────────────────────────────────────────────────────────────
// astrid:uplink/host
// ────────────────────────────────────────────────────────────────────
declare module "astrid:uplink/host@1.0.0" {
  export type ErrorCode =
    | { tag: "capability-denied" }
    | { tag: "invalid-input" }
    | { tag: "invalid-profile" }
    | { tag: "unknown-uplink" }
    | { tag: "no-session" }
    | { tag: "quota" }
    | { tag: "unknown"; val: string };

  export type UplinkProfile = "chat" | "interactive" | "notify" | "bridge";

  export function uplinkRegister(
    name: string,
    platform: string,
    profile: UplinkProfile,
  ): string;
  export function uplinkSend(
    uplinkId: string,
    platformUserId: string,
    content: string,
  ): boolean;
}

// ────────────────────────────────────────────────────────────────────
// astrid:elicit/host
// ────────────────────────────────────────────────────────────────────
declare module "astrid:elicit/host@1.0.0" {
  export type ErrorCode =
    | { tag: "not-in-lifecycle" }
    | { tag: "timeout" }
    | { tag: "cancelled" }
    | { tag: "invalid-input" }
    | { tag: "store-unavailable" }
    | { tag: "unknown"; val: string };

  export type ElicitType = "text" | "secret" | "select" | "array";

  export interface ElicitRequest {
    kind: ElicitType;
    key: string;
    description: string;
    options: string[] | undefined;
    defaultValue: string | undefined;
  }

  export type ElicitResponse =
    | { tag: "value"; val: string }
    | { tag: "values"; val: string[] }
    | { tag: "secret-stored" };

  export function elicit(request: ElicitRequest): ElicitResponse;
  export function hasSecret(key: string): boolean;
}

// ────────────────────────────────────────────────────────────────────
// astrid:approval/host
// ────────────────────────────────────────────────────────────────────
declare module "astrid:approval/host@1.0.0" {
  export type ErrorCode =
    | { tag: "invalid-input" }
    | { tag: "timeout" }
    | { tag: "store-unavailable" }
    | { tag: "unknown"; val: string };

  export type ApprovalDecision =
    | "denied"
    | "approved"
    | "approved-session"
    | "approved-always"
    | "allowance";

  export interface ApprovalRequest {
    action: string;
    targetResource: string;
  }

  export interface ApprovalResponse {
    decision: ApprovalDecision;
  }

  export function requestApproval(request: ApprovalRequest): ApprovalResponse;
}

// ────────────────────────────────────────────────────────────────────
// astrid:identity/host
// ────────────────────────────────────────────────────────────────────
declare module "astrid:identity/host@1.0.0" {
  export type ErrorCode =
    | { tag: "capability-denied" }
    | { tag: "invalid-input" }
    | { tag: "user-not-found" }
    | { tag: "link-not-found" }
    | { tag: "already-linked" }
    | { tag: "store-unavailable" }
    | { tag: "unknown"; val: string };

  export interface IdentityResolveRequest {
    platform: string;
    platformUserId: string;
  }

  export interface IdentityResolveResponse {
    userId: string;
    displayName: string | undefined;
  }

  export interface IdentityLinkRequest {
    platform: string;
    platformUserId: string;
    astridUserId: string;
    method: string;
  }

  export interface IdentityUnlinkRequest {
    platform: string;
    platformUserId: string;
  }

  export interface IdentityCreateUserRequest {
    displayName: string | undefined;
  }

  export interface IdentityCreateUserResponse {
    userId: string;
  }

  export interface PlatformLink {
    platform: string;
    platformUserId: string;
    linkedAt: string;
    method: string;
  }

  export function identityResolve(
    request: IdentityResolveRequest,
  ): IdentityResolveResponse;
  export function identityLink(request: IdentityLinkRequest): void;
  export function identityUnlink(request: IdentityUnlinkRequest): void;
  export function identityCreateUser(
    request: IdentityCreateUserRequest,
  ): IdentityCreateUserResponse;
  export function identityListLinks(astridUserId: string): PlatformLink[];
}
