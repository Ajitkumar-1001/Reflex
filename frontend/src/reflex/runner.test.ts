import { describe, expect, it, vi } from "vitest";
import { ScriptedModel, createStubTools, defineTool } from "./adapters";
import { z } from "zod";
import type { RunEvent } from "./contracts";
import { auditTrace } from "./evaluator";
import {
  FIXED_ADD_SOURCE,
  FIXTURE_PLAN,
  FIXTURE_POLICY,
  FIXTURE_TASK,
  SOLUTION_STEPS,
  fixtureModel,
  investigationTask,
  runFixture,
} from "./fixture";
import { ToolRegistry } from "./permission";
import { ModelUnavailableError } from "./ports";
import type { ModelAdapter, RunResult } from "./ports";

type Admitted = Extract<RunResult, { admitted: true }>;

async function run(options: Parameters<typeof runFixture>[0] = {}): Promise<Admitted> {
  const result = await runFixture(options);
  if (!result.admitted) throw new Error(`not admitted: ${JSON.stringify(result.issues)}`);
  return result;
}

const types = (events: readonly RunEvent[]) => events.map((e) => e.type);
const finish = { tool: "finish", args: { summary: "done", claimedOutcome: "done" } };
const stateTrail = (events: readonly RunEvent[]) =>
  events.flatMap((e) => (e.type === "state_transition" ? [e.redactedPayload.to] : []));

describe("Phase 0 exit gate: deterministic fixture", () => {
  it("runs end-to-end with a complete trace and zero unauthorized tool actions", async () => {
    const { run: r, events, evaluation } = await run();

    expect(r.status).toBe("COMPLETE");
    expect(r.outcome).toBe("verified_success");
    expect(r.outcomeReason).toBe("checks_passed");
    expect(evaluation?.checks.map((c) => [c.name, c.passed])).toEqual([
      ["add_returns_sum", true],
      ["tests_unchanged", true],
    ]);

    const audit = auditTrace(events);
    expect(audit.problems).toEqual([]);
    expect(audit.complete).toBe(true);
    expect(audit.unauthorizedToolActions).toBe(0);
    expect(audit.executedToolCalls).toBe(SOLUTION_STEPS.length);
    expect(audit.deniedToolCalls).toBe(0);

    expect(stateTrail(events)).toEqual([
      "CREATED", "ADMITTED", "RETRIEVING", "PLANNING", "EXECUTING", "EVALUATING", "REFLECTING", "COMPLETE",
    ]);
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
  });

  it("is a memory-off run: no retrieval, no memory use, no writeback", async () => {
    const { run: r, events } = await run();
    expect(r.configArm).toBe("A");
    expect(r.retrievalSnapshot).toEqual({ mode: "disabled", indexVersion: null });
    expect(types(events)).toContain("retrieval_skipped");
    expect(types(events)).toContain("reflection_skipped");
    const plan = events.find((e) => e.type === "plan_recorded");
    expect(plan?.type === "plan_recorded" && plan.redactedPayload.plan.memoryIds).toEqual([]);
  });

  it("pins versions and hashes for reproducibility (INV-05)", async () => {
    const { run: r } = await run();
    expect(r.modelConfig).toEqual({ provider: "stub", model: "scripted", version: "1" });
    expect(r.toolRegistryVersion).toBe("p0-stub-tools-1");
    expect([r.policyId, r.policyVersion]).toEqual([FIXTURE_POLICY.id, FIXTURE_POLICY.version]);
    expect(r.startWorkspaceHash).not.toBe(r.endWorkspaceHash);
  });

  it("keys workspace-writing calls for idempotency and leaves reads unkeyed", async () => {
    const { events } = await run();
    const results = events.filter((e) => e.type === "tool_result");
    expect(results.filter((e) => e.idempotencyKey !== undefined).map((e) => e.type === "tool_result" && e.redactedPayload.tool)).toEqual([
      "write_file",
      "run_command",
    ]);
  });

  it("forwards every event to the sink in order", async () => {
    const seen: RunEvent[] = [];
    const { events } = await run({ sink: { append: (e) => seen.push(e) } });
    expect(seen).toEqual(events);
  });
});

