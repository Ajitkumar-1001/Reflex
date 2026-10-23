import { z } from "zod";
import { ReflexError, authorize } from "./access";
import type { Principal } from "./access";
import type { Clock, IdGenerator } from "./ports";

/*
 * Approval workflow for a tool call that must not run until an authorized principal says so.
 * A request records who asked, what would run, and the scope it would touch. It starts pending
 * and closes exactly once: approved, denied, or expired. Deny and expiry fail closed — the
 * status is never approved, and the reason is kept on the request. The in-memory store is the
 * stand-in behind `ApprovalStore`; nothing here reaches a database.
 */

const Timestamp = z.iso.datetime();

export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ApprovalScopeSchema = z.strictObject({
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  repo: z.string().min(1),
  commit: z.string().min(1),
  paths: z.array(z.string().min(1)).optional(),
});
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

export const ApprovalRequestSchema = z
  .strictObject({
    id: z.string().min(1),
    runId: z.string().min(1),
    taskId: z.string().min(1),
    step: z.int().positive(),
    tool: z.string().min(1),
    argsSummary: z.string(),
    idempotencyKey: z.string().min(1),
    scope: ApprovalScopeSchema,
    requestedBy: z.string().min(1),
    requestedAt: Timestamp,
    expiresAt: Timestamp,
    status: ApprovalStatus,
    decidedBy: z.string().min(1).nullable(),
    decidedAt: Timestamp.nullable(),
    reason: z.string().min(1).nullable(),
  })
  .superRefine((request, ctx) => {
    const open = request.status === "pending";
    if (open && (request.decidedBy !== null || request.decidedAt !== null || request.reason !== null)) {
      ctx.addIssue({ code: "custom", message: "a pending approval has no decision" });
    }
    if (!open && (request.decidedBy === null || request.decidedAt === null || request.reason === null)) {
      ctx.addIssue({ code: "custom", message: "a closed approval records who decided and why" });
    }
  });
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export interface ApprovalSubject {
  runId: string;
  taskId: string;
  step: number;
  tool: string;
  argsSummary: string;
  idempotencyKey: string;
  scope: ApprovalScope;
  requestedBy: string;
}

export interface ApprovalDecision {
  status: "approved" | "denied";
  decidedBy: string;
  decidedAt: string;
  reason: string;
}

export interface ApprovalStore {
  create(request: ApprovalRequest): ApprovalRequest;
  get(id: string): ApprovalRequest | undefined;
  list(): ApprovalRequest[];
  /** Pending → approved or denied. A request that is no longer pending is returned unchanged. */
  decide(id: string, decision: ApprovalDecision): ApprovalRequest | undefined;
  /** Pending requests with `expiresAt <= nowIso` become expired. The reason is recorded. */
  expireDue(nowIso: string): ApprovalRequest[];
}

const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, ApprovalRequest>();

  create(request: ApprovalRequest): ApprovalRequest {
    const valid = ApprovalRequestSchema.parse(request);
    if (this.records.has(valid.id)) throw new Error(`duplicate approval ${valid.id}`);
    this.records.set(valid.id, valid);
    return copy(valid);
  }

  get(id: string): ApprovalRequest | undefined {
    const found = this.records.get(id);
    return found && copy(found);
  }

  list(): ApprovalRequest[] {
    return [...this.records.values()].map(copy);
  }

  decide(id: string, decision: ApprovalDecision): ApprovalRequest | undefined {
    const current = this.records.get(id);
    if (!current) return undefined;
    if (current.status !== "pending") return copy(current);
    const next = ApprovalRequestSchema.parse({ ...current, ...decision });
    this.records.set(id, next);
    return copy(next);
  }

  expireDue(nowIso: string): ApprovalRequest[] {
    const expired: ApprovalRequest[] = [];
    for (const current of this.records.values()) {
      if (current.status !== "pending" || current.expiresAt > nowIso) continue;
      const next = ApprovalRequestSchema.parse({
        ...current,
        status: "expired",
        decidedBy: "system",
        decidedAt: nowIso,
        reason: "approval expired",
      });
      this.records.set(current.id, next);
      expired.push(copy(next));
    }
    return expired;
  }
}

/** The run was cancelled while it was waiting. The mutation has not run. */
export class ApprovalAborted extends Error {
  constructor() {
    super("approval wait aborted");
    this.name = "ApprovalAborted";
  }
}

