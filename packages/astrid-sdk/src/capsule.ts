/**
 * Capsule + lifecycle decorators. Mirrors `#[capsule]` / `#[astrid::install]`
 * / `#[astrid::upgrade]` from the Rust SDK.
 *
 * TypeScript standard decorators (TC39 Stage 3 / TS 5.0+). Class-method
 * decorators are the most stable subset of the spec; we deliberately use
 * only that subset to minimize churn risk.
 */

import {
  type CapsuleConstructor,
  registerCapsule,
  recordInstall,
  recordUpgrade,
  recordRun,
  defer,
  flushDeferred,
} from "./runtime/registry.js";

/**
 * Class decorator marking the entry-point of the capsule. The decorated
 * class must have a no-arg constructor (state defaults via field initializers).
 *
 * Runs last (TC39 applies the class decorator after all member decorators),
 * so by now every @tool/@install/... has deferred its registration; we flush
 * them here against the real constructor.
 *
 * Exactly one `@capsule` class per compiled WASM module.
 */
export function capsule<T extends CapsuleConstructor>(
  target: T,
  _context: ClassDecoratorContext<T>,
): T {
  registerCapsule(target);
  flushDeferred(target);
  return target;
}

/**
 * Method decorator marking the first-time install lifecycle hook. The
 * method receives no arguments and may be async. It runs once before any
 * tool dispatch.
 */
export function install<This extends object>(
  _value: (this: This) => unknown,
  context: ClassMethodDecoratorContext<This, (this: This) => unknown>,
): void {
  if (context.private || context.static) {
    throw new Error("@install must be applied to a public instance method.");
  }
  const methodName = String(context.name);
  defer((ctor) => recordInstall(ctor, methodName));
}

/**
 * Method decorator marking the upgrade lifecycle hook. The method receives
 * the previous version string and may be async.
 */
export function upgrade<This extends object>(
  _value: (this: This, prevVersion: string) => unknown,
  context: ClassMethodDecoratorContext<This, (this: This, prevVersion: string) => unknown>,
): void {
  if (context.private || context.static) {
    throw new Error("@upgrade must be applied to a public instance method.");
  }
  const methodName = String(context.name);
  defer((ctor) => recordUpgrade(ctor, methodName));
}

/**
 * Method decorator marking the long-running background loop. The method
 * receives no arguments, may be async, and is expected NEVER to return
 * (it is the capsule's daemon loop). Mirror of `#[astrid::run]`.
 *
 * Capsules that declare `@run` are "runnable" capsules: the kernel
 * spawns them as background tasks and the WIT `run` export blocks until
 * the loop exits. Capsules without `@run` are hook-driven and the `run`
 * export is a no-op.
 */
export function run<This extends object>(
  _value: (this: This) => unknown,
  context: ClassMethodDecoratorContext<This, (this: This) => unknown>,
): void {
  if (context.private || context.static) {
    throw new Error("@run must be applied to a public instance method.");
  }
  const methodName = String(context.name);
  defer((ctor) => recordRun(ctor, methodName));
}
