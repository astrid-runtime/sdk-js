/**
 * Capability-gated outbound HTTP for Astrid capsules.
 *
 * {@link fetch} is the primary API and follows the WHATWG contract for the
 * buffered request/response features the host can faithfully provide. The
 * Astrid-specific policy and resource controls are additive camelCase fields
 * on {@link FetchOptions}. The explicitly named {@link RequestBuilder} keeps
 * the Rust SDK's convenient fluent form without impersonating WHATWG Request.
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

const encoder = new TextEncoder();
const HTTP_INTERNAL = Symbol("Astrid HTTP resource");
let createBufferedResponse: (raw: HttpResponseData) => BufferedResponse;
let createHttpStreamHandle: (inner: WitHttpStream) => HttpStreamHandle;

export type HttpMethod =
  | "GET" | "HEAD" | "POST" | "PUT" | "DELETE"
  | "CONNECT" | "OPTIONS" | "TRACE" | "PATCH"
  | string;

export type RedirectPolicy = "follow" | "error" | "manual";

/** Host-specific controls shared by fetch and the fluent request builder. */
export interface HttpRequestOptions {
  /** Whole-request deadline in milliseconds. */
  timeoutMs?: number;
  /** TCP and TLS establishment deadline in milliseconds. */
  connectTimeoutMs?: number;
  /** Deadline from request transmission to the first response byte. */
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

/** WHATWG-shaped fetch init plus Astrid's capability/resource controls. */
export interface FetchOptions extends HttpRequestOptions {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | Uint8Array | null;
  signal?: AbortSignal | null;
}

export type FetchInput = string | URL | globalThis.Request;

/** Astrid metadata added to the ordinary WHATWG Response returned by fetch. */
export interface ResponseMetadata {
  readonly redirectCount: number;
  readonly elapsedMs: number;
  readonly wireBytes: bigint;
  bytes(): Promise<Uint8Array>;
}

/** A genuine WHATWG Response with additive Astrid request metadata. */
export type FetchResponse = globalThis.Response & ResponseMetadata;

interface BuilderState {
  body: Uint8Array | undefined;
  options: HttpRequestOptions;
}

const builderStates = new WeakMap<RequestBuilder, BuilderState>();

/**
 * Fluent, buffered request builder for authors who prefer the Rust SDK shape.
 * Use {@link fetch} for ordinary JavaScript HTTP code.
 */
export class RequestBuilder {
  url: string;
  method: string;
  readonly headers: Headers;

  constructor(method: string, url: string | URL) {
    this.method = method.toUpperCase();
    this.url = String(url);
    this.headers = new Headers();
    builderStates.set(this, { body: undefined, options: {} });
  }

  static get(url: string | URL): RequestBuilder { return new RequestBuilder("GET", url); }
  static post(url: string | URL): RequestBuilder { return new RequestBuilder("POST", url); }
  static put(url: string | URL): RequestBuilder { return new RequestBuilder("PUT", url); }
  static delete(url: string | URL): RequestBuilder { return new RequestBuilder("DELETE", url); }
  static patch(url: string | URL): RequestBuilder { return new RequestBuilder("PATCH", url); }
  static head(url: string | URL): RequestBuilder { return new RequestBuilder("HEAD", url); }

  header(name: string, value: string): this {
    this.headers.set(name, value);
    return this;
  }

  body(value: string | Uint8Array): this {
    builderState(this).body = typeof value === "string" ? encoder.encode(value) : value;
    return this;
  }

  /** @deprecated Use {@link body}. */
  setBody(value: string | Uint8Array): this { return this.body(value); }

  json(value: unknown): this {
    this.headers.set("content-type", "application/json");
    try {
      builderState(this).body = encoder.encode(JSON.stringify(value));
    } catch (error) {
      throw SysError.json(`http.RequestBuilder.json: ${(error as Error).message}`, error);
    }
    return this;
  }

  timeout(ms: number): this { builderState(this).options.timeoutMs = milliseconds("timeout", ms); return this; }
  connectTimeout(ms: number): this { builderState(this).options.connectTimeoutMs = milliseconds("connectTimeout", ms); return this; }
  firstByteTimeout(ms: number): this { builderState(this).options.firstByteTimeoutMs = milliseconds("firstByteTimeout", ms); return this; }
  readTimeout(ms: number): this { builderState(this).options.readTimeoutMs = milliseconds("readTimeout", ms); return this; }
  redirect(policy: RedirectPolicy): this { builderState(this).options.redirect = policy; return this; }
  maxRedirects(max: number): this { builderState(this).options.maxRedirects = u32("maxRedirects", max); return this; }
  maxResponseBytes(max: number | bigint): this { builderState(this).options.maxResponseBytes = max; return this; }
  maxDecompressedBytes(max: number | bigint): this { builderState(this).options.maxDecompressedBytes = max; return this; }
  autoDecompress(enabled = true): this { builderState(this).options.autoDecompress = enabled; return this; }
  httpsOnly(enabled = true): this { builderState(this).options.httpsOnly = enabled; return this; }
  integrity(digest: string): this { builderState(this).options.integrity = digest; return this; }

