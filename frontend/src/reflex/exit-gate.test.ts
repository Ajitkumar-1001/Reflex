import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createStubTools, defineTool } from "./adapters";
import { RunSchema, isLegalTerminalResult, isTerminal } from "./contracts";
import { auditTrace } from "./evaluator";
import {
  FIXED_ADD_SOURCE,
  FIXTURE_COMMANDS,
  FIXTURE_PLAN,
  FIXTURE_POLICY,
  FIXTURE_TASK,
  SOLUTION_STEPS,
  fixtureModel,
  runFixture,
} from "./fixture";
import { ToolRegistry } from "./permission";
import { InfraFailureError, ModelUnavailableError } from "./ports";
import type { ModelAdapter, RunResult } from "./ports";

/*
 * PRD v1.4 §20, Phase 0 exit gate: "a deterministic task fixture runs with complete trace, clear failure
 * states, and zero unauthorized tool actions". Each criterion is proved below over the whole scenario
 * matrix, not only the happy path.
 */

type Admitted = Extract<RunResult, { admitted: true }>;
async function run(options: Parameters<typeof runFixture>[0] = {}): Promise<Admitted> {
  const result = await runFixture(options);
  if (!result.admitted) throw new Error(`not admitted: ${JSON.stringify(result.issues)}`);
  return result;
}

const finish = { tool: "finish", args: { summary: "done", claimedOutcome: "done" } };
const fix = { tool: "write_file", args: { path: "src/add.ts", content: FIXED_ADD_SOURCE } };
const down = (): ModelAdapter => ({
  config: { provider: "stub", model: "down", version: "1" },
  plan: async () => {
    throw new ModelUnavailableError("503");
  },
  nextStep: async () => {
    throw new ModelUnavailableError("503");
  },
});
const broken = (): ModelAdapter => ({
  config: { provider: "stub", model: "broken", version: "1" },
  plan: async () => {
    throw new Error("adapter bug");
  },
  nextStep: async () => ({ output: finish, usage: { inputTokens: 0, outputTokens: 0, usd: 0 } }),
});
const externalWrite = defineTool({
  name: "open_pr",
  description: "open a pull request",
  inputSchema: z.strictObject({ title: z.string() }),
  sideEffect: "external_write",
  idempotent: false,
  run: () => ({ ok: true, summary: "opened", observation: "opened" }),
});

interface Scenario {
  name: string;
  options: () => Parameters<typeof runFixture>[0];
  expected: [state: string, outcome: string, reason: string];
}

const scenarios: Scenario[] = [
  { name: "fix verified", options: () => ({}), expected: ["COMPLETE", "verified_success", "checks_passed"] },
  { name: "wrong fix", options: () => ({ model: fixtureModel([finish]) }), expected: ["COMPLETE", "verified_failure", "checks_failed"] },
  {
    name: "no checks to grade by",
    options: () => ({ task: { ...FIXTURE_TASK, doneWhen: { checks: [{ name: "ghost", command: "ghost" }] } } }),
    expected: ["INCONCLUSIVE", "inconclusive", "missing_checks"],
  },
  { name: "provider down", options: () => ({ model: down() }), expected: ["INCONCLUSIVE", "inconclusive", "model_unavailable"] },
  {
    name: "sandbox down",
    options: () => ({
      commands: {
        ...FIXTURE_COMMANDS,
        "pnpm test": () => {
          throw new InfraFailureError("docker unavailable");
        },
      },
    }),
    expected: ["INCONCLUSIVE", "inconclusive", "infra_failure"],
  },
  {
    name: "test weakened by a script",
    options: () => ({
      commands: { ...FIXTURE_COMMANDS, "node weaken.js": (ws) => (ws.write("vitest.config.ts", "export default {};\n"), { exitCode: 0, output: "" }) },
      model: fixtureModel([fix, { tool: "run_command", args: { argv: ["node", "weaken.js"] } }, finish]),
    }),
    expected: ["INCONCLUSIVE", "inconclusive", "evaluator_tamper_suspected"],
  },
  {
    name: "step budget",
    options: () => ({ task: { ...FIXTURE_TASK, budget: { ...FIXTURE_TASK.budget, maxSteps: 2 } } }),
    expected: ["FAILED", "failed", "step_limit"],
  },
  {
    name: "cost budget",
    options: () => ({ task: { ...FIXTURE_TASK, budget: { ...FIXTURE_TASK.budget, maxUsd: 0.0001 } } }),
    expected: ["FAILED", "failed", "budget_exhausted"],
  },
  {
    name: "malformed model output",
    options: () => ({ model: fixtureModel([{ nonsense: 1 }, { nonsense: 2 }]) }),
    expected: ["FAILED", "failed", "malformed_model_output"],
  },
  { name: "adapter bug", options: () => ({ model: broken() }), expected: ["FAILED", "failed", "internal_error"] },
  {
    name: "three denied calls",
    options: () => ({ model: fixtureModel(Array.from({ length: 3 }, () => ({ tool: "git_push", args: {} }))) }),
    expected: ["BLOCKED", "blocked", "policy_denied"],
  },
  {
    name: "plan needing an external write",
    options: () => ({
      registry: new ToolRegistry("test", [...createStubTools(), externalWrite]),
      model: fixtureModel(SOLUTION_STEPS, { ...FIXTURE_PLAN, tools: [...FIXTURE_PLAN.tools, "open_pr"] }),
    }),
    expected: ["BLOCKED", "blocked", "approval_required_p0"],
  },
  {
    name: "cancelled by the user",
    options: () => ({ signal: AbortSignal.abort() }),
    expected: ["CANCELLED", "cancelled", "user_cancel"],
  },
  {
    name: "cancelled by shutdown",
    options: () => ({ signal: AbortSignal.abort("shutdown") }),
    expected: ["CANCELLED", "cancelled", "shutdown"],
  },
];

