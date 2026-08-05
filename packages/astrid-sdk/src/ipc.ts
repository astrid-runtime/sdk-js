/**
 * IPC event bus. Mirrors `astrid_sdk::ipc`.
 *
 * Publish: {@link publish} / {@link publishJson} for the calling capsule's
 * own principal, {@link publishAs} / {@link publishJsonAs} for uplinks
 * asserting an end-user principal (requires `uplink = true` capability —
 * subscribers see the principal as `claimed`, not `verified`).
 *
 * Subscribe: {@link subscribe} returns a {@link Subscription} resource handle.
 * Resources are Component Model objects with a drop step; we surface
 * `Symbol.dispose` so `using sub = ipc.subscribe(...)` cleans up automatically
 * on scope exit, and an explicit `.close()` for codebases that haven't moved
 * to the explicit-resource-management proposal. AsyncIterable convenience
 * preserved from the pre-migration API.
 *
 * Request/response: {@link requestResponse} mirrors `astrid_sdk::ipc::request_response`.
 * Validates the request payload, pre-subscribes to the reply topic, publishes
 * with an auto-injected `correlation_id`, blocks up to `timeoutMs` for the
 * single reply, always tears down the subscription.
 */

import {
  publish as hostPublish,
  publishAs as hostPublishAs,
  subscribe as hostSubscribe,
  getInterceptorBindings as hostGetInterceptorBindings,
  type IpcEnvelope,
  type IpcMessage as WitIpcMessage,
  type InterceptorBinding as WitInterceptorBinding,
  type Subscription as WitSubscription,
} from "astrid:ipc/host@1.0.0";
import { randomBytes as hostRandomBytes } from "astrid:sys/host@1.0.0";
import { SysError, callHost } from "./errors.js";

/** A single IPC message dispatched to a subscriber. */
export interface IpcMessage {
  topic: string;
  payload: string;
  /** UUID of the capsule that published this message. */
  sourceId: string;
  /**
   * Principal attributed to the publisher. `verified(...)` for kernel-attributed
   * principals, `claimed(...)` for uplink-asserted principals (NOT kernel-
   * verified), `system` for kernel-originated events.
   *
   * Subscribers MUST check this variant on sensitive actions. Multi-message
   * batches MUST be read per-message rather than relying on `runtime.caller()`
   * (which only reflects the first message's publisher).
   */
  principal: PrincipalAttribution;
  /** Convenience: parse `payload` as JSON. Throws SysError.json on failure. */
  json<T = unknown>(): T;
}

export type PrincipalAttribution =
  | { tag: "verified"; val: string }
  | { tag: "claimed"; val: string }
  | { tag: "system" };

export interface PollResult {
  messages: IpcMessage[];
  /** Messages dropped due to buffer overflow since the previous poll. */
  dropped: bigint;
  /** Cumulative lag — total messages missed since subscription opened. */
  lagged: bigint;
}

export interface InterceptorBinding {
  /** Subscription handle ID. */
  handle: bigint;
  /** Hook action name the kernel dispatches when a message matches. */
  action: string;
  /** Topic pattern this subscription was registered for. */
  topic: string;
}

const DEFAULT_RECV_TIMEOUT_MS = 5_000n;
const IPC_INTERNAL = Symbol("Astrid IPC resource");
let createSubscription: (inner: WitSubscription, topic: string) => Subscription;

export function publish(topic: string, payload: string): void {
  callHost(`ipc.publish(${quote(topic)})`, () => hostPublish(topic, payload));
}

export function publishJson<T>(topic: string, payload: T): void {
  publish(topic, jsonify(`ipc.publishJson(${quote(topic)})`, payload));
}

/**
 * Publish on behalf of a specific principal. Requires `uplink = true` in
 * `Capsule.toml [capabilities]`; non-uplinks see `capability-denied`.
 * Subscribers see the principal as `claimed(...)`, NOT `verified(...)` —
 * downstream consumers MUST treat the principal as caller-input, not
 * authenticated context.
 */
export function publishAs(topic: string, payload: string, principal: string): void {
  callHost(`ipc.publishAs(${quote(topic)})`, () =>
    hostPublishAs(topic, payload, principal),
  );
}

