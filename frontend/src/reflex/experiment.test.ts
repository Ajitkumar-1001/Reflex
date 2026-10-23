import { describe, expect, it } from "vitest";
import { bootstrapCi, mcnemarExact, runExperiment } from "./experiment";
import type { Cell } from "./experiment";
import { LESSON_TEXT, LessonFollowingModel, Lab, arithmeticTask, labPolicy } from "./memory-fixture";
import type { Operator } from "./memory-fixture";
import { RepositoryUnavailableError } from "./ports";
import type { MemoryRepository } from "./ports";
import { FrozenMemoryRepository } from "./store";

describe("statistics", () => {
  it("McNemar exact two-sided p matches the binomial tail", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(3, 3)).toBe(1);
    expect(mcnemarExact(5, 0)).toBeCloseTo(0.0625, 10);
    expect(mcnemarExact(0, 5)).toBeCloseTo(0.0625, 10);
    expect(mcnemarExact(10, 0)).toBeCloseTo(2 / 1024, 10);
    expect(mcnemarExact(8, 2)).toBeCloseTo((2 * (1 + 10 + 45)) / 1024, 10);
    expect(mcnemarExact(400, 300)).toBeLessThan(0.001); // large n does not overflow
  });

  it("bootstrap is seeded: same inputs, same interval; different seed may differ; degenerate inputs collapse", () => {
    const diffs = [1, 1, 0, 0, 1, -1, 0, 1];
    expect(bootstrapCi(diffs, 500, 7)).toEqual(bootstrapCi(diffs, 500, 7));
    expect(bootstrapCi([1, 1, 1], 200, 3)).toEqual([1, 1]);
    expect(bootstrapCi([0, 0, 0], 200, 3)).toEqual([0, 0]);
    expect(bootstrapCi([], 200, 3)).toEqual([0, 0]);
    const [lo, hi] = bootstrapCi(diffs, 2000, 1);
    expect(lo).toBeLessThanOrEqual(hi);
    expect(lo).toBeLessThanOrEqual(0.375);
    expect(hi).toBeGreaterThanOrEqual(0.375);
  });
});

interface Item {
  id: string;
  op: Operator;
  taskClass?: string | null;
}

const LESSON_SCOPE = { taskClass: "operator_swap", conditions: ["task class operator_swap"] };
const items = (n: number, over: Partial<Item> = {}): Item[] => Array.from({ length: n }, (_, i) => ({ id: `test-${i + 1}`, op: (["mul", "sub", "mul"] as const)[i % 3], ...over }));

/** Arm A: no memory at all. Arm B: retrieval over a frozen repository. */
function harness(lab: Lab, experimentId: string, over: { policyB?: 2 | 3; repoB?: MemoryRepository; modelA?: (item: Item) => LessonFollowingModel } = {}) {
  return async ({ arm, item, trialIndex }: Cell<Item>) => {
    const version = arm === "A" ? 1 : (over.policyB ?? 2);
    const task = arithmeticTask(item.op, { id: item.id, version, split: "test", ...(item.taskClass !== undefined ? { taskClass: item.taskClass } : {}) });
    return lab.run({
      op: item.op,
      task,
      experiment: { experimentId, trialIndex },
      ...(arm === "A" ? { memory: false as const } : { repository: over.repoB ?? new FrozenMemoryRepository(lab.store.memories) }),
    });
  };
}

const withLesson = async () => {
  const lab = new Lab();
  await lab.seed({ id: "m-lesson", text: LESSON_TEXT, scope: LESSON_SCOPE });
  return lab;
};

