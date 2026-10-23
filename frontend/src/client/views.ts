/*
 * Pure view models for the dashboard. Pages render these; they do not read the store themselves.
 * Nothing here imports Next.js, and embeddings never leave this module — the explorer already strips
 * them, and `toMemoryListItem` drops them again if a raw record is passed in.
 */

import type {
  EvaluationResult,
  LifecycleState,
  MemoryKind,
  MemoryRecord,
  OutcomeReason,
  Run,
  RunEvent,
  RunOutcome,
  RunState,
  Task,
} from "../reflex/contracts";
import type { ExperimentReport } from "../reflex/experiment";
import type { MemoryView } from "../reflex/explorer";

export interface RunListItem {
  id: string;
  taskId: string;
  objective: string;
  status: RunState;
  outcome: RunOutcome | null;
  outcomeReason: OutcomeReason | null;
  arm: Run["configArm"];
  retrieval: Run["retrievalSnapshot"]["mode"];
  createdAt: string;
  endedAt: string | null;
  steps: number;
  experimentId: string | null;
}

type RunListSource = Pick<
  Run,
  "id" | "taskId" | "status" | "outcome" | "outcomeReason" | "configArm" | "retrievalSnapshot" | "timestamps" | "steps" | "experimentId"
>;

export function toRunListItem(run: RunListSource, task: Pick<Task, "objective"> | undefined): RunListItem {
  return {
    id: run.id,
    taskId: run.taskId,
    objective: task?.objective ?? "Unknown task",
    status: run.status,
    outcome: run.outcome,
    outcomeReason: run.outcomeReason,
    arm: run.configArm,
    retrieval: run.retrievalSnapshot.mode,
    createdAt: run.timestamps.createdAt,
    endedAt: run.timestamps.endedAt,
    steps: run.steps,
    experimentId: run.experimentId ?? null,
  };
}

export function sortRunsNewestFirst(items: readonly RunListItem[]): RunListItem[] {
  return [...items].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? 1 : -1));
}

export interface TimelineStep {
  sequence: number;
  at: string;
  from: RunState | null;
  to: RunState;
  reason: string;
}

export function stateTimeline(events: readonly RunEvent[]): TimelineStep[] {
  return events
    .flatMap((event) =>
      event.type === "state_transition"
        ? [{ sequence: event.sequence, at: event.timestamp, from: event.redactedPayload.from, to: event.redactedPayload.to, reason: event.redactedPayload.reason }]
        : [],
    )
    .sort((a, b) => a.sequence - b.sequence);
}

export interface EventRow {
  sequence: number;
  at: string;
  type: RunEvent["type"];
  actor: string;
  summary: string;
  artifactRef: string | null;
}

export function toEventRow(event: RunEvent): EventRow {
  return {
    sequence: event.sequence,
    at: event.timestamp,
    type: event.type,
    actor: `${event.actor.kind}:${event.actor.id}`,
    summary: eventSummary(event),
    artifactRef: event.artifactRef ?? null,
  };
}

