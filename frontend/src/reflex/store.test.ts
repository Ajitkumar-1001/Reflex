import { describe, expect, it } from "vitest";
import { FIXTURE_POLICY } from "./fixture";
import { Lab, arithmeticTask, labPolicy } from "./memory-fixture";
import { FrozenMemoryError, StaleVersionError } from "./ports";
import { FrozenMemoryRepository, InMemoryMemoryRepository, InMemoryStore } from "./store";

describe("InMemoryMemoryRepository (the memories collection, DEC-08 stand-in)", () => {
  const record = async (lab: Lab, id: string, over = {}) => lab.seed({ id, text: `lesson ${id}`, ...over });

  it("pre-filters on tenant and project: a query cannot span scopes", async () => {
    const lab = new Lab();
    await record(lab, "m1");
    await record(lab, "m2", { projectId: "project-other" });
    await record(lab, "m3", { tenantId: "tenant-other" });
    const found = await lab.store.memories.find({ tenantId: "tenant-local", projectId: "project-fixture" });
    expect(found.map((m) => m.id)).toEqual(["m1"]);
  });

  it("filters by lifecycle state and kind", async () => {
    const lab = new Lab();
    await record(lab, "m1");
    await record(lab, "m2", { lifecycleState: "candidate" });
    await record(lab, "m3", { kind: "episodic" });
    const f = { tenantId: "tenant-local", projectId: "project-fixture" };
    expect((await lab.store.memories.find({ ...f, lifecycleStates: ["approved"] })).map((m) => m.id).sort()).toEqual(["m1", "m3"]);
    expect((await lab.store.memories.find({ ...f, kinds: ["episodic"] })).map((m) => m.id)).toEqual(["m3"]);
  });

  it("validates on insert and returns copies, so a caller cannot edit stored state", async () => {
    const lab = new Lab();
    const stored = await record(lab, "m1");
    await expect(lab.store.memories.insert({ ...stored, id: "bad", confidence: 3 })).rejects.toThrow();
    await expect(lab.store.memories.insert(stored)).rejects.toThrow(/duplicate/);
    const read = await lab.store.memories.get("m1");
    if (!read) throw new Error("missing");
    read.text = "tampered";
    expect((await lab.store.memories.get("m1"))?.text).toBe("lesson m1");
  });

  it("updates only on the expected version, and the loser gets StaleVersionError (PRD §9.6)", async () => {
    const lab = new Lab();
    const m = await record(lab, "m1");
    await lab.store.memories.replace({ ...m, version: 2, text: "edited" }, 1);
    await expect(lab.store.memories.replace({ ...m, version: 2, text: "racing" }, 1)).rejects.toBeInstanceOf(StaleVersionError);
    await expect(lab.store.memories.replace({ ...m, version: 5 }, 2)).rejects.toBeInstanceOf(StaleVersionError);
    expect((await lab.store.memories.get("m1"))?.text).toBe("edited");
  });

  it("freezing makes reads pass and every write throw (FR-28)", async () => {
    const inner = new InMemoryMemoryRepository();
    const lab = new Lab();
    const m = await record(lab, "m1");
    await inner.insert(m);
    const frozen = new FrozenMemoryRepository(inner);
    expect((await frozen.get("m1"))?.id).toBe("m1");
    expect(await frozen.find({ tenantId: m.tenantId, projectId: m.projectId })).toHaveLength(1);
    expect(() => frozen.insert()).toThrow(FrozenMemoryError);
    expect(() => frozen.replace()).toThrow(FrozenMemoryError);
  });
});

describe("InMemoryStore (the other five collections)", () => {
  it("records a run with its task, policy, evaluation and gapless trace, and serves them back", async () => {
    const lab = new Lab();
    const task = arithmeticTask("add", { id: "task-add-1" });
    const { run, evaluation } = await lab.run({ op: "add", task, memory: false });
    expect((await lab.store.getRun(run.id))?.outcome).toBe("verified_failure");
    expect((await lab.store.getTask(task.id))?.id).toBe(task.id);
    expect((await lab.store.getEvaluation(evaluation?.id ?? ""))?.runId).toBe(run.id);
    expect((await lab.store.getPolicy("policy-p1-memory", 1))?.version).toBe(1);
    const trace = await lab.store.getEvents(run.id);
    expect(trace.map((e) => e.sequence)).toEqual(trace.map((_, i) => i + 1));
  });

  it("enforces the (run_id, sequence) index on appended events", async () => {
    const lab = new Lab();
    const { run } = await lab.run({ op: "add", task: arithmeticTask("add", { id: "task-add-1" }), memory: false });
    const next = await lab.store.nextSequence(run.id);
    const event = { id: "e", runId: run.id, actor: { kind: "system", id: "x" }, timestamp: "2026-01-01T00:00:00.000Z", type: "reflection_skipped", redactedPayload: { reason: "memory_disabled" } } as const;
    await expect(lab.store.appendEvent({ ...event, sequence: next + 3 })).rejects.toThrow(/index/);
    await lab.store.appendEvent({ ...event, sequence: next });
    expect(await lab.store.nextSequence(run.id)).toBe(next + 1);
  });

  it("enforces the (experiment, arm, task, trial) unique index on runs", async () => {
    const lab = new Lab();
    const policy = labPolicy(2);
    const task = arithmeticTask("add", { id: "task-add-1", version: 2, split: "test" });
    const first = await lab.run({ op: "add", task, experiment: { experimentId: "exp-1", trialIndex: 0 } });
    expect(first.run).toMatchObject({ experimentId: "exp-1", trialIndex: 0, configArm: "B" });
    const again = await lab.run({ op: "add", task, experiment: { experimentId: "exp-1", trialIndex: 1 } });
    expect(again.run.trialIndex).toBe(1);
    // Re-recording the first slot under a new run id collides.
    const store = new InMemoryStore();
    store.recordRun({ task, policy, run: first.run, events: first.events, evaluation: first.evaluation });
    const clash = { ...again.run, trialIndex: 0 };
    expect(() => store.recordRun({ task, policy, run: clash, events: again.events, evaluation: again.evaluation })).toThrow(/experiment slot/);
    expect(FIXTURE_POLICY.id).not.toBe(policy.id);
  });

  it("derives quarantined runs from the last event on each run's own trace", async () => {
    const lab = new Lab();
    const { run } = await lab.run({ op: "add", task: arithmeticTask("add", { id: "task-add-1" }), memory: false });
    const base = { id: "", runId: run.id, actor: { kind: "user", id: "ajit" }, timestamp: "2026-01-01T00:00:00.000Z", type: "quarantine_recorded" } as const;
    const payload = { selector: "run" as const, memoryIds: [] as string[], runIds: [run.id], reason: "bad" };
    await lab.store.appendEvent({ ...base, id: "q1", sequence: await lab.store.nextSequence(run.id), redactedPayload: { ...payload, restored: false } });
    expect((await lab.store.quarantinedRunIds()).has(run.id)).toBe(true);
    await lab.store.appendEvent({ ...base, id: "q2", sequence: await lab.store.nextSequence(run.id), redactedPayload: { ...payload, restored: true } });
    expect((await lab.store.quarantinedRunIds()).has(run.id)).toBe(false);
  });
});
