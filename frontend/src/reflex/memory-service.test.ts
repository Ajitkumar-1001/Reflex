import { describe, expect, it } from "vitest";
import { MemoryService } from "./memory-service";
import { LessonFollowingModel, Lab, LESSON_TEXT, OTHER_PROJECT, PRINCIPALS, PROJECT, TASK_CLASS, TENANT, arithmeticTask } from "./memory-fixture";
import { ReflexError } from "./access";
import { PROPOSED_RETENTION } from "./retention";
import type { MemoryRecord } from "./contracts";

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "ok";
  } catch (e) {
    return e instanceof ReflexError ? e.code : `other:${String(e)}`;
  }
};

async function world() {
  const lab = new Lab();
  const failed = await lab.run({ op: "add", task: arithmeticTask("add", { id: "task-add-1", split: "train" }), memory: false });
  const solved = await lab.run({ op: "mul", task: arithmeticTask("mul", { id: "task-mul-1", split: "train" }), model: new LessonFollowingModel("mul", true), memory: false });
  const service = lab.service();
  const candidate = (id = "m1", over: Partial<MemoryRecord> = {}) =>
    lab.seed({ id, text: LESSON_TEXT, lifecycleState: "candidate", lastVerifiedAt: null, sourceRunIds: [failed.run.id], evaluationIds: [failed.evaluation?.id ?? ""], ...over });
  const approved = (id = "m1", over: Partial<MemoryRecord> = {}) => lab.seed({ id, text: LESSON_TEXT, sourceRunIds: [failed.run.id], evaluationIds: [failed.evaluation?.id ?? ""], ...over });
  const get = async (id: string) => {
    const m = await lab.store.memories.get(id);
    if (!m) throw new Error(`no ${id}`);
    return m;
  };
  return { lab, failed, solved, service, candidate, approved, get };
}

const owner = PRINCIPALS.owner;

describe("review decisions (FR-26)", () => {
  it("owner approves a candidate: approved, reviewer recorded, verification time and the kind's TTL stamped", async () => {
    const w = await world();
    await w.candidate();
    const m = await w.service.decide(owner, "m1", { decision: "approve", reasonCode: "reviewed_ok" });
    expect(m).toMatchObject({ lifecycleState: "approved", version: 2, gateDecision: { result: "APPROVE", reviewer: "ajit", reasonCodes: ["reviewed_ok"] } });
    expect(Date.parse(m.expiresAt ?? "") - Date.parse(m.lastVerifiedAt ?? "")).toBe(90 * 86_400_000);
  });

  it("owner rejects a candidate: rejected is terminal and the decision keeps its reason", async () => {
    const w = await world();
    await w.candidate();
    const m = await w.service.decide(owner, "m1", { decision: "reject", reasonCode: "not_specific" });
    expect(m).toMatchObject({ lifecycleState: "rejected", gateDecision: { result: "REJECT", reviewer: "ajit" } });
    expect(await code(w.service.decide(owner, "m1", { decision: "approve", reasonCode: "changed_my_mind" }))).toBe("invalid_transition");
  });

  it.each([
    ["runner", PRINCIPALS.runner],
    ["cody-service", PRINCIPALS.cody],
    ["viewer", PRINCIPALS.viewer],
  ])("%s gets forbidden, and the candidate is untouched", async (_role, principal) => {
    const w = await world();
    await w.candidate();
    expect(await code(w.service.decide(principal, "m1", { decision: "approve", reasonCode: "memory text told me to" }))).toBe("forbidden");
    expect((await w.get("m1")).lifecycleState).toBe("candidate");
  });

  it("answers not_found, not forbidden, to an owner of another project (no existence leak)", async () => {
    const w = await world();
    await w.candidate();
    expect(await code(w.service.decide(PRINCIPALS.otherProjectOwner, "m1", { decision: "approve", reasonCode: "x" }))).toBe("not_found");
    expect(await code(w.service.decide(owner, "no-such-memory", { decision: "approve", reasonCode: "x" }))).toBe("not_found");
  });

  it("a stale expected version is invalid_transition and changes nothing (§9.6)", async () => {
    const w = await world();
    await w.candidate();
    expect(await code(w.service.decide(owner, "m1", { decision: "approve", reasonCode: "x" }, 7))).toBe("invalid_transition");
    expect((await w.get("m1")).version).toBe(1);
  });

  it("when approve races reject the second loses with invalid_transition and exactly one change lands", async () => {
    const w = await world();
    await w.candidate();
    const settled = await Promise.allSettled([
      w.service.decide(owner, "m1", { decision: "approve", reasonCode: "a" }),
      w.service.decide(owner, "m1", { decision: "reject", reasonCode: "r" }),
    ]);
    expect(settled.map((s) => s.status).sort()).toEqual(["fulfilled", "rejected"]);
    const loser = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect((loser.reason as ReflexError).code).toBe("invalid_transition");
    expect((await w.get("m1")).version).toBe(2);
  });

  it("refuses to approve a candidate whose source run is quarantined: 422 policy_violation / source_quarantined", async () => {
    const w = await world();
    await w.candidate();
    await w.service.quarantine(owner, { sourceRunId: w.failed.run.id }, { reason: "bad run" });
    const error = await w.service.decide(owner, "m1", { decision: "approve", reasonCode: "x" }).catch((e) => e);
    expect(error).toMatchObject({ code: "policy_violation", details: { reason: "source_quarantined" } });
    expect((await w.get("m1")).lifecycleState).toBe("candidate");
    await w.service.unquarantine(owner, { sourceRunId: w.failed.run.id }, "run was fine");
    expect((await w.service.decide(owner, "m1", { decision: "approve", reasonCode: "x" })).lifecycleState).toBe("approved");
  });
});

