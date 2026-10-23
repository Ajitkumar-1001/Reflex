import type { z } from "zod";
import type {
  DenialReason,
  EvaluationResult,
  LifecycleState,
  MemoryCandidate,
  MemoryKind,
  MemoryRecord,
  Plan,
  Policy,
  Run,
  RunEvent,
  SideEffectClass,
  Task,
  TaskScope,
} from "./contracts";

/*
 * Seams. Each interface is where a deferred decision plugs in; see README.md for the
 * DEC block each one belongs to. Nothing here depends on a concrete framework.
 */

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: string): string;
}

/** Sandbox seam (DEC-02). Phase 0 uses an in-memory map; no isolation is claimed. */
export interface Workspace {
  readonly ref: string;
  list(prefix: string): string[];
  read(path: string): string | undefined;
  write(path: string, content: string): void;
  hash(): string;
  /** Every file by path, for diffing the start and end states of a run. */
  snapshot(): Readonly<Record<string, string>>;
  /** An independent copy, so a check can run against the final state without being able to change it. */
  clone(): Workspace;
}

export interface CommandResult {
  exitCode: number;
  output: string;
}

/**
 * Stand-in for a sandboxed process (DEC-02), keyed by the space-joined argv. `run_command` and the
 * task's `doneWhen` checks both resolve through it; a handler may mutate the workspace it is given.
 */
export type CommandTable = Readonly<Record<string, (workspace: Workspace) => CommandResult>>;

/** Large tool output is stored by content hash and referenced from the event (PRD §10, §11). Retention is DEC-05. */
export interface ArtifactStore {
  /** Returns the `sha256:<hex>` reference. */
  put(content: string): string;
}

// ------------------------------------------------------------------- model

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/** `output` is untrusted until the runner parses it with the matching Zod schema. */
export interface ModelResponse {
  output: unknown;
  usage: ModelUsage;
}

export interface Observation {
  callId: string;
  tool: string;
  ok: boolean;
  text: string;
}

export interface PlanInput {
  objective: string;
  mode: Task["mode"];
  authorizedTools: readonly string[];
  /** Retrieved memory, memory-on arms only. Untrusted advisory data (INV-02, PRD §17.1). */
  memory?: { cards: readonly MemoryCard[]; context: string };
  validationError?: string;
}

export interface StepInput {
  step: number;
  plan: Plan;
  observations: readonly Observation[];
  validationError?: string;
}

/** Provider seam (DEC-10 pins the model, DEC-04 gates cloud use). Throw `ModelUnavailableError` for provider outages. */
export interface ModelAdapter {
  readonly config: { provider: string; model: string; version: string };
  plan(input: PlanInput): Promise<ModelResponse>;
  nextStep(input: StepInput): Promise<ModelResponse>;
}

/** A retryable provider failure: 429, 5xx or a network error (PRD §7.8). */
export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

/** The sandbox or its runtime is unavailable or crashed (PRD §7.8). Not retried in P0. */
export class InfraFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfraFailureError";
  }
}

// ------------------------------------------------------------------- tools

export interface ToolDescriptor {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly sideEffect: SideEffectClass;
  readonly requiredPermissions: readonly string[];
  readonly timeoutMs: number;
  readonly idempotent: boolean;
  readonly endsExecution: boolean;
  readonly outputSchema: z.ZodType<ToolOutput>;
  /** Workspace paths the call would touch, from already-validated arguments. */
  touchedPaths(args: unknown): string[];
  /** Argument-dependent policy check that the input schema cannot express, e.g. the command allowlist. */
  denyArgs?(args: unknown, policy: Policy): Denial | null;
}

export type Denial = { reasonCode: DenialReason; detail: string };

export interface ToolContext {
  workspace: Workspace;
  scope: TaskScope;
  commands: CommandTable;
  artifacts: ArtifactStore;
}

/** `summary` is persisted in the trace; `observation` goes back to the model and is untrusted data. */
export interface ToolOutput {
  ok: boolean;
  summary: string;
  observation: string;
  exitStatus?: number;
  artifactRef?: string;
}

