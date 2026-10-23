import { describe, expect, it } from "vitest";
import {
  CreateTaskSchema,
  EventSchema,
  JudgeVerdictSchema,
  LifecycleState,
  MEMORY_TRANSITIONS,
  MemoryCandidateSchema,
  MemoryKind,
  MemoryRecordSchema,
  ReflectionSchema,
  RunSchema,
  RunState,
  TERMINAL_RESULTS,
  TERMINAL_STATES,
  TRANSITIONS,
  TaskSchema,
  ToolCallRequest,
  assertTransition,
  canTransition,
  canTransitionMemory,
  isLegalTerminalResult,
  isTerminal,
} from "./contracts";

const budget = { maxSteps: 5, maxUsd: 1, maxWallMinutes: 1 };
const ts = "2026-01-01T00:00:00.000Z";

const task = {
  id: "t1",
  tenantId: "tn",
  projectId: "p",
  objective: "fix bug",
  mode: "build",
  scope: { repo: "org/repo", commit: "abc123", paths: ["src"], protectedPaths: [] },
  doneWhen: { checks: [{ name: "c1", command: "pnpm test" }] },
  riskClass: "low",
  budget,
  policyId: "pol",
  policyVersion: 1,
  requestedBy: "tester",
  createdAt: ts,
  source: "live",
};

const run = {
  id: "r1",
  taskId: "t1",
  status: "EXECUTING",
  policyId: "pol",
  policyVersion: 1,
  modelConfig: { provider: "stub", model: "scripted", version: "1" },
  promptTemplateVersion: "p0",
  toolRegistryVersion: "v1",
  retrievalSnapshot: { mode: "disabled", indexVersion: null },
  configArm: "A",
  workspaceRef: "ws",
  startWorkspaceHash: "abc",
  endWorkspaceHash: null,
  budget,
  ledger: { steps: 0, usd: 0, wallMs: 0 },
  timestamps: { createdAt: ts, updatedAt: ts, endedAt: null },
  outcome: null,
  outcomeReason: null,
};

describe("task contract (FR-01, PRD §15.2)", () => {
  const { objective, projectId, scope, riskClass, budget, policyId, policyVersion, id, tenantId, requestedBy, createdAt, source } = task;
  const investigate = { mode: "investigate", objective, projectId, scope, riskClass, budget, policyId, policyVersion, id, tenantId, requestedBy, createdAt, source };

  it("accepts a well-formed build task", () => {
    expect(TaskSchema.safeParse(task).success).toBe(true);
  });

  it("rejects a build task with no checks or no doneWhen", () => {
    expect(TaskSchema.safeParse({ ...task, doneWhen: { checks: [] } }).success).toBe(false);
    expect(TaskSchema.safeParse(investigate).success).toBe(true);
    expect(TaskSchema.safeParse({ ...investigate, mode: "build" }).success).toBe(false);
  });

  it("allows an investigation task only without doneWhen (doneWhen?: never)", () => {
    expect(TaskSchema.safeParse({ ...task, mode: "investigate" }).success).toBe(false);
  });

  it("rejects malformed scope paths, unknown fields and an unknown risk class", () => {
    for (const paths of [[], ["../x"], ["/abs"]]) {
      expect(TaskSchema.safeParse({ ...task, scope: { ...task.scope, paths } }).success).toBe(false);
    }
    expect(TaskSchema.safeParse({ ...task, surprise: true }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...task, riskClass: "critical" }).success).toBe(false);
  });

  it("treats absent scope.paths as the whole worktree", () => {
    const scope = { repo: task.scope.repo, commit: task.scope.commit };
    expect(TaskSchema.safeParse({ ...task, scope }).success).toBe(true);
  });

  it("keeps identity out of the create body", () => {
    const { projectId, objective, scope, doneWhen, riskClass, budget, policyId, policyVersion } = task;
    const body = { mode: "build", projectId, objective, scope, doneWhen, riskClass, budget, policyId, policyVersion };
    expect(CreateTaskSchema.safeParse(body).success).toBe(true);
    expect(CreateTaskSchema.safeParse({ ...body, tenantId: "tn" }).success).toBe(false);
  });
});

