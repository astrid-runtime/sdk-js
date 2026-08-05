/**
 * Outbound HTTP. Two public shapes:
 *
 *   1. A builder-style {@link Request} / {@link Response} mirroring the Rust
 *      SDK's reqwest-like API (`http.get(url)`, `http.send(req)`).
 *   2. A WHATWG-style {@link fetch} available as `http.fetch`, with optional
 *      `globalThis` registration via {@link installFetchPolyfill}. It routes through the same
 *      capability-gated host imports so users can't bypass the per-capsule
 *      net allow-list by reaching for the platform fetch.
 *
 * Streaming: {@link streamStart} returns an {@link HttpStream} resource
 * handle with `read-chunk` for explicit per-chunk pulls, an `async-iterator`
 * convenience, and access to the body as an `astrid:io/streams` `InputStream`
 * for capsules forwarding the body into another sink.
 */

import {
  httpRequestOpts as hostRequest,
  httpStreamStartOpts as hostStreamStart,
  type HttpRequestData,
  type HttpResponseData,
  type HttpStream as WitHttpStream,
  type HttpMethod as WitHttpMethod,
  type KeyValuePair,
  type RequestOptions as WitRequestOptions,
} from "astrid:http/host@1.1.0";
import { SysError, callHost } from "./errors.js";

// ---------------------------------------------------------------------------
// Method type
// ---------------------------------------------------------------------------

export type HttpMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "DELETE"
  | "CONNECT"
  | "OPTIONS"
  | "TRACE"
  | "PATCH"
  | string;

export type RedirectPolicy = "follow" | "error" | "manual";

/** Astrid-specific controls layered onto the familiar fetch/request surface. */
export interface HttpRequestOptions {
  /** Whole-request deadline in milliseconds. */
  timeoutMs?: number;
  /** TCP and TLS establishment deadline in milliseconds. */
  connectTimeoutMs?: number;
  /** Deadline from sending the request to receiving the first byte. */
  firstByteTimeoutMs?: number;
  /** Maximum idle gap between response chunks. */
  readTimeoutMs?: number;
  redirect?: RedirectPolicy;
  maxRedirects?: number;
  maxResponseBytes?: number | bigint;
  maxDecompressedBytes?: number | bigint;
  autoDecompress?: boolean;
  httpsOnly?: boolean;
  /** Subresource-integrity digest such as `sha256-<base64>`. */
  integrity?: string;
}

/** Convert a string method name into the WIT variant the host expects. */
function methodToWit(method: string): WitHttpMethod {
  switch (method.toUpperCase()) {
    case "GET":
      return { tag: "get" };
    case "HEAD":
      return { tag: "head" };
    case "POST":
      return { tag: "post" };
    case "PUT":
      return { tag: "put" };
    case "DELETE":
      return { tag: "delete" };
    case "CONNECT":
      return { tag: "connect" };
    case "OPTIONS":
      return { tag: "options" };
    case "TRACE":
      return { tag: "trace" };
    case "PATCH":
      return { tag: "patch" };
    default:
      return { tag: "other", val: method };
  }
}

// ---------------------------------------------------------------------------
// Builder API (reqwest shape)
// ---------------------------------------------------------------------------

export class Request {
  url: string;
  method: string;
  headers: Map<string, string>;
  body: Uint8Array | undefined;
  #options: HttpRequestOptions;

  constructor(method: string, url: string) {
    this.method = method;
    this.url = url;
    this.headers = new Map();
    this.body = undefined;
    this.#options = {};
  }

  static get(url: string): Request {
    return new Request("GET", url);
  }
  static post(url: string): Request {
    return new Request("POST", url);
  }
  static put(url: string): Request {
    return new Request("PUT", url);
  }
  static delete(url: string): Request {
    return new Request("DELETE", url);
  }
  static patch(url: string): Request {
    return new Request("PATCH", url);
  }
  static head(url: string): Request {
    return new Request("HEAD", url);
  }

  header(key: string, value: string): this {
    this.headers.set(key, value);
    return this;
  }

  setBody(body: string | Uint8Array): this {
    this.body = typeof body === "string" ? new TextEncoder().encode(body) : body;
    return this;
  }

  json<T>(value: T): this {
    this.headers.set("Content-Type", "application/json");
    let s: string;
    try {
      s = JSON.stringify(value);
    } catch (err) {
      throw SysError.json(`http.Request.json: ${(err as Error).message}`, err);
    }
    this.body = new TextEncoder().encode(s);
    return this;
  }

  /** Set the whole-request deadline in milliseconds. */
  timeout(ms: number): this {
    this.#options.timeoutMs = validateMilliseconds("timeout", ms);
    return this;
  }

  connectTimeout(ms: number): this {
    this.#options.connectTimeoutMs = validateMilliseconds("connectTimeout", ms);
    return this;
  }

  firstByteTimeout(ms: number): this {
    this.#options.firstByteTimeoutMs = validateMilliseconds("firstByteTimeout", ms);
    return this;
  }

  readTimeout(ms: number): this {
    this.#options.readTimeoutMs = validateMilliseconds("readTimeout", ms);
    return this;
  }

