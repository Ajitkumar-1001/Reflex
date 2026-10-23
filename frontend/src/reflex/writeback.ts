import type { GateDecision, MemoryCandidate, MemoryKind } from "./contracts";
import type { WriteGate } from "./gate";
import type { MemoryService } from "./memory-service";
import type { Embedder, ModelUsage } from "./ports";
import type { ScanFinding } from "./scanner";

/*
 * Gated writeback (PRD §7.7, FR-10, FR-28). A candidate is stored only after the write gate has decided:
 * APPROVE becomes an approved memory (or, for a near-duplicate, extra provenance on the existing one),
 * REVIEW_REQUIRED stays a `candidate` for the human queue, and REJECT is kept as a `rejected` record so the
 * decision is auditable but never retrievable. A candidate that tripped the secret scan is stored with its
 * text redacted, so a rejected secret is not written to the database it was rejected from.
 */

export interface WritebackResult {
  memoryId: string;
  decision: GateDecision;
  merged: boolean;
  securityFindings: ScanFinding[];
  judgeUsage: ModelUsage | null;
}

const REDACTED = "[redacted: secret detected]";

function redact(candidate: MemoryCandidate): MemoryCandidate {
  return {
    ...candidate,
    lesson: REDACTED,
    applicability: { ...candidate.applicability, stack: undefined, conditions: [] },
    limitations: [],
    evidenceRefs: candidate.evidenceRefs.map(() => "redacted"),
  };
}

export class MemoryWriteback {
  constructor(
    private readonly deps: {
      service: MemoryService;
      gate: WriteGate;
      embedder: Embedder;
      indexVersion: string;
      tenantId: string;
    },
  ) {}

  async persist(candidate: MemoryCandidate, options: { autoApprove: readonly MemoryKind[]; requiresReview?: boolean }): Promise<WritebackResult> {
    const { service, gate, embedder, indexVersion, tenantId } = this.deps;
    const outcome = await gate.evaluate(candidate, options);
    const { decision } = outcome;
    const base = { decision, securityFindings: outcome.securityFindings, judgeUsage: outcome.judgeUsage };

    if (decision.result === "APPROVE" && outcome.duplicateOf) {
      const merged = await service.mergeEvidence(outcome.duplicateOf, candidate);
      return { ...base, memoryId: merged.id, merged: true };
    }
    const stored = outcome.securityFindings.some((f) => f.code === "secret_detected") ? redact(candidate) : candidate;
    const record = await service.insertFromCandidate({
      candidate: stored,
      tenantId,
      decision,
      state: decision.result === "APPROVE" ? "approved" : decision.result === "REJECT" ? "rejected" : "candidate",
      stamp: { embedding: await embedder.embed(stored.lesson), model: embedder.model, version: embedder.version, indexVersion },
    });
    return { ...base, memoryId: record.id, merged: false };
  }
}
