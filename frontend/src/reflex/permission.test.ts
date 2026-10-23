import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createStubTools, defineTool } from "./adapters";
import type { Policy, Task } from "./contracts";
import { FIXTURE_POLICY, FIXTURE_TASK, fixtureRegistry } from "./fixture";
import { ToolRegistry, authorizeToolCall, normalizePath } from "./permission";

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

  it("denies a registered tool the task did not authorize", () => {
    const task = { ...FIXTURE_TASK, authorizedTools: ["read_file", "finish"] };
    expect(reasonOf(authorizeToolCall(call("write_file", { path: "src/add.ts", content: "x" }), ctx(task)))).toBe(
      "tool_not_authorized_for_task",
    );
  });

  it("denies a tool the policy does not allow, even if the task lists it", () => {
    const policy = { ...FIXTURE_POLICY, toolAllowlist: ["read_file", "finish"] };
    expect(reasonOf(authorizeToolCall(call("write_file", { path: "src/add.ts", content: "x" }), ctx(FIXTURE_TASK, policy)))).toBe(
      "tool_not_in_policy",
    );
  });

  it("denies writes in investigation mode", () => {
    const task: Task = { ...FIXTURE_TASK, mode: "investigate", doneWhen: [] };
    expect(reasonOf(authorizeToolCall(call("write_file", { path: "src/add.ts", content: "x" }), ctx(task)))).toBe(
      "write_in_investigation_mode",
    );
  });

  it("denies external writes in P0 even when task and policy both list the tool", () => {
    const postComment = defineTool({
      name: "post_comment",
      description: "post a comment",
      inputSchema: z.strictObject({ body: z.string() }),
      sideEffect: "external_write",
      idempotent: false,
      run: () => ({ ok: true, summary: "posted", observation: "posted" }),
    });
    const registry = new ToolRegistry("test", [...createStubTools(), postComment]);
    const task = { ...FIXTURE_TASK, authorizedTools: [...FIXTURE_TASK.authorizedTools, "post_comment"] };
    const policy = { ...FIXTURE_POLICY, toolAllowlist: [...FIXTURE_POLICY.toolAllowlist, "post_comment"] };
    expect(reasonOf(authorizeToolCall(call("post_comment", { body: "hi" }), ctx(task, policy, registry)))).toBe(
      "external_write_not_permitted",
    );
  });

  it("denies malformed or unexpected arguments", () => {
    expect(reasonOf(authorizeToolCall(call("read_file", { path: 5 }), ctx()))).toBe("invalid_arguments");
    expect(reasonOf(authorizeToolCall(call("read_file", { path: "src/add.ts", sudo: true }), ctx()))).toBe("invalid_arguments");
  });

  it.each(["../secrets.txt", "/etc/passwd", "src/../tests/add.test.ts", "docs/readme.md", "src\\add.ts", "."])(
    "denies path %j outside the task scope",
    (path) => {
      expect(reasonOf(authorizeToolCall(call("read_file", { path }), ctx()))).toBe("path_outside_scope");
    },
  );

  it.each(["tests/add.test.ts", "tests/./add.test.ts", "tests//add.test.ts"])("denies writing protected path %j", (path) => {
    expect(reasonOf(authorizeToolCall(call("write_file", { path, content: "x" }), ctx()))).toBe("protected_path");
  });

  it("still allows reading a protected path", () => {
    expect(authorizeToolCall(call("read_file", { path: "tests/add.test.ts" }), ctx()).allowed).toBe(true);
  });
});

describe("normalizePath", () => {
  it("canonicalizes safe paths and rejects unsafe ones", () => {
    expect(normalizePath("./src//a.ts")).toBe("src/a.ts");
    expect(normalizePath("")).toBe(".");
    expect(normalizePath("a/../b")).toBeNull();
    expect(normalizePath("/abs")).toBeNull();
    expect(normalizePath("a\0b")).toBeNull();
  });
});