describe("lifecycle transitions and decay (FR-22, §9.6)", () => {
  it("only the PRD's transitions are possible", async () => {
    const w = await world();
    await w.candidate();
    expect(await code(w.service.demote("m1", "x"))).toBe("invalid_transition"); // candidate -> demoted
    await w.service.decide(owner, "m1", { decision: "approve", reasonCode: "x" });
    await w.service.retire(owner, "m1", "obsolete");
    expect((await w.get("m1")).lifecycleState).toBe("retired");
    expect(await code(w.service.demote("m1", "x"))).toBe("invalid_transition"); // retired is terminal
    expect(await code(w.service.retire(owner, "m1", "again"))).toBe("invalid_transition");
  });

  it("only the owner may retire", async () => {
    const w = await world();
    await w.approved();
    expect(await code(w.service.retire(PRINCIPALS.runner, "m1", "x"))).toBe("forbidden");
  });

  it("supersedes an approved memory with a successor in the same scope, keeping the chain", async () => {
    const w = await world();
    await w.approved("m-old");
    await w.approved("m-new");
    await w.service.supersede(owner, "m-old", "m-new", "better_lesson");
    expect(await w.get("m-old")).toMatchObject({ lifecycleState: "superseded" });
    expect((await w.get("m-new")).supersedes).toBe("m-old");
    await w.lab.seed({ id: "m-x", text: LESSON_TEXT, projectId: OTHER_PROJECT });
    expect(await code(w.service.supersede(owner, "m-new", "m-x", "x"))).toBe("policy_violation");
  });

  it("expires procedural memory after 90 days and semantic after 180; episodic never expires by time (§9.6)", async () => {
    const w = await world();
    const stamp = async (id: string, kind: "procedural" | "semantic" | "episodic") => {
      const now = w.lab.clock.now();
      const ttl = PROPOSED_RETENTION.ttlDays[kind];
      return w.approved(id, { kind, expiresAt: ttl === undefined ? null : new Date(now.getTime() + ttl * 86_400_000).toISOString() });
    };
    await stamp("m-proc", "procedural");
    await stamp("m-sem", "semantic");
    await stamp("m-epi", "episodic");
    w.lab.clock.advanceDays(91);
    expect(await w.service.expireDue(TENANT, PROJECT)).toEqual(["m-proc"]);
    w.lab.clock.advanceDays(100);
    expect(await w.service.expireDue(TENANT, PROJECT)).toEqual(["m-sem"]);
    expect((await w.get("m-epi")).lifecycleState).toBe("approved");
  });

  it("re-approves an expired or demoted memory only with a verified success from another run in the project (§9.6)", async () => {
    const w = await world();
    await w.approved("m1", { expiresAt: new Date(w.lab.clock.now().getTime() + 1000).toISOString() });
    w.lab.clock.advanceDays(1);
    await w.service.expireDue(TENANT, PROJECT);
    expect((await w.get("m1")).lifecycleState).toBe("expired");
    const evidence = { runId: w.solved.run.id, evaluationId: w.solved.evaluation?.id ?? "" };
    expect(await code(w.service.reverify(PRINCIPALS.runner, "m1", evidence))).toBe("forbidden");
    expect(await code(w.service.reverify(owner, "m1", { runId: w.failed.run.id, evaluationId: w.failed.evaluation?.id ?? "" }))).toBe("policy_violation"); // its own failed source run
    expect(await code(w.service.reverify(owner, "m1", { runId: w.solved.run.id, evaluationId: w.failed.evaluation?.id ?? "" }))).toBe("policy_violation"); // evaluation of another run
    const back = await w.service.reverify(owner, "m1", evidence);
    expect(back.lifecycleState).toBe("approved");
    expect(back.evaluationIds).toContain(evidence.evaluationId);
    expect(Date.parse(back.expiresAt ?? "")).toBeGreaterThan(w.lab.clock.now().getTime());
    expect(await code(w.service.reverify(owner, "m1", evidence))).toBe("invalid_transition"); // already approved
  });

  it("rejects re-verification evidence from a run in another project", async () => {
    const w = await world();
    const foreign = await w.lab.run({ op: "sub", task: arithmeticTask("sub", { id: "task-sub-1", projectId: OTHER_PROJECT }), model: new LessonFollowingModel("sub", true), memory: false });
    await w.approved("m1");
    await w.service.demote("m1", "stale");
    expect(await code(w.service.reverify(owner, "m1", { runId: foreign.run.id, evaluationId: foreign.evaluation?.id ?? "" }))).toBe("policy_violation");
  });

  it("writes an audited memory_lifecycle event on the source run's trace for every change", async () => {
    const w = await world();
    await w.candidate();
    await w.service.decide(owner, "m1", { decision: "approve", reasonCode: "ok" });
    await w.service.retire(owner, "m1", "obsolete");
    const trace = await w.lab.store.getEvents(w.failed.run.id);
    const changes = trace.filter((e) => e.type === "memory_lifecycle").map((e) => (e.type === "memory_lifecycle" ? [e.actor.id, e.redactedPayload.from, e.redactedPayload.to, e.redactedPayload.reasonCode] : []));
    expect(changes).toEqual([["ajit", "candidate", "approved", "ok"], ["ajit", "approved", "retired", "obsolete"]]);
    expect(trace.map((e) => e.sequence)).toEqual(trace.map((_, i) => i + 1));
  });

  it("adds provenance to a memory as a new version without touching its state or confidence", async () => {
    const w = await world();
    await w.approved("m1", { confidence: 0.4 });
    const merged = await w.service.mergeEvidence("m1", { kind: "procedural", lesson: LESSON_TEXT, applicability: { projectId: PROJECT, conditions: ["c"] }, evidenceStatus: "observed", sourceRunIds: [w.solved.run.id], evaluationIds: [w.solved.evaluation?.id ?? ""], evidenceRefs: ["x"], limitations: [], confidence: 0.5 });
    expect(merged).toMatchObject({ version: 2, lifecycleState: "approved", confidence: 0.4 });
    expect(merged.sourceRunIds).toEqual([w.failed.run.id, w.solved.run.id]);
  });

  it("applies the single-run confidence cap and kind TTL when a gated candidate is stored", async () => {
    const w = await world();
    const base = { lesson: LESSON_TEXT, applicability: { projectId: PROJECT, taskClass: TASK_CLASS, conditions: ["c"] }, evidenceStatus: "observed" as const, evaluationIds: [w.failed.evaluation?.id ?? ""], evidenceRefs: ["x"], limitations: ["not here"], confidence: 0.9 };
    const decision = { result: "APPROVE" as const, reasonCodes: ["approved_auto"], judgeModel: null, reviewer: null, decidedAt: w.lab.clock.now().toISOString() };
    const stamp = { embedding: [], model: "m", version: "1", indexVersion: "i" };
    const one = await w.service.insertFromCandidate({ candidate: { ...base, kind: "procedural", sourceRunIds: [w.failed.run.id] }, tenantId: TENANT, decision, state: "approved", stamp });
    const two = await w.service.insertFromCandidate({ candidate: { ...base, kind: "semantic", sourceRunIds: [w.failed.run.id, w.solved.run.id] }, tenantId: TENANT, decision, state: "approved", stamp });
    const cand = await w.service.insertFromCandidate({ candidate: { ...base, kind: "procedural", sourceRunIds: [w.failed.run.id] }, tenantId: TENANT, decision: { ...decision, result: "REVIEW_REQUIRED" }, state: "candidate", stamp });
    expect(one.confidence).toBe(0.5);
    expect(two.confidence).toBe(0.9);
    expect(one.scope.exclusions).toEqual(["not here"]);
    expect([one.lastVerifiedAt === null, one.expiresAt === null]).toEqual([false, false]);
    expect([cand.lastVerifiedAt, cand.expiresAt]).toEqual([null, null]);
    expect(Date.parse(two.expiresAt ?? "") - Date.parse(two.lastVerifiedAt ?? "")).toBe(180 * 86_400_000);
  });
});