  redirect(policy: RedirectPolicy): this {
    this.#options.redirect = policy;
    return this;
  }

  maxRedirects(max: number): this {
    this.#options.maxRedirects = validateU32("maxRedirects", max);
    return this;
  }

  maxResponseBytes(max: number | bigint): this {
    this.#options.maxResponseBytes = max;
    return this;
  }

  maxDecompressedBytes(max: number | bigint): this {
    this.#options.maxDecompressedBytes = max;
    return this;
  }

  autoDecompress(enabled: boolean): this {
    this.#options.autoDecompress = enabled;
    return this;
  }

  httpsOnly(enabled = true): this {
    this.#options.httpsOnly = enabled;
    return this;
  }

  integrity(digest: string): this {
    this.#options.integrity = digest;
    return this;
  }

  /** Apply an options object, useful when adapting from configuration. */
  withOptions(options: HttpRequestOptions): this {
    if (options.timeoutMs !== undefined) this.timeout(options.timeoutMs);
    if (options.connectTimeoutMs !== undefined) this.connectTimeout(options.connectTimeoutMs);
    if (options.firstByteTimeoutMs !== undefined) this.firstByteTimeout(options.firstByteTimeoutMs);
    if (options.readTimeoutMs !== undefined) this.readTimeout(options.readTimeoutMs);
    if (options.redirect !== undefined) this.redirect(options.redirect);
    if (options.maxRedirects !== undefined) this.maxRedirects(options.maxRedirects);
    if (options.maxResponseBytes !== undefined) this.maxResponseBytes(options.maxResponseBytes);
    if (options.maxDecompressedBytes !== undefined) {
      this.maxDecompressedBytes(options.maxDecompressedBytes);
    }
    if (options.autoDecompress !== undefined) this.autoDecompress(options.autoDecompress);
    if (options.httpsOnly !== undefined) this.httpsOnly(options.httpsOnly);
    if (options.integrity !== undefined) this.integrity(options.integrity);
    return this;
  }

  toWit(): HttpRequestData {
    return {
      url: this.url,
      method: methodToWit(this.method),
      headers: Array.from(this.headers, ([key, value]) => ({ key, value })),
      body: this.body,
    };
  }

