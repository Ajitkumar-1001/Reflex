import { createHash } from "node:crypto";
import { z } from "zod";
import type { SideEffectClass } from "./contracts";
import { normalizePath } from "./permission";
import type {
  Clock,
  IdGenerator,
  ModelAdapter,
  ModelResponse,
  ModelUsage,
  ToolAdapter,
  ToolContext,
  ToolOutput,
  Workspace,
} from "./ports";

/* Deterministic stand-ins for the model, the tools and the sandbox. No I/O, no randomness. */

// ---------------------------------------------------------------- determinism

/** Advances a fixed step per read, so repeated runs produce identical timestamps. */
export class SteppingClock implements Clock {
  private tick = 0;

  constructor(
    private readonly startMs: number,
    private readonly stepMs: number,
  ) {}

  now(): Date {
    return new Date(this.startMs + this.stepMs * this.tick++);
  }
}

export class SequentialIds implements IdGenerator {
  private readonly counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${n}`;
  }
}

// ------------------------------------------------------------------ workspace

export class InMemoryWorkspace implements Workspace {
  private readonly files = new Map<string, string>();

  constructor(
    readonly ref: string,
    initial: Readonly<Record<string, string>>,
  ) {
    for (const [path, content] of Object.entries(initial)) this.write(path, content);
  }

  list(prefix: string): string[] {
    const root = normalizePath(prefix);
    if (root === null) return [];
    return [...this.files.keys()].filter((p) => root === "." || p === root || p.startsWith(`${root}/`)).sort();
  }

  read(path: string): string | undefined {
    const key = normalizePath(path);
    return key === null ? undefined : this.files.get(key);
  }

  write(path: string, content: string): void {
    const key = normalizePath(path);
    if (key === null || key === ".") throw new Error(`invalid workspace path ${JSON.stringify(path)}`);
    this.files.set(key, content);
  }

  hash(): string {
    const entries = [...this.files.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  }
}

// ---------------------------------------------------------------------- tools

interface ToolDefinition<S extends z.ZodType> {
  name: string;
  description: string;
  inputSchema: S;
  sideEffect: SideEffectClass;
  idempotent: boolean;
  endsExecution?: boolean;
  touchedPaths?: (args: z.output<S>) => string[];
  run: (args: z.output<S>, ctx: ToolContext) => ToolOutput;
}

/** Builds a ToolAdapter whose arguments are always re-validated, even if the caller already parsed them. */
export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): ToolAdapter {
  return {
    descriptor: {
      name: def.name,
      version: "1",
      description: def.description,
      inputSchema: def.inputSchema,
      sideEffect: def.sideEffect,
      requiredPermissions: [def.sideEffect],
      timeoutMs: 1000,
      idempotent: def.idempotent,
      endsExecution: def.endsExecution ?? false,
      touchedPaths: (args) => (def.touchedPaths ? def.touchedPaths(def.inputSchema.parse(args)) : []),
    },
    execute: async (args, ctx) => def.run(def.inputSchema.parse(args), ctx),
  };
}

const PathArgs = z.strictObject({ path: z.string().min(1) });

/** The P0 stub tool set: workspace tools over an in-memory map. No external writes exist. */
export function createStubTools(): ToolAdapter[] {
  return [
    defineTool({
      name: "list_files",
      description: "List files under a workspace path",
      inputSchema: PathArgs,
      sideEffect: "read_only",
      idempotent: true,
      touchedPaths: (a) => [a.path],
      run: (a, { workspace }) => {
        const files = workspace.list(a.path);
        return { ok: true, summary: `listed ${files.length} files`, observation: files.join("\n") };
      },
    }),
    defineTool({
      name: "read_file",
      description: "Read a workspace file",
      inputSchema: PathArgs,
      sideEffect: "read_only",
      idempotent: true,
      touchedPaths: (a) => [a.path],
      run: (a, { workspace }) => {
        const content = workspace.read(a.path);
        if (content === undefined) return { ok: false, summary: "file not found", observation: `no such file: ${a.path}` };
        return { ok: true, summary: `read ${content.length} chars`, observation: content };
      },
    }),
    defineTool({
      name: "write_file",
      description: "Replace a workspace file's content",
      inputSchema: z.strictObject({ path: z.string().min(1), content: z.string().max(256 * 1024) }),
      sideEffect: "workspace_write",
      idempotent: true,
      touchedPaths: (a) => [a.path],
      run: (a, { workspace }) => {
        workspace.write(a.path, a.content);
        return { ok: true, summary: `wrote ${a.content.length} chars`, observation: `wrote ${a.path}` };
      },
    }),
    defineTool({
      name: "run_check",
      description: "Run one of the task's checks; advisory only, the evaluator decides the outcome",
      inputSchema: z.strictObject({ checkId: z.string().min(1) }),
      sideEffect: "read_only",
      idempotent: true,
      run: (a, { workspace, checks }) => {
        const check = checks[a.checkId];
        if (!check) return { ok: false, summary: "unknown check", observation: `no such check: ${a.checkId}` };
        const passed = check(workspace);
        return { ok: true, summary: `check ${a.checkId} ${passed ? "passed" : "failed"}`, observation: passed ? "passed" : "failed" };
      },
    }),
    defineTool({
      name: "finish",
      description: "End execution; the claimed outcome is never trusted",
      inputSchema: z.strictObject({ summary: z.string(), claimedOutcome: z.enum(["done", "cannot_complete"]) }),
      sideEffect: "read_only",
      idempotent: true,
      endsExecution: true,
      run: (a) => ({ ok: true, summary: `claimed ${a.claimedOutcome}`, observation: "finish recorded" }),
    }),
  ];
}

// ---------------------------------------------------------------------- model

const STUB_USAGE: ModelUsage = { inputTokens: 100, outputTokens: 20, usd: 0.001 };

export interface ModelScript {
  /** Returned for every plan request. Deliberately `unknown` so tests can feed malformed output. */
  plan: unknown;
  /** One entry per execution step, consumed in order. */
  steps: readonly unknown[];
}

/** Replays a fixed script. Emits typed outputs only, never prose. When the script ends it claims it cannot complete. */
export class ScriptedModel implements ModelAdapter {
  readonly config = { provider: "stub", model: "scripted", version: "1" };
  private index = 0;

  constructor(
    private readonly script: ModelScript,
    private readonly usage: ModelUsage = STUB_USAGE,
  ) {}

  async plan(): Promise<ModelResponse> {
    return { output: this.script.plan, usage: this.usage };
  }

  async nextStep(): Promise<ModelResponse> {
    const output = this.script.steps[this.index++] ?? {
      tool: "finish",
      args: { summary: "script exhausted", claimedOutcome: "cannot_complete" },
    };
    return { output, usage: this.usage };
  }
}