export function publishJsonAs<T>(topic: string, payload: T, principal: string): void {
  publishAs(topic, jsonify(`ipc.publishJsonAs(${quote(topic)})`, payload), principal);
}

/**
 * Subscribe to an IPC topic pattern. Supports exact matches and trailing-suffix
 * wildcards (`foo.bar.*`). Mid-segment wildcards are rejected by the host.
 *
 * The returned {@link Subscription} is a Resource handle. Use `using` for
 * scope-bound cleanup, or call `.close()` explicitly:
 *
 * ```ts
 * using sub = ipc.subscribe("foo.bar");      // disposed at scope exit
 * for await (const msg of sub) { ... }
 *
 * const sub = ipc.subscribe("foo.bar");      // explicit close
 * try { ... } finally { sub.close(); }
 * ```
 *
 * Per-capsule cap: 128 subscriptions.
 */
export function subscribe(topicPattern: string): Subscription {
  const inner = callHost(`ipc.subscribe(${quote(topicPattern)})`, () =>
    hostSubscribe(topicPattern),
  );
  return createSubscription(inner, topicPattern);
}

/**
 * Pre-registered interceptor handles for run-loop capsules. Returns ONLY the
 * calling capsule's own interceptors. Most authors don't call this — the
 * `@interceptor` decorator + bridge handle dispatch.
 */
export function runtimeInterceptors(): InterceptorBinding[] {
  const handles: WitInterceptorBinding[] = callHost("ipc.runtimeInterceptors", () =>
    hostGetInterceptorBindings(),
  );
  return handles.map((h) => ({ handle: h.handleId, action: h.action, topic: h.topic }));
}

export class Subscription {
  readonly topic: string;
  #inner: WitSubscription | undefined;

  private constructor(token: typeof IPC_INTERNAL, value: unknown, topic: string) {
    if (token !== IPC_INTERNAL) throw new TypeError("Subscription cannot be constructed directly");
    this.#inner = value as WitSubscription;
    this.topic = topic;
  }

  static {
    createSubscription = (inner, topic) => new Subscription(IPC_INTERNAL, inner, topic);
  }

