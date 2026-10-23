/*
 * The approvals page over the real Phase 2 approval service. Every decision goes through
 * `ApprovalService.approve` / `deny`, so the role matrix, the tenant and project scope, the expiry rule and the
 * one-decision-only rule are the service's, not this file's. The store is in memory (DEC-03 is open).
 */

import { ReflexError, canActOn } from "../reflex/access";
import type { Principal } from "../reflex/access";
import { SequentialIds } from "../reflex/adapters";
import { ApprovalService, InMemoryApprovalStore } from "../reflex/approval";
import type { ApprovalRequest } from "../reflex/approval";
import { fixtureRegistry } from "../reflex/fixture";
import { effectKey } from "../reflex/ledger";
import { PRINCIPALS, PROJECT, TENANT } from "../reflex/memory-fixture";
import type { ToolRegistry } from "../reflex/permission";
import { ApprovalClientError, STATUS_MESSAGE, isApprovalStatus, newestFirst } from "./approvals";
import type { ApprovalEffect, ApprovalRecord, ApprovalsClient } from "./approvals";

export interface LedgerApprovalsOptions {
  approvals: ApprovalService;
  /** Where a request's side-effect class comes from: the request records the tool, not its class. */
  registry: ToolRegistry;
  /**
   * Authority for every decision: role, tenant and project. The decision's actor label replaces only its id, so
   * the ledger records who acted while the service still checks what that role may do in that scope.
   */
  operator: Principal;
}

function toRecord(request: ApprovalRequest, effect: ApprovalEffect): ApprovalRecord {
  return {
    id: request.id,
    effect,
    tool: request.tool,
    summary: request.argsSummary,
    runId: request.runId,
    taskId: request.taskId,
    requestedAt: request.requestedAt,
    status: request.status,
    decidedAt: request.decidedAt,
    decidedBy: request.decidedBy,
    reason: request.reason,
  };
}

/** The service's `ReflexError` becomes the client's error. Anything else is a bug and passes through. */
function clientError(id: string, error: unknown): unknown {
  if (!(error instanceof ReflexError)) return error;
  if (error.code === "not_found") return new ApprovalClientError("not_found", `No approval ${id}.`);
  if (error.code === "invalid_transition") return new ApprovalClientError("already_decided", `${id} is no longer pending.`);
  if (error.code === "forbidden" || error.code === "validation_error") return new ApprovalClientError(error.code, error.message);
  return error;
}

export function createLedgerApprovalsClient({ approvals, registry, operator }: LedgerApprovalsOptions): ApprovalsClient {
  // A tool the registry does not know is shown as the strictest class.
  const effectOf = (tool: string): ApprovalEffect => registry.get(tool)?.descriptor.sideEffect ?? "external_write";

  return {
    async list(query) {
      if (query?.status !== undefined && !isApprovalStatus(query.status)) {
        throw new ApprovalClientError("validation_error", STATUS_MESSAGE);
      }
      approvals.expireDue(); // a lapsed deadline reads as expired, never as pending
      return approvals
        .list()
        .filter((request) => canActOn(operator, request.scope) && (query?.status === undefined || request.status === query.status))
        .map((request) => toRecord(request, effectOf(request.tool)))
        .sort(newestFirst);
    },

    async decide(id, decision, input) {
      const actor = input.actor.trim();
      const reason = input.reason.trim();
      if (actor.length === 0) throw new ApprovalClientError("validation_error", "A decision needs an actor.");
      if (reason.length === 0) throw new ApprovalClientError("validation_error", "A decision needs a reason.");
      const principal: Principal = { ...operator, id: actor };
      try {
        const decided = decision === "approve" ? approvals.approve(principal, id, reason) : approvals.deny(principal, id, reason);
        return toRecord(decided, effectOf(decided.tool));
      } catch (error) {
        throw clientError(id, error);
      }
    },
  };
}

/**
 * Demo requests, so the page has rows. No run is waiting on them: approving one records a decision and does
 * nothing else. Run and task ids match the first three runs the dashboard catalog records.
 */
function seedDemoRequests(approvals: ApprovalService, operator: Principal): void {
  const ask = (runId: string, taskId: string, op: "add" | "sub" | "mul", tool: string, args: Record<string, string>) =>
    approvals.request({
      runId,
      taskId,
      step: 2,
      tool,
      argsSummary: JSON.stringify(args),
      idempotencyKey: effectKey(runId, 2, tool, args).key,
      scope: { tenantId: TENANT, projectId: PROJECT, repo: `fixture/arith-${op}`, commit: `arith-${op}-1` },
      requestedBy: "fixture",
    });
  ask("run-1", "task-add-train", "add", "git_push", { remote: "fixture-origin", branch: "main" });
  ask("run-2", "task-sub-train", "sub", "webhook", { url: "https://ci.example.invalid/callback" });
  const pushed = ask("run-3", "task-mul-demo", "mul", "git_push", { remote: "demo-origin", branch: "main" });
  approvals.approve(operator, pushed.id, "Reviewed the diff. The remote is the fixture origin.");
  const sent = ask("run-1", "task-add-train", "add", "http_request", { url: "https://summarizer.example.invalid" });
  approvals.deny(operator, sent.id, "An external model would take the workspace contents off the machine.");
}

let singleton: ApprovalsClient | null = null;

/**
 * One approval store per server process. The page and the approve/deny action share it. The operator is the
 * Phase 1 fixture owner: a stand-in until the §17.0 tokens exist, not an authenticated user.
 */
export function getApprovalsClient(): ApprovalsClient {
  if (singleton === null) {
    const approvals = new ApprovalService(new InMemoryApprovalStore(), { now: () => new Date() }, new SequentialIds());
    seedDemoRequests(approvals, PRINCIPALS.owner);
    singleton = createLedgerApprovalsClient({ approvals, registry: fixtureRegistry(), operator: PRINCIPALS.owner });
  }
  return singleton;
}
