/**
 * Virtual filesystem — shape-compatible with `node:fs/promises` where it
 * makes sense, including a `Stats`-like object with `isFile()` /
 * `isDirectory()` methods.
 *
 * Path schemes follow VFS conventions (`workspace://`, `home://`, `tmp://`).
 * The kernel re-resolves and re-validates every path on every call;
 * {@link canonicalize} is for display / equality only, NOT a security check
 * that subsequent calls can rely on.
 *
 * The Rust SDK's surface is sync (`std::fs`); we expose async (`await`) to
 * match Node idioms even though the underlying host calls are synchronous.
 * StarlingMonkey syncifies awaits at the WASM boundary.
 */

import {
  fsOpen as hostOpen,
  fsExists as hostExists,
  fsMkdir as hostMkdir,
  fsMkdirAll as hostMkdirAll,
  fsReaddir as hostReaddir,
  fsStat as hostStat,
  fsStatSymlink as hostStatSymlink,
  fsUnlink as hostUnlink,
  readFile as hostReadFile,
  writeFile as hostWriteFile,
  fsAppend as hostAppend,
  fsCopy as hostCopy,
  fsRename as hostRename,
  fsRemoveDirAll as hostRemoveDirAll,
  fsCanonicalize as hostCanonicalize,
  fsReadLink as hostReadLink,
  fsHardLink as hostHardLink,
  type FileStat,
  type FileHandle as WitFileHandle,
} from "astrid:fs/host@1.0.0";
import { SysError, callHost } from "./errors.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const FS_INTERNAL = Symbol("Astrid filesystem resource");
let createStats: (stat: FileStat) => Stats;
let createDirent: (parentPath: string, name: string, kind: FileType) => Dirent;
let createFileHandle: (inner: WitFileHandle, path: string) => FileHandle;

/** Supported `node:fs`-style open flags. */
export type OpenMode = "r" | "r+" | "w" | "a";
export type FileType =
  | "type-unknown"
  | "regular"
  | "directory"
  | "symlink"
  | "block-device"
  | "character-device"
  | "fifo"
  | "socket";

/**
 * Stat result. Shaped like Node's `fs.Stats` for the fields the Astrid VFS
 * surfaces. `size` is `bigint` (WIT `u64`); use `Number(size)` if you need a
 * regular number and you're sure it fits.
 */
export class Stats {
  readonly size: bigint;
  readonly mode: number;
  readonly kind: FileType;
  readonly mtimeMs: number | undefined;
  readonly birthtimeMs: number | undefined;
  readonly atimeMs: number | undefined;

  private constructor(token: typeof FS_INTERNAL, value: unknown) {
    if (token !== FS_INTERNAL) throw new TypeError("Stats cannot be constructed directly");
    const stat = value as FileStat;
    this.size = stat.size;
    this.mode = stat.mode;
    this.kind = stat.kind;
    this.mtimeMs = datetimeToMs(stat.modified);
    this.birthtimeMs = datetimeToMs(stat.created);
    this.atimeMs = datetimeToMs(stat.accessed);
  }

  static { createStats = (stat) => new Stats(FS_INTERNAL, stat); }

  isFile(): boolean {
    return this.kind === "regular";
  }

  isDirectory(): boolean {
    return this.kind === "directory";
  }

  isSymbolicLink(): boolean {
    return this.kind === "symlink";
  }

  isBlockDevice(): boolean { return this.kind === "block-device"; }
  isCharacterDevice(): boolean { return this.kind === "character-device"; }
  isFIFO(): boolean { return this.kind === "fifo"; }
  isSocket(): boolean { return this.kind === "socket"; }

  isEmpty(): boolean {
    return this.size === 0n;
  }
}

/** Directory entry returned by `readdir({ withFileTypes: true })`. */
export class Dirent {
  readonly name: string;
  readonly path: string;
  readonly parentPath: string;
  readonly #kind: FileType;

  private constructor(token: typeof FS_INTERNAL, parentPath: string, name: string, kind: FileType) {
    if (token !== FS_INTERNAL) throw new TypeError("Dirent cannot be constructed directly");
    this.name = name;
    this.parentPath = parentPath;
    this.path = parentPath.endsWith("/") ? parentPath + name : `${parentPath}/${name}`;
    this.#kind = kind;
  }

