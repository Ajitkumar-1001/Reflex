import { z } from "zod";
import { normalizePath } from "./paths";

/*
 * Canonical Reflex contracts. Source of truth: PRD v1.4 (§7.1, §7.2, §9, §10, §11, §12, §13, §15.2).
 */

// ---------------------------------------------------------------- primitives

const Id = z.string().min(1).max(128);
const Timestamp = z.iso.datetime();
const NonEmpty = z.string().min(1);

export const EvidenceStatus = z.enum(["observed", "inferred", "hypothesis", "rejected"]);
export type EvidenceStatus = z.infer<typeof EvidenceStatus>;

export const RunOutcome = z.enum([
  "verified_success",
  "verified_failure",
  "inconclusive",
  "failed",
  "blocked",
  "cancelled",
]);
export type RunOutcome = z.infer<typeof RunOutcome>;

export const TaskMode = z.enum(["build", "investigate"]);
export type TaskMode = z.infer<typeof TaskMode>;

export const RiskClass = z.enum(["low", "medium", "high"]);
export type RiskClass = z.infer<typeof RiskClass>;

export const SideEffectClass = z.enum(["read_only", "workspace_write", "external_write"]);
export type SideEffectClass = z.infer<typeof SideEffectClass>;

export const EvalSplit = z.enum(["train", "test", "none"]);
export type EvalSplit = z.infer<typeof EvalSplit>;

export const TaskSource = z.enum(["fixture", "live", "cody"]);
export type TaskSource = z.infer<typeof TaskSource>;

/** PRD §15.2. Wall-clock is in minutes, the unit of the §7.8 policy defaults. */
export const Budget = z.strictObject({
  maxSteps: z.int().positive(),
  maxUsd: z.number().nonnegative(),
  maxWallMinutes: z.number().positive(),
});
export type Budget = z.infer<typeof Budget>;

// --------------------------------------------------------------- state machine

export const RunState = z.enum([
  "CREATED",
  "ADMITTED",
  "RETRIEVING",
  "PLANNING",
  "EXECUTING",
  "EVALUATING",
  "REFLECTING",
  "COMPLETE",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "INCONCLUSIVE",
]);
export type RunState = z.infer<typeof RunState>;

