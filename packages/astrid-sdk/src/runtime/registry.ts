/**
 * Module-scoped registry populated by the @capsule, @tool, @install,
 * @upgrade, @interceptor, @command, @run decorators. The bridge reads from
 * this registry to dispatch host export calls.
 *
 * Decorators run during class evaluation, which happens at module init.
 * The bridge is constructed AFTER all decorators have populated the
 * registry, so reads are safe.
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

export interface HookEntry {
  /** Semantic hook name, such as `before_tool_call`. */
  name: string;
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
  hooks: Map<string, HookEntry>;
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
    hooks: new Map(),
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
 * Decorators may run before `@capsule` if class fields appear before the
 * class itself in source. Buffer pending entries on the constructor so the
 * eventual @capsule call picks them up.
 */
const pendingByCtor = new WeakMap<CapsuleConstructor, CapsuleRegistration>();

function ensureRegistration(ctor: CapsuleConstructor): CapsuleRegistration {
  if (registration !== undefined && registration.ctor === ctor) {
    return registration;
  }
  let pending = pendingByCtor.get(ctor);
  if (pending === undefined) {
    pending = newRegistration(ctor, undefined);
    pendingByCtor.set(ctor, pending);
  }
  return pending;
}

/** Adopt any decorator entries buffered before @capsule fired. */
export function adoptPending(ctor: CapsuleConstructor): void {
  if (registration === undefined || registration.ctor !== ctor) return;
  const pending = pendingByCtor.get(ctor);
  if (pending === undefined) return;
  for (const [name, entry] of pending.tools) registration.tools.set(name, entry);
  for (const [topic, entry] of pending.interceptors) registration.interceptors.set(topic, entry);
  for (const [name, entry] of pending.hooks) registration.hooks.set(name, entry);
  for (const [name, entry] of pending.commands) registration.commands.set(name, entry);
  if (pending.installMethod !== undefined && registration.installMethod === undefined) {
    registration.installMethod = pending.installMethod;
  }
  if (pending.upgradeMethod !== undefined && registration.upgradeMethod === undefined) {
    registration.upgradeMethod = pending.upgradeMethod;
  }
  if (pending.runMethod !== undefined && registration.runMethod === undefined) {
    registration.runMethod = pending.runMethod;
  }
  if (pending.description !== undefined && registration.description === undefined) {
    registration.description = pending.description;
  }
  pendingByCtor.delete(ctor);
}

export function recordTool(ctor: CapsuleConstructor, entry: ToolEntry): void {
  const target = ensureRegistration(ctor);
  if (target.tools.has(entry.name)) {
    throw new Error(`@tool("${entry.name}") declared twice on ${ctor.name}.`);
  }
  target.tools.set(entry.name, entry);
}

export function recordInterceptor(ctor: CapsuleConstructor, entry: InterceptorEntry): void {
  const target = ensureRegistration(ctor);
  if (target.interceptors.has(entry.topic)) {
    throw new Error(`@interceptor("${entry.topic}") declared twice on ${ctor.name}.`);
  }
  target.interceptors.set(entry.topic, entry);
}

export function recordHook(ctor: CapsuleConstructor, entry: HookEntry): void {
  const target = ensureRegistration(ctor);
  if (target.hooks.has(entry.name)) {
    throw new Error(`@hook("${entry.name}") declared twice on ${ctor.name}.`);
  }
  target.hooks.set(entry.name, entry);
}

export function recordCommand(ctor: CapsuleConstructor, entry: CommandEntry): void {
  const target = ensureRegistration(ctor);
  if (target.commands.has(entry.name)) {
    throw new Error(`@command("${entry.name}") declared twice on ${ctor.name}.`);
  }
  target.commands.set(entry.name, entry);
}

export function recordInstall(ctor: CapsuleConstructor, methodName: string): void {
  const target = ensureRegistration(ctor);
  if (target.installMethod !== undefined) {
    throw new Error(`Only one @install method allowed on ${ctor.name}.`);
  }
  target.installMethod = methodName;
}

export function recordUpgrade(ctor: CapsuleConstructor, methodName: string): void {
  const target = ensureRegistration(ctor);
  if (target.upgradeMethod !== undefined) {
    throw new Error(`Only one @upgrade method allowed on ${ctor.name}.`);
  }
  target.upgradeMethod = methodName;
}

export function recordRun(ctor: CapsuleConstructor, methodName: string): void {
  const target = ensureRegistration(ctor);
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
}
