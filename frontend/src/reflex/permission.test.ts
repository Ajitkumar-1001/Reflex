import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createStubTools, defineTool } from "./adapters";
import type { Policy, Task } from "./contracts";
import { FIXTURE_POLICY, FIXTURE_TASK, fixtureRegistry, investigationTask } from "./fixture";
import { ToolRegistry, authorizeToolCall } from "./permission";

const call = (tool: string, args: Record<string, unknown>) => ({ tool, args });
const ctx = (task: Task = FIXTURE_TASK, policy: Policy = FIXTURE_POLICY, registry: ToolRegistry = fixtureRegistry()) => ({
  task,
  policy,
  registry,
});

function reasonOf(decision: ReturnType<typeof authorizeToolCall>): string {
  return decision.allowed ? "allowed" : decision.reasonCode;
}

describe("authorizeToolCall (FR-06, INV-02, INV-08)", () => {
  it("allows a registered, authorized, in-scope call", () => {
    expect(authorizeToolCall(call("read_file", { path: "src/add.ts" }), ctx()).allowed).toBe(true);
  });

  it("denies a tool that is not registered", () => {
    expect(reasonOf(authorizeToolCall(call("git_push", {}), ctx()))).toBe("unregistered_tool");
  });

  it("denies a tool the policy does not allow, even if the task lists it", () => {
    const policy = { ...FIXTURE_POLICY, toolAllowlist: ["read_file", "finish"] };
    expect(reasonOf(authorizeToolCall(call("write_file", { path: "src/add.ts", content: "x" }), ctx(FIXTURE_TASK, policy)))).toBe(
      "tool_not_in_policy",
    );
  });

  it("denies writes in investigation mode", () => {
    expect(reasonOf(authorizeToolCall(call("write_file", { path: "src/add.ts", content: "x" }), ctx(investigationTask())))).toBe(
      "write_in_investigation_mode",
    );
  });

  it("denies external writes in P0 whether or not the policy lists the tool", () => {
    const postComment = defineTool({
      name: "post_comment",
      description: "post a comment",
      inputSchema: z.strictObject({ body: z.string() }),
      sideEffect: "external_write",
      idempotent: false,
      run: () => ({ ok: true, summary: "posted", observation: "posted" }),
    });
    const registry = new ToolRegistry("test", [...createStubTools(), postComment]);
    const policy = { ...FIXTURE_POLICY, toolAllowlist: [...FIXTURE_POLICY.toolAllowlist, "post_comment"] };
    expect(reasonOf(authorizeToolCall(call("post_comment", { body: "hi" }), ctx(FIXTURE_TASK, policy, registry)))).toBe(
      "external_write_not_permitted",
    );
    expect(reasonOf(authorizeToolCall(call("post_comment", { body: "hi" }), ctx(FIXTURE_TASK, FIXTURE_POLICY, registry)))).toBe(
      "external_write_not_permitted",
    );
  });

  it("denies malformed or unexpected arguments", () => {
    expect(reasonOf(authorizeToolCall(call("read_file", { path: 5 }), ctx()))).toBe("invalid_arguments");
    expect(reasonOf(authorizeToolCall(call("read_file", { path: "src/add.ts", sudo: true }), ctx()))).toBe("invalid_arguments");
  });

  it.each(["../secrets.txt", "/etc/passwd", "src/../tests/add.test.ts", "src\\add.ts"])(
    "denies path %j outside the worktree, whatever the scope",
    (path) => {
      expect(reasonOf(authorizeToolCall(call("read_file", { path }), ctx()))).toBe("path_outside_scope");
    },
  );

  it.each(["docs/readme.md", "."])("confines the agent to scope.paths when set: %j is outside", (path) => {
    const task = { ...FIXTURE_TASK, scope: { ...FIXTURE_TASK.scope, paths: ["src", "tests"] } };
    expect(reasonOf(authorizeToolCall(call("read_file", { path }), ctx(task)))).toBe("path_outside_scope");
    expect(reasonOf(authorizeToolCall(call("read_file", { path: "src/add.ts" }), ctx(task)))).toBe("allowed");
  });

  it("puts the whole worktree in scope when scope.paths is absent", () => {
    expect(reasonOf(authorizeToolCall(call("read_file", { path: "docs/readme.md" }), ctx()))).toBe("allowed");
    expect(reasonOf(authorizeToolCall(call("list_files", { path: "." }), ctx()))).toBe("allowed");
  });

  it.each([
    "tests/add.test.ts",
    "tests/./add.test.ts",
    "tests//add.test.ts",
    "src/add.test.ts",
    ".github/workflows/ci.yml",
    "tsconfig.json",
    "eslint.config.mjs",
    "pnpm-lock.yaml",
  ])("denies writing default-protected path %j", (path) => {
    expect(reasonOf(authorizeToolCall(call("write_file", { path, content: "x" }), ctx()))).toBe("protected_path");
  });

  it("denies writing a task-listed protected path and allows a lockfile the task names", () => {
    const listed = { ...FIXTURE_TASK, scope: { ...FIXTURE_TASK.scope, protectedPaths: ["src/generated"] } };
    expect(reasonOf(authorizeToolCall(call("write_file", { path: "src/generated/api.ts", content: "x" }), ctx(listed)))).toBe(
      "protected_path",
    );
    const named = { ...FIXTURE_TASK, scope: { ...FIXTURE_TASK.scope, paths: ["src", "pnpm-lock.yaml"] } };
    expect(reasonOf(authorizeToolCall(call("write_file", { path: "pnpm-lock.yaml", content: "x" }), ctx(named)))).toBe("allowed");
  });

  it("still allows reading a protected path", () => {
    expect(authorizeToolCall(call("read_file", { path: "tests/add.test.ts" }), ctx()).allowed).toBe(true);
  });
});