describe("evaluation honesty (INV-01, INV-09)", () => {
  it("marks a wrong fix verified_failure, not success", async () => {
    const wrong = { tool: "write_file", args: { path: "src/add.ts", content: "export const add = (a: number, b: number) => a * b;\n" } };
    const { run: r, events } = await run({ model: fixtureModel([wrong, finish]) });
    expect([r.status, r.outcome, r.outcomeReason]).toEqual(["COMPLETE", "verified_failure", "checks_failed"]);
    expect(auditTrace(events).complete).toBe(true);
  });

  it("ignores a fabricated success claim when nothing was fixed", async () => {
    const { run: r } = await run({ model: fixtureModel([finish]) });
    expect(r.outcome).toBe("verified_failure");
  });

  it("is inconclusive when a done-when check cannot be resolved", async () => {
    const task = { ...FIXTURE_TASK, doneWhen: { checks: [{ name: "ghost_check", command: "ghost" }] } };
    const { run: r, evaluation } = await run({ task });
    expect([r.status, r.outcome, r.outcomeReason]).toEqual(["INCONCLUSIVE", "inconclusive", "missing_checks"]);
    expect(evaluation?.checks[0].passed).toBeNull();
  });
});

describe("tool permission enforcement (FR-06)", () => {
  function spyRegistry() {
    const execute = vi.fn();
    const postComment = defineTool({
      name: "post_comment",
      description: "post a comment",
      inputSchema: z.strictObject({ body: z.string() }),
      sideEffect: "external_write",
      idempotent: false,
      run: (args) => {
        execute(args);
        return { ok: true, summary: "posted", observation: "posted" };
      },
    });
    return { execute, registry: new ToolRegistry("test", [...createStubTools(), postComment]) };
  }

  it("denies and records prohibited calls without executing them, then continues", async () => {
    const { execute, registry } = spyRegistry();
    const prohibited = [
      { tool: "git_push", args: { remote: "origin" } },
      { tool: "post_comment", args: { body: "hi" } },
    ];
    const { run: r, events } = await run({ registry, model: fixtureModel([...prohibited, ...SOLUTION_STEPS]) });

    expect(execute).not.toHaveBeenCalled();
    const denials = events.flatMap((e) => (e.type === "policy_denied" ? [e.redactedPayload] : []));
    expect(denials.map((d) => [d.tool, d.reasonCode])).toEqual([
      ["git_push", "unregistered_tool"],
      ["post_comment", "external_write_not_permitted"],
    ]);

    const audit = auditTrace(events);
    expect(audit.deniedToolCalls).toBe(2);
    expect(audit.unauthorizedToolActions).toBe(0);
    expect(audit.complete).toBe(true);
    expect(r.outcome).toBe("verified_success");
  });

  it("blocks the run after three policy denials", async () => {
    const attempt = { tool: "git_push", args: {} };
    const { run: r, events, evaluation } = await run({ model: fixtureModel([attempt, attempt, attempt, ...SOLUTION_STEPS]) });
    expect([r.status, r.outcome, r.outcomeReason]).toEqual(["BLOCKED", "blocked", "policy_denied"]);
    expect(evaluation).toBeNull();
    expect(auditTrace(events)).toMatchObject({ complete: true, deniedToolCalls: 3, executedToolCalls: 0, unauthorizedToolActions: 0 });
  });

  it("refuses to edit protected tests, so the checks cannot be weakened", async () => {
    const tamper = { tool: "write_file", args: { path: "tests/add.test.ts", content: "// always passes\n" } };
    const { run: r, events } = await run({ model: fixtureModel([tamper, ...SOLUTION_STEPS]) });
    const denial = events.find((e) => e.type === "policy_denied");
    expect(denial?.type === "policy_denied" && denial.redactedPayload.reasonCode).toBe("protected_path");
    expect(r.outcome).toBe("verified_success");
  });

  it("denies a path traversal attempt", async () => {
    const escape = { tool: "read_file", args: { path: "../../.ssh/id_rsa" } };
    const { events } = await run({ model: fixtureModel([escape, ...SOLUTION_STEPS]) });
    const denial = events.find((e) => e.type === "policy_denied");
    expect(denial?.type === "policy_denied" && denial.redactedPayload.reasonCode).toBe("path_outside_scope");
  });

  it("blocks a plan that names an unauthorized tool before executing anything", async () => {
    const plan = { ...FIXTURE_PLAN, tools: [...FIXTURE_PLAN.tools, "git_push"] };
    const { run: r, events } = await run({ model: fixtureModel(SOLUTION_STEPS, plan) });
    expect([r.status, r.outcomeReason]).toEqual(["BLOCKED", "policy_denied"]);
    expect(types(events)).not.toContain("tool_authorized");
  });

  it("blocks a plan that cites memory while memory is disabled (INV-02)", async () => {
    const plan = { ...FIXTURE_PLAN, memoryIds: ["mem-1"] };
    const { run: r } = await run({ model: fixtureModel(SOLUTION_STEPS, plan) });
    expect([r.status, r.outcomeReason]).toEqual(["BLOCKED", "policy_denied"]);
  });
});

