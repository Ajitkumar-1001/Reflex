import { authorize, ReflexError } from "./access";
import type { Principal } from "./access";
import type { GateDecision, LifecycleState, MemoryKind, MemoryRecord, Run } from "./contracts";
import { HybridRetriever } from "./retrieval";
import type { RetrievalConfig } from "./retrieval";
import type { Clock, Embedder, MemoryRepository, RunRecords } from "./ports";
import { DAY_MS, PROPOSED_RETENTION } from "./retention";
import type { RetentionConfig } from "./retention";

/*
 * Memory explorer read API (PRD §16 "Memory explorer", §15 `GET /v1/memories/search`, `/v1/memories/{id}`,
 * `/v1/review-queue`; US-2, US-3). Typed functions with the PRD's authorization rules, ready for route handlers
 * to wrap. There is deliberately no page: the routes and token authentication that would feed one (FR-29) are not
 * built, and a page over an empty in-process store would show nothing real. Embeddings are never returned.
 */

const MAX_K = 20; // §15.1: search returns top-k only, k <= 20
const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;

/** The §15.2 `Memory` shape, plus the fields an inspector needs. No embedding, no raw vectors. */
export interface MemoryView {
  id: string;
  kind: MemoryKind;
  text: string;
  lifecycleState: LifecycleState;
  version: number;
  scope: MemoryRecord["scope"];
  preconditions: string[];
  confidence: number;
  sourceRunIds: string[];
  lastVerifiedAt?: string;
  expiresAt?: string;
}

const view = (m: MemoryRecord): MemoryView => ({
  id: m.id,
  kind: m.kind,
  text: m.text,
  lifecycleState: m.lifecycleState,
  version: m.version,
  scope: m.scope,
  preconditions: m.preconditions,
  confidence: m.confidence,
  sourceRunIds: m.sourceRunIds,
  ...(m.lastVerifiedAt ? { lastVerifiedAt: m.lastVerifiedAt } : {}),
  ...(m.expiresAt ? { expiresAt: m.expiresAt } : {}),
});

export interface MemoryDetail {
  memory: MemoryView;
  ageDays: number;
  /** Source runs and evaluations: why this memory exists and what verified it. */
  provenance: {
    runs: { runId: string; taskId: string; outcome: Run["outcome"]; outcomeReason: Run["outcomeReason"] }[];
    evaluations: { evaluationId: string; verdict: string; checkBundleHash: string }[];
  };
  usage: {
    helpful: number;
    harmful: number;
    uses: { runId: string; citedInPlan: boolean; followed: boolean; outcomeEffect: string }[];
  };
  /** Older versions this memory replaced, newest first, and the memory that replaced it, if any. */
  supersession: { supersedes: string[]; supersededBy: string | null };
  /** Why retrieval would skip it right now, and whether it needs re-verification (§9.6). */
  flags: { expired: boolean; idle: boolean; sourceQuarantined: boolean; needsReverification: boolean };
  history: { at: string; actor: string; from: LifecycleState | null; to: LifecycleState; version: number; reasonCode: string }[];
  gate: GateDecision | null;
}

export interface ReviewItem {
  candidate: MemoryView;
  gate: GateDecision;
  createdAt: string;
}

export class MemoryExplorer {
  private readonly retriever: HybridRetriever;

  constructor(
    private readonly repo: MemoryRepository,
    private readonly records: RunRecords,
    embedder: Embedder,
    private readonly clock: Clock,
    retrieval: Partial<RetrievalConfig> = {},
    private readonly retention: RetentionConfig = PROPOSED_RETENTION,
  ) {
    this.retriever = new HybridRetriever(repo, records, embedder, clock, retrieval, retention);
  }

  /** `GET /v1/memories/search`: hybrid search in one project. Defaults to approved memory; any role may read. */
  async search(
    principal: Principal,
    input: { projectId: string; q: string; kind?: MemoryKind; k?: number; states?: readonly LifecycleState[] },
  ): Promise<{ items: { memory: MemoryView; score: number }[] }> {
    authorize(principal, "read", { tenantId: principal.tenantId, projectId: input.projectId });
    const found = await this.retriever.search(
      { tenantId: principal.tenantId, projectId: input.projectId, text: input.q },
      { lifecycleStates: input.states ?? ["approved"], ...(input.kind ? { kinds: [input.kind] } : {}), k: Math.min(MAX_K, Math.max(1, input.k ?? 10)) },
    );
    return { items: found.map((f) => ({ memory: view(f.memory), score: f.score })) };
  }