  /** @internal Convert controls to the canonical `request-options` record. */
  toWitOptions(): WitRequestOptions {
    const hasTimeout =
      this.#options.connectTimeoutMs !== undefined ||
      this.#options.firstByteTimeoutMs !== undefined ||
      this.#options.readTimeoutMs !== undefined ||
      this.#options.timeoutMs !== undefined;
    return {
      timeouts: hasTimeout
        ? {
            connectMs: optionalMs(this.#options.connectTimeoutMs),
            firstByteMs: optionalMs(this.#options.firstByteTimeoutMs),
            betweenBytesMs: optionalMs(this.#options.readTimeoutMs),
            totalMs: optionalMs(this.#options.timeoutMs),
          }
        : undefined,
      redirect: this.#options.redirect,
      maxRedirects: this.#options.maxRedirects,
      maxResponseBytes: optionalU64("maxResponseBytes", this.#options.maxResponseBytes),
      maxDecompressedBytes: optionalU64(
        "maxDecompressedBytes",
        this.#options.maxDecompressedBytes,
      ),
      autoDecompress: this.#options.autoDecompress,
      httpsOnly: this.#options.httpsOnly,
      integrity: this.#options.integrity,
    };
  }
}

export class Response {
  readonly status: number;
  readonly headers: Map<string, string>;
  readonly url: string;
  readonly redirected: boolean;
  readonly redirectCount: number;
  readonly elapsedMs: number;
  readonly wireBytes: bigint;
  readonly #body: Uint8Array;

  constructor(raw: HttpResponseData) {
    this.status = raw.status;
    this.headers = new Map(raw.headers.map((h) => [h.key, h.value]));
    this.#body = raw.body;
    this.url = raw.meta.finalUrl;
    this.redirectCount = raw.meta.redirectCount;
    this.redirected = raw.meta.redirectCount > 0;
    this.elapsedMs = Number(raw.meta.elapsedMs);
    this.wireBytes = raw.meta.wireBytes;
  }

  bytes(): Uint8Array {
    return this.#body;
  }

  text(): string {
    return new TextDecoder().decode(this.#body);
  }

  json<T = unknown>(): T {
    try {
      return JSON.parse(this.text()) as T;
    } catch (err) {
      throw SysError.json(`http.Response.json: ${(err as Error).message}`, err);
    }
  }

  ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }
}

export function send(req: Request): Response {
  const wit = req.toWit();
  const raw = callHost(`http.send ${req.method} ${req.url}`, () =>
    hostRequest(wit, req.toWitOptions()),
  );
  return new Response(raw);
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Streaming HTTP response. The kernel buffers chunks server-side; the
 * capsule reads them via `.read()` (or the async iterator) until EOF. Drop
 * (via `using` or `.close()`) releases the host-side resource.
 */
export class HttpStreamHandle {
  #inner: WitHttpStream | undefined;
  readonly status: number;
  readonly headers: Map<string, string>;

  constructor(inner: WitHttpStream) {
    this.#inner = inner;
    this.status = inner.status();
    this.headers = new Map(inner.headers().map((h: KeyValuePair) => [h.key, h.value]));
  }

  /** Read the next chunk. Returns `undefined` at EOF. */
  read(): Uint8Array | undefined {
    if (this.#inner === undefined) return undefined;
    const chunk = callHost("http.HttpStream.readChunk", () => this.#inner!.readChunk());
    if (chunk.length === 0) return undefined;
    return chunk;
  }

  close(): void {
    if (this.#inner === undefined) return;
    const inner = this.#inner;
    this.#inner = undefined;
    try {
      // Explicit close mirrors the WIT-defined `.close()`; the Drop step still
      // runs on resource release regardless.
      inner.close();
    } catch {
      // idempotent close — host may have already released it.
    }
    try {
      inner[Symbol.dispose]();
    } catch {
      // already released
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /** Async iterator that yields each chunk until EOF. Auto-closes on completion. */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    try {
      while (true) {
        const chunk = this.read();
        if (chunk === undefined) return;
        yield chunk;
      }
    } finally {
      this.close();
    }
  }
}

export interface StreamStart {
  handle: HttpStreamHandle;
  status: number;
  headers: Map<string, string>;
}

export function streamStart(req: Request): StreamStart {
  const wit = req.toWit();
  const inner: WitHttpStream = callHost(
    `http.streamStart ${req.method} ${req.url}`,
    () => hostStreamStart(wit, req.toWitOptions()),
  );
  const handle = new HttpStreamHandle(inner);
  return { handle, status: handle.status, headers: handle.headers };
}

// ---------------------------------------------------------------------------
// WHATWG fetch polyfill
// ---------------------------------------------------------------------------

export interface FetchInit extends HttpRequestOptions {
  method?: string;
  headers?: Record<string, string> | Map<string, string> | [string, string][];
  body?: string | Uint8Array | Record<string, unknown>;
}

export class FetchResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly url: string;
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly redirectCount: number;
  readonly elapsedMs: number;
  readonly wireBytes: bigint;
  readonly #body: Uint8Array;

  constructor(raw: HttpResponseData) {
    this.url = raw.meta.finalUrl;
    this.status = raw.status;
    this.statusText = httpStatusText(raw.status);
    this.headers = new Headers(raw.headers.map((h): [string, string] => [h.key, h.value]));
    this.ok = raw.status >= 200 && raw.status < 300;
    this.redirectCount = raw.meta.redirectCount;
    this.redirected = raw.meta.redirectCount > 0;
    this.elapsedMs = Number(raw.meta.elapsedMs);
    this.wireBytes = raw.meta.wireBytes;
    this.#body = raw.body;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.#body);
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#body.buffer.slice(
      this.#body.byteOffset,
      this.#body.byteOffset + this.#body.byteLength,
    ) as ArrayBuffer;
  }

  async bytes(): Promise<Uint8Array> {
    return this.#body;
  }
}

export async function fetch(url: string, init: FetchInit = {}): Promise<FetchResponse> {
  const req = new Request(init.method ?? "GET", url).withOptions(init);
  if (init.headers) {
    for (const [k, v] of normalizeHeaders(init.headers)) {
      req.header(k, v);
    }
  }
  if (init.body !== undefined) {
    if (typeof init.body === "string") {
      req.setBody(init.body);
    } else if (init.body instanceof Uint8Array) {
      req.setBody(init.body);
    } else {
      req.json(init.body);
    }
  }
  const raw = callHost(`fetch ${req.method} ${url}`, () =>
    hostRequest(req.toWit(), req.toWitOptions()),
  );
  return new FetchResponse(raw);
}

/** Backwards-compatible name for {@link fetch}. */
export const fetchPolyfill = fetch;

/** Install the polyfill on `globalThis.fetch`. */
export function installFetchPolyfill(): void {
  (globalThis as unknown as { fetch?: typeof fetch }).fetch = fetch;
}

function validateMilliseconds(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw SysError.api(`${name} must be a finite, non-negative number of milliseconds`);
  }
  return Math.floor(value);
}

function validateU32(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw SysError.api(`${name} must be an integer between 0 and 4294967295`);
  }
  return value;
}

function optionalMs(value: number | undefined): bigint | undefined {
  return value === undefined ? undefined : BigInt(value);
}

function optionalU64(name: string, value: number | bigint | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw SysError.api(`${name} must be a non-negative safe integer or bigint`);
    }
    return BigInt(value);
  }
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw SysError.api(`${name} must fit in an unsigned 64-bit integer`);
  }
  return value;
}

function normalizeHeaders(
  input: NonNullable<FetchInit["headers"]>,
): Iterable<[string, string]> {
  if (input instanceof Map) return input.entries();
  if (Array.isArray(input)) return input;
  return Object.entries(input);
}

function httpStatusText(code: number): string {
  const map: Record<number, string> = {
    200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
    301: "Moved Permanently", 302: "Found", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    409: "Conflict", 422: "Unprocessable Entity", 429: "Too Many Requests",
    500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
  };
  return map[code] ?? "";
}