describe("paired memory-on vs memory-off evaluation (FR-12, FR-28)", () => {
  it("reports the effect with per-task results, pass^1/pass^k, bootstrap CI and exact McNemar", async () => {
    const lab = await withLesson();
    const report = await runExperiment({ experimentId: "exp-1", items: items(6), trials: 3, runOne: harness(lab, "exp-1") });
    expect(report).toMatchObject({
      experimentId: "exp-1",
      tasksPlanned: 6,
      tasksAnalysed: 6,
      tasksExcluded: [],
      runsExecuted: 36,
      arms: { A: { pass1: 0, passK: 0, majorityRate: 0 }, B: { pass1: 1, passK: 1, majorityRate: 1 } },
      paired: { bothSucceed: 0, bOnly: 6, aOnly: 0, neither: 0 },
      lift: { majority: 1, pass1: 1, majorityCi95: [1, 1], ciLowerBoundPositive: true },
      meetsTarget: null,
      frozen: { writebackAttemptsBlocked: 0, memoryWrites: 0 },
    });
    expect(report.mcnemar.pValue).toBeCloseTo(2 / 64, 10);
    expect(report.mcnemar.significantAt05).toBe(true);
    expect(report.perTask).toHaveLength(6);
    expect(report.perTask[0]).toMatchObject({ taskId: "test-1", A: { successes: 0, trials: 3, majority: false }, B: { successes: 3, trials: 3, majority: true, allPass: true } });
    expect(report.perMemory).toEqual([{ memoryId: "m-lesson", injectedTrials: 18, successRateWhenInjected: 1, controlSuccessRate: 0, delta: 1 }]);
  });

  it("interleaves A and B per task and records every run under its experiment slot with pinned retrieval", async () => {
    const lab = await withLesson();
    const order: string[] = [];
    const inner = harness(lab, "exp-1");
    await runExperiment({ experimentId: "exp-1", items: items(2), trials: 2, runOne: async (cell) => { order.push(`${cell.item.id}:${cell.arm}${cell.trialIndex}`); return inner(cell); } });
    expect(order).toEqual(["test-1:A0", "test-1:B0", "test-1:A1", "test-1:B1", "test-2:A0", "test-2:B0", "test-2:A1", "test-2:B1"]);
    const runs = await lab.store.allRuns();
    expect(runs.every((r) => r.experimentId === "exp-1" && r.evalSplit === "test")).toBe(true);
    expect(new Set(runs.map((r) => r.configArm))).toEqual(new Set(["A", "B"]));
    expect(runs.filter((r) => r.configArm === "A").every((r) => r.retrievalSnapshot.mode === "disabled")).toBe(true);
    expect(runs.filter((r) => r.configArm === "B").every((r) => r.retrievalSnapshot.mode === "hybrid")).toBe(true);
  });

  it("is reproducible: an identical experiment on a fresh lab yields an identical report", async () => {
    const run = async () => {
      const lab = await withLesson();
      return runExperiment({ experimentId: "exp-1", items: items(4), trials: 2, runOne: harness(lab, "exp-1") });
    };
    expect(await run()).toEqual(await run());
  });

  it("reports a null result honestly: with nothing learned there is no lift, p = 1, and the CI includes 0", async () => {
    const lab = new Lab();
    const report = await runExperiment({ experimentId: "exp-1", items: items(6), trials: 3, runOne: harness(lab, "exp-1") });
    expect(report.lift).toMatchObject({ majority: 0, pass1: 0, majorityCi95: [0, 0], ciLowerBoundPositive: false });
    expect(report.mcnemar).toMatchObject({ pValue: 1, significantAt05: false });
    expect(report.perMemory).toEqual([]);
    expect(report.meetsTarget).toBeNull();
  });

  it("separates repeat-class from novel tasks: no harm on novel tasks, lift only where the class recurs (§4.1 guardrail)", async () => {
    const lab = await withLesson();
    const repeat = items(3).map((i) => ({ ...i, id: `repeat-${i.id}` }));
    const novel = items(3).map((i) => ({ ...i, id: `novel-${i.id}`, taskClass: "unrelated_class" }));
    const report = await runExperiment({ experimentId: "exp-1", items: [...repeat, ...novel], trials: 1, runOne: harness(lab, "exp-1") });
    const slice = (prefix: string) => report.perTask.filter((t) => t.taskId.startsWith(prefix));
    expect(slice("repeat").every((t) => t.B.majority && !t.A.majority)).toBe(true);
    expect(slice("novel").every((t) => t.B.majority === t.A.majority && !t.B.majority)).toBe(true);
    expect(report.lift.majority).toBe(0.5);
  });

  it("compares the lift with a target only once the owner has set one (DEC-06 is open)", async () => {
    const lab = await withLesson();
    const base = { items: items(6), trials: 3, runOne: harness(lab, "exp-1") };
    expect((await runExperiment({ ...base, experimentId: "exp-1", targetLift: 0.15 })).meetsTarget).toBe(true);
    const lab2 = new Lab();
    expect((await runExperiment({ experimentId: "exp-2", items: items(6), trials: 3, runOne: harness(lab2, "exp-2"), targetLift: 0.15 })).meetsTarget).toBe(false);
  });

  it("excludes a task with a retrieval_degraded run from the statistics and says so (PRD §7.8)", async () => {
    const lab = await withLesson();
    const down: MemoryRepository = {
      insert: async () => {},
      get: async () => undefined,
      replace: async () => {},
      find: async () => { throw new RepositoryUnavailableError("atlas down"); },
    };
    const inner = harness(lab, "exp-1");
    const report = await runExperiment({
      experimentId: "exp-1",
      items: items(3),
      trials: 1,
      runOne: (cell) => (cell.item.id === "test-2" && cell.arm === "B" ? harness(lab, "exp-1", { repoB: down })(cell) : inner(cell)),
    });
    expect(report.tasksExcluded).toEqual([{ taskId: "test-2", reason: "retrieval_degraded" }]);
    expect(report.tasksAnalysed).toBe(2);
    expect(report.perTask.map((t) => t.taskId)).toEqual(["test-1", "test-3"]);
  });

  it("excludes infra and provider failures rather than counting them as agent failures", async () => {
    const lab = await withLesson();
    const unavailable = {
      config: { provider: "stub", model: "down", version: "1" },
      plan: async () => { throw new (await import("./ports")).ModelUnavailableError("503"); },
      nextStep: async () => { throw new Error("unreachable"); },
    };
    const report = await runExperiment({
      experimentId: "exp-1",
      items: items(2),
      trials: 1,
      runOne: async (cell) => {
        if (cell.item.id !== "test-1" || cell.arm !== "A") return harness(lab, "exp-1")(cell);
        return lab.run({ op: cell.item.op, task: arithmeticTask(cell.item.op, { id: cell.item.id, version: 1, split: "test" }), model: unavailable, memory: false, experiment: { experimentId: "exp-1", trialIndex: 0 } });
      },
    });
    expect(report.tasksExcluded).toEqual([{ taskId: "test-1", reason: "model_unavailable" }]);
    expect(report.tasksAnalysed).toBe(1);
  });

  it("a run budget stop leaves only complete pairs; the partial task and the untouched ones are excluded and counted", async () => {
    const lab = await withLesson();
    const report = await runExperiment({ experimentId: "exp-1", items: items(4), trials: 3, maxRuns: 7, runOne: harness(lab, "exp-1") });
    expect(report.runsExecuted).toBe(7);
    expect(report.perTask.map((t) => t.taskId)).toEqual(["test-1"]);
    expect(report.tasksExcluded).toEqual([
      { taskId: "test-2", reason: "incomplete_budget" },
      { taskId: "test-3", reason: "not_run" },
      { taskId: "test-4", reason: "not_run" },
    ]);
  });

  it("FR-28: arm B with writeback attempted has every write blocked, the memory store is unchanged, and the report says how many attempts were blocked", async () => {
    const lab = await withLesson();
    const before = JSON.stringify(await lab.store.memories.find({ tenantId: "tenant-local", projectId: "project-fixture" }));
    const report = await runExperiment({ experimentId: "exp-1", items: items(3), trials: 2, runOne: harness(lab, "exp-1", { policyB: 3 }) });
    expect(report.frozen.memoryWrites).toBe(0);
    expect(report.frozen.writebackAttemptsBlocked).toBe(6);
    expect(JSON.stringify(await lab.store.memories.find({ tenantId: "tenant-local", projectId: "project-fixture" }))).toBe(before);
    expect(report.tasksAnalysed).toBe(3);
  });

  it("flags a comparison that is not valid because arm B did write (frozen.memoryWrites > 0)", async () => {
    const lab = await withLesson();
    // A deliberately unfrozen repository on a train-split task: the harness must surface the writes, not hide them.
    const report = await runExperiment({
      experimentId: "exp-1",
      items: items(1),
      trials: 1,
      runOne: async ({ arm, item, trialIndex }) =>
        lab.run({ op: item.op, task: arithmeticTask(item.op, { id: item.id, version: arm === "A" ? 1 : 3, split: "train" }), experiment: { experimentId: "exp-1", trialIndex }, ...(arm === "A" ? { memory: false as const } : {}) }),
    });
    expect(report.frozen.memoryWrites).toBeGreaterThan(0);
    expect(labPolicy(3).memoryRules.writebackEnabled).toBe(true);
  });
});

