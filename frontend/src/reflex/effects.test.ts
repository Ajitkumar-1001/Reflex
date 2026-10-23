import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ReflexError } from "./access";
import type { Principal } from "./access";
import { InMemoryArtifactStore, InMemoryWorkspace, SequentialIds, createStubTools, defineTool } from "./adapters";
import { ApprovalService, InMemoryApprovalStore } from "./approval";
import type { RunEvent } from "./contracts";
import { auditTrace } from "./evaluator";
import {
  FIXTURE_PLAN,
  FIXTURE_POLICY,
  FIXTURE_TASK,
  SOLUTION_STEPS,
  fixtureModel,
  runFixture,
} from "./fixture";
import { InMemorySideEffectLedger, effectKey } from "./ledger";
import { ToolRegistry } from "./permission";
import type { Clock, ToolAdapter } from "./ports";
import type { EffectRuntime } from "./runner";
import { dispatchEffect } from "./tool-runner";

class ManualClock implements Clock {
  constructor(private ms: number) {}

  now(): Date {
    return new Date(this.ms);
  }

  advance(by: number): void {
    this.ms += by;
  }
}

const TTL_MS = 60_000;
const owner: Principal = { id: "owner-1", role: "owner", tenantId: FIXTURE_TASK.tenantId, projectIds: [FIXTURE_TASK.projectId] };
const viewer: Principal = { id: "viewer-1", role: "viewer", tenantId: FIXTURE_TASK.tenantId, projectIds: [FIXTURE_TASK.projectId] };
const comment = { tool: "post_comment", args: { body: "hi" } };
const commentPlan = { ...FIXTURE_PLAN, tools: [...FIXTURE_PLAN.tools, "post_comment"] };
const commentPolicy = { ...FIXTURE_POLICY, toolAllowlist: [...FIXTURE_POLICY.toolAllowlist, "post_comment"] };

const stateTrail = (events: readonly RunEvent[]) => events.flatMap((event) => (event.type === "state_transition" ? [event.redactedPayload.to] : []));
const code = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    return error instanceof ReflexError ? error.code : "other";
  }
  return "ok";
};

function commentTool(execute: () => void): ToolAdapter {
  return defineTool({
    name: "post_comment",
    description: "post a comment",
    inputSchema: z.strictObject({ body: z.string() }),
    sideEffect: "external_write",
    idempotent: false,
    run: () => {
      execute();
      return { ok: true, summary: "posted", observation: "posted" };
    },
  });
}

function pausedRun(execute: () => void, signal?: AbortSignal) {
  const clock = new ManualClock(Date.UTC(2026, 0, 1));
  const ids = new SequentialIds();
  const ledger = new InMemorySideEffectLedger();
  const approvals = new ApprovalService(new InMemoryApprovalStore(), clock, ids, { ttlMs: TTL_MS });
  const tool = commentTool(execute);
  let resolvePaused: (id: string) => void = () => {};
  const paused = new Promise<string>((resolve) => {
    resolvePaused = resolve;
  });
  let opened = false;
  const effects: EffectRuntime = { ledger, approvals };
  const result = runFixture({
    registry: new ToolRegistry("test", [...createStubTools(), tool]),
    policy: commentPolicy,
    model: fixtureModel([comment, ...SOLUTION_STEPS], commentPlan),
    clock,
    ids,
    effects,
    signal,
    sink: {
      append: (event) => {
        if (opened || event.type !== "state_transition" || event.redactedPayload.to !== "AWAITING_APPROVAL") return;
        opened = true;
        const pending = approvals.list().find((request) => request.status === "pending");
        if (pending) resolvePaused(pending.id);
      },
    },
  });
  const requestId = new Promise<string>((resolve, reject) => {
    paused.then(resolve, reject);
    result.then(
      () => {
        if (!opened) reject(new Error("run ended before it paused for approval"));
      },
      reject,
    );
  });
  return { clock, ledger, approvals, tool, effects, result, requestId };
}

