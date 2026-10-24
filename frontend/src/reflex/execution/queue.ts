import { LeaseLostError } from "./handoff";

/**
 * In-memory `JobQueue` (Phase 2, DEC-03). The critical section does not await, so two overlapping
 * `lease` calls cannot both take the same job. BullMQ and ioredis are not imported; a Redis
 * adapter would implement the same interface later.
 */

export type JobState = "queued" | "leased" | "acked" | "dead";

export interface Job<T> {
  id: string;
  idempotencyKey: string | null;
  payload: T;
  state: JobState;
  /** Failed attempts so far: nacks and expired leases. A clean completion leaves this unchanged. */
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  lease: { workerId: string; token: string; expiresAt: number } | null;
  /** How many times a worker has held this job. A re-lease increments it; it does not copy the job. */
  leaseCount: number;
  lastError: string | null;
  deadLetteredAt: number | null;
}

export interface JobLease<T> {
  job: Job<T>;
  token: string;
  workerId: string;
  expiresAt: number;
}

export interface EnqueueInput<T> {
  payload: T;
  now: number;
  idempotencyKey?: string;
  maxAttempts?: number;
  availableAt?: number;
}

export interface LeaseInput {
  workerId: string;
  now: number;
  leaseMs: number;
  limit?: number;
}

export interface LeaseToken {
  jobId: string;
  token: string;
  now: number;
}

/**
 * Durable job queue. `enqueue` with the same idempotency key returns the original job in any
 * state, including acked and dead, so a duplicate dispatch does not start a second run.
 */
export interface JobQueue<T> {
  enqueue(input: EnqueueInput<T>): Promise<Job<T>>;
  lease(input: LeaseInput): Promise<readonly JobLease<T>[]>;
  heartbeat(input: LeaseToken & { leaseMs: number }): Promise<Job<T>>;
  ack(input: LeaseToken): Promise<Job<T>>;
  /** `defer`: the job is waiting on something, not failing. It is queued again after `backoffMs` and `attempts` is unchanged. */
  nack(input: LeaseToken & { error: string; backoffMs: number; deadLetter?: boolean; defer?: boolean }): Promise<{ job: Job<T>; disposition: "requeued" | "dead" }>;
  deadLetters(): Promise<readonly Job<T>[]>;
}

interface InternalJob<T> {
  id: string;
  idempotencyKey: string | null;
  payload: T;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  lease: { workerId: string; token: string; expiresAt: number } | null;
  leaseCount: number;
  lastError: string | null;
  deadLetteredAt: number | null;
  ackedToken: string | null;
}

const copy = <T>(value: T): T => structuredClone(value);

const finite = (name: string, value: number): void => {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
};

const positiveInt = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
};

export const DEFAULT_MAX_ATTEMPTS = 3;

/** Bounded exponential backoff: `baseMs`, then double, capped. `attempt` is 1-based. */
export function exponentialBackoff(attempt: number, baseMs = 1_000, capMs = 30_000): number {
  positiveInt("attempt", attempt);
  finite("baseMs", baseMs);
  finite("capMs", capMs);
  if (baseMs < 0 || capMs < 0) throw new Error("backoff bounds must be non-negative");
  return Math.min(capMs, baseMs * 2 ** (attempt - 1));
}

export class InMemoryJobQueue<T> implements JobQueue<T> {
  private readonly jobs: InternalJob<T>[] = [];
  private readonly byId = new Map<string, InternalJob<T>>();
  private readonly byKey = new Map<string, InternalJob<T>>();
  private sequence = 0;

  async enqueue(input: EnqueueInput<T>): Promise<Job<T>> {
    finite("now", input.now);
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    positiveInt("maxAttempts", maxAttempts);
    if (input.availableAt !== undefined) finite("availableAt", input.availableAt);
    const key = input.idempotencyKey ?? null;
    if (key !== null && key.length === 0) throw new Error("idempotencyKey must be non-empty when set");
    if (key !== null) {
      const existing = this.byKey.get(key);
      if (existing) return this.toJob(existing);
    }
    const job: InternalJob<T> = {
      id: `job-${++this.sequence}`,
      idempotencyKey: key,
      payload: copy(input.payload),
      state: "queued",
      attempts: 0,
      maxAttempts,
      availableAt: input.availableAt ?? input.now,
      lease: null,
      leaseCount: 0,
      lastError: null,
      deadLetteredAt: null,
      ackedToken: null,
    };
    this.jobs.push(job);
    this.byId.set(job.id, job);
    if (key !== null) this.byKey.set(key, job);
    return this.toJob(job);
  }

