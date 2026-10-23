import { canTransitionMemory, MemoryRecordSchema } from "./contracts";
import type { GateDecision, LifecycleState, MemoryCandidate, MemoryKind, MemoryRecord } from "./contracts";
import { authorize, canActOn, ReflexError } from "./access";
import type { Principal } from "./access";
import { StaleVersionError } from "./ports";
import type { Clock, IdGenerator, MemoryRepository, RunRecords } from "./ports";
import { DAY_MS, PROPOSED_RETENTION } from "./retention";
import type { RetentionConfig } from "./retention";
import { sha256, tokenize } from "./text";

/*
 * Memory lifecycle (PRD §9.6, INV-11): every state change is a conditional update on `(id, version)`, is
 * attributable, is audited as a `memory_lifecycle` event, and is reversible where the PRD says so. Only
 * `approved` memory is retrievable, so each transition here is also an eligibility change.
 */

export interface EmbeddingStamp {
  embedding: number[];
  model: string;
  version: string;
  indexVersion: string;
}

export type QuarantineSelector =
  | { memoryIds: string[] }
  | { sourceRunId: string }
  | { sourceTaskId: string }
  | { from: string; to: string; projectId: string };

export interface QuarantineResult {
  affected: number;
  memoryIds: string[];
}

const MAX_RANGE_MS = 30 * DAY_MS;

export function contentHash(kind: MemoryKind, projectId: string, text: string): string {
  return sha256(`${kind}\n${projectId}\n${tokenize(text).join(" ")}`);
}

