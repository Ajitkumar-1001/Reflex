import { InMemoryArtifactStore, InMemoryWorkspace, SequentialIds } from "./adapters";
import { createTask } from "./admission";
import { CheckEvaluator } from "./evaluator";
import { fixtureRegistry, FIXTURE_POLICY } from "./fixture";
import { HashingEmbedder } from "./embedder";
import { MemoryService } from "./memory-service";
import { ScriptedReflector, RuleJudge } from "./reflection";
import { ReferenceRunner } from "./runner";
import type { MemoryRuntime } from "./runner";
import { InMemoryStore } from "./store";
import type { Principal } from "./access";
import type { MemoryKind, MemoryRecord, Policy, Task } from "./contracts";
import type {
  Clock,
  CommandTable,
  MemoryJudge,
  MemoryRepository,
  ModelAdapter,
  ModelResponse,
  PlanInput,
  Reflector,
  RunResult,
  StepInput,
} from "./ports";
import { SteppingClock } from "./adapters";
import { sha256 } from "./text";

/*
 * Phase 1 fixture: a family of one-file "wrong operator" repositories (task class `operator_swap`), a stub model
 * that applies a retrieved lesson when it sees one and guesses otherwise, and the helpers the exit-gate tests use
 * to seed probe memories. The model is a test double for "a model conditioned on its context": results measured
 * with it show that retrieval, injection, gating and evaluation are wired correctly, not that a real model
 * learns (that needs DEC-10 and the DEC-11 suite).
 */

export const TENANT = "tenant-local";
export const PROJECT = "project-fixture";
export const OTHER_PROJECT = "project-other";
export const TASK_CLASS = "operator_swap";
export const LESSON_MARKER = "the intended operator follows the function name";

export type Operator = "add" | "mul" | "sub";

const OPERATORS: Record<Operator, { correct: string; guess: string; noun: string; buggy: string }> = {
  add: { correct: "a + b", guess: "a * b", noun: "sum", buggy: "a - b" },
  mul: { correct: "a * b", guess: "a - b", noun: "product", buggy: "a + b" },
  sub: { correct: "a - b", guess: "a * b", noun: "difference", buggy: "a + b" },
};

const source = (op: Operator, body: string) => `export const ${op} = (a: number, b: number): number => ${body};\n`;
const TEST_FILE = (op: Operator) => `// expects ${op}(2, 3) to equal the ${OPERATORS[op].noun}\n`;

export function arithmeticWorkspace(op: Operator): InMemoryWorkspace {
  return new InMemoryWorkspace(`fixture/arith-${op}@arith-${op}-1`, {
    [`src/${op}.ts`]: source(op, OPERATORS[op].buggy),
    [`tests/${op}.test.ts`]: TEST_FILE(op),
  });
}

export function arithmeticCommands(op: Operator): CommandTable {
  return {
    "pnpm test": (ws) =>
      ws.read(`src/${op}.ts`)?.includes(OPERATORS[op].correct) === true
        ? { exitCode: 0, output: "1 passed" }
        : { exitCode: 1, output: `FAIL tests/${op}.test.ts: ${op}(2, 3) is wrong` },
    "git diff --exit-code -- tests": (ws) =>
      ws.read(`tests/${op}.test.ts`) === TEST_FILE(op) ? { exitCode: 0, output: "" } : { exitCode: 1, output: "tests/ changed" },
  };
}

/** Policy versions: 1 = memory off (arm A), 2 = retrieval only (arm B, frozen), 3 = retrieval and writeback (train stream). */
export function labPolicy(version: 1 | 2 | 3, rules: Partial<Policy["memoryRules"]> = {}): Policy {
  return {
    ...FIXTURE_POLICY,
    id: "policy-p1-memory",
    name: `Phase 1 memory fixture v${version}`,
    version,
    memoryRules: { retrievalEnabled: version >= 2, writebackEnabled: version === 3, ...rules },
  };
}

