import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Principal } from "../access";
import { InMemoryArtifactStore, SequentialIds, createStubTools, defineTool } from "../adapters";
import { ApprovalService, InMemoryApprovalStore } from "../approval";
import type { RunEvent } from "../contracts";
import { auditTrace } from "../evaluator";
import {
  FIXTURE_COMMANDS,
  FIXTURE_PLAN,
  FIXTURE_POLICY,
  FIXTURE_TASK,
  SOLUTION_STEPS,
  fixtureEvaluator,
  fixtureWorkspace,
} from "../fixture";
import { InMemorySideEffectLedger } from "../ledger";
import { ToolRegistry } from "../permission";
import type { Clock, ModelAdapter } from "../ports";
import { InMemoryJobQueue } from "./queue";
import type { RunJobPayload } from "./worker";
import { DurableExecutor } from "./worker";

/* A run paused in AWAITING_APPROVAL survives a checkpoint resume: pending stays paused, a decision continues or blocks it. */

class ManualClock implements Clock {
  constructor(private ms: number) {}

  now(): Date {
    return new Date(this.ms);
  }

  advance(by: number): void {
    this.ms += by;
  }
}

const KEY = "pause";
const TTL_MS = 60_000;
const RECHECK_MS = 1_000; // the executor's base backoff, which is how soon a paused job is offered again
const USAGE = { inputTokens: 100, outputTokens: 20, usd: 0.001 };
const owner: Principal = { id: "owner-1", role: "owner", tenantId: FIXTURE_TASK.tenantId, projectIds: [FIXTURE_TASK.projectId] };
const comment = { tool: "post_comment", args: { body: "hi" } };
const commentPlan = { ...FIXTURE_PLAN, tools: [...FIXTURE_PLAN.tools, "post_comment"] };
const commentPolicy = { ...FIXTURE_POLICY, toolAllowlist: [...FIXTURE_POLICY.toolAllowlist, "post_comment"] };

const stateTrail = (events: readonly RunEvent[]) => events.flatMap((event) => (event.type === "state_transition" ? [event.redactedPayload.to] : []));

// Stateless on purpose: a resumed attempt builds a fresh model, so the step index comes from the runner.
function stepModel(): ModelAdapter {
  const steps: readonly unknown[] = [comment, ...SOLUTION_STEPS];
  return {
    config: { provider: "stub", model: "scripted", version: "1" },
    async plan() {
      return { output: commentPlan, usage: USAGE };
    },
    async nextStep(input) {
      const output = steps[input.step - 1] ?? { tool: "finish", args: { summary: "script exhausted", claimedOutcome: "cannot_complete" } };
      return { output, usage: USAGE };
    },
  };
}

function setup() {
  const clock = new ManualClock(Date.UTC(2026, 0, 1));
  const approvals = new ApprovalService(new InMemoryApprovalStore(), clock, new SequentialIds(), { ttlMs: TTL_MS });
  const ledger = new InMemorySideEffectLedger();
  const queue = new InMemoryJobQueue<RunJobPayload>();
  let posted = 0;
  const registry = new ToolRegistry("test", [
    ...createStubTools(),
    defineTool({
      name: "post_comment",
      description: "post a comment",
      inputSchema: z.strictObject({ body: z.string() }),
      sideEffect: "external_write",
      idempotent: false,
      run: () => {
        posted += 1;
        return { ok: true, summary: "posted", observation: "posted" };
      },
    }),
  ]);
  const exec = new DurableExecutor({
    leaseMs: 1_000,
    queue,
    blankWorkspace: () => fixtureWorkspace(),
    createDeps: () => ({
      model: stepModel(),
      registry,
      evaluator: fixtureEvaluator(),
      commands: FIXTURE_COMMANDS,
      artifacts: new InMemoryArtifactStore(),
      sleep: async () => {},
      random: () => 0.5,
      effects: { ledger, approvals },
    }),
  });
  return { exec, queue, approvals, ledger, clock, posted: () => posted };
}

/** Dispatches the run and drives it to its first pause. */
async function pausedRun() {
  const h = setup();
  await h.exec.dispatch({ task: FIXTURE_TASK, policy: commentPolicy, idempotencyKey: KEY });
  expect(await h.exec.tick("worker-a")).toEqual({ kind: "paused", dispatchId: KEY, availableAt: RECHECK_MS });
  const [request] = h.approvals.list();
  if (!request) throw new Error("the run did not request an approval");
  return { ...h, id: request.id };
}

function finished(exec: DurableExecutor) {
  const result = exec.result(KEY);
  if (!result?.admitted) throw new Error("run has no result");
  return result;
}

