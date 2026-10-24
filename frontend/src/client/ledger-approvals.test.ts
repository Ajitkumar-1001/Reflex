import { describe, expect, it } from "vitest";
import type { Principal } from "../reflex/access";
import { SequentialIds } from "../reflex/adapters";
import { ApprovalService, InMemoryApprovalStore } from "../reflex/approval";
import type { ApprovalSubject } from "../reflex/approval";
import { fixtureRegistry } from "../reflex/fixture";
import type { Clock } from "../reflex/ports";
import { ApprovalClientError } from "./approvals";
import { createLedgerApprovalsClient, getApprovalsClient } from "./ledger-approvals";

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
const owner: Principal = { id: "owner-1", role: "owner", tenantId: "t", projectIds: ["p"] };
const scope = { tenantId: "t", projectId: "p", repo: "r", commit: "c" };

function subject(over: Partial<ApprovalSubject> = {}): ApprovalSubject {
  return {
    runId: "run-1",
    taskId: "task-1",
    step: 1,
    tool: "write_file",
    argsSummary: '{"path":"a.ts"}',
    idempotencyKey: "run-1:1:x",
    scope,
    requestedBy: "ada",
    ...over,
  };
}

function setup(operator: Principal = owner) {
  const clock = new ManualClock(Date.UTC(2026, 0, 1));
  const approvals = new ApprovalService(new InMemoryApprovalStore(), clock, new SequentialIds(), { ttlMs: TTL_MS });
  const client = createLedgerApprovalsClient({ approvals, registry: fixtureRegistry(), operator });
  return { clock, approvals, client };
}