export function eventSummary(event: RunEvent): string {
  switch (event.type) {
    case "state_transition": {
      const payload = event.redactedPayload;
      return payload.from === null ? `Entered ${payload.to}: ${payload.reason}` : `${payload.from} → ${payload.to}: ${payload.reason}`;
    }
    case "retrieval_skipped":
      return `Retrieval skipped (${event.redactedPayload.reason}).`;
    case "plan_recorded":
      return event.redactedPayload.plan.goal;
    case "tool_authorized":
      return `Authorized ${event.redactedPayload.tool}: ${event.redactedPayload.argsSummary}`;
    case "policy_denied":
      return `Denied ${event.redactedPayload.tool || "tool"} (${event.redactedPayload.reasonCode}): ${event.redactedPayload.detail}`;
    case "tool_result":
      return `${event.redactedPayload.ok ? "ok" : "failed"} ${event.redactedPayload.tool}: ${event.redactedPayload.summary}`;
    case "model_retry":
      return `Retry ${event.redactedPayload.retry} at ${event.redactedPayload.stage} after ${event.redactedPayload.cause} (${event.redactedPayload.delayMs} ms).`;
    case "model_output_invalid":
      return `Invalid ${event.redactedPayload.stage} output on attempt ${event.redactedPayload.attempt}: ${event.redactedPayload.issues.join("; ") || "no details"}`;
    case "evaluation_recorded":
      return `Evaluation ${event.redactedPayload.evaluationId}: ${event.redactedPayload.verdict}`;
    case "evaluator_tamper_flag":
      return `Tamper flag on ${event.redactedPayload.touchedProtectedPaths.join(", ") || "protected paths"}.`;
    case "reflection_skipped":
      return `Reflection skipped (${event.redactedPayload.reason}).`;
    case "retrieval_recorded":
      return `Retrieved ${event.redactedPayload.injected.length} of ${event.redactedPayload.considered} considered (${event.redactedPayload.contextTokens} tokens).`;
    case "retrieval_degraded":
      return `Retrieval degraded: ${event.redactedPayload.reason}`;
    case "reflection_recorded":
      return `${event.redactedPayload.candidates} candidate(s) from reflection: ${event.redactedPayload.reflection.lesson}`;
    case "reflection_failed":
      return `Reflection failed (${event.redactedPayload.cause}): ${event.redactedPayload.detail}`;
    case "writeback_blocked":
      return `Writeback blocked (${event.redactedPayload.reason}).`;
    case "memory_lifecycle":
      return `Memory ${event.redactedPayload.memoryId} ${event.redactedPayload.from ?? "new"} → ${event.redactedPayload.to} (${event.redactedPayload.reasonCode}).`;
    case "quarantine_recorded":
      return `${event.redactedPayload.restored ? "Restored" : "Quarantined"} ${event.redactedPayload.selector}: ${event.redactedPayload.reason}`;
    case "memory_use":
      return `Used ${event.redactedPayload.memoryId}: cited ${event.redactedPayload.citedInPlan}, followed ${event.redactedPayload.followed}, effect ${event.redactedPayload.outcomeEffect}.`;
    case "gate_decision":
      return `Gate ${event.redactedPayload.decision.result} for ${event.redactedPayload.memoryId}: ${event.redactedPayload.decision.reasonCodes.join(", ") || "no reason code"}.`;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

export interface ArtifactLink {
  ref: string;
  source: "event" | "check";
  label: string;
}

export function collectArtifacts(events: readonly RunEvent[], evaluation: EvaluationResult | null): ArtifactLink[] {
  const links: ArtifactLink[] = [];
  const seen = new Set<string>();
  const add = (ref: string | undefined, source: ArtifactLink["source"], label: string) => {
    if (!ref || !ref.startsWith("sha256:") || seen.has(ref)) return;
    seen.add(ref);
    links.push({ ref, source, label });
  };
  for (const event of events) add(event.artifactRef, "event", `${event.type} #${event.sequence}`);
  for (const check of evaluation?.checks ?? []) add(check.artifactRef, "check", check.name);
  return links;
}

export interface EvaluationView {
  id: string;
  verdict: RunOutcome;
  outcomeReason: OutcomeReason;
  checkBundleHash: string;
  hiddenChecksPassed: boolean | null;
  touchedProtectedPaths: string[];
  metrics: { name: string; value: number }[];
  checks: { name: string; passed: boolean | null; command: string | null; artifactRef: string | null }[];
  completedAt: string;
}

export function toEvaluationView(evaluation: EvaluationResult): EvaluationView {
  return {
    id: evaluation.id,
    verdict: evaluation.verdict,
    outcomeReason: evaluation.outcomeReason,
    checkBundleHash: evaluation.checkBundleHash,
    hiddenChecksPassed: evaluation.hiddenChecksPassed,
    touchedProtectedPaths: [...evaluation.touchedProtectedPaths],
    metrics: Object.entries(evaluation.metrics)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, value]) => ({ name, value })),
    checks: evaluation.checks.map((check) => ({
      name: check.name,
      passed: check.passed,
      command: check.command ?? null,
      artifactRef: check.artifactRef ?? null,
    })),
    completedAt: evaluation.completedAt,
  };
}

export interface RetrievedMemoryRow {
  memoryId: string;
  text: string | null;
  lifecycleState: LifecycleState | null;
  sourceRunIds: string[];
  rank: number | null;
  score: number | null;
  injected: boolean;
  citedInPlan: boolean;
  followed: boolean;
  outcomeEffect: string;
}

export interface MemoryUse {
  memoryId: string;
  citedInPlan: boolean;
  followed: boolean;
  outcomeEffect: string;
}

export interface MemoryProvenance {
  text: string;
  lifecycleState: LifecycleState;
  sourceRunIds: readonly string[];
}

