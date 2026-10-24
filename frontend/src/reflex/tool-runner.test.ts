import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApprovalService, InMemoryApprovalStore } from "./approval";
import type { ApprovalSubject } from "./approval";
import { InMemoryArtifactStore, InMemoryWorkspace, SequentialIds, defineTool } from "./adapters";
import type { Principal } from "./access";
import type { SideEffectClass } from "./contracts";
import { WorkerCrash } from "./execution/handoff";
import { effectKey } from "./ledger";
import { InMemorySideEffectLedger } from "./ledger";
import { InfraFailureError } from "./ports";
import type { Clock, ToolAdapter, ToolContext, ToolOutput } from "./ports";
import { dispatchEffect } from "./tool-runner";
import type { DispatchInput } from "./tool-runner";

class ManualClock implements Clock {
  constructor(private ms: number) {}

  now(): Date {
    return new Date(this.ms);
  }

  advance(by: number): void {
    this.ms += by;
  }
}

const owner: Principal = { id: "owner-1", role: "owner", tenantId: "t", projectIds: ["p"] };
const ok: ToolOutput = { ok: true, summary: "done", observation: "done" };

function context(workspace = new InMemoryWorkspace("ws", {})): ToolContext {
  return { workspace, scope: { repo: "r", commit: "c" }, commands: {}, artifacts: new InMemoryArtifactStore() };
}

function adapter(name: string, sideEffect: SideEffectClass, execute: ToolAdapter["execute"]): ToolAdapter {
  const base = defineTool({
    name,
    description: name,
    inputSchema: z.record(z.string(), z.unknown()),
    sideEffect,
    idempotent: false,
    run: () => ok,
  });
  return { descriptor: base.descriptor, execute };
}

function harness(toolName: string, args: unknown, step = 1) {
  const clock = new ManualClock(Date.UTC(2026, 0, 1));
  const ledger = new InMemorySideEffectLedger();
  const approvals = new ApprovalService(new InMemoryApprovalStore(), clock, new SequentialIds(), { ttlMs: 60_000 });
  const { key } = effectKey("run-1", step, toolName, args);
  const subject: ApprovalSubject = {
    runId: "run-1",
    taskId: "task-1",
    step,
    tool: toolName,
    argsSummary: "x",
    idempotencyKey: key,
    scope: { tenantId: "t", projectId: "p", repo: "r", commit: "c" },
    requestedBy: "ada",
  };
  return { clock, ledger, approvals, key, request: approvals.request(subject) };
}

async function dispatch(tool: ToolAdapter, over: Partial<DispatchInput> & Pick<DispatchInput, "ledger" | "grants">) {
  return dispatchEffect({
    runId: "run-1",
    step: 1,
    args: { body: "hi" },
    ctx: context(),
    approvalId: null,
    approvalMarks: [],
    clock: new ManualClock(Date.UTC(2026, 0, 1)),
    timeoutMs: 5_000,
    tool,
    ...over,
  });
}

