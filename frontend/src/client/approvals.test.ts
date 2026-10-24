import { describe, expect, it } from "vitest";
import {
  ApprovalClientError,
  MOCK_APPROVAL_SEED,
  approvalNotice,
  createMockApprovalsClient,
  parseApprovalStatus,
  parseDecisionForm,
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

describe("parseDecisionForm", () => {
  const good = { id: "apr-1", decision: "approve", reason: "diff is local" };

  it("accepts a decision and trims the reason", () => {
    expect(parseDecisionForm(good)).toEqual({ ok: true, id: "apr-1", decision: "approve", reason: "diff is local" });
    expect(parseDecisionForm({ ...good, decision: "deny", reason: "  wrong remote  " })).toEqual({
      ok: true,
      id: "apr-1",
      decision: "deny",
      reason: "wrong remote",
    });
  });

  it("rejects a missing, non-text, or empty id, and an id over 128 characters", () => {
    for (const id of [null, undefined, "", new File(["x"], "x.txt")]) {
      expect(parseDecisionForm({ ...good, id })).toEqual({ ok: false, message: "Missing approval id." });
    }
    expect(parseDecisionForm({ ...good, id: "a".repeat(128) })).toMatchObject({ ok: true });
    expect(parseDecisionForm({ ...good, id: "a".repeat(129) })).toEqual({ ok: false, message: "Approval id is too long." });
  });

  it("rejects anything but approve or deny", () => {
    for (const decision of [null, undefined, "", "delete", "APPROVE"]) {
      expect(parseDecisionForm({ ...good, decision })).toEqual({ ok: false, message: "Choose approve or deny." });
    }
  });

  it("requires a reason and enforces the form's 240-character cap on the server", () => {
    for (const reason of [null, undefined, "", "   "]) {
      expect(parseDecisionForm({ ...good, reason })).toEqual({ ok: false, message: "A decision needs a reason." });
    }
    expect(parseDecisionForm({ ...good, reason: "r".repeat(240) })).toMatchObject({ ok: true });
    expect(parseDecisionForm({ ...good, reason: `  ${"r".repeat(240)}  ` })).toMatchObject({ ok: true, reason: "r".repeat(240) });
    expect(parseDecisionForm({ ...good, reason: "r".repeat(241) })).toEqual({
      ok: false,
      message: "A reason is at most 240 characters.",
    });
  });

  it("reports the first problem in field order: id, then decision, then reason", () => {
    expect(parseDecisionForm({ id: null, decision: null, reason: null })).toEqual({ ok: false, message: "Missing approval id." });
    expect(parseDecisionForm({ id: "apr-1", decision: null, reason: null })).toEqual({ ok: false, message: "Choose approve or deny." });
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
