import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore, SequentialIds, SteppingClock, createStubTools } from "../adapters";
import type { RunEvent } from "../contracts";
import { CheckEvaluator, auditTrace } from "../evaluator";
import {
  FIXTURE_COMMANDS,
  FIXTURE_FILES,
  FIXTURE_PLAN,
  FIXTURE_POLICY,
  FIXTURE_TASK,
  SOLUTION_STEPS,
  fixtureEvaluator,
  fixtureRegistry,
  fixtureWorkspace,
} from "../fixture";
import { LESSON_TEXT, Lab, TASK_CLASS, arithmeticCommands, arithmeticTask, arithmeticWorkspace, labPolicy } from "../memory-fixture";
import { ToolRegistry } from "../permission";
import type { ModelAdapter, RunResult, ToolAdapter, ToolContext } from "../ports";
import { ReferenceRunner } from "../runner";
import { WorkerCrash } from "./handoff";
import { InMemoryJobQueue } from "./queue";
import type { JobQueue } from "./queue";
import type { RunJobPayload } from "./worker";
import { DurableExecutor } from "./worker";

/* Phase 2 durable execution: crash resume, duplicate dispatch, lease expiry, dead-letter, cancellation. */

type Admitted = Extract<RunResult, { admitted: true }>;

const USAGE = { inputTokens: 100, outputTokens: 20, usd: 0.001 };
const CLOCK = { startMs: Date.UTC(2026, 0, 1), stepMs: 10 };

function stepModel(steps: readonly unknown[] = SOLUTION_STEPS, plan: unknown = FIXTURE_PLAN): ModelAdapter {
  return {
    config: { provider: "stub", model: "scripted", version: "1" },
    async plan() {
      return { output: plan, usage: USAGE };
    },
    async nextStep(input) {
      const output = steps[input.step - 1] ?? { tool: "finish", args: { summary: "script exhausted", claimedOutcome: "cannot_complete" } };
      return { output, usage: USAGE };
    },
  };
}

function countingModel(stepsSeen: number[]): ModelAdapter {
  const inner = stepModel();
  return {
    config: inner.config,
    plan: (input) => inner.plan(input),
    async nextStep(input) {
      stepsSeen.push(input.step);
      return inner.nextStep(input);
    },
  };
}

function withWriteFile(
  run: (inner: ToolAdapter, args: unknown, ctx: ToolContext) => ReturnType<ToolAdapter["execute"]>,
): ToolRegistry {
  const tools = createStubTools().map((tool) =>
    tool.descriptor.name === "write_file"
      ? { descriptor: tool.descriptor, execute: (args: unknown, ctx: ToolContext) => run(tool, args, ctx) }
      : tool,
  );
  return new ToolRegistry("p0-stub-tools-1", tools);
}

const baseDeps = {
  evaluator: fixtureEvaluator(),
  commands: FIXTURE_COMMANDS,
  sleep: async () => {},
  random: () => 0.5,
};

async function cleanRun(model: ModelAdapter = stepModel()): Promise<Admitted> {
  const result = await new ReferenceRunner({
    ...baseDeps,
    model,
    registry: fixtureRegistry(),
    workspace: fixtureWorkspace(),
    artifacts: new InMemoryArtifactStore(),
    clock: new SteppingClock(CLOCK.startMs, CLOCK.stepMs),
    ids: new SequentialIds(),
  }).execute({ task: FIXTURE_TASK, policy: FIXTURE_POLICY });
  if (!result.admitted) throw new Error("clean run was not admitted");
  return result;
}

