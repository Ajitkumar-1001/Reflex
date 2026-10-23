import { z } from "zod";
import { EvaluationSchema, EventSchema } from "./contracts";
import type { EvaluationResult, MemoryRecord, RunEvent } from "./contracts";
import type { Clock, IdGenerator } from "./ports";
import { DAY_MS } from "./retention";
import { sha256 } from "./text";

/*
 * Trace, artifact and evaluation retention (PRD §10, §11, DEC-05). DEC-05 is open: v1.4 names the decision
 * and does not give TTL or size figures, so every number lives in an injected `TraceRetentionPolicy`.
 * `PROPOSED_TRACE_RETENTION` is a stand-in, the same way `PROPOSED_RETENTION` is for memories.
 *
 * The sweeper never deletes a record an approved memory's provenance names, or a record an open evaluation
 * cites. Provenance on a stored memory is `sourceRunIds` and `evaluationIds` (evidence refs are not kept on
 * the memory record). An evaluation is "open" only as a retention hold: `EvaluationResult` is a finished
 * verdict and has no such field. A hold pins that evaluation, its run's trace, and the artifacts either one
 * cites. Records past policy that are not pinned are deleted. Each deletion appends one audit event to the
 * retention log, not to the run trace: the trace is what is being deleted, and appending there would break
 * the `(run_id, sequence)` index.
 *
 * Redaction is preserved by omission. Surviving records are not rewritten, and an audit event carries a
 * redaction flag rather than the record body, so a pruned secret cannot reappear in the log.
 */

export const RETENTION_RECORD_KINDS = ["events", "artifacts", "evaluations"] as const;
export type RetentionRecordKind = (typeof RETENTION_RECORD_KINDS)[number];

export interface RetentionKindPolicy {
  /** Age after the record timestamp at which an unpinned record expires. `null` disables expiry by time. */
  ttlMs: number | null;
  /** UTF-8 byte cap for the kind. `null` disables the cap. Oldest unpinned records are removed first. */
  maxBytes: number | null;
}

export interface TraceRetentionPolicy {
  events: RetentionKindPolicy;
  artifacts: RetentionKindPolicy;
  evaluations: RetentionKindPolicy;
}

/**
 * Stand-in caps, not a DEC-05 decision. Events and artifacts follow a 30-day trace window; evaluations follow
 * the 180-day semantic-memory window so a verdict still exists when a later approval cites it. Byte caps are
 * process-local budgets for the in-memory stand-in.
 */
export const PROPOSED_TRACE_RETENTION: TraceRetentionPolicy = {
  events: { ttlMs: 30 * DAY_MS, maxBytes: 8 * 1024 * 1024 },
  artifacts: { ttlMs: 30 * DAY_MS, maxBytes: 64 * 1024 * 1024 },
  evaluations: { ttlMs: 180 * DAY_MS, maxBytes: 4 * 1024 * 1024 },
};

/** `open` is a legal hold. `closed` means the evaluation is subject to the evaluations policy. */
export type EvaluationHold = "open" | "closed";

export interface RetainedEvaluation {
  evaluation: EvaluationResult;
  status: EvaluationHold;
}

export interface ArtifactRecord {
  /** Content address, `sha256:<hex>`, the same form as `InMemoryArtifactStore` and `event.artifactRef`. */
  id: string;
  contentHash: string;
  content: string;
  storedAt: string;
}

export type ArtifactIntegrity = { ok: true; contentHash: string } | { ok: false; expected: string; actual: string };

/** Recompute the content hash. A mismatch means the bytes changed after the hash was recorded. */
export function checkArtifactIntegrity(record: Pick<ArtifactRecord, "content" | "contentHash">): ArtifactIntegrity {
  const actual = sha256(record.content);
  if (actual === record.contentHash) return { ok: true, contentHash: actual };
  return { ok: false, expected: record.contentHash, actual };
}

const REDACTION_MARK = "[redacted:";