describe("ledger approvals client", () => {
  it("maps a real request to the page's record, taking the effect class from the tool registry", async () => {
    const { approvals, client } = setup();
    const known = approvals.request(subject({ tool: "write_file" }));
    const unknown = approvals.request(subject({ tool: "post_comment", idempotencyKey: "run-1:2:y", step: 2 }));
    expect(await client.list()).toEqual(
      expect.arrayContaining([
        {
          id: known.id,
          effect: "workspace_write",
          tool: "write_file",
          summary: '{"path":"a.ts"}',
          runId: "run-1",
          taskId: "task-1",
          requestedAt: known.requestedAt,
          status: "pending",
          decidedAt: null,
          decidedBy: null,
          reason: null,
        },
      ]),
    );
    // a tool the registry does not know is shown as the strictest class
    expect((await client.list()).find((item) => item.id === unknown.id)?.effect).toBe("external_write");
  });

  it("lists newest first and filters by status", async () => {
    const { approvals, clock, client } = setup();
    const first = approvals.request(subject());
    clock.advance(1_000);
    const second = approvals.request(subject({ step: 2, idempotencyKey: "run-1:2:y" }));
    clock.advance(1_000);
    const third = approvals.request(subject({ step: 3, idempotencyKey: "run-1:3:z" }));
    await client.decide(second.id, "approve", { actor: "dash", reason: "ok" });
    expect((await client.list()).map((item) => item.id)).toEqual([third.id, second.id, first.id]);
    expect((await client.list({ status: "pending" })).map((item) => item.id)).toEqual([third.id, first.id]);
    expect((await client.list({ status: "approved" })).map((item) => item.id)).toEqual([second.id]);
    expect(await client.list({ status: "denied" })).toEqual([]);
  });

  it("reads a lapsed deadline as expired, not pending", async () => {
    const { approvals, clock, client } = setup();
    const request = approvals.request(subject());
    clock.advance(TTL_MS);
    expect(await client.list({ status: "pending" })).toEqual([]);
    expect(await client.list({ status: "expired" })).toMatchObject([
      { id: request.id, status: "expired", decidedBy: "system", reason: "approval expired" },
    ]);
  });

  it("records the actor label and the reason on the service's record, then refuses a second decision", async () => {
    const { approvals, client } = setup();
    const request = approvals.request(subject());
    const approved = await client.decide(request.id, "approve", { actor: " dashboard ", reason: " diff is local " });
    expect(approved).toMatchObject({ status: "approved", decidedBy: "dashboard", reason: "diff is local" });
    expect(approvals.get(request.id)).toMatchObject({ status: "approved", decidedBy: "dashboard", reason: "diff is local" });
    await expect(client.decide(request.id, "deny", { actor: "dashboard", reason: "again" })).rejects.toMatchObject({
      code: "already_decided",
    });
    expect(approvals.get(request.id)?.status).toBe("approved");
  });

  it("denies with the reason, and a decision after the deadline is refused and closes the request as expired", async () => {
    const { approvals, clock, client } = setup();
    const denied = approvals.request(subject());
    expect(await client.decide(denied.id, "deny", { actor: "dashboard", reason: "wrong remote" })).toMatchObject({
      status: "denied",
      reason: "wrong remote",
    });
    const late = approvals.request(subject({ step: 2, idempotencyKey: "run-1:2:y" }));
    clock.advance(TTL_MS);
    await expect(client.decide(late.id, "approve", { actor: "dashboard", reason: "late" })).rejects.toMatchObject({
      code: "already_decided",
    });
    expect(approvals.get(late.id)?.status).toBe("expired");
  });

  it("enforces the service's role check: a viewer cannot decide, and the request stays pending", async () => {
    const { approvals, client } = setup({ ...owner, role: "viewer" });
    const request = approvals.request(subject());
    await expect(client.decide(request.id, "approve", { actor: "dashboard", reason: "ok" })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(approvals.get(request.id)?.status).toBe("pending");
  });

  it("hides a request outside the operator's tenant and project, and refuses to decide it", async () => {
    const { approvals, client } = setup();
    const mine = approvals.request(subject());
    const theirs = approvals.request(subject({ step: 2, idempotencyKey: "run-9:2:q", scope: { ...scope, tenantId: "other" } }));
    expect((await client.list()).map((item) => item.id)).toEqual([mine.id]);
    await expect(client.decide(theirs.id, "approve", { actor: "dashboard", reason: "ok" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(approvals.get(theirs.id)?.status).toBe("pending");
  });

  it("reports a missing id, a blank actor or reason, and a bad status filter as client errors", async () => {
    const { approvals, client } = setup();
    const request = approvals.request(subject());
    await expect(client.decide("apr-missing", "approve", { actor: "dashboard", reason: "ok" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(client.decide(request.id, "approve", { actor: " ", reason: "ok" })).rejects.toMatchObject({ code: "validation_error" });
    await expect(client.decide(request.id, "approve", { actor: "dashboard", reason: " " })).rejects.toMatchObject({
      code: "validation_error",
    });
    await expect(client.list({ status: "bogus" as never })).rejects.toBeInstanceOf(ApprovalClientError);
    expect(approvals.get(request.id)?.status).toBe("pending");
  });
});

describe("the dashboard's shared client", () => {
  it("serves the seeded demo requests from one store, and a decision is recorded under the action's actor", async () => {
    const client = getApprovalsClient();
    expect(getApprovalsClient()).toBe(client);

    const all = await client.list();
    expect(all.map((item) => item.status).sort()).toEqual(["approved", "denied", "pending", "pending"]);
    expect(all.every((item) => ["run-1", "run-2", "run-3"].includes(item.runId))).toBe(true);
    expect(all.find((item) => item.status === "approved")).toMatchObject({ decidedBy: "ajit", effect: "external_write" });

    const [pending] = await client.list({ status: "pending" });
    const decided = await client.decide(pending.id, "deny", { actor: "dashboard-operator", reason: "not now" });
    expect(decided).toMatchObject({ status: "denied", decidedBy: "dashboard-operator", reason: "not now" });
    expect(await client.list({ status: "pending" })).toHaveLength(1);
  });
});
