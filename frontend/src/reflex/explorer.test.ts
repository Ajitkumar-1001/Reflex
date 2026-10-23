import { describe, expect, it } from "vitest";
import { ReflexError } from "./access";
import { MemoryExplorer } from "./explorer";
import { LESSON_TEXT, LessonFollowingModel, Lab, PRINCIPALS, PROJECT, arithmeticTask } from "./memory-fixture";

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "ok";
  } catch (e) {
    return e instanceof ReflexError ? e.code : `other:${String(e)}`;
  }
};
const explorerFor = (lab: Lab) => new MemoryExplorer(lab.store.memories, lab.store, lab.embedder, lab.clock);

async function learned() {
  const lab = new Lab();
  const failed = await lab.run({ op: "add", task: arithmeticTask("add", { id: "task-add-1", version: 3, split: "train" }) });
  const procedural = (await lab.store.memories.find({ tenantId: "tenant-local", projectId: PROJECT, kinds: ["procedural"] }))[0];
  await lab.service().decide(PRINCIPALS.owner, procedural.id, { decision: "approve", reasonCode: "reviewed" });
  const used = await lab.run({ op: "mul", task: arithmeticTask("mul", { id: "task-mul-1", version: 2, split: "test" }) });
  return { lab, failed, used, procedural, explorer: explorerFor(lab) };
}

describe("memory explorer: search (GET /v1/memories/search)", () => {
  it("finds a memory by an exact identifier and by a paraphrase, with scores, and never returns vectors", async () => {
    const lab = new Lab();
    await lab.seed({ id: "m-client", text: "After editing schema.prisma run the documented command pnpm gen:client before the type checker" });
    await lab.seed({ id: "m-op", text: LESSON_TEXT });
    const explorer = explorerFor(lab);
    const exact = await explorer.search(PRINCIPALS.viewer, { projectId: PROJECT, q: "gen:client" });
    expect(exact.items.map((i) => i.memory.id)).toEqual(["m-client"]);
    expect(exact.items[0].score).toBeGreaterThan(0);
    expect(JSON.stringify(exact)).not.toContain("embedding");
    const op = await explorer.search(PRINCIPALS.viewer, { projectId: PROJECT, q: "operator follows the function name" });
    expect(op.items[0].memory.id).toBe("m-op");
  });

  it("shows only approved memory by default, but lets a reader inspect other states on request", async () => {
    const lab = new Lab();
    await lab.seed({ id: "m-ok", text: LESSON_TEXT });
    await lab.seed({ id: "m-cand", text: LESSON_TEXT, lifecycleState: "candidate" });
    await lab.seed({ id: "m-quar", text: LESSON_TEXT, lifecycleState: "quarantined" });
    const explorer = explorerFor(lab);
    expect((await explorer.search(PRINCIPALS.viewer, { projectId: PROJECT, q: "operator function name" })).items.map((i) => i.memory.id)).toEqual(["m-ok"]);
    const all = await explorer.search(PRINCIPALS.viewer, { projectId: PROJECT, q: "operator function name", states: ["approved", "candidate", "quarantined"] });
    expect(all.items.map((i) => i.memory.id).sort()).toEqual(["m-cand", "m-ok", "m-quar"]);
  });

  it("filters by kind and caps k at 20 (§15.1)", async () => {
    const lab = new Lab();
    for (let i = 0; i < 25; i++) await lab.seed({ id: `m${String(i).padStart(2, "0")}`, text: `${LESSON_TEXT} number ${i}`, kind: i === 0 ? "semantic" : "procedural" });
    const explorer = explorerFor(lab);
    expect((await explorer.search(PRINCIPALS.viewer, { projectId: PROJECT, q: "operator function name", k: 100 })).items).toHaveLength(20);
    expect((await explorer.search(PRINCIPALS.viewer, { projectId: PROJECT, q: "operator function name", kind: "semantic" })).items.map((i) => i.memory.id)).toEqual(["m00"]);
  });

  it("answers not_found for a project the principal has no grant on, and exposes nothing about it", async () => {
    const lab = new Lab();
    await lab.seed({ id: "m1", text: LESSON_TEXT });
    expect(await code(explorerFor(lab).search(PRINCIPALS.otherProjectOwner, { projectId: PROJECT, q: "operator" }))).toBe("not_found");
  });
});

