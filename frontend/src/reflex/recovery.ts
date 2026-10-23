import { RunSchema, isTerminal } from "./contracts";
import type { Run, RunEvent } from "./contracts";
import type { Clock, IdGenerator } from "./ports";

/**
 * Startup recovery for the non-durable P0 executor (PRD §7.8, last row). A run found in a non-terminal state
 * after a restart is marked FAILED/internal_error with a state_transition event; nothing resumes it.
 * `events` is the run's existing trace, so the new event continues its sequence.
 */
export function recoverInterruptedRun(
  run: Run,
  events: readonly RunEvent[],
  clock: Clock,
  ids: IdGenerator,
): { run: Run; event: RunEvent | null } {
  if (isTerminal(run.status)) return { run, event: null };
  const timestamp = clock.now().toISOString();
  const event: RunEvent = {
    id: ids.next("evt"),
    runId: run.id,
    sequence: (events.at(-1)?.sequence ?? 0) + 1,
    actor: { kind: "system", id: "startup-recovery" },
    timestamp,
    type: "state_transition",
    redactedPayload: { from: run.status, to: "FAILED", reason: `internal_error: process stopped while run was ${run.status}` },
  };
  const recovered = RunSchema.parse({
    ...run,
    status: "FAILED",
    outcome: "failed",
    outcomeReason: "internal_error",
    timestamps: { ...run.timestamps, updatedAt: timestamp, endedAt: timestamp },
  });
  return { run: recovered, event };
}