  withOptions(options: HttpRequestOptions): this {
    if (options.timeoutMs !== undefined) this.timeout(options.timeoutMs);
    if (options.connectTimeoutMs !== undefined) this.connectTimeout(options.connectTimeoutMs);
    if (options.firstByteTimeoutMs !== undefined) this.firstByteTimeout(options.firstByteTimeoutMs);
    if (options.readTimeoutMs !== undefined) this.readTimeout(options.readTimeoutMs);
    if (options.redirect !== undefined) this.redirect(options.redirect);
    if (options.maxRedirects !== undefined) this.maxRedirects(options.maxRedirects);
    if (options.maxResponseBytes !== undefined) this.maxResponseBytes(options.maxResponseBytes);
    if (options.maxDecompressedBytes !== undefined) this.maxDecompressedBytes(options.maxDecompressedBytes);
    if (options.autoDecompress !== undefined) this.autoDecompress(options.autoDecompress);
    if (options.httpsOnly !== undefined) this.httpsOnly(options.httpsOnly);
    if (options.integrity !== undefined) this.integrity(options.integrity);
    return this;
  }

}

/** Buffered synchronous response returned by {@link send}. */
export class BufferedResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly url: string;
  readonly redirected: boolean;
  readonly redirectCount: number;
  readonly elapsedMs: number;
  readonly wireBytes: bigint;
  readonly #body: Uint8Array;

  private constructor(token: typeof HTTP_INTERNAL, raw: HttpResponseData) {
    if (token !== HTTP_INTERNAL) throw new TypeError("BufferedResponse cannot be constructed directly");
    this.status = raw.status;
    this.headers = new Headers(raw.headers.map((h): [string, string] => [h.key, h.value]));
    this.#body = raw.body;
    this.url = raw.meta.finalUrl;
    this.redirectCount = raw.meta.redirectCount;
    this.redirected = raw.meta.redirectCount > 0;
    this.elapsedMs = Number(raw.meta.elapsedMs);
    this.wireBytes = raw.meta.wireBytes;
  }

  static { createBufferedResponse = (raw) => new BufferedResponse(HTTP_INTERNAL, raw); }

