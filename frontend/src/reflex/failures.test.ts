import { describe, expect, it } from "vitest";
import { SequentialIds, SteppingClock, createStubTools } from "./adapters";
import type { RunEvent } from "./contracts";
import { RunSchema } from "./contracts";
import { auditTrace } from "./evaluator";
import { FIXTURE_COMMANDS, FIXTURE_TASK, SOLUTION_STEPS, fixtureModel, runFixture } from "./fixture";
import { ToolRegistry } from "./permission";
import { InfraFailureError, ModelUnavailableError } from "./ports";
import type { ModelAdapter, ModelResponse } from "./ports";
import { recoverInterruptedRun } from "./recovery";

/* PRD §7.8 failure mapping (FR-30): one injected failure per row that Phase 0 has a component for. */

async function run(options: Parameters<typeof runFixture>[0] = {}) {
  const result = await runFixture(options);
  if (!result.admitted) throw new Error(`not admitted: ${JSON.stringify(result.issues)}`);
  return result;
}

const terminal = (r: { status: string; outcome: string | null; outcomeReason: string | null }) => [r.status, r.outcome, r.outcomeReason];
const retries = (events: readonly RunEvent[]) =>
  events.flatMap((e) => (e.type === "model_retry" ? [[e.redactedPayload.cause, e.redactedPayload.retry, e.redactedPayload.delayMs]] : []));

/** A model whose first `plan` calls fail as scripted; later calls delegate to the fixture model. */
function flaky(faults: readonly ("provider" | "hang")[]): ModelAdapter {
  const inner: ModelAdapter = fixtureModel();
  let calls = 0;
  return {
    config: inner.config,
    nextStep: (input) => inner.nextStep(input),
    plan: async (input): Promise<ModelResponse> => {
      const fault = faults[calls++];
      if (fault === "provider") throw new ModelUnavailableError("429 rate limited");
      if (fault === "hang") return new Promise(() => {});
      return inner.plan(input);
    },
  };
}

describe("provider 429 / 5xx / network error (§7.8 row 1)", () => {
  it("retries up to 3 times with 2 s, 8 s, 30 s backoff, then continues if the provider recovers", async () => {
    const delays: number[] = [];
    const { run: r, events } = await run({ model: flaky(["provider", "provider", "provider"]), sleep: async (ms) => void delays.push(ms) });
    expect(delays).toEqual([2_000, 8_000, 30_000]);
    expect(retries(events)).toEqual([["provider_error", 1, 2_000], ["provider_error", 2, 8_000], ["provider_error", 3, 30_000]]);
    expect(r.outcome).toBe("verified_success");
  });

  it("ends INCONCLUSIVE/model_unavailable when the fourth call also fails", async () => {
    const { run: r, events } = await run({ model: flaky(["provider", "provider", "provider", "provider"]) });
    expect(terminal(r)).toEqual(["INCONCLUSIVE", "inconclusive", "model_unavailable"]);
    expect(retries(events)).toHaveLength(3);
    expect(auditTrace(events).complete).toBe(true);
  });

  it("applies jitter within ±25% of each backoff", async () => {
    const first = async (random: number) => {
      const delays: number[] = [];
      await run({ model: flaky(["provider"]), random: () => random, sleep: async (ms) => void delays.push(ms) });
      return delays[0];
    };
    expect([await first(0), await first(0.5), await first(1)]).toEqual([1_500, 2_000, 2_500]);
  });

  it("counts retries against the budget: an exhausted wall-clock budget stops the retries", async () => {
    const task = { ...FIXTURE_TASK, budget: { ...FIXTURE_TASK.budget, maxWallMinutes: 30 / 60_000 } };
    const { run: r, events } = await run({ task, model: flaky(["provider", "provider", "provider"]) });
    expect(terminal(r)).toEqual(["FAILED", "failed", "budget_exhausted"]);
    expect(retries(events).length).toBeLessThan(3);
  });
});

