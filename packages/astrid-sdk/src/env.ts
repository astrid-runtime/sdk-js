/**
 * Capsule configuration — Astrid's equivalent of environment variables.
 * Mirrors `astrid_sdk::env`. Values are injected by the kernel at load time
 * from `Capsule.toml [env]` entries.
 *
 * Per the per-domain WIT split, `get-config` now returns `option<string>` so
 * the caller can distinguish "key not set" from "key explicitly set to empty
 * string". Like `Deno.env.get`, {@link get} returns `undefined` when absent.
 */

import { getConfig } from "astrid:sys/host@1.0.0";
import { SysError, callHost } from "./errors.js";

/** Well-known config key carrying the kernel's Unix domain socket path. */
export const CONFIG_SOCKET_PATH = "ASTRID_SOCKET_PATH";

/** Read a config value or `undefined` if not set. */
export function get(key: string): string | undefined {
  return callHost(`env.get(${JSON.stringify(key)})`, () => getConfig(key));
}

/** @deprecated Use {@link get}. */
export const tryGet = get;

/** Read a required config value or throw when it is absent. */
export function getOrThrow(key: string): string {
  const value = get(key);
  if (value === undefined) throw SysError.api(`Missing required Astrid config: ${key}`);
  return value;
}

/** Read a config value as bytes, or `undefined` if it is absent. */
export function getBytes(key: string): Uint8Array | undefined {
  const value = get(key);
  return value === undefined ? undefined : new TextEncoder().encode(value);
}
