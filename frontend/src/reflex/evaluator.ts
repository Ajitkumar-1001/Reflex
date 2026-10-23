import { createHash } from "node:crypto";
import { canTransition, isTerminal, taskChecks } from "./contracts";
import type { EvaluationResult, RunEvent, RunState } from "./contracts";
import { isProtectedPath } from "./paths";
import type { CommandTable, Evaluator, HiddenCheckBundle } from "./ports";

/*
 * Test-weakening markers (PRD §12.1: `.skip`, `xit`, `--passWithNoTests`). Narrowed globs are the fourth
 * example the PRD gives; there is no static rule for them yet, so only a touched protected path catches them.
 */
const SKIP_MARKERS: readonly { name: string; pattern: RegExp }[] = [
  { name: "skip_marker", pattern: /\b(?:it|test|describe)\.(?:skip|todo)\b|\bx(?:it|test|describe)\b/g },
  { name: "pass_with_no_tests", pattern: /--passWithNoTests\b/g },
];

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

export interface TamperReport {
  touchedProtectedPaths: string[];
  /** `<marker>:<path>` for each file that gained a test-weakening marker. */
  signals: string[];
}

/** Static tamper detection over the run's start and end workspace states (INV-10). */
export function detectTamper(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  scope: Parameters<typeof isProtectedPath>[1],
): TamperReport {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = paths.filter((p) => before[p] !== after[p]);
  const signals = changed.flatMap((path) =>
    SKIP_MARKERS.filter(({ pattern }) => count(after[path] ?? "", pattern) > count(before[path] ?? "", pattern)).map(
      ({ name }) => `${name}:${path}`,
    ),
  );
  return { touchedProtectedPaths: changed.filter((p) => isProtectedPath(p, scope)), signals };
}

/**
 * Deterministic evaluator (INV-01, INV-09, INV-10). The verdict comes only from executing each check's
 * command against a copy of the final workspace; the agent's own claim is never an input. A run that
 * touched a protected path or weakened a test is `inconclusive/evaluator_tamper_suspected`, whatever the
 * checks say. A hidden check bundle, if the task names one, must also pass for `verified_success`.
 */
export class CheckEvaluator implements Evaluator {
  readonly version = "check-evaluator-p0";

  constructor(
    private readonly commands: CommandTable,
    private readonly hiddenBundles: Readonly<Record<string, HiddenCheckBundle>> = {},
  ) {}

  evaluate: Evaluator["evaluate"] = ({ evaluationId, runId, task, workspace, before, completedAt }) => {
    const visible = taskChecks(task);
    const hiddenRef = task.mode === "build" ? (task.doneWhen.hiddenCheckBundleRef ?? null) : null;
    const hidden = hiddenRef === null ? null : (this.hiddenBundles[hiddenRef] ?? null);

    const results = visible.map(({ name, command }) => {
      const run = this.commands[command];
      return { name, command, passed: run ? run(workspace.clone()).exitCode === 0 : null };
    });
    const hiddenPassed = hidden ? hidden.checks.every((c) => hidden.commands[c.command]?.(workspace.clone()).exitCode === 0) : null;
    const tamper = detectTamper(before, workspace.snapshot(), task.scope);

    const checkBundleHash = `sha256:${createHash("sha256")
      .update(JSON.stringify({ visible, hidden: hidden?.checks ?? [] }))
      .digest("hex")}`;
    const base = {
      id: evaluationId,
      runId,
      checkBundleHash,
      hiddenChecksPassed: hiddenPassed,
      touchedProtectedPaths: tamper.touchedProtectedPaths,
      groundTruthRef: hiddenRef,
      metrics: { checksRun: results.length, checksPassed: results.filter((r) => r.passed).length },
      checks: results,
      evaluatorVersion: this.version,
      evidenceRefs: [...results.map((r) => `check:${r.name}`), ...tamper.signals.map((s) => `tamper:${s}`)],
      completedAt: completedAt.toISOString(),
    };

    if (tamper.touchedProtectedPaths.length > 0 || tamper.signals.length > 0) {
      return { ...base, verdict: "inconclusive", outcomeReason: "evaluator_tamper_suspected" } satisfies EvaluationResult;
    }
    if (results.length === 0 || results.some((r) => r.passed === null) || (hiddenRef !== null && hidden === null)) {
      return { ...base, verdict: "inconclusive", outcomeReason: "missing_checks" } satisfies EvaluationResult;
    }
    return results.every((r) => r.passed) && hiddenPassed !== false
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