describe("quarantine and bulk revert (FR-23, INV-11)", () => {
  it("dry run names the affected memories and changes nothing", async () => {
    const w = await world();
    await w.approved("m1");
    await w.approved("m2", { sourceRunIds: [w.solved.run.id] });
    const dry = await w.service.quarantine(owner, { sourceRunId: w.failed.run.id }, { reason: "bad", dryRun: true });
    expect(dry).toEqual({ affected: 1, memoryIds: ["m1"] });
    expect((await w.get("m1")).lifecycleState).toBe("approved");
    expect((await w.lab.store.quarantinedRunIds()).size).toBe(0);
  });

  it("by source run: quarantines every memory derived from the run, and memories derived from those (playbook rule)", async () => {
    const w = await world();
    await w.approved("m1");
    await w.approved("m2", { sourceRunIds: [w.solved.run.id], derivedFromMemoryIds: ["m1"] });
    await w.approved("m3", { sourceRunIds: [w.solved.run.id] });
    const result = await w.service.quarantine(owner, { sourceRunId: w.failed.run.id }, { reason: "bad run" });
    expect(result.memoryIds.sort()).toEqual(["m1", "m2"]);
    expect((await w.get("m1")).lifecycleState).toBe("quarantined");
    expect((await w.get("m2")).lifecycleState).toBe("quarantined");
    expect((await w.get("m3")).lifecycleState).toBe("approved");
    expect((await w.lab.store.quarantinedRunIds()).has(w.failed.run.id)).toBe(true);
  });

  it("by memory id, by source task and by time range", async () => {
    const w = await world();
    await w.approved("m1");
    await w.approved("m2", { sourceRunIds: [w.solved.run.id] });
    await w.approved("m3", { sourceRunIds: [w.solved.run.id] });
    expect((await w.service.quarantine(owner, { memoryIds: ["m1"] }, { reason: "x" })).memoryIds).toEqual(["m1"]);
    expect((await w.service.quarantine(owner, { sourceTaskId: "task-mul-1" }, { reason: "x" })).memoryIds.sort()).toEqual(["m2", "m3"]);
    const w2 = await world();
    await w2.approved("r1");
    const from = new Date(w2.lab.clock.now().getTime() - 60_000).toISOString();
    const to = new Date(w2.lab.clock.now().getTime() + 60_000).toISOString();
    expect((await w2.service.quarantine(owner, { from, to, projectId: PROJECT }, { reason: "x", dryRun: true })).memoryIds).toEqual(["r1"]);
    const tooWide = new Date(w2.lab.clock.now().getTime() + 31 * 86_400_000).toISOString();
    expect(await code(w2.service.quarantine(owner, { from, to: tooWide, projectId: PROJECT }, { reason: "x" }))).toBe("validation_error");
  });

  it("is owner-only and project-scoped: cody-service, runner, viewer get 403; another project's owner gets 404", async () => {
    const w = await world();
    await w.approved("m1");
    for (const p of [PRINCIPALS.cody, PRINCIPALS.runner, PRINCIPALS.viewer]) {
      expect(await code(w.service.quarantine(p, { memoryIds: ["m1"] }, { reason: "x" }))).toBe("forbidden");
      expect(await code(w.service.unquarantine(p, { memoryIds: ["m1"] }, "x"))).toBe("forbidden");
    }
    expect(await code(w.service.quarantine(PRINCIPALS.otherProjectOwner, { memoryIds: ["m1"] }, { reason: "x" }))).toBe("not_found");
    expect((await w.get("m1")).lifecycleState).toBe("approved");
  });

  it("un-quarantine restores, but not a memory that still has another quarantined source run", async () => {
    const w = await world();
    await w.approved("m-one", { sourceRunIds: [w.failed.run.id] });
    await w.approved("m-two", { sourceRunIds: [w.failed.run.id, w.solved.run.id] });
    await w.service.quarantine(owner, { sourceRunId: w.failed.run.id }, { reason: "x" });
    await w.service.quarantine(owner, { sourceRunId: w.solved.run.id }, { reason: "y" });
    const restored = await w.service.unquarantine(owner, { sourceRunId: w.failed.run.id }, "fine");
    expect(restored.memoryIds).toEqual(["m-one"]);
    expect((await w.get("m-one")).lifecycleState).toBe("approved");
    expect((await w.get("m-two")).lifecycleState).toBe("quarantined");
  });

  it("records an audited event stamped on the run, with the actor and reason", async () => {
    const w = await world();
    await w.approved("m1");
    await w.service.quarantine(owner, { sourceRunId: w.failed.run.id }, { reason: "poisoned train task" });
    const events = (await w.lab.store.getEvents(w.failed.run.id)).filter((e) => e.type === "quarantine_recorded");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { kind: "user", id: "ajit" }, redactedPayload: { selector: "run", runIds: [w.failed.run.id], reason: "poisoned train task", restored: false } });
  });
});

