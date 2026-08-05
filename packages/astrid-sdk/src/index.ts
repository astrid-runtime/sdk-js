// Public API of @astrid-runtime/sdk.
//
// Module-by-module mirror of `astrid_sdk::prelude`, with idiom translated
// from Rust-std to Node/WHATWG conventions where appropriate.

export { SysError, type SysErrorKind } from "./errors.js";

export { capsule, install, upgrade, run } from "./capsule.js";
export {
  tool,
  interceptor,
  hook,
  command,
  type ToolOptions,
  type InterceptorOptions,
  type HookOptions,
  type CommandOptions,
} from "./tool.js";

// Namespaced submodules. Authors import as
// `import { fs, http, ipc, ... } from "@astrid-runtime/sdk"` and call
// `await fs.readFile(...)`, `ipc.publish(...)`, etc.
export * as log from "./log.js";
export * as kv from "./kv.js";
export * as ipc from "./ipc.js";
export * as fs from "./fs.js";
export * as http from "./http.js";
export * as net from "./net.js";
export * as process from "./process.js";
export * as env from "./env.js";
export * as time from "./time.js";
export * as runtime from "./runtime.js";
export * as capabilities from "./capabilities.js";
export * as elicit from "./elicit.js";
export * as identity from "./identity.js";
export * as approval from "./approval.js";
export * as uplink from "./uplink.js";
export * as interceptors from "./interceptors.js";
export * as hooks from "./hooks.js";

// Type re-exports for ergonomic imports.
export type {
  IpcMessage,
  PollResult,
  Subscription,
  InterceptorBinding,
  PrincipalAttribution,
} from "./ipc.js";
export type { Stats, Dirent, FileHandle, OpenMode, FileType } from "./fs.js";
export type {
  RequestBuilder,
  BufferedResponse,
  HttpMethod,
  RedirectPolicy,
  HttpRequestOptions,
  HttpStreamHandle,
  StreamStart,
  FetchOptions,
  FetchInput,
  FetchResponse,
  ResponseMetadata,
} from "./http.js";
export type {
  UnixListener,
  TcpListener,
  TcpStream,
  UdpSocket,
  ListenerHandle,
  StreamHandle,
  RecvError,
  SendError,
  TryRecvError,
  ShutdownHow,
  NetReadStatus,
  UdpDatagram,
} from "./net.js";
export type {
  ProcessResult,
  ProcessLogs,
  KillResult,
  ChildProcess,
  BackgroundProcessHandle,
  SpawnOptions,
  InjectedFile,
  ProcessSignal,
  EnvVar,
  PersistentProcess,
  PersistentProcessInfo,
  SpawnPersistentOptions,
  LogChunkResult,
  ResourceLimits,
  ProcessPhase,
  LogStream,
  LogCursor,
  OverflowPolicy,
} from "./process.js";
export type { CallerContext } from "./runtime.js";
export type { ResolvedUser, Link } from "./identity.js";
export type { UplinkId, UplinkProfile } from "./uplink.js";
export type { ApprovalDecision } from "./approval.js";
export type { KeyPage, Versioned } from "./kv.js";
export { HookEvent, type HookEventRequest, type HookResult } from "./hooks.js";