export function retrievedMemories(
  context: Run["memoryContext"],
  uses: readonly MemoryUse[],
  provenance: ReadonlyMap<string, MemoryProvenance>,
): RetrievedMemoryRow[] {
  const byId = new Map<string, RetrievedMemoryRow>();
  const ordered = [...context].sort((a, b) => a.rank - b.rank);
  for (const card of ordered) {
    const known = provenance.get(card.memoryId);
    byId.set(card.memoryId, {
      memoryId: card.memoryId,
      text: known ? excerpt(known.text) : null,
      lifecycleState: known?.lifecycleState ?? null,
      sourceRunIds: known ? [...known.sourceRunIds] : [],
      rank: card.rank,
      score: card.score,
      injected: card.injected,
      citedInPlan: false,
      followed: false,
      outcomeEffect: "unknown",
    });
  }
  for (const use of uses) {
    const known = provenance.get(use.memoryId);
    const existing = byId.get(use.memoryId);
    byId.set(use.memoryId, {
      memoryId: use.memoryId,
      text: existing?.text ?? (known ? excerpt(known.text) : null),
      lifecycleState: existing?.lifecycleState ?? known?.lifecycleState ?? null,
      sourceRunIds: existing?.sourceRunIds ?? (known ? [...known.sourceRunIds] : []),
      rank: existing?.rank ?? null,
      score: existing?.score ?? null,
      injected: existing?.injected ?? false,
      citedInPlan: use.citedInPlan,
      followed: use.followed,
      outcomeEffect: use.outcomeEffect,
    });
  }
  return [...byId.values()];
}

export const MEMORY_STATUS_FILTERS = ["candidate", "approved", "quarantined", "expired"] as const;
export type MemoryStatusFilter = (typeof MEMORY_STATUS_FILTERS)[number];

export const MEMORY_KINDS = ["episodic", "semantic", "procedural", "playbook_item"] as const;

/** Sentinel for memories with no task class. A real task class will not use this spelling. */
export const UNSCOPED_SCOPE = "__unscoped__";

export interface MemoryQuery {
  status?: MemoryStatusFilter;
  kind?: MemoryKind;
  scope?: string;
  q?: string;
}

export interface MemoryListItem {
  id: string;
  kind: MemoryKind;
  lifecycleState: LifecycleState;
  text: string;
  confidence: number;
  scopeLabel: string;
  taskClass: string | null;
  sourceRunIds: string[];
  version: number;
  score: number | null;
}

type MemoryListSource = Pick<MemoryRecord, "id" | "kind" | "lifecycleState" | "text" | "confidence" | "scope" | "sourceRunIds" | "version">;

export function scopeLabel(scope: MemoryRecord["scope"]): string {
  const parts = [scope.taskClass, scope.stack?.join(", "), scope.environment].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "unscoped";
}

export function toMemoryListItem(record: MemoryListSource, score?: number): MemoryListItem {
  return {
    id: record.id,
    kind: record.kind,
    lifecycleState: record.lifecycleState,
    text: record.text,
    confidence: record.confidence,
    scopeLabel: scopeLabel(record.scope),
    taskClass: record.scope.taskClass ?? null,
    sourceRunIds: [...record.sourceRunIds],
    version: record.version,
    score: score ?? null,
  };
}

export function memoryListItemFromView(memory: MemoryView, score: number): MemoryListItem {
  return toMemoryListItem(memory, score);
}