export class MemoryService {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly records: RunRecords,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly retention: RetentionConfig = PROPOSED_RETENTION,
  ) {}

  /** Builds and stores a record for a gated candidate. Approval stamps verification time and the kind's TTL. */
  async insertFromCandidate(input: {
    candidate: MemoryCandidate;
    tenantId: string;
    decision: GateDecision;
    state: Extract<LifecycleState, "candidate" | "approved" | "rejected">;
    stamp: EmbeddingStamp;
  }): Promise<MemoryRecord> {
    const { candidate, tenantId, decision, state, stamp } = input;
    const now = this.clock.now();
    const single = new Set(candidate.sourceRunIds).size === 1;
    const record: MemoryRecord = MemoryRecordSchema.parse({
      id: this.ids.next("mem"),
      tenantId,
      projectId: candidate.applicability.projectId,
      kind: candidate.kind,
      text: candidate.lesson,
      embedding: stamp.embedding,
      tags: [...(candidate.applicability.stack ?? []), ...(candidate.applicability.taskClass ? [candidate.applicability.taskClass] : [])],
      scope: {
        ...(candidate.applicability.stack ? { stack: candidate.applicability.stack } : {}),
        ...(candidate.applicability.taskClass ? { taskClass: candidate.applicability.taskClass } : {}),
        conditions: candidate.applicability.conditions,
        ...(candidate.limitations.length > 0 ? { exclusions: candidate.limitations.filter((l) => l.length > 0) } : {}),
      },
      preconditions: candidate.preconditions ?? [],
      lifecycleState: state,
      confidence: single ? Math.min(candidate.confidence, this.retention.singleRunConfidenceCap) : candidate.confidence,
      sourceRunIds: candidate.sourceRunIds,
      evaluationIds: candidate.evaluationIds,
      version: 1,
      supersedes: null,
      lastVerifiedAt: state === "approved" ? now.toISOString() : null,
      expiresAt: state === "approved" ? this.expiryFor(candidate.kind, now) : null,
      embeddingModel: stamp.model,
      embeddingVersion: stamp.version,
      indexVersion: stamp.indexVersion,
      helpfulCount: 0,
      harmfulCount: 0,
      gateDecision: decision,
      derivedFromMemoryIds: [],
      contentHash: contentHash(candidate.kind, candidate.applicability.projectId, candidate.lesson),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastUsedAt: null,
    });
    await this.repo.insert(record);
    await this.audit(record, null, state, decision.reasonCodes[0] ?? "inserted", { kind: "system", id: "write-gate" });
    return record;
  }

  /** A near-duplicate adds provenance to the existing memory as a new version; its confidence is untouched (§9.3). */
  async mergeEvidence(memoryId: string, candidate: MemoryCandidate): Promise<MemoryRecord> {
    return this.change(memoryId, "duplicate_merged", { kind: "system", id: "write-gate" }, undefined, (m) => ({
      ...m,
      sourceRunIds: [...new Set([...m.sourceRunIds, ...candidate.sourceRunIds])],
      evaluationIds: [...new Set([...m.evaluationIds, ...candidate.evaluationIds])],
    }), { keepState: true });
  }

  // ------------------------------------------------------------- decisions

  /** FR-26: human review of a `REVIEW_REQUIRED` candidate. Only `owner` may decide; a stale version loses (§9.6). */
  async decide(
    principal: Principal,
    memoryId: string,
    decision: { decision: "approve" | "reject"; reasonCode: string; note?: string },
    expectedVersion?: number,
  ): Promise<MemoryRecord> {
    const current = await this.require(memoryId);
    authorize(principal, "decide", current);
    const actor = { kind: "user", id: principal.id } as const;
    const gate: GateDecision = {
      result: decision.decision === "approve" ? "APPROVE" : "REJECT",
      reasonCodes: [decision.reasonCode, ...(current.gateDecision?.reasonCodes ?? [])],
      judgeModel: current.gateDecision?.judgeModel ?? null,
      reviewer: principal.id,
      decidedAt: this.clock.now().toISOString(),
    };
    if (decision.decision === "reject") {
      return this.change(memoryId, decision.reasonCode, actor, expectedVersion, (m) => ({ ...m, lifecycleState: "rejected", gateDecision: gate }));
    }
    const quarantined = await this.records.quarantinedRunIds();
    if (current.sourceRunIds.some((id) => quarantined.has(id))) {
      throw new ReflexError("policy_violation", "a source run of this candidate is quarantined", { reason: "source_quarantined" });
    }
    const now = this.clock.now();
    return this.change(memoryId, decision.reasonCode, actor, expectedVersion, (m) => ({
      ...m,
      lifecycleState: "approved",
      gateDecision: gate,
      lastVerifiedAt: now.toISOString(),
      expiresAt: this.expiryFor(m.kind, now),
    }));
  }

  // ------------------------------------------------------------ transitions

  async demote(memoryId: string, reasonCode: string, actor: { kind: "system" | "user"; id: string } = { kind: "system", id: "lifecycle" }): Promise<MemoryRecord> {
    return this.change(memoryId, reasonCode, actor, undefined, (m) => ({ ...m, lifecycleState: "demoted" }));
  }

  async retire(principal: Principal, memoryId: string, reasonCode: string): Promise<MemoryRecord> {
    const current = await this.require(memoryId);
    authorize(principal, "decide", current);
    return this.change(memoryId, reasonCode, { kind: "user", id: principal.id }, undefined, (m) => ({ ...m, lifecycleState: "retired" }));
  }

  /** Replaces an approved memory with a successor in the same scope; the old version stays as audit history. */
  async supersede(principal: Principal, oldId: string, successorId: string, reasonCode: string): Promise<MemoryRecord> {
    const [old, successor] = [await this.require(oldId), await this.require(successorId)];
    authorize(principal, "decide", old);
    if (successor.projectId !== old.projectId || successor.tenantId !== old.tenantId) {
      throw new ReflexError("policy_violation", "successor is in another scope");
    }
    await this.change(successorId, reasonCode, { kind: "user", id: principal.id }, undefined, (m) => ({ ...m, supersedes: oldId }), { keepState: true });
    return this.change(oldId, reasonCode, { kind: "user", id: principal.id }, undefined, (m) => ({ ...m, lifecycleState: "superseded" }));
  }

  /** Moves every approved memory past its `expiresAt` to `expired` (§9.6 decay). Retrieval also checks the clock, so this is hygiene, not a gate. */
  async expireDue(tenantId: string, projectId: string): Promise<string[]> {
    const now = this.clock.now().getTime();
    const due = (await this.repo.find({ tenantId, projectId, lifecycleStates: ["approved"] })).filter(
      (m) => m.expiresAt !== null && Date.parse(m.expiresAt) <= now,
    );
    for (const m of due) await this.change(m.id, "ttl_elapsed", { kind: "system", id: "lifecycle" }, undefined, (x) => ({ ...x, lifecycleState: "expired" }));
    return due.map((m) => m.id);
  }

  /**
   * `demoted|expired -> approved` only with re-verification evidence (§9.6): a verified_success evaluation of a run on
   * a task in the same project, other than the memory's own source runs. Returns the memory with a fresh TTL.
   */
  async reverify(principal: Principal, memoryId: string, evidence: { runId: string; evaluationId: string }): Promise<MemoryRecord> {
    const current = await this.require(memoryId);
    authorize(principal, "decide", current);
    const [run, evaluation] = [await this.records.getRun(evidence.runId), await this.records.getEvaluation(evidence.evaluationId)];
    const task = run ? await this.records.getTask(run.taskId) : undefined;
    const valid =
      run && evaluation && task && evaluation.runId === run.id && evaluation.verdict === "verified_success" &&
      task.projectId === current.projectId && task.tenantId === current.tenantId && !current.sourceRunIds.includes(run.id);
    if (!valid) throw new ReflexError("policy_violation", "re-verification needs a verified success from another run in this project", { reason: "reverification_evidence_invalid" });
    const now = this.clock.now();
    return this.change(memoryId, "reverified", { kind: "user", id: principal.id }, undefined, (m) => ({
      ...m,
      lifecycleState: "approved",
      evaluationIds: [...new Set([...m.evaluationIds, evaluation.id])],
      lastVerifiedAt: now.toISOString(),
      expiresAt: this.expiryFor(m.kind, now),
    }));
  }

  // ------------------------------------------------------------- quarantine

  /** FR-23: quarantine by memory, source run, source task or time range, with `dryRun`. Derived memories follow (§9.6). */
  async quarantine(principal: Principal, selector: QuarantineSelector, options: { reason: string; dryRun?: boolean }): Promise<QuarantineResult> {
    const { runIds, targets } = await this.resolve(principal, selector, "quarantine");
    const affected = targets.filter((m) => m.lifecycleState === "approved");
    const ids = affected.map((m) => m.id);
    if (options.dryRun) return { affected: ids.length, memoryIds: ids };
    await this.stamp(principal, selector, runIds, targets, options.reason, false);
    for (const m of affected) {
      await this.change(m.id, options.reason, { kind: "user", id: principal.id }, undefined, (x) => ({ ...x, lifecycleState: "quarantined" }));
    }
    return { affected: ids.length, memoryIds: ids };
  }

  /** `quarantined -> approved` is owner-only (§9.6). Restores memories whose every source run is no longer quarantined. */
  async unquarantine(principal: Principal, selector: QuarantineSelector, reason: string): Promise<QuarantineResult> {
    const { runIds, targets } = await this.resolve(principal, selector, "unquarantine");
    const quarantinedBefore = targets.filter((m) => m.lifecycleState === "quarantined");
    await this.stamp(principal, selector, runIds, targets, reason, true);
    const still = await this.records.quarantinedRunIds();
    const restored: string[] = [];
    for (const m of quarantinedBefore) {
      if (m.sourceRunIds.some((id) => still.has(id))) continue;
      await this.change(m.id, reason, { kind: "user", id: principal.id }, undefined, (x) => ({ ...x, lifecycleState: "approved" }));
      restored.push(m.id);
    }
    return { affected: restored.length, memoryIds: restored };
  }

  // --------------------------------------------------------------- feedback

  /**
   * §9.4 use-feedback. Counters move; a `helped` from a task other than the memory's own sources is an independent
   * confirmation and raises confidence; net-harm across the configured number of runs demotes (§9.5).
   */
  async recordFeedback(
    principal: Principal,
    memoryId: string,
    feedback: { runId: string; cited: boolean; followed: boolean; outcomeEffect: "helped" | "hurt" | "neutral" | "unknown"; evidenceRef?: string },
  ): Promise<MemoryRecord> {
    const current = await this.require(memoryId);
    authorize(principal, "feedback", current);
    const run = await this.records.getRun(feedback.runId);
    const task = run ? await this.records.getTask(run.taskId) : undefined;
    if (!run || !task || task.projectId !== current.projectId || task.tenantId !== current.tenantId) {
      throw new ReflexError("not_found", "not found");
    }
    const sourceTasks = new Set(
      (await Promise.all(current.sourceRunIds.map((id) => this.records.getRun(id)))).flatMap((r) => (r ? [r.taskId] : [])),
    );
    const independent = !sourceTasks.has(run.taskId);
    const now = this.clock.now().toISOString();
    const updated = await this.change(memoryId, `feedback_${feedback.outcomeEffect}`, { kind: "user", id: principal.id }, undefined, (m) => ({
      ...m,
      helpfulCount: m.helpfulCount + (feedback.outcomeEffect === "helped" ? 1 : 0),
      harmfulCount: m.harmfulCount + (feedback.outcomeEffect === "hurt" ? 1 : 0),
      confidence:
        feedback.outcomeEffect === "helped" && independent ? Math.min(1, m.confidence + this.retention.confidenceStep) : m.confidence,
      lastUsedAt: now,
    }), { keepState: true });
    await this.records.appendEvent({
      id: this.ids.next("evt"),
      runId: run.id,
      sequence: await this.records.nextSequence(run.id),
      actor: { kind: "user", id: principal.id },
      timestamp: now,
      type: "memory_use",
      redactedPayload: {
        memoryId,
        citedInPlan: feedback.cited,
        followed: feedback.followed,
        outcomeEffect: feedback.outcomeEffect,
        ...(feedback.evidenceRef ? { evidenceRef: feedback.evidenceRef } : {}),
      },
    });
    if (updated.lifecycleState === "approved" && updated.harmfulCount >= this.retention.harmfulDemotionRuns && updated.harmfulCount > updated.helpfulCount) {
      return this.demote(memoryId, "net_harmful");
    }
    return updated;
  }

  /** §9.6 capacity: approved memories against the soft cap. */
  async capacity(tenantId: string, projectId: string): Promise<{ approved: number; cap: number; alert: boolean; overCap: boolean }> {
    const approved = (await this.repo.find({ tenantId, projectId, lifecycleStates: ["approved"] })).length;
    const cap = this.retention.capacityPerProject;
    return { approved, cap, alert: approved >= cap * this.retention.capacityAlertRatio, overCap: approved > cap };
  }

  // ---------------------------------------------------------------- helpers

  private expiryFor(kind: MemoryKind, from: Date): string | null {
    const days = this.retention.ttlDays[kind];
    return days === undefined ? null : new Date(from.getTime() + days * DAY_MS).toISOString();
  }

  private async require(id: string): Promise<MemoryRecord> {
    const found = await this.repo.get(id);
    if (!found) throw new ReflexError("not_found", "not found");
    return found;
  }

  /** Conditional update with lifecycle validation and an audit event. A lost race is `invalid_transition` (409). */
  private async change(
    id: string,
    reasonCode: string,
    actor: { kind: "system" | "user"; id: string },
    expectedVersion: number | undefined,
    mutate: (m: MemoryRecord) => MemoryRecord,
    options: { keepState?: boolean } = {},
  ): Promise<MemoryRecord> {
    const current = await this.require(id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new ReflexError("invalid_transition", `memory ${id} is at version ${current.version}, not ${expectedVersion}`);
    }
    const mutated = mutate(current);
    if (!options.keepState && !canTransitionMemory(current.lifecycleState, mutated.lifecycleState)) {
      throw new ReflexError("invalid_transition", `${current.lifecycleState} -> ${mutated.lifecycleState} is not allowed`);
    }
    const next: MemoryRecord = { ...mutated, version: current.version + 1, updatedAt: this.clock.now().toISOString() };
    try {
      await this.repo.replace(next, current.version);
    } catch (error) {
      if (error instanceof StaleVersionError) throw new ReflexError("invalid_transition", error.message);
      throw error;
    }
    await this.audit(next, current.lifecycleState, next.lifecycleState, reasonCode, actor);
    return next;
  }

  private async audit(record: MemoryRecord, from: LifecycleState | null, to: LifecycleState, reasonCode: string, actor: { kind: "system" | "user"; id: string }): Promise<void> {
    const runId = record.sourceRunIds[0];
    if (!(await this.records.getRun(runId))) return; // a memory whose run was never recorded has no trace to append to
    await this.records.appendEvent({
      id: this.ids.next("evt"),
      runId,
      sequence: await this.records.nextSequence(runId),
      actor,
      timestamp: this.clock.now().toISOString(),
      type: "memory_lifecycle",
      redactedPayload: { memoryId: record.id, from, to, version: record.version, reasonCode },
    });
  }

  /** Resolves a selector to the runs it names and every memory it reaches, transitively through `derivedFromMemoryIds`. */
  private async resolve(
    principal: Principal,
    selector: QuarantineSelector,
    action: "quarantine" | "unquarantine",
  ): Promise<{ runIds: string[]; targets: MemoryRecord[] }> {
    const project = async (tenantId: string, projectId: string) => {
      authorize(principal, action, { tenantId, projectId });
      return this.repo.find({ tenantId, projectId });
    };
    let pool: MemoryRecord[] = [];
    let seeds: MemoryRecord[] = [];
    let runIds: string[] = [];

    if ("memoryIds" in selector) {
      seeds = await Promise.all(selector.memoryIds.map((id) => this.require(id)));
      for (const m of seeds) authorize(principal, action, m);
      if (seeds.length > 0) pool = await project(seeds[0].tenantId, seeds[0].projectId);
    } else if ("sourceRunId" in selector) {
      const run = await this.records.getRun(selector.sourceRunId);
      const task = run && (await this.records.getTask(run.taskId));
      if (!run || !task) throw new ReflexError("not_found", "not found");
      pool = await project(task.tenantId, task.projectId);
      seeds = pool.filter((m) => m.sourceRunIds.includes(run.id));
      runIds = [run.id];
    } else if ("sourceTaskId" in selector) {
      const task = await this.records.getTask(selector.sourceTaskId);
      if (!task) throw new ReflexError("not_found", "not found");
      pool = await project(task.tenantId, task.projectId);
      const runs = await Promise.all(pool.flatMap((m) => m.sourceRunIds).map((id) => this.records.getRun(id)));
      runIds = [...new Set(runs.flatMap((r) => (r && r.taskId === task.id ? [r.id] : [])))];
      seeds = pool.filter((m) => m.sourceRunIds.some((id) => runIds.includes(id)));
    } else {
      const [from, to] = [Date.parse(selector.from), Date.parse(selector.to)];
      if (Number.isNaN(from) || Number.isNaN(to) || to < from || to - from > MAX_RANGE_MS) {
        throw new ReflexError("validation_error", "time range must be ordered and at most 30 days");
      }
      pool = await project(principal.tenantId, selector.projectId);
      seeds = pool.filter((m) => Date.parse(m.createdAt) >= from && Date.parse(m.createdAt) <= to);
    }

    const reached = new Map(seeds.map((m) => [m.id, m]));
    for (let grew = true; grew; ) {
      grew = false;
      for (const m of pool) {
        if (!reached.has(m.id) && m.derivedFromMemoryIds.some((id) => reached.has(id))) {
          reached.set(m.id, m);
          grew = true;
        }
      }
    }
    const targets = [...reached.values()].filter((m) => canActOn(principal, m));
    return { runIds, targets };
  }

  /** Stamps one quarantine/restore event on each named run's own trace, or on the first source run for a memory selector. */
  private async stamp(principal: Principal, selector: QuarantineSelector, runIds: string[], targets: MemoryRecord[], reason: string, restored: boolean): Promise<void> {
    const kind = "memoryIds" in selector ? "memory" : "sourceRunId" in selector ? "run" : "sourceTaskId" in selector ? "task" : "time_range";
    const homes = runIds.length > 0 ? runIds.map((id) => [id, [id]] as const) : [...new Set(targets.map((m) => m.sourceRunIds[0]))].map((id) => [id, []] as const);
    for (const [home, ids] of homes) {
      if (!(await this.records.getRun(home))) continue;
      await this.records.appendEvent({
        id: this.ids.next("evt"),
        runId: home,
        sequence: await this.records.nextSequence(home),
        actor: { kind: "user", id: principal.id },
        timestamp: this.clock.now().toISOString(),
        type: "quarantine_recorded",
        redactedPayload: { selector: kind, memoryIds: targets.map((m) => m.id), runIds: [...ids], reason, restored },
      });
    }
  }
}
