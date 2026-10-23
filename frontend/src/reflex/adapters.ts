import { createHash } from "node:crypto";
import { z } from "zod";
import type { Policy, SideEffectClass } from "./contracts";
import { isInScope, normalizePath } from "./paths";
import type {
  ArtifactStore,
  Clock,
  Denial,
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
  constructor(
    private readonly startMs: number,
    private readonly stepMs: number,
    private tick = 0,
  ) {}

  now(): Date {
    return new Date(this.startMs + this.stepMs * this.tick++);
  }

  /** The next tick a resumed clock should use. Does not advance time. */
  snapshot(): { startMs: number; stepMs: number; tick: number } {
    return { startMs: this.startMs, stepMs: this.stepMs, tick: this.tick };
  }
}

export class SequentialIds implements IdGenerator {
  private readonly counters: Map<string, number>;

  constructor(seed: Readonly<Record<string, number>> = {}) {
    this.counters = new Map(Object.entries(seed));
  }

  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${n}`;
  }

  /** Last issued number per prefix, so a resumed attempt keeps issuing fresh ids. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
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

  snapshot(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.files);
  }

  clone(): InMemoryWorkspace {
    return new InMemoryWorkspace(this.ref, Object.fromEntries(this.files));
  }

  hash(): string {
    const entries = [...this.files.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  }
}

// ---------------------------------------------------------------------- tools

const ToolOutputSchema = z.strictObject({
  ok: z.boolean(),
  summary: z.string(),
  observation: z.string(),
  exitStatus: z.int().optional(),
  artifactRef: z.string().optional(),
});

interface ToolDefinition<S extends z.ZodType> {
  name: string;
  description: string;
  inputSchema: S;
  sideEffect: SideEffectClass;
  idempotent: boolean;
  timeoutMs?: number;
  endsExecution?: boolean;
  touchedPaths?: (args: z.output<S>) => string[];
  denyArgs?: (args: z.output<S>, policy: Policy) => Denial | null;
  run: (args: z.output<S>, ctx: ToolContext) => ToolOutput;
}

/** Builds a ToolAdapter whose arguments are always re-validated, even if the caller already parsed them. */
export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): ToolAdapter {
  const denyArgs = def.denyArgs;
  return {
    descriptor: {
      name: def.name,
      version: "1",
      description: def.description,
      inputSchema: def.inputSchema,
      outputSchema: ToolOutputSchema,
      sideEffect: def.sideEffect,
      requiredPermissions: [def.sideEffect],
      timeoutMs: def.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      idempotent: def.idempotent,
      endsExecution: def.endsExecution ?? false,
      touchedPaths: (args) => (def.touchedPaths ? def.touchedPaths(def.inputSchema.parse(args)) : []),
      ...(denyArgs ? { denyArgs: (args: unknown, policy: Policy) => denyArgs(def.inputSchema.parse(args), policy) } : {}),
    },
    execute: async (args, ctx) => ToolOutputSchema.parse(def.run(def.inputSchema.parse(args), ctx)),
  };
}

// P0 limits, PRD §11. Per-tool timeouts other than run_command's are not specified there.
const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
const MAX_LIST_ENTRIES = 2_000;
const MAX_READ_LINES = 400;
const MAX_READ_BYTES = 64 * 1024;
const MAX_SEARCH_MATCHES = 200;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024;
const MAX_COMMAND_TIMEOUT_SEC = 600;

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/** Longest prefix of `text` that fits in `limit` UTF-8 bytes. */
function clipBytes(text: string, limit: number): string {
  if (byteLength(text) <= limit) return text;
  let clipped = Buffer.from(text, "utf8").subarray(0, limit).toString("utf8");
  if (clipped.endsWith("\uFFFD")) clipped = clipped.slice(0, -1); // drop a character cut in half
  return clipped;
}

const PathArg = z.string().min(1);
const Content = z.string().refine((c) => byteLength(c) <= MAX_WRITE_BYTES, { message: `at most ${MAX_WRITE_BYTES} bytes` });

/** Paths named by a unified diff: file headers plus git rename/copy lines, so none can hide a protected path. */
export function diffPaths(unifiedDiff: string): string[] {
  const paths = new Set<string>();
  const add = (raw: string) => {
    const path = raw.split("\t")[0].trim().replace(/^"(.*)"$/, "$1");
    if (path !== "/dev/null" && path !== "") paths.add(path.replace(/^[ab]\//, ""));
  };
  for (const line of unifiedDiff.split("\n")) {
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git) {
      add(git[1]);
      add(git[2]);
    } else if (/^(---|\+\+\+) /.test(line)) add(line.slice(4));
    else {
      const move = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
      if (move) add(move[1]);
    }
  }
  return [...paths];
}

function globToRegExp(glob: string): RegExp {
  const source = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\0/g, ".*");
  return new RegExp(`^${source}$`);
}

const ReadRange = z
  .strictObject({ path: PathArg, startLine: z.int().min(1).optional(), endLine: z.int().min(1).optional() })
  .refine((a) => a.startLine === undefined || a.endLine === undefined || a.startLine <= a.endLine, {
    message: "startLine must not exceed endLine",
  });

/** Default PRD §11 allowlist matching: an entry matches if it is a prefix of argv (so `["npx","tsc"]` is expressible). */
export function commandAllowed(argv: readonly string[], allowlist: Policy["commandAllowlist"]): boolean {
  return allowlist.some((entry) => entry.length <= argv.length && entry.every((part, i) => argv[i] === part));
}

/**
 * The P0 tool registry (PRD §11): exactly these seven, none with the `external_write` class. They run
 * against an in-memory workspace; the sandbox is DEC-02. `apply_patch` validates and authorizes but the
 * stub workspace does not apply patches, and `search_code` matches `pattern` as a fixed string where the
 * sandboxed tool uses ripgrep.
 */
export function createStubTools(): ToolAdapter[] {
  return [
    defineTool({
      name: "list_files",
      description: "List files under a workspace path",
      inputSchema: z.strictObject({ path: PathArg, depth: z.int().min(0).max(4).optional() }),
      sideEffect: "read_only",
      idempotent: true,
      touchedPaths: (a) => [a.path],
      run: (a, { workspace, scope }) => {
        const root = normalizePath(a.path) ?? ".";
        const rootDepth = root === "." ? 0 : root.split("/").length;
        const files = workspace
          .list(a.path)
          .filter((f) => isInScope(f, scope) && f.split("/").length - rootDepth <= (a.depth ?? 4));
        const shown = files.slice(0, MAX_LIST_ENTRIES);
        const note = files.length > shown.length ? `\n[truncated: ${files.length - shown.length} more entries]` : "";
        return { ok: true, summary: `listed ${shown.length} files`, observation: shown.join("\n") + note };
      },
    }),
    defineTool({
      name: "read_file",
      description: "Read a workspace file, optionally a line range",
      inputSchema: ReadRange,
      sideEffect: "read_only",
      idempotent: true,
      touchedPaths: (a) => [a.path],
      run: (a, { workspace }) => {
        const content = workspace.read(a.path);
        if (content === undefined) return { ok: false, summary: "file not found", observation: `no such file: ${a.path}` };
        const lines = content.split("\n");
        const window = lines.slice((a.startLine ?? 1) - 1, a.endLine ?? lines.length).slice(0, MAX_READ_LINES);
        const text = clipBytes(window.join("\n"), MAX_READ_BYTES);
        const truncated = text.length < window.join("\n").length || window.length < (a.endLine ?? lines.length) - (a.startLine ?? 1) + 1;
        return { ok: true, summary: `read ${text.length} chars${truncated ? " (truncated)" : ""}`, observation: truncated ? `${text}\n[truncated]` : text };
      },
    }),
    defineTool({
      name: "search_code",
      description: "Search the workspace for a pattern, optionally within a glob",
      inputSchema: z.strictObject({ pattern: z.string().min(1), glob: z.string().min(1).optional() }),
      sideEffect: "read_only",
      idempotent: true,
      run: (a, { workspace, scope }) => {
        const include = a.glob === undefined ? null : globToRegExp(a.glob);
        const matches: string[] = [];
        for (const file of workspace.list(".")) {
          if (!isInScope(file, scope) || (include && !include.test(file))) continue;
          for (const [i, line] of (workspace.read(file) ?? "").split("\n").entries()) {
            if (line.includes(a.pattern)) matches.push(`${file}:${i + 1}:${line}`);
          }
        }
        const shown = matches.slice(0, MAX_SEARCH_MATCHES);
        const note = matches.length > shown.length ? `\n[truncated: ${matches.length - shown.length} more matches]` : "";
        return { ok: true, summary: `${shown.length} matches`, observation: shown.join("\n") + note };
      },
    }),
    defineTool({
      name: "write_file",
      description: "Replace a workspace file's content",
      inputSchema: z.strictObject({ path: PathArg, content: Content }),
      sideEffect: "workspace_write",
      idempotent: true,
      touchedPaths: (a) => [a.path],
      run: (a, { workspace }) => {
        workspace.write(a.path, a.content);
        return { ok: true, summary: `wrote ${a.content.length} chars`, observation: `wrote ${a.path}` };
      },
    }),
    defineTool({
      name: "apply_patch",
      description: "Apply a unified diff to the workspace",
      inputSchema: z.strictObject({
        unifiedDiff: Content.refine((d) => diffPaths(d).length > 0, { message: "diff names no file" }),
      }),
      sideEffect: "workspace_write",
      idempotent: false,
      touchedPaths: (a) => diffPaths(a.unifiedDiff),
      run: () => ({ ok: false, summary: "not supported by the stub workspace", observation: "apply_patch is not available in Phase 0" }),
    }),
    defineTool({
      name: "run_command",
      description: "Run an allowlisted command (argv, no shell) in the sandbox",
      inputSchema: z.strictObject({
        argv: z.array(z.string().min(1).refine((part) => !part.includes("\0"))).min(1),
        timeoutSec: z.int().min(1).max(MAX_COMMAND_TIMEOUT_SEC).optional(),
      }),
      sideEffect: "workspace_write",
      idempotent: false,
      timeoutMs: MAX_COMMAND_TIMEOUT_SEC * 1000,
      denyArgs: (a, policy) =>
        commandAllowed(a.argv, policy.commandAllowlist)
          ? null
          : { reasonCode: "command_not_allowed", detail: `${a.argv.slice(0, 2).join(" ")} is not on the policy's command allowlist` },
      run: (a, { workspace, commands, artifacts }) => {
        const handler = commands[a.argv.join(" ")];
        const result = handler ? handler(workspace) : { exitCode: 127, output: `command not found: ${a.argv[0]}` };
        const truncated = byteLength(result.output) > MAX_COMMAND_OUTPUT_BYTES;
        return {
          ok: result.exitCode === 0,
          summary: `exit ${result.exitCode}${truncated ? " (output truncated)" : ""}`,
          observation: clipBytes(result.output, MAX_COMMAND_OUTPUT_BYTES),
          exitStatus: result.exitCode,
          ...(truncated ? { artifactRef: artifacts.put(result.output) } : {}),
        };
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

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly blobs = new Map<string, string>();

  put(content: string): string {
    const ref = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    this.blobs.set(ref, content);
    return ref;
  }

  get(ref: string): string | undefined {
    return this.blobs.get(ref);
  }
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
