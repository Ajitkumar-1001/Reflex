import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore, InMemoryWorkspace, commandAllowed, createStubTools, diffPaths } from "./adapters";
import type { Policy, Task } from "./contracts";
import { FIXTURE_COMMANDS, FIXTURE_POLICY, FIXTURE_TASK, fixtureRegistry, investigationTask, runFixture } from "./fixture";
import { authorizeToolCall } from "./permission";
import type { CommandTable, ToolContext } from "./ports";

const tools = createStubTools();
const byName = (name: string) => {
  const tool = tools.find((t) => t.descriptor.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};

function ctxOf(files: Record<string, string> = {}, scope: Task["scope"] = FIXTURE_TASK.scope, commands = FIXTURE_COMMANDS): ToolContext {
  return { workspace: new InMemoryWorkspace("ws", files), scope, commands, artifacts: new InMemoryArtifactStore() };
}
const run = (name: string, args: unknown, ctx: ToolContext) => byName(name).execute(args, ctx);
const auth = (tool: string, args: Record<string, unknown>, task: Task = FIXTURE_TASK, policy: Policy = FIXTURE_POLICY) =>
  authorizeToolCall({ tool, args }, { task, policy, registry: fixtureRegistry() });
const reason = (d: ReturnType<typeof auth>) => (d.allowed ? "allowed" : d.reasonCode);

describe("P0 tool registry (PRD §11)", () => {
  it("registers exactly the seven P0 tools, with no external_write class", () => {
    expect(tools.map((t) => [t.descriptor.name, t.descriptor.sideEffect])).toEqual([
      ["list_files", "read_only"],
      ["read_file", "read_only"],
      ["search_code", "read_only"],
      ["write_file", "workspace_write"],
      ["apply_patch", "workspace_write"],
      ["run_command", "workspace_write"],
      ["finish", "read_only"],
    ]);
    expect(tools.every((t) => t.descriptor.sideEffect !== "external_write")).toBe(true);
  });

  it("declares input and output schemas, a timeout and idempotency for every tool (§11 contract)", () => {
    for (const { descriptor } of tools) {
      expect(descriptor.inputSchema).toBeDefined();
      expect(descriptor.outputSchema).toBeDefined();
      expect(descriptor.timeoutMs).toBeGreaterThan(0);
      expect(typeof descriptor.idempotent).toBe("boolean");
    }
    expect(byName("run_command").descriptor.timeoutMs).toBe(600_000);
  });
});

describe("argument schemas and limits", () => {
  it("rejects list_files depth above 4, and unknown arguments", () => {
    expect(reason(auth("list_files", { path: ".", depth: 5 }))).toBe("invalid_arguments");
    expect(reason(auth("list_files", { path: ".", depth: 4 }))).toBe("allowed");
    expect(reason(auth("list_files", { path: ".", recursive: true }))).toBe("invalid_arguments");
  });

  it("caps list_files at depth and 2,000 entries", async () => {
    const files = Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [`src/f${i}.ts`, ""]));
    files["src/a/b/c/d/e/deep.ts"] = "";
    const out = await run("list_files", { path: "src", depth: 1 }, ctxOf(files));
    expect(out.observation.split("\n").filter((l) => l.endsWith(".ts"))).toHaveLength(2000);
    expect(out.observation).toContain("[truncated: 100 more entries]");
    expect(out.observation).not.toContain("deep.ts");
  });

  it("reads a line range and caps a read at 400 lines", async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n");
    const ctx = ctxOf({ "src/big.txt": lines });
    expect((await run("read_file", { path: "src/big.txt", startLine: 2, endLine: 3 }, ctx)).observation).toBe("line 2\nline 3");
    const all = await run("read_file", { path: "src/big.txt" }, ctx);
    expect(all.observation.split("\n")).toHaveLength(401);
    expect(all.observation.endsWith("[truncated]")).toBe(true);
    expect(reason(auth("read_file", { path: "src/a.ts", startLine: 5, endLine: 2 }))).toBe("invalid_arguments");
  });

  it("caps a read at 64 KB", async () => {
    const out = await run("read_file", { path: "src/wide.txt" }, ctxOf({ "src/wide.txt": "x".repeat(200_000) }));
    expect(out.observation.length).toBeLessThanOrEqual(64 * 1024 + "\n[truncated]".length);
  });

  it("searches within a glob and within the task scope, capped at 200 matches", async () => {
    const files = { "src/a.ts": "needle\nhay", "src/b.md": "needle", "docs/c.ts": "needle", ...Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`src/m${i}.ts`, "needle"])) };
    const scoped = { ...FIXTURE_TASK.scope, paths: ["src"] };
    const found = await run("search_code", { pattern: "needle", glob: "src/*.ts" }, ctxOf(files, scoped));
    expect(found.summary).toBe("200 matches");
    expect(found.observation).toContain("[truncated: 101 more matches]");
    expect(found.observation).not.toContain("docs/c.ts");
    expect(found.observation).not.toContain("b.md");
    const one = await run("search_code", { pattern: "hay" }, ctxOf(files, scoped));
    expect(one.observation).toBe("src/a.ts:2:hay");
  });

  it("limits write_file content to 256 KB (bytes, not characters)", () => {
    expect(reason(auth("write_file", { path: "src/a.ts", content: "x".repeat(256 * 1024) }))).toBe("allowed");
    expect(reason(auth("write_file", { path: "src/a.ts", content: "x".repeat(256 * 1024 + 1) }))).toBe("invalid_arguments");
    expect(reason(auth("write_file", { path: "src/a.ts", content: "é".repeat(150_000) }))).toBe("invalid_arguments");
  });
});