const AuditSchema = z.strictObject({
  id: z.string().min(1),
  timestamp: z.iso.datetime(),
  actor: z.strictObject({ kind: z.literal("system"), id: z.string().min(1) }),
  type: z.literal("retention_pruned"),
  redactedPayload: z.strictObject({
    kind: z.enum(RETENTION_RECORD_KINDS),
    recordId: z.string().min(1),
    reason: z.enum(["ttl", "size"]),
    contentHash: z.string().nullable(),
    redacted: z.boolean(),
    bytes: z.int().nonnegative(),
    runId: z.string().nullable(),
  }),
});
export type RetentionAuditEvent = z.infer<typeof AuditSchema>;

export type PinReason = "approved_provenance" | "open_evaluation";

export interface SweepResult {
  pruned: { kind: RetentionRecordKind; recordId: string; reason: "ttl" | "size" }[];
  /** Pinned records the policy would have removed. */
  held: { kind: RetentionRecordKind; recordId: string; pin: PinReason; reason: "ttl" | "size" }[];
  /** Kinds whose surviving pinned bytes still exceed `maxBytes`. Nothing pinned was deleted to meet it. */
  unmetCaps: RetentionRecordKind[];
}

/**
 * The retention collections (DEC-05, DEC-08). An Atlas `events` collection and an object store would
 * implement the same reads, deletes and audit append.
 */
export interface TraceRetentionStore {
  putEvent(event: RunEvent): Promise<void>;
  putArtifact(content: string, storedAt: string): Promise<ArtifactRecord>;
  putEvaluation(evaluation: EvaluationResult, status: EvaluationHold): Promise<void>;
  events(): Promise<readonly RunEvent[]>;
  artifacts(): Promise<readonly ArtifactRecord[]>;
  evaluations(): Promise<readonly RetainedEvaluation[]>;
  audits(): Promise<readonly RetentionAuditEvent[]>;
  deleteEvent(id: string): Promise<void>;
  deleteArtifact(id: string): Promise<void>;
  deleteEvaluation(id: string): Promise<void>;
  appendAudit(event: RetentionAuditEvent): Promise<void>;
  verifyArtifact(id: string): Promise<ArtifactIntegrity>;
}

const copy = <T>(value: T): T => structuredClone(value);
const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

