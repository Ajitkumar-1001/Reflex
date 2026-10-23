/*
 * Typed client for the approvals queue. Workstream B is adding the side-effect ledger in parallel, so the
 * dashboard depends only on this interface. `createMockApprovalsClient` is the stand-in: same inputs and
 * errors the real client will have, with no network and no Reflex domain imports.
 */

export const APPROVAL_STATUSES = ["pending", "approved", "denied"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_EFFECTS = ["external_write", "workspace_write", "network"] as const;
export type ApprovalEffect = (typeof APPROVAL_EFFECTS)[number];

export type ApprovalDecision = "approve" | "deny";

export interface ApprovalRecord {
  id: string;
  effect: ApprovalEffect;
  tool: string;
  summary: string;
  runId: string;
  taskId: string;
  requestedAt: string;
  status: ApprovalStatus;
  decidedAt: string | null;
  decidedBy: string | null;
  reason: string | null;
}

export interface ApprovalListQuery {
  status?: ApprovalStatus;
}

export interface ApprovalDecisionInput {
  actor: string;
  reason: string;
}

export interface ApprovalsClient {
  list(query?: ApprovalListQuery): Promise<ApprovalRecord[]>;
  decide(id: string, decision: ApprovalDecision, input: ApprovalDecisionInput): Promise<ApprovalRecord>;
}

export class ApprovalClientError extends Error {
  readonly name = "ApprovalClientError";

  constructor(
    readonly code: "not_found" | "already_decided" | "validation_error",
    message: string,
  ) {
    super(message);
  }
}

/** Notice codes the approvals page may render after a decision. Anything else is ignored. */
export function approvalNotice(notice: string | string[] | undefined, id: string | string[] | undefined): string | null {
  if (Array.isArray(notice) || Array.isArray(id)) return null;
  if ((notice !== "approved" && notice !== "denied") || id === undefined || !/^apr-[a-z0-9-]+$/.test(id)) return null;
  return notice === "approved" ? `${id} was approved.` : `${id} was denied.`;
}

export function isApprovalStatus(value: string): value is ApprovalStatus {
  return (APPROVAL_STATUSES as readonly string[]).includes(value);
}

/** Query-string parser for the approvals page. Repeated params are an error, not a silent first-value pick. */
export function parseApprovalStatus(
  value: string | string[] | undefined,
): { ok: true; status?: ApprovalStatus } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (Array.isArray(value)) return { ok: false, message: "status must be a single value." };
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "all") return { ok: true };
  if (!isApprovalStatus(trimmed)) {
    return { ok: false, message: "Status must be pending, approved, or denied." };
  }
  return { ok: true, status: trimmed };
}

/**
 * Demo ledger rows. Run and task ids match the first three runs the dashboard catalog records
 * (`run-1` train add, `run-2` train sub, `run-3` memory-on mul). Reordering that seed breaks the links.
 */
export const MOCK_APPROVAL_SEED: readonly ApprovalRecord[] = [
  {
    id: "apr-push-add",
    effect: "external_write",
    tool: "git_push",
    summary: "Push the add() fix to the fixture remote.",
    runId: "run-1",
    taskId: "task-add-train",
    requestedAt: "2026-01-01T00:10:00.000Z",
    status: "pending",
    decidedAt: null,
    decidedBy: null,
    reason: null,
  },
  {
    id: "apr-webhook-sub",
    effect: "network",
    tool: "webhook",
    summary: "POST the sub() evaluation verdict to the CI callback.",
    runId: "run-2",
    taskId: "task-sub-train",
    requestedAt: "2026-01-01T00:20:00.000Z",
    status: "pending",
    decidedAt: null,
    decidedBy: null,
    reason: null,
  },
  {
    id: "apr-push-mul",
    effect: "external_write",
    tool: "git_push",
    summary: "Push the mul() fix to the demo remote.",
    runId: "run-3",
    taskId: "task-mul-demo",
    requestedAt: "2026-01-01T00:05:00.000Z",
    status: "approved",
    decidedAt: "2026-01-01T00:06:00.000Z",
    decidedBy: "ajit",
    reason: "Reviewed the diff. The remote is the fixture origin.",
  },
  {
    id: "apr-summarizer",
    effect: "network",
    tool: "http_request",
    summary: "Send repository contents to an external summarizer.",
    runId: "run-1",
    taskId: "task-add-train",
    requestedAt: "2026-01-01T00:04:00.000Z",
    status: "denied",
    decidedAt: "2026-01-01T00:04:30.000Z",
    decidedBy: "ajit",
    reason: "An external model would take the workspace contents off the machine.",
  },
];

const copy = <T>(value: T): T => structuredClone(value);

export function createMockApprovalsClient(options?: {
  seed?: readonly ApprovalRecord[];
  now?: () => string;
}): ApprovalsClient {
  const now = options?.now ?? (() => new Date().toISOString());
  const records = new Map<string, ApprovalRecord>();
  for (const item of options?.seed ?? MOCK_APPROVAL_SEED) {
    if (records.has(item.id)) throw new ApprovalClientError("validation_error", `duplicate approval id ${item.id}`);
    records.set(item.id, copy(item));
  }

  return {
    async list(query) {
      if (query?.status !== undefined && !isApprovalStatus(query.status)) {
        throw new ApprovalClientError("validation_error", "Status must be pending, approved, or denied.");
      }
      return [...records.values()]
        .filter((record) => query?.status === undefined || record.status === query.status)
        .sort((a, b) => (a.requestedAt === b.requestedAt ? (a.id < b.id ? -1 : 1) : a.requestedAt < b.requestedAt ? 1 : -1))
        .map(copy);
    },

    async decide(id, decision, input) {
      const actor = input.actor.trim();
      const reason = input.reason.trim();
      if (actor.length === 0) throw new ApprovalClientError("validation_error", "A decision needs an actor.");
      if (reason.length === 0) throw new ApprovalClientError("validation_error", "A decision needs a reason.");
      const current = records.get(id);
      if (!current) throw new ApprovalClientError("not_found", `No approval ${id}.`);
      if (current.status !== "pending") {
        throw new ApprovalClientError("already_decided", `${id} is already ${current.status}.`);
      }
      const next: ApprovalRecord = {
        ...current,
        status: decision === "approve" ? "approved" : "denied",
        decidedAt: now(),
        decidedBy: actor,
        reason,
      };
      records.set(id, next);
      return copy(next);
    },
  };
}

let singleton: ApprovalsClient | null = null;

/** One ledger per server process. The page and the approve/deny action share it. */
export function getApprovalsClient(): ApprovalsClient {
  singleton ??= createMockApprovalsClient();
  return singleton;
}