export function arithmeticTask(
  op: Operator,
  options: { id: string; version?: 1 | 2 | 3; projectId?: string; split?: Task["split"]; taskClass?: string | null; tenantId?: string } ,
): Task {
  const { id, version = 1, projectId = PROJECT, split, tenantId = TENANT } = options;
  const taskClass = options.taskClass === undefined ? TASK_CLASS : options.taskClass;
  const created = createTask(
    {
      projectId,
      objective: `Fix ${op}() so that it returns the ${OPERATORS[op].noun} of its arguments`,
      mode: "build",
      scope: { repo: `fixture/arith-${op}`, commit: `arith-${op}-1` },
      doneWhen: {
        checks: [
          { name: "operator_correct", command: "pnpm test" },
          { name: "tests_unchanged", command: "git diff --exit-code -- tests" },
        ],
      },
      riskClass: "low",
      budget: { maxSteps: 10, maxUsd: 0.5, maxWallMinutes: 0.5 },
      policyId: "policy-p1-memory",
      policyVersion: version,
      ...(taskClass ? { taskClass } : {}),
    },
    { id, tenantId, requestedBy: "fixture", createdAt: "2026-01-01T00:00:00.000Z", source: "fixture", ...(split ? { split } : {}) },
  );
  if (!created.ok) throw new Error(`invalid lab task: ${JSON.stringify(created.issues)}`);
  return created.task;
}

// ------------------------------------------------------------------- the model

const USAGE = { inputTokens: 100, outputTokens: 20, usd: 0.001 };

/**
 * Guesses the wrong operator unless a retrieved card says the right one is determined by the function name, in
 * which case it fixes the file correctly and cites that card. It reads memory only through `PlanInput.memory`,
 * so it cannot see an arm that withholds it.
 */
export class LessonFollowingModel implements ModelAdapter {
  readonly config = { provider: "stub", model: "lesson-following", version: "1" };
  private informed = false;

  /** `alwaysSolves` makes it a model that fixes the task with or without memory. */
  constructor(
    private readonly op: Operator,
    private readonly alwaysSolves = false,
  ) {}

  async plan(input: PlanInput): Promise<ModelResponse> {
    const used = (input.memory?.cards ?? []).filter((c) => c.text.includes(LESSON_MARKER));
    this.informed = this.alwaysSolves || used.length > 0;
    return {
      output: {
        goal: `Make ${this.op}() return ${OPERATORS[this.op].correct}`,
        assumptions: [],
        steps: [{ description: "fix the operator", tool: "write_file" }],
        tools: ["read_file", "write_file", "run_command", "finish"],
        stopConditions: ["finish is called"],
        memoryIds: used.map((c) => c.memoryId),
        verificationCommands: ["pnpm test"],
        expectedArtifacts: [`src/${this.op}.ts`],
      },
      usage: USAGE,
    };
  }

  async nextStep(input: StepInput): Promise<ModelResponse> {
    const body = this.informed ? OPERATORS[this.op].correct : OPERATORS[this.op].guess;
    const steps: unknown[] = [
      { tool: "read_file", args: { path: `src/${this.op}.ts` } },
      { tool: "write_file", args: { path: `src/${this.op}.ts`, content: source(this.op, body) } },
      { tool: "run_command", args: { argv: ["pnpm", "test"] } },
      { tool: "finish", args: { summary: "fixed", claimedOutcome: "done" } },
    ];
    return { output: steps[input.step - 1] ?? steps[3], usage: USAGE };
  }
}

export const LESSON_TEXT =
  `In an ${TASK_CLASS} task, when an arithmetic helper such as add() or mul() returns the wrong value, ${LESSON_MARKER}: ` +
  "add uses +, mul uses *, sub uses -. Guessing a different operator, such as a * b inside add(), failed check operator_correct.";

/** Reflects a failed run into the operator lesson; a success into an episodic note. Evidence refs point at real trace events. */
export function lessonReflector(overrides: Partial<{ lesson: string; kind: MemoryKind; requiresReview: boolean; refs: (events: readonly { sequence: number; type: string; redactedPayload: unknown }[], runId: string, evaluationId: string) => string[] }> = {}): ScriptedReflector {
  return new ScriptedReflector((input) => {
    const failedResult = input.events.find((e) => e.type === "tool_result" && (e.redactedPayload as { ok: boolean }).ok === false);
    const refs = overrides.refs
      ? overrides.refs(input.events, input.run.id, input.evaluation.id)
      : [`evaluation:${input.evaluation.id}`, ...(failedResult ? [`event:${input.run.id}:${failedResult.sequence}`] : [])];
    return {
      outcome: input.evaluation.verdict,
      failureMode: input.evaluation.verdict === "verified_failure" ? "wrong_operator_guess" : "operator_fixed",
      evidenceRefs: refs,
      lesson: overrides.lesson ?? LESSON_TEXT,
      appliesWhen: [`task class ${TASK_CLASS}`, "an arithmetic helper returns the wrong value"],
      doesNotApplyWhen: ["the failing check already names the expected operator"],
      suggestedMemoryKind: overrides.kind ?? "procedural",
      requiresReview: overrides.requiresReview ?? false,
    };
  });
}