function assertPolicy(policy: TraceRetentionPolicy): void {
  for (const kind of RETENTION_RECORD_KINDS) {
    const rule = policy[kind];
    if (rule.ttlMs !== null && (!Number.isFinite(rule.ttlMs) || rule.ttlMs < 0)) {
      throw new Error(`retention ttl for ${kind} must be null or a finite number >= 0`);
    }
    if (rule.maxBytes !== null && (!Number.isInteger(rule.maxBytes) || rule.maxBytes < 0)) {
      throw new Error(`retention maxBytes for ${kind} must be null or an integer >= 0`);
    }
  }
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  // Unreadable time fails closed: the record is kept rather than expired.
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

export class InMemoryTraceRetentionStore implements TraceRetentionStore {
  private readonly eventMap = new Map<string, RunEvent>();
  private readonly artifactMap = new Map<string, ArtifactRecord>();
  private readonly evaluationMap = new Map<string, RetainedEvaluation>();
  private readonly auditLog: RetentionAuditEvent[] = [];

  async putEvent(event: RunEvent): Promise<void> {
    const valid = EventSchema.parse(event);
    if (this.eventMap.has(valid.id)) throw new Error(`duplicate event id ${valid.id}`);
    this.eventMap.set(valid.id, copy(valid));
  }

  /** First write wins. A second put of the same bytes does not refresh `storedAt`, so a rewrite cannot dodge the TTL. */
  async putArtifact(content: string, storedAt: string): Promise<ArtifactRecord> {
    if (!z.iso.datetime().safeParse(storedAt).success) throw new Error("artifact storedAt must be an ISO timestamp");
    const contentHash = sha256(content);
    const existing = this.artifactMap.get(contentHash);
    if (existing) return copy(existing);
    const record: ArtifactRecord = { id: contentHash, contentHash, content, storedAt };
    this.artifactMap.set(contentHash, copy(record));
    return copy(record);
  }

  async putEvaluation(evaluation: EvaluationResult, status: EvaluationHold): Promise<void> {
    const valid = EvaluationSchema.parse(evaluation);
    if (this.evaluationMap.has(valid.id)) throw new Error(`duplicate evaluation id ${valid.id}`);
    this.evaluationMap.set(valid.id, copy({ evaluation: valid, status }));
  }

  async events(): Promise<readonly RunEvent[]> {
    return [...this.eventMap.values()]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.runId.localeCompare(b.runId) || a.sequence - b.sequence)
      .map(copy);
  }

  async artifacts(): Promise<readonly ArtifactRecord[]> {
    return [...this.artifactMap.values()].sort((a, b) => a.storedAt.localeCompare(b.storedAt) || a.id.localeCompare(b.id)).map(copy);
  }

  async evaluations(): Promise<readonly RetainedEvaluation[]> {
    return [...this.evaluationMap.values()]
      .sort((a, b) => a.evaluation.completedAt.localeCompare(b.evaluation.completedAt) || a.evaluation.id.localeCompare(b.evaluation.id))
      .map(copy);
  }

  async audits(): Promise<readonly RetentionAuditEvent[]> {
    return copy(this.auditLog);
  }

  async deleteEvent(id: string): Promise<void> {
    if (!this.eventMap.delete(id)) throw new Error(`no such event ${id}`);
  }

  async deleteArtifact(id: string): Promise<void> {
    if (!this.artifactMap.delete(id)) throw new Error(`no such artifact ${id}`);
  }

  async deleteEvaluation(id: string): Promise<void> {
    if (!this.evaluationMap.delete(id)) throw new Error(`no such evaluation ${id}`);
  }

  async appendAudit(event: RetentionAuditEvent): Promise<void> {
    const valid = AuditSchema.parse(event);
    if (this.auditLog.some((e) => e.id === valid.id)) throw new Error(`duplicate audit id ${valid.id}`);
    this.auditLog.push(copy(valid));
  }

  async verifyArtifact(id: string): Promise<ArtifactIntegrity> {
    const found = this.artifactMap.get(id);
    if (!found) throw new Error(`no such artifact ${id}`);
    return checkArtifactIntegrity(found);
  }
}

interface Holds {
  runs: Map<string, PinReason>;
  /** `${runId}:${sequence}` for an evidence ref that names one event and not its whole run. */
  events: Map<string, PinReason>;
  evaluations: Map<string, PinReason>;
  artifacts: Map<string, PinReason>;
}

function hold(map: Map<string, PinReason>, id: string, reason: PinReason): void {
  const prev = map.get(id);
  if (prev === undefined || (prev === "open_evaluation" && reason === "approved_provenance")) map.set(id, reason);
}

/** Evidence-ref grammar shared with the write gate: `evaluation:`, `event:<run>:<seq>`, `run:`, plus `sha256:` and `artifact:`. */
function holdRef(holds: Holds, ref: string, reason: PinReason): void {
  if (ref.startsWith("sha256:")) {
    hold(holds.artifacts, ref, reason);
    return;
  }
  const split = ref.indexOf(":");
  if (split <= 0) return;
  const kind = ref.slice(0, split);
  const rest = ref.slice(split + 1);
  if (rest === "") return;
  if (kind === "evaluation") hold(holds.evaluations, rest, reason);
  else if (kind === "run") hold(holds.runs, rest, reason);
  else if (kind === "artifact") hold(holds.artifacts, rest, reason);
  else if (kind === "event") {
    const colon = rest.lastIndexOf(":");
    if (colon <= 0) return;
    const runId = rest.slice(0, colon);
    const sequence = Number(rest.slice(colon + 1));
    if (runId !== "" && Number.isInteger(sequence)) hold(holds.events, `${runId}:${sequence}`, reason);
  }
}

