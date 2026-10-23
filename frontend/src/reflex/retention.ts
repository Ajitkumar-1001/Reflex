import type { MemoryKind } from "./contracts";

/*
 * Retention and learning thresholds. DEC-05 (retention/review) is open: every value below is the PRD v1.4
 * *proposed default* (§9.3, §9.5, §9.6), pending the owner's confirmation, and is injected, never read from a
 * global, so confirming or changing a number changes configuration and nothing else.
 */
export interface RetentionConfig {
  /** Days a verification stays valid, per kind (§9.6). A kind absent here never expires by time. */
  ttlDays: Partial<Record<MemoryKind, number>>;
  /** Episodic records stop being retrieved after this many days without use (§9.6). */
  episodicIdleDays: number;
  /** A memory backed by a single run never exceeds this confidence (§9.3). */
  singleRunConfidenceCap: number;
  /** Confidence gained per independent confirming use. The PRD says confidence rises, not by how much. */
  confidenceStep: number;
  /** Net-harmful use across this many runs demotes a memory (§9.5). */
  harmfulDemotionRuns: number;
  /** Soft cap of approved memories per project, and the share at which to alert (§9.6). */
  capacityPerProject: number;
  capacityAlertRatio: number;
}

export const PROPOSED_RETENTION: RetentionConfig = {
  ttlDays: { procedural: 90, semantic: 180 },
  episodicIdleDays: 180,
  singleRunConfidenceCap: 0.5,
  confidenceStep: 0.1,
  harmfulDemotionRuns: 3,
  capacityPerProject: 2000,
  capacityAlertRatio: 0.8,
};

export const DAY_MS = 86_400_000;
