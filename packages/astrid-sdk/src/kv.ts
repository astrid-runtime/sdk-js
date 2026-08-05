/**
 * Key-value persistent storage. Mirrors `astrid_sdk::kv` semantics.
 *
 * Keys are scoped per-(principal, capsule). Each capsule sees an isolated
 * namespace. Keys are UTF-8 NFC strings (max 256 bytes); values are arbitrary
 * bytes (max 1 MiB per value). Per-(principal, capsule) cumulative quota is
 * bounded; exceeding it returns `quota` from the host.
 */

import {
  kvGet as hostGet,
  kvSet as hostSet,
  kvDelete as hostDelete,
  kvListKeys as hostListKeys,
  kvListKeysPage as hostListKeysPage,
  kvClearPrefix as hostClearPrefix,
  kvCas as hostCas,
} from "astrid:kv/host@1.0.0";
import { SysError, callHost } from "./errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface KeyPage {
  keys: string[];
  /** Pass back to {@link listKeysPage} for the next page. `undefined` on the last page. */
  nextCursor: string | undefined;
}

/** Result of reading a schema-versioned JSON value. */
export type Versioned<T> =
  | { kind: "current"; value: T }
  | { kind: "needsMigration"; value: unknown; storedVersion: number }
  | { kind: "unversioned"; value: unknown }
  | { kind: "notFound" };

export function getBytes(key: string): Uint8Array | undefined {
  return callHost(`kv.getBytes(${quote(key)})`, () => hostGet(key));
}

export function setBytes(key: string, value: Uint8Array): void {
  callHost(`kv.setBytes(${quote(key)})`, () => hostSet(key, value));
}

export function has(key: string): boolean {
  return getBytes(key) !== undefined;
}

export function get<T = unknown>(key: string): T | undefined {
  const bytes = getBytes(key);
  if (bytes === undefined || bytes.length === 0) return undefined;
  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } catch (err) {
    throw SysError.json(`kv.get(${quote(key)}): ${(err as Error).message}`, err);
  }
}

export function set<T>(key: string, value: T): void {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    throw SysError.json(`kv.set(${quote(key)}): ${(err as Error).message}`, err);
  }
  setBytes(key, encoder.encode(json));
}

/** Idempotent: deleting a non-existent key succeeds silently. */
export function del(key: string): void {
  callHost(`kv.delete(${quote(key)})`, () => hostDelete(key));
}

/** Map-compatible name for deleting a key. */
export { del as delete };

export function listKeys(prefix: string): string[] {
  return callHost(`kv.listKeys(${quote(prefix)})`, () => hostListKeys(prefix));
}

/**
 * Paginated key listing for unbounded stores. Pass `undefined` cursor on the
 * first call and the `nextCursor` from the previous page on subsequent calls.
 * `limit` is capped at 1024 per page; 0 means "use the server default".
 */
export function listKeysPage(
  prefix: string,
  cursor: string | undefined,
  limit: number = 0,
): KeyPage {
  return callHost(`kv.listKeysPage(${quote(prefix)})`, () =>
    hostListKeysPage(prefix, cursor, limit),
  );
}

export function clearPrefix(prefix: string): bigint {
  return callHost(`kv.clearPrefix(${quote(prefix)})`, () => hostClearPrefix(prefix));
}

/**
 * Atomic compare-and-swap. If the current value for `key` equals `expected`,
 * write `newValue` and return `true`. Otherwise leave the store unchanged and
 * return `false` — the routine lost-race retry path. `expected = undefined`
 * means "swap only if the key does not currently exist" (create-if-absent).
 *
 * SDK-level convenience: the underlying WIT host fn surfaces mismatch as
 * `Err(cas-mismatch)`. We catch that here and return `false` so capsule code
 * can branch on success/mismatch with a boolean. Genuine host errors (quota,
 * invalid key, etc.) still throw via `callHost`.
 *
 * Required for any concurrent coordination on shared state — the kernel runs
 * capsule invocations across a multi-threaded worker pool so naive RMW
 * patterns race.
 */
export function cas(
  key: string,
  expected: Uint8Array | undefined,
  newValue: Uint8Array,
): boolean {
  try {
    callHost(`kv.cas(${quote(key)})`, () => hostCas(key, expected, newValue));
    return true;
  } catch (err) {
    if (err instanceof SysError && err.message.includes("cas-mismatch")) {
      return false;
    }
    throw err;
  }
}

/** Store JSON in the cross-SDK `{"__sv": version, "data": value}` envelope. */
export function setVersioned<T>(key: string, value: T, version: number): void {
  assertSchemaVersion("version", version);
  set(key, { __sv: version, data: value });
}

/**
 * Read a schema-versioned value without guessing how to migrate older data.
 * Newer schemas fail closed instead of being interpreted by older code.
 */
export function getVersioned<T>(key: string, currentVersion: number): Versioned<T> {
  assertSchemaVersion("currentVersion", currentVersion);
  const bytes = getBytes(key);
  if (bytes === undefined) return { kind: "notFound" };

  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw SysError.json(`kv.getVersioned(${quote(key)}): ${(error as Error).message}`, error);
  }

  if (!isRecord(value) || !("__sv" in value)) {
    return { kind: "unversioned", value };
  }
  if (!("data" in value) || !isSchemaVersion(value.__sv)) {
    throw SysError.api(
      "malformed versioned envelope: __sv must be an unsigned 32-bit integer and data must exist",
    );
  }
  if (value.__sv > currentVersion) {
    throw SysError.api(
      `stored schema version ${value.__sv} is newer than current version ${currentVersion}; cannot safely read`,
    );
  }
  if (value.__sv < currentVersion) {
    return { kind: "needsMigration", value: value.data, storedVersion: value.__sv };
  }
  return { kind: "current", value: value.data as T };
}

/** Read versioned data, migrating and writing back older or legacy values. */
export function getVersionedOrMigrate<T>(
  key: string,
  currentVersion: number,
  migrate: (value: unknown, storedVersion: number) => T,
): T | undefined {
  const found = getVersioned<T>(key, currentVersion);
  switch (found.kind) {
    case "current":
      return found.value;
    case "notFound":
      return undefined;
    case "needsMigration": {
      const migrated = migrate(found.value, found.storedVersion);
      setVersioned(key, migrated, currentVersion);
      return migrated;
    }
    case "unversioned": {
      const migrated = migrate(found.value, 0);
      setVersioned(key, migrated, currentVersion);
      return migrated;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchemaVersion(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
}

function assertSchemaVersion(name: string, value: number): void {
  if (!isSchemaVersion(value)) {
    throw SysError.api(`${name} must be an unsigned 32-bit integer`);
  }
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}