describe("a run paused for approval under the durable worker", () => {
  it("checkpoints the pause, does not run the mutation, and is not charged an attempt", async () => {
    const { exec, queue, approvals, ledger, posted, id } = await pausedRun();
    const record = await exec.checkpoints.load(KEY);
    expect(record?.checkpoint.run.status).toBe("AWAITING_APPROVAL");
    expect(record?.checkpoint.phase).toBe("executing");
    expect(record?.checkpoint.awaiting).toMatchObject({ approvalId: id, call: comment });
    expect(approvals.get(id)?.status).toBe("pending");
    expect(posted()).toBe(0);
    expect(ledger.list().map((row) => row.tool)).not.toContain("post_comment");
    expect(await queue.list()).toMatchObject([{ state: "queued", attempts: 0, availableAt: RECHECK_MS }]);
    expect(await exec.tick("worker-a")).toEqual({ kind: "idle" });
  });

  it("stays paused while the approval is pending: no second request, no failure, never dead-lettered", async () => {
    const { exec, queue, approvals, id } = await pausedRun();
    for (let round = 1; round <= 5; round++) {
      exec.advance(RECHECK_MS);
      expect(await exec.tick("worker-b")).toMatchObject({ kind: "paused", dispatchId: KEY });
    }
    expect(approvals.list().map((request) => request.id)).toEqual([id]);
    expect(await queue.list()).toMatchObject([{ state: "queued", attempts: 0 }]);
    expect(await exec.deadLetters()).toEqual([]);
    expect(exec.result(KEY)).toBeUndefined();
    const record = await exec.checkpoints.load(KEY);
    expect(stateTrail(record?.checkpoint.events ?? []).filter((to) => to === "AWAITING_APPROVAL")).toHaveLength(1);
  });

  it("continues once an owner approves, and the mutation runs exactly once", async () => {
    const { exec, queue, approvals, ledger, posted, id } = await pausedRun();
    exec.advance(RECHECK_MS);
    expect(await exec.tick("worker-b")).toMatchObject({ kind: "paused" });
    approvals.approve(owner, id);
    exec.advance(RECHECK_MS);
    expect(await exec.tick("worker-b")).toEqual({ kind: "done", dispatchId: KEY });

    const done = finished(exec);
    expect([done.run.status, done.run.outcome, done.run.outcomeReason]).toEqual(["COMPLETE", "verified_success", "checks_passed"]);
    expect(stateTrail(done.events)).toEqual([
      "CREATED", "ADMITTED", "RETRIEVING", "PLANNING", "EXECUTING", "AWAITING_APPROVAL", "EXECUTING", "EVALUATING", "REFLECTING", "COMPLETE",
    ]);
    expect(auditTrace(done.events)).toMatchObject({ complete: true, unauthorizedToolActions: 0 });
    expect(posted()).toBe(1);
    expect(ledger.list().find((row) => row.tool === "post_comment")?.state).toBe("committed");
    expect(done.events.filter((event) => event.type === "tool_result" && event.redactedPayload.tool === "post_comment")).toHaveLength(1);
    expect(done.run.steps).toBe(5); // the paused step is counted once, not again on resume
    expect((await queue.list())[0]).toMatchObject({ state: "acked", attempts: 0 });
    expect((await exec.checkpoints.load(KEY))?.checkpoint.awaiting).toBeUndefined();
  });

  it("ends BLOCKED / approval_denied when the approval is denied, and never runs the mutation", async () => {
    const { exec, approvals, ledger, posted, id } = await pausedRun();
    approvals.deny(owner, id, "not this comment");
    exec.advance(RECHECK_MS);
    expect(await exec.tick("worker-b")).toEqual({ kind: "done", dispatchId: KEY });

    const done = finished(exec);
    expect([done.run.status, done.run.outcome, done.run.outcomeReason]).toEqual(["BLOCKED", "blocked", "approval_denied"]);
    expect(stateTrail(done.events).slice(-3)).toEqual(["EXECUTING", "AWAITING_APPROVAL", "BLOCKED"]);
    expect(posted()).toBe(0);
    expect(ledger.list().map((row) => row.tool)).not.toContain("post_comment");
    expect((await exec.checkpoints.load(KEY))?.checkpoint.awaiting).toBeUndefined();
  });

  it("ends BLOCKED / approval_expired when the deadline passes while paused, and closes the request", async () => {
    const { exec, approvals, clock, posted, id } = await pausedRun();
    clock.advance(TTL_MS);
    exec.advance(RECHECK_MS);
    expect(await exec.tick("worker-b")).toEqual({ kind: "done", dispatchId: KEY });

    const done = finished(exec);
    expect([done.run.status, done.run.outcome, done.run.outcomeReason]).toEqual(["BLOCKED", "blocked", "approval_expired"]);
    expect(approvals.get(id)?.status).toBe("expired");
    expect(posted()).toBe(0);
  });

  it("stops CANCELLED when cancelled while paused, closes the request, and never runs the mutation", async () => {
    const { exec, approvals, posted, id } = await pausedRun();
    exec.cancel(KEY);
    exec.advance(RECHECK_MS);
    expect(await exec.tick("worker-b")).toEqual({ kind: "done", dispatchId: KEY });

    const done = finished(exec);
    expect([done.run.status, done.run.outcome, done.run.outcomeReason]).toEqual(["CANCELLED", "cancelled", "user_cancel"]);
    expect(approvals.get(id)).toMatchObject({ status: "denied", decidedBy: "system" });
    expect(posted()).toBe(0);
    expect((await exec.checkpoints.load(KEY))?.checkpoint.awaiting).toBeUndefined();
  });
});
