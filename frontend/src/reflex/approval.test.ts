import { describe, expect, it } from "vitest";
import { ApprovalService, InMemoryApprovalStore } from "./approval";
import type { ApprovalSubject } from "./approval";
import { ReflexError } from "./access";
import type { Principal, Role } from "./access";
import { SequentialIds } from "./adapters";
import type { Clock } from "./ports";

class ManualClock implements Clock {
  constructor(private ms: number) {}

  now(): Date {
    return new Date(this.ms);
  }

  advance(by: number): void {
    this.ms += by;
  }
}

const scope = { tenantId: "t", projectId: "p", repo: "fixture/fix-add-bug", commit: "abc", paths: ["src"] };
const subject: ApprovalSubject = {
  runId: "run-1",
  taskId: "task-1",
  step: 1,
  tool: "post_comment",
  argsSummary: "{\"body\":\"hi\"}",
  idempotencyKey: "run-1:1:abc",
  scope,
  requestedBy: "ada",
};
const as = (role: Role, id: string = role): Principal => ({ id, role, tenantId: "t", projectIds: ["p"] });
const TTL_MS = 1_000;

function service(clock: ManualClock, onRequest?: (request: { id: string }) => void) {
  return new ApprovalService(new InMemoryApprovalStore(), clock, new SequentialIds(), { ttlMs: TTL_MS, onRequest });
}

const code = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    return error instanceof ReflexError ? error.code : "other";
  }
  return "ok";
};

describe("approval requests", () => {
  it("records who asked, what would run, and the scope, and stays pending", () => {
    const clock = new ManualClock(Date.UTC(2026, 0, 1));
    const request = service(clock).request(subject);
    expect(request).toMatchObject({
      requestedBy: "ada",
      tool: "post_comment",
      argsSummary: "{\"body\":\"hi\"}",
      scope,
      status: "pending",
      decidedBy: null,
      reason: null,
    });
    expect(request.expiresAt).toBe(new Date(clock.now().getTime() + TTL_MS).toISOString());
  });

  it("resumes a waiter only when an owner approves", async () => {
    const approvals = service(new ManualClock(Date.UTC(2026, 0, 1)));
    const request = approvals.request(subject);
    const waiting = approvals.wait(request.id);
    const decided = approvals.approve(as("owner", "owner-1"), request.id);
    await expect(waiting).resolves.toMatchObject({ status: "approved", decidedBy: "owner-1", reason: "approved" });
    expect(decided.status).toBe("approved");
    expect(approvals.get(request.id)?.status).toBe("approved");
  });

  it("deny fails closed and records why", () => {
    const approvals = service(new ManualClock(Date.UTC(2026, 0, 1)));
    const request = approvals.request(subject);
    const decided = approvals.deny(as("owner"), request.id, "out of scope for this task");
    expect(decided).toMatchObject({ status: "denied", decidedBy: "owner", reason: "out of scope for this task" });
    expect(code(() => approvals.approve(as("owner"), request.id))).toBe("invalid_transition");
    expect(approvals.get(request.id)?.status).toBe("denied");
  });

  it("expiry fails closed and records why, and a late approval cannot reopen it", async () => {
    const clock = new ManualClock(Date.UTC(2026, 0, 1));
    const approvals = service(clock);
    const request = approvals.request(subject);
    const waiting = approvals.wait(request.id);
    clock.advance(TTL_MS);
    const expired = approvals.expireDue();
    expect(expired.map((item) => item.id)).toEqual([request.id]);
    expect(expired[0]).toMatchObject({ status: "expired", decidedBy: "system", reason: "approval expired" });
    await expect(waiting).resolves.toMatchObject({ status: "expired" });
    expect(code(() => approvals.approve(as("owner"), request.id))).toBe("invalid_transition");
    expect(approvals.get(request.id)?.status).toBe("expired");
  });

  it("rejects an unauthorized approver and leaves the request pending", () => {
    const approvals = service(new ManualClock(Date.UTC(2026, 0, 1)));
    const request = approvals.request(subject);
    expect(code(() => approvals.approve(as("viewer"), request.id))).toBe("forbidden");
    expect(code(() => approvals.deny(as("runner"), request.id, "no"))).toBe("forbidden");
    expect(code(() => approvals.approve(as("cody-service"), request.id))).toBe("forbidden");
    expect(code(() => approvals.approve({ ...as("owner"), projectIds: ["other"] }, request.id))).toBe("not_found");
    expect(approvals.get(request.id)?.status).toBe("pending");
    expect(approvals.get(request.id)?.decidedBy).toBeNull();
  });

  it("treats an approval attempted after the deadline as expiry, not as a grant", async () => {
    const clock = new ManualClock(Date.UTC(2026, 0, 1));
    const approvals = service(clock);
    const request = approvals.request(subject);
    const waiting = approvals.wait(request.id);
    clock.advance(TTL_MS);
    expect(code(() => approvals.approve(as("owner"), request.id))).toBe("invalid_transition");
    await expect(waiting).resolves.toMatchObject({ status: "expired", reason: "approval expired" });
  });
});