describe("memory explorer: detail (GET /v1/memories/{id}, US-2)", () => {
  it("shows provenance, the gate decision, audit history and usage outcomes", async () => {
    const { lab, failed, used, procedural, explorer } = await learned();
    await lab.service().recordFeedback(PRINCIPALS.owner, procedural.id, { runId: used.run.id, cited: true, followed: true, outcomeEffect: "helped" });
    const detail = await explorer.get(PRINCIPALS.viewer, procedural.id);
    expect(detail.memory).toMatchObject({ id: procedural.id, kind: "procedural", lifecycleState: "approved" });
    expect(detail.provenance.runs).toEqual([{ runId: failed.run.id, taskId: "task-add-1", outcome: "verified_failure", outcomeReason: "checks_failed" }]);
    expect(detail.provenance.evaluations).toEqual([expect.objectContaining({ evaluationId: failed.evaluation?.id, verdict: "verified_failure" })]);
    expect(detail.history.map((h) => [h.from, h.to, h.reasonCode, h.actor])).toEqual([
      [null, "candidate", "inferred_claim", "write-gate"],
      ["candidate", "approved", "reviewed", "ajit"],
      ["approved", "approved", "feedback_helped", "ajit"],
    ]);
    expect(detail.gate).toMatchObject({ result: "APPROVE", reviewer: "ajit" });
    expect(detail.usage).toMatchObject({ helpful: 1, harmful: 0 });
    expect(detail.usage.uses.map((u) => u.outcomeEffect)).toContain("helped");
    expect(detail.usage.uses).toContainEqual({ runId: used.run.id, citedInPlan: true, followed: false, outcomeEffect: "unknown" });
    expect(detail.flags).toEqual({ expired: false, idle: false, sourceQuarantined: false, needsReverification: false });
    expect(JSON.stringify(detail)).not.toContain("embedding");
  });

  it("flags what makes retrieval skip a memory: expiry, idleness, quarantined source, re-verification", async () => {
    const { lab, failed, procedural, explorer } = await learned();
    lab.clock.advanceDays(91);
    expect((await explorer.get(PRINCIPALS.viewer, procedural.id)).flags).toMatchObject({ expired: true, needsReverification: true });
    await lab.service().quarantine(PRINCIPALS.owner, { sourceRunId: failed.run.id }, { reason: "bad" });
    expect((await explorer.get(PRINCIPALS.viewer, procedural.id)).flags.sourceQuarantined).toBe(true);
    await lab.seed({ id: "m-epi", kind: "episodic", text: "old attempt" });
    lab.clock.advanceDays(200);
    expect((await explorer.get(PRINCIPALS.viewer, "m-epi")).flags.idle).toBe(true);
  });

  it("walks the supersession chain in both directions", async () => {
    const lab = new Lab();
    await lab.seed({ id: "v1", text: LESSON_TEXT });
    await lab.seed({ id: "v2", text: `${LESSON_TEXT} v2`, supersedes: "v1" });
    await lab.seed({ id: "v3", text: `${LESSON_TEXT} v3`, supersedes: "v2" });
    const explorer = explorerFor(lab);
    expect((await explorer.get(PRINCIPALS.viewer, "v3")).supersession).toEqual({ supersedes: ["v2", "v1"], supersededBy: null });
    expect((await explorer.get(PRINCIPALS.viewer, "v1")).supersession).toEqual({ supersedes: [], supersededBy: "v2" });
  });

  it("is not_found for an unknown memory or another project's, so existence does not leak", async () => {
    const { explorer, procedural } = await learned();
    expect(await code(explorer.get(PRINCIPALS.viewer, "mem-999"))).toBe("not_found");
    expect(await code(explorer.get(PRINCIPALS.otherProjectOwner, procedural.id))).toBe("not_found");
  });
});