// ------------------------------------------------------------------------ lab

export class LabClock implements Clock {
  private inner = new SteppingClock(Date.UTC(2026, 0, 1), 10);
  private offsetMs = 0;

  now(): Date {
    return new Date(this.inner.now().getTime() + this.offsetMs);
  }

  advanceDays(days: number): void {
    this.offsetMs += days * 86_400_000;
  }
}

const principal = (id: string, role: Principal["role"], projectIds: string[] = [PROJECT], tenantId = TENANT): Principal => ({ id, role, tenantId, projectIds });
export const PRINCIPALS = {
  owner: principal("ajit", "owner"),
  runner: principal("runner-1", "runner"),
  cody: principal("cody", "cody-service"),
  viewer: principal("viewer-1", "viewer"),
  otherProjectOwner: principal("other-owner", "owner", [OTHER_PROJECT]),
} as const;

type Admitted = Extract<RunResult, { admitted: true }>;

export interface LabRun {
  op: Operator;
  task: Task;
  model?: ModelAdapter;
  /** Defaults to the policy version the task pins. */
  policy?: Policy;
  repository?: MemoryRepository;
  experiment?: { experimentId: string; trialIndex: number };
  memory?: Partial<MemoryRuntime> | false;
}

/** One shared clock, id sequence and store, so every run and memory in a scenario has a distinct, reproducible id. */
export class Lab {
  readonly store = new InMemoryStore();
  readonly clock = new LabClock();
  readonly ids = new SequentialIds();
  readonly embedder = new HashingEmbedder();
  reflector: Reflector | null = lessonReflector();
  judge: MemoryJudge | null = new RuleJudge();

  service(): MemoryService {
    return new MemoryService(this.store.memories, this.store, this.clock, this.ids);
  }

  async run(input: LabRun): Promise<Admitted> {
    const { op, task } = input;
    const policy = input.policy ?? labPolicy(task.policyVersion as 1 | 2 | 3);
    const runner = new ReferenceRunner({
      model: input.model ?? new LessonFollowingModel(op),
      registry: fixtureRegistry(),
      evaluator: new CheckEvaluator(arithmeticCommands(op)),
      workspace: arithmeticWorkspace(op),
      commands: arithmeticCommands(op),
      artifacts: new InMemoryArtifactStore(),
      clock: this.clock,
      ids: this.ids,
      sleep: async () => {},
      random: () => 0.5,
      ...(input.memory === false
        ? {}
        : {
            memory: {
              repository: input.repository ?? this.store.memories,
              records: this.store,
              embedder: this.embedder,
              reflector: this.reflector,
              judge: this.judge,
              ...input.memory,
            },
          }),
    });
    const result = await runner.execute({ task, policy, ...(input.experiment ? { experiment: input.experiment } : {}) });
    if (!result.admitted) throw new Error(`lab run not admitted: ${JSON.stringify(result.issues)}`);
    this.store.recordRun({ task, policy, run: result.run, events: result.events, evaluation: result.evaluation });
    return result;
  }

  /** Inserts a memory directly, bypassing the gate: for probes that need a record in a given state. */
  async seed(overrides: Partial<MemoryRecord> & { text: string; id: string }): Promise<MemoryRecord> {
    const now = this.clock.now().toISOString();
    const record: MemoryRecord = {
      tenantId: TENANT,
      projectId: PROJECT,
      kind: "procedural",
      embedding: await this.embedder.embed(overrides.text),
      tags: [],
      scope: { taskClass: TASK_CLASS, conditions: ["seeded"] },
      preconditions: [],
      lifecycleState: "approved",
      confidence: 0.5,
      sourceRunIds: ["run-seed"],
      evaluationIds: [],
      version: 1,
      supersedes: null,
      lastVerifiedAt: now,
      expiresAt: null,
      embeddingModel: this.embedder.model,
      embeddingVersion: this.embedder.version,
      indexVersion: "mem-index-1",
      helpfulCount: 0,
      harmfulCount: 0,
      gateDecision: null,
      derivedFromMemoryIds: [],
      contentHash: sha256(overrides.text),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      ...overrides,
    };
    await this.store.memories.insert(record);
    return record;
  }
}