describe("admission (FR-01)", () => {
  it("rejects a build task with no definition of done and creates no run", async () => {
    const sink = vi.fn();
    const result = await runFixture({ task: { ...FIXTURE_TASK, doneWhen: { checks: [] } }, sink: { append: sink } });
    expect(result.admitted).toBe(false);
    if (!result.admitted) expect(result.issues[0]).toMatchObject({ code: "validation_error", reason: "invalid_task" });
    expect(sink).not.toHaveBeenCalled();
  });

  it("rejects a policy that allows an unregistered tool, or a mismatched policy pin", async () => {
    const unregistered = await runFixture({ policy: { ...FIXTURE_POLICY, toolAllowlist: [...FIXTURE_POLICY.toolAllowlist, "rm_rf"] } });
    const mismatch = await runFixture({ task: { ...FIXTURE_TASK, policyVersion: 2 } });
    const reasons = (r: RunResult) => (r.admitted ? [] : r.issues.map((i) => i.reason));
    expect(reasons(unregistered)).toContain("unregistered_tool");
    expect(reasons(mismatch)).toContain("policy_mismatch");
  });

  it("blocks a plan that needs a tool the policy does not allow", async () => {
    const policy = { ...FIXTURE_POLICY, toolAllowlist: ["read_file", "finish"] };
    const { run: r, events } = await run({ policy });
    expect([r.status, r.outcomeReason]).toEqual(["BLOCKED", "policy_denied"]);
    const denial = events.find((e) => e.type === "policy_denied");
    expect(denial?.type === "policy_denied" && denial.redactedPayload.reasonCode).toBe("tool_not_in_policy");
  });

  it("admits an investigation task but blocks a plan that writes, and does not admit a policy that is not ACTIVE", async () => {
    const { run: r, events } = await run({ task: investigationTask() });
    expect([r.status, r.outcomeReason]).toEqual(["BLOCKED", "policy_denied"]);
    const denial = events.find((e) => e.type === "policy_denied");
    expect(denial?.type === "policy_denied" && denial.redactedPayload.reasonCode).toBe("write_in_investigation_mode");
    expect((await runFixture({ policy: { ...FIXTURE_POLICY, status: "DRAFT" } })).admitted).toBe(false);
  });

  it("blocks a run whose policy enables memory, because this runner is memory-disabled", async () => {
    const policy = { ...FIXTURE_POLICY, memoryRules: { retrievalEnabled: true, writebackEnabled: false } };
    const { run: r, events } = await run({ policy });
    expect([r.status, r.outcome, r.outcomeReason]).toEqual(["BLOCKED", "blocked", "policy_denied"]);
    expect(auditTrace(events).complete).toBe(true);
  });
});

