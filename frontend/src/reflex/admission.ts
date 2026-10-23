import { CreateTaskSchema, PolicySchema, TaskSchema } from "./contracts";
import type { Policy, Task, TaskSource } from "./contracts";
import type { ToolRegistry } from "./permission";
import type { AdmissionIssue } from "./ports";

/* FR-01: typed admission. Anything unknown, unregistered or over-privileged is rejected (INV-08). */

const RISK_RANK = { low: 0, medium: 1, high: 2 } as const;

/** Identity is derived server-side and may never arrive in a request body (PRD §15.1). */
const FORBIDDEN_FIELDS = ["tenantId", "tenant_id", "userId", "user_id", "role"] as const;

const issue = (code: AdmissionIssue["code"], reason: string, message: string): AdmissionIssue => ({ code, reason, message });

function schemaIssues(error: { issues: readonly { path: PropertyKey[]; message: string }[] }, reason: string): AdmissionIssue[] {
  return error.issues.map((i) => issue("validation_error", reason, `${i.path.map(String).join(".") || reason}: ${i.message}`));
}

export interface ServerTaskFields {
  id: string;
  tenantId: string;
  requestedBy: string;
  createdAt: string;
  source: TaskSource;
  split?: Task["split"];
}

export type TaskCreation = { ok: true; task: Task } | { ok: false; issues: AdmissionIssue[] };

/** Validates a `POST /v1/tasks` body, then adds the server-derived fields. */
export function createTask(input: unknown, server: ServerTaskFields): TaskCreation {
  if (typeof input === "object" && input !== null) {
    const forbidden = FORBIDDEN_FIELDS.filter((field) => field in input);
    if (forbidden.length > 0) {
      return { ok: false, issues: forbidden.map((f) => issue("forbidden_field", f, `${f} is derived server-side and cannot be supplied`)) };
    }
  }
  const body = CreateTaskSchema.safeParse(input);
  if (!body.success) return { ok: false, issues: schemaIssues(body.error, "invalid_task") };
  const task = TaskSchema.safeParse({ ...body.data, ...server });
  return task.success ? { ok: true, task: task.data } : { ok: false, issues: schemaIssues(task.error, "invalid_task") };
}

export type Admission = { ok: true; task: Task; policy: Policy } | { ok: false; issues: AdmissionIssue[] };

/**
 * Admits a stored task against its pinned policy and the tool registry.
 * `externalWrites: "defer"` is the Phase 2 approval path: an allowlisted external write is admitted,
 * and the tool runner still refuses it without a grant. The default keeps the P0 rejection.
 */
export function admitTask(
  taskInput: unknown,
  policyInput: unknown,
  registry: ToolRegistry,
  options?: { externalWrites?: "deny" | "defer" },
): Admission {
  const task = TaskSchema.safeParse(taskInput);
  const policy = PolicySchema.safeParse(policyInput);
  const issues: AdmissionIssue[] = [];
  if (!task.success) issues.push(...schemaIssues(task.error, "invalid_task"));
  if (!policy.success) issues.push(...schemaIssues(policy.error, "invalid_policy"));
  if (!task.success || !policy.success) return { ok: false, issues };

  const t = task.data;
  const p = policy.data;
  const violation = (reason: string, message: string) => issues.push(issue("policy_violation", reason, message));
  if (t.policyId !== p.id || t.policyVersion !== p.version) {
    violation("policy_mismatch", `task pins ${t.policyId}@${t.policyVersion}, got ${p.id}@${p.version}`);
  }
  if (p.status !== "ACTIVE") violation("policy_not_active", `policy status is ${p.status}`);
  if (RISK_RANK[t.riskClass] > RISK_RANK[p.riskClass]) {
    violation("risk_exceeds_policy", `task risk ${t.riskClass} exceeds policy risk ${p.riskClass}`);
  }
  for (const name of p.toolAllowlist) {
    const tool = registry.get(name);
    if (!tool) violation("unregistered_tool", `policy allows ${name}, which is not registered`);
    else if (tool.descriptor.sideEffect === "external_write" && options?.externalWrites !== "defer") {
      violation("external_write_not_permitted", `policy allows ${name}; P0 has no approval path for external writes`);
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, task: t, policy: p };
}