export const TERMINAL_STATES = ["COMPLETE", "BLOCKED", "FAILED", "CANCELLED", "INCONCLUSIVE"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

export function isTerminal(state: RunState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * Allowed transitions. Main path and explicit rules of PRD v1.4 §7.1: every non-terminal state may
 * move to CANCELLED or FAILED, ADMITTED -> BLOCKED, EVALUATING -> INCONCLUSIVE, REFLECTING -> COMPLETE.
 * BLOCKED and INCONCLUSIVE are also reachable from PLANNING and EXECUTING, because §7.8 (3 policy
 * denials -> BLOCKED/policy_denied; provider or sandbox failure -> INCONCLUSIVE) and §11 (a plan that
 * needs an external write -> BLOCKED/approval_required_p0) require it and §7.1's literal list does not
 * cover them. WAITING_APPROVAL and RETRY_PENDING are P1 and intentionally absent.
 */
export const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  CREATED: ["ADMITTED", "CANCELLED", "FAILED"],
  ADMITTED: ["RETRIEVING", "BLOCKED", "CANCELLED", "FAILED"],
  RETRIEVING: ["PLANNING", "CANCELLED", "FAILED"],
  PLANNING: ["EXECUTING", "BLOCKED", "INCONCLUSIVE", "CANCELLED", "FAILED"],
  EXECUTING: ["EVALUATING", "BLOCKED", "INCONCLUSIVE", "CANCELLED", "FAILED"],
  EVALUATING: ["REFLECTING", "INCONCLUSIVE", "CANCELLED", "FAILED"],
  REFLECTING: ["COMPLETE", "CANCELLED", "FAILED"],
  COMPLETE: [],
  BLOCKED: [],
  FAILED: [],
  CANCELLED: [],
  INCONCLUSIVE: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new Error(`illegal run transition ${from} -> ${to}`);
}

export const OutcomeReason = z.enum([
  "checks_passed",
  "checks_failed",
  "infra_failure",
  "evaluator_tamper_suspected",
  "missing_checks",
  "model_unavailable",
  "budget_exhausted",
  "step_limit",
  "malformed_model_output",
  "internal_error",
  "policy_denied",
  "cloud_not_permitted",
  "approval_required_p0",
  "user_cancel",
  "shutdown",
]);
export type OutcomeReason = z.infer<typeof OutcomeReason>;

/** Legal (terminal state, outcome, reason) triples: the failure-state contract. */
export const TERMINAL_RESULTS: readonly {
  state: TerminalState;
  outcome: RunOutcome;
  reasons: readonly OutcomeReason[];
}[] = [
  { state: "COMPLETE", outcome: "verified_success", reasons: ["checks_passed"] },
  { state: "COMPLETE", outcome: "verified_failure", reasons: ["checks_failed"] },
  {
    state: "INCONCLUSIVE",
    outcome: "inconclusive",
    reasons: ["infra_failure", "evaluator_tamper_suspected", "missing_checks", "model_unavailable", "internal_error"],
  },
  {
    state: "FAILED",
    outcome: "failed",
    reasons: ["budget_exhausted", "step_limit", "malformed_model_output", "internal_error"],
  },
  { state: "BLOCKED", outcome: "blocked", reasons: ["policy_denied", "cloud_not_permitted", "approval_required_p0"] },
  { state: "CANCELLED", outcome: "cancelled", reasons: ["user_cancel", "shutdown"] },
];

export function isLegalTerminalResult(state: RunState, outcome: RunOutcome, reason: OutcomeReason): boolean {
  return TERMINAL_RESULTS.some((r) => r.state === state && r.outcome === outcome && r.reasons.includes(reason));
}

// ----------------------------------------------------------------------- task

const WorkspacePath = NonEmpty.refine((p) => normalizePath(p) !== null, {
  message: "must be a workspace-relative path without '..' segments",
});

/** PRD §15.2. Without `paths` the whole task worktree is in scope; with it, the agent is confined to them. */
export const TaskScope = z.strictObject({
  repo: NonEmpty,
  commit: NonEmpty,
  paths: z.array(WorkspacePath).min(1).optional(),
  protectedPaths: z.array(WorkspacePath).optional(),
});
export type TaskScope = z.infer<typeof TaskScope>;

const CheckDefinition = z.strictObject({ name: NonEmpty, command: NonEmpty });

const taskFields = {
  projectId: Id,
  objective: NonEmpty,
  scope: TaskScope,
  riskClass: RiskClass,
  budget: Budget,
  policyId: Id,
  policyVersion: z.int().positive(),
  taskClass: NonEmpty.optional(),
};
const buildFields = {
  mode: z.literal("build"),
  doneWhen: z.strictObject({ checks: z.array(CheckDefinition).min(1), hiddenCheckBundleRef: NonEmpty.optional() }),
};
const investigateFields = { mode: z.literal("investigate") }; // no `doneWhen`: strict rejects it, as `doneWhen?: never` does

/** The `POST /v1/tasks` body (PRD §15.2). Identity fields are server-derived and absent here. */
export const CreateTaskSchema = z.discriminatedUnion("mode", [
  z.strictObject({ ...taskFields, ...buildFields }),
  z.strictObject({ ...taskFields, ...investigateFields }),
]);
export type CreateTask = z.infer<typeof CreateTaskSchema>;

const serverTaskFields = {
  id: Id,
  tenantId: Id,
  requestedBy: NonEmpty,
  createdAt: Timestamp,
  source: TaskSource,
  split: EvalSplit.optional(),
};

/** The stored `tasks` document (PRD §10 and its v1.1 additions): a CreateTask plus server-derived fields. */
export const TaskSchema = z.discriminatedUnion("mode", [
  z.strictObject({ ...taskFields, ...buildFields, ...serverTaskFields }),
  z.strictObject({ ...taskFields, ...investigateFields, ...serverTaskFields }),
]);
export type Task = z.infer<typeof TaskSchema>;

/** Checks the task is graded by; empty for investigation tasks. */
export function taskChecks(task: Task): readonly { name: string; command: string }[] {
  return task.mode === "build" ? task.doneWhen.checks : [];
}

// ----------------------------------------------------------------------- plan

export const PlanSchema = z.strictObject({
  goal: NonEmpty,
  assumptions: z.array(z.string()),
  steps: z.array(z.strictObject({ description: NonEmpty, tool: z.string().optional() })).min(1),
  tools: z.array(NonEmpty),
  stopConditions: z.array(NonEmpty),
  memoryIds: z.array(NonEmpty),
  verificationCommands: z.array(NonEmpty),
  expectedArtifacts: z.array(NonEmpty),
});
export type Plan = z.infer<typeof PlanSchema>;

// ------------------------------------------------------------ model and tools

/** The only shape a model may emit during execution. Strict, so a `reasoning` field is rejected (INV-04). */
export const ToolCallRequest = z.strictObject({
  tool: NonEmpty,
  args: z.record(z.string(), z.unknown()),
});
export type ToolCallRequest = z.infer<typeof ToolCallRequest>;

export const DenialReason = z.enum([
  "unregistered_tool",
  "tool_not_in_policy",
  "external_write_not_permitted",
  "write_in_investigation_mode",
  "invalid_arguments",
  "command_not_allowed",
  "path_outside_scope",
  "protected_path",
]);
export type DenialReason = z.infer<typeof DenialReason>;

// ---------------------------------------------------------------------- policy

/** PRD §11 default `run_command` allowlist, as argv prefixes: git only with read-only subcommands. */
export const DEFAULT_COMMAND_ALLOWLIST: readonly (readonly string[])[] = [
  ["npm"],
  ["pnpm"],
  ["npx", "tsc"],
  ["node"],
  ["git", "status"],
  ["git", "diff"],
  ["git", "log"],
  ["git", "show"],
];

export const PolicySchema = z.strictObject({
  id: Id,
  name: NonEmpty,
  version: z.int().positive(),
  status: z.enum(["DRAFT", "TESTED", "APPROVED", "CANARY", "ACTIVE", "RETIRED", "ROLLED_BACK"]),
  riskClass: RiskClass,
  toolAllowlist: z.array(NonEmpty),
  /** argv prefixes `run_command` may execute, e.g. ["npx","tsc"] (PRD §11 assigns the allowlist to the policy). */
  commandAllowlist: z.array(z.array(NonEmpty).min(1)),
  routingPreferences: z.record(z.string(), z.string()),
  memoryRules: z.strictObject({ retrievalEnabled: z.boolean(), writebackEnabled: z.boolean() }),
  budgets: Budget,
  approvalRequirements: z.array(NonEmpty),
  evaluationSuiteRef: z.string().nullable(),
  promotedBy: z.string().nullable(),
  promotedAt: Timestamp.nullable(),
});
export type Policy = z.infer<typeof PolicySchema>;

// ------------------------------------------------------------------------ run

export const RunSchema = z
  .strictObject({
    id: Id,
    taskId: Id,
    status: RunState,
    policyId: Id,
    policyVersion: z.int().positive(),
    modelConfig: z.strictObject({ provider: NonEmpty, model: NonEmpty, version: NonEmpty }),
    promptTemplateVersion: NonEmpty,
    toolRegistryVersion: NonEmpty,
    /** Memory-off baseline records no retrieval index; Phase 1 widens this. */
    retrievalSnapshot: z.strictObject({ mode: z.literal("disabled"), indexVersion: z.null() }),
    configArm: z.enum(["A", "B", "C"]),
    workspaceRef: NonEmpty,
    startWorkspaceHash: NonEmpty,
    endWorkspaceHash: NonEmpty.nullable(),
    budget: Budget,
    steps: z.int().nonnegative(),
    cost: z.strictObject({
      inputTokens: z.int().nonnegative(),
      outputTokens: z.int().nonnegative(),
      usd: z.number().nonnegative(),
      wallMs: z.int().nonnegative(),
    }),
    learningCost: z.strictObject({ reflectionTokens: z.int().nonnegative(), gateTokens: z.int().nonnegative() }),
    playbookVersion: z.string().nullable(),
    memoryContext: z.array(
      z.strictObject({ memoryId: Id, version: z.int().positive(), rank: z.int().positive(), score: z.number(), injected: z.boolean() }),
    ),
    evalSplit: EvalSplit,
    timestamps: z.strictObject({ createdAt: Timestamp, updatedAt: Timestamp, endedAt: Timestamp.nullable() }),
    outcome: RunOutcome.nullable(),
    outcomeReason: OutcomeReason.nullable(),
  })
  .superRefine((run, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", path: ["outcome"], message });
    if (!isTerminal(run.status)) {
      if (run.outcome !== null || run.outcomeReason !== null) fail("non-terminal run must not carry an outcome");
      if (run.timestamps.endedAt !== null) fail("non-terminal run must not have endedAt");
      return;
    }
    if (run.outcome === null || run.outcomeReason === null) return fail("terminal run needs an outcome and reason");
    if (!isLegalTerminalResult(run.status, run.outcome, run.outcomeReason)) {
      fail(`illegal terminal result ${run.status}/${run.outcome}/${run.outcomeReason}`);
    }
    if (run.timestamps.endedAt === null) fail("terminal run needs endedAt");
  });
export type Run = z.infer<typeof RunSchema>;

// ---------------------------------------------------------------------- memory

export const MemoryKind = z.enum(["episodic", "semantic", "procedural", "playbook_item"]);
export type MemoryKind = z.infer<typeof MemoryKind>;

/** The only memory state field (PRD §9.6, §10); only `approved` is retrievable. */
export const LifecycleState = z.enum([
  "candidate",
  "approved",
  "rejected",
  "demoted",
  "quarantined",
  "superseded",
  "expired",
  "retired",
]);
export type LifecycleState = z.infer<typeof LifecycleState>;

/**
 * Allowed lifecycle transitions (PRD §9.6). Guards that need an actor or evidence are not
 * encoded here: demoted|expired -> approved needs re-verification evidence, and
 * quarantined -> approved is `owner` only. `rejected` and `retired` are terminal.
 */
export const MEMORY_TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  candidate: ["approved", "rejected"],
  approved: ["demoted", "quarantined", "superseded", "expired", "retired"],
  demoted: ["approved"],
  expired: ["approved"],
  quarantined: ["approved"],
  superseded: [],
  rejected: [],
  retired: [],
};

