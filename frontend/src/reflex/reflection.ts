import { ReflectionSchema } from "./contracts";
import type { EvaluationResult, MemoryCandidate, Reflection, Run, Task } from "./contracts";
import type { JudgeInput, MemoryJudge, ModelResponse, ModelUsage, ReflectionInput, Reflector } from "./ports";
import { scanInstructionElevation } from "./scanner";
import { normalizeForScan, scanSecrets } from "./scanner";
import { tokenize } from "./text";

/*
 * Reflection and judge stand-ins plus the mapping from a validated `Reflection` to a `MemoryCandidate`. The real
 * reflector and judge are models (DEC-12 asks for a different family for the judge; DEC-10 pins the executor), so
 * here they are scripted or rule-based and make no claim about lesson quality. The seams, schemas and gate
 * behaviour around them are the Phase 1 deliverable.
 */

const REFLECTION_USAGE: ModelUsage = { inputTokens: 50, outputTokens: 30, usd: 0.0005 };
const JUDGE_USAGE: ModelUsage = { inputTokens: 40, outputTokens: 10, usd: 0.0003 };

/** Replays whatever `produce` returns for each run. Output is `unknown` on purpose so tests can feed malformed reflections. */
export class ScriptedReflector implements Reflector {
  readonly config = { provider: "stub", model: "scripted-reflector", version: "1" };

  constructor(
    private readonly produce: (input: ReflectionInput) => unknown,
    private readonly usage: ModelUsage = REFLECTION_USAGE,
  ) {}

  async reflect(input: ReflectionInput): Promise<ModelResponse> {
    return { output: this.produce(input), usage: this.usage };
  }
}

/**
 * Deterministic judge. It treats the lesson as supported when it shares a term with the cited evaluation excerpts,
 * and as instruction-like when the elevation deny-list hits. It is a plumbing stand-in for the model judge, not a
 * claim-verifier: the gate's own deterministic checks carry the safety weight.
 */
export class RuleJudge implements MemoryJudge {
  readonly config = { provider: "stub", model: "rule-judge", version: "1" };

  async judge(input: JudgeInput): Promise<ModelResponse> {
    const evidence = new Set(input.evidenceExcerpts.flatMap((e) => tokenize(e)));
    const shared = tokenize(input.candidate.lesson).filter((t) => evidence.has(t));
    return {
      output: {
        supported: shared.length > 0,
        unsupportedClaims: shared.length > 0 ? [] : [input.candidate.lesson.slice(0, 80)],
        generic: false,
        instructionLike: scanInstructionElevation(input.candidate.lesson).length > 0,
        rationaleSummary: shared.length > 0 ? `shares ${shared.length} term(s) with the evaluation` : "no term shared with the evaluation",
      },
      usage: JUDGE_USAGE,
    };
  }
}

/** Parse a reflector's output. A reflection that disagrees with the evaluator about the outcome is invalid, not trusted (INV-01). */
export function parseReflection(output: unknown, evaluation: EvaluationResult): { ok: true; reflection: Reflection } | { ok: false; issues: string } {
  const parsed = ReflectionSchema.safeParse(output);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".") || "output"}: ${i.message}`).slice(0, 5).join("; ") };
  }
  if (parsed.data.outcome !== evaluation.verdict) {
    return { ok: false, issues: `outcome: reflection says ${parsed.data.outcome} but the evaluator recorded ${evaluation.verdict}` };
  }
  return { ok: true, reflection: parsed.data };
}

/**
 * The automatic episodic record of a run (PRD §12.2: "episodic records are automatic"). It restates evaluator facts
 * only, so it carries no model claim and needs no judge.
 */
export function episodicCandidate(input: { task: Task; run: Run; evaluation: EvaluationResult | null }): MemoryCandidate {
  const { task, run, evaluation } = input;
  const failing = evaluation?.checks.filter((c) => c.passed === false).map((c) => c.name) ?? [];
  const passing = evaluation?.checks.filter((c) => c.passed === true).map((c) => c.name) ?? [];
  const verdict = evaluation ? `${evaluation.verdict}/${evaluation.outcomeReason}` : `${run.outcome ?? "unknown"}/${run.outcomeReason ?? "unknown"}`;
  return {
    kind: "episodic",
    lesson: `Run ${run.id} on task ${task.id} (${task.taskClass ?? "unclassified"}) ended ${verdict} after ${run.steps} steps. Failing checks: ${failing.join(", ") || "none"}. Passing checks: ${passing.join(", ") || "none"}.`,
    applicability: { projectId: task.projectId, ...(task.taskClass ? { taskClass: task.taskClass } : {}), conditions: [] },
    evidenceStatus: "observed",
    sourceRunIds: [run.id],
    evaluationIds: evaluation ? [evaluation.id] : [],
    evidenceRefs: evaluation ? [`evaluation:${evaluation.id}`] : [`run:${run.id}`],
    limitations: [],
    confidence: 0.5,
  };
}

/**
 * A reflection becomes a candidate of the kind it suggests. Anything beyond an episodic record is `inferred`: a
 * lesson generalizes from one run's evidence, which is not itself an observation (INV-03).
 */
export function reflectionCandidate(reflection: Reflection, input: { task: Task; run: Run; evaluation: EvaluationResult }): MemoryCandidate {
  const { task, run, evaluation } = input;
  return {
    kind: reflection.suggestedMemoryKind,
    lesson: reflection.lesson,
    applicability: { projectId: task.projectId, ...(task.taskClass ? { taskClass: task.taskClass } : {}), conditions: reflection.appliesWhen },
    evidenceStatus: reflection.suggestedMemoryKind === "episodic" ? "observed" : "inferred",
    sourceRunIds: [run.id],
    evaluationIds: [evaluation.id],
    evidenceRefs: reflection.evidenceRefs,
    limitations: reflection.doesNotApplyWhen,
    confidence: 0.5,
  };
}

const REDACTED = "[redacted: secret detected]";

/**
 * The trace is persisted before the gate's verdict is final, so a reflection that carries a secret must not reach
 * it verbatim (PRD §17.0 "redact before event persistence"). The gate still sees the original and rejects it.
 */
export function redactReflection(reflection: Reflection): Reflection {
  const text = JSON.stringify(reflection);
  if (scanSecrets(normalizeForScan(text).text).length === 0 && scanSecrets(text).length === 0) return reflection;
  return {
    ...reflection,
    failureMode: REDACTED,
    evidenceRefs: reflection.evidenceRefs.map(() => REDACTED),
    lesson: REDACTED,
    appliesWhen: reflection.appliesWhen.map(() => REDACTED),
    doesNotApplyWhen: reflection.doesNotApplyWhen.map(() => REDACTED),
  };
}
