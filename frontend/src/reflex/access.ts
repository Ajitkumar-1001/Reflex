/*
 * Server-side authorization for memory operations (PRD §17.0, FR-26, FR-29). The role matrix is the v1.4
 * *proposed default* pending the owner's confirmation; tokens, hashing and transport are not built, so a
 * `Principal` here is what an authenticated request would resolve to. Every check runs in the service,
 * never in the UI.
 */

export type Role = "owner" | "runner" | "cody-service" | "viewer";

export interface Principal {
  id: string;
  role: Role;
  tenantId: string;
  projectIds: readonly string[];
}

export type Action = "read" | "feedback" | "decide" | "quarantine" | "unquarantine";

const ALLOWED: Record<Action, readonly Role[]> = {
  read: ["owner", "runner", "cody-service", "viewer"],
  feedback: ["owner", "runner", "cody-service"],
  decide: ["owner"],
  quarantine: ["owner"],
  unquarantine: ["owner"],
};

/** Error classes carry the PRD §15.1 code so a route handler can map them to a status without parsing prose. */
export class ReflexError extends Error {
  constructor(
    readonly code: "forbidden" | "not_found" | "invalid_transition" | "policy_violation" | "validation_error",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReflexError";
  }
}

/**
 * Resource scope first, then role: a resource in another tenant or project is `not_found` whatever the
 * role (no existence leak, §15.1); a role lacking the action is `forbidden`.
 */
export function authorize(principal: Principal, action: Action, resource: { tenantId: string; projectId: string }): void {
  if (principal.tenantId !== resource.tenantId || !principal.projectIds.includes(resource.projectId)) {
    throw new ReflexError("not_found", "not found");
  }
  if (!ALLOWED[action].includes(principal.role)) {
    throw new ReflexError("forbidden", `role ${principal.role} may not ${action}`);
  }
}

export function canActOn(principal: Principal, resource: { tenantId: string; projectId: string }): boolean {
  return principal.tenantId === resource.tenantId && principal.projectIds.includes(resource.projectId);
}