describe("apply_patch protected-path rule", () => {
  const patch = (path: string, extra = "") =>
    `${extra}--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

  it("collects every path a diff names, including renames and git headers", () => {
    expect(diffPaths(patch("src/a.ts"))).toEqual(["src/a.ts"]);
    expect(diffPaths("diff --git a/src/a.ts b/tests/a.test.ts\nrename from src/a.ts\nrename to tests/a.test.ts\n")).toEqual([
      "src/a.ts",
      "tests/a.test.ts",
    ]);
    expect(diffPaths("--- /dev/null\n+++ b/src/new.ts\n")).toEqual(["src/new.ts"]);
  });

  it("is allowed for ordinary files", () => {
    expect(reason(auth("apply_patch", { unifiedDiff: patch("src/add.ts") }))).toBe("allowed");
  });

  it.each([
    ["a protected test file", patch("tests/add.test.ts")],
    ["a second hunk file that is protected", `${patch("src/add.ts")}${patch("tsconfig.json")}`],
    ["a rename into a protected path", "diff --git a/src/a.ts b/src/a.ts\nrename from src/a.ts\nrename to tests/a.test.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n"],
  ])("is denied when any hunk touches %s", (_label, unifiedDiff) => {
    expect(reason(auth("apply_patch", { unifiedDiff }))).toBe("protected_path");
  });

  it("is denied for paths that escape the worktree and for diffs that name no file", () => {
    expect(reason(auth("apply_patch", { unifiedDiff: patch("../outside.ts") }))).toBe("path_outside_scope");
    expect(reason(auth("apply_patch", { unifiedDiff: "just text" }))).toBe("invalid_arguments");
  });
});

describe("run_command allowlist and limits", () => {
  it.each([
    [["pnpm", "test"], true],
    [["npm", "run", "build"], true],
    [["node", "script.js"], true],
    [["npx", "tsc", "--noEmit"], true],
    [["git", "status"], true],
    [["git", "diff", "--stat"], true],
    [["npx", "eslint"], false],
    [["git", "push"], false],
    [["git", "commit", "-m", "x"], false],
    [["curl", "https://example.com"], false],
    [["pnpm test"], false],
    [["sh", "-c", "pnpm test"], false],
  ] as const)("matches %j against the default allowlist: %s", (argv, allowed) => {
    expect(commandAllowed(argv, FIXTURE_POLICY.commandAllowlist)).toBe(allowed);
    expect(reason(auth("run_command", { argv: [...argv] }))).toBe(allowed ? "allowed" : "command_not_allowed");
  });

  it("denies everything when the policy's command allowlist is empty", () => {
    expect(reason(auth("run_command", { argv: ["pnpm", "test"] }, FIXTURE_TASK, { ...FIXTURE_POLICY, commandAllowlist: [] }))).toBe(
      "command_not_allowed",
    );
  });

  it("rejects an empty argv, a timeout above 600 s and a missing argv (no shell string)", () => {
    expect(reason(auth("run_command", { argv: [] }))).toBe("invalid_arguments");
    expect(reason(auth("run_command", { argv: ["pnpm", "test"], timeoutSec: 601 }))).toBe("invalid_arguments");
    expect(reason(auth("run_command", { command: "pnpm test" }))).toBe("invalid_arguments");
    expect(reason(auth("run_command", { argv: ["pnpm", "test"], timeoutSec: 600 }))).toBe("allowed");
  });

  it("is not available to an investigation task, because it is a workspace_write tool", () => {
    expect(reason(auth("run_command", { argv: ["git", "status"] }, investigationTask()))).toBe("write_in_investigation_mode");
  });

  it("returns a non-zero exit as an observation with its status", async () => {
    const out = await run("run_command", { argv: ["pnpm", "test"] }, ctxOf({ "src/add.ts": "a - b" }));
    expect([out.ok, out.exitStatus]).toEqual([false, 1]);
    const missing = await run("run_command", { argv: ["pnpm", "build"] }, ctxOf());
    expect([missing.ok, missing.exitStatus]).toEqual([false, 127]);
  });

  it("truncates output to 32 KB and keeps the full output as a hashed artifact", async () => {
    const big = "y".repeat(100_000);
    const ctx = ctxOf({}, FIXTURE_TASK.scope, { "pnpm test": () => ({ exitCode: 0, output: big }) });
    const out = await run("run_command", { argv: ["pnpm", "test"] }, ctx);
    expect(out.observation).toHaveLength(32 * 1024);
    expect(out.artifactRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((ctx.artifacts as InMemoryArtifactStore).get(out.artifactRef ?? "")).toBe(big);
  });
});

describe("run_command through a run", () => {
  const testEvent = async (commands?: CommandTable) => {
    const result = await runFixture({ commands });
    if (!result.admitted) throw new Error("not admitted");
    const event = result.events.find((e) => e.type === "tool_result" && e.redactedPayload.tool === "run_command");
    if (event?.type !== "tool_result") throw new Error("no run_command result");
    return event;
  };

  it("records exit status and an idempotency key, and no artifact for small output", async () => {
    const event = await testEvent();
    expect(event.redactedPayload.exitStatus).toBe(0);
    expect(event.idempotencyKey).toMatch(/^run-1:call-/);
    expect(event.artifactRef).toBeUndefined();
  });

  it("points the event at the artifact when output is truncated", async () => {
    const event = await testEvent({ ...FIXTURE_COMMANDS, "pnpm test": () => ({ exitCode: 0, output: "z".repeat(40_000) }) });
    expect(event.artifactRef).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