  get ok(): boolean { return this.status >= 200 && this.status < 300; }
  bytes(): Uint8Array { return this.#body.slice(); }
  text(): string { return new TextDecoder().decode(this.#body); }
  json<T = unknown>(): T {
    try {
      return JSON.parse(this.text()) as T;
    } catch (error) {
      throw SysError.json(`http.BufferedResponse.json: ${(error as Error).message}`, error);
    }
  }
}

export function send(request: RequestBuilder): BufferedResponse {
  const encoded = encodeBuilder(request);
  const raw = callHost(`http.send ${request.method} ${request.url}`, () =>
    hostRequest(encoded.request, encoded.options),
  );
  return createBufferedResponse(raw);
}

/** A pull-based streaming response handle. */
export class HttpStreamHandle {
  #inner: WitHttpStream | undefined;
  readonly status: number;
  readonly headers: Headers;

  private constructor(token: typeof HTTP_INTERNAL, inner: WitHttpStream) {
    if (token !== HTTP_INTERNAL) throw new TypeError("HttpStreamHandle cannot be constructed directly");
    this.#inner = inner;
    this.status = inner.status();
    this.headers = new Headers(inner.headers().map((h: KeyValuePair): [string, string] => [h.key, h.value]));
  }

  static { createHttpStreamHandle = (inner) => new HttpStreamHandle(HTTP_INTERNAL, inner); }

  read(): Uint8Array | undefined {
    if (this.#inner === undefined) return undefined;
    const chunk = callHost("http.HttpStream.read", () => this.#inner!.readChunk());
    return chunk.length === 0 ? undefined : chunk;
  }

  close(): void {
    if (this.#inner === undefined) return;
    const inner = this.#inner;
    this.#inner = undefined;
    try { inner.close(); } catch { /* already closed */ }
    try { inner[Symbol.dispose](); } catch { /* already released */ }
  }

  [Symbol.dispose](): void { this.close(); }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    try {
      for (;;) {
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
  headers: Headers;
}

export function streamStart(request: RequestBuilder): StreamStart {
  const encoded = encodeBuilder(request);
  const inner = callHost(`http.streamStart ${request.method} ${request.url}`, () =>
    hostStreamStart(encoded.request, encoded.options),
  );
  const handle = createHttpStreamHandle(inner);
  return { handle, status: handle.status, headers: handle.headers };
}

/**
 * WHATWG-style fetch routed through Astrid's capability-gated HTTP host.
 * The host is currently buffered, so streaming request bodies are rejected.
 */
export async function fetch(input: FetchInput, init: FetchOptions = {}): Promise<FetchResponse> {
  const normalized = await normalizeFetchInput(input, init);
  abortIfNeeded(normalized.signal);
  if ((normalized.method === "GET" || normalized.method === "HEAD") && normalized.body !== undefined) {
    throw new TypeError(`Request with ${normalized.method} method cannot have a body.`);
  }
  const encoded = encodeRequest(
    normalized.method,
    normalized.url,
    normalized.headers,
    normalized.body,
    normalized.options,
  );
  const raw = callHost(`http.fetch ${normalized.method} ${normalized.url}`, () =>
    hostRequest(encoded.request, encoded.options),
  );
  abortIfNeeded(normalized.signal);
  return createFetchResponse(raw);
}

/** Install the Astrid fetch implementation on `globalThis`. */
export function installGlobalFetch(): void {
  (globalThis as unknown as { fetch?: typeof fetch }).fetch = fetch;
}

async function normalizeFetchInput(
  input: FetchInput,
  init: FetchOptions,
): Promise<{
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array | undefined;
  signal: AbortSignal | null | undefined;
  options: HttpRequestOptions;
}> {
  const source = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
  const url = source === undefined ? String(input) : source.url;
  const parsedUrl = new URL(url);
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    throw new TypeError("Request URL cannot include credentials");
  }
  const method = (init.method ?? source?.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers ?? source?.headers);
  let body: Uint8Array | undefined;
  if (init.body !== undefined && init.body !== null) {
    body = await bodyBytes(init.body);
    setDefaultContentType(headers, init.body);
  } else if (source?.body !== null && source !== undefined) {
    if (source.bodyUsed) throw new TypeError("Cannot fetch a Request whose body is already used");
    body = new Uint8Array(await source.arrayBuffer());
  }
  return {
    url: parsedUrl.href,
    method,
    headers,
    body,
    signal: init.signal ?? source?.signal,
    options: fetchRequestOptions(init, source),
  };
}

function fetchRequestOptions(
  init: FetchOptions,
  source: globalThis.Request | undefined,
): HttpRequestOptions {
  const options: HttpRequestOptions = {};
  if (init.timeoutMs !== undefined) options.timeoutMs = init.timeoutMs;
  if (init.connectTimeoutMs !== undefined) options.connectTimeoutMs = init.connectTimeoutMs;
  if (init.firstByteTimeoutMs !== undefined) options.firstByteTimeoutMs = init.firstByteTimeoutMs;
  if (init.readTimeoutMs !== undefined) options.readTimeoutMs = init.readTimeoutMs;
  const redirect = init.redirect ?? source?.redirect;
  if (redirect !== undefined) options.redirect = redirect;
  if (init.maxRedirects !== undefined) options.maxRedirects = init.maxRedirects;
  if (init.maxResponseBytes !== undefined) options.maxResponseBytes = init.maxResponseBytes;
  if (init.maxDecompressedBytes !== undefined) options.maxDecompressedBytes = init.maxDecompressedBytes;
  if (init.autoDecompress !== undefined) options.autoDecompress = init.autoDecompress;
  if (init.httpsOnly !== undefined) options.httpsOnly = init.httpsOnly;
  const integrity = init.integrity ?? source?.integrity;
  if (integrity !== undefined && integrity !== "") options.integrity = integrity;
  return options;
}

async function bodyBytes(body: BodyInit | Uint8Array): Promise<Uint8Array> {
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return encoder.encode(body.toString());
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    throw new TypeError("FormData request bodies are not supported by the buffered Astrid HTTP host");
  }
  throw new TypeError("ReadableStream request bodies are not supported by the buffered Astrid HTTP host");
}

function setDefaultContentType(headers: Headers, body: BodyInit | Uint8Array): void {
  if (headers.has("content-type")) return;
  if (typeof body === "string") {
    headers.set("content-type", "text/plain;charset=UTF-8");
  } else if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
  } else if (typeof Blob !== "undefined" && body instanceof Blob && body.type !== "") {
    headers.set("content-type", body.type);
  }
}

function createFetchResponse(raw: HttpResponseData): FetchResponse {
  const nullBody = raw.status === 101 || raw.status === 103 || raw.status === 204 || raw.status === 205 || raw.status === 304;
  const responseBody = raw.body.buffer.slice(
    raw.body.byteOffset,
    raw.body.byteOffset + raw.body.byteLength,
  ) as ArrayBuffer;
  const response = new globalThis.Response(nullBody ? null : responseBody, {
    status: raw.status,
    statusText: statusText(raw.status),
    headers: raw.headers.map((h): [string, string] => [h.key, h.value]),
  });
  const metadata = {
    url: raw.meta.finalUrl,
    redirected: raw.meta.redirectCount > 0,
    redirectCount: raw.meta.redirectCount,
    elapsedMs: Number(raw.meta.elapsedMs),
    wireBytes: raw.meta.wireBytes,
  };
  return decorateResponse(response, metadata);
}

function decorateResponse(
  response: globalThis.Response,
  metadata: Omit<ResponseMetadata, "bytes"> & { url: string; redirected: boolean },
): FetchResponse {
  const nativeClone = response.clone.bind(response);
  Object.defineProperties(response, {
    url: { value: metadata.url, enumerable: true },
    redirected: { value: metadata.redirected, enumerable: true },
    redirectCount: { value: metadata.redirectCount, enumerable: true },
    elapsedMs: { value: metadata.elapsedMs, enumerable: true },
    wireBytes: { value: metadata.wireBytes, enumerable: true },
    bytes: {
      value: async () => new Uint8Array(await response.arrayBuffer()),
    },
    clone: {
      value: () => decorateResponse(nativeClone(), metadata),
    },
  });
  return response as FetchResponse;
}

function encodeRequest(
  method: string,
  url: string,
  headers: Headers,
  body: Uint8Array | undefined,
  options: HttpRequestOptions,
): { request: HttpRequestData; options: WitRequestOptions } {
  const hasTimeout = options.connectTimeoutMs !== undefined ||
    options.firstByteTimeoutMs !== undefined || options.readTimeoutMs !== undefined ||
    options.timeoutMs !== undefined;
  return {
    request: {
      url,
      method: methodToWit(method),
      headers: headerPairs(headers),
      body,
    },
    options: {
      timeouts: hasTimeout ? {
        connectMs: optionalMs("connectTimeoutMs", options.connectTimeoutMs),
        firstByteMs: optionalMs("firstByteTimeoutMs", options.firstByteTimeoutMs),
        betweenBytesMs: optionalMs("readTimeoutMs", options.readTimeoutMs),
        totalMs: optionalMs("timeoutMs", options.timeoutMs),
      } : undefined,
      redirect: options.redirect,
      maxRedirects: options.maxRedirects === undefined ? undefined : u32("maxRedirects", options.maxRedirects),
      maxResponseBytes: optionalU64("maxResponseBytes", options.maxResponseBytes),
      maxDecompressedBytes: optionalU64("maxDecompressedBytes", options.maxDecompressedBytes),
      autoDecompress: options.autoDecompress,
      httpsOnly: options.httpsOnly,
      integrity: options.integrity,
    },
  };
}

function headerPairs(headers: Headers): KeyValuePair[] {
  const pairs: KeyValuePair[] = [];
  headers.forEach((value, key) => pairs.push({ key, value }));
  return pairs;
}

function encodeBuilder(builder: RequestBuilder): { request: HttpRequestData; options: WitRequestOptions } {
  const state = builderState(builder);
  return encodeRequest(builder.method, builder.url, builder.headers, state.body, state.options);
}

function builderState(builder: RequestBuilder): BuilderState {
  const state = builderStates.get(builder);
  if (state === undefined) throw SysError.api("invalid HTTP request builder");
  return state;
}

function methodToWit(method: string): WitHttpMethod {
  switch (method.toUpperCase()) {
    case "GET": return { tag: "get" };
    case "HEAD": return { tag: "head" };
    case "POST": return { tag: "post" };
    case "PUT": return { tag: "put" };
    case "DELETE": return { tag: "delete" };
    case "CONNECT": return { tag: "connect" };
    case "OPTIONS": return { tag: "options" };
    case "TRACE": return { tag: "trace" };
    case "PATCH": return { tag: "patch" };
    default: return { tag: "other", val: method };
  }
}

function abortIfNeeded(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function milliseconds(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw SysError.api(`${name} must be a finite, non-negative number of milliseconds`);
  }
  return Math.floor(value);
}

function u32(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw SysError.api(`${name} must be an integer between 0 and 4294967295`);
  }
  return value;
}

function optionalMs(name: string, value: number | undefined): bigint | undefined {
  return value === undefined ? undefined : BigInt(milliseconds(name, value));
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

function statusText(code: number): string {
  const names: Record<number, string> = {
    200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
    301: "Moved Permanently", 302: "Found", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    409: "Conflict", 422: "Unprocessable Entity", 429: "Too Many Requests",
    500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
  };
  return names[code] ?? "";
}