describe("state machine contract", () => {
  it("allows the v1.0 main path", () => {
    const path = ["CREATED", "ADMITTED", "RETRIEVING", "PLANNING", "EXECUTING", "EVALUATING", "REFLECTING", "COMPLETE"] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i])).toBe(true);
  });

  it("throws on an illegal transition and never leaves a terminal state", () => {
    expect(() => assertTransition("CREATED", "EXECUTING")).toThrow(/illegal run transition/);
    for (const s of TERMINAL_STATES) expect(TRANSITIONS[s]).toEqual([]);
  });

  it("lets every non-terminal state be cancelled or failed", () => {
    for (const s of RunState.options.filter((o) => !isTerminal(o))) {
      expect(canTransition(s, "CANCELLED")).toBe(true);
      expect(canTransition(s, "FAILED")).toBe(true);
    }
  });

  it("maps each terminal state to honest outcomes (INV-09)", () => {
    expect(isLegalTerminalResult("COMPLETE", "verified_success", "checks_passed")).toBe(true);
    expect(isLegalTerminalResult("COMPLETE", "verified_success", "checks_failed")).toBe(false);
    expect(isLegalTerminalResult("FAILED", "verified_success", "internal_error")).toBe(false);
    expect(isLegalTerminalResult("FAILED", "failed", "budget_exhausted")).toBe(true);
    expect(new Set(TERMINAL_RESULTS.map((r) => r.state))).toEqual(new Set(TERMINAL_STATES));
  });
});

describe("run contract", () => {
  it("accepts an in-flight run", () => {
    expect(RunSchema.safeParse(run).success).toBe(true);
  });

  it("rejects an outcome on a non-terminal run", () => {
    expect(RunSchema.safeParse({ ...run, outcome: "verified_success", outcomeReason: "checks_passed" }).success).toBe(false);
  });

  it("rejects a terminal run with a mismatched outcome", () => {
    const done = { ...run, status: "FAILED", timestamps: { ...run.timestamps, endedAt: ts } };
    expect(RunSchema.safeParse({ ...done, outcome: "verified_success", outcomeReason: "checks_passed" }).success).toBe(false);
    expect(RunSchema.safeParse({ ...done, outcome: "failed", outcomeReason: "step_limit" }).success).toBe(true);
  });
});

describe("event and model-output contracts (INV-04)", () => {
  const base = { id: "e1", runId: "r1", sequence: 1, actor: { kind: "system", id: "runner" }, timestamp: ts };

  it("accepts a state_transition event", () => {
    const ev = { ...base, type: "state_transition", redactedPayload: { from: null, to: "CREATED", reason: "created" } };
    expect(EventSchema.safeParse(ev).success).toBe(true);
  });

  it("rejects payload fields that carry reasoning", () => {
    const ev = {
      ...base,
      type: "state_transition",
      redactedPayload: { from: null, to: "CREATED", reason: "x", reasoning: "hidden chain of thought" },
    };
    expect(EventSchema.safeParse(ev).success).toBe(false);
  });

  it("rejects model tool calls that carry a reasoning field", () => {
    expect(ToolCallRequest.safeParse({ tool: "read_file", args: {} }).success).toBe(true);
    expect(ToolCallRequest.safeParse({ tool: "read_file", args: {}, reasoning: "because" }).success).toBe(false);
  });
});

describe("memory candidate contract (INV-01, INV-03)", () => {
  const candidate = {
    kind: "procedural",
    lesson: "regenerate client before type check",
    applicability: { projectId: "p", conditions: ["schema changed"] },
    evidenceStatus: "observed",
    sourceRunIds: ["r1"],
    evaluationIds: ["ev1"],
    evidenceRefs: ["event:r1:3"],
    limitations: [],
    confidence: 0.7,
  };

  it("accepts an observed, evaluated procedural candidate", () => {
    expect(MemoryCandidateSchema.safeParse(candidate).success).toBe(true);
  });

  it("rejects a hypothesis posing as a procedure", () => {
    expect(MemoryCandidateSchema.safeParse({ ...candidate, evidenceStatus: "hypothesis" }).success).toBe(false);
  });

  it("rejects candidates without provenance or evaluation", () => {
    expect(MemoryCandidateSchema.safeParse({ ...candidate, sourceRunIds: [] }).success).toBe(false);
    expect(MemoryCandidateSchema.safeParse({ ...candidate, evaluationIds: [] }).success).toBe(false);
  });

  it("rejects out-of-range confidence", () => {
    expect(MemoryCandidateSchema.safeParse({ ...candidate, confidence: 1.5 }).success).toBe(false);
  });
});

