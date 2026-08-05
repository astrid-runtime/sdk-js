/**
 * Typed lifecycle-hook events delivered by the hook bridge.
 *
 * Hook handlers normally receive a {@link HookEvent} through the `@hook`
 * decorator. The event exposes JavaScript-style properties and JSON parsing,
 * while replies remain scoped to the event's correlation id.
 */

import * as ipc from "./ipc.js";
import { SysError } from "./errors.js";
import type { hook as contracts } from "./contracts.js";

export type HookEventRequest = contracts.HookEventRequest;
export type HookResult = contracts.HookResult;

const RESPONSE_PREFIX = "hook.v1.response.";

/** A lifecycle event with its optional reply channel bound. */
export class HookEvent {
  readonly name: string;
  readonly correlationId: string | undefined;
  readonly payload: string;

  constructor(request: HookEventRequest) {
    this.name = request.hook;
    this.correlationId = request.correlation_id;
    this.payload = request.payload;
  }

  /** @deprecated Use {@link payload}. */
  get rawPayload(): string { return this.payload; }

  /** Whether this event has a correlation-scoped response channel. */
  get canReply(): boolean { return this.correlationId !== undefined; }

  /** Parse the hook-specific JSON payload. */
  json<T = unknown>(): T {
    try {
      return JSON.parse(this.payload) as T;
    } catch (error) {
      throw SysError.json(`hooks.HookEvent.json: ${(error as Error).message}`, error);
    }
  }

  /**
   * Publish a result on this event's scoped reply topic. Fire-and-forget
   * events have no correlation id, so replying to one is a successful no-op.
   */
  reply(result: HookResult): boolean {
    if (this.correlationId === undefined) return false;
    ipc.publishJson(`${RESPONSE_PREFIX}${this.name}.${this.correlationId}`, result);
    return true;
  }

  /** Ask the kernel to skip the gated operation. */
  skip(): boolean {
    return this.reply({ skip: true });
  }

  /** Supply opaque JSON data for the hook bridge's merge strategy. */
  respond(data: unknown): boolean {
    return this.reply({ data: typeof data === "string" ? data : stringifyData(data) });
  }
}

function stringifyData(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch (error) {
    throw SysError.json(`hooks.HookEvent.respond: ${(error as Error).message}`, error);
  }
}
