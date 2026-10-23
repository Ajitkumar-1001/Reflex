import { cosine } from "./embedder";
import { GateDecisionSchema, JudgeVerdictSchema, MemoryCandidateSchema } from "./contracts";
import type { EvaluationResult, GateDecision, GateResult, MemoryCandidate, MemoryKind, Run, RunOutcome } from "./contracts";
import { JudgeUnavailableError } from "./ports";
import type { Clock, Embedder, MemoryJudge, MemoryRepository, ModelUsage, RunRecords } from "./ports";
import { normalizeForScan, scanInstructionElevation, scanSecrets } from "./scanner";
import type { ScanFinding } from "./scanner";
import { jaccard, tokenize } from "./text";

/*
 * Memory write gate (PRD §9.3, FR-10, FR-25; INV-01, INV-02, INV-03, INV-04, INV-08). Every candidate is checked in
 * the PRD's order and the strictest result wins: any REJECT beats any REVIEW_REQUIRED beats APPROVE. Deterministic
 * code decides provenance, scope, secrets, instruction elevation and genericity; the model judge (a separate port,
 * DEC-12) only adds a verdict, and an unavailable or malformed judge fails toward review, never toward approval.
 */

/** The closed set of reason codes a decision can carry; tests and dashboards key on these, not on prose. */
export const GATE_REASON_CODES = [
  "provenance_missing",
  "evidence_unresolved",
  "unverified_run",
  "source_quarantined",
  "scope_missing",
  "scope_mismatch",
  "secret_detected",
  "instruction_elevation",
  "hidden_content",
  "generic",
  "hypothesis_not_reusable",
  "inferred_claim",
  "unsupported_claim",
  "judge_unavailable",
  "possible_contradiction",
  "duplicate_merged",
  "requires_review",
  "human_review_required",
  "playbook_delta_review",
  "approved_auto",
] as const;
export type GateReasonCode = (typeof GATE_REASON_CODES)[number];

export interface GateConfig {
  /** A lesson shorter than this many words carries no specific future problem (§9.3 check 4). */
  minLessonWords: number;
  /** Near-duplicate when vector similarity or token overlap reaches these (§9.3 check 6). */
  duplicateCosine: number;
  duplicateJaccard: number;
  /** Overlap at which differing polarity is read as a contradiction. */
  contradictionJaccard: number;
}

/** Stand-in thresholds: v1.4 names the checks but gives no numbers. */
export const DEFAULT_GATE: GateConfig = { minLessonWords: 6, duplicateCosine: 0.93, duplicateJaccard: 0.8, contradictionJaccard: 0.45 };

export interface GateOutcome {
  decision: GateDecision;
  reasons: GateReasonCode[];
  /** Set when the candidate repeats an approved memory: the writeback adds provenance to it instead of storing a second copy. */
  duplicateOf: string | null;
  /** Security-relevant findings (secrets, hidden content, instruction elevation) for the audit stream. */
  securityFindings: ScanFinding[];
  judgeUsage: ModelUsage | null;
}