export interface ToolAdapter {
  readonly descriptor: ToolDescriptor;
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

// -------------------------------------------------------------- evaluation

/**
 * Checks the agent never sees (PRD §12.1), resolved by the task's `hiddenCheckBundleRef`. The bundle
 * lives with the evaluator, not in the worktree, so the agent cannot read or edit it.
 */
export interface HiddenCheckBundle {
  checks: readonly { name: string; command: string }[];
  commands: CommandTable;
}

export interface Evaluator {
  readonly version: string;
  evaluate(input: {
    evaluationId: string;
    runId: string;
    task: Task;
    /** The workspace as the run left it; the evaluator only runs checks against copies. */
    workspace: Workspace;
    /** The workspace as the run found it, to detect changes to protected paths. */
    before: Readonly<Record<string, string>>;
    completedAt: Date;
  }): EvaluationResult;
}

// ------------------------------------------------------------ trace and run

/** Receives every event as it is emitted. Atlas `events` and OpenTelemetry attach here. */
export interface EventSink {
  append(event: RunEvent): void;
}

/** `code` follows the PRD §15.1 error taxonomy; `reason` is the specific rule that failed. */
export interface AdmissionIssue {
  code: "validation_error" | "forbidden_field" | "policy_violation";
  reason: string;
  message: string;
}

export interface RunRequest {
  task: unknown;
  policy: unknown;
  signal?: AbortSignal;
  /** Set when the run is one cell of an experiment (PRD §10 `experiment_id`, `trial_index`). */
  experiment?: { experimentId: string; trialIndex: number };
}

export type RunResult =
  | { admitted: false; issues: AdmissionIssue[] }
  | { admitted: true; run: Run; events: RunEvent[]; evaluation: EvaluationResult | null };

/** Orchestrator seam (DEC-01). A custom state machine and a Mastra adapter would both implement this. */
export interface RunEngine {
  execute(request: RunRequest): Promise<RunResult>;
}

// ------------------------------------------------------------------ memory

/** A bounded, concise memory card with provenance (PRD §7.3): what a plan sees, never a transcript. */
export interface MemoryCard {
  memoryId: string;
  version: number;
  kind: MemoryKind;
  text: string;
  confidence: number;
  rank: number;
  score: number;
  appliesWhen: readonly string[];
  doesNotApplyWhen: readonly string[];
  provenance: { sourceRunIds: readonly string[]; evaluationIds: readonly string[]; lastVerifiedAt: string | null };
}

/** Embedding seam (DEC-10 pins the model). A real adapter calls a provider, hence async. */
export interface Embedder {
  readonly model: string;
  readonly version: string;
  embed(text: string): Promise<number[]>;
}

/** The persistence store cannot be reached (PRD §7.8 "Atlas unavailable"). */
export class RepositoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryUnavailableError";
  }
}

/** The embedding provider is unreachable; retrieval degrades like a repository outage (PRD §7.8). */
export class EmbedderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedderUnavailableError";
  }
}

/** A conditional update lost the race: the stored version is not the expected one (PRD §9.6 `409 invalid_transition`). */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleVersionError";
  }
}

/** Memory is frozen for this arm (PRD §12.3): any write is a bug, so it fails loudly. */
export class FrozenMemoryError extends Error {
  constructor() {
    super("memory repository is frozen; writeback is disabled for this arm");
    this.name = "FrozenMemoryError";
  }
}

export interface MemoryFilter {
  tenantId: string;
  projectId: string;
  lifecycleStates?: readonly LifecycleState[];
  kinds?: readonly MemoryKind[];
}

/**
 * The `memories` collection (DEC-08: six collections on Atlas). `find` is the pre-filter of PRD §9.2: tenant and
 * project are mandatory, so a query cannot be written that spans scopes.
 */
export interface MemoryRepository {
  insert(record: MemoryRecord): Promise<void>;
  get(id: string): Promise<MemoryRecord | undefined>;
  find(filter: MemoryFilter): Promise<MemoryRecord[]>;
  /** Conditional update on `(id, version)`; `next.version` must be `expectedVersion + 1`. Throws `StaleVersionError`. */
  replace(next: MemoryRecord, expectedVersion: number): Promise<void>;
}

/** Read and append access to `tasks`, `runs`, `evaluations` and `events`, for provenance checks and audit. */
export interface RunRecords {
  getTask(id: string): Promise<Task | undefined>;
  getRun(id: string): Promise<Run | undefined>;
  getEvaluation(id: string): Promise<EvaluationResult | undefined>;
  getEvents(runId: string): Promise<readonly RunEvent[]>;
  /** The next free `(run_id, sequence)` slot. */
  nextSequence(runId: string): Promise<number>;
  appendEvent(event: RunEvent): Promise<void>;
  /** Source runs under an unrestored quarantine (PRD §9.6). */
  quarantinedRunIds(): Promise<ReadonlySet<string>>;
}

/** The reflector is down (PRD §7.8: the run outcome stands). */
export class ReflectorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReflectorUnavailableError";
  }
}

/** The gate judge is down (PRD §7.8, §9.3: candidates go to `REVIEW_REQUIRED / judge_unavailable`). */
export class JudgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeUnavailableError";
  }
}

export interface ReflectionInput {
  task: Task;
  run: Run;
  evaluation: EvaluationResult;
  /** The run's trace so far, so a reflection can cite `event:<run>:<sequence>` evidence. */
  events: readonly RunEvent[];
  validationError?: string;
}

/** Structured reflection (PRD §12). `output` is untrusted until parsed with `ReflectionSchema`. DEC-12 for the model. */
export interface Reflector {
  readonly config: { provider: string; model: string; version: string };
  reflect(input: ReflectionInput): Promise<ModelResponse>;
}

export interface JudgeInput {
  candidate: MemoryCandidate;
  /** Redacted excerpts of the cited evidence. */
  evidenceExcerpts: readonly string[];
}

/** Gate judge (PRD §9.3). Must be a different prompt, ideally model family, from the reflector (DEC-12). */
export interface MemoryJudge {
  readonly config: { provider: string; model: string; version: string };
  judge(input: JudgeInput): Promise<ModelResponse>;
}
