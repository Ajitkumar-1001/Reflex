import { describe, expect, it } from "vitest";
import {
  EventSchema,
  MemoryCandidateSchema,
  RunSchema,
  RunState,
  TERMINAL_RESULTS,
  TERMINAL_STATES,
  TRANSITIONS,
  TaskSchema,
  ToolCallRequest,
  assertTransition,
  canTransition,
  isLegalTerminalResult,
  isTerminal,
} from "./contracts";

const budget = { maxSteps: 5, maxWallMs: 1000, maxUsd: 1 };
const ts = "2026-01-01T00:00:00.000Z";

const task = {
  id: "t1",
  tenantId: "tn",
  projectId: "p",
  objective: "fix bug",
  mode: "build",
  scope: { workspaceRef: "ws", allowedPaths: ["src"], protectedPaths: [] },
  doneWhen: [{ checkId: "c1", description: "passes" }],
  authorizedTools: ["read_file"],
  riskClass: "low",
  budget,
  policy: { id: "pol", version: 1 },
  requestedBy: "tester",
  createdAt: ts,
};

const run = {
  id: "r1",
  taskId: "t1",
  status: "EXECUTING",
  policy: { id: "pol", version: 1 },
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

describe("task admission contract (FR-01)", () => {
  it("accepts a well-formed build task", () => {
    expect(TaskSchema.safeParse(task).success).toBe(true);
  });

  it("rejects a build task with no definition of done", () => {
    expect(TaskSchema.safeParse({ ...task, doneWhen: [] }).success).toBe(false);
  });

  it("allows an investigation task without a definition of done", () => {
    expect(TaskSchema.safeParse({ ...task, mode: "investigate", doneWhen: [] }).success).toBe(true);
  });

  it("rejects empty scope and unknown fields", () => {
    expect(TaskSchema.safeParse({ ...task, scope: { ...task.scope, allowedPaths: [] } }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...task, surprise: true }).success).toBe(false);
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