describe("approval workflow on the reference runner", () => {
  it("pauses for approval, records who/what/scope, and runs the mutation once after an owner approves", async () => {
    let calls = 0;
    const { approvals, ledger, tool, effects, result, requestId } = pausedRun(() => {
      calls += 1;
    });
    const id = await requestId;
    expect(calls).toBe(0);
    expect(ledger.list().map((record) => record.tool)).not.toContain("post_comment");
    expect(approvals.get(id)).toMatchObject({
      status: "pending",
      requestedBy: FIXTURE_TASK.requestedBy,
      tool: "post_comment",
      argsSummary: JSON.stringify(comment.args).slice(0, 200),
      scope: {
        tenantId: FIXTURE_TASK.tenantId,
        projectId: FIXTURE_TASK.projectId,
        repo: FIXTURE_TASK.scope.repo,
        commit: FIXTURE_TASK.scope.commit,
      },
    });

    approvals.approve(owner, id);
    const done = await result;
    if (!done.admitted) throw new Error("not admitted");
    expect([done.run.status, done.run.outcome, done.run.outcomeReason]).toEqual(["COMPLETE", "verified_success", "checks_passed"]);
    expect(calls).toBe(1);
    expect(stateTrail(done.events)).toEqual([
      "CREATED", "ADMITTED", "RETRIEVING", "PLANNING", "EXECUTING", "AWAITING_APPROVAL", "EXECUTING", "EVALUATING", "REFLECTING", "COMPLETE",
    ]);
    expect(auditTrace(done.events)).toMatchObject({ complete: true, unauthorizedToolActions: 0 });
    const recorded = ledger.list().find((record) => record.tool === "post_comment");
    expect(recorded?.state).toBe("committed");

    const replay = await dispatchEffect({
      runId: done.run.id,
      step: recorded?.step ?? 0,
      tool,
      args: comment.args,
      ctx: { workspace: new InMemoryWorkspace("ws", {}), scope: FIXTURE_TASK.scope, commands: {}, artifacts: new InMemoryArtifactStore() },
      ledger,
      grants: effects.approvals.store,
      approvalId: id,
      approvalMarks: [],
      clock: new ManualClock(Date.UTC(2026, 0, 1)),
      timeoutMs: 5_000,
    });
    expect(replay).toMatchObject({ kind: "replayed", state: "committed" });
    expect(calls).toBe(1);
  });

  it("deny fails closed, records why, and never runs the mutation", async () => {
    let calls = 0;
    const { approvals, result, requestId } = pausedRun(() => {
      calls += 1;
    });
    const id = await requestId;
    approvals.deny(owner, id, "not this repository");
    const done = await result;
    if (!done.admitted) throw new Error("not admitted");
    expect([done.run.status, done.run.outcome, done.run.outcomeReason]).toEqual(["BLOCKED", "blocked", "approval_denied"]);
    expect(calls).toBe(0);
    expect(approvals.get(id)).toMatchObject({ status: "denied", decidedBy: "owner-1", reason: "not this repository" });
    const blocked = done.events.find((event) => event.type === "state_transition" && event.redactedPayload.to === "BLOCKED");
    expect(blocked?.type === "state_transition" && blocked.redactedPayload.reason).toContain("not this repository");
    expect(done.events.some((event) => event.type === "tool_authorized")).toBe(false);
    expect(auditTrace(done.events).complete).toBe(true);
  });

  it("expiry fails closed, records why, and never runs the mutation", async () => {
    let calls = 0;
    const { clock, approvals, result, requestId } = pausedRun(() => {
      calls += 1;
    });
    const id = await requestId;
    clock.advance(TTL_MS);
    expect(approvals.expireDue()[0]).toMatchObject({ id, status: "expired", reason: "approval expired" });
    const done = await result;
    if (!done.admitted) throw new Error("not admitted");
    expect([done.run.status, done.run.outcome, done.run.outcomeReason]).toEqual(["BLOCKED", "blocked", "approval_expired"]);
    expect(calls).toBe(0);
    const blocked = done.events.find((event) => event.type === "state_transition" && event.redactedPayload.to === "BLOCKED");
    expect(blocked?.type === "state_transition" && blocked.redactedPayload.reason).toContain("approval expired");
    expect(auditTrace(done.events).complete).toBe(true);
  });

  it("rejects an unauthorized approver and leaves the run paused until an owner decides", async () => {
    let calls = 0;
    const { approvals, result, requestId } = pausedRun(() => {
      calls += 1;
    });
    const id = await requestId;
    expect(code(() => approvals.approve(viewer, id))).toBe("forbidden");
    expect(code(() => approvals.deny({ ...owner, role: "runner", id: "runner-1" }, id, "no"))).toBe("forbidden");
    expect(approvals.get(id)?.status).toBe("pending");
    expect(calls).toBe(0);
    approvals.approve(owner, id);
    const done = await result;
    if (!done.admitted) throw new Error("not admitted");
    expect(done.run.status).toBe("COMPLETE");
    expect(calls).toBe(1);
  });

  it("cancels a paused run without running the mutation", async () => {
    const controller = new AbortController();
    let calls = 0;
    const { approvals, result, requestId } = pausedRun(() => {
      calls += 1;
    }, controller.signal);
    const id = await requestId;
    controller.abort();
    const done = await result;
    if (!done.admitted) throw new Error("not admitted");
    expect([done.run.status, done.run.outcome, done.run.outcomeReason]).toEqual(["CANCELLED", "cancelled", "user_cancel"]);
    expect(calls).toBe(0);
    expect(approvals.get(id)).toMatchObject({ status: "denied", reason: "run cancelled while awaiting approval" });
    expect(auditTrace(done.events).complete).toBe(true);
  });

  it("does not run a marked mutation when no approval workflow is configured", async () => {
    const done = await runFixture({ policy: { ...FIXTURE_POLICY, approvalRequirements: ["write_file"] } });
    if (!done.admitted) throw new Error("not admitted");
    expect([done.run.status, done.run.outcome, done.run.outcomeReason]).toEqual(["BLOCKED", "blocked", "approval_required_p0"]);
    expect(done.run.startWorkspaceHash).toBe(done.run.endWorkspaceHash);
    expect(done.events.some((event) => event.type === "tool_authorized")).toBe(false);
    expect(auditTrace(done.events).complete).toBe(true);
  });

  it("ledgers each mutation before it runs, and a second dispatch of that key does not run it again", async () => {
    const clock = new ManualClock(Date.UTC(2026, 0, 1));
    const ids = new SequentialIds();
    const ledger = new InMemorySideEffectLedger();
    const approvals = new ApprovalService(new InMemoryApprovalStore(), clock, ids, { ttlMs: TTL_MS });
    let writes = 0;
    const tools = createStubTools().map((tool) => {
      if (tool.descriptor.name !== "write_file") return tool;
      return {
        descriptor: tool.descriptor,
        execute: async (args: unknown, ctx: Parameters<ToolAdapter["execute"]>[1]) => {
          writes += 1;
          expect(ledger.list().find((record) => record.tool === "write_file")?.state).toBe("intended");
          return tool.execute(args, ctx);
        },
      };
    });
    const writeTool = tools.find((tool) => tool.descriptor.name === "write_file");
    if (!writeTool) throw new Error("no write_file");
    const done = await runFixture({
      registry: new ToolRegistry("test", tools),
      clock,
      ids,
      effects: { ledger, approvals },
    });
    if (!done.admitted) throw new Error("not admitted");
    expect(done.run.outcome).toBe("verified_success");
    expect(writes).toBe(1);
    expect(ledger.list().map((record) => [record.tool, record.state])).toEqual([
      ["write_file", "committed"],
      ["run_command", "committed"],
    ]);
    const writeArgs = SOLUTION_STEPS[1];
    const recorded = ledger.get(effectKey(done.run.id, 2, "write_file", (writeArgs as { args: unknown }).args).key);
    expect(recorded?.state).toBe("committed");
    const replay = await dispatchEffect({
      runId: done.run.id,
      step: 2,
      tool: writeTool,
      args: (writeArgs as { args: unknown }).args,
      ctx: { workspace: new InMemoryWorkspace("ws", {}), scope: FIXTURE_TASK.scope, commands: {}, artifacts: new InMemoryArtifactStore() },
      ledger,
      grants: approvals.store,
      approvalId: null,
      approvalMarks: [],
      clock,
      timeoutMs: 5_000,
    });
    expect(replay.kind).toBe("replayed");
    expect(writes).toBe(1);
  });
});
