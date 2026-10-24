import type { EvaluationResult, Plan, Run, RunEvent, ToolCallRequest } from "../contracts";
import type { MemoryCard, Observation } from "../ports";

/**
 * Durable-execution seam for the reference runner (Phase 2, DEC-03). Absent on `RunnerDeps`, the
 * runner stays the non-durable in-process loop and its traces do not change. A BullMQ adapter is
 * not this type: the queue lives behind `JobQueue`, and this is only what one attempt needs.
 */

/** Where a checkpoint sits. `terminal` is a finished run and is never executed again. */
export type CheckpointPhase = "executing" | "evaluated" | "terminal";

/**
 * The tool call a run is paused on. The approval record keeps only a truncated `argsSummary`, so the
 * call itself travels in the checkpoint and a resumed attempt does not ask the model again.
 */
export interface PendingApproval {
  approvalId: string;
  callId: string;
  call: ToolCallRequest;
}

/**
 * Everything required to continue a run after the last completed step. Tool side effects that
 * happened after this snapshot are discarded with the crashed attempt.
 */
export interface RunCheckpoint {
  version: 1;
  dispatchId: string;
  phase: CheckpointPhase;
  run: Run;
  events: RunEvent[];
  evaluation: EvaluationResult | null;
  /** Workspace as the run found it, for the evaluator's tamper diff. */
  before: Readonly<Record<string, string>>;
  /** Workspace after the last completed step. */
  workspace: Readonly<Record<string, string>>;
  plan: Plan | null;
  observations: Observation[];
  denials: number;
  /** The tool loop has exited (`finish` or equivalent). Later phases must not re-enter it. */
  executionFinished: boolean;
  cards: MemoryCard[];
  memoryBlock: string;
  /** Present only while `run.status` is AWAITING_APPROVAL. Absent on every other checkpoint. */
  awaiting?: PendingApproval;
}

/** What the runner calls. The worker implements it with a checkpoint store and the live lease. */
export interface RunExecution {
  readonly dispatchId: string;
  readonly checkpoint: RunCheckpoint | null;
  save(checkpoint: RunCheckpoint): Promise<void>;
  /** Polled at step boundaries. A true result stops the run as CANCELLED / cancelled / user_cancel. */
  isCancelled(): boolean;
}
