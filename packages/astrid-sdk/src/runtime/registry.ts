/**
 * Module-scoped registry populated by the @capsule, @tool, @install,
 * @upgrade, @interceptor, @command, @run decorators. The bridge reads from
 * this registry to dispatch host export calls.
 *
 * Registration timing matters. Method decorators run *before* the class
 * decorator (TC39 applies member decorators first, in source order, then the
 * class decorator last) and none of them can see the constructor yet. So the
 * member decorators defer their registration onto a module-scoped queue; the
 * `@capsule` class decorator — which does have the constructor — flushes that
 * queue via `flushDeferred(ctor)`. Everything therefore lands in the registry
 * synchronously at class-evaluation time, before any instance is constructed
 * and before the bridge ever reads it.
 *
 * (Earlier this was done from `context.addInitializer`, which only runs at
 * *construction* time — but the bridge reads the registry before constructing
 * anything, so every registration looked empty. See sdk-js#20.)
 */

export type CapsuleConstructor = new () => object;

export interface ToolEntry {
  /** Name exposed to the LLM / kernel — matches `tool_execute_<name>` action. */
  name: string;
  /** TS method name on the class. */
  methodName: string;
  /** If true, the bridge loads state before and saves after on success. */
  mutable: boolean;
  /** Human-readable description from decorator or TSDoc. */
  description: string | undefined;
  /** JSON Schema for the tool's input. Built-time codegen fills this in. */
  inputSchema: Record<string, unknown> | undefined;
}

export interface InterceptorEntry {
  /** Topic pattern the interceptor reacts to (also the hook action name). */
  topic: string;
  methodName: string;
  mutable: boolean;
}

export interface CommandEntry {
  /** Command name (= hook action name, registered alongside interceptors). */
  name: string;
  methodName: string;
  mutable: boolean;
}

export interface CapsuleRegistration {
  ctor: CapsuleConstructor;
  tools: Map<string, ToolEntry>;
  interceptors: Map<string, InterceptorEntry>;
  commands: Map<string, CommandEntry>;
  installMethod: string | undefined;
  upgradeMethod: string | undefined;
  runMethod: string | undefined;
  description: string | undefined;
}

let registration: CapsuleRegistration | undefined;

function newRegistration(ctor: CapsuleConstructor, description: string | undefined): CapsuleRegistration {
  return {
    ctor,
    tools: new Map(),
    interceptors: new Map(),
    commands: new Map(),
    installMethod: undefined,
    upgradeMethod: undefined,
    runMethod: undefined,
    description,
  };
}

export function registerCapsule(ctor: CapsuleConstructor, description?: string): void {
  if (registration !== undefined && registration.ctor !== ctor) {
    throw new Error(
      `Only one @capsule class may be registered per WASM module. ` +
        `Already have ${registration.ctor.name}; refusing to register ${ctor.name}.`,
    );
  }
  if (registration === undefined) {
    registration = newRegistration(ctor, description);
  } else if (description !== undefined && registration.description === undefined) {
    registration.description = description;
  }
}

/**
 * Member decorators (@tool/@interceptor/@command/@install/@upgrade/@run) run
 * before the class exists, so they cannot name the constructor. Each defers a
 * closure here; `@capsule` runs last and flushes them with the real ctor.
 */
type DeferredRecord = (ctor: CapsuleConstructor) => void;
let deferred: DeferredRecord[] = [];

export function defer(record: DeferredRecord): void {
  deferred.push(record);
}

/** Apply every deferred member registration against the now-known ctor. */
export function flushDeferred(ctor: CapsuleConstructor): void {
  const pending = deferred;
  deferred = [];
  for (const record of pending) record(ctor);
}

function requireRegistration(ctor: CapsuleConstructor): CapsuleRegistration {
  if (registration === undefined || registration.ctor !== ctor) {
    throw new Error(
      `Internal: @capsule must register ${ctor.name} before recording its members.`,
    );
  }
  return registration;
}

export function recordTool(ctor: CapsuleConstructor, entry: ToolEntry): void {
  const target = requireRegistration(ctor);
  if (target.tools.has(entry.name)) {
    throw new Error(`@tool("${entry.name}") declared twice on ${ctor.name}.`);
  }
  target.tools.set(entry.name, entry);
}

export function recordInterceptor(ctor: CapsuleConstructor, entry: InterceptorEntry): void {
  const target = requireRegistration(ctor);
  if (target.interceptors.has(entry.topic)) {
    throw new Error(`@interceptor("${entry.topic}") declared twice on ${ctor.name}.`);
  }
  target.interceptors.set(entry.topic, entry);
}

export function recordCommand(ctor: CapsuleConstructor, entry: CommandEntry): void {
  const target = requireRegistration(ctor);
  if (target.commands.has(entry.name)) {
    throw new Error(`@command("${entry.name}") declared twice on ${ctor.name}.`);
  }
  target.commands.set(entry.name, entry);
}

export function recordInstall(ctor: CapsuleConstructor, methodName: string): void {
  const target = requireRegistration(ctor);
  if (target.installMethod !== undefined) {
    throw new Error(`Only one @install method allowed on ${ctor.name}.`);
  }
  target.installMethod = methodName;
}

export function recordUpgrade(ctor: CapsuleConstructor, methodName: string): void {
  const target = requireRegistration(ctor);
  if (target.upgradeMethod !== undefined) {
    throw new Error(`Only one @upgrade method allowed on ${ctor.name}.`);
  }
  target.upgradeMethod = methodName;
}

export function recordRun(ctor: CapsuleConstructor, methodName: string): void {
  const target = requireRegistration(ctor);
  if (target.runMethod !== undefined) {
    throw new Error(`Only one @run method allowed on ${ctor.name}.`);
  }
  target.runMethod = methodName;
}

/** Returns the registered capsule, or undefined if none has been declared. */
export function getRegistration(): CapsuleRegistration | undefined {
  return registration;
}

/** Test-only: reset the registry to a clean state. */
export function __resetRegistry(): void {
  registration = undefined;
  deferred = [];
}