export function filterMemoryList(items: readonly MemoryListItem[], query: MemoryQuery): MemoryListItem[] {
  const needle = query.q?.trim().toLowerCase();
  return items.filter((item) => {
    if (query.status && item.lifecycleState !== query.status) return false;
    if (query.kind && item.kind !== query.kind) return false;
    if (query.scope === UNSCOPED_SCOPE && item.taskClass !== null) return false;
    if (query.scope && query.scope !== UNSCOPED_SCOPE && item.taskClass !== query.scope) return false;
    if (needle && !`${item.text} ${item.id}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

export interface ScopeChoice {
  value: string;
  label: string;
}

export function scopeChoices(items: readonly MemoryListItem[]): ScopeChoice[] {
  const classes = new Set<string>();
  let unscoped = false;
  for (const item of items) {
    if (item.taskClass) classes.add(item.taskClass);
    else unscoped = true;
  }
  const choices = [...classes].sort().map((value) => ({ value, label: value }));
  if (unscoped) choices.push({ value: UNSCOPED_SCOPE, label: "unscoped" });
  return choices;
}

function one(
  value: string | string[] | undefined,
  field: string,
): { ok: true; value?: string } | { ok: false; field: string; message: string } {
  if (value === undefined) return { ok: true };
  if (Array.isArray(value)) return { ok: false, field, message: `${field} must be a single value.` };
  const trimmed = value.trim();
  return trimmed.length === 0 ? { ok: true } : { ok: true, value: trimmed };
}

export function parseMemoryQuery(raw: {
  status?: string | string[];
  kind?: string | string[];
  scope?: string | string[];
  q?: string | string[];
}): { ok: true; query: MemoryQuery } | { ok: false; field: string; message: string } {
  const status = one(raw.status, "status");
  if (!status.ok) return status;
  const kind = one(raw.kind, "kind");
  if (!kind.ok) return kind;
  const scope = one(raw.scope, "scope");
  if (!scope.ok) return scope;
  const q = one(raw.q, "q");
  if (!q.ok) return q;

  const query: MemoryQuery = {};
  if (status.value) {
    if (!(MEMORY_STATUS_FILTERS as readonly string[]).includes(status.value)) {
      return { ok: false, field: "status", message: "Status must be candidate, approved, quarantined, or expired." };
    }
    query.status = status.value as MemoryStatusFilter;
  }
  if (kind.value) {
    if (!(MEMORY_KINDS as readonly string[]).includes(kind.value)) {
      return { ok: false, field: "kind", message: "Kind must be episodic, semantic, procedural, or playbook_item." };
    }
    query.kind = kind.value as MemoryKind;
  }
  if (scope.value) query.scope = scope.value;
  if (q.value) query.q = q.value;
  return { ok: true, query };
}

export interface ComparisonRow {
  taskId: string;
  trials: number;
  armA: { successes: number; majority: boolean; runIds: string[] };
  armB: { successes: number; majority: boolean; runIds: string[] };
}

export function toComparisonRows(report: Pick<ExperimentReport, "perTask" | "trials">): ComparisonRow[] {
  return report.perTask.map((task) => ({
    taskId: task.taskId,
    trials: report.trials,
    armA: { successes: task.A.successes, majority: task.A.majority, runIds: [...task.A.runIds] },
    armB: { successes: task.B.successes, majority: task.B.majority, runIds: [...task.B.runIds] },
  }));
}

export interface ChartBar {
  metric: "pass^1" | "pass^k" | "majority";
  label: string;
  armA: number;
  armB: number;
}

export function toChartBars(report: Pick<ExperimentReport, "arms">): ChartBar[] {
  return [
    { metric: "pass^1", label: "pass^1", armA: report.arms.A.pass1, armB: report.arms.B.pass1 },
    { metric: "pass^k", label: "pass^k", armA: report.arms.A.passK, armB: report.arms.B.passK },
    { metric: "majority", label: "majority", armA: report.arms.A.majorityRate, armB: report.arms.B.majorityRate },
  ];
}

export function countsBy(values: readonly string[]): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, count]) => ({ key, count }));
}

export function formatRate(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const pct = Math.round(value * 1000) / 10;
  return Number.isInteger(pct) ? `${pct.toFixed(0)}%` : `${pct.toFixed(1)}%`;
}

export function formatPValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.001) return "< 0.001";
  return value.toFixed(3);
}

export function formatTimestamp(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(iso)) return iso;
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

export function excerpt(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

export interface RunDetailModel {
  item: RunListItem;
  timeline: TimelineStep[];
  events: EventRow[];
  evaluation: EvaluationView | null;
  artifacts: ArtifactLink[];
  memories: RetrievedMemoryRow[];
  cost: Run["cost"];
  budget: Run["budget"];
  learningCost: Run["learningCost"];
  model: string;
  policyId: string;
  policyVersion: number;
  playbookVersion: string | null;
  workspaceRef: string;
}

export function buildRunDetail(input: {
  run: Run;
  task: Task | undefined;
  events: readonly RunEvent[];
  evaluation: EvaluationResult | null;
  memoryUses: readonly MemoryUse[];
  provenance: ReadonlyMap<string, MemoryProvenance>;
}): RunDetailModel {
  return {
    item: toRunListItem(input.run, input.task),
    timeline: stateTimeline(input.events),
    events: [...input.events].sort((a, b) => a.sequence - b.sequence).map(toEventRow),
    evaluation: input.evaluation ? toEvaluationView(input.evaluation) : null,
    artifacts: collectArtifacts(input.events, input.evaluation),
    memories: retrievedMemories(input.run.memoryContext, input.memoryUses, input.provenance),
    cost: input.run.cost,
    budget: input.run.budget,
    learningCost: input.run.learningCost,
    model: `${input.run.modelConfig.provider}/${input.run.modelConfig.model}@${input.run.modelConfig.version}`,
    policyId: input.run.policyId,
    policyVersion: input.run.policyVersion,
    playbookVersion: input.run.playbookVersion,
    workspaceRef: input.run.workspaceRef,
  };
}

export function formatCheckPassed(passed: boolean | null): string {
  if (passed === true) return "passed";
  if (passed === false) return "failed";
  return "not run";
}
