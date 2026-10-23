import { describe, expect, it } from "vitest";
import type { EvaluationResult, Run, RunEvent } from "../reflex/contracts";
import type { ExperimentReport } from "../reflex/experiment";
import {
  UNSCOPED_SCOPE,
  collectArtifacts,
  countsBy,
  eventSummary,
  excerpt,
  filterMemoryList,
  formatCheckPassed,
  formatPValue,
  formatRate,
  formatTimestamp,
  parseMemoryQuery,
  retrievedMemories,
  scopeChoices,
  sortRunsNewestFirst,
  stateTimeline,
  toChartBars,
  toComparisonRows,
  toEvaluationView,
  toMemoryListItem,
  toRunListItem,
} from "./views";
import type { MemoryListItem, MemoryProvenance } from "./views";

function stateEvent(sequence: number, from: null | "CREATED", to: "CREATED" | "ADMITTED", reason: string): RunEvent {
  return {
    id: `evt-${sequence}`,
    runId: "run-1",
    sequence,
    actor: { kind: "system", id: "runner" },
    timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
    type: "state_transition",
    redactedPayload: { from, to, reason },
  };
}

const run = (id: string, createdAt: string, experimentId?: string): Parameters<typeof toRunListItem>[0] => ({
  id,
  taskId: `task-${id}`,
  status: "COMPLETE",
  outcome: "verified_success",
  outcomeReason: "checks_passed",
  configArm: "B",
  retrievalSnapshot: { mode: "hybrid", indexVersion: "mem-index-1", embeddingModel: "stub", embeddingVersion: "1" },
  timestamps: { createdAt, updatedAt: createdAt, endedAt: createdAt },
  steps: 4,
  ...(experimentId ? { experimentId } : {}),
});

const memory = (over: Partial<MemoryListItem> & Pick<MemoryListItem, "id" | "lifecycleState" | "kind">): MemoryListItem => ({
  text: `${over.id} lesson`,
  confidence: 0.5,
  scopeLabel: over.taskClass ?? "unscoped",
  taskClass: over.taskClass ?? null,
  sourceRunIds: ["run-1"],
  version: 1,
  score: null,
  ...over,
});

