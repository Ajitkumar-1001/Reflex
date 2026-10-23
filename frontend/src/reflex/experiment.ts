import type { RunEvent } from "./contracts";
import type { RunResult } from "./ports";

/*
 * Paired memory-on vs memory-off evaluation (PRD §12.3, FR-12, FR-28, US-4). The harness only orders cells,
 * classifies results and computes statistics; building a runner for an arm is the caller's job, so arm B can be
 * given a frozen repository and arm A no memory at all. Statistics are exact where they can be (McNemar) and
 * seeded where they cannot (bootstrap), so a report is reproducible byte for byte.
 *
 * Not here: arm B' (online writeback during test), arm C, the leave-one-out attribution (§12.3 step 6), order
 * sensitivity (step 7) and contamination checks (step 8). They need the real suite (DEC-11) and a real model.
 */

export type Arm = "A" | "B";

export interface Cell<T> {
  arm: Arm;
  item: T;
  trialIndex: number;
}

export interface ExperimentInput<T extends { id: string }> {
  experimentId: string;
  /** Test tasks, in the order they are run. Arms are interleaved per task: A1, B1, A2, B2, ... (§12.3 execution order). */
  items: readonly T[];
  /** Trials per arm per task. The PRD proposes k = 3. */
  trials: number;
  runOne: (cell: Cell<T>) => Promise<RunResult>;
  /** Hard stop on the number of runs. A task that cannot finish all its pairs is excluded and counted. */
  maxRuns?: number;
  /** Bootstrap resamples and PRNG seed for the confidence interval. */
  bootstrap?: { resamples: number; seed: number };
  /** The lift the owner has decided counts (DEC-06). Omitted while that decision is open: `meetsTarget` is then null. */
  targetLift?: number;
}

export interface ArmResult {
  successes: number;
  trials: number;
  /** The primary endpoint (§12.3 step 5): succeeded in a strict majority of trials. */
  majority: boolean;
  /** pass^k: every trial succeeded. */
  allPass: boolean;
  runIds: string[];
}

export interface TaskResult {
  taskId: string;
  A: ArmResult;
  B: ArmResult;
}

export type ExclusionReason = "retrieval_degraded" | "infra_failure" | "model_unavailable" | "not_admitted" | "incomplete_budget" | "not_run";

export interface ArmSummary {
  /** pass^1: mean over tasks of the share of trials that succeeded. */
  pass1: number;
  /** pass^k: share of tasks where all k trials succeeded. */
  passK: number;
  /** Share of tasks that succeeded in a strict majority of trials. */
  majorityRate: number;
}

export interface MemoryEffect {
  memoryId: string;
  /** Trials of arm B in which this memory was injected. Descriptive, not causal: ablation is deferred. */
  injectedTrials: number;
  successRateWhenInjected: number;
  /** Arm A success rate on the same tasks and trials. */
  controlSuccessRate: number;
  delta: number;
}

export interface ExperimentReport {
  experimentId: string;
  trials: number;
  tasksPlanned: number;
  tasksAnalysed: number;
  tasksExcluded: { taskId: string; reason: ExclusionReason }[];
  runsExecuted: number;
  perTask: TaskResult[];
  arms: { A: ArmSummary; B: ArmSummary };
  /** Paired majority outcomes. `bOnly` and `aOnly` are the discordant tasks McNemar tests. */
  paired: { bothSucceed: number; bOnly: number; aOnly: number; neither: number };
  lift: {
    majority: number;
    pass1: number;
    /** 95% percentile bootstrap interval over tasks for the majority lift. */
    majorityCi95: [number, number];
    /** §12.3 step 4: a lift counts only if the interval's lower bound exceeds 0. */
    ciLowerBoundPositive: boolean;
  };
  mcnemar: { bOnly: number; aOnly: number; pValue: number; significantAt05: boolean };
  /** Null while DEC-06 leaves the target open. */
  meetsTarget: boolean | null;
  perMemory: MemoryEffect[];
  /** FR-28: arm B must not write. Both counts must be 0 for the comparison to be valid. */
  frozen: { writebackAttemptsBlocked: number; memoryWrites: number };
}

// ------------------------------------------------------------------ statistics

/** Exact two-sided McNemar test (binomial with p = 0.5 on the discordant pairs). */
export function mcnemarExact(bOnly: number, aOnly: number): number {
  const n = bOnly + aOnly;
  if (n === 0) return 1;
  const k = Math.min(bOnly, aOnly);
  // Cumulative binomial in log space so a few hundred discordant pairs cannot overflow.
  const logChoose = (m: number, i: number) => {
    let sum = 0;
    for (let j = 1; j <= i; j++) sum += Math.log((m - i + j) / j);
    return sum;
  };
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

/** mulberry32: a small seeded PRNG, so the bootstrap interval is a pure function of its inputs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap over tasks of the mean paired difference (B minus A). */
export function bootstrapCi(diffs: readonly number[], resamples: number, seed: number): [number, number] {
  if (diffs.length === 0) return [0, 0];
  const random = mulberry32(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < diffs.length; i++) sum += diffs[Math.floor(random() * diffs.length)];
    means.push(sum / diffs.length);
  }
  means.sort((x, y) => x - y);
  return [means[Math.floor(0.025 * (resamples - 1))], means[Math.ceil(0.975 * (resamples - 1))]];
}

const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);

// ----------------------------------------------------------------------- runner

type Verdict = { success: boolean; exclusion: ExclusionReason | null; runId: string | null; events: readonly RunEvent[] };

