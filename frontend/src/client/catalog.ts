/*
 * Dashboard read model over the Phase 1 in-memory store and MemoryExplorer.
 * The seed runs the existing lab (no domain changes) so the pages have runs, memories, and an A/B report.
 * Ids are deterministic: run-1 is the add train run, run-2 the sub train run, run-3 the memory-on mul demo.
 * The demo approval requests (`ledger-approvals.ts`) link to those three. Do not insert another run ahead of them.
 */

import { ReflexError } from "../reflex/access";
import { LifecycleState } from "../reflex/contracts";
import type { RunEvent } from "../reflex/contracts";
import { runExperiment } from "../reflex/experiment";
import type { ExperimentReport } from "../reflex/experiment";
import { MemoryExplorer } from "../reflex/explorer";
import type { MemoryDetail } from "../reflex/explorer";
import { Lab, PRINCIPALS, PROJECT, TENANT, arithmeticTask } from "../reflex/memory-fixture";
import type { Operator } from "../reflex/memory-fixture";
import { FrozenMemoryRepository } from "../reflex/store";
import { buildRunDetail, memoryListItemFromView, sortRunsNewestFirst, toMemoryListItem, toRunListItem } from "./views";
import type { MemoryListItem, MemoryProvenance, MemoryQuery, RunDetailModel, RunListItem } from "./views";

const EXPERIMENT_ITEMS: readonly { id: string; op: Operator }[] = [
  { id: "task-exp-1", op: "mul" },
  { id: "task-exp-2", op: "sub" },
  { id: "task-exp-3", op: "add" },
  { id: "task-exp-4", op: "mul" },
  { id: "task-exp-5", op: "sub" },
  { id: "task-exp-6", op: "add" },
];

const ALL_STATES = LifecycleState.options;

export interface DashboardCatalog {
  projectId: string;
  tenantId: string;
  principalLabel: string;
  report: ExperimentReport;
  listRuns(): Promise<RunListItem[]>;
  getRun(id: string): Promise<RunDetailModel | null>;
  listMemories(): Promise<MemoryListItem[]>;
  searchMemories(query: MemoryQuery & { q: string }): Promise<MemoryListItem[]>;
  getMemory(id: string): Promise<MemoryDetail | null>;
}

async function buildCatalog(): Promise<DashboardCatalog> {
  const lab = new Lab();
  const failed = await lab.run({
    op: "add",
    task: arithmeticTask("add", { id: "task-add-train", version: 3, split: "train" }),
  });
  const trainMemories = await lab.store.memories.find({ tenantId: TENANT, projectId: PROJECT, kinds: ["procedural"] });
  const lesson = trainMemories.find((record) => record.text.includes("operator"));
  if (lesson && lesson.lifecycleState === "candidate") {
    await lab.service().decide(PRINCIPALS.owner, lesson.id, { decision: "approve", reasonCode: "reviewed" });
  }
  await lab.run({
    op: "sub",
    task: arithmeticTask("sub", { id: "task-sub-train", version: 3, split: "train" }),
  });

  const evaluationId = failed.evaluation?.id;
  await lab.seed({
    id: "mem-quarantined-schema",
    kind: "semantic",
    text: "Do not regenerate the Prisma client until schema.prisma is saved. Running gen:client against a dirty schema left the types behind the database.",
    lifecycleState: "quarantined",
    scope: { taskClass: "schema_change", conditions: ["schema.prisma changed"], stack: ["prisma"] },
    sourceRunIds: [failed.run.id],
    ...(evaluationId ? { evaluationIds: [evaluationId] } : {}),
    confidence: 0.4,
  });
  await lab.seed({
    id: "mem-expired-docs",
    kind: "semantic",
    text: "The docs site build fails when the sidebar config still lists a deleted page.",
    lifecycleState: "expired",
    expiresAt: "2025-06-01T00:00:00.000Z",
    scope: { taskClass: "docs_only", conditions: ["docs sidebar"], stack: ["mdx"] },
    sourceRunIds: [failed.run.id],
    ...(evaluationId ? { evaluationIds: [evaluationId] } : {}),
    confidence: 0.2,
  });
  await lab.seed({
    id: "mem-candidate-playbook",
    kind: "playbook_item",
    text: "When a check fails, quote the check name in the lesson instead of restating the whole diff.",
    lifecycleState: "candidate",
    scope: { conditions: ["any failed check"] },
    sourceRunIds: [failed.run.id],
    confidence: 0.3,
    gateDecision: {
      result: "REVIEW_REQUIRED",
      reasonCodes: ["playbook_review"],
      judgeModel: null,
      reviewer: null,
      decidedAt: "2026-01-01T00:00:00.000Z",
    },
  });

  await lab.run({
    op: "mul",
    task: arithmeticTask("mul", { id: "task-mul-demo", version: 2, split: "test" }),
    repository: new FrozenMemoryRepository(lab.store.memories),
  });

  const report = await runExperiment({
    experimentId: "exp-dashboard",
    items: EXPERIMENT_ITEMS,
    trials: 1,
    bootstrap: { resamples: 200, seed: 1 },
    runOne: ({ arm, item, trialIndex }) => {
      const task = arithmeticTask(item.op, { id: item.id, version: arm === "A" ? 1 : 2, split: "test" });
      return lab.run({
        op: item.op,
        task,
        experiment: { experimentId: "exp-dashboard", trialIndex },
        ...(arm === "A" ? { memory: false as const } : { repository: new FrozenMemoryRepository(lab.store.memories) }),
      });
    },
  });

  const explorer = new MemoryExplorer(lab.store.memories, lab.store, lab.embedder, lab.clock);
  return new LabCatalog(lab, explorer, report);
}

