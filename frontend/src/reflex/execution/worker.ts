import { InMemoryWorkspace, SequentialIds, SteppingClock } from "../adapters";
import { isTerminal } from "../contracts";
import type { RunResult } from "../ports";
import type { Workspace } from "../ports";
import { ReferenceRunner } from "../runner";
import type { RunnerDeps } from "../runner";
import { InMemoryCheckpointStore } from "./checkpoint";
import type { CheckpointStore } from "./checkpoint";
import { LeaseLostError, WorkerCrash } from "./handoff";
import { DEFAULT_MAX_ATTEMPTS, InMemoryJobQueue, exponentialBackoff } from "./queue";
import type { Job, JobLease, JobQueue } from "./queue";
import type { RunCheckpoint, RunExecution } from "./types";

/**
 * One leased attempt of a dispatched run. The executor injects the workspace, ids, clock, and
 * execution hook so a resumed attempt continues from the checkpoint rather than from step zero.
 */

export interface RunJobPayload {
  dispatchId: string;
  task: unknown;
  policy: unknown;
  experiment?: { experimentId: string; trialIndex: number };
}

export interface AttemptContext {
  payload: RunJobPayload;
  workspace: Workspace;
  ids: SequentialIds;
  clock: SteppingClock;
  checkpoint: RunCheckpoint | null;
}

export interface DispatchInput {
  task: unknown;
  policy: unknown;
  idempotencyKey: string;
  experiment?: { experimentId: string; trialIndex: number };
  maxAttempts?: number;
}

export type TickResult =
  | { kind: "idle" }
  | { kind: "done"; dispatchId: string }
  | { kind: "crashed"; dispatchId: string }
  | { kind: "lost"; dispatchId: string }
  | { kind: "ack_failed"; dispatchId: string }
  | { kind: "requeued"; dispatchId: string; attempts: number; availableAt: number }
  | { kind: "dead"; dispatchId: string; attempts: number };

export interface DurableExecutorOptions {
  leaseMs: number;
  maxAttempts?: number;
  backoffMs?: (attempt: number) => number;
  clockStartMs?: number;
  clockStepMs?: number;
  queue?: JobQueue<RunJobPayload>;
  checkpoints?: CheckpointStore;
  /** A fresh workspace for a dispatch that has no checkpoint yet. Called once per such attempt. */
  blankWorkspace: () => Workspace;
  createDeps: (ctx: AttemptContext) => Omit<RunnerDeps, "workspace" | "ids" | "clock" | "execution">;
}

const CLOCK_START = Date.UTC(2026, 0, 1);
const CLOCK_STEP = 10;

/** A private copy, so a crashed attempt cannot leave partial writes in the workspace the next attempt opens. */
function copyWorkspace(workspace: Workspace): InMemoryWorkspace {
  return new InMemoryWorkspace(workspace.ref, workspace.snapshot());
}

/**
 * Leases one run at a time and drives the reference runner. A crash (WorkerCrash) does not ack or
 * nack: the lease expires and the next worker loads the last checkpoint. Any other throw is a
 * failed attempt with backoff, and the attempt cap dead-letters the job.
 */
export class DurableExecutor {
  readonly queue: JobQueue<RunJobPayload>;
  readonly checkpoints: CheckpointStore;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly clockStartMs: number;
  private readonly clockStepMs: number;
  private readonly cancelled = new Set<string>();
  private readonly results = new Map<string, RunResult>();
  private at = 0;

  constructor(private readonly options: DurableExecutorOptions) {
    if (!Number.isInteger(options.leaseMs) || options.leaseMs < 1) throw new Error("leaseMs must be a positive integer");
    this.queue = options.queue ?? new InMemoryJobQueue<RunJobPayload>();
    this.checkpoints = options.checkpoints ?? new InMemoryCheckpointStore();
    this.leaseMs = options.leaseMs;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = options.backoffMs ?? exponentialBackoff;
    this.clockStartMs = options.clockStartMs ?? CLOCK_START;
    this.clockStepMs = options.clockStepMs ?? CLOCK_STEP;
  }

  now(): number {
    return this.at;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("advance expects a non-negative finite delay");
    this.at += ms;
  }

  /** Cooperative: the run stops at the next step boundary, in state CANCELLED (outcome `cancelled`). */
  cancel(dispatchId: string): void {
    this.cancelled.add(dispatchId);
  }

  result(dispatchId: string): RunResult | undefined {
    return this.results.get(dispatchId);
  }

  async deadLetters(): Promise<readonly Job<RunJobPayload>[]> {
    return this.queue.deadLetters();
  }

