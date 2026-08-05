/**
 * Direct frontend messaging. Mirrors `astrid_sdk::uplink`.
 *
 * Capsules register uplinks (named endpoints) for platforms they bridge —
 * Discord, Slack, Telegram, CLI proxy — and then forward inbound user
 * messages to the kernel's processing pipeline.
 */

import {
  uplinkRegister,
  uplinkSend,
} from "astrid:uplink/host@1.0.0";
import { callHost } from "./errors.js";

export type UplinkProfile = "chat" | "interactive" | "notify" | "bridge";

declare const uplinkIdBrand: unique symbol;
/** Opaque string ID returned by {@link register}. */
export type UplinkId = string & { readonly [uplinkIdBrand]: true };

/**
 * Register an uplink. `profile` is one of `"chat"` / `"interactive"` /
 * `"notify"` / `"bridge"`. Returns the assigned opaque uplink ID.
 */
export function register(name: string, platform: string, profile: UplinkProfile): UplinkId {
  const id = callHost(`uplink.register(${JSON.stringify(name)})`, () =>
    uplinkRegister(name, platform, profile),
  );
  return id as UplinkId;
}

/**
 * Forward an inbound message through a registered uplink. Returns `true` if
 * sent, `false` if intentionally dropped (e.g. no active session for the
 * principal).
 */
export function send(uplink: UplinkId, platformUserId: string, content: string): boolean {
  return callHost(`uplink.send(${uplink})`, () =>
    uplinkSend(uplink, platformUserId, content),
  );
}