describe("crash mid-step and resume", () => {
  it("discards the partial step, re-leases once the lease expires, and matches a run that never crashed", async () => {
    const stepsSeen: number[] = [];
    let crashed = false;
    const registry = withWriteFile(async (inner, args, ctx) => {
      if (!crashed) {
        crashed = true;
        ctx.workspace.write("src/add.ts", "PARTIAL CRASH\n");
        throw new WorkerCrash("died during write_file");
      }
      return inner.execute(args, ctx);
    });
    const exec = new DurableExecutor({
      leaseMs: 1_000,
      ...CLOCK,
      blankWorkspace: () => fixtureWorkspace(),
      createDeps: () => ({ ...baseDeps, model: countingModel(stepsSeen), registry, artifacts: new InMemoryArtifactStore() }),
    });
    await exec.dispatch({ task: FIXTURE_TASK, policy: FIXTURE_POLICY, idempotencyKey: "fix" });

    expect(await exec.tick("worker-a")).toEqual({ kind: "crashed", dispatchId: "fix" });
    const checkpoint = await exec.checkpoints.load("fix");
    expect(checkpoint?.checkpoint.phase).toBe("executing");
    expect(checkpoint?.checkpoint.run.steps).toBe(1);
    expect(checkpoint?.checkpoint.workspace["src/add.ts"]).toBe(FIXTURE_FILES["src/add.ts"]);
    expect(await exec.tick("worker-b")).toEqual({ kind: "idle" });

    exec.advance(1_000);
    expect(await exec.tick("worker-b")).toEqual({ kind: "done", dispatchId: "fix" });
    const resumed = exec.result("fix");
    if (!resumed?.admitted) throw new Error("resumed run missing");
    const clean = await cleanRun();
    expect(resumed.run).toEqual(clean.run);
    expect(resumed.events).toEqual(clean.events);
    expect(auditTrace(resumed.events).complete).toBe(true);
    // Step 2 (the write) is dispatched twice — the crash and the resume — and recorded once.
    expect(stepsSeen).toEqual([1, 2, 2, 3, 4]);
    expect(resumed.events.filter((event) => event.type === "tool_result" && event.redactedPayload.tool === "write_file")).toHaveLength(1);
    expect(await exec.checkpoints.load("fix")).toMatchObject({ checkpoint: { phase: "terminal" } });
  });

  it("does not re-execute a finished run when the ack is lost and the lease expires", async () => {
    const stepsSeen: number[] = [];
    const inner = new InMemoryJobQueue<RunJobPayload>();
    let acks = 0;
    const queue: JobQueue<RunJobPayload> = {
      enqueue: (input) => inner.enqueue(input),
      lease: (input) => inner.lease(input),
      heartbeat: (input) => inner.heartbeat(input),
      nack: (input) => inner.nack(input),
      deadLetters: () => inner.deadLetters(),
      ack: async (input) => {
        acks += 1;
        if (acks === 1) throw new Error("ack dropped");
        return inner.ack(input);
      },
    };
    const exec = new DurableExecutor({
      leaseMs: 1_000,
      queue,
      ...CLOCK,
      blankWorkspace: () => fixtureWorkspace(),
      createDeps: () => ({ ...baseDeps, model: countingModel(stepsSeen), registry: fixtureRegistry(), artifacts: new InMemoryArtifactStore() }),
    });
    await exec.dispatch({ task: FIXTURE_TASK, policy: FIXTURE_POLICY, idempotencyKey: "fix" });
    expect(await exec.tick("worker-a")).toEqual({ kind: "ack_failed", dispatchId: "fix" });
    expect(stepsSeen).toEqual([1, 2, 3, 4]);
    expect(await exec.tick("worker-b")).toEqual({ kind: "idle" });
    exec.advance(1_000);
    expect(await exec.tick("worker-b")).toEqual({ kind: "done", dispatchId: "fix" });
    expect(stepsSeen).toEqual([1, 2, 3, 4]);
    const done = exec.result("fix");
    if (!done?.admitted) throw new Error("result missing");
    expect(done.run).toEqual((await cleanRun()).run);
  });
});