describe("failure states are explicit and legal", () => {
  it("fails with step_limit when the step budget runs out", async () => {
    const task = { ...FIXTURE_TASK, budget: { ...FIXTURE_TASK.budget, maxSteps: 2 } };
    const { run: r, events, evaluation } = await run({ task });
    expect([r.status, r.outcome, r.outcomeReason]).toEqual(["FAILED", "failed", "step_limit"]);
    expect(evaluation).toBeNull();
    expect(auditTrace(events)).toMatchObject({ complete: true, unauthorizedToolActions: 0 });
  });

  it("fails with budget_exhausted when cost exceeds the budget", async () => {
    const model = new ScriptedModel({ plan: FIXTURE_PLAN, steps: SOLUTION_STEPS }, { inputTokens: 1, outputTokens: 1, usd: 0.3 });
    const { run: r } = await run({ model });
    expect([r.status, r.outcome, r.outcomeReason]).toEqual(["FAILED", "failed", "budget_exhausted"]);
  });

  it("fails with budget_exhausted when the wall-clock budget runs out", async () => {
    const task = { ...FIXTURE_TASK, budget: { ...FIXTURE_TASK.budget, maxWallMinutes: 50 / 60_000 } };
    const { run: r } = await run({ task });
    expect([r.outcome, r.outcomeReason]).toEqual(["failed", "budget_exhausted"]);
  });

  it("re-prompts once on malformed output, then continues", async () => {
    const { run: r, events } = await run({ model: fixtureModel([{ nonsense: true }, ...SOLUTION_STEPS]) });
    expect(types(events).filter((t) => t === "model_output_invalid")).toHaveLength(1);
    expect(r.outcome).toBe("verified_success");
  });

  it("fails with malformed_model_output after two bad outputs, including smuggled reasoning (INV-04)", async () => {
    const withReasoning = { tool: "finish", args: { summary: "x", claimedOutcome: "done" }, reasoning: "private chain of thought" };
    const { run: r, events } = await run({ model: fixtureModel([withReasoning, withReasoning]) });
    expect([r.status, r.outcome, r.outcomeReason]).toEqual(["FAILED", "failed", "malformed_model_output"]);
    expect(types(events).filter((t) => t === "model_output_invalid")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("private chain of thought");
  });

  it("is inconclusive/model_unavailable when the provider is down", async () => {
    const model: ModelAdapter = {
      config: { provider: "stub", model: "down", version: "1" },
      plan: async () => {
        throw new ModelUnavailableError("503 from provider");
      },
      nextStep: async () => {
        throw new ModelUnavailableError("503 from provider");
      },
    };
    const { run: r, events } = await run({ model });
    expect([r.status, r.outcome, r.outcomeReason]).toEqual(["INCONCLUSIVE", "inconclusive", "model_unavailable"]);
    expect(auditTrace(events).complete).toBe(true);
  });

  it("maps an unexpected adapter exception to FAILED/internal_error instead of throwing", async () => {
    const model: ModelAdapter = {
      config: { provider: "stub", model: "buggy", version: "1" },
      plan: async () => {
        throw new Error("adapter bug");
      },
      nextStep: async () => ({ output: finish, usage: { inputTokens: 0, outputTokens: 0, usd: 0 } }),
    };
    const { run: r } = await run({ model });
    expect([r.status, r.outcome, r.outcomeReason]).toEqual(["FAILED", "failed", "internal_error"]);
  });

  it("cancels on abort with a truthful terminal state", async () => {
    const controller = new AbortController();
    controller.abort();
    const { run: r, events } = await run({ signal: controller.signal });
    expect([r.status, r.outcome, r.outcomeReason]).toEqual(["CANCELLED", "cancelled", "user_cancel"]);
    expect(auditTrace(events).complete).toBe(true);
  });

  it("treats a tool exception as an observation, not a harness failure", async () => {
    const boom = defineTool({
      name: "read_file",
      description: "always throws",
      inputSchema: z.strictObject({ path: z.string() }),
      sideEffect: "read_only",
      idempotent: true,
      run: () => {
        throw new Error("disk on fire");
      },
    });
    const registry = new ToolRegistry("test", [...createStubTools().filter((t) => t.descriptor.name !== "read_file"), boom]);
    const fixOnly = [SOLUTION_STEPS[0], { tool: "write_file", args: { path: "src/add.ts", content: FIXED_ADD_SOURCE } }, finish];
    const { run: r, events } = await run({ registry, model: fixtureModel(fixOnly) });
    const failed = events.find((e) => e.type === "tool_result" && !e.redactedPayload.ok);
    expect(failed).toBeDefined();
    expect(r.outcome).toBe("verified_success");
    expect(auditTrace(events).complete).toBe(true);
  });
});

describe("auditTrace catches a bad trace", () => {
  it("flags a tool result with no authorization", async () => {
    const { events } = await run();
    const stripped = events.filter((e) => e.type !== "tool_authorized");
    const audit = auditTrace(stripped.map((e, i) => ({ ...e, sequence: i + 1 })));
    expect(audit.complete).toBe(false);
    expect(audit.unauthorizedToolActions).toBeGreaterThan(0);
  });

  it("flags a truncated trace", async () => {
    const { events } = await run();
    expect(auditTrace(events.slice(0, 5)).complete).toBe(false);
  });
});
