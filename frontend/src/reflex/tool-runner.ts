import { effectKey } from "./ledger";
import type { SideEffectLedger } from "./ledger";
import type { ApprovalRequest, ApprovalStore } from "./approval";
import { RunHandoff } from "./execution/handoff";
import { InfraFailureError } from "./ports";
import type { Clock, ToolAdapter, ToolContext, ToolOutput } from "./ports";

/*
 * The only path that performs a tool's side effect. An action marked as needing approval — every
 * `external_write`, plus any tool the policy lists — is refused unless the approval store holds a
 * matching, unexpired grant. The grant is read from the store, not from the caller. A mutation is
 * ledgered as `intended` before `execute`, and a key that is already present is never executed again.
 */

export function actionRequiresApproval(tool: ToolAdapter, marks: readonly string[]): boolean {
  return tool.descriptor.sideEffect === "external_write" || marks.includes(tool.descriptor.name);
}

export type DispatchBlock = "approval_required" | "approval_pending" | "approval_denied" | "approval_expired";

export type DispatchResult =
  | { kind: "executed"; output: ToolOutput; key: string | null; infraFailure: InfraFailureError | null }
  | { kind: "replayed"; output: ToolOutput | null; key: string; state: "intended" | "committed" | "failed" }
  | { kind: "blocked"; reason: DispatchBlock; key: string };

export interface DispatchInput {
  runId: string;
  step: number;
  tool: ToolAdapter;
  args: unknown;
  ctx: ToolContext;
  ledger: SideEffectLedger;
  grants: ApprovalStore;
  /** Id of the approval created for this call. Null when the caller has none. */
  approvalId: string | null;
  /** `policy.approvalRequirements`: tool names that need a grant besides every external write. */
  approvalMarks: readonly string[];
  clock: Clock;
  timeoutMs: number;
}

class TimedOut extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimedOut()), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function grantBlock(grant: ApprovalRequest | undefined, key: string, tool: string, runId: string, now: string): DispatchBlock | null {
  if (!grant || grant.runId !== runId || grant.tool !== tool || grant.idempotencyKey !== key) return "approval_required";
  if (grant.status === "denied") return "approval_denied";
  if (grant.status === "expired" || grant.expiresAt <= now) return "approval_expired";
  if (grant.status === "pending") return "approval_pending";
  return grant.status === "approved" ? null : "approval_required";
}

async function runTool(tool: ToolAdapter, args: unknown, ctx: ToolContext, timeoutMs: number): Promise<{
  output: ToolOutput;
  infraFailure: InfraFailureError | null;
}> {
  try {
    return { output: await withTimeout(tool.execute(args, ctx), timeoutMs), infraFailure: null };
  } catch (error) {
    // A crash or lost lease hands the run back to the worker. The ledger row stays `intended`, so the resumed attempt does not run the mutation again.
    if (error instanceof RunHandoff) throw error;
    if (error instanceof InfraFailureError) {
      return { output: { ok: false, summary: "sandbox unavailable", observation: error.message }, infraFailure: error };
    }
    if (error instanceof TimedOut) {
      return {
        output: { ok: false, summary: "tool timed out", observation: `${tool.descriptor.name} timed out after ${timeoutMs} ms` },
        infraFailure: null,
      };
    }
    return {
      output: { ok: false, summary: "tool raised an error", observation: error instanceof Error ? error.message : "tool error" },
      infraFailure: null,
    };
  }
}

/** Authorize, ledger, then execute. A blocked or replayed call does not call `execute`. */
export async function dispatchEffect(input: DispatchInput): Promise<DispatchResult> {
  const { runId, step, tool, args, ledger, clock, timeoutMs } = input;
  const name = tool.descriptor.name;
  const { key, intentHash } = effectKey(runId, step, name, args);
  const now = clock.now().toISOString();

  if (actionRequiresApproval(tool, input.approvalMarks)) {
    const grant = input.approvalId === null ? undefined : input.grants.get(input.approvalId);
    const block = grantBlock(grant, key, name, runId, now);
    if (block) return { kind: "blocked", reason: block, key };
  }

  if (tool.descriptor.sideEffect === "read_only") {
    const outcome = await runTool(tool, args, input.ctx, timeoutMs);
    return { kind: "executed", output: outcome.output, key: null, infraFailure: outcome.infraFailure };
  }

  const { inserted, record } = ledger.intend({
    key,
    runId,
    step,
    intentHash,
    tool: name,
    argsSummary: JSON.stringify(args).slice(0, 200),
    recordedAt: now,
  });
  if (!inserted) return { kind: "replayed", key, state: record.state, output: record.output };

  const outcome = await runTool(tool, args, input.ctx, timeoutMs);
  const failed = outcome.infraFailure !== null || !outcome.output.ok;
  ledger.settle(key, {
    state: failed ? "failed" : "committed",
    at: clock.now().toISOString(),
    output: outcome.output,
    failure: failed ? outcome.output.summary : null,
  });
  return { kind: "executed", output: outcome.output, key, infraFailure: outcome.infraFailure };
}
