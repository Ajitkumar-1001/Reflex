import { describe, expect, it } from "vitest";
import { LeaseLostError } from "./handoff";
import { InMemoryJobQueue, exponentialBackoff } from "./queue";

/* JobQueue seam: duplicate dispatch, exactly-once re-lease, expiry, backoff, and dead-letter. */

describe("InMemoryJobQueue", () => {
  it("returns the original job for a duplicate idempotency key and leases it once", async () => {
    const queue = new InMemoryJobQueue<string>();
    const first = await queue.enqueue({ payload: "run-a", now: 0, idempotencyKey: "dispatch-1" });
    const second = await queue.enqueue({ payload: "run-b", now: 5, idempotencyKey: "dispatch-1", maxAttempts: 9 });
    expect(second).toEqual(first);
    expect(second.payload).toBe("run-a");
    expect(second.maxAttempts).toBe(3);
    const [lease] = await queue.lease({ workerId: "w1", now: 5, leaseMs: 100, limit: 10 });
    expect(lease?.job.id).toBe(first.id);
    expect(await queue.lease({ workerId: "w2", now: 5, leaseMs: 100 })).toEqual([]);
    expect(await queue.list()).toHaveLength(1);
  });

  it("re-leases an expired job to exactly one worker and rejects the stale token", async () => {
    const queue = new InMemoryJobQueue<string>();
    const job = await queue.enqueue({ payload: "x", now: 0, maxAttempts: 3 });
    const [first] = await queue.lease({ workerId: "a", now: 0, leaseMs: 100 });
    if (!first) throw new Error("expected a lease");
    expect(await queue.lease({ workerId: "b", now: 99, leaseMs: 100 })).toEqual([]);

    const [left, right] = await Promise.all([
      queue.lease({ workerId: "b", now: 100, leaseMs: 50 }),
      queue.lease({ workerId: "c", now: 100, leaseMs: 50 }),
    ]);
    const won = [...left, ...right];
    const winner = won[0];
    if (!winner) throw new Error("expected exactly one re-lease");
    expect(won).toHaveLength(1);
    expect(winner.job.id).toBe(job.id);
    expect(winner.job.leaseCount).toBe(2);
    expect(winner.job.attempts).toBe(1);
    expect(winner.token).not.toBe(first.token);
    expect(await queue.list()).toHaveLength(1);

    await expect(queue.ack({ jobId: job.id, token: first.token, now: 100 })).rejects.toBeInstanceOf(LeaseLostError);
    await expect(queue.heartbeat({ jobId: job.id, token: first.token, now: 110, leaseMs: 50 })).rejects.toBeInstanceOf(LeaseLostError);
    const extended = await queue.heartbeat({ jobId: job.id, token: winner.token, now: 120, leaseMs: 50 });
    expect(extended.lease?.expiresAt).toBe(170);
    expect(await queue.lease({ workerId: "d", now: 169, leaseMs: 50 })).toEqual([]);
    await queue.ack({ jobId: job.id, token: winner.token, now: 120 });
    const again = await queue.ack({ jobId: job.id, token: winner.token, now: 500 });
    expect(again.state).toBe("acked");
    expect(await queue.lease({ workerId: "e", now: 500, leaseMs: 50 })).toEqual([]);
  });

  it("hides a nacked job until its backoff elapses, then dead-letters when attempts are exhausted", async () => {
    const queue = new InMemoryJobQueue<string>();
    const job = await queue.enqueue({ payload: "x", now: 0, maxAttempts: 3 });
    const take = async (now: number) => {
      const [lease] = await queue.lease({ workerId: "w", now, leaseMs: 10 });
      if (!lease) throw new Error(`no lease at ${now}`);
      return lease;
    };
    const first = await take(0);
    const retried = await queue.nack({ jobId: job.id, token: first.token, now: 0, error: "store down", backoffMs: 500 });
    expect(retried).toMatchObject({ disposition: "requeued", job: { attempts: 1, availableAt: 500, state: "queued" } });
    expect(await queue.lease({ workerId: "w", now: 499, leaseMs: 10 })).toEqual([]);

    const second = await take(500);
    expect(second.job.attempts).toBe(1);
    await queue.nack({ jobId: job.id, token: second.token, now: 500, error: "store down", backoffMs: exponentialBackoff(2) });
    const third = await take(500 + exponentialBackoff(2));
    const dead = await queue.nack({ jobId: job.id, token: third.token, now: 2_500, error: "store down", backoffMs: 0 });
    expect(dead.disposition).toBe("dead");
    expect(dead.job.attempts).toBe(3);
    expect(await queue.deadLetters()).toEqual([expect.objectContaining({ id: job.id, state: "dead", lastError: "store down" })]);
    expect(await queue.lease({ workerId: "w", now: 9_000, leaseMs: 10 })).toEqual([]);
    const duplicate = await queue.enqueue({ payload: "other", now: 9_000, idempotencyKey: undefined });
    expect(duplicate.id).not.toBe(job.id);
  });

  it("dead-letters a lease that expires once when maxAttempts is 1", async () => {
    const queue = new InMemoryJobQueue<string>();
    const job = await queue.enqueue({ payload: "poison", now: 0, maxAttempts: 1, idempotencyKey: "poison" });
    await queue.lease({ workerId: "a", now: 0, leaseMs: 10 });
    expect(await queue.lease({ workerId: "b", now: 10, leaseMs: 10 })).toEqual([]);
    expect(await queue.deadLetters()).toEqual([expect.objectContaining({ id: job.id, attempts: 1, lastError: "lease expired" })]);
    const again = await queue.enqueue({ payload: "poison", now: 20, idempotencyKey: "poison" });
    expect(again.state).toBe("dead");
  });

  it("rejects a nack after the lease has already been reclaimed", async () => {
    const queue = new InMemoryJobQueue<string>();
    const job = await queue.enqueue({ payload: "x", now: 0, maxAttempts: 3 });
    const [first] = await queue.lease({ workerId: "a", now: 0, leaseMs: 10 });
    if (!first) throw new Error("expected a lease");
    const [second] = await queue.lease({ workerId: "b", now: 10, leaseMs: 10 });
    if (!second) throw new Error("expected a re-lease");
    await expect(queue.nack({ jobId: job.id, token: first.token, now: 10, error: "late", backoffMs: 0 })).rejects.toBeInstanceOf(LeaseLostError);
    expect(second.job.attempts).toBe(1);
    const held = await queue.nack({ jobId: job.id, token: second.token, now: 10, error: "real", backoffMs: 0 });
    expect(held.job.attempts).toBe(2);
  });
});
