/**
 * Human-in-the-loop approval. Mirrors `astrid_sdk::approval`.
 *
 * The capsule declares the action and target resource. The kernel classifies
 * risk, checks any pre-approved allowances, and either auto-approves or
 * prompts the frontend user. The capsule sees the specific decision class
 * (one-shot / session / always / allowance-hit / denied), not just
 * approved/denied — UI can communicate WHY (e.g. "stored as always-approve")
 * for transparency.
 */

import {
  requestApproval as hostRequestApproval,
} from "astrid:approval/host@1.0.0";
import { callHost } from "./errors.js";

export type ApprovalDecision =
  | "denied"
  | "approved"
  | "approved-session"
  | "approved-always"
  | "allowance";

/**
 * Request approval for a sensitive action. Returns `true` if approved (any
 * approval variant), `false` if denied. Blocks until the user responds or
 * the request times out (60s).
 *
 * For the specific decision class, use {@link requestDecision}.
 */
export function request(action: string, resource: string): boolean {
  const decision = requestDecision(action, resource);
  return decision !== "denied";
}

/** Request approval and return the specific decision class. */
export function requestDecision(action: string, resource: string): ApprovalDecision {
  const resp = callHost(`approval.request(${JSON.stringify(action)})`, () =>
    hostRequestApproval({ action, targetResource: resource }),
  );
  return resp.decision;
}