  async lease(input: LeaseInput): Promise<readonly JobLease<T>[]> {
    if (input.workerId.length === 0) throw new Error("workerId must be non-empty");
    finite("now", input.now);
    positiveInt("leaseMs", input.leaseMs);
    const limit = input.limit ?? 1;
    if (!Number.isInteger(limit) || limit < 0) throw new Error("limit must be a non-negative integer");
    // Reclaim and mark leased before this method yields, so a concurrent caller sees the job taken.
    this.reclaimExpired(input.now);
    const taken: JobLease<T>[] = [];
    for (const job of this.jobs) {
      if (taken.length >= limit) break;
      if (job.state !== "queued" || job.availableAt > input.now) continue;
      const token = `lease-${++this.sequence}`;
      const expiresAt = input.now + input.leaseMs;
      job.state = "leased";
      job.leaseCount += 1;
      job.lease = { workerId: input.workerId, token, expiresAt };
      taken.push({ job: this.toJob(job), token, workerId: input.workerId, expiresAt });
    }
    return taken;
  }

  async heartbeat(input: LeaseToken & { leaseMs: number }): Promise<Job<T>> {
    finite("now", input.now);
    positiveInt("leaseMs", input.leaseMs);
    const job = this.requireActive(input.jobId, input.token, input.now);
    const lease = job.lease;
    if (lease === null) throw new LeaseLostError(`lease ${input.token} is not active for job ${input.jobId}`);
    job.lease = { workerId: lease.workerId, token: lease.token, expiresAt: input.now + input.leaseMs };
    return this.toJob(job);
  }

  async ack(input: LeaseToken): Promise<Job<T>> {
    finite("now", input.now);
    const job = this.require(input.jobId);
    if (job.state === "acked" && job.ackedToken === input.token) return this.toJob(job);
    this.requireActive(input.jobId, input.token, input.now);
    job.state = "acked";
    job.ackedToken = input.token;
    job.lease = null;
    return this.toJob(job);
  }

  async nack(input: LeaseToken & { error: string; backoffMs: number; deadLetter?: boolean; defer?: boolean }): Promise<{ job: Job<T>; disposition: "requeued" | "dead" }> {
    finite("now", input.now);
    finite("backoffMs", input.backoffMs);
    if (input.backoffMs < 0) throw new Error("backoffMs must be non-negative");
    const job = this.requireActive(input.jobId, input.token, input.now);
    const deferred = input.defer === true && input.deadLetter !== true;
    if (!deferred) job.attempts += 1;
    job.lastError = input.error.slice(0, 300);
    job.lease = null;
    if (input.deadLetter === true || (!deferred && job.attempts >= job.maxAttempts)) {
      job.state = "dead";
      job.deadLetteredAt = input.now;
      return { job: this.toJob(job), disposition: "dead" };
    }
    job.state = "queued";
    job.availableAt = input.now + input.backoffMs;
    return { job: this.toJob(job), disposition: "requeued" };
  }

  async deadLetters(): Promise<readonly Job<T>[]> {
    return this.jobs.filter((job) => job.state === "dead").map((job) => this.toJob(job));
  }

  /** Every job, in enqueue order. For tests; not part of the adapter seam. */
  async list(): Promise<readonly Job<T>[]> {
    return this.jobs.map((job) => this.toJob(job));
  }

  /** An expired lease is one failed attempt. Under the cap the same record is queued again. */
  private reclaimExpired(now: number): void {
    for (const job of this.jobs) {
      if (job.state !== "leased" || job.lease === null || now < job.lease.expiresAt) continue;
      job.attempts += 1;
      job.lastError = "lease expired";
      job.lease = null;
      if (job.attempts >= job.maxAttempts) {
        job.state = "dead";
        job.deadLetteredAt = now;
      } else {
        job.state = "queued";
        job.availableAt = now;
      }
    }
  }

  private require(jobId: string): InternalJob<T> {
    const job = this.byId.get(jobId);
    if (!job) throw new LeaseLostError(`no job ${jobId}`);
    return job;
  }

  private requireActive(jobId: string, token: string, now: number): InternalJob<T> {
    const job = this.require(jobId);
    if (job.state !== "leased" || job.lease === null || job.lease.token !== token || now >= job.lease.expiresAt) {
      throw new LeaseLostError(`lease ${token} is not active for job ${jobId}`);
    }
    return job;
  }

  private toJob(job: InternalJob<T>): Job<T> {
    return {
      id: job.id,
      idempotencyKey: job.idempotencyKey,
      payload: copy(job.payload),
      state: job.state,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      availableAt: job.availableAt,
      lease: job.lease ? { ...job.lease } : null,
      leaseCount: job.leaseCount,
      lastError: job.lastError,
      deadLetteredAt: job.deadLetteredAt,
    };
  }
}