export interface ApprovalServiceOptions {
  /** How long a request stays open. Past this, closing it approves nothing. */
  ttlMs?: number;
  onRequest?: (request: ApprovalRequest) => void;
}

const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

type Waiter = (record: ApprovalRequest) => void;

/**
 * Creates requests and applies decisions. `approve` and `deny` go through the role matrix
 * (`approve` is owner-only). An unauthorized caller leaves the request pending.
 */
export class ApprovalService {
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly ttlMs: number;
  private readonly onRequest: ((request: ApprovalRequest) => void) | undefined;

  constructor(
    readonly store: ApprovalStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    options: ApprovalServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.onRequest = options.onRequest;
  }

  request(subject: ApprovalSubject): ApprovalRequest {
    const requestedAt = this.clock.now();
    const stored = this.store.create({
      id: this.ids.next("apr"),
      ...subject,
      requestedAt: requestedAt.toISOString(),
      expiresAt: new Date(requestedAt.getTime() + this.ttlMs).toISOString(),
      status: "pending",
      decidedBy: null,
      decidedAt: null,
      reason: null,
    });
    this.onRequest?.(stored);
    return stored;
  }

  get(id: string): ApprovalRequest | undefined {
    return this.store.get(id);
  }

  list(): ApprovalRequest[] {
    return this.store.list();
  }

  approve(principal: Principal, id: string, reason = "approved"): ApprovalRequest {
    if (reason.trim() === "") throw new ReflexError("validation_error", "an approval needs a reason");
    return this.decide(principal, id, "approved", reason);
  }

  deny(principal: Principal, id: string, reason: string): ApprovalRequest {
    if (reason.trim() === "") throw new ReflexError("validation_error", "a denial needs a reason");
    return this.decide(principal, id, "denied", reason);
  }

  /** Fail closed: every pending request whose deadline has passed is expired, and waiters are released. */
  expireDue(): ApprovalRequest[] {
    const expired = this.store.expireDue(this.clock.now().toISOString());
    for (const record of expired) this.wake(record);
    return expired;
  }

  /**
   * Closes a still-pending request without approving it. Used when the run is cancelled while
   * it is waiting, so a later decision cannot authorize a mutation the run already abandoned.
   */
  failClosed(id: string, reason: string): ApprovalRequest | undefined {
    const current = this.store.get(id);
    if (!current || current.status !== "pending") return current;
    const updated = this.store.decide(id, {
      status: "denied",
      decidedBy: "system",
      decidedAt: this.clock.now().toISOString(),
      reason,
    });
    if (updated && updated.status !== "pending") this.wake(updated);
    return updated;
  }

  /** Resolves when the request is no longer pending. Rejects if `signal` aborts first. */
  wait(id: string, signal?: AbortSignal): Promise<ApprovalRequest> {
    const current = this.store.get(id);
    if (!current) return Promise.reject(new ReflexError("not_found", "not found"));
    if (current.status !== "pending") return Promise.resolve(current);
    if (signal?.aborted) return Promise.reject(new ApprovalAborted());

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        settle();
      };
      const onAbort = () => finish(() => reject(new ApprovalAborted()));
      signal?.addEventListener("abort", onAbort);
      const bucket = this.waiters.get(id) ?? [];
      bucket.push((record) => finish(() => resolve(record)));
      this.waiters.set(id, bucket);
    });
  }

  private decide(principal: Principal, id: string, status: "approved" | "denied", reason: string): ApprovalRequest {
    const current = this.store.get(id);
    if (!current) throw new ReflexError("not_found", "not found");
    authorize(principal, "approve", { tenantId: current.scope.tenantId, projectId: current.scope.projectId });

    const now = this.clock.now().toISOString();
    if (current.status === "pending" && current.expiresAt <= now) {
      for (const record of this.store.expireDue(now)) this.wake(record);
      throw new ReflexError("invalid_transition", "approval expired");
    }
    if (current.status !== "pending") throw new ReflexError("invalid_transition", `approval is ${current.status}`);

    const updated = this.store.decide(id, { status, decidedBy: principal.id, decidedAt: now, reason });
    if (!updated || updated.status !== status) throw new ReflexError("invalid_transition", "approval could not be decided");
    this.wake(updated);
    return updated;
  }

  private wake(record: ApprovalRequest): void {
    const bucket = this.waiters.get(record.id);
    if (!bucket) return;
    this.waiters.delete(record.id);
    for (const resolve of bucket) resolve(record);
  }
}