describe("use-feedback (§9.4, §9.5)", () => {
  const feedback = (runId: string, effect: "helped" | "hurt" | "neutral" | "unknown") => ({ runId, cited: true, followed: true, outcomeEffect: effect, evidenceRef: `evaluation:x` });

  it("raises confidence only on an independent confirmation: a helped on a different task, not the source task", async () => {
    const w = await world();
    await w.approved("m1");
    // A second run of the memory's own source task confirms nothing new.
    const rerun = await w.lab.run({ op: "add", task: arithmeticTask("add", { id: "task-add-1", split: "train" }), model: new LessonFollowingModel("add", true), memory: false });
    const same = await w.service.recordFeedback(PRINCIPALS.runner, "m1", feedback(rerun.run.id, "helped"));
    expect(same).toMatchObject({ confidence: 0.5, helpfulCount: 1 });
    const independent = await w.service.recordFeedback(PRINCIPALS.runner, "m1", feedback(w.solved.run.id, "helped"));
    expect(independent).toMatchObject({ confidence: 0.6, helpfulCount: 2, harmfulCount: 0 });
    expect(independent.confidence).toBeLessThanOrEqual(1);
    expect(independent.lastUsedAt).not.toBeNull();
  });

  it("appends a memory_use event to the run it concerns", async () => {
    const w = await world();
    await w.approved("m1");
    await w.service.recordFeedback(PRINCIPALS.cody, "m1", feedback(w.solved.run.id, "neutral"));
    const use = (await w.lab.store.getEvents(w.solved.run.id)).find((e) => e.type === "memory_use");
    expect(use).toMatchObject({ actor: { id: "cody" }, redactedPayload: { memoryId: "m1", citedInPlan: true, followed: true, outcomeEffect: "neutral" } });
  });

  it("demotes a memory that is net-harmful across three runs, transparently (negative transfer, §24)", async () => {
    const w = await world();
    await w.approved("m1");
    for (const runId of [w.failed.run.id, w.solved.run.id]) await w.service.recordFeedback(owner, "m1", feedback(runId, "hurt"));
    expect((await w.get("m1")).lifecycleState).toBe("approved");
    const after = await w.service.recordFeedback(owner, "m1", feedback(w.solved.run.id, "hurt"));
    expect(after).toMatchObject({ lifecycleState: "demoted", harmfulCount: 3 });
    const reasons = (await w.lab.store.getEvents(w.failed.run.id)).flatMap((e) => (e.type === "memory_lifecycle" ? [e.redactedPayload.reasonCode] : []));
    expect(reasons).toContain("net_harmful");
  });

  it("does not demote when helpful evidence outweighs harm", async () => {
    const w = await world();
    await w.approved("m1", { helpfulCount: 5 });
    for (let i = 0; i < 3; i++) await w.service.recordFeedback(owner, "m1", feedback(w.solved.run.id, "hurt"));
    expect((await w.get("m1")).lifecycleState).toBe("approved");
  });

  it("is refused to viewers, and a run in another project is not_found", async () => {
    const w = await world();
    await w.approved("m1");
    expect(await code(w.service.recordFeedback(PRINCIPALS.viewer, "m1", feedback(w.solved.run.id, "helped")))).toBe("forbidden");
    const foreign = await w.lab.run({ op: "sub", task: arithmeticTask("sub", { id: "task-sub-1", projectId: OTHER_PROJECT }), memory: false });
    expect(await code(w.service.recordFeedback(owner, "m1", feedback(foreign.run.id, "helped")))).toBe("not_found");
  });
});

describe("capacity (§9.6)", () => {
  it("alerts at 80% of the soft cap and reports when it is exceeded; the cap is configuration", async () => {
    const w = await world();
    const small = new MemoryService(w.lab.store.memories, w.lab.store, w.lab.clock, w.lab.ids, { ...PROPOSED_RETENTION, capacityPerProject: 5 });
    for (let i = 0; i < 3; i++) await w.approved(`m${i}`);
    expect(await small.capacity(TENANT, PROJECT)).toEqual({ approved: 3, cap: 5, alert: false, overCap: false });
    await w.approved("m3");
    expect(await small.capacity(TENANT, PROJECT)).toMatchObject({ approved: 4, alert: true, overCap: false });
    await w.approved("m4");
    await w.approved("m5");
    expect(await small.capacity(TENANT, PROJECT)).toMatchObject({ approved: 6, overCap: true });
    expect((await w.service.capacity(TENANT, PROJECT)).cap).toBe(2000);
  });
});

