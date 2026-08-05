/**
 * Bridge runtime — implements the four WIT guest exports
 * (`astrid-hook-trigger`, `run`, `astrid-install`, `astrid-upgrade`) on top
 * of the registry the decorators populated.
 *
 * The Rust SDK's `#[capsule]` macro generates this same logic at compile
 * time. We do it at runtime: walk the registry, dispatch the action,
 * load/save state for mutable handlers, publish results to IPC, and
 * produce the `capsule-result` the kernel expects.
 *
 * Dispatch table mirrors `sdk-rust/astrid-sdk-macros/src/lib.rs:600–660`:
 *   - `tool_describe`: aggregate schemas + descriptions, return as `data`.
 *     Built lazily on first invocation, cached thereafter.
 *   - `tool_execute_<name>`: parse `ToolExecuteRequest`, optionally load
 *     state, run handler, publish result to `tool.v1.execute.<name>.result`,
 *     optionally save state, return `{ action: "continue", data: undefined }`.
 *   - any other action: check the interceptors map THEN the commands map.
 *     Their results flow back via `capsule-result.data` directly (no IPC
 *     publish), matching the Rust macro's behaviour for these paths.
 *
 * State key matches Rust: `__state`, JSON-encoded.
 */

import {
  getRegistration,
  type CapsuleRegistration,
  type ToolEntry,
  type InterceptorEntry,
  type HookEntry,
  type CommandEntry,
} from "./registry.js";
import * as kv from "../kv.js";
import * as ipc from "../ipc.js";
import * as log from "../log.js";
import { HookEvent, type HookEventRequest, type HookResult } from "../hooks.js";
import { getConfig } from "astrid:sys/host@1.0.0";

const STATE_KEY = "__state";

export interface CapsuleResult {
  action: string;
  data: string | undefined;
}

export interface Bridge {
  astridHookTrigger(action: string, payload: Uint8Array): CapsuleResult;
  run(): void;
  astridInstall(): void;
  astridUpgrade(): void;
}

interface ToolExecuteRequest {
  call_id: string;
  tool_name: string;
  arguments: unknown;
}

const decoder = new TextDecoder();

function denied(reason: string): CapsuleResult {
  return { action: "deny", data: reason };
}

function cont(data?: string): CapsuleResult {
  return { action: "continue", data };
}

