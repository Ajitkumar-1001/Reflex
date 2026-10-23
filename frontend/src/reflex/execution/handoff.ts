/**
 * Errors the reference runner must not turn into a terminal run. The worker still holds the
 * decision: a crash leaves the last checkpoint, and a lost lease means another worker owns the job.
 */

/** Base class for control transferred back to the durable worker. */
export class RunHandoff extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The worker process died mid-step. The job stays leased until the lease expires and is re-leased. */
export class WorkerCrash extends RunHandoff {
  constructor(message = "worker crashed") {
    super(message);
  }
}

/** The lease token is unknown, expired, or already held by another worker. */
export class LeaseLostError extends RunHandoff {
  constructor(message: string) {
    super(message);
  }
}