describe("duplicate dispatch", () => {
  it("leases one job and runs the fixture once", async () => {
    let attempts = 0;
    const exec = new DurableExecutor({
      leaseMs: 1_000,
      ...CLOCK,
      blankWorkspace: () => fixtureWorkspace(),
      createDeps: () => {
        attempts += 1;
        return { ...baseDeps, model: stepModel(), registry: fixtureRegistry(), artifacts: new InMemoryArtifactStore() };
      },
    });
    const first = await exec.dispatch({ task: FIXTURE_TASK, policy: FIXTURE_POLICY, idempotencyKey: "same" });
    const second = await exec.dispatch({
      task: { ...FIXTURE_TASK, objective: "different" },
      policy: FIXTURE_POLICY,
      idempotencyKey: "same",
    });
    expect(second.id).toBe(first.id);
    expect(second.payload.task).toEqual(first.payload.task);
    expect(await exec.tick("worker-a")).toEqual({ kind: "done", dispatchId: "same" });
    expect(await exec.tick("worker-b")).toEqual({ kind: "idle" });
    const third = await exec.dispatch({ task: FIXTURE_TASK, policy: FIXTURE_POLICY, idempotencyKey: "same" });
    expect(third.state).toBe("acked");
    expect(await exec.tick("worker-c")).toEqual({ kind: "idle" });
    expect(attempts).toBe(1);
  });
});

describe("cancellation", () => {
  it("finishes the in-flight step and stops at the next boundary as cancelled", async () => {
    const stepsSeen: number[] = [];
    const exec = new DurableExecutor({
      leaseMs: 5_000,
      ...CLOCK,
      blankWorkspace: () => fixtureWorkspace(),
      createDeps: () => ({
        ...baseDeps,
        model: countingModel(stepsSeen),
        artifacts: new InMemoryArtifactStore(),
        registry: withWriteFile(async (inner, args, ctx) => {
          exec.cancel("cancel-1");
          return inner.execute(args, ctx);
        }),
      }),
    });
    await exec.dispatch({ task: FIXTURE_TASK, policy: FIXTURE_POLICY, idempotencyKey: "cancel-1" });
    expect(await exec.tick("worker-a")).toEqual({ kind: "done", dispatchId: "cancel-1" });
    const result = exec.result("cancel-1");
    if (!result?.admitted) throw new Error("cancelled run missing");
    expect([result.run.status, result.run.outcome, result.run.outcomeReason]).toEqual(["CANCELLED", "cancelled", "user_cancel"]);
    expect(result.run.steps).toBe(2);
    const tools = result.events
      .filter((event): event is Extract<RunEvent, { type: "tool_result" }> => event.type === "tool_result")
      .map((event) => event.redactedPayload.tool);
    expect(tools).toEqual(["read_file", "write_file"]);
    expect(stepsSeen).toEqual([1, 2]);
    expect(auditTrace(result.events)).toMatchObject({ complete: true, unauthorizedToolActions: 0 });
    expect(result.events.at(-1)).toMatchObject({ type: "state_transition", redactedPayload: { to: "CANCELLED" } });
  });
});

describe("retry exhaustion", () => {
  it("dead-letters a job after bounded nacks and does not lease it again", async () => {
    let tries = 0;
    const exec = new DurableExecutor({
      leaseMs: 1_000,
      maxAttempts: 3,
      backoffMs: (attempt) => attempt * 100,
      blankWorkspace: () => fixtureWorkspace(),
      createDeps: () => {
        tries += 1;
        throw new Error("store unavailable");
      },
    });
    await exec.dispatch({ task: FIXTURE_TASK, policy: FIXTURE_POLICY, idempotencyKey: "flaky" });
    expect(await exec.tick("worker")).toMatchObject({ kind: "requeued", dispatchId: "flaky", attempts: 1, availableAt: 100 });
    expect(await exec.tick("worker")).toEqual({ kind: "idle" });
    exec.advance(100);
    expect(await exec.tick("worker")).toMatchObject({ kind: "requeued", attempts: 2, availableAt: 300 });
    exec.advance(10_000);
    expect(await exec.tick("worker")).toMatchObject({ kind: "dead", dispatchId: "flaky", attempts: 3 });
    expect(tries).toBe(3);
    expect(await exec.deadLetters()).toEqual([
      expect.objectContaining({ idempotencyKey: "flaky", state: "dead", lastError: "store unavailable" }),
    ]);
    expect(await exec.tick("worker")).toEqual({ kind: "idle" });
    const again = await exec.dispatch({ task: FIXTURE_TASK, policy: FIXTURE_POLICY, idempotencyKey: "flaky" });
    expect(again.state).toBe("dead");
  });
});