export function createBridge(): Bridge {
  let toolDescribeCache: string | undefined;

  function reg(): CapsuleRegistration {
    const r = getRegistration();
    if (r === undefined) {
      throw new Error(
        "No @capsule class registered. The build pipeline emits the entry " +
          "module after the user's source so decorators have already fired — " +
          "this means the user code never imported the SDK or never declared " +
          "a @capsule class.",
      );
    }
    return r;
  }

  function buildToolDescribe(): string {
    const r = reg();
    const tools = Array.from(r.tools.values()).map(toolToDescribeEntry);
    return JSON.stringify({
      tools,
      description: r.description ?? "",
    });
  }

  function loadInstance(r: CapsuleRegistration): object {
    const instance = new r.ctor();
    const persisted = kv.get<Record<string, unknown>>(STATE_KEY);
    if (persisted !== undefined && typeof persisted === "object" && persisted !== null) {
      Object.assign(instance, persisted);
    }
    return instance;
  }

  function persistInstance(instance: object): void {
    const snapshot: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(instance)) {
      snapshot[key] = value;
    }
    kv.set(STATE_KEY, snapshot);
  }

  function getInstance(entry: { mutable: boolean }): { instance: object; persist: boolean } {
    const r = reg();
    if (entry.mutable) {
      return { instance: loadInstance(r), persist: true };
    }
    return { instance: new r.ctor(), persist: false };
  }

  function executeTool(entry: ToolEntry, payload: Uint8Array): CapsuleResult {
    let req: ToolExecuteRequest;
    try {
      req = JSON.parse(decoder.decode(payload)) as ToolExecuteRequest;
    } catch (e) {
      return denied(`failed to parse tool execute payload: ${(e as Error).message}`);
    }
    const callId = req.call_id ?? "";

    let instance: object;
    let persist: boolean;
    try {
      ({ instance, persist } = getInstance(entry));
    } catch (e) {
      publishToolError(entry.name, callId, `failed to load state: ${(e as Error).message}`);
      return cont();
    }

    let resultPayload: { content: string; isError: boolean };
    try {
      const raw = invoke(instance, entry.methodName, req.arguments);
      resultPayload = { content: stringifyResult(raw), isError: false };
    } catch (e) {
      resultPayload = { content: (e as Error).message ?? String(e), isError: true };
    }

    if (persist && !resultPayload.isError) {
      try {
        persistInstance(instance);
      } catch (e) {
        publishToolError(entry.name, callId, `failed to save state: ${(e as Error).message}`);
        return cont();
      }
    }

    publishToolResult(entry.name, callId, resultPayload.content, resultPayload.isError);
    return cont();
  }

  /**
   * Dispatch interceptor / command actions. Both kinds share the same
   * return path: the handler's JSON-serialized result becomes
   * `capsule-result.data`, the kernel reads it from the hook-trigger
   * return value. `null` results yield `{ action: "continue", data: undefined }`
   * so the interceptor chain keeps the original payload (mirrors Rust).
   */
  function executeHookHandler(
    entry: InterceptorEntry | CommandEntry,
    payload: Uint8Array,
  ): CapsuleResult {
    let parsed: unknown = undefined;
    if (payload.length > 0) {
      try {
        parsed = JSON.parse(decoder.decode(payload));
      } catch (e) {
        return denied(`failed to parse payload: ${(e as Error).message}`);
      }
    }

    let instance: object;
    let persist: boolean;
    try {
      ({ instance, persist } = getInstance(entry));
    } catch (e) {
      return denied(`failed to load state: ${(e as Error).message}`);
    }

    let resultJson: string;
    try {
      const raw = invoke(instance, entry.methodName, parsed);
      resultJson = stringifyResult(raw);
    } catch (e) {
      return denied((e as Error).message ?? String(e));
    }

    if (persist) {
      try {
        persistInstance(instance);
      } catch (e) {
        return denied(`failed to save state: ${(e as Error).message}`);
      }
    }

    if (resultJson === "null") return cont();
    return cont(resultJson);
  }

  /** Semantic lifecycle hooks are always fail-open. */
  function executeLifecycleHook(entry: HookEntry, payload: Uint8Array): CapsuleResult {
    let request: HookEventRequest;
    try {
      request = JSON.parse(decoder.decode(payload)) as HookEventRequest;
      if (
        typeof request.hook !== "string" ||
        request.hook !== entry.name ||
        typeof request.payload !== "string" ||
        (request.correlation_id !== undefined && typeof request.correlation_id !== "string")
      ) {
        throw new Error(
          `expected { hook: ${JSON.stringify(entry.name)}, payload, correlation_id? }`,
        );
      }
    } catch (error) {
      log.warn(`hook '${entry.name}': malformed event: ${(error as Error).message}`);
      return cont();
    }

    let instance: object;
    let persist: boolean;
    try {
      ({ instance, persist } = getInstance(entry));
    } catch (error) {
      log.warn(`hook '${entry.name}': failed to load state: ${(error as Error).message}`);
      return cont();
    }

    const event = new HookEvent(request);
    try {
      const result = invoke(instance, entry.methodName, event) as HookResult | undefined;
      if (result !== undefined) event.reply(result);
    } catch (error) {
      log.warn(`hook '${entry.name}': handler or reply failed: ${(error as Error).message}`);
    }

    if (persist) {
      try {
        persistInstance(instance);
      } catch (error) {
        log.warn(`hook '${entry.name}': failed to save state: ${(error as Error).message}`);
      }
    }
    return cont();
  }

  return {
    astridHookTrigger(action: string, payload: Uint8Array): CapsuleResult {
      try {
        if (action === "tool_describe") {
          toolDescribeCache ??= buildToolDescribe();
          return cont(toolDescribeCache);
        }

        if (action.startsWith("tool_execute_")) {
          const name = action.slice("tool_execute_".length);
          const r = reg();
          const entry = r.tools.get(name);
          if (entry === undefined) return denied(`unknown tool: ${name}`);
          return executeTool(entry, payload);
        }

        const r = reg();
        const hook = r.hooks.get(action);
        if (hook !== undefined) {
          return executeLifecycleHook(hook, payload);
        }
        const interceptor = r.interceptors.get(action);
        if (interceptor !== undefined) {
          return executeHookHandler(interceptor, payload);
        }
        const command = r.commands.get(action);
        if (command !== undefined) {
          return executeHookHandler(command, payload);
        }

        return denied(`unknown hook action: ${action}`);
      } catch (e) {
        return denied(`bridge panic in astridHookTrigger: ${(e as Error).message ?? String(e)}`);
      }
    },

    run(): void {
      try {
        const r = reg();
        if (r.runMethod === undefined) {
          // Non-runnable capsule: WIT requires the export, but it must
          // return immediately so the kernel doesn't think we're a daemon.
          return;
        }
        // Runnable capsule. Per Rust macro semantics, run() loads state but
        // does NOT auto-persist (loops are infinite; explicit kv.set is
        // the user's responsibility for runnable state).
        const instance = loadInstance(r);
        const raw = invoke(instance, r.runMethod, undefined);
        // For a daemon-style loop, the handler should never resolve. If it
        // does (or throws), surface via log and return.
        if (raw instanceof Promise) {
          syncWait(raw);
        }
      } catch (e) {
        log.error(`run loop exited with error: ${(e as Error).message ?? String(e)}`);
      }
    },

    astridInstall(): void {
      try {
        const r = reg();
        if (r.installMethod === undefined) return;
        const instance = new r.ctor();
        invoke(instance, r.installMethod, undefined);
        persistInstance(instance);
      } catch (e) {
        log.error(`install hook failed: ${(e as Error).message ?? String(e)}`);
      }
    },

    astridUpgrade(): void {
      try {
        const r = reg();
        if (r.upgradeMethod === undefined) return;
        const prevVersion = safeGetConfig("prev_version");
        const instance = loadInstance(r);
        invoke(instance, r.upgradeMethod, prevVersion);
        persistInstance(instance);
      } catch (e) {
        log.error(`upgrade hook failed: ${(e as Error).message ?? String(e)}`);
      }
    },
  };
}

