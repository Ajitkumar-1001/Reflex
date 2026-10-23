import { canTransition, isTerminal } from "./contracts";
import type { EvaluationResult, RunEvent, RunState } from "./contracts";
import type { CheckSet, Evaluator } from "./ports";

/**
 * Deterministic evaluator (INV-01, INV-09). The verdict comes only from executable
 * checks over the final workspace; the agent's own claim is never an input.
 */
export class CheckEvaluator implements Evaluator {
  readonly version = "check-evaluator-p0";

  constructor(private readonly checks: CheckSet) {}

  evaluate: Evaluator["evaluate"] = ({ evaluationId, runId, task, workspace, completedAt }) => {
    const results = task.doneWhen.map(({ checkId }) => {
      const check = this.checks[checkId];
      return { name: checkId, command: `check:${checkId}`, passed: check ? check(workspace) : null };
    });
    const base = {
      id: evaluationId,
      runId,
      checks: results,
      evaluatorVersion: this.version,
      evidenceRefs: results.map((r) => `check:${r.name}`),
      completedAt: completedAt.toISOString(),
    };
    if (results.length === 0 || results.some((r) => r.passed === null)) {
      return { ...base, verdict: "inconclusive", outcomeReason: "missing_checks" } satisfies EvaluationResult;
    }
    return results.every((r) => r.passed)
      ? ({ ...base, verdict: "verified_success", outcomeReason: "checks_passed" } satisfies EvaluationResult)
      : ({ ...base, verdict: "verified_failure", outcomeReason: "checks_failed" } satisfies EvaluationResult);
  };
}

export interface TraceAudit {
  /** True when the trace is gapless, legally ordered, ends terminal, and every executed tool call was authorized. */
  complete: boolean;
  problems: string[];
  executedToolCalls: number;
  deniedToolCalls: number;
  /** Tool results with no preceding `tool_authorized` event. The Phase 0 exit gate requires 0. */
  unauthorizedToolActions: number;
}

/** Independent check of the Phase 0 exit gate, computed from the trace alone. */
export function auditTrace(events: readonly RunEvent[]): TraceAudit {
  const problems: string[] = [];
  const authorized = new Set<string>();
  let executed = 0;
  let denied = 0;
  let unauthorized = 0;
  let state: RunState | null = null;

  if (events.length === 0) problems.push("trace is empty");

  for (const [i, event] of events.entries()) {
    if (event.sequence !== i + 1) problems.push(`sequence gap at index ${i}: got ${event.sequence}`);
    if (event.runId !== events[0].runId) problems.push(`event ${event.id} belongs to another run`);

    switch (event.type) {
      case "state_transition": {
        const { from, to } = event.redactedPayload;
        const legal = from === null ? to === "CREATED" && i === 0 : canTransition(from, to);
        if (from !== state) problems.push(`transition ${from}->${to} does not follow state ${state}`);
        if (!legal) problems.push(`illegal transition ${from}->${to}`);
        state = to;
        break;
      }
      case "tool_authorized":
        authorized.add(event.redactedPayload.callId);
        break;
      case "tool_result": {
        executed++;
        if (!authorized.delete(event.redactedPayload.callId)) {
          unauthorized++;
          problems.push(`tool call ${event.redactedPayload.callId} executed without authorization`);
        }
        break;
      }
      case "policy_denied":
        denied++;
        break;
      default:
        break;
    }
  }

  for (const callId of authorized) problems.push(`tool call ${callId} was authorized but has no result`);
  if (state === null || !isTerminal(state)) problems.push("trace does not end in a terminal state");

  return {
    complete: problems.length === 0,
    problems,
    executedToolCalls: executed,
    deniedToolCalls: denied,
    unauthorizedToolActions: unauthorized,
  };
}