describe("model call timeout (§7.8 row 2)", () => {
  it("retries once, then continues if the second call answers", async () => {
    const { run: r, events } = await run({ model: flaky(["hang"]), modelTimeoutMs: 5 });
    expect(retries(events)).toEqual([["timeout", 1, 0]]);
    expect(r.outcome).toBe("verified_success");
  });

  it("stops after the second timeout as INCONCLUSIVE/model_unavailable", async () => {
    const { run: r, events } = await run({ model: flaky(["hang", "hang"]), modelTimeoutMs: 5 });
    expect(terminal(r)).toEqual(["INCONCLUSIVE", "inconclusive", "model_unavailable"]);
    expect(retries(events)).toHaveLength(1);
  });
});

describe("tool failures (§7.8 rows 5 and 6)", () => {
  it("returns a tool timeout to the model as an observation, not a harness failure", async () => {
    const stub = createStubTools();
    const real = stub.find((t) => t.descriptor.name === "read_file");
    if (!real) throw new Error("no read_file");
    const hanging = { descriptor: { ...real.descriptor, timeoutMs: 5 }, execute: () => new Promise<never>(() => {}) };
    const registry = new ToolRegistry("test", [...stub.filter((t) => t !== real), hanging]);
    const { run: r, events } = await run({ registry });
    const timedOut = events.find((e) => e.type === "tool_result" && !e.redactedPayload.ok);
    expect(timedOut?.type === "tool_result" && timedOut.redactedPayload.summary).toBe("tool timed out");
    expect(r.outcome).toBe("verified_success");
  });

  it("returns a non-zero exit to the model as an observation", async () => {
    const commands = { ...FIXTURE_COMMANDS, "pnpm test": () => ({ exitCode: 2, output: "boom" }) };
    const { run: r, events } = await run({ commands, model: fixtureModel(SOLUTION_STEPS) });
    const failed = events.find((e) => e.type === "tool_result" && e.redactedPayload.tool === "run_command");
    expect(failed?.type === "tool_result" && [failed.redactedPayload.ok, failed.redactedPayload.exitStatus]).toEqual([false, 2]);
    expect(r.status).toBe("COMPLETE");
  });

  it("ends INCONCLUSIVE/infra_failure without retrying when the sandbox is unavailable", async () => {
    let attempts = 0;
    const commands = {
      ...FIXTURE_COMMANDS,
      "pnpm test": () => {
        attempts++;
        throw new InfraFailureError("docker daemon unreachable");
      },
    };
    const { run: r, events, evaluation } = await run({ commands });
    expect(terminal(r)).toEqual(["INCONCLUSIVE", "inconclusive", "infra_failure"]);
    expect(attempts).toBe(1);
    expect(evaluation).toBeNull();
    expect(auditTrace(events).complete).toBe(true);
  });
});

describe("process crash in the non-durable executor (§7.8 last row)", () => {
  it("marks a run found non-terminal after restart FAILED/internal_error, and continues its trace", async () => {
    const full = await run();
    const executingAt = full.events.findIndex((e) => e.type === "state_transition" && e.redactedPayload.to === "EXECUTING");
    const events = full.events.slice(0, executingAt + 1);
    const interrupted = RunSchema.parse({
      ...full.run,
      status: "EXECUTING",
      outcome: null,
      outcomeReason: null,
      endWorkspaceHash: null,
      timestamps: { ...full.run.timestamps, endedAt: null },
    });

    const { run: recovered, event } = recoverInterruptedRun(interrupted, events, new SteppingClock(Date.UTC(2026, 0, 2), 10), new SequentialIds());
    expect(terminal(recovered)).toEqual(["FAILED", "failed", "internal_error"]);
    expect(event?.sequence).toBe(events.length + 1);
    expect(auditTrace([...events, ...(event ? [event] : [])]).complete).toBe(true);
  });

  it("leaves a terminal run alone", async () => {
    const { run: done, events } = await run();
    const result = recoverInterruptedRun(done, events, new SteppingClock(0, 1), new SequentialIds());
    expect(result).toEqual({ run: done, event: null });
  });
});