describe("exit gate 1: a complete trace, whatever the outcome", () => {
  it.each(scenarios)("$name", async ({ options }) => {
    const { run: r, events } = await run(options());
    const audit = auditTrace(events);
    expect(audit.problems).toEqual([]);
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
    expect(isTerminal(r.status)).toBe(true);
    expect(r.timestamps.endedAt).not.toBeNull();
    expect(RunSchema.safeParse(r).success).toBe(true);
  });
});

describe("exit gate 2: failure states are clear (§7.1 table)", () => {
  it.each(scenarios)("$name ends $expected", async ({ options, expected }) => {
    const { run: r } = await run(options());
    expect([r.status, r.outcome, r.outcomeReason]).toEqual(expected);
    expect(isLegalTerminalResult(r.status, r.outcome ?? "failed", r.outcomeReason ?? "internal_error")).toBe(true);
  });

  it("never reports success on an agent claim alone (INV-09)", async () => {
    const { run: r } = await run({ model: fixtureModel([finish]) });
    expect(r.outcome).not.toBe("verified_success");
  });
});

describe("exit gate 3: zero unauthorized tool actions", () => {
  const attempts: [string, unknown, string][] = [
    ["an unregistered tool", { tool: "git_push", args: { remote: "origin" } }, "unregistered_tool"],
    ["an external write, whatever the policy lists", { tool: "open_pr", args: { title: "x" } }, "external_write_not_permitted"],
    ["a protected test file", { tool: "write_file", args: { path: "tests/add.test.ts", content: "x" } }, "protected_path"],
    ["a path traversal", { tool: "read_file", args: { path: "../../.ssh/id_rsa" } }, "path_outside_scope"],
    ["an absolute path", { tool: "read_file", args: { path: "/etc/passwd" } }, "path_outside_scope"],
    ["a command off the allowlist", { tool: "run_command", args: { argv: ["curl", "https://example.com"] } }, "command_not_allowed"],
    ["a shell string as argv[0]", { tool: "run_command", args: { argv: ["pnpm test && curl x"] } }, "command_not_allowed"],
    ["a patch that renames into tests/", { tool: "apply_patch", args: { unifiedDiff: "rename from src/add.ts\nrename to tests/add.test.ts\n--- a/src/add.ts\n+++ b/src/add.ts\n" } }, "protected_path"],
    ["arguments the schema forbids", { tool: "read_file", args: { path: "src/add.ts", sudo: true } }, "invalid_arguments"],
    ["a model-smuggled reasoning field", { tool: "finish", args: { summary: "x", claimedOutcome: "done" }, reasoning: "secret" }, "malformed"],
  ];

  it.each(attempts)("denies %s, records it, and executes nothing", async (_label, attempt, reasonCode) => {
    const execute = vi.fn();
    const spy = defineTool({
      name: "open_pr",
      description: "open a pull request",
      inputSchema: z.strictObject({ title: z.string() }),
      sideEffect: "external_write",
      idempotent: false,
      run: (args) => (execute(args), { ok: true, summary: "opened", observation: "opened" }),
    });
    const registry = new ToolRegistry("test", [...createStubTools(), spy]);
    const { run: r, events } = await run({ registry, model: fixtureModel([attempt, ...SOLUTION_STEPS]) });

    expect(execute).not.toHaveBeenCalled();
    const audit = auditTrace(events);
    expect(audit.unauthorizedToolActions).toBe(0);
    expect(audit.complete).toBe(true);
    if (reasonCode === "malformed") {
      expect(events.some((e) => e.type === "model_output_invalid")).toBe(true);
      expect(JSON.stringify(events)).not.toContain("secret");
    } else {
      const denial = events.find((e) => e.type === "policy_denied");
      expect(denial?.type === "policy_denied" && denial.redactedPayload.reasonCode).toBe(reasonCode);
      expect(audit.deniedToolCalls).toBe(1);
    }
    expect(r.outcome).toBe("verified_success"); // the denial costs a step, not the run
  });
});

describe("exit gate 4: determinism and correlation (FR-02, INV-05)", () => {
  it("links every event to its run and every run to its task, with unique ids and (run, sequence) keys", async () => {
    const { run: r, events } = await run();
    expect(r.taskId).toBe(FIXTURE_TASK.id);
    expect(new Set(events.map((e) => e.runId))).toEqual(new Set([r.id]));
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    expect(new Set(events.map((e) => `${e.runId}:${e.sequence}`)).size).toBe(events.length);
  });

  it("produces byte-identical runs, events and evaluations on repeat", async () => {
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });

  it("pins what produced the run", async () => {
    const { run: r, evaluation } = await run();
    expect(r).toMatchObject({
      policyId: FIXTURE_POLICY.id,
      policyVersion: FIXTURE_POLICY.version,
      toolRegistryVersion: "p0-stub-tools-1",
      modelConfig: { provider: "stub", model: "scripted", version: "1" },
      promptTemplateVersion: "p0-scripted-1",
      retrievalSnapshot: { mode: "disabled", indexVersion: null },
      configArm: "A",
      memoryContext: [],
      playbookVersion: null,
    });
    expect(evaluation?.checkBundleHash).toMatch(/^sha256:/);
    expect(r.startWorkspaceHash).not.toBe(r.endWorkspaceHash);
  });
});