describe("memory explorer: review queue (GET /v1/review-queue, US-3)", () => {
  it("lists held candidates oldest first with the gate's reason codes, and drops them once decided", async () => {
    const lab = new Lab();
    await lab.run({ op: "add", task: arithmeticTask("add", { id: "task-add-1", version: 3, split: "train" }) });
    await lab.run({ op: "sub", task: arithmeticTask("sub", { id: "task-sub-1", version: 3, split: "train" }) });
    const explorer = explorerFor(lab);
    const queue = await explorer.reviewQueue(PRINCIPALS.viewer, { projectId: PROJECT });
    expect(queue.items.map((i) => i.candidate.kind)).toEqual(["procedural", "procedural"]);
    expect(queue.items.every((i) => i.gate.result === "REVIEW_REQUIRED" && i.gate.reasonCodes.length > 0)).toBe(true);
    expect(queue.items[0].createdAt <= queue.items[1].createdAt).toBe(true);
    await lab.service().decide(PRINCIPALS.owner, queue.items[0].candidate.id, { decision: "reject", reasonCode: "no" });
    expect((await explorer.reviewQueue(PRINCIPALS.viewer, { projectId: PROJECT })).items.map((i) => i.candidate.id)).toEqual([queue.items[1].candidate.id]);
  });

  it("paginates with an opaque cursor and rejects a forged one", async () => {
    const lab = new Lab();
    for (let i = 0; i < 5; i++) await lab.seed({ id: `c${i}`, text: `${LESSON_TEXT} ${i}`, lifecycleState: "candidate", gateDecision: { result: "REVIEW_REQUIRED", reasonCodes: ["human_review_required"], judgeModel: null, reviewer: null, decidedAt: lab.clock.now().toISOString() } });
    const explorer = explorerFor(lab);
    const first = await explorer.reviewQueue(PRINCIPALS.owner, { projectId: PROJECT, limit: 2 });
    expect(first.items.map((i) => i.candidate.id)).toEqual(["c0", "c1"]);
    const second = await explorer.reviewQueue(PRINCIPALS.owner, { projectId: PROJECT, limit: 2, cursor: first.next_cursor });
    expect(second.items.map((i) => i.candidate.id)).toEqual(["c2", "c3"]);
    const last = await explorer.reviewQueue(PRINCIPALS.owner, { projectId: PROJECT, limit: 2, cursor: second.next_cursor });
    expect(last.items.map((i) => i.candidate.id)).toEqual(["c4"]);
    expect(last.next_cursor).toBeUndefined();
    expect(await code(explorer.reviewQueue(PRINCIPALS.owner, { projectId: PROJECT, cursor: "not-a-cursor" }))).toBe("validation_error");
  });

  it("is hidden from principals without a grant on the project", async () => {
    const lab = new Lab();
    expect(await code(explorerFor(lab).reviewQueue(PRINCIPALS.otherProjectOwner, { projectId: PROJECT }))).toBe("not_found");
  });
});

describe("memory explorer: run memory (US-2)", () => {
  it("shows what a run retrieved, what it cited, and the retrieval snapshot it pinned", async () => {
    const { used, procedural, explorer } = await learned();
    const inspected = await explorer.runMemory(PRINCIPALS.viewer, used.run.id);
    expect(inspected.retrieval).toMatchObject({ mode: "hybrid", indexVersion: "mem-index-1" });
    expect(inspected.context.map((c) => c.memoryId)).toContain(procedural.id);
    expect(inspected.uses).toContainEqual({ memoryId: procedural.id, citedInPlan: true, followed: false, outcomeEffect: "unknown" });
    expect(inspected.playbookVersion).toBeNull();
    expect(await code(explorer.runMemory(PRINCIPALS.otherProjectOwner, used.run.id))).toBe("not_found");
    expect(await code(explorer.runMemory(PRINCIPALS.viewer, "run-999"))).toBe("not_found");
  });

  it("shows nothing injected for a memory-off run", async () => {
    const lab = new Lab();
    const { run } = await lab.run({ op: "add", task: arithmeticTask("add", { id: "task-add-1" }), model: new LessonFollowingModel("add") });
    const inspected = await explorerFor(lab).runMemory(PRINCIPALS.viewer, run.id);
    expect(inspected).toMatchObject({ retrieval: { mode: "disabled" }, context: [], uses: [] });
  });
});