/**
 * Call a registered method on an instance. The bridge always passes
 * either zero or one argument; method signatures with more parameters
 * are rejected at decorator time.
 */
function invoke(instance: object, methodName: string, arg: unknown): unknown {
  const method = (instance as Record<string, unknown>)[methodName];
  if (typeof method !== "function") {
    throw new Error(`method ${methodName} not found on capsule instance`);
  }
  const raw = arg === undefined
    ? (method as Function).call(instance)
    : (method as Function).call(instance, arg);
  return raw instanceof Promise ? syncWait(raw) : raw;
}

function toolToDescribeEntry(entry: ToolEntry): Record<string, unknown> {
  const schema =
    entry.inputSchema ?? ({ type: "object", properties: {} } as Record<string, unknown>);
  // Mirror schemars: `mutable` is a schema extension, not a top-level field.
  const inputSchema: Record<string, unknown> = { ...schema, mutable: entry.mutable };
  return {
    name: entry.name,
    description: entry.description ?? "",
    input_schema: inputSchema,
  };
}

function publishToolResult(name: string, callId: string, content: string, isError: boolean): void {
  const topic = `tool.v1.execute.${name}.result`;
  ipc.publishJson(topic, {
    type: "tool_execute_result",
    call_id: callId,
    result: { call_id: callId, content, is_error: isError },
  });
}

function publishToolError(name: string, callId: string, message: string): void {
  publishToolResult(name, callId, message, true);
}

function stringifyResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "null";
  try {
    return JSON.stringify(value);
  } catch (e) {
    throw new Error(`failed to serialize tool result: ${(e as Error).message}`);
  }
}

function safeGetConfig(key: string): string {
  try {
    return getConfig(key) ?? "";
  } catch {
    return "";
  }
}

/**
 * StarlingMonkey runs the JS event loop to settle promises returned from
 * exported functions before returning to the host. Sync handlers
 * pass-through; async handlers whose promise hasn't resolved by the
 * engine's microtask drain are surfaced as a clear error.
 */
function syncWait<T>(promise: Promise<T>): T {
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  promise.then(
    (v) => {
      settled = true;
      value = v;
    },
    (e) => {
      settled = true;
      error = e;
    },
  );
  if (!settled) {
    throw new Error(
      "Handler returned a Promise that did not settle synchronously. " +
        "ComponentizeJS syncifies awaits backed by host imports it knows " +
        "how to drive — pure setTimeout/setInterval will hang. Use only " +
        "Astrid SDK calls inside handlers, or make the handler sync.",
    );
  }
  if (error !== undefined) throw error;
  return value as T;
}
