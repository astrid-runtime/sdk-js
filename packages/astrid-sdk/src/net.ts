/**
 * Networking — Unix domain sockets, outbound TCP, inbound TCP listeners,
 * UDP, and DNS. Mirrors `astrid_sdk::net`. The kernel pre-binds a single
 * Unix-domain listener per capsule; outbound TCP and UDP are gated by
 * `net_connect` / `net_udp` allowlists and run through the SSRF airlock.
 *
 * Resource handles ({@link UnixListener}, {@link TcpListener}, {@link TcpStream},
 * {@link UdpSocket}) are Component Model resources with automatic Drop. Use
 * `using` for scope-bound cleanup or call `.close()` explicitly.
 *
 * Per-capsule caps: 8 concurrent TCP streams, 4 UDP sockets, 4 TCP listeners.
 */

import {
  bindUnix as hostBindUnix,
  bindTcp as hostBindTcp,
  connectTcp as hostConnectTcp,
  udpBind as hostUdpBind,
  lookupHost as hostLookupHost,
  type UnixListener as WitUnixListener,
  type TcpListener as WitTcpListener,
  type TcpStream as WitTcpStream,
  type UdpSocket as WitUdpSocket,
} from "astrid:net/host@1.0.0";
import { SysError, callHost } from "./errors.js";
import { sleepMs as hostSleepMs } from "./time.js";

const NET_INTERNAL = Symbol("Astrid network resource");
let createUnixListener: (inner: WitUnixListener) => UnixListener;
let createTcpListener: (inner: WitTcpListener) => TcpListener;
let createTcpStream: (inner: WitTcpStream) => TcpStream;
let createUdpSocket: (inner: WitUdpSocket) => UdpSocket;

export type ShutdownHow = "receive" | "send" | "both";
export type NetReadStatus =
  | { tag: "data"; val: Uint8Array }
  | { tag: "closed" }
  | { tag: "pending" };
export interface UdpDatagram {
  data: Uint8Array;
  peerHost: string;
  peerPort: number;
}

// ---------------------------------------------------------------------------
// mpsc-shaped errors (preserved from pre-migration API)
// ---------------------------------------------------------------------------

export class RecvError extends Error {
  override readonly name = "RecvError";
  readonly code = "EPIPE" as const;
  constructor() {
    super("stream closed");
  }
}

export type TryRecvError =
  | { kind: "empty"; message: string; code: "EAGAIN" }
  | { kind: "closed"; message: string; code: "EPIPE" };

export class SendError extends Error {
  override readonly name = "SendError";
  readonly code = "EPIPE" as const;
  constructor() {
    super("stream closed");
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toHostTimeout(timeoutMs: number | undefined): bigint | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw SysError.api(
      `timeout must be a positive integer (got ${timeoutMs}); use undefined to clear`,
    );
  }
  return BigInt(Math.floor(timeoutMs));
}

// ---------------------------------------------------------------------------
// Listener handles
// ---------------------------------------------------------------------------

/** The capsule's pre-bound Unix domain listener. Activated by {@link bindUnix}. */
export class UnixListener {
  #inner: WitUnixListener | undefined;

  private constructor(token: typeof NET_INTERNAL, value: unknown) {
    if (token !== NET_INTERNAL) throw new TypeError("UnixListener cannot be constructed directly");
    this.#inner = value as WitUnixListener;
  }

  static { createUnixListener = (inner) => new UnixListener(NET_INTERNAL, inner); }

  /** Blocking accept. Performs peer-credential verification + session token handshake. */
  accept(): TcpStream {
    const inner = callHost("net.UnixListener.accept", () =>
      this.#requireInner().accept(),
    );
    return createTcpStream(inner);
  }

  /** Polling accept with caller-controlled timeout. Returns `undefined` if none arrived. */
  pollAccept(timeoutMs: number): TcpStream | undefined {
    const ms = toHostTimeout(timeoutMs) ?? 0n;
    const inner = callHost(`net.UnixListener.pollAccept(${timeoutMs}ms)`, () =>
      this.#requireInner().pollAccept(ms),
    );
    return inner === undefined ? undefined : createTcpStream(inner);
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

  #requireInner(): WitUnixListener {
    if (this.#inner === undefined) throw SysError.api("UnixListener is closed");
    return this.#inner;
  }
}

/** A bound TCP listener accepting inbound network connections. Per-capsule cap: 4. */
export class TcpListener {
  #inner: WitTcpListener | undefined;

