/**
 * `@tool`, `@interceptor`, `@hook`, `@command` method decorators — mirror
 * `#[astrid::tool]`, `#[astrid::interceptor]`, `#[astrid::hook]`, `#[astrid::command]` from the
 * Rust SDK.
 *
 * Unlike Rust, JS has no `&mut self` signal at decoration time, so
 * mutability is opt-in via the options bag. Without `mutable: true`, the
 * bridge will not load or save `__state` around the call.
 */

import {
  type CapsuleConstructor,
  recordTool,
  recordInterceptor,
  recordHook,
  recordCommand,
} from "./runtime/registry.js";
import type { HookEvent, HookResult } from "./hooks.js";

export interface ToolOptions {
  /** If true, the bridge auto-loads + auto-persists capsule state via KV `__state`. */
  mutable?: boolean;
  /** Human-readable tool description. If omitted, build-time codegen extracts from TSDoc. */
  description?: string;
  /** Pre-computed JSON Schema. If omitted, build-time codegen derives from TS types. */
  inputSchema?: Record<string, unknown>;
}

export interface InterceptorOptions {
  /** Mirror @tool: opt-in state load/save for handlers that mutate `this`. */
  mutable?: boolean;
}

export interface HookOptions {
  /** Opt in to loading and persisting capsule state around the handler. */
  mutable?: boolean;
}

export interface CommandOptions {
  mutable?: boolean;
}

/**
 * Declares a method as an Astrid tool. The decorator records the tool in
 * the registry; the bridge dispatches `tool_execute_<name>` hook actions
 * to it.
 */
export function tool(name: string, options: ToolOptions = {}) {
  requireName("tool", name);

  return function <This extends object, Args, Result>(
    _value: (this: This, args: Args) => Result | Promise<Result>,
    context: ClassMethodDecoratorContext<This, (this: This, args: Args) => Result | Promise<Result>>,
  ): void {
    const methodName = publicMethodName("tool", name, context);
    context.addInitializer(function () {
      const ctor = (this as object).constructor as CapsuleConstructor;
      recordTool(ctor, {
        name,
        methodName,
        mutable: options.mutable === true,
        description: options.description,
        inputSchema: options.inputSchema,
      });
    });
  };
}

/**
 * Declares a method as an interceptor on a specific IPC topic. The bridge
 * routes hook-trigger actions named exactly `<topic>` to this method.
 *
 * Topic patterns follow IPC subscription rules (exact match or
 * trailing-suffix wildcard). The kernel pre-registers the subscription
 * when the capsule has both `@run` and `@interceptor` — for purely
 * hook-driven (non-runnable) capsules the kernel dispatches directly.
 */
export function interceptor(topic: string, options: InterceptorOptions = {}) {
  requireName("interceptor", topic);

  return function <This extends object, Payload, Result>(
    _value: (this: This, payload: Payload) => Result | Promise<Result>,
    context: ClassMethodDecoratorContext<This, (this: This, payload: Payload) => Result | Promise<Result>>,
  ): void {
    const methodName = publicMethodName("interceptor", topic, context);
    context.addInitializer(function () {
      const ctor = (this as object).constructor as CapsuleConstructor;
      recordInterceptor(ctor, {
        topic,
        methodName,
        mutable: options.mutable === true,
      });
    });
  };
}

/**
 * Declares a semantic lifecycle-hook handler.
 *
 * The handler receives a typed {@link HookEvent}. Returning a HookResult
 * publishes it automatically; returning `undefined` observes without
 * replying. Malformed events and handler failures are logged and fail open.
 */
export function hook(name: string, options: HookOptions = {}) {
  requireName("hook", name);

  return function <This extends object>(
    _value: (
      this: This,
      event: HookEvent,
    ) => HookResult | undefined | Promise<HookResult | undefined>,
    context: ClassMethodDecoratorContext<
      This,
      (this: This, event: HookEvent) => HookResult | undefined | Promise<HookResult | undefined>
    >,
  ): void {
    const methodName = publicMethodName("hook", name, context);
    context.addInitializer(function () {
      const ctor = (this as object).constructor as CapsuleConstructor;
      recordHook(ctor, {
        name,
        methodName,
        mutable: options.mutable === true,
      });
    });
  };
}

/**
 * Declares a method as an RPC-style command. Commands and interceptors
 * share the same dispatch table on the kernel side — the only difference
 * is intent (commands are invoked directly by name, interceptors fire on
 * topic matches).
 */
export function command(name: string, options: CommandOptions = {}) {
  requireName("command", name);

  return function <This extends object, Payload, Result>(
    _value: (this: This, payload: Payload) => Result | Promise<Result>,
    context: ClassMethodDecoratorContext<This, (this: This, payload: Payload) => Result | Promise<Result>>,
  ): void {
    const methodName = publicMethodName("command", name, context);
    context.addInitializer(function () {
      const ctor = (this as object).constructor as CapsuleConstructor;
      recordCommand(ctor, {
        name,
        methodName,
        mutable: options.mutable === true,
      });
    });
  };
}

function requireName(kind: string, name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`@${kind} requires a non-empty name (got ${JSON.stringify(name)})`);
  }
}

function publicMethodName(
  kind: string,
  name: string,
  context: { name: string | symbol; private: boolean; static: boolean },
): string {
  if (context.private || context.static || typeof context.name !== "string") {
    throw new Error(`@${kind}("${name}") must be applied to a string-named public instance method.`);
  }
  return context.name;
}
