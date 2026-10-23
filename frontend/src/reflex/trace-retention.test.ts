import { describe, expect, it } from "vitest";
import type { EvaluationResult, MemoryRecord, RunEvent } from "./contracts";
import type { Clock, IdGenerator } from "./ports";
import { DAY_MS } from "./retention";
import { sha256 } from "./text";
import { InMemoryTraceRetentionStore, PROPOSED_TRACE_RETENTION, RetentionSweeper, checkArtifactIntegrity } from "./trace-retention";
import type { TraceRetentionPolicy } from "./trace-retention";

const NOW = "2026-06-01T00:00:00.000Z";
const OLD = "2026-05-01T00:00:00.000Z";
const FRESH = "2026-05-31T12:00:00.000Z";

const clock: Clock = { now: () => new Date(NOW) };

function ids(): IdGenerator {
  const counters = new Map<string, number>();
  return {
    next(prefix: string) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}-${n}`;
    },
  };
}

function policy(overrides: Partial<{ [K in keyof TraceRetentionPolicy]: Partial<TraceRetentionPolicy[K]> }> = {}): TraceRetentionPolicy {
  const unlimited = { ttlMs: null, maxBytes: null };
  return {
    events: { ...unlimited, ...overrides.events },
    artifacts: { ...unlimited, ...overrides.artifacts },
    evaluations: { ...unlimited, ...overrides.evaluations },
  };
}

function event(id: string, runId: string, sequence: number, timestamp: string, summary: string, artifactRef?: string): RunEvent {
  return {
    id,
    runId,
    sequence,
    actor: { kind: "tool", id: "run_command" },
    timestamp,
    ...(artifactRef ? { artifactRef } : {}),
    type: "tool_result",
    redactedPayload: { callId: `call-${id}`, tool: "run_command", ok: true, summary, durationMs: 1 },
  };
}

function evaluation(id: string, runId: string, completedAt: string, extra: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    id,
    runId,
    verdict: "verified_failure",
    outcomeReason: "checks_failed",
    checkBundleHash: "sha256:bundle",
    hiddenChecksPassed: null,
    touchedProtectedPaths: [],
    groundTruthRef: null,
    metrics: {},
    checks: [],
    evaluatorVersion: "check-evaluator-p0",
    evidenceRefs: [],
    completedAt,
    ...extra,
  };
}

function memory(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "lifecycleState" | "sourceRunIds">): MemoryRecord {
  const base: MemoryRecord = {
    id: overrides.id,
    tenantId: "tn",
    projectId: "p",
    kind: "procedural",
    text: "lesson",
    tags: [],
    scope: { conditions: ["c"] },
    preconditions: [],
    lifecycleState: "approved",
    confidence: 0.5,
    sourceRunIds: ["run-seed"],
    evaluationIds: [],
    version: 1,
    supersedes: null,
    lastVerifiedAt: null,
    expiresAt: null,
    embeddingModel: null,
    embeddingVersion: null,
    indexVersion: null,
    helpfulCount: 0,
    harmfulCount: 0,
    gateDecision: null,
    derivedFromMemoryIds: [],
    contentHash: "sha256:memory",
    createdAt: NOW,
    updatedAt: NOW,
    lastUsedAt: null,
  };
  return { ...base, ...overrides };
}

function sweeper(store: InMemoryTraceRetentionStore, rules: TraceRetentionPolicy) {
  return new RetentionSweeper(store, clock, ids(), rules);
}

describe("trace retention policy", () => {
  it("keeps TTL and size as injected configuration (DEC-05 is open)", () => {
    for (const kind of ["events", "artifacts", "evaluations"] as const) {
      expect(PROPOSED_TRACE_RETENTION[kind].ttlMs).toBeGreaterThan(0);
      expect(PROPOSED_TRACE_RETENTION[kind].maxBytes).toBeGreaterThan(0);
    }
    expect(() => new RetentionSweeper(new InMemoryTraceRetentionStore(), clock, ids(), policy({ events: { ttlMs: -1 } }))).toThrow(/ttl/);
  });
});

describe("retention sweeper", () => {
  it("expires unpinned records past the configured TTL and leaves fresh ones", async () => {
    const store = new InMemoryTraceRetentionStore();
    await store.putEvent(event("e-old", "run-old", 1, OLD, "stale output"));
    await store.putEvent(event("e-fresh", "run-fresh", 1, FRESH, "recent output"));
    await store.putArtifact("stale-bytes", OLD);
    await store.putArtifact("fresh-bytes", FRESH);
    await store.putEvaluation(evaluation("ev-old", "run-old", OLD), "closed");
    await store.putEvaluation(evaluation("ev-fresh", "run-fresh", FRESH), "closed");

    const result = await sweeper(store, policy({ events: { ttlMs: DAY_MS }, artifacts: { ttlMs: DAY_MS }, evaluations: { ttlMs: DAY_MS } })).sweep([]);

    expect(result.pruned.map((row) => [row.kind, row.recordId, row.reason]).sort()).toEqual([
      ["artifacts", sha256("stale-bytes"), "ttl"],
      ["evaluations", "ev-old", "ttl"],
      ["events", "e-old", "ttl"],
    ]);
    expect((await store.events()).map((e) => e.id)).toEqual(["e-fresh"]);
    expect((await store.artifacts()).map((a) => a.content)).toEqual(["fresh-bytes"]);
    expect((await store.evaluations()).map((e) => e.evaluation.id)).toEqual(["ev-fresh"]);
    expect((await sweeper(store, policy({ events: { ttlMs: DAY_MS }, artifacts: { ttlMs: DAY_MS }, evaluations: { ttlMs: DAY_MS } })).sweep([])).pruned).toEqual([]);
  });

  it("drops the oldest unpinned records until the kind is within its size cap", async () => {
    const store = new InMemoryTraceRetentionStore();
    const oldest = await store.putArtifact("a".repeat(50), "2026-01-01T00:00:00.000Z");
    const middle = await store.putArtifact("b".repeat(50), "2026-02-01T00:00:00.000Z");
    const newest = await store.putArtifact("c".repeat(50), "2026-03-01T00:00:00.000Z");

    const result = await sweeper(store, policy({ artifacts: { maxBytes: 80 } })).sweep([]);

    expect(result.pruned.map((row) => row.recordId)).toEqual([oldest.id, middle.id]);
    expect(result.pruned.every((row) => row.reason === "size")).toBe(true);
    expect(result.unmetCaps).toEqual([]);
    const left = await store.artifacts();
    expect(left.map((a) => a.id)).toEqual([newest.id]);
    expect(await store.verifyArtifact(newest.id)).toEqual({ ok: true, contentHash: newest.contentHash });
  });

  it("keeps a pinned record when the cap can only be met by deleting it", async () => {
    const store = new InMemoryTraceRetentionStore();
    const pinned = await store.putArtifact("p".repeat(50), "2026-01-01T00:00:00.000Z");
    const other = await store.putArtifact("q".repeat(50), "2026-02-01T00:00:00.000Z");
    await store.putEvent(event("e-pin", "run-pin", 1, OLD, "kept", pinned.id));
    await store.putEvaluation(evaluation("ev-pin", "run-pin", OLD), "closed");

    const result = await sweeper(
      store,
      policy({ artifacts: { ttlMs: DAY_MS, maxBytes: 40 }, events: { ttlMs: DAY_MS }, evaluations: { ttlMs: DAY_MS } }),
    ).sweep([memory({ id: "m-approved", lifecycleState: "approved", sourceRunIds: ["run-pin"], evaluationIds: ["ev-pin"] })]);

    expect((await store.artifacts()).map((a) => a.id)).toEqual([pinned.id]);
    expect(result.pruned.map((row) => row.recordId)).toEqual([other.id]);
    expect(result.held).toContainEqual({ kind: "artifacts", recordId: pinned.id, pin: "approved_provenance", reason: "ttl" });
    expect(result.unmetCaps).toEqual(["artifacts"]);
    expect(await store.verifyArtifact(pinned.id)).toEqual({ ok: true, contentHash: pinned.contentHash });
  });

  it("keeps records named by an approved memory and by an open evaluation", async () => {
    const store = new InMemoryTraceRetentionStore();
    const cited = await store.putArtifact("cited-output", OLD);
    const loose = await store.putArtifact("loose-output", OLD);
    const judged = await store.putArtifact("judged-output", OLD);
    await store.putEvent(event("e-src-1", "run-src", 1, OLD, "first"));
    await store.putEvent(event("e-src-2", "run-src", 2, OLD, "second", cited.id));
    await store.putEvent(event("e-other", "run-other", 1, OLD, "unrelated"));
    await store.putEvent(event("e-cited", "run-cited", 4, OLD, "named by the evaluation"));
    await store.putEvent(event("e-open", "run-open", 1, OLD, "under an open evaluation"));
    await store.putEvent(event("e-closed", "run-closed", 1, OLD, "closed evaluation's trace"));
    await store.putEvaluation(evaluation("ev-src", "run-src", OLD), "closed");
    await store.putEvaluation(
      evaluation("ev-open", "run-open", OLD, {
        checks: [{ name: "hidden", passed: false, artifactRef: judged.id }],
        evidenceRefs: ["event:run-cited:4"],
      }),
      "open",
    );
    await store.putEvaluation(evaluation("ev-closed", "run-closed", OLD), "closed");

    const result = await sweeper(store, policy({ events: { ttlMs: DAY_MS }, artifacts: { ttlMs: DAY_MS }, evaluations: { ttlMs: DAY_MS } })).sweep([
      memory({ id: "m-approved", lifecycleState: "approved", sourceRunIds: ["run-src"], evaluationIds: ["ev-src"] }),
      memory({ id: "m-candidate", lifecycleState: "candidate", sourceRunIds: ["run-other"], evaluationIds: ["ev-closed"] }),
    ]);

    expect((await store.events()).map((e) => e.id).sort()).toEqual(["e-cited", "e-open", "e-src-1", "e-src-2"]);
    expect((await store.evaluations()).map((e) => e.evaluation.id).sort()).toEqual(["ev-open", "ev-src"]);
    expect((await store.artifacts()).map((a) => a.content).sort()).toEqual(["cited-output", "judged-output"]);
    expect(result.pruned.map((row) => row.recordId).sort()).toEqual(["e-closed", "e-other", "ev-closed", loose.id].sort());
    expect(result.held).toContainEqual({ kind: "events", recordId: "e-src-1", pin: "approved_provenance", reason: "ttl" });
    expect(result.held).toContainEqual({ kind: "evaluations", recordId: "ev-open", pin: "open_evaluation", reason: "ttl" });
    expect(result.held).toContainEqual({ kind: "events", recordId: "e-cited", pin: "open_evaluation", reason: "ttl" });
    expect(result.held.some((row) => row.recordId === "e-other")).toBe(false);
  });

  it("writes one audit event per prune and does not copy the record body", async () => {
    const store = new InMemoryTraceRetentionStore();
    const secret = "super-secret-tool-output-9f3a";
    const artifact = await store.putArtifact(secret, OLD);
    await store.putEvent(event("e-redacted", "run-1", 1, OLD, `[redacted: secret detected] ticket-98765`));

    const result = await sweeper(store, policy({ events: { ttlMs: DAY_MS }, artifacts: { ttlMs: DAY_MS } })).sweep([]);

    expect(result.pruned).toHaveLength(2);
    const audits = await store.audits();
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.type)).toEqual(["retention_pruned", "retention_pruned"]);
    expect(audits.map((a) => a.actor)).toEqual([
      { kind: "system", id: "retention-sweeper" },
      { kind: "system", id: "retention-sweeper" },
    ]);
    const eventAudit = audits.find((a) => a.redactedPayload.recordId === "e-redacted");
    const artifactAudit = audits.find((a) => a.redactedPayload.recordId === artifact.id);
    expect(eventAudit?.redactedPayload).toMatchObject({ kind: "events", reason: "ttl", redacted: true, runId: "run-1", contentHash: null });
    expect(artifactAudit?.redactedPayload).toMatchObject({ kind: "artifacts", reason: "ttl", redacted: false, contentHash: artifact.contentHash, runId: null });
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain("ticket-98765");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("[redacted:");
  });

  it("leaves a surviving redacted payload unchanged", async () => {
    const store = new InMemoryTraceRetentionStore();
    const summary = "[redacted: secret detected]";
    await store.putEvent(event("e-keep", "run-keep", 1, FRESH, summary));
    await store.putEvent(event("e-drop", "run-drop", 1, OLD, "gone"));

    await sweeper(store, policy({ events: { ttlMs: DAY_MS } })).sweep([]);

    const kept = (await store.events())[0];
    expect(kept.redactedPayload).toEqual({ callId: "call-e-keep", tool: "run_command", ok: true, summary, durationMs: 1 });
  });
});

describe("artifact integrity", () => {
  it("detects a content hash mismatch and accepts intact bytes after retention", async () => {
    const store = new InMemoryTraceRetentionStore();
    const record = await store.putArtifact("echo hello", FRESH);
    const stale = await store.putArtifact("old output", OLD);
    expect(record.id).toBe(record.contentHash);
    expect(record.contentHash).toBe(sha256("echo hello"));

    const result = await sweeper(store, policy({ artifacts: { ttlMs: DAY_MS } })).sweep([]);
    expect(result.pruned.map((row) => row.recordId)).toEqual([stale.id]);
    expect(await store.verifyArtifact(record.id)).toEqual({ ok: true, contentHash: record.contentHash });

    const tampered = "echo hello\nchanged";
    expect(checkArtifactIntegrity({ content: tampered, contentHash: record.contentHash })).toEqual({
      ok: false,
      expected: record.contentHash,
      actual: sha256(tampered),
    });
  });

  it("does not refresh storedAt when the same bytes are stored again", async () => {
    const store = new InMemoryTraceRetentionStore();
    const first = await store.putArtifact("same", OLD);
    const second = await store.putArtifact("same", FRESH);
    expect(second.storedAt).toBe(first.storedAt);
    const result = await sweeper(store, policy({ artifacts: { ttlMs: DAY_MS } })).sweep([]);
    expect(result.pruned.map((row) => row.recordId)).toEqual([first.id]);
  });
});
