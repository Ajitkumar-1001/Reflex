import { describe, expect, it } from "vitest";
import {
  ApprovalClientError,
  MOCK_APPROVAL_SEED,
  approvalNotice,
  createMockApprovalsClient,
  parseApprovalStatus,
} from "./approvals";

const clock = () => "2026-02-02T00:00:00.000Z";

describe("parseApprovalStatus", () => {
  it("treats a missing, blank, or all value as no filter", () => {
    expect(parseApprovalStatus(undefined)).toEqual({ ok: true });
    expect(parseApprovalStatus("")).toEqual({ ok: true });
    expect(parseApprovalStatus("  ")).toEqual({ ok: true });
    expect(parseApprovalStatus("all")).toEqual({ ok: true });
  });

  it("accepts the four ledger statuses and rejects anything else", () => {
    expect(parseApprovalStatus(" pending ")).toEqual({ ok: true, status: "pending" });
    expect(parseApprovalStatus("approved")).toEqual({ ok: true, status: "approved" });
    expect(parseApprovalStatus("denied")).toEqual({ ok: true, status: "denied" });
    expect(parseApprovalStatus("expired")).toEqual({ ok: true, status: "expired" });
    expect(parseApprovalStatus("rejected")).toEqual({
      ok: false,
      message: "Status must be pending, approved, denied, or expired.",
    });
    expect(parseApprovalStatus(["pending", "denied"])).toEqual({
      ok: false,
      message: "status must be a single value.",
    });
  });
});

describe("approvalNotice", () => {
  it("renders the two decision codes and drops anything else", () => {
    expect(approvalNotice("approved", "apr-push-add")).toBe("apr-push-add was approved.");
    expect(approvalNotice("denied", "apr-summarizer")).toBe("apr-summarizer was denied.");
    expect(approvalNotice("deleted", "apr-push-add")).toBeNull();
    expect(approvalNotice("approved", "run-1")).toBeNull();
    expect(approvalNotice(["approved"], "apr-push-add")).toBeNull();
  });
});

describe("mock approvals client", () => {
  it("lists newest first and filters by status without mutating the seed", async () => {
    const client = createMockApprovalsClient({ now: clock });
    const all = await client.list();
    expect(all.map((item) => item.id)).toEqual(["apr-webhook-sub", "apr-push-add", "apr-push-mul", "apr-summarizer"]);
    expect(all.map((item) => item.status)).toEqual(["pending", "pending", "approved", "denied"]);
    expect((await client.list({ status: "pending" })).map((item) => item.id)).toEqual(["apr-webhook-sub", "apr-push-add"]);
    expect((await client.list({ status: "approved" })).map((item) => item.id)).toEqual(["apr-push-mul"]);
    expect((await client.list({ status: "denied" })).map((item) => item.id)).toEqual(["apr-summarizer"]);
    all[0].status = "denied";
    expect((await client.list({ status: "pending" })).map((item) => item.id)).toContain("apr-webhook-sub");
    expect(MOCK_APPROVAL_SEED.find((item) => item.id === "apr-push-add")?.status).toBe("pending");
  });

  it("approves and denies a pending row once, then refuses a second decision", async () => {
    const client = createMockApprovalsClient({ now: clock });
    const approved = await client.decide("apr-push-add", "approve", { actor: " dashboard ", reason: " diff is local " });
    expect(approved).toMatchObject({
      status: "approved",
      decidedAt: "2026-02-02T00:00:00.000Z",
      decidedBy: "dashboard",
      reason: "diff is local",
    });
    const denied = await client.decide("apr-webhook-sub", "deny", { actor: "dashboard", reason: "callback host is unknown" });
    expect(denied.status).toBe("denied");
    await expect(client.decide("apr-push-add", "deny", { actor: "dashboard", reason: "again" })).rejects.toMatchObject({
      code: "already_decided",
    });
    expect((await client.list({ status: "pending" })).map((item) => item.id)).toEqual([]);
  });

  it("reports a missing id and a blank actor or reason", async () => {
    const client = createMockApprovalsClient({ now: clock });
    await expect(client.decide("apr-missing", "approve", { actor: "dashboard", reason: "ok" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(client.decide("apr-push-add", "approve", { actor: " ", reason: "ok" })).rejects.toMatchObject({
      code: "validation_error",
    });
    await expect(client.decide("apr-push-add", "approve", { actor: "dashboard", reason: " " })).rejects.toMatchObject({
      code: "validation_error",
    });
    expect((await client.list({ status: "pending" })).map((item) => item.id)).toContain("apr-push-add");
  });

  it("rejects a duplicated seed id", () => {
    const row = MOCK_APPROVAL_SEED[0];
    expect(() => createMockApprovalsClient({ seed: [row, row] })).toThrow(ApprovalClientError);
  });
});