function classify(result: RunResult): Verdict {
  if (!result.admitted) return { success: false, exclusion: "not_admitted", runId: null, events: [] };
  const { run, events } = result;
  // §7.8: a retrieval-degraded run is excluded from A/B statistics. Infra and provider outages are not the agent's result either.
  if (run.retrievalSnapshot.mode === "degraded") return { success: false, exclusion: "retrieval_degraded", runId: run.id, events };
  if (run.outcomeReason === "infra_failure") return { success: false, exclusion: "infra_failure", runId: run.id, events };
  if (run.outcomeReason === "model_unavailable") return { success: false, exclusion: "model_unavailable", runId: run.id, events };
  return { success: run.outcome === "verified_success", exclusion: null, runId: run.id, events };
}

const armResult = (verdicts: readonly Verdict[]): ArmResult => {
  const successes = verdicts.filter((v) => v.success).length;
  return {
    successes,
    trials: verdicts.length,
    majority: successes * 2 > verdicts.length,
    allPass: verdicts.length > 0 && successes === verdicts.length,
    runIds: verdicts.flatMap((v) => (v.runId ? [v.runId] : [])),
  };
};

const summarize = (results: readonly ArmResult[]): ArmSummary => ({
  pass1: mean(results.map((r) => r.successes / Math.max(1, r.trials))),
  passK: mean(results.map((r) => (r.allPass ? 1 : 0))),
  majorityRate: mean(results.map((r) => (r.majority ? 1 : 0))),
});

/**
 * Runs every task's pairs in interleaved order and reports. A task with any excluded run, or whose pairs the run
 * budget cannot complete, is dropped from the statistics and listed with its reason, so a budget stop leaves only
 * complete pairs (§12.3).
 */
export async function runExperiment<T extends { id: string }>(input: ExperimentInput<T>): Promise<ExperimentReport> {
  const { items, trials } = input;
  const maxRuns = input.maxRuns ?? Number.POSITIVE_INFINITY;
  const perTask: TaskResult[] = [];
  const excluded: { taskId: string; reason: ExclusionReason }[] = [];
  const injections = new Map<string, { success: number; trials: number; control: number }>();
  const frozen = { writebackAttemptsBlocked: 0, memoryWrites: 0 };
  let runsExecuted = 0;
  let budgetHit = false;

  for (const item of items) {
    if (budgetHit) {
      excluded.push({ taskId: item.id, reason: "not_run" });
      continue;
    }
    const a: Verdict[] = [];
    const b: Verdict[] = [];
    let complete = true;
    for (let trialIndex = 0; trialIndex < trials && complete; trialIndex++) {
      for (const arm of ["A", "B"] as const) {
        if (runsExecuted >= maxRuns) {
          complete = false;
          budgetHit = true;
          break;
        }
        runsExecuted++;
        (arm === "A" ? a : b).push(classify(await input.runOne({ arm, item, trialIndex })));
      }
    }
    for (const v of b) {
      for (const e of v.events) {
        if (e.type === "writeback_blocked") frozen.writebackAttemptsBlocked++;
        if (e.type === "gate_decision") frozen.memoryWrites++;
      }
    }
    if (!complete) {
      excluded.push({ taskId: item.id, reason: "incomplete_budget" });
      continue;
    }
    const reason = [...a, ...b].find((v) => v.exclusion)?.exclusion;
    if (reason) {
      excluded.push({ taskId: item.id, reason });
      continue;
    }
    perTask.push({ taskId: item.id, A: armResult(a), B: armResult(b) });
    b.forEach((v, i) => {
      for (const e of v.events) {
        if (e.type !== "memory_use") continue;
        const entry = injections.get(e.redactedPayload.memoryId) ?? { success: 0, trials: 0, control: 0 };
        entry.trials++;
        entry.success += v.success ? 1 : 0;
        entry.control += a[i].success ? 1 : 0;
        injections.set(e.redactedPayload.memoryId, entry);
      }
    });
  }

  const armA = summarize(perTask.map((t) => t.A));
  const armB = summarize(perTask.map((t) => t.B));
  const bOnly = perTask.filter((t) => t.B.majority && !t.A.majority).length;
  const aOnly = perTask.filter((t) => t.A.majority && !t.B.majority).length;
  const bothSucceed = perTask.filter((t) => t.A.majority && t.B.majority).length;
  const diffs = perTask.map((t) => (t.B.majority ? 1 : 0) - (t.A.majority ? 1 : 0));
  const { resamples, seed } = input.bootstrap ?? { resamples: 2000, seed: 1 };
  const majorityCi95 = bootstrapCi(diffs, resamples, seed);
  const lift = armB.majorityRate - armA.majorityRate;
  const pValue = mcnemarExact(bOnly, aOnly);
  const ciLowerBoundPositive = majorityCi95[0] > 0;

  return {
    experimentId: input.experimentId,
    trials,
    tasksPlanned: items.length,
    tasksAnalysed: perTask.length,
    tasksExcluded: excluded,
    runsExecuted,
    perTask,
    arms: { A: armA, B: armB },
    paired: { bothSucceed, bOnly, aOnly, neither: perTask.length - bothSucceed - bOnly - aOnly },
    lift: { majority: lift, pass1: armB.pass1 - armA.pass1, majorityCi95, ciLowerBoundPositive },
    mcnemar: { bOnly, aOnly, pValue, significantAt05: pValue < 0.05 },
    meetsTarget: input.targetLift === undefined ? null : lift >= input.targetLift && ciLowerBoundPositive && pValue < 0.05,
    perMemory: [...injections.entries()]
      .sort(([x], [y]) => (x < y ? -1 : 1))
      .map(([memoryId, e]) => ({
        memoryId,
        injectedTrials: e.trials,
        successRateWhenInjected: e.success / e.trials,
        controlSuccessRate: e.control / e.trials,
        delta: (e.success - e.control) / e.trials,
      })),
    frozen,
  };
}