  /** `GET /v1/memories/{id}`: the memory with its provenance, usage outcomes, supersession chain and audit history. */
  async get(principal: Principal, memoryId: string): Promise<MemoryDetail> {
    const m = await this.repo.get(memoryId);
    if (!m) throw new ReflexError("not_found", "not found");
    authorize(principal, "read", m);

    const runs = await Promise.all(m.sourceRunIds.map((id) => this.records.getRun(id)));
    const evaluations = await Promise.all(m.evaluationIds.map((id) => this.records.getEvaluation(id)));
    const events = await this.records.memoryEvents(m.id);
    const quarantined = await this.records.quarantinedRunIds();
    const siblings = await this.repo.find({ tenantId: m.tenantId, projectId: m.projectId });
    const now = this.clock.now().getTime();

    const chain: string[] = [];
    for (let cursor = m.supersedes, guard = 0; cursor && guard < 100; guard++) {
      chain.push(cursor);
      cursor = siblings.find((s) => s.id === cursor)?.supersedes ?? null;
    }
    const idle = m.kind === "episodic" && now - Date.parse(m.lastUsedAt ?? m.createdAt) > this.retention.episodicIdleDays * DAY_MS;
    const expired = m.expiresAt !== null && Date.parse(m.expiresAt) <= now;

    return {
      memory: view(m),
      ageDays: Math.floor((now - Date.parse(m.createdAt)) / DAY_MS),
      provenance: {
        runs: runs.flatMap((r) => (r ? [{ runId: r.id, taskId: r.taskId, outcome: r.outcome, outcomeReason: r.outcomeReason }] : [])),
        evaluations: evaluations.flatMap((e) => (e ? [{ evaluationId: e.id, verdict: e.verdict, checkBundleHash: e.checkBundleHash }] : [])),
      },
      usage: {
        helpful: m.helpfulCount,
        harmful: m.harmfulCount,
        uses: events.flatMap((e) => (e.type === "memory_use" ? [{ runId: e.runId, citedInPlan: e.redactedPayload.citedInPlan, followed: e.redactedPayload.followed, outcomeEffect: e.redactedPayload.outcomeEffect }] : [])),
      },
      supersession: { supersedes: chain, supersededBy: siblings.find((s) => s.supersedes === m.id)?.id ?? null },
      flags: {
        expired,
        idle,
        sourceQuarantined: m.sourceRunIds.some((id) => quarantined.has(id)),
        needsReverification: m.lifecycleState === "demoted" || m.lifecycleState === "expired" || expired,
      },
      history: events.flatMap((e) => (e.type === "memory_lifecycle" ? [{ at: e.timestamp, actor: e.actor.id, from: e.redactedPayload.from, to: e.redactedPayload.to, version: e.redactedPayload.version, reasonCode: e.redactedPayload.reasonCode }] : [])),
      gate: m.gateDecision,
    };
  }

  /** `GET /v1/review-queue`: candidates the gate held for a human, oldest first, with an opaque cursor. */
  async reviewQueue(
    principal: Principal,
    input: { projectId: string; limit?: number; cursor?: string },
  ): Promise<{ items: ReviewItem[]; next_cursor?: string }> {
    authorize(principal, "read", { tenantId: principal.tenantId, projectId: input.projectId });
    const limit = Math.min(MAX_PAGE, Math.max(1, input.limit ?? DEFAULT_PAGE));
    const after = input.cursor ? decodeCursor(input.cursor) : null;
    const queue = (await this.repo.find({ tenantId: principal.tenantId, projectId: input.projectId, lifecycleStates: ["candidate"] }))
      .filter((m) => m.gateDecision?.result === "REVIEW_REQUIRED")
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
      .filter((m) => after === null || m.createdAt > after.t || (m.createdAt === after.t && m.id > after.id));
    const page = queue.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.flatMap((m) => (m.gateDecision ? [{ candidate: view(m), gate: m.gateDecision, createdAt: m.createdAt }] : [])),
      ...(queue.length > limit && last ? { next_cursor: encodeCursor(last.createdAt, last.id) } : {}),
    };
  }

  /** US-2: which memories were in a run's context, which it cited, and what feedback followed. */
  async runMemory(principal: Principal, runId: string): Promise<{
    retrieval: Run["retrievalSnapshot"];
    context: Run["memoryContext"];
    playbookVersion: Run["playbookVersion"];
    uses: { memoryId: string; citedInPlan: boolean; followed: boolean; outcomeEffect: string }[];
  }> {
    const run = await this.records.getRun(runId);
    const task = run && (await this.records.getTask(run.taskId));
    if (!run || !task) throw new ReflexError("not_found", "not found");
    authorize(principal, "read", task);
    const trace = await this.records.getEvents(run.id);
    return {
      retrieval: run.retrievalSnapshot,
      context: run.memoryContext,
      playbookVersion: run.playbookVersion,
      uses: trace.flatMap((e) => (e.type === "memory_use" ? [{ memoryId: e.redactedPayload.memoryId, citedInPlan: e.redactedPayload.citedInPlan, followed: e.redactedPayload.followed, outcomeEffect: e.redactedPayload.outcomeEffect }] : [])),
    };
  }
}

const encodeCursor = (t: string, id: string) => Buffer.from(JSON.stringify({ t, id })).toString("base64url");

function decodeCursor(cursor: string): { t: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && "t" in parsed && "id" in parsed && typeof parsed.t === "string" && typeof parsed.id === "string") {
      return { t: parsed.t, id: parsed.id };
    }
  } catch {
    // fall through to the validation error
  }
  throw new ReflexError("validation_error", "invalid cursor");
}