class LabCatalog implements DashboardCatalog {
  readonly projectId = PROJECT;
  readonly tenantId = TENANT;
  readonly principalLabel = `${PRINCIPALS.viewer.id} (${PRINCIPALS.viewer.role})`;

  constructor(
    private readonly lab: Lab,
    private readonly explorer: MemoryExplorer,
    readonly report: ExperimentReport,
  ) {}

  async listRuns(): Promise<RunListItem[]> {
    const runs = await this.lab.store.allRuns();
    const items = await Promise.all(
      runs.map(async (run) => toRunListItem(run, await this.lab.store.getTask(run.taskId))),
    );
    return sortRunsNewestFirst(items);
  }

  async getRun(id: string): Promise<RunDetailModel | null> {
    const run = await this.lab.store.getRun(id);
    if (!run) return null;
    const task = await this.lab.store.getTask(run.taskId);
    if (!task) return null;
    const events = await this.lab.store.getEvents(run.id);
    const evaluationId = lastEvaluationId(events);
    const evaluation = evaluationId ? await this.lab.store.getEvaluation(evaluationId) : undefined;
    let memory: Awaited<ReturnType<MemoryExplorer["runMemory"]>>;
    try {
      memory = await this.explorer.runMemory(PRINCIPALS.viewer, run.id);
    } catch (error) {
      if (error instanceof ReflexError && error.code === "not_found") return null;
      throw error;
    }
    const provenance = new Map<string, MemoryProvenance>();
    const ids = new Set<string>([...run.memoryContext.map((card) => card.memoryId), ...memory.uses.map((use) => use.memoryId)]);
    for (const memoryId of ids) {
      try {
        const detail = await this.explorer.get(PRINCIPALS.viewer, memoryId);
        provenance.set(memoryId, {
          text: detail.memory.text,
          lifecycleState: detail.memory.lifecycleState,
          sourceRunIds: detail.provenance.runs.map((source) => source.runId),
        });
      } catch (error) {
        if (!(error instanceof ReflexError) || error.code !== "not_found") throw error;
      }
    }
    return buildRunDetail({
      run,
      task,
      events,
      evaluation: evaluation ?? null,
      memoryUses: memory.uses,
      provenance,
    });
  }

  async listMemories(): Promise<MemoryListItem[]> {
    const records = await this.lab.store.memories.find({ tenantId: TENANT, projectId: PROJECT });
    return records
      .map((record) => toMemoryListItem(record))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async searchMemories(query: MemoryQuery & { q: string }): Promise<MemoryListItem[]> {
    const found = await this.explorer.search(PRINCIPALS.viewer, {
      projectId: PROJECT,
      q: query.q,
      states: query.status ? [query.status] : ALL_STATES,
      ...(query.kind ? { kind: query.kind } : {}),
      k: 20,
    });
    return found.items.map((item) => memoryListItemFromView(item.memory, item.score));
  }

  async getMemory(id: string): Promise<MemoryDetail | null> {
    try {
      return await this.explorer.get(PRINCIPALS.viewer, id);
    } catch (error) {
      if (error instanceof ReflexError && error.code === "not_found") return null;
      throw error;
    }
  }
}

function lastEvaluationId(events: readonly RunEvent[]): string | null {
  let id: string | null = null;
  for (const event of events) {
    if (event.type === "evaluation_recorded") id = event.redactedPayload.evaluationId;
  }
  return id;
}

let pending: Promise<DashboardCatalog> | null = null;

export function getCatalog(): Promise<DashboardCatalog> {
  pending ??= buildCatalog().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}