  static { createDirent = (parentPath, name, kind) => new Dirent(FS_INTERNAL, parentPath, name, kind); }

  isFile(): boolean { return this.#kind === "regular"; }
  isDirectory(): boolean { return this.#kind === "directory"; }
  isSymbolicLink(): boolean { return this.#kind === "symlink"; }
  isBlockDevice(): boolean { return this.#kind === "block-device"; }
  isCharacterDevice(): boolean { return this.#kind === "character-device"; }
  isFIFO(): boolean { return this.#kind === "fifo"; }
  isSocket(): boolean { return this.#kind === "socket"; }
}

/**
 * Open file handle. Returned from {@link open}. The host releases the
 * underlying file descriptor automatically when the handle is dropped via
 * `Symbol.dispose` or `.close()`. Per-capsule cap: 16 open file handles.
 *
 * ```ts
 * using f = await fs.open("workspace://data.bin", "r+");
 * await f.writeAt(0n, new TextEncoder().encode("hello"));
 * ```
 */
export class FileHandle {
  #inner: WitFileHandle | undefined;
  readonly path: string;

  private constructor(token: typeof FS_INTERNAL, value: unknown, path: string) {
    if (token !== FS_INTERNAL) throw new TypeError("FileHandle cannot be constructed directly");
    this.#inner = value as WitFileHandle;
    this.path = path;
  }

  static { createFileHandle = (inner, path) => new FileHandle(FS_INTERNAL, inner, path); }

  /** Read up to `maxBytes` from `offset`. Empty result signals EOF at that offset. */
  async readAt(offset: bigint, maxBytes: number): Promise<Uint8Array> {
    return callHost(`fs.FileHandle.readAt(${quote(this.path)})`, () =>
      this.#requireInner().readAt(offset, maxBytes),
    );
  }

  /** Write `data` at `offset`. Returns bytes actually written. */
  async writeAt(offset: bigint, data: Uint8Array): Promise<number> {
    return callHost(`fs.FileHandle.writeAt(${quote(this.path)})`, () =>
      this.#requireInner().writeAt(offset, data),
    );
  }

  /** Flush buffered data (only) to disk — `fdatasync(2)`. */
  async syncData(): Promise<void> {
    callHost(`fs.FileHandle.syncData(${quote(this.path)})`, () =>
      this.#requireInner().syncData(),
    );
  }

  /** Node-compatible alias for {@link syncData}. */
  async datasync(): Promise<void> { return this.syncData(); }

  /** Flush both data and metadata to disk — `fsync(2)`. */
  async syncAll(): Promise<void> {
    callHost(`fs.FileHandle.syncAll(${quote(this.path)})`, () =>
      this.#requireInner().syncAll(),
    );
  }

  /** Node-compatible alias for {@link syncAll}. */
  async sync(): Promise<void> { return this.syncAll(); }

  /** Race-free counterpart to {@link stat} on the path. */
  async stat(): Promise<Stats> {
    const raw = callHost(`fs.FileHandle.stat(${quote(this.path)})`, () =>
      this.#requireInner().stat(),
    );
    return createStats(raw);
  }

  /** Truncate or extend the file to `size` bytes. Extending past end fills with zeros. */
  async setLen(size: bigint): Promise<void> {
    callHost(`fs.FileHandle.setLen(${quote(this.path)})`, () =>
      this.#requireInner().setLen(size),
    );
  }

  /** Node-compatible name for resizing a file. */
  async truncate(size: number | bigint = 0): Promise<void> {
    if (typeof size === "number" && (!Number.isSafeInteger(size) || size < 0)) {
      throw SysError.api("file length must be a non-negative safe integer or bigint");
    }
    const length = typeof size === "bigint" ? size : BigInt(size);
    if (length < 0n) throw SysError.api("file length must be non-negative");
    return this.setLen(length);
  }

  close(): void {
    if (this.#inner === undefined) return;
    const inner = this.#inner;
    this.#inner = undefined;
    try {
      inner[Symbol.dispose]();
    } catch {
      // Already disposed by the runtime; safe to ignore.
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #requireInner(): WitFileHandle {
    if (this.#inner === undefined) {
      throw SysError.api(`FileHandle ${quote(this.path)} is closed`);
    }
    return this.#inner;
  }
}

export interface ReadFileOptions {
  /** When set, decode bytes as a string with this encoding. */
  encoding?: "utf8";
}

export interface ReaddirOptions {
  /** When true, yields `Dirent` objects instead of bare name strings. */
  withFileTypes?: boolean;
}

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
}

/** Open a file by path. Required capability depends on `mode`. */
export async function open(path: string, mode: OpenMode): Promise<FileHandle> {
  const inner = callHost(`fs.open(${quote(path)})`, () => hostOpen(path, hostOpenMode(mode)));
  return createFileHandle(inner, path);
}

export async function exists(path: string): Promise<boolean> {
  return callHost(`fs.exists(${quote(path)})`, () => hostExists(path));
}

export async function stat(path: string): Promise<Stats> {
  const raw = callHost(`fs.stat(${quote(path)})`, () => hostStat(path));
  return createStats(raw);
}

/** Stat without following symlinks — `lstat(2)`. */
export async function lstat(path: string): Promise<Stats> {
  const raw = callHost(`fs.lstat(${quote(path)})`, () => hostStatSymlink(path));
  return createStats(raw);
}

export async function readFile(path: string): Promise<Uint8Array>;
export async function readFile(path: string, options: { encoding: "utf8" }): Promise<string>;
export async function readFile(
  path: string,
  options?: ReadFileOptions,
): Promise<Uint8Array | string> {
  const bytes = callHost(`fs.readFile(${quote(path)})`, () => hostReadFile(path));
  if (options?.encoding === "utf8") return decoder.decode(bytes);
  return bytes;
}

/** Read a file as UTF-8 text. */
export async function readTextFile(path: string): Promise<string> {
  const bytes = callHost(`fs.readTextFile(${quote(path)})`, () => hostReadFile(path));
  try {
    return decoder.decode(bytes);
  } catch (err) {
    throw SysError.api(`fs.readTextFile(${quote(path)}): ${(err as Error).message}`, err);
  }
}

export async function writeFile(path: string, data: string | Uint8Array): Promise<void> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  callHost(`fs.writeFile(${quote(path)})`, () => hostWriteFile(path, bytes));
}

/** Append `data` to a file, creating it if absent. */
export async function appendFile(path: string, data: string | Uint8Array): Promise<void> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  callHost(`fs.appendFile(${quote(path)})`, () => hostAppend(path, bytes));
}

/**
 * Create a directory. Mirrors `std::fs::create_dir` / `mkdir(2)` — strict.
 * Fails with `already-exists` if the path exists. Use {@link mkdirAll} for
 * idempotent "ensure-exists" semantics.
 */
export async function mkdir(path: string, options?: MkdirOptions): Promise<void> {
  if (options?.recursive === true) {
    callHost(`fs.mkdir(${quote(path)}, recursive)`, () => hostMkdirAll(path));
  } else {
    callHost(`fs.mkdir(${quote(path)})`, () => hostMkdir(path));
  }
}

/** Create a directory and all missing parents. Idempotent. */
export async function mkdirAll(path: string): Promise<void> {
  callHost(`fs.mkdirAll(${quote(path)})`, () => hostMkdirAll(path));
}

/** Remove a file. Mirrors `fs.unlink` / `fs.rm` (file-only). */
export async function rm(path: string, options?: RmOptions): Promise<void> {
  if (options?.recursive === true) {
    const entry = callHost(`fs.lstat(${quote(path)})`, () => hostStatSymlink(path));
    if (entry.kind === "directory") {
      callHost(`fs.rm(${quote(path)}, recursive)`, () => hostRemoveDirAll(path));
    } else {
      callHost(`fs.rm(${quote(path)}, recursive)`, () => hostUnlink(path));
    }
  } else {
    callHost(`fs.rm(${quote(path)})`, () => hostUnlink(path));
  }
}

/** Remove a file. */
export async function unlink(path: string): Promise<void> {
  callHost(`fs.unlink(${quote(path)})`, () => hostUnlink(path));
}

/**
 * Remove a directory and all its contents recursively. Refuses to traverse
 * symlinks to prevent sandbox escapes. Returns the count of removed entries.
 */
export async function removeDirAll(path: string): Promise<bigint> {
  return callHost(`fs.removeDirAll(${quote(path)})`, () => hostRemoveDirAll(path));
}

/** Copy a file from `src` to `dst`. Overwrites `dst`. */
export async function copy(src: string, dst: string): Promise<void> {
  callHost(`fs.copy(${quote(src)} -> ${quote(dst)})`, () => hostCopy(src, dst));
}

/** Node-compatible alias for {@link copy}. */
export const copyFile = copy;

/** Rename (move) within the same VFS scheme. Cross-scheme returns `cross-vfs`. */
export async function rename(src: string, dst: string): Promise<void> {
  callHost(`fs.rename(${quote(src)} -> ${quote(dst)})`, () => hostRename(src, dst));
}

/**
 * Resolve a path to its canonical form, following symlinks. Returns a
 * VFS-scheme path, never a host real-path. NOT a TOCTOU-safe security check.
 */
export async function canonicalize(path: string): Promise<string> {
  return callHost(`fs.canonicalize(${quote(path)})`, () => hostCanonicalize(path));
}

/** Node-compatible alias for {@link canonicalize}. */
export const realpath = canonicalize;

/** Read a symlink target without following it. */
export async function readLink(path: string): Promise<string> {
  return callHost(`fs.readLink(${quote(path)})`, () => hostReadLink(path));
}

/** Node-compatible alias for {@link readLink}. */
export const readlink = readLink;

/** Create a hard link. Both endpoints must be in the same VFS scheme. */
export async function hardLink(src: string, linkPath: string): Promise<void> {
  callHost(`fs.hardLink(${quote(src)} -> ${quote(linkPath)})`, () =>
    hostHardLink(src, linkPath),
  );
}

/** Node-compatible alias for {@link hardLink}. */
export const link = hardLink;

/**
 * Read directory entries. Returns string[] by default to match
 * `fs.readdir(path)`; pass `{ withFileTypes: true }` for `Dirent[]`.
 */
export async function readdir(path: string): Promise<string[]>;
export async function readdir(
  path: string,
  options: { withFileTypes: true },
): Promise<Dirent[]>;
export async function readdir(
  path: string,
  options?: ReaddirOptions,
): Promise<string[] | Dirent[]> {
  const names = callHost(`fs.readdir(${quote(path)})`, () => hostReaddir(path));
  if (options?.withFileTypes) {
    return Promise.all(names.map(async (name) => {
      const entryPath = path.endsWith("/") ? path + name : `${path}/${name}`;
      const entry = callHost(`fs.lstat(${quote(entryPath)})`, () => hostStatSymlink(entryPath));
      return createDirent(path, name, entry.kind);
    }));
  }
  return names;
}

/**
 * Stream-style directory iteration. Mirrors `fs.opendir` / `Dir`. The VFS
 * resolves all entries in one host call, so the async-iterator is fully
 * populated up-front; the shape matches Node for compatibility.
 */
export async function opendir(path: string): Promise<AsyncIterableIterator<Dirent>> {
  const entries = await readdir(path, { withFileTypes: true });
  let i = 0;
  const iter: AsyncIterableIterator<Dirent> = {
    [Symbol.asyncIterator](): AsyncIterableIterator<Dirent> {
      return iter;
    },
    async next(): Promise<IteratorResult<Dirent>> {
      if (i >= entries.length) {
        return { value: undefined as unknown as Dirent, done: true };
      }
      return { value: entries[i++]!, done: false };
    },
    async return(): Promise<IteratorResult<Dirent>> {
      i = entries.length;
      return { value: undefined as unknown as Dirent, done: true };
    },
  };
  return iter;
}

function datetimeToMs(dt: FileStat["modified"]): number | undefined {
  if (dt === undefined) return undefined;
  return Number(dt.seconds) * 1000 + dt.nanoseconds / 1_000_000;
}

function hostOpenMode(mode: OpenMode): "read" | "read-write" | "write" | "append" {
  switch (mode) {
    case "r": return "read";
    case "r+": return "read-write";
    case "w": return "write";
    case "a": return "append";
  }
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}