describe("memory contracts (PRD §9.5, §9.6, §10)", () => {
  const record = {
    id: "m1",
    tenantId: "tn",
    projectId: "p",
    kind: "playbook_item",
    text: "Run pnpm gen:client after editing schema.prisma",
    tags: [],
    scope: { conditions: ["schema.prisma changed"] },
    preconditions: [],
    lifecycleState: "candidate",
    confidence: 0.5,
    sourceRunIds: ["r1"],
    evaluationIds: ["ev1"],
    version: 1,
    supersedes: null,
    lastVerifiedAt: null,
    expiresAt: null,
    embeddingModel: null,
    embeddingVersion: null,
    indexVersion: null,
    helpfulCount: 0,
    harmfulCount: 0,
    gateDecision: null,
    derivedFromMemoryIds: [],
    contentHash: "sha256:abc",
  };

  it("has the v1.4 kinds and the single lifecycle_state field with its eight values", () => {
    expect(MemoryKind.options).toEqual(["episodic", "semantic", "procedural", "playbook_item"]);
    expect(LifecycleState.options).toEqual([
      "candidate", "approved", "rejected", "demoted", "quarantined", "superseded", "expired", "retired",
    ]);
    expect(MemoryRecordSchema.safeParse(record).success).toBe(true);
    expect(MemoryRecordSchema.safeParse({ ...record, status: "approved" }).success).toBe(false);
    expect(MemoryRecordSchema.safeParse({ ...record, lifecycleState: "pending" }).success).toBe(false);
  });

  it("follows the §9.6 lifecycle transitions", () => {
    expect(canTransitionMemory("candidate", "approved")).toBe(true);
    expect(canTransitionMemory("candidate", "quarantined")).toBe(false);
    for (const to of ["demoted", "quarantined", "superseded", "expired", "retired"] as const) {
      expect(canTransitionMemory("approved", to)).toBe(true);
    }
    for (const from of ["demoted", "expired", "quarantined"] as const) expect(MEMORY_TRANSITIONS[from]).toEqual(["approved"]);
    expect(MEMORY_TRANSITIONS.rejected).toEqual([]);
    expect(MEMORY_TRANSITIONS.retired).toEqual([]);
  });

  it("accepts a playbook_item candidate only with an evaluation", () => {
    const candidate = {
      kind: "playbook_item",
      lesson: "run the generator first",
      applicability: { projectId: "p", conditions: ["schema changed"] },
      evidenceStatus: "observed",
      sourceRunIds: ["r1"],
      evaluationIds: ["ev1"],
      evidenceRefs: ["event:r1:3"],
      limitations: [],
      confidence: 0.4,
    };
    expect(MemoryCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(MemoryCandidateSchema.safeParse({ ...candidate, evaluationIds: [] }).success).toBe(false);
  });

  it("validates the reflection and judge contracts and the memory event variants", () => {
    const reflection = {
      outcome: "verified_failure",
      failureMode: "stale_tool_version_assumption",
      evidenceRefs: ["event:run-123:17", "evaluation:eval-123"],
      lesson: "Verify the installed CLI flag before using it in this repository",
      appliesWhen: ["same CLI family"],
      doesNotApplyWhen: ["version already pinned and verified"],
      suggestedMemoryKind: "procedural",
      requiresReview: false,
    };
    expect(ReflectionSchema.safeParse(reflection).success).toBe(true);
    expect(ReflectionSchema.safeParse({ ...reflection, reasoning: "private" }).success).toBe(false);
    const judge = { supported: true, unsupportedClaims: [], generic: false, instructionLike: false, rationaleSummary: "ok" };
    expect(JudgeVerdictSchema.safeParse(judge).success).toBe(true);

    const base = { id: "e1", runId: "r1", sequence: 1, actor: { kind: "system", id: "x" }, timestamp: ts };
    const use = { memoryId: "m1", citedInPlan: true, followed: true, outcomeEffect: "helped" };
    expect(EventSchema.safeParse({ ...base, type: "memory_use", redactedPayload: use }).success).toBe(true);
    expect(EventSchema.safeParse({ ...base, type: "memory_use", redactedPayload: { ...use, outcomeEffect: "great" } }).success).toBe(false);
  });
});
