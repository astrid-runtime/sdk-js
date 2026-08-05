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

export const EVENT_PREFIX = "hook.v1.event.";
export const RESPONSE_PREFIX = "hook.v1.response.";

export function eventTopic(name: string): string {
  return `${EVENT_PREFIX}${name}`;
}

export function responseTopic(name: string, correlationId: string): string {
  return `${RESPONSE_PREFIX}${name}.${correlationId}`;
}

/** A lifecycle event with its optional reply channel bound. */
export class HookEvent {
  readonly name: string;
  readonly correlationId: string | undefined;
  readonly rawPayload: string;

  constructor(request: HookEventRequest) {
    this.name = request.hook;
    this.correlationId = request.correlation_id;
    this.rawPayload = request.payload;
  }

  /** Parse the hook-specific JSON payload. */
  json<T = unknown>(): T {
    try {
      return JSON.parse(this.rawPayload) as T;
    } catch (error) {
      throw SysError.json(`hooks.HookEvent.json: ${(error as Error).message}`, error);
    }
  }

  /**
   * Publish a result on this event's scoped reply topic. Fire-and-forget
   * events have no correlation id, so replying to one is a successful no-op.
   */
  reply(result: HookResult): void {
    if (this.correlationId === undefined) return;
    ipc.publishJson(responseTopic(this.name, this.correlationId), result);
  }

  /** Ask the kernel to skip the gated operation. */
  skip(): void {
    this.reply({ skip: true });
  }

  /** Supply opaque JSON data for the hook bridge's merge strategy. */
  respond(data: string | unknown): void {
    this.reply({ data: typeof data === "string" ? data : stringifyData(data) });
  }
}

function stringifyData(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch (error) {
    throw SysError.json(`hooks.HookEvent.respond: ${(error as Error).message}`, error);
  }
}