/**
 * Approved provenance pins the source runs and the named evaluations. Open evaluations pin themselves.
 * Either hold then expands to that evaluation's run, its artifact refs, and artifact refs on the held
 * events. Refs inside an unrelated trace are not walked: one citation must not retain every ancestor.
 */
function resolveHolds(memories: readonly MemoryRecord[], events: readonly RunEvent[], evaluations: readonly RetainedEvaluation[]): Holds {
  const holds: Holds = { runs: new Map(), events: new Map(), evaluations: new Map(), artifacts: new Map() };
  for (const memory of memories) {
    if (memory.lifecycleState !== "approved") continue;
    for (const id of memory.sourceRunIds) hold(holds.runs, id, "approved_provenance");
    for (const id of memory.evaluationIds) hold(holds.evaluations, id, "approved_provenance");
  }
  for (const stored of evaluations) {
    if (stored.status === "open") hold(holds.evaluations, stored.evaluation.id, "open_evaluation");
  }

  let size = 0;
  for (;;) {
    for (const stored of evaluations) {
      const reason = holds.evaluations.get(stored.evaluation.id);
      if (reason === undefined) continue;
      hold(holds.runs, stored.evaluation.runId, reason);
      for (const check of stored.evaluation.checks) {
        if (check.artifactRef !== undefined) hold(holds.artifacts, check.artifactRef, reason);
      }
      for (const ref of stored.evaluation.evidenceRefs) holdRef(holds, ref, reason);
      const ground = stored.evaluation.groundTruthRef;
      if (ground !== null && ground.startsWith("sha256:")) hold(holds.artifacts, ground, reason);
    }
    for (const event of events) {
      const reason = holds.runs.get(event.runId) ?? holds.events.get(`${event.runId}:${event.sequence}`);
      if (reason !== undefined && event.artifactRef !== undefined) hold(holds.artifacts, event.artifactRef, reason);
    }
    const next = holds.runs.size + holds.events.size + holds.evaluations.size + holds.artifacts.size;
    if (next === size) return holds;
    size = next;
  }
}

interface SweepItem {
  kind: RetentionRecordKind;
  id: string;
  at: number;
  bytes: number;
  pin: PinReason | null;
  redacted: boolean;
  contentHash: string | null;
  runId: string | null;
}

function byAge(a: SweepItem, b: SweepItem): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function containsRedaction(value: unknown): boolean {
  return JSON.stringify(value).includes(REDACTION_MARK);
}

function planKind(items: readonly SweepItem[], policy: RetentionKindPolicy, now: number): {
  drops: { item: SweepItem; reason: "ttl" | "size" }[];
  held: SweepResult["held"];
  unmet: boolean;
} {
  const drops: { item: SweepItem; reason: "ttl" | "size" }[] = [];
  const held: SweepResult["held"] = [];
  const expired = new Set<string>();
  if (policy.ttlMs !== null) {
    for (const item of items) {
      if (now - item.at < policy.ttlMs) continue;
      if (item.pin) held.push({ kind: item.kind, recordId: item.id, pin: item.pin, reason: "ttl" });
      else expired.add(item.id);
    }
  }
  for (const item of items) if (expired.has(item.id)) drops.push({ item, reason: "ttl" });

  let unmet = false;
  if (policy.maxBytes !== null) {
    const live = items.filter((item) => !expired.has(item.id));
    let bytes = live.reduce((sum, item) => sum + item.bytes, 0);
    if (bytes > policy.maxBytes) {
      for (const item of [...live].sort(byAge)) {
        if (bytes <= policy.maxBytes) break;
        if (item.pin) {
          if (!held.some((row) => row.recordId === item.id)) held.push({ kind: item.kind, recordId: item.id, pin: item.pin, reason: "size" });
          continue;
        }
        drops.push({ item, reason: "size" });
        bytes -= item.bytes;
      }
      unmet = bytes > policy.maxBytes;
    }
  }
  drops.sort((a, b) => byAge(a.item, b.item));
  return { drops, held, unmet };
}