const PLATITUDE = /^(?:always |please )?(?:write|add|run) (?:more )?tests\b|\bbe careful\b|\bdouble[- ]?check\b|\bbest practices?\b|\bcode quality\b|\bread the (?:docs|documentation)\b/i;
const NEGATION = /\b(?:do not|don't|never|avoid|must not|should not|instead of|rather than)\b/i;

const STRICTNESS: Record<GateResult, number> = { APPROVE: 0, REVIEW_REQUIRED: 1, REJECT: 2 };

const effectiveOutcome = (run: Run, evaluations: readonly EvaluationResult[]): RunOutcome | null =>
  // A run still in REFLECTING has no outcome yet; its evaluation, which the runner records first, decides it.
  run.outcome ?? (run.status === "REFLECTING" ? (evaluations.find((e) => e.runId === run.id)?.verdict ?? null) : null);

export class WriteGate {
  private readonly config: GateConfig;

  constructor(
    private readonly deps: {
      records: RunRecords;
      repo: MemoryRepository;
      embedder: Embedder;
      judge: MemoryJudge | null;
      clock: Clock;
    },
    config: Partial<GateConfig> = {},
  ) {
    this.config = { ...DEFAULT_GATE, ...config };
  }

  /**
   * @param autoApprove kinds the gate may approve without a human (policy `memoryRules.autoApprove`, DEC-05)
   * @param requiresReview the reflection's own `requires_review` flag
   */
  async evaluate(input: unknown, options: { autoApprove: readonly MemoryKind[]; requiresReview?: boolean }): Promise<GateOutcome> {
    const parsed = MemoryCandidateSchema.safeParse(input);
    if (!parsed.success) return this.outcome([{ result: "REJECT", code: "provenance_missing" }], null, [], null, null);
    const candidate = parsed.data;
    const verdicts: { result: GateResult; code: GateReasonCode }[] = [];
    const flag = (result: GateResult, code: GateReasonCode) => verdicts.push({ result, code });
    const security: ScanFinding[] = [];

    // 1. Provenance and eligibility (deterministic, hard fail).
    const provenance = await this.checkProvenance(candidate);
    provenance.forEach(([result, code]) => flag(result, code));

    // 2. Truth status (INV-03). An inferred claim is checked after dedup: restating an approved memory adds provenance, not a new claim.
    if (candidate.kind !== "episodic" && (candidate.evidenceStatus === "hypothesis" || candidate.evidenceStatus === "rejected")) {
      flag("REJECT", "hypothesis_not_reusable");
    }

    // 3. Scope declared and matching the source tasks.
    if (candidate.kind !== "episodic" && candidate.applicability.conditions.length === 0) flag("REJECT", "scope_missing");

    // 4. Secrets and PII anywhere in the candidate (INV-04 redaction is the writer's job; this is the backstop).
    const texts = [candidate.lesson, ...candidate.applicability.conditions, ...candidate.limitations, ...candidate.evidenceRefs, ...(candidate.applicability.stack ?? [])];
    const joined = texts.join("\n");
    const secrets = scanSecrets(normalizeForScan(joined).text).concat(scanSecrets(joined));
    if (secrets.length > 0) {
      flag("REJECT", "secret_detected");
      security.push(...secrets);
    }

    // 5. Instruction elevation (INV-02, INV-08).
    for (const finding of scanInstructionElevation(joined)) {
      flag("REVIEW_REQUIRED", finding.code === "hidden_content" ? "hidden_content" : "instruction_elevation");
      security.push(finding);
    }

    // 6. Utility: a specific future problem helped, not a platitude.
    if (candidate.kind !== "episodic" && (tokenize(candidate.lesson).length < this.config.minLessonWords || PLATITUDE.test(candidate.lesson))) {
      flag("REJECT", "generic");
    }

    // 7. Dedup and conflict against approved memories in the same scope.
    let duplicateOf: string | null = null;
    const hardReject = verdicts.some((v) => v.result === "REJECT");
    if (!hardReject) {
      const dedup = await this.checkDuplicates(candidate);
      duplicateOf = dedup.duplicateOf;
      if (dedup.contradiction) flag("REVIEW_REQUIRED", "possible_contradiction");
      if (duplicateOf) flag("APPROVE", "duplicate_merged");
      else if (candidate.kind !== "episodic" && candidate.evidenceStatus === "inferred") flag("REVIEW_REQUIRED", "inferred_claim");
    }

    // 8. Judge: only when nothing has rejected the candidate and it is not a pure duplicate. The automatic episodic
    // record restates evaluator facts rather than model text, so it has no claim for a judge to check.
    let judgeUsage: ModelUsage | null = null;
    let judgeModel: string | null = null;
    if (candidate.kind !== "episodic" && !verdicts.some((v) => v.result === "REJECT") && duplicateOf === null) {
      const judged = await this.judge(candidate);
      judgeUsage = judged.usage;
      judgeModel = judged.model;
      judged.flags.forEach(([result, code]) => flag(result, code));
    }

    // 9. Review policy: the reflection's own flag, then the per-kind auto-approval list (MVP default: only episodic).
    if (options.requiresReview) flag("REVIEW_REQUIRED", "requires_review");
    if (duplicateOf === null && !verdicts.some((v) => v.result !== "APPROVE")) {
      if (candidate.kind === "playbook_item") flag("REVIEW_REQUIRED", "playbook_delta_review");
      else if (!options.autoApprove.includes(candidate.kind)) flag("REVIEW_REQUIRED", "human_review_required");
      else flag("APPROVE", "approved_auto");
    }
    return this.outcome(verdicts, duplicateOf, security, judgeUsage, judgeModel);
  }

  private outcome(
    verdicts: readonly { result: GateResult; code: GateReasonCode }[],
    duplicateOf: string | null,
    securityFindings: ScanFinding[],
    judgeUsage: ModelUsage | null,
    judgeModel: string | null,
  ): GateOutcome {
    const result = verdicts.reduce<GateResult>((worst, v) => (STRICTNESS[v.result] > STRICTNESS[worst] ? v.result : worst), "APPROVE");
    // Reasons that explain the decision first, then the rest; each code once.
    const ordered = [...verdicts.filter((v) => v.result === result), ...verdicts.filter((v) => v.result !== result)].map((v) => v.code);
    const reasons = [...new Set(ordered)];
    return {
      decision: GateDecisionSchema.parse({
        result,
        reasonCodes: reasons.length > 0 ? reasons : ["provenance_missing"],
        judgeModel,
        reviewer: null,
        decidedAt: this.deps.clock.now().toISOString(),
      }),
      reasons,
      duplicateOf,
      securityFindings,
      judgeUsage,
    };
  }

  /** Source runs, evaluations and evidence pointers must exist, belong together, share one scope, and be eligible (§7.1). */
  private async checkProvenance(c: MemoryCandidate): Promise<[GateResult, GateReasonCode][]> {
    const { records } = this.deps;
    const out: [GateResult, GateReasonCode][] = [];
    if (c.evidenceRefs.length === 0) out.push(["REJECT", "provenance_missing"]);

    const runs = await Promise.all(c.sourceRunIds.map((id) => records.getRun(id)));
    const evaluations = await Promise.all(c.evaluationIds.map((id) => records.getEvaluation(id)));
    if (runs.some((r) => !r) || evaluations.some((e) => !e)) return [...out, ["REJECT", "evidence_unresolved"]];
    const knownRuns = runs as Run[];
    const knownEvals = evaluations as EvaluationResult[];
    if (knownEvals.some((e) => !c.sourceRunIds.includes(e.runId))) out.push(["REJECT", "evidence_unresolved"]);

    const tasks = await Promise.all(knownRuns.map((r) => records.getTask(r.taskId)));
    if (tasks.some((t) => !t)) return [...out, ["REJECT", "evidence_unresolved"]];
    const projects = new Set(tasks.map((t) => `${t?.tenantId}/${t?.projectId}`));
    if (projects.size !== 1 || !projects.has(`${tasks[0]?.tenantId}/${c.applicability.projectId}`)) out.push(["REJECT", "scope_mismatch"]);

    const quarantined = await records.quarantinedRunIds();
    if (c.sourceRunIds.some((id) => quarantined.has(id))) out.push(["REJECT", "source_quarantined"]);

    for (const ref of c.evidenceRefs) if (!(await this.resolves(ref, c.sourceRunIds, knownEvals))) out.push(["REJECT", "evidence_unresolved"]);

    // Eligibility by outcome (§7.1): verified runs learn; a failed run yields an unreviewed episodic record only; the rest nothing.
    for (const run of knownRuns) {
      const outcome = effectiveOutcome(run, knownEvals);
      const verified = outcome === "verified_success" || outcome === "verified_failure";
      if (verified) continue;
      if (outcome === "failed" && c.kind === "episodic") out.push(["REVIEW_REQUIRED", "unverified_run"]);
      else out.push(["REJECT", "unverified_run"]);
    }
    if (c.kind !== "episodic" && knownEvals.some((e) => e.verdict !== "verified_success" && e.verdict !== "verified_failure")) {
      out.push(["REJECT", "unverified_run"]);
    }
    return out;
  }

  /** `evaluation:<id>`, `event:<runId>:<sequence>` (the PRD's §12 examples), `check:<name>` and `run:<id>` (an evaluation-less run). */
  private async resolves(ref: string, sourceRunIds: readonly string[], evaluations: readonly EvaluationResult[]): Promise<boolean> {
    const [kind, ...rest] = ref.split(":");
    if (kind === "evaluation") {
      const found = await this.deps.records.getEvaluation(rest.join(":"));
      return !!found && sourceRunIds.includes(found.runId);
    }
    if (kind === "event") {
      const sequence = Number(rest.pop());
      const runId = rest.join(":");
      if (!sourceRunIds.includes(runId) || !Number.isInteger(sequence)) return false;
      return (await this.deps.records.getEvents(runId)).some((e) => e.sequence === sequence);
    }
    if (kind === "run") return sourceRunIds.includes(rest.join(":"));
    if (kind === "check") return evaluations.some((e) => e.checks.some((c) => c.name === rest.join(":")));
    return false;
  }

  private async checkDuplicates(c: MemoryCandidate): Promise<{ duplicateOf: string | null; contradiction: boolean }> {
    const { repo, embedder } = this.deps;
    const tenantTask = await this.deps.records.getRun(c.sourceRunIds[0]).then((r) => (r ? this.deps.records.getTask(r.taskId) : undefined));
    if (!tenantTask) return { duplicateOf: null, contradiction: false };
    const approved = (await repo.find({ tenantId: tenantTask.tenantId, projectId: c.applicability.projectId, lifecycleStates: ["approved"], kinds: [c.kind] })).filter(
      (m) => m.scope.taskClass === c.applicability.taskClass,
    );
    const vector = await embedder.embed(c.lesson);
    const tokens = tokenize(c.lesson);
    let duplicateOf: string | null = null;
    let contradiction = false;
    for (const m of approved) {
      const overlap = jaccard(tokens, tokenize(m.text));
      const similar = m.embedding !== undefined && m.embeddingModel === embedder.model && m.embeddingVersion === embedder.version ? cosine(vector, m.embedding) : 0;
      const close = similar >= this.config.duplicateCosine || overlap >= this.config.duplicateJaccard;
      // Negations are stopwords to the tokenizer, so "use X" and "do not use X" overlap completely: polarity must veto a merge.
      const reversed = NEGATION.test(c.lesson) !== NEGATION.test(m.text);
      if (reversed && (close || overlap >= this.config.contradictionJaccard)) contradiction = true;
      else if (close) duplicateOf = duplicateOf ?? m.id;
    }
    return { duplicateOf, contradiction };
  }

  private async judge(c: MemoryCandidate): Promise<{ flags: [GateResult, GateReasonCode][]; usage: ModelUsage | null; model: string | null }> {
    const { judge, records } = this.deps;
    if (!judge) return { flags: [["REVIEW_REQUIRED", "judge_unavailable"]], usage: null, model: null };
    const excerpts: string[] = [];
    for (const id of c.evaluationIds) {
      const e = await records.getEvaluation(id);
      if (e) excerpts.push(`evaluation ${e.id}: ${e.verdict}/${e.outcomeReason}; ${e.checks.map((k) => `${k.name}=${k.passed}`).join(", ")}`);
    }
    try {
      const response = await judge.judge({ candidate: c, evidenceExcerpts: excerpts });
      const verdict = JudgeVerdictSchema.safeParse(response.output);
      if (!verdict.success) return { flags: [["REVIEW_REQUIRED", "judge_unavailable"]], usage: response.usage, model: judge.config.model };
      const flags: [GateResult, GateReasonCode][] = [];
      if (verdict.data.generic) flags.push(["REJECT", "generic"]);
      if (!verdict.data.supported) flags.push(["REVIEW_REQUIRED", "unsupported_claim"]);
      if (verdict.data.instructionLike) flags.push(["REVIEW_REQUIRED", "instruction_elevation"]);
      return { flags, usage: response.usage, model: judge.config.model };
    } catch (error) {
      if (error instanceof JudgeUnavailableError) return { flags: [["REVIEW_REQUIRED", "judge_unavailable"]], usage: null, model: judge.config.model };
      throw error;
    }
  }
}