describe("memory-on resume", () => {
  it("continues an arm B run from the last tool step and does not retrieve again", async () => {
    const lab = new Lab();
    await lab.seed({
      id: "m-lesson",
      text: LESSON_TEXT,
      scope: { taskClass: TASK_CLASS, conditions: ["task class operator_swap"], exclusions: ["the failing check names the operator"] },
    });
    const task = arithmeticTask("mul", { id: "task-mul-durable", version: 2, split: "test" });
    const policy = labPolicy(2);
    const plan = {
      goal: "Make mul() return a * b",
      assumptions: [],
      steps: [{ description: "fix the operator", tool: "write_file" }],
      tools: ["read_file", "write_file", "run_command", "finish"],
      stopConditions: ["finish is called"],
      memoryIds: ["m-lesson"],
      verificationCommands: ["pnpm test"],
      expectedArtifacts: ["src/mul.ts"],
    };
    const fixed = "export const mul = (a: number, b: number): number => a * b;\n";
    const steps = [
      { tool: "read_file", args: { path: "src/mul.ts" } },
      { tool: "write_file", args: { path: "src/mul.ts", content: fixed } },
      { tool: "run_command", args: { argv: ["pnpm", "test"] } },
      { tool: "finish", args: { summary: "fixed", claimedOutcome: "done" } },
    ];
    const model: ModelAdapter = {
      config: { provider: "stub", model: "scripted", version: "1" },
      async plan() {
        return { output: plan, usage: USAGE };
      },
      async nextStep(input) {
        return { output: steps[input.step - 1] ?? steps[3], usage: USAGE };
      },
    };
    let crashed = false;
    const registry = withWriteFile(async (inner, args, ctx) => {
      if (!crashed) {
        crashed = true;
        ctx.workspace.write("src/mul.ts", "PARTIAL CRASH\n");
        throw new WorkerCrash("died during write_file");
      }
      return inner.execute(args, ctx);
    });
    const exec = new DurableExecutor({
      leaseMs: 1_000,
      ...CLOCK,
      blankWorkspace: () => arithmeticWorkspace("mul"),
      createDeps: () => ({
        model,
        registry,
        evaluator: new CheckEvaluator(arithmeticCommands("mul")),
        commands: arithmeticCommands("mul"),
        artifacts: new InMemoryArtifactStore(),
        sleep: async () => {},
        random: () => 0.5,
        memory: { repository: lab.store.memories, records: lab.store, embedder: lab.embedder, reflector: null, judge: null },
      }),
    });
    await exec.dispatch({ task, policy, idempotencyKey: "mul" });
    expect(await exec.tick("worker-a")).toEqual({ kind: "crashed", dispatchId: "mul" });
    const mid = await exec.checkpoints.load("mul");
    expect(mid?.checkpoint.run.retrievalSnapshot.mode).toBe("hybrid");
    expect(mid?.checkpoint.run.steps).toBe(1);
    expect(mid?.checkpoint.workspace["src/mul.ts"]).not.toContain("PARTIAL");
    expect(mid?.checkpoint.events.filter((event) => event.type === "retrieval_recorded")).toHaveLength(1);

    exec.advance(1_000);
    expect(await exec.tick("worker-b")).toEqual({ kind: "done", dispatchId: "mul" });
    const result = exec.result("mul");
    if (!result?.admitted) throw new Error("memory run missing");
    expect(result.run.outcome).toBe("verified_success");
    expect(result.run.configArm).toBe("B");
    expect(result.run.memoryContext).toEqual([expect.objectContaining({ memoryId: "m-lesson", injected: true })]);
    expect(result.events.filter((event) => event.type === "retrieval_recorded")).toHaveLength(1);
    expect(result.events.filter((event) => event.type === "memory_use")).toHaveLength(1);
    expect(result.events.filter((event) => event.type === "tool_result" && event.redactedPayload.tool === "write_file")).toHaveLength(1);
    expect(auditTrace(result.events).complete).toBe(true);
  });
});