describe("run list and timeline", () => {
  it("maps a run onto a list row and falls back when the task is missing", () => {
    expect(toRunListItem(run("run-9", "2026-01-02T00:00:00.000Z", "exp-1"), { objective: "Fix add()" })).toMatchObject({
      id: "run-9",
      objective: "Fix add()",
      arm: "B",
      retrieval: "hybrid",
      experimentId: "exp-1",
    });
    expect(toRunListItem(run("run-8", "2026-01-01T00:00:00.000Z"), undefined).objective).toBe("Unknown task");
  });

  it("sorts newest first and orders the state timeline by sequence", () => {
    const sorted = sortRunsNewestFirst([
      toRunListItem(run("run-a", "2026-01-01T00:00:00.000Z"), { objective: "a" }),
      toRunListItem(run("run-b", "2026-01-03T00:00:00.000Z"), { objective: "b" }),
      toRunListItem(run("run-c", "2026-01-03T00:00:00.000Z"), { objective: "c" }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["run-b", "run-c", "run-a"]);
    const steps = stateTimeline([
      stateEvent(2, "CREATED", "ADMITTED", "admitted"),
      stateEvent(1, null, "CREATED", "run created"),
    ]);
    expect(steps.map((step) => [step.sequence, step.from, step.to])).toEqual([
      [1, null, "CREATED"],
      [2, "CREATED", "ADMITTED"],
    ]);
  });

  it("summarises trace events without dropping a variant", () => {
    const skipped: RunEvent = {
      id: "evt-3",
      runId: "run-1",
      sequence: 3,
      actor: { kind: "system", id: "runner" },
      timestamp: "2026-01-01T00:00:03.000Z",
      type: "retrieval_skipped",
      redactedPayload: { reason: "memory_disabled" },
    };
    expect(eventSummary(stateEvent(1, null, "CREATED", "run created"))).toBe("Entered CREATED: run created");
    expect(eventSummary(skipped)).toBe("Retrieval skipped (memory_disabled).");
    const denied: RunEvent = {
      ...skipped,
      type: "policy_denied",
      redactedPayload: { callId: null, tool: "git_push", reasonCode: "external_write_not_permitted", detail: "needs approval" },
    };
    expect(eventSummary(denied)).toContain("git_push");
  });
});

describe("artifacts and evaluations", () => {
  it("keeps sha256 refs from events and checks, once each, and ignores other refs", () => {
    const event: RunEvent = {
      id: "evt-1",
      runId: "run-1",
      sequence: 4,
      actor: { kind: "tool", id: "run_command" },
      timestamp: "2026-01-01T00:00:04.000Z",
      type: "tool_result",
      artifactRef: "sha256:abc",
      redactedPayload: { callId: "call-1", tool: "run_command", ok: true, summary: "output", durationMs: 3 },
    };
    const duplicate: RunEvent = { ...event, id: "evt-2", sequence: 5, artifactRef: "sha256:abc" };
    const other: RunEvent = { ...event, id: "evt-3", sequence: 6, artifactRef: "evaluation:eval-1" };
    const evaluation = {
      id: "eval-1",
      runId: "run-1",
      verdict: "verified_success",
      outcomeReason: "checks_passed",
      checkBundleHash: "hash",
      hiddenChecksPassed: true,
      touchedProtectedPaths: [],
      groundTruthRef: null,
      metrics: { duration_ms: 12 },
      checks: [
        { name: "operator_correct", command: "pnpm test", passed: true, artifactRef: "sha256:def" },
        { name: "tests_unchanged", passed: false, artifactRef: "sha256:abc" },
      ],
      evaluatorVersion: "1",
      evidenceRefs: [],
      completedAt: "2026-01-01T00:00:05.000Z",
    } satisfies EvaluationResult;
    expect(collectArtifacts([event, duplicate, other], evaluation)).toEqual([
      { ref: "sha256:abc", source: "event", label: "tool_result #4" },
      { ref: "sha256:def", source: "check", label: "operator_correct" },
    ]);
    expect(collectArtifacts([], null)).toEqual([]);
    expect(toEvaluationView(evaluation).metrics).toEqual([{ name: "duration_ms", value: 12 }]);
    expect(formatCheckPassed(null)).toBe("not run");
  });
});

describe("retrieved memories", () => {
  it("merges context rank with later use, and keeps a use that was not in context", () => {
    const context: Run["memoryContext"] = [
      { memoryId: "mem-b", version: 1, rank: 2, score: 0.2, injected: true },
      { memoryId: "mem-a", version: 1, rank: 1, score: 0.9, injected: true },
    ];
    const provenance = new Map<string, MemoryProvenance>([
      ["mem-a", { text: "use plus", lifecycleState: "approved", sourceRunIds: ["run-1"] }],
      ["mem-c", { text: "outside context", lifecycleState: "candidate", sourceRunIds: ["run-9"] }],
    ]);
    const rows = retrievedMemories(
      context,
      [
        { memoryId: "mem-a", citedInPlan: true, followed: false, outcomeEffect: "unknown" },
        { memoryId: "mem-c", citedInPlan: false, followed: false, outcomeEffect: "hurt" },
      ],
      provenance,
    );
    expect(rows.map((row) => row.memoryId)).toEqual(["mem-a", "mem-b", "mem-c"]);
    expect(rows[0]).toMatchObject({ rank: 1, citedInPlan: true, sourceRunIds: ["run-1"], text: "use plus" });
    expect(rows[1]).toMatchObject({ text: null, lifecycleState: null, outcomeEffect: "unknown" });
    expect(rows[2]).toMatchObject({ rank: null, injected: false, outcomeEffect: "hurt", sourceRunIds: ["run-9"] });
  });
});

describe("memory filters", () => {
  const items = [
    memory({ id: "m-ok", lifecycleState: "approved", kind: "procedural", taskClass: "operator_swap", text: "operator follows the function name" }),
    memory({ id: "m-cand", lifecycleState: "candidate", kind: "semantic", taskClass: "schema_change", text: "regenerate the client" }),
    memory({ id: "m-quar", lifecycleState: "quarantined", kind: "episodic", taskClass: "operator_swap" }),
    memory({ id: "m-exp", lifecycleState: "expired", kind: "semantic" }),
  ];

  it("filters by status, kind, scope, and text together", () => {
    expect(filterMemoryList(items, { status: "approved" }).map((item) => item.id)).toEqual(["m-ok"]);
    expect(filterMemoryList(items, { kind: "semantic" }).map((item) => item.id)).toEqual(["m-cand", "m-exp"]);
    expect(filterMemoryList(items, { scope: "operator_swap" }).map((item) => item.id)).toEqual(["m-ok", "m-quar"]);
    expect(filterMemoryList(items, { scope: UNSCOPED_SCOPE }).map((item) => item.id)).toEqual(["m-exp"]);
    expect(filterMemoryList(items, { status: "candidate", kind: "semantic", scope: "schema_change", q: "CLIENT" }).map((item) => item.id)).toEqual(["m-cand"]);
    expect(filterMemoryList(items, { q: "missing" })).toEqual([]);
  });

  it("drops embeddings when mapping a record", () => {
    const record = {
      id: "m1",
      kind: "procedural" as const,
      lifecycleState: "approved" as const,
      text: "lesson",
      confidence: 0.4,
      scope: { taskClass: "operator_swap", conditions: [], stack: ["node"] },
      sourceRunIds: ["run-1"],
      version: 2,
      embedding: [0.1, 0.2],
    };
    const item = toMemoryListItem(record);
    expect(item).not.toHaveProperty("embedding");
    expect(item.scopeLabel).toBe("operator_swap · node");
    expect(JSON.stringify(item)).not.toContain("0.1");
  });

  it("parses a query and rejects an unknown status, kind, or repeated key", () => {
    expect(parseMemoryQuery({ status: " candidate ", kind: "episodic", scope: " operator_swap ", q: " plus " })).toEqual({
      ok: true,
      query: { status: "candidate", kind: "episodic", scope: "operator_swap", q: "plus" },
    });
    expect(parseMemoryQuery({})).toEqual({ ok: true, query: {} });
    expect(parseMemoryQuery({ status: "rejected" })).toMatchObject({ ok: false, field: "status" });
    expect(parseMemoryQuery({ kind: "note" })).toMatchObject({ ok: false, field: "kind" });
    expect(parseMemoryQuery({ status: ["approved", "expired"] })).toMatchObject({ ok: false, field: "status" });
  });

  it("offers each task class once, plus unscoped when a memory has none", () => {
    expect(scopeChoices(items)).toEqual([
      { value: "operator_swap", label: "operator_swap" },
      { value: "schema_change", label: "schema_change" },
      { value: UNSCOPED_SCOPE, label: "unscoped" },
    ]);
  });
});

describe("evaluation comparison", () => {
  const report = {
    trials: 1,
    perTask: [
      {
        taskId: "task-exp-1",
        A: { successes: 0, trials: 1, majority: false, allPass: false, runIds: ["run-a"] },
        B: { successes: 1, trials: 1, majority: true, allPass: true, runIds: ["run-b"] },
      },
    ],
    arms: {
      A: { pass1: 0, passK: 0, majorityRate: 0 },
      B: { pass1: 1, passK: 1, majorityRate: 1 },
    },
  } as Pick<ExperimentReport, "perTask" | "trials" | "arms">;

  it("maps per-task rows and the three arm rates, including an empty report", () => {
    expect(toComparisonRows(report)).toEqual([
      {
        taskId: "task-exp-1",
        trials: 1,
        armA: { successes: 0, majority: false, runIds: ["run-a"] },
        armB: { successes: 1, majority: true, runIds: ["run-b"] },
      },
    ]);
    expect(toChartBars(report).map((bar) => [bar.label, bar.armA, bar.armB])).toEqual([
      ["pass^1", 0, 1],
      ["pass^k", 0, 1],
      ["majority", 0, 1],
    ]);
    expect(toComparisonRows({ perTask: [], trials: 3 })).toEqual([]);
    expect(toChartBars({ arms: { A: { pass1: 0, passK: 0, majorityRate: 0 }, B: { pass1: 0, passK: 0, majorityRate: 0 } } })).toHaveLength(3);
  });
});

describe("formatting", () => {
  it("formats rates, p-values, timestamps, excerpts, and counts", () => {
    expect(formatRate(1)).toBe("100%");
    expect(formatRate(0)).toBe("0%");
    expect(formatRate(1 / 3)).toBe("33.3%");
    expect(formatRate(Number.NaN)).toBe("—");
    expect(formatPValue(0)).toBe("0.000");
    expect(formatPValue(0.0004)).toBe("< 0.001");
    expect(formatPValue(0.25)).toBe("0.250");
    expect(formatTimestamp("2026-01-01T00:00:03.000Z")).toBe("2026-01-01 00:00:03 UTC");
    expect(formatTimestamp("not-a-time")).toBe("not-a-time");
    expect(excerpt("one   two")).toBe("one two");
    expect(excerpt("abcdef", 4)).toBe("abc…");
    expect(countsBy(["COMPLETE", "FAILED", "COMPLETE"])).toEqual([
      { key: "COMPLETE", count: 2 },
      { key: "FAILED", count: 1 },
    ]);
  });
});