  /** Non-blocking poll. Returns whatever's already queued. */
  poll(): PollResult {
    const env = callHost(`ipc.poll(${quote(this.topic)})`, () => this.#requireInner().poll());
    return envelopeToPollResult(env);
  }

  /** Blocking receive (timeout capped at 60s by the host). */
  recv(timeoutMs: bigint = DEFAULT_RECV_TIMEOUT_MS): PollResult {
    const env = callHost(`ipc.recv(${quote(this.topic)})`, () =>
      this.#requireInner().recv(timeoutMs),
    );
    return envelopeToPollResult(env);
  }

  /**
   * Idempotent — closing an already-closed subscription is a no-op.
   * Equivalent to the resource Drop. Prefer `using` when the surrounding
   * code can adopt explicit resource management.
   */
  close(): void {
    if (this.#inner === undefined) return;
    const inner = this.#inner;
    this.#inner = undefined;
    try {
      inner[Symbol.dispose]();
    } catch {
      // Resource may already be released (interceptor-owned handles, etc.).
      // close() is meant to be safe to call from any cleanup path.
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /**
   * AsyncIterable convenience. Loops calling `.recv()` and yielding each
   * message. Stops when the subscription is closed. Drops `lagged`/`dropped`
   * info — use `.poll()`/`.recv()` explicitly if you need to react to lag.
   */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<IpcMessage> {
    while (this.#inner !== undefined) {
      const batch = this.recv();
      for (const msg of batch.messages) {
        yield msg;
      }
    }
  }

  #requireInner(): WitSubscription {
    if (this.#inner === undefined) {
      throw SysError.api(`subscription on ${quote(this.topic)} is closed`);
    }
    return this.#inner;
  }
}

/**
 * Send a request on `requestTopic` and await a single response on a scoped
 * reply topic. Mirrors `astrid_sdk::ipc::request_response` exactly.
 *
 * The helper:
 * 1. Generates a v4 correlation ID.
 * 2. Subscribes to `{responseNamespace}.{correlationId}` *before* publishing
 *    (so the response can never be missed in the race).
 * 3. Injects the correlation ID into the request payload as a top-level
 *    `correlation_id` field.
 * 4. Publishes the request.
 * 5. Blocks up to `timeoutMs` for the response.
 * 6. Unsubscribes (always, even on error).
 * 7. Returns the parsed response payload as `Resp`.
 *
 * `request` must serialize to a JSON object. Primitives, arrays, strings,
 * etc. are rejected synchronously with `SysError.api` because there is
 * nowhere to put the correlation ID.
 *
 * `responseNamespace` should be the dotted topic prefix the responder
 * publishes to, *without* the trailing correlation id segment. For example,
 * if the responder publishes to
 * `registry.v1.response.set_active_model.<corr_id>`, pass
 * `"registry.v1.response.set_active_model"`.
 *
 * `timeoutMs` is capped at 60,000 ms by the host. A timeout throws
 * `SysError.api` with `request_response: no reply within …`.
 */
export function requestResponse<Req, Resp = unknown>(
  requestTopic: string,
  responseNamespace: string,
  request: Req,
  timeoutMs: number | bigint,
): Resp {
  // Validate input before touching the host so bad calls never allocate a
  // subscription handle.
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw SysError.api(
      "request_response: request payload must serialize to a JSON object so the " +
        "correlation_id can be injected",
    );
  }

  const correlationId = randomUuidV4();
  // Defensive copy + injection. Don't mutate the caller's object.
  const augmented: Record<string, unknown> = {
    ...(request as Record<string, unknown>),
    correlation_id: correlationId,
  };
  const payload = jsonify("requestResponse", augmented);
  const replyTopic = `${responseNamespace}.${correlationId}`;

  const sub = subscribe(replyTopic);
  try {
    publish(requestTopic, payload);
    const timeoutBig =
      typeof timeoutMs === "bigint" ? timeoutMs : BigInt(Math.max(0, Math.floor(timeoutMs)));
    const poll = sub.recv(timeoutBig);
    const msg = poll.messages[0];
    if (msg === undefined) {
      throw SysError.api(
        `request_response: no reply on '${replyTopic}' within ${String(timeoutMs)}ms`,
      );
    }
    try {
      return JSON.parse(msg.payload) as Resp;
    } catch (err) {
      throw SysError.json(
        `request_response: failed to parse reply on '${replyTopic}': ${(err as Error).message}`,
        err,
      );
    }
  } finally {
    sub.close();
  }
}

function envelopeToPollResult(env: IpcEnvelope): PollResult {
  return {
    messages: env.messages.map(makeIpcMessage),
    dropped: env.dropped,
    lagged: env.lagged,
  };
}

function makeIpcMessage(m: WitIpcMessage): IpcMessage {
  return {
    topic: m.topic,
    payload: m.payload,
    sourceId: m.sourceId,
    principal: m.principal,
    json<T = unknown>(): T {
      try {
        return JSON.parse(m.payload) as T;
      } catch (err) {
        throw SysError.json(
          `IpcMessage.json() on topic ${quote(m.topic)}: ${(err as Error).message}`,
          err,
        );
      }
    },
  };
}

function jsonify(label: string, value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (err) {
    throw SysError.json(`${label}: ${(err as Error).message}`, err);
  }
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * UUIDv4 generator. The Astrid host exposes `randomBytes`; pulling from
 * `globalThis.crypto` would work too (StarlingMonkey exposes `crypto`), but
 * routing through `sys::randomBytes` keeps the audit trail on the host side.
 *
 * Lazy-loaded to avoid a load-order cycle between ipc.ts and sys.ts.
 */
function randomUuidV4(): string {
  // 16 random bytes → format as 8-4-4-4-12 hex with version (0x40) and
  // variant (0x80) bits set. RFC 4122 §4.4.
  const bytes = getRandomBytes();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) {
    hex.push((bytes[i] ?? 0).toString(16).padStart(2, "0"));
  }
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

function getRandomBytes(): Uint8Array {
  // Audit-traced via sys::random-bytes rather than reaching for globalThis.crypto
  // so every UUID generation flows through the kernel's principal-scoped audit.
  return hostRandomBytes(16n);
}
