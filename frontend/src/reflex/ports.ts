import type { z } from "zod";
import type {
  DenialReason,
  EvaluationResult,
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
}

export type RunResult =
  | { admitted: false; issues: AdmissionIssue[] }
  | { admitted: true; run: Run; events: RunEvent[]; evaluation: EvaluationResult | null };

/** Orchestrator seam (DEC-01). A custom state machine and a Mastra adapter would both implement this. */
export interface RunEngine {
  execute(request: RunRequest): Promise<RunResult>;
}
