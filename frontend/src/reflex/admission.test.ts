import { describe, expect, it } from "vitest";
import { admitTask, createTask } from "./admission";
import { FIXTURE_CREATE_TASK, FIXTURE_POLICY, FIXTURE_TASK, fixtureRegistry } from "./fixture";

const server = { id: "t1", tenantId: "tn", requestedBy: "tester", createdAt: "2026-01-01T00:00:00.000Z", source: "live" as const };
const reasons = (r: { ok: boolean; issues?: { reason: string }[] }) => (r.ok ? [] : (r.issues ?? []).map((i) => i.reason));

describe("createTask (FR-01, PRD §15.1)", () => {
  it("adds server-derived identity to a valid body", () => {
    const result = createTask(FIXTURE_CREATE_TASK, server);
    expect(result.ok && result.task).toMatchObject({ id: "t1", tenantId: "tn", requestedBy: "tester", mode: "build" });
  });

  it.each(["tenantId", "tenant_id", "userId", "user_id", "role"])("rejects %s in the body as forbidden_field", (field) => {
    const result = createTask({ ...FIXTURE_CREATE_TASK, [field]: "x" }, server);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => [i.code, i.reason])).toEqual([["forbidden_field", field]]);
  });

  it("rejects missing completion criteria and invalid scope as validation_error", () => {
    const noChecks = createTask({ ...FIXTURE_CREATE_TASK, doneWhen: { checks: [] } }, server);
    const badScope = createTask({ ...FIXTURE_CREATE_TASK, scope: { repo: "r", commit: "c", paths: ["../etc"] } }, server);
    for (const result of [noChecks, badScope]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(new Set(result.issues.map((i) => i.code))).toEqual(new Set(["validation_error"]));
    }
  });

  it("accepts an investigation body without doneWhen and rejects one that carries it", () => {
    const { projectId, objective, scope, riskClass, budget, policyId, policyVersion } = FIXTURE_CREATE_TASK;
    const body = { projectId, objective, scope, riskClass, budget, policyId, policyVersion, mode: "investigate" };
    expect(createTask(body, server).ok).toBe(true);
    expect(createTask({ ...body, doneWhen: FIXTURE_CREATE_TASK.mode === "build" ? FIXTURE_CREATE_TASK.doneWhen : null }, server).ok).toBe(false);
  });
});

describe("admitTask (FR-01, INV-08)", () => {
  const admit = (task: unknown = FIXTURE_TASK, policy: unknown = FIXTURE_POLICY) => admitTask(task, policy, fixtureRegistry());

  it("admits the fixture", () => {
    expect(admit().ok).toBe(true);
  });

  it("rejects a policy pin mismatch, an inactive policy and a task riskier than its policy", () => {
    expect(reasons(admit({ ...FIXTURE_TASK, policyVersion: 2 }))).toContain("policy_mismatch");
    expect(reasons(admit(FIXTURE_TASK, { ...FIXTURE_POLICY, status: "DRAFT" }))).toContain("policy_not_active");
    expect(reasons(admit({ ...FIXTURE_TASK, riskClass: "high" }))).toContain("risk_exceeds_policy");
  });

  it("rejects a policy that allows an unregistered tool", () => {
    const policy = { ...FIXTURE_POLICY, toolAllowlist: [...FIXTURE_POLICY.toolAllowlist, "rm_rf"] };
    expect(reasons(admit(FIXTURE_TASK, policy))).toContain("unregistered_tool");
  });

  it("reports schema failures for the task and the policy separately", () => {
    const result = admit({ ...FIXTURE_TASK, doneWhen: { checks: [] } }, { ...FIXTURE_POLICY, version: 0 });
    expect(reasons(result)).toEqual(expect.arrayContaining(["invalid_task", "invalid_policy"]));
  });
});
