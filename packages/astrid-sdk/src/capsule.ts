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
  adoptPending,
} from "./runtime/registry.js";

/**
 * Class decorator marking the entry-point of the capsule. The decorated
 * class must have a no-arg constructor (state defaults via field initializers).
 *
 * Exactly one `@capsule` class per compiled WASM module.
 */
export function capsule<T extends CapsuleConstructor>(
  target: T,
  _context: ClassDecoratorContext<T>,
): T {
  registerCapsule(target);
  adoptPending(target);
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
  const methodName = publicMethodName("install", context);
  context.addInitializer(function () {
    const ctor = (this as object).constructor as CapsuleConstructor;
    recordInstall(ctor, methodName);
  });
}

/**
 * Method decorator marking the upgrade lifecycle hook. The method receives
 * the previous version string and may be async.
 */
export function upgrade<This extends object>(
  _value: (this: This, prevVersion: string) => unknown,
  context: ClassMethodDecoratorContext<This, (this: This, prevVersion: string) => unknown>,
): void {
  const methodName = publicMethodName("upgrade", context);
  context.addInitializer(function () {
    const ctor = (this as object).constructor as CapsuleConstructor;
    recordUpgrade(ctor, methodName);
  });
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
  const methodName = publicMethodName("run", context);
  context.addInitializer(function () {
    const ctor = (this as object).constructor as CapsuleConstructor;
    recordRun(ctor, methodName);
  });
}

function publicMethodName(
  kind: string,
  context: { name: string | symbol; private: boolean; static: boolean },
): string {
  if (context.private || context.static || typeof context.name !== "string") {
    throw new Error(`@${kind} must be applied to a string-named public instance method.`);
  }
  return context.name;
}