/**
 * Expires and size-caps the three retention collections. Pinned records stay even when that leaves a kind
 * over its cap; `unmetCaps` reports that case. Audit is appended before the delete, so a failure between
 * the two leaves a record that a later sweep will try again rather than a deletion with no audit.
 */
export class RetentionSweeper {
  private readonly policy: TraceRetentionPolicy;

  constructor(
    private readonly store: TraceRetentionStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    policy: TraceRetentionPolicy = PROPOSED_TRACE_RETENTION,
  ) {
    this.policy = copy(policy);
    assertPolicy(this.policy);
  }

  async sweep(memories: readonly MemoryRecord[]): Promise<SweepResult> {
    const now = this.clock.now().getTime();
    const events = await this.store.events();
    const artifacts = await this.store.artifacts();
    const evaluations = await this.store.evaluations();
    const holds = resolveHolds(memories, events, evaluations);

    const eventItems: SweepItem[] = events.map((event) => ({
      kind: "events",
      id: event.id,
      at: timestamp(event.timestamp),
      bytes: utf8Bytes(JSON.stringify(event)),
      pin: holds.runs.get(event.runId) ?? holds.events.get(`${event.runId}:${event.sequence}`) ?? null,
      redacted: containsRedaction(event),
      contentHash: null,
      runId: event.runId,
    }));
    const artifactItems: SweepItem[] = artifacts.map((artifact) => ({
      kind: "artifacts",
      id: artifact.id,
      at: timestamp(artifact.storedAt),
      bytes: utf8Bytes(artifact.content),
      pin: holds.artifacts.get(artifact.id) ?? holds.artifacts.get(artifact.contentHash) ?? null,
      redacted: artifact.content.includes(REDACTION_MARK),
      contentHash: artifact.contentHash,
      runId: null,
    }));
    const evaluationItems: SweepItem[] = evaluations.map((stored) => ({
      kind: "evaluations",
      id: stored.evaluation.id,
      at: timestamp(stored.evaluation.completedAt),
      bytes: utf8Bytes(JSON.stringify(stored.evaluation)),
      pin: holds.evaluations.get(stored.evaluation.id) ?? null,
      redacted: containsRedaction(stored.evaluation),
      contentHash: null,
      runId: stored.evaluation.runId,
    }));

    const planned = [
      planKind(eventItems, this.policy.events, now),
      planKind(artifactItems, this.policy.artifacts, now),
      planKind(evaluationItems, this.policy.evaluations, now),
    ];
    const result: SweepResult = { pruned: [], held: planned.flatMap((p) => p.held), unmetCaps: [] };
    for (const [i, plan] of planned.entries()) {
      const kind = RETENTION_RECORD_KINDS[i];
      if (plan.unmet) result.unmetCaps.push(kind);
      for (const drop of plan.drops) {
        const event: RetentionAuditEvent = {
          id: this.ids.next("audit"),
          timestamp: this.clock.now().toISOString(),
          actor: { kind: "system", id: "retention-sweeper" },
          type: "retention_pruned",
          redactedPayload: {
            kind: drop.item.kind,
            recordId: drop.item.id,
            reason: drop.reason,
            contentHash: drop.item.contentHash,
            redacted: drop.item.redacted,
            bytes: drop.item.bytes,
            runId: drop.item.runId,
          },
        };
        await this.store.appendAudit(event);
        if (drop.item.kind === "events") await this.store.deleteEvent(drop.item.id);
        else if (drop.item.kind === "artifacts") await this.store.deleteArtifact(drop.item.id);
        else await this.store.deleteEvaluation(drop.item.id);
        result.pruned.push({ kind: drop.item.kind, recordId: drop.item.id, reason: drop.reason });
      }
    }
    return result;
  }
}
