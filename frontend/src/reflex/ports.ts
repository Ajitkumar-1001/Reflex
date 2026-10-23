import type { z } from "zod";
import type {
  EvaluationResult,
  Plan,
  Run,
  RunEvent,
  SideEffectClass,
  Task,
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
}

export type WorkspaceReader = Pick<Workspace, "list" | "read">;

/** A deterministic check over the final workspace. `checkId` in a task's `doneWhen` resolves here. */
export type CheckSet = Readonly<Record<string, (workspace: WorkspaceReader) => boolean>>;

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

/** Provider seam (DEC-04). Throw `ModelUnavailableError` for provider outages. */
export interface ModelAdapter {
  readonly config: { provider: string; model: string; version: string };
  plan(input: PlanInput): Promise<ModelResponse>;
  nextStep(input: StepInput): Promise<ModelResponse>;
}

export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
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
  /** Workspace paths the call would touch, from already-validated arguments. */
  touchedPaths(args: unknown): string[];
}

export interface ToolContext {
  workspace: Workspace;
  checks: CheckSet;
}

/** `summary` is persisted in the trace; `observation` goes back to the model and is untrusted data. */
export interface ToolOutput {
  ok: boolean;
  summary: string;
  observation: string;
}

export interface ToolAdapter {
  readonly descriptor: ToolDescriptor;
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

// -------------------------------------------------------------- evaluation

export interface Evaluator {
  readonly version: string;
  evaluate(input: { evaluationId: string; runId: string; task: Task; workspace: WorkspaceReader; completedAt: Date }): EvaluationResult;
}

// ------------------------------------------------------------ trace and run

/** Receives every event as it is emitted. Atlas `events` and OpenTelemetry attach here. */
export interface EventSink {
  append(event: RunEvent): void;
}

export interface AdmissionIssue {
  code: string;
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
