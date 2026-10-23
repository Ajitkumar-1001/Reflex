import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolOutput } from "./ports";

/*
 * External side-effect ledger (Phase 2). Every mutation a tool makes is recorded under an idempotency
 * key of run id + step + intent hash *before* it runs, and moves intended → committed or failed.
 * A second dispatch of the same key finds the row already there and must not run the mutation again,
 * including when the first attempt is still `intended` (at-most-once: a crash between the record and
 * the call is not distinguishable from a call that happened).
 *
 * Synchronous on purpose. The in-memory check-and-set has to finish before `intend` yields, or two
 * dispatches could both decide they were first. A durable adapter would replace this class.
 */

const Timestamp = z.iso.datetime();
const HexHash = z.string().regex(/^[0-9a-f]{64}$/);

export const EffectState = z.enum(["intended", "committed", "failed"]);
export type EffectState = z.infer<typeof EffectState>;

const ToolOutputRecord = z.strictObject({
  ok: z.boolean(),
  summary: z.string(),
  observation: z.string(),
  exitStatus: z.int().optional(),
  artifactRef: z.string().optional(),
});

export const EffectRecordSchema = z
  .strictObject({
    key: z.string().min(1),
    runId: z.string().min(1),
    step: z.int().positive(),
    intentHash: HexHash,
    tool: z.string().min(1),
    argsSummary: z.string(),
    state: EffectState,
    recordedAt: Timestamp,
    settledAt: Timestamp.nullable(),
    output: ToolOutputRecord.nullable(),
    failure: z.string().nullable(),
  })
  .superRefine((record, ctx) => {
    if (record.key !== `${record.runId}:${record.step}:${record.intentHash}`) {
      ctx.addIssue({ code: "custom", path: ["key"], message: "key must be run id, step and intent hash" });
    }
    if (record.state === "intended" && (record.settledAt !== null || record.output !== null || record.failure !== null)) {
      ctx.addIssue({ code: "custom", path: ["state"], message: "an intended effect has no outcome yet" });
    }
    if (record.state !== "intended" && record.settledAt === null) {
      ctx.addIssue({ code: "custom", path: ["settledAt"], message: "a settled effect needs settledAt" });
    }
  });
export type EffectRecord = z.infer<typeof EffectRecordSchema>;

export interface EffectIntent {
  key: string;
  runId: string;
  step: number;
  intentHash: string;
  tool: string;
  argsSummary: string;
  recordedAt: string;
}

export interface EffectSettlement {
  state: "committed" | "failed";
  at: string;
  output: ToolOutput | null;
  failure: string | null;
}

export interface SideEffectLedger {
  /**
   * Insert `intended` when the key is new. When it already exists, return that row and `inserted: false`
   * and do not touch it: the caller must not perform the mutation.
   */
  intend(intent: EffectIntent): { record: EffectRecord; inserted: boolean };
  /** First settlement wins. A row that is already committed or failed is returned unchanged. */
  settle(key: string, settlement: EffectSettlement): EffectRecord;
  get(key: string): EffectRecord | undefined;
  list(): EffectRecord[];
}

/** Stable encoding so key order in a tool's arguments cannot fork the intent hash. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

/** Idempotency key: run id + step + sha256 of the tool name and its arguments. */
export function effectKey(runId: string, step: number, tool: string, args: unknown): { key: string; intentHash: string } {
  const intentHash = createHash("sha256").update(canonical({ tool, args })).digest("hex");
  return { key: `${runId}:${step}:${intentHash}`, intentHash };
}

const copy = <T>(value: T): T => structuredClone(value);

export class InMemorySideEffectLedger implements SideEffectLedger {
  private readonly records = new Map<string, EffectRecord>();

  intend(intent: EffectIntent): { record: EffectRecord; inserted: boolean } {
    const existing = this.records.get(intent.key);
    if (existing) return { record: copy(existing), inserted: false };
    const record = EffectRecordSchema.parse({
      ...intent,
      state: "intended",
      settledAt: null,
      output: null,
      failure: null,
    });
    this.records.set(record.key, record);
    return { record: copy(record), inserted: true };
  }

  settle(key: string, settlement: EffectSettlement): EffectRecord {
    const current = this.records.get(key);
    if (!current) throw new Error(`no side effect ${key}`);
    if (current.state !== "intended") return copy(current);
    const next = EffectRecordSchema.parse({
      ...current,
      state: settlement.state,
      settledAt: settlement.at,
      output: settlement.output,
      failure: settlement.failure,
    });
    this.records.set(key, next);
    return copy(next);
  }

  get(key: string): EffectRecord | undefined {
    const found = this.records.get(key);
    return found && copy(found);
  }

  list(): EffectRecord[] {
    return [...this.records.values()].map(copy);
  }
}
