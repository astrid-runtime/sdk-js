/**
 * Wall-clock and monotonic time — mirrors `astrid_sdk::time`.
 *
 * The WASM guest has no direct access to the system clock; all time comes
 * through the `sys` host package. {@link now} / {@link nowMs} return wall
 * clock (subject to NTP adjustments); {@link monotonicNs} returns a host
 * monotonic reading suitable for measuring elapsed time within a single
 * capsule lifetime.
 */

import { clockMs, clockMonotonicNs, sleepNs as hostSleepNs } from "astrid:sys/host@1.0.0";
import { callHost } from "./errors.js";

/** Current wall-clock time as a JS `Date`. */
export function now(): Date {
  const ms = callHost("time.now", () => clockMs());
  return new Date(Number(ms));
}

/** Current wall-clock time as a bigint of milliseconds since UNIX epoch. */
export function nowMs(): bigint {
  return callHost("time.nowMs", () => clockMs());
}

/**
 * Current monotonic clock reading in nanoseconds. Suitable for measuring
 * elapsed time; the absolute value is meaningless across processes or capsule
 * reloads — only differences are.
 */
export function monotonicNs(): bigint {
  return callHost("time.monotonicNs", () => clockMonotonicNs());
}

/**
 * Block the calling task for the given duration in milliseconds.
 *
 * Capped at 60_000 ms (60 s) per call by the host. Throws `cancelled` if
 * the capsule unloads mid-sleep.
 */
export function sleepMs(ms: number): void {
  const ns = BigInt(Math.max(0, Math.floor(ms))) * 1_000_000n;
  callHost(`time.sleepMs(${ms})`, () => hostSleepNs(ns));
}

/** Promise-shaped sleep for ordinary JavaScript control flow. */
export async function sleep(ms: number): Promise<void> {
  sleepMs(ms);
}

/** Block for `ns` nanoseconds. See {@link sleepMs} for the practical wrapper. */
export function sleepNs(ns: bigint): void {
  callHost(`time.sleepNs(${ns})`, () => hostSleepNs(ns));
}
