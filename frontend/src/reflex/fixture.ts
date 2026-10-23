import { InMemoryArtifactStore, InMemoryWorkspace, ScriptedModel, SequentialIds, SteppingClock, createStubTools } from "./adapters";
import type { ModelScript } from "./adapters";
import { CheckEvaluator } from "./evaluator";
import { ToolRegistry } from "./permission";
import { createTask } from "./admission";
import { DEFAULT_COMMAND_ALLOWLIST } from "./contracts";
import type { CreateTask, Plan, Policy, Task } from "./contracts";
import type { CommandTable, EventSink, ModelAdapter, RunResult } from "./ports";
import { ReferenceRunner } from "./runner";

/*
 * Phase 0 reference fixture ("fix-add-bug"): a one-file repository whose `add` subtracts.
 * Everything is a pure value so any run of it is reproducible.
 */

export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "src/add.ts": "export const add = (a: number, b: number): number => a - b;\n",
  "tests/add.test.ts": "// expects add(2, 3) === 5\n",
};

export const FIXED_ADD_SOURCE = "export const add = (a: number, b: number): number => a + b;\n";

/** The fixture's commands, keyed by argv. The first two are also the task's `doneWhen` checks. */
export const FIXTURE_COMMANDS: CommandTable = {
  "pnpm test": (ws) =>
    ws.read("src/add.ts")?.includes("a + b") === true
      ? { exitCode: 0, output: "1 passed" }
      : { exitCode: 1, output: "FAIL tests/add.test.ts: expected add(2, 3) to be 5" },
  "git diff --exit-code -- tests": (ws) =>
    ws.read("tests/add.test.ts") === FIXTURE_FILES["tests/add.test.ts"]
      ? { exitCode: 0, output: "" }
      : { exitCode: 1, output: "tests/ changed" },
};

export const FIXTURE_POLICY: Policy = {
  id: "policy-p0-baseline",
  name: "Phase 0 memory-off baseline",
  version: 1,
  status: "ACTIVE",
  riskClass: "low",
  toolAllowlist: ["list_files", "read_file", "search_code", "write_file", "apply_patch", "run_command", "finish"],
  commandAllowlist: DEFAULT_COMMAND_ALLOWLIST.map((entry) => [...entry]),
  routingPreferences: {},
  memoryRules: { retrievalEnabled: false, writebackEnabled: false },
  budgets: { maxSteps: 40, maxUsd: 1, maxWallMinutes: 30 }, // PRD §7.8 policy defaults
  approvalRequirements: [],
  evaluationSuiteRef: null,
  promotedBy: null,
  promotedAt: null,
};

/** The `POST /v1/tasks` body for the fixture (PRD §15.2). */
export const FIXTURE_CREATE_TASK: CreateTask = {
  projectId: "project-fixture",
  objective: "Fix add() so that it returns the sum of its arguments",
  mode: "build",
  scope: { repo: "fixture/fix-add-bug", commit: "fixture-commit-1" },
  doneWhen: {
    checks: [
      { name: "add_returns_sum", command: "pnpm test" },
      { name: "tests_unchanged", command: "git diff --exit-code -- tests" },
    ],
  },
  riskClass: "low",
  budget: { maxSteps: 10, maxUsd: 0.5, maxWallMinutes: 0.5 },
  policyId: FIXTURE_POLICY.id,
  policyVersion: FIXTURE_POLICY.version,
};

const SERVER_FIELDS = {
  id: "task-fix-add-bug",
  tenantId: "tenant-local",
  requestedBy: "fixture",
  createdAt: "2026-01-01T00:00:00.000Z",
  source: "fixture",
} as const;

function mustCreate(body: unknown): Task {
  const created = createTask(body, SERVER_FIELDS);
  if (!created.ok) throw new Error(`invalid fixture task: ${JSON.stringify(created.issues)}`);
  return created.task;
}

export const FIXTURE_TASK: Task = mustCreate(FIXTURE_CREATE_TASK);

/** The same task declared as an investigation: no `doneWhen`, no writes. */
export function investigationTask(): Task {
  const { projectId, objective, scope, riskClass, budget, policyId, policyVersion } = FIXTURE_CREATE_TASK;
  return mustCreate({ projectId, objective, scope, riskClass, budget, policyId, policyVersion, mode: "investigate" });
}

export const FIXTURE_PLAN: Plan = {
  goal: "Make add() return a + b",
  assumptions: ["src/add.ts is the only file that needs to change"],
  steps: [
    { description: "read src/add.ts", tool: "read_file" },
    { description: "write the corrected implementation", tool: "write_file" },
    { description: "run the tests", tool: "run_command" },
    { description: "finish", tool: "finish" },
  ],
  tools: ["read_file", "write_file", "run_command", "finish"],
  stopConditions: ["finish is called"],
  memoryIds: [],
  verificationCommands: ["pnpm test"],
  expectedArtifacts: ["src/add.ts"],
};

export const SOLUTION_STEPS: readonly unknown[] = [
  { tool: "read_file", args: { path: "src/add.ts" } },
  { tool: "write_file", args: { path: "src/add.ts", content: FIXED_ADD_SOURCE } },
  { tool: "run_command", args: { argv: ["pnpm", "test"] } },
  { tool: "finish", args: { summary: "fixed add", claimedOutcome: "done" } },
];

export function fixtureWorkspace(): InMemoryWorkspace {
  return new InMemoryWorkspace(`${FIXTURE_TASK.scope.repo}@${FIXTURE_TASK.scope.commit}`, FIXTURE_FILES);
}

export function fixtureRegistry(): ToolRegistry {
  return new ToolRegistry("p0-stub-tools-1", createStubTools());
}

export function fixtureEvaluator(): CheckEvaluator {
  return new CheckEvaluator(FIXTURE_COMMANDS);
}

/** The scripted model that solves the fixture. Pass different `steps` for failure variants. */
export function fixtureModel(steps: readonly unknown[] = SOLUTION_STEPS, plan: unknown = FIXTURE_PLAN): ScriptedModel {
  const script: ModelScript = { plan, steps };
  return new ScriptedModel(script);
}

export interface FixtureRunOptions {
  model?: ModelAdapter;
  task?: unknown;
  policy?: unknown;
  registry?: ToolRegistry;
  commands?: CommandTable;
  signal?: AbortSignal;
  sink?: EventSink;
}

/**
 * Runs the fixture memory-off with a fresh workspace, a stepping clock and sequential ids,
 * so identical options always produce an identical result.
 */
export function runFixture(options: FixtureRunOptions = {}): Promise<RunResult> {
  const runner = new ReferenceRunner({
    model: options.model ?? fixtureModel(),
    registry: options.registry ?? fixtureRegistry(),
    evaluator: fixtureEvaluator(),
    workspace: fixtureWorkspace(),
    commands: options.commands ?? FIXTURE_COMMANDS,
    artifacts: new InMemoryArtifactStore(),
    clock: new SteppingClock(Date.UTC(2026, 0, 1), 10),
    ids: new SequentialIds(),
    sink: options.sink,
  });
  return runner.execute({
    task: options.task ?? FIXTURE_TASK,
    policy: options.policy ?? FIXTURE_POLICY,
    signal: options.signal,
  });
}
