import type { Policy, Task, ToolCallRequest } from "./contracts";
import { isInScope, isProtectedPath, normalizePath } from "./paths";
import type { Denial, ToolAdapter } from "./ports";

/** Registry of tools by name. A tool that is not here does not exist (INV-08). */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolAdapter>();

  constructor(
    readonly version: string,
    tools: readonly ToolAdapter[],
  ) {
    for (const tool of tools) this.tools.set(tool.descriptor.name, tool);
  }

  get(name: string): ToolAdapter | undefined {
    return this.tools.get(name);
  }
}

export interface AccessContext {
  task: Task;
  policy: Policy;
  registry: ToolRegistry;
  /**
   * `deny` (default) refuses every external write: P0 has no approval path. `defer` leaves that check to
   * the tool runner, which still refuses the call unless a grant is on record.
   */
  externalWrite?: "deny" | "defer";
}

/** Argument-independent checks, shared by plan validation and per-call authorization. */
export function checkToolAccess(
  toolName: string,
  { task, policy, registry, externalWrite = "deny" }: AccessContext,
): { tool: ToolAdapter } | { denial: Denial } {
  const tool = registry.get(toolName);
  if (!tool) return { denial: { reasonCode: "unregistered_tool", detail: `no tool named ${toolName}` } };
  const { sideEffect } = tool.descriptor;
  if (sideEffect === "external_write" && externalWrite !== "defer") {
    return { denial: { reasonCode: "external_write_not_permitted", detail: "external writes need approval, which P0 lacks" } };
  }
  if (!policy.toolAllowlist.includes(toolName)) {
    return { denial: { reasonCode: "tool_not_in_policy", detail: `${toolName} is not in the policy allowlist` } };
  }
  if (sideEffect !== "read_only" && task.mode === "investigate") {
    return { denial: { reasonCode: "write_in_investigation_mode", detail: "investigation tasks cannot write" } };
  }
  return { tool };
}

export type AuthorizationDecision =
  | { allowed: true; tool: ToolAdapter; args: unknown }
  | ({ allowed: false } & Denial);

/** Default-deny authorization of one model-requested tool call. */
export function authorizeToolCall(call: ToolCallRequest, ctx: AccessContext): AuthorizationDecision {
  const access = checkToolAccess(call.tool, ctx);
  if ("denial" in access) return { allowed: false, ...access.denial };
  const { tool } = access;

  const parsed = tool.descriptor.inputSchema.safeParse(call.args);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
    return { allowed: false, reasonCode: "invalid_arguments", detail: detail.slice(0, 300) };
  }

  const { scope } = ctx.task;
  const writes = tool.descriptor.sideEffect === "workspace_write";
  for (const raw of tool.descriptor.touchedPaths(parsed.data)) {
    const path = normalizePath(raw);
    if (path === null || !isInScope(path, scope)) {
      return { allowed: false, reasonCode: "path_outside_scope", detail: `path ${JSON.stringify(raw)} is outside the task scope` };
    }
    if (writes && isProtectedPath(path, scope)) {
      return { allowed: false, reasonCode: "protected_path", detail: `path ${path} is protected` };
    }
  }
  const denied = tool.descriptor.denyArgs?.(parsed.data, ctx.policy);
  if (denied) return { allowed: false, ...denied };
  return { allowed: true, tool, args: parsed.data };
}
