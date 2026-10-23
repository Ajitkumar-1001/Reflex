import { describe, expect, it } from "vitest";
import { ReflexError, authorize } from "./access";
import type { Action, Principal, Role } from "./access";

const resource = { tenantId: "t", projectId: "p" };
const as = (role: Role, extra: Partial<Principal> = {}): Principal => ({ id: role, role, tenantId: "t", projectIds: ["p"], ...extra });
const code = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ReflexError ? e.code : "other";
  }
  return "ok";
};

describe("memory role matrix (PRD §17.0, FR-29), server-side", () => {
  const matrix: Record<Action, Record<Role, boolean>> = {
    read: { owner: true, runner: true, "cody-service": true, viewer: true },
    feedback: { owner: true, runner: true, "cody-service": true, viewer: false },
    decide: { owner: true, runner: false, "cody-service": false, viewer: false },
    quarantine: { owner: true, runner: false, "cody-service": false, viewer: false },
    unquarantine: { owner: true, runner: false, "cody-service": false, viewer: false },
  };

  for (const [action, roles] of Object.entries(matrix) as [Action, Record<Role, boolean>][]) {
    for (const [role, allowed] of Object.entries(roles) as [Role, boolean][]) {
      it(`${role} ${allowed ? "may" : "may not"} ${action}`, () => {
        expect(code(() => authorize(as(role), action, resource))).toBe(allowed ? "ok" : "forbidden");
      });
    }
  }

  it("returns not_found, not forbidden, for another project or tenant, whatever the role (no existence leak)", () => {
    expect(code(() => authorize(as("owner"), "read", { tenantId: "t", projectId: "other" }))).toBe("not_found");
    expect(code(() => authorize(as("viewer"), "decide", { tenantId: "t", projectId: "other" }))).toBe("not_found");
    expect(code(() => authorize(as("owner"), "read", { tenantId: "other", projectId: "p" }))).toBe("not_found");
  });
});