  private constructor(token: typeof NET_INTERNAL, value: unknown) {
    if (token !== NET_INTERNAL) throw new TypeError("TcpListener cannot be constructed directly");
    this.#inner = value as WitTcpListener;
  }

  static { createTcpListener = (inner) => new TcpListener(NET_INTERNAL, inner); }

  /** Blocking accept. */
  accept(): TcpStream {
    const inner = callHost("net.TcpListener.accept", () => this.#requireInner().accept());
    return createTcpStream(inner);
  }

  /** Polling accept with caller-controlled timeout. */
  pollAccept(timeoutMs: number): TcpStream | undefined {
    const ms = toHostTimeout(timeoutMs) ?? 0n;
    const inner = callHost(`net.TcpListener.pollAccept(${timeoutMs}ms)`, () =>
      this.#requireInner().pollAccept(ms),
    );
    return inner === undefined ? undefined : createTcpStream(inner);
  }

  localAddr(): string {
    return callHost("net.TcpListener.localAddr", () => this.#requireInner().localAddr());
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

  #requireInner(): WitTcpListener {
    if (this.#inner === undefined) throw SysError.api("TcpListener is closed");
    return this.#inner;
  }
}

// ---------------------------------------------------------------------------
// TCP stream — bidirectional resource used for both Unix-domain and TCP
// ---------------------------------------------------------------------------

export class TcpStream {
  #inner: WitTcpStream | undefined;

  private constructor(token: typeof NET_INTERNAL, value: unknown) {
    if (token !== NET_INTERNAL) throw new TypeError("TcpStream cannot be constructed directly");
    this.#inner = value as WitTcpStream;
  }

  static { createTcpStream = (inner) => new TcpStream(NET_INTERNAL, inner); }

  // ---- Length-prefixed framed I/O (uplink-proxy use case) -----------------

  /** Non-blocking framed read. Returns Data/Closed/Pending. Max frame: 10 MB. */
  tryRecv(): Uint8Array | { kind: "empty" } {
    const status: NetReadStatus = callHost("net.TcpStream.tryRecv", () =>
      this.#requireInner().read(),
    );
    switch (status.tag) {
      case "data":
        return status.val;
      case "pending":
        return { kind: "empty" };
      case "closed":
        this.close();
        throw new RecvError();
    }
  }

  /**
   * Blocking framed receive. Spins on `tryRecv` with a 50 ms sleep between
   * polls; StarlingMonkey's syncify makes this a real blocking call from the
   * host's POV. Mirrors the Rust SDK polling-loop shape.
   */
  recv(): Uint8Array {
    while (true) {
      const result = this.tryRecv();
      if (result instanceof Uint8Array) return result;
      sleepMs(50);
    }
  }

  /** Write a length-prefixed frame. */
  send(data: Uint8Array): void {
    try {
      callHost("net.TcpStream.send", () => this.#requireInner().write(data));
    } catch (err) {
      // Map host errors on send to SendError to mirror Rust SDK.
      if (err instanceof SysError) throw new SendError();
      throw err;
    }
  }

  // ---- Byte-stream I/O ----------------------------------------------------

  /**
   * Read up to `maxBytes` without length-prefix framing. Empty array = EOF.
   * Honours any timeout set via {@link setReadTimeout}.
   */
  readBytes(maxBytes: number): Uint8Array {
    return callHost(`net.TcpStream.readBytes(${maxBytes})`, () =>
      this.#requireInner().readBytes(maxBytes),
    );
  }

  /** Write `data` without framing. Returns bytes written (may be less than `data.length`). */
  writeBytes(data: Uint8Array): number {
    return callHost("net.TcpStream.writeBytes", () =>
      this.#requireInner().writeBytes(data),
    );
  }

  /** Peek up to `maxBytes` without consuming them. */
  peek(maxBytes: number): Uint8Array {
    return callHost(`net.TcpStream.peek(${maxBytes})`, () =>
      this.#requireInner().peek(maxBytes),
    );
  }

  /** Half-close the read side, write side, or both. */
  shutdown(how: ShutdownHow): void {
    callHost(`net.TcpStream.shutdown(${how})`, () => this.#requireInner().shutdown(how));
  }

  // ---- Address accessors --------------------------------------------------

  /** Remote peer address as `"ip:port"`. Returns `not-tcp` for Unix-domain streams. */
  peerAddr(): string {
    return callHost("net.TcpStream.peerAddr", () => this.#requireInner().peerAddr());
  }

  /** Local socket address as `"ip:port"`. */
  localAddr(): string {
    return callHost("net.TcpStream.localAddr", () => this.#requireInner().localAddr());
  }

  // ---- TCP socket options -------------------------------------------------

  setNodelay(nodelay: boolean): void {
    callHost(`net.TcpStream.setNodelay(${nodelay})`, () =>
      this.#requireInner().setNodelay(nodelay),
    );
  }

  nodelay(): boolean {
    return callHost("net.TcpStream.nodelay", () => this.#requireInner().nodelay());
  }

  setReadTimeout(timeoutMs: number | undefined): void {
    const ms = toHostTimeout(timeoutMs);
    callHost(`net.TcpStream.setReadTimeout(${timeoutMs})`, () =>
      this.#requireInner().setReadTimeout(ms),
    );
  }

  readTimeout(): number | undefined {
    const v = callHost("net.TcpStream.readTimeout", () => this.#requireInner().readTimeout());
    return v === undefined ? undefined : Number(v);
  }

  setWriteTimeout(timeoutMs: number | undefined): void {
    const ms = toHostTimeout(timeoutMs);
    callHost(`net.TcpStream.setWriteTimeout(${timeoutMs})`, () =>
      this.#requireInner().setWriteTimeout(ms),
    );
  }

  writeTimeout(): number | undefined {
    const v = callHost("net.TcpStream.writeTimeout", () => this.#requireInner().writeTimeout());
    return v === undefined ? undefined : Number(v);
  }

  /** IPv6 hop limit / IPv4 TTL. */
  setHopLimit(hops: number): void {
    callHost(`net.TcpStream.setHopLimit(${hops})`, () =>
      this.#requireInner().setHopLimit(hops),
    );
  }

  hopLimit(): number {
    return callHost("net.TcpStream.hopLimit", () => this.#requireInner().hopLimit());
  }

  /** TCP keepalive probe interval in seconds (`undefined` disables). */
  setKeepalive(keepaliveSecs: number | undefined): void {
    const v = keepaliveSecs === undefined ? undefined : BigInt(Math.max(0, Math.floor(keepaliveSecs)));
    callHost(`net.TcpStream.setKeepalive(${keepaliveSecs})`, () =>
      this.#requireInner().setKeepalive(v),
    );
  }

  keepalive(): number | undefined {
    const v = callHost("net.TcpStream.keepalive", () => this.#requireInner().keepalive());
    return v === undefined ? undefined : Number(v);
  }

  /** SO_LINGER. `undefined` = default; `0` = immediate RST; otherwise drain time in ms. */
  setLinger(lingerMs: number | undefined): void {
    const v = lingerMs === undefined ? undefined : BigInt(Math.max(0, Math.floor(lingerMs)));
    callHost(`net.TcpStream.setLinger(${lingerMs})`, () =>
      this.#requireInner().setLinger(v),
    );
  }

  linger(): number | undefined {
    const v = callHost("net.TcpStream.linger", () => this.#requireInner().linger());
    return v === undefined ? undefined : Number(v);
  }

  setReuseaddr(reuse: boolean): void {
    callHost(`net.TcpStream.setReuseaddr(${reuse})`, () =>
      this.#requireInner().setReuseaddr(reuse),
    );
  }

  reuseaddr(): boolean {
    return callHost("net.TcpStream.reuseaddr", () => this.#requireInner().reuseaddr());
  }

  // ---- Lifecycle ----------------------------------------------------------

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

  /** Async iterator yielding each frame until the peer closes. */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    try {
      while (this.#inner !== undefined) {
        try {
          yield this.recv();
        } catch (err) {
          if (err instanceof RecvError) return;
          throw err;
        }
      }
    } finally {
      this.close();
    }
  }

  #requireInner(): WitTcpStream {
    if (this.#inner === undefined) throw SysError.api("TcpStream is closed");
    return this.#inner;
  }
}

// ---------------------------------------------------------------------------
// UDP socket
// ---------------------------------------------------------------------------

/**
 * UDP datagram socket. Two modes: unconnected (`sendTo`/`recvFrom`) and
 * connected (`connect` + `send`/`recv`). Per-capsule cap: 4.
 */
export class UdpSocket {
  #inner: WitUdpSocket | undefined;

  private constructor(token: typeof NET_INTERNAL, value: unknown) {
    if (token !== NET_INTERNAL) throw new TypeError("UdpSocket cannot be constructed directly");
    this.#inner = value as WitUdpSocket;
  }

  static { createUdpSocket = (inner) => new UdpSocket(NET_INTERNAL, inner); }

  sendTo(data: Uint8Array, peerHost: string, peerPort: number): number {
    return callHost(`net.UdpSocket.sendTo(${peerHost}:${peerPort})`, () =>
      this.#requireInner().sendTo(data, peerHost, peerPort),
    );
  }

  recvFrom(maxBytes: number): UdpDatagram | undefined {
    return callHost(`net.UdpSocket.recvFrom(${maxBytes})`, () =>
      this.#requireInner().recvFrom(maxBytes),
    );
  }

  connect(peerHost: string, peerPort: number): void {
    callHost(`net.UdpSocket.connect(${peerHost}:${peerPort})`, () =>
      this.#requireInner().connect(peerHost, peerPort),
    );
  }

  disconnect(): void {
    callHost("net.UdpSocket.disconnect", () => this.#requireInner().disconnect());
  }

  send(data: Uint8Array): number {
    return callHost("net.UdpSocket.send", () => this.#requireInner().send(data));
  }

  recv(maxBytes: number): Uint8Array | undefined {
    return callHost(`net.UdpSocket.recv(${maxBytes})`, () =>
      this.#requireInner().recv(maxBytes),
    );
  }

  peerAddr(): string | undefined {
    return callHost("net.UdpSocket.peerAddr", () => this.#requireInner().peerAddr());
  }

  setReadTimeout(timeoutMs: number | undefined): void {
    const ms = toHostTimeout(timeoutMs);
    callHost(`net.UdpSocket.setReadTimeout(${timeoutMs})`, () =>
      this.#requireInner().setReadTimeout(ms),
    );
  }

  localAddr(): string {
    return callHost("net.UdpSocket.localAddr", () => this.#requireInner().localAddr());
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

  #requireInner(): WitUdpSocket {
    if (this.#inner === undefined) throw SysError.api("UdpSocket is closed");
    return this.#inner;
  }
}

// ---------------------------------------------------------------------------
// Pre-migration handle types preserved for source-compatibility — these are
// now just type aliases over the resource-backed classes above. Callers using
// the legacy names (`StreamHandle`, `ListenerHandle`) continue to compile.
// ---------------------------------------------------------------------------

export { TcpStream as StreamHandle, UnixListener as ListenerHandle };

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/** Bind the kernel-pre-provisioned Unix socket and return a listener. */
export function bindUnix(): UnixListener {
  const inner = callHost("net.bindUnix", () => hostBindUnix());
  return createUnixListener(inner);
}

/**
 * Bind a TCP listener for inbound connections. Gated by `net_tcp_bind`. Port
 * 0 selects an ephemeral port.
 */
export function bindTcp(host: string, port: number): TcpListener {
  const inner = callHost(`net.bindTcp(${host}:${port})`, () => hostBindTcp(host, port));
  return createTcpListener(inner);
}

/** Block until the next incoming connection on the Unix listener. */
export function accept(listener: UnixListener): TcpStream {
  return listener.accept();
}

/** Non-blocking accept. Returns `undefined` if none ready. */
export function tryAccept(listener: UnixListener): TcpStream | undefined {
  return listener.pollAccept(0);
}

/**
 * Open an outbound TCP connection to `host:port`. Goes through the SSRF
 * airlock (rejects private/loopback/etc.) and the `net_connect` allowlist.
 */
export function connect(host: string, port: number): TcpStream {
  const inner = callHost(`net.connect(${host}:${port})`, () => hostConnectTcp(host, port));
  return createTcpStream(inner);
}

/** Alias for {@link connect} matching the WIT name. */
export const connectTcp = connect;

/** Bind a UDP socket. */
export function udpBind(host: string, port: number): UdpSocket {
  const inner = callHost(`net.udpBind(${host}:${port})`, () => hostUdpBind(host, port));
  return createUdpSocket(inner);
}

/**
 * Resolve a hostname to a list of `"ip:port"` (or `"ip"` if no port in input)
 * strings. SSRF airlock applies — private/loopback/etc. ranges stripped.
 */
export function lookupHost(host: string): string[] {
  return callHost(`net.lookupHost(${host})`, () => hostLookupHost(host));
}

// ---------------------------------------------------------------------------
// Sleep shim — used by the polling recv loop
// ---------------------------------------------------------------------------

/**
 * 50 ms host-mediated sleep. Routes through `astrid:sys/host.sleep-ns`
 * so the kernel can cancel the wait when the capsule unloads and
 * account for the wait in audit. Mirrors the Rust SDK switch from
 * `std::thread::sleep` to `crate::time::sleep`.
 */
function sleepMs(ms: number): void {
  hostSleepMs(ms);
}