  async dispatch(input: DispatchInput): Promise<Job<RunJobPayload>> {
    if (input.idempotencyKey.length === 0) throw new Error("idempotencyKey must be non-empty");
    return this.queue.enqueue({
      now: this.at,
      idempotencyKey: input.idempotencyKey,
      maxAttempts: input.maxAttempts ?? this.maxAttempts,
      payload: {
        dispatchId: input.idempotencyKey,
        task: input.task,
        policy: input.policy,
        ...(input.experiment ? { experiment: input.experiment } : {}),
      },
    });
  }

  /** Take one job, if any is due, and drive it until it finishes, crashes, or is retried. */
  async tick(workerId: string): Promise<TickResult> {
    const [lease] = await this.queue.lease({ workerId, now: this.at, leaseMs: this.leaseMs, limit: 1 });
    if (!lease) return { kind: "idle" };
    const dispatchId = lease.job.payload.dispatchId;
    let result: RunResult;
    try {
      result = await this.drive(lease);
    } catch (error) {
      if (error instanceof LeaseLostError) return { kind: "lost", dispatchId };
      if (error instanceof WorkerCrash) return { kind: "crashed", dispatchId };
      return this.fail(lease, error instanceof Error ? error.message : "job failed", false);
    }
    if (!result.admitted) {
      const message = result.issues.map((issue) => issue.message).join("; ") || "admission rejected";
      return this.fail(lease, message, true);
    }
    if (!isTerminal(result.run.status)) {
      return this.fail(lease, `run ${result.run.id} stopped in ${result.run.status}`, false);
    }
    this.results.set(dispatchId, result);
    try {
      await this.queue.ack({ jobId: lease.job.id, token: lease.token, now: this.at });
    } catch (error) {
      if (error instanceof LeaseLostError) return { kind: "lost", dispatchId };
      return { kind: "ack_failed", dispatchId };
    }
    return { kind: "done", dispatchId };
  }

  private async fail(lease: JobLease<RunJobPayload>, error: string, deadLetter: boolean): Promise<TickResult> {
    const dispatchId = lease.job.payload.dispatchId;
    try {
      const nacked = await this.queue.nack({
        jobId: lease.job.id,
        token: lease.token,
        now: this.at,
        error,
        backoffMs: this.backoffMs(lease.job.attempts + 1),
        deadLetter,
      });
      if (nacked.disposition === "dead") return { kind: "dead", dispatchId, attempts: nacked.job.attempts };
      return { kind: "requeued", dispatchId, attempts: nacked.job.attempts, availableAt: nacked.job.availableAt };
    } catch (nackError) {
      if (nackError instanceof LeaseLostError) return { kind: "lost", dispatchId };
      throw nackError;
    }
  }

  private async drive(lease: JobLease<RunJobPayload>): Promise<RunResult> {
    const { payload } = lease.job;
    const record = await this.checkpoints.load(payload.dispatchId);
    const workspace = record
      ? new InMemoryWorkspace(record.checkpoint.run.workspaceRef, { ...record.checkpoint.workspace })
      : copyWorkspace(this.options.blankWorkspace());
    const ids = new SequentialIds({ ...(record?.ids ?? {}) });
    const clock = record
      ? new SteppingClock(record.clock.startMs, record.clock.stepMs, record.clock.tick)
      : new SteppingClock(this.clockStartMs, this.clockStepMs);
    const execution: RunExecution = {
      dispatchId: payload.dispatchId,
      checkpoint: record?.checkpoint ?? null,
      isCancelled: () => this.cancelled.has(payload.dispatchId),
      save: (checkpoint) => this.saveCheckpoint(lease, ids, clock, checkpoint),
    };
    const runner = new ReferenceRunner({
      ...this.options.createDeps({ payload, workspace, ids, clock, checkpoint: record?.checkpoint ?? null }),
      workspace,
      ids,
      clock,
      execution,
    });
    return runner.execute({
      task: payload.task,
      policy: payload.policy,
      ...(payload.experiment ? { experiment: payload.experiment } : {}),
    });
  }

  private async saveCheckpoint(lease: JobLease<RunJobPayload>, ids: SequentialIds, clock: SteppingClock, checkpoint: RunCheckpoint): Promise<void> {
    await this.checkpoints.save(lease.job.payload.dispatchId, { checkpoint, ids: ids.snapshot(), clock: clock.snapshot() });
    await this.queue.heartbeat({ jobId: lease.job.id, token: lease.token, now: this.at, leaseMs: this.leaseMs });
  }
}