export function canTransitionMemory(from: LifecycleState, to: LifecycleState): boolean {
  return MEMORY_TRANSITIONS[from].includes(to);
}

export const GateResult = z.enum(["APPROVE", "REJECT", "REVIEW_REQUIRED"]);
export type GateResult = z.infer<typeof GateResult>;

export const GateDecisionSchema = z.strictObject({
  result: GateResult,
  reasonCodes: z.array(NonEmpty),
  judgeModel: z.string().nullable(),
  reviewer: z.string().nullable(),
  decidedAt: Timestamp,
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;

/** Gate judge output (PRD §9.3 judge contract). */
export const JudgeVerdictSchema = z.strictObject({
  supported: z.boolean(),
  unsupportedClaims: z.array(z.string()),
  generic: z.boolean(),
  instructionLike: z.boolean(),
  rationaleSummary: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/** Reflector output (PRD §12): an evidence summary, never a chain-of-thought transcript (INV-04). */
export const ReflectionSchema = z.strictObject({
  outcome: RunOutcome,
  failureMode: NonEmpty,
  evidenceRefs: z.array(NonEmpty),
  lesson: NonEmpty,
  appliesWhen: z.array(NonEmpty),
  doesNotApplyWhen: z.array(NonEmpty),
  suggestedMemoryKind: MemoryKind,
  requiresReview: z.boolean(),
});
export type Reflection = z.infer<typeof ReflectionSchema>;

// ---------------------------------------------------------------------- events

const Actor = z.strictObject({ kind: z.enum(["system", "model", "tool", "evaluator", "user"]), id: NonEmpty });

const eventBase = z.strictObject({
  id: Id,
  runId: Id,
  sequence: z.int().positive(),
  actor: Actor,
  timestamp: Timestamp,
  artifactRef: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

function eventVariant<T extends string, P extends z.ZodType>(type: T, redactedPayload: P) {
  return eventBase.extend({ type: z.literal(type), redactedPayload });
}

export const EventSchema = z.discriminatedUnion("type", [
  eventVariant("state_transition", z.strictObject({ from: RunState.nullable(), to: RunState, reason: NonEmpty })),
  eventVariant("retrieval_skipped", z.strictObject({ reason: z.literal("memory_disabled") })),
  eventVariant("plan_recorded", z.strictObject({ plan: PlanSchema })),
  eventVariant("tool_authorized", z.strictObject({ callId: Id, tool: NonEmpty, argsSummary: z.string() })),
  eventVariant(
    "policy_denied",
    z.strictObject({ callId: Id.nullable(), tool: z.string(), reasonCode: DenialReason, detail: z.string() }),
  ),
  eventVariant(
    "tool_result",
    z.strictObject({
      callId: Id,
      tool: NonEmpty,
      ok: z.boolean(),
      summary: z.string(),
      durationMs: z.int().nonnegative(),
      exitStatus: z.int().optional(),
    }),
  ),
  eventVariant(
    "model_output_invalid",
    z.strictObject({ stage: z.enum(["plan", "step"]), attempt: z.int().positive(), issues: z.array(z.string()) }),
  ),
  eventVariant("evaluation_recorded", z.strictObject({ evaluationId: Id, verdict: RunOutcome })),
  eventVariant(
    "evaluator_tamper_flag",
    z.strictObject({ evaluationId: Id, touchedProtectedPaths: z.array(NonEmpty), signals: z.array(NonEmpty) }),
  ),
  eventVariant("reflection_skipped", z.strictObject({ reason: z.literal("memory_disabled") })),
  eventVariant(
    "memory_use",
    z.strictObject({
      memoryId: Id,
      citedInPlan: z.boolean(),
      followed: z.boolean(),
      outcomeEffect: z.enum(["helped", "hurt", "neutral", "unknown"]),
      evidenceRef: z.string().optional(),
    }),
  ),
  eventVariant("gate_decision", z.strictObject({ memoryId: Id, decision: GateDecisionSchema })),
]);
export type RunEvent = z.infer<typeof EventSchema>;
export type RunEventType = RunEvent["type"];

// ------------------------------------------------------------------ evaluation

/** The `evaluations` document (PRD §10; `EvaluationResult` in the canonical contracts). */
export const EvaluationSchema = z.strictObject({
  id: Id,
  runId: Id,
  verdict: RunOutcome,
  outcomeReason: OutcomeReason,
  checkBundleHash: NonEmpty,
  /** null when the task has no hidden check bundle, or when it could not be resolved. */
  hiddenChecksPassed: z.boolean().nullable(),
  touchedProtectedPaths: z.array(NonEmpty),
  groundTruthRef: z.string().nullable(),
  metrics: z.record(z.string(), z.number()),
  checks: z.array(
    z.strictObject({
      name: NonEmpty,
      command: z.string().optional(),
      passed: z.boolean().nullable(),
      artifactRef: z.string().optional(),
    }),
  ),
  evaluatorVersion: NonEmpty,
  evidenceRefs: z.array(NonEmpty),
  completedAt: Timestamp,
});
export type EvaluationResult = z.infer<typeof EvaluationSchema>;

export const MemoryCandidateSchema = z
  .strictObject({
    kind: MemoryKind,
    lesson: NonEmpty,
    applicability: z.strictObject({
      projectId: Id,
      stack: z.array(NonEmpty).optional(),
      conditions: z.array(NonEmpty),
    }),
    evidenceStatus: EvidenceStatus,
    sourceRunIds: z.array(Id),
    evaluationIds: z.array(Id),
    evidenceRefs: z.array(NonEmpty),
    limitations: z.array(z.string()),
    confidence: z.number().min(0).max(1), // normalized score, not proof of correctness
  })
  .superRefine((m, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (m.sourceRunIds.length === 0) fail("sourceRunIds", "a memory needs provenance (INV-01)");
    if (m.kind !== "episodic" && m.evaluationIds.length === 0) {
      fail("evaluationIds", "only episodic records may lack a recorded evaluation (INV-01)");
    }
    if (m.kind === "procedural" && (m.evidenceStatus === "hypothesis" || m.evidenceStatus === "rejected")) {
      fail("evidenceStatus", "an untested hypothesis is not a reusable procedure (INV-03)");
    }
  });
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

/** The `memories` collection record (PRD §10, v1.1 additions, §15.2 `Memory`). Nothing writes it in Phase 0. */
export const MemoryRecordSchema = z.strictObject({
  id: Id,
  tenantId: Id,
  projectId: Id,
  kind: MemoryKind,
  text: NonEmpty,
  embedding: z.array(z.number()).optional(),
  tags: z.array(z.string()),
  scope: z.strictObject({
    stack: z.array(NonEmpty).optional(),
    environment: z.string().optional(),
    toolVersions: z.record(z.string(), z.string()).optional(),
    conditions: z.array(NonEmpty),
  }),
  preconditions: z.array(z.string()),
  lifecycleState: LifecycleState,
  confidence: z.number().min(0).max(1),
  sourceRunIds: z.array(Id).min(1),
  evaluationIds: z.array(Id),
  version: z.int().positive(),
  supersedes: Id.nullable(),
  lastVerifiedAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
  embeddingModel: z.string().nullable(),
  embeddingVersion: z.string().nullable(),
  indexVersion: z.string().nullable(),
  helpfulCount: z.int().nonnegative(),
  harmfulCount: z.int().nonnegative(),
  gateDecision: GateDecisionSchema.nullable(),
  derivedFromMemoryIds: z.array(Id),
  contentHash: NonEmpty,
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
