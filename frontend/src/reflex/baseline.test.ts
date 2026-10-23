import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auditTrace } from "./evaluator";
import { runFixture } from "./fixture";

/**
 * Arm A (memory off) baseline for the Phase 0 fixture. The committed snapshot in
 * __snapshots__/baseline.memory-off.json is the recorded baseline; refresh it deliberately
 * with `pnpm test -- -u` and review the diff.
 */
async function baselineReport() {
  const result = await runFixture();
  if (!result.admitted) throw new Error("fixture was not admitted");
  const { run, events, evaluation } = result;
  const audit = auditTrace(events);
  return {
    result,
    report: {
      fixture: run.taskId,
      arm: run.configArm,
      memory: run.retrievalSnapshot.mode,
      policy: { id: run.policyId, version: run.policyVersion },
      modelConfig: run.modelConfig,
      toolRegistryVersion: run.toolRegistryVersion,
      status: run.status,
      outcome: run.outcome,
      outcomeReason: run.outcomeReason,
      evaluatorVersion: evaluation?.evaluatorVersion ?? null,
      checks: evaluation?.checks.map((c) => ({ name: c.name, passed: c.passed })) ?? [],
      ledger: run.ledger,
      startWorkspaceHash: run.startWorkspaceHash,
      endWorkspaceHash: run.endWorkspaceHash,
      eventCount: events.length,
      eventTypes: events.map((e) => e.type),
      executedToolCalls: audit.executedToolCalls,
      deniedToolCalls: audit.deniedToolCalls,
      unauthorizedToolActions: audit.unauthorizedToolActions,
      traceComplete: audit.complete,
      traceSha256: createHash("sha256").update(JSON.stringify(events)).digest("hex"),
    },
  };
}

describe("memory-off baseline (FR-12, Phase 0)", () => {
  it("is reproducible: two runs yield identical runs, events and evaluations", async () => {
    const first = await baselineReport();
    const second = await baselineReport();
    expect(second.result).toEqual(first.result);
    expect(second.report.traceSha256).toBe(first.report.traceSha256);
  });

  it("matches the recorded baseline", async () => {
    const { report } = await baselineReport();
    await expect(`${JSON.stringify(report, null, 2)}\n`).toMatchFileSnapshot("./__snapshots__/baseline.memory-off.json");
  });

  it("meets the Phase 0 exit gate", async () => {
    const { report } = await baselineReport();
    expect(report).toMatchObject({
      arm: "A",
      memory: "disabled",
      outcome: "verified_success",
      traceComplete: true,
      unauthorizedToolActions: 0,
    });
  });
});