describe("tool runner", () => {
  it("records a mutation as intended before executing it, and a second dispatch does not execute it again", async () => {
    const workspace = new InMemoryWorkspace("ws", {});
    const ledger = new InMemorySideEffectLedger();
    const seen: string[] = [];
    let calls = 0;
    const tool = adapter("write_note", "workspace_write", async () => {
      calls += 1;
      seen.push(...ledger.list().map((record) => record.state));
      const prev = workspace.read("note.txt") ?? "";
      workspace.write("note.txt", `${prev}x`);
      return ok;
    });

    const first = await dispatch(tool, { ledger, grants: new InMemoryApprovalStore(), ctx: context(workspace) });
    const second = await dispatch(tool, { ledger, grants: new InMemoryApprovalStore(), ctx: context(workspace) });

    expect(first).toMatchObject({ kind: "executed", key: effectKey("run-1", 1, "write_note", { body: "hi" }).key });
    expect(seen).toEqual(["intended"]);
    expect(second).toMatchObject({ kind: "replayed", state: "committed", output: ok });
    expect(calls).toBe(1);
    expect(workspace.read("note.txt")).toBe("x");
    expect(ledger.list().map((record) => record.state)).toEqual(["committed"]);
  });

  it("does not execute a duplicate while the first attempt is still intended, nor after it fails", async () => {
    const ledger = new InMemorySideEffectLedger();
    let calls = 0;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finish: (output: ToolOutput) => void = () => {};
    const tool = adapter("write_note", "workspace_write", () => {
      calls += 1;
      release?.();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const grants = new InMemoryApprovalStore();

    const first = dispatch(tool, { ledger, grants });
    await started;
    const inflight = await dispatch(tool, { ledger, grants });
    expect(inflight).toMatchObject({ kind: "replayed", state: "intended", output: null });
    expect(calls).toBe(1);

    finish({ ok: false, summary: "rejected", observation: "rejected" });
    await expect(first).resolves.toMatchObject({ kind: "executed", output: { ok: false } });
    const again = await dispatch(tool, { ledger, grants });
    expect(again).toMatchObject({ kind: "replayed", state: "failed" });
    expect(calls).toBe(1);
  });

  it("blocks an external write that has no approval, and does not ledger or execute it", async () => {
    const ledger = new InMemorySideEffectLedger();
    const execute = vi.fn(async () => ok);
    const tool = adapter("post_comment", "external_write", execute);
    const result = await dispatch(tool, { ledger, grants: new InMemoryApprovalStore() });
    expect(result).toMatchObject({ kind: "blocked", reason: "approval_required" });
    expect(execute).not.toHaveBeenCalled();
    expect(ledger.list()).toEqual([]);
  });

  it.each([
    ["pending", (approvals: ApprovalService, id: string) => approvals.get(id)],
    ["denied", (approvals: ApprovalService, id: string) => approvals.deny(owner, id, "no")],
    ["expired", (approvals: ApprovalService, id: string, clock: ManualClock) => (clock.advance(60_000), approvals.expireDue()[0])],
  ] as const)("blocks an external write whose approval is %s", async (reason, decide) => {
    const args = { body: "hi" };
    const { clock, ledger, approvals, request } = harness("post_comment", args);
    decide(approvals, request.id, clock);
    const execute = vi.fn(async () => ok);
    const result = await dispatch(adapter("post_comment", "external_write", execute), {
      ledger,
      grants: approvals.store,
      approvalId: request.id,
      clock,
      args,
    });
    expect(result).toMatchObject({ kind: "blocked", reason: reason === "expired" ? "approval_expired" : reason === "denied" ? "approval_denied" : "approval_pending" });
    expect(execute).not.toHaveBeenCalled();
    expect(ledger.list()).toEqual([]);
  });

  it("executes an approved external write once, and a replay of that key does not execute it again", async () => {
    const args = { body: "hi" };
    const { clock, ledger, approvals, request } = harness("post_comment", args);
    approvals.approve(owner, request.id);
    let calls = 0;
    const tool = adapter("post_comment", "external_write", async () => {
      calls += 1;
      expect(ledger.list()[0]?.state).toBe("intended");
      return ok;
    });
    const input = { ledger, grants: approvals.store, approvalId: request.id, clock, args };
    expect(await dispatch(tool, input)).toMatchObject({ kind: "executed" });
    expect(await dispatch(tool, input)).toMatchObject({ kind: "replayed", state: "committed" });
    expect(calls).toBe(1);
  });

  it("blocks a policy-marked action with no grant, including one that is not an external write", async () => {
    const ledger = new InMemorySideEffectLedger();
    const execute = vi.fn(async () => ok);
    const tool = adapter("write_note", "workspace_write", execute);
    const result = await dispatch(tool, { ledger, grants: new InMemoryApprovalStore(), approvalMarks: ["write_note"] });
    expect(result).toMatchObject({ kind: "blocked", reason: "approval_required" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not ledger a read", async () => {
    const ledger = new InMemorySideEffectLedger();
    const tool = adapter("read_file", "read_only", async () => ok);
    const result = await dispatch(tool, { ledger, grants: new InMemoryApprovalStore() });
    expect(result).toMatchObject({ kind: "executed", key: null });
    expect(ledger.list()).toEqual([]);
  });

  it("fails a timed-out mutation closed and will not dispatch it again", async () => {
    const ledger = new InMemorySideEffectLedger();
    let calls = 0;
    let finish: (output: ToolOutput) => void = () => {};
    const tool = adapter("write_note", "workspace_write", () => {
      calls += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const grants = new InMemoryApprovalStore();
    const first = await dispatch(tool, { ledger, grants, timeoutMs: 15 });
    expect(first).toMatchObject({ kind: "executed", output: { ok: false, summary: "tool timed out" } });
    expect(ledger.list()[0]?.state).toBe("failed");
    finish(ok);
    await dispatch(tool, { ledger, grants, timeoutMs: 15 });
    expect(calls).toBe(1);
  });

  it("records an infra failure and does not retry the mutation", async () => {
    const ledger = new InMemorySideEffectLedger();
    let calls = 0;
    const tool = adapter("write_note", "workspace_write", async () => {
      calls += 1;
      throw new InfraFailureError("docker daemon unreachable");
    });
    const grants = new InMemoryApprovalStore();
    const first = await dispatch(tool, { ledger, grants });
    expect(first.kind === "executed" && first.infraFailure?.message).toBe("docker daemon unreachable");
    expect(ledger.list()[0]?.state).toBe("failed");
    await dispatch(tool, { ledger, grants });
    expect(calls).toBe(1);
  });

  it("hands a worker crash back to the caller, leaves the row intended, and does not run the mutation again", async () => {
    const ledger = new InMemorySideEffectLedger();
    let calls = 0;
    const tool = adapter("write_note", "workspace_write", async () => {
      calls += 1;
      throw new WorkerCrash();
    });
    const grants = new InMemoryApprovalStore();
    await expect(dispatch(tool, { ledger, grants })).rejects.toBeInstanceOf(WorkerCrash);
    expect(ledger.list().map((record) => record.state)).toEqual(["intended"]);
    expect(await dispatch(tool, { ledger, grants })).toMatchObject({ kind: "replayed", state: "intended", output: null });
    expect(calls).toBe(1);
  });
});
