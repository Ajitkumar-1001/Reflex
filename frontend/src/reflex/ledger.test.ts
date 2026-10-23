import { describe, expect, it } from "vitest";
import { InMemorySideEffectLedger, effectKey } from "./ledger";
import type { EffectIntent } from "./ledger";

const at = "2026-01-01T00:00:00.000Z";
const later = "2026-01-01T00:00:01.000Z";

function intent(over: Partial<Pick<EffectIntent, "runId" | "step" | "tool" | "argsSummary" | "recordedAt">> = {}): EffectIntent {
  const runId = over.runId ?? "run-1";
  const step = over.step ?? 1;
  const tool = over.tool ?? "post_comment";
  const key = effectKey(runId, step, tool, { body: "hi" });
  return { ...key, runId, step, tool, argsSummary: over.argsSummary ?? "{\"body\":\"hi\"}", recordedAt: over.recordedAt ?? at };
}

describe("side-effect ledger", () => {
  it("keys an effect by run id, step and an intent hash of the tool and its arguments", () => {
    const first = effectKey("run-1", 2, "post_comment", { body: "hi", room: "a" });
    const reordered = effectKey("run-1", 2, "post_comment", { room: "a", body: "hi" });
    expect(first).toEqual(reordered);
    expect(first.key).toBe(`run-1:2:${first.intentHash}`);
    expect(first.intentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(effectKey("run-1", 3, "post_comment", { body: "hi" }).key).not.toBe(effectKey("run-1", 2, "post_comment", { body: "hi" }).key);
    expect(effectKey("run-2", 2, "post_comment", { body: "hi" }).key).not.toBe(effectKey("run-1", 2, "post_comment", { body: "hi" }).key);
    expect(effectKey("run-1", 2, "post_comment", { body: "yo" }).key).not.toBe(first.key);
    expect(effectKey("run-1", 2, "open_pr", { body: "hi", room: "a" }).key).not.toBe(first.key);
  });

  it("records intended before any outcome, then committed or failed", () => {
    const ledger = new InMemorySideEffectLedger();
    const inserted = ledger.intend(intent());
    expect(inserted.inserted).toBe(true);
    expect(inserted.record.state).toBe("intended");
    expect(inserted.record.settledAt).toBeNull();

    const committed = ledger.settle(inserted.record.key, {
      state: "committed",
      at: later,
      output: { ok: true, summary: "posted", observation: "posted" },
      failure: null,
    });
    expect(committed.state).toBe("committed");
    expect(ledger.get(inserted.record.key)?.output?.summary).toBe("posted");

    const failedIntent = intent({ step: 2 });
    ledger.intend(failedIntent);
    const failed = ledger.settle(failedIntent.key, { state: "failed", at: later, output: null, failure: "remote rejected it" });
    expect(failed).toMatchObject({ state: "failed", failure: "remote rejected it" });
  });

  it("does not insert again or overwrite a settled row when the same key is repeated", () => {
    const ledger = new InMemorySideEffectLedger();
    const first = ledger.intend(intent());
    const second = ledger.intend(intent({ recordedAt: later, argsSummary: "other" }));
    expect(second.inserted).toBe(false);
    expect(second.record.recordedAt).toBe(at);
    expect(ledger.list()).toHaveLength(1);

    ledger.settle(first.record.key, {
      state: "committed",
      at: later,
      output: { ok: true, summary: "posted", observation: "posted" },
      failure: null,
    });
    const again = ledger.settle(first.record.key, { state: "failed", at: later, output: null, failure: "too late" });
    expect(again.state).toBe("committed");
    expect(again.failure).toBeNull();
  });

  it("returns copies, so a caller cannot mutate the stored row", () => {
    const ledger = new InMemorySideEffectLedger();
    const { record } = ledger.intend(intent());
    record.state = "committed";
    expect(ledger.get(record.key)?.state).toBe("intended");
  });
});
