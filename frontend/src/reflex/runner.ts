import {
  EvaluationSchema,
  EventSchema,
  PlanSchema,
  RunSchema,
  ToolCallRequest,
  assertTransition,
  isTerminal,
} from "./contracts";
import type {
  Budget,
  EvaluationResult,
  OutcomeReason,
  Plan,
  Policy,
  Run,
  RunEvent,
  RunEventType,
  RunOutcome,
  RunState,
  Task,
  TerminalState,
} from "./contracts";
import { admitTask } from "./admission";
import { ApprovalAborted } from "./approval";
import type { ApprovalService } from "./approval";
import { WriteGate } from "./gate";
import { effectKey } from "./ledger";
import type { SideEffectLedger } from "./ledger";
import type { GateConfig } from "./gate";
import { LiveRecords } from "./live-records";
import { MemoryService } from "./memory-service";
import { authorizeToolCall, checkToolAccess } from "./permission";
import { actionRequiresApproval, dispatchEffect } from "./tool-runner";
import type { ToolRegistry } from "./permission";
import {
  EmbedderUnavailableError,
  FrozenMemoryError,
  InfraFailureError,
  ModelUnavailableError,
  ReflectorUnavailableError,
  RepositoryUnavailableError,
} from "./ports";
import type {
  ArtifactStore,
  Clock,
  CommandTable,
  Embedder,
  EventSink,
  Evaluator,
  IdGenerator,
  MemoryCard,
  MemoryJudge,
  MemoryRepository,
  ModelAdapter,
  ModelResponse,
  Observation,
  Reflector,
  RunEngine,
  RunRecords,
  RunRequest,
  RunResult,
  ToolOutput,
  Workspace,
} from "./ports";
import { RunHandoff } from "./execution/handoff";
import type { CheckpointPhase, RunCheckpoint, RunExecution } from "./execution/types";
import { episodicCandidate, parseReflection, redactReflection, reflectionCandidate } from "./reflection";
import { HybridRetriever } from "./retrieval";
import type { RetrievalConfig } from "./retrieval";
import type { RetentionConfig } from "./retention";
import { PROPOSED_RETENTION } from "./retention";
import { MemoryWriteback } from "./writeback";
import type { z } from "zod";

/*
 * Reference runner: a minimal in-process executor behind the RunEngine interface. Without `deps.memory` it is the
 * Phase 0 memory-off baseline (arm A) and its trace is byte-for-byte what Phase 0 recorded. With `deps.memory`
 * and a policy that enables it, the same loop retrieves bounded context before planning (arm B) and, outside a
 * frozen split, reflects and writes back through the gate. It is NOT the DEC-01 orchestration decision.
 * Without `deps.execution` a process crash loses the run. With it, a checkpoint is written after each
 * completed step and a later attempt continues from that step (Phase 2, DEC-03).
 */

const PROMPT_TEMPLATE_VERSION = "p0-scripted-1";
const MAX_DENIALS = 3;
const MAX_MODEL_ATTEMPTS = 2;

// PRD §7.8: provider failures retry 3 times at 2 s, 8 s, 30 s with jitter; a call over 120 s retries once.
const PROVIDER_BACKOFF_MS = [2_000, 8_000, 30_000] as const;
const MAX_TIMEOUT_RETRIES = 1;
const DEFAULT_MODEL_TIMEOUT_MS = 120_000;
const JITTER = 0.25; // ± fraction of the backoff; the PRD says "with jitter" without a width

class TimedOut extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimedOut()), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function effectiveBudget(task: Task, policy: Policy): Budget {
  return {
    maxSteps: Math.min(task.budget.maxSteps, policy.budgets.maxSteps),
    maxUsd: Math.min(task.budget.maxUsd, policy.budgets.maxUsd),
    maxWallMinutes: Math.min(task.budget.maxWallMinutes, policy.budgets.maxWallMinutes),
  };
}

// -------------------------------------------------------------------- runner

/**
 * Everything the memory-on path needs, injected so each piece can be swapped when its DEC lands: the store
 * (DEC-08), embedder (DEC-10), reflector and judge (DEC-12) and the retention numbers (DEC-05). Pass a
 * `FrozenMemoryRepository` for the frozen arm of an experiment.
 */
export interface MemoryRuntime {
  repository: MemoryRepository;
  records: RunRecords;
  embedder: Embedder;
  /** Null: no reflection, only the automatic episodic record. */
  reflector: Reflector | null;
  /** Null: the gate cannot judge, so non-episodic candidates go to review as `judge_unavailable`. */
  judge: MemoryJudge | null;
  retention?: RetentionConfig;
  retrieval?: Partial<RetrievalConfig>;
  gate?: Partial<GateConfig>;
}

export interface RunnerDeps {
  model: ModelAdapter;
  registry: ToolRegistry;
  evaluator: Evaluator;
  /** Fresh per run: the runner mutates it through tools. */
  workspace: Workspace;
  commands: CommandTable;
  artifacts: ArtifactStore;
  clock: Clock;
  ids: IdGenerator;
  sink?: EventSink;
  /** Per-call model timeout; PRD §7.8 default 120 s. */
  modelTimeoutMs?: number;
  /** Backoff sleep and jitter source, injectable so retries are deterministic in tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Absent: memory is disabled whatever the policy says, and a policy that enables it is blocked. */
  memory?: MemoryRuntime;
  /**
   * Phase 2 side effects. Absent: external writes stay denied and the trace matches the memory-off
   * baseline. Present: mutations are ledgered before they run, and an action that requires approval pauses.
   */
  effects?: EffectRuntime;
  /**
   * Durable execution (Phase 2). Absent: this attempt is the non-durable loop and traces match Phase 0/1.
   * Present: checkpoints are written at step boundaries, a stored checkpoint is resumed, and cancellation
   * requested through it stops the run at the next boundary.
   */
  execution?: RunExecution;
}

export interface EffectRuntime {
  ledger: SideEffectLedger;
  approvals: ApprovalService;
}

const PERSIST_ATTEMPTS = 3; // PRD §7.8: persistence retries 3 times

/** `path:<workspace path>` preconditions hold while the file exists; any other precondition cannot be checked here and is assumed to hold. */
const preconditionHolds = (workspace: Workspace) => (precondition: string): boolean =>
  precondition.startsWith("path:") ? workspace.read(precondition.slice(5)) !== undefined : true;

/** Control-flow signal: ends the run in a legal terminal state. */
class Stop extends Error {
  constructor(
    readonly state: TerminalState,
    readonly outcome: RunOutcome,
    readonly reason: OutcomeReason,
    readonly detail: string,
  ) {
    super(detail);
  }
}

type Actor = RunEvent["actor"];
type EventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;

export class ReferenceRunner implements RunEngine {
  constructor(private readonly deps: RunnerDeps) {}

  async execute(request: RunRequest): Promise<RunResult> {
    const { model, registry, evaluator, workspace, commands, artifacts, clock, ids, sink } = this.deps;
    const execution = this.deps.execution;
    const saved = execution?.checkpoint ?? null;
    if (saved && execution && saved.dispatchId !== execution.dispatchId) {
      throw new Error(`checkpoint ${saved.dispatchId} does not match dispatch ${execution.dispatchId}`);
    }
    const modelTimeoutMs = this.deps.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const random = this.deps.random ?? Math.random;
    const effects = this.deps.effects;
    const admission = admitTask(request.task, request.policy, registry, { externalWrites: effects ? "defer" : "deny" });
    if (!admission.ok) return { admitted: false, issues: admission.issues };
    const { task, policy } = admission;
    if (saved?.phase === "terminal") {
      if (!isTerminal(saved.run.status)) throw new Error(`terminal checkpoint for ${saved.dispatchId} is not terminal`);
      return {
        admitted: true,
        run: RunSchema.parse(saved.run),
        events: structuredClone(saved.events),
        evaluation: saved.evaluation ? structuredClone(saved.evaluation) : null,
      };
    }

    const budget = effectiveBudget(task, policy);
    const runId = saved ? saved.run.id : ids.next("run");
    const events: RunEvent[] = saved ? structuredClone(saved.events) : [];
    const system: Actor = { kind: "system", id: "reference-runner" };
    const modelActor: Actor = { kind: "model", id: model.config.model };
    const createdAt = saved ? new Date(saved.run.timestamps.createdAt) : clock.now();
    const before = saved ? structuredClone(saved.before) : workspace.snapshot();
    let evaluation: EvaluationResult | null = saved?.evaluation ?? null;
    let plan: Plan | null = saved?.plan ?? null;
    const observations: Observation[] = saved ? structuredClone(saved.observations) : [];
    let denials = saved?.denials ?? 0;
    let executionFinished = saved?.executionFinished ?? false;
    let cards: MemoryCard[] = saved ? structuredClone(saved.cards) : [];
    let memoryBlock = saved?.memoryBlock ?? "";

    const run: Run = saved
      ? structuredClone(saved.run)
      : {
          id: runId,
          taskId: task.id,
          status: "CREATED",
          policyId: task.policyId,
          policyVersion: task.policyVersion,
          modelConfig: model.config,
          promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
          toolRegistryVersion: registry.version,
          retrievalSnapshot: { mode: "disabled", indexVersion: null },
          configArm: policy.memoryRules.retrievalEnabled && this.deps.memory ? "B" : "A",
          ...(request.experiment ? { experimentId: request.experiment.experimentId, trialIndex: request.experiment.trialIndex } : {}),
          workspaceRef: workspace.ref,
          startWorkspaceHash: workspace.hash(),
          endWorkspaceHash: null,
          budget,
          steps: 0,
          cost: { inputTokens: 0, outputTokens: 0, usd: 0, wallMs: 0 },
          learningCost: { reflectionTokens: 0, gateTokens: 0 },
          playbookVersion: null,
          memoryContext: [],
          evalSplit: task.split ?? "none",
          timestamps: { createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(), endedAt: null },
          outcome: null,
          outcomeReason: null,
        };

    const emit = <T extends RunEventType>(
      type: T,
      actor: Actor,
      payload: EventOf<T>["redactedPayload"],
      extra: { idempotencyKey?: string; artifactRef?: string } = {},
    ): RunEvent => {
      const event = EventSchema.parse({
        id: ids.next("evt"),
        runId,
        sequence: events.length + 1,
        actor,
        timestamp: clock.now().toISOString(),
        type,
        redactedPayload: payload,
        ...extra,
      });
      events.push(event);
      sink?.append(event);
      run.timestamps.updatedAt = event.timestamp;
      return event;
    };

    const moveTo = (to: RunState, reason: string): RunEvent => {
      assertTransition(run.status, to);
      const event = emit("state_transition", system, { from: run.status, to, reason });
      run.status = to;
      return event;
    };

    const stop = (state: TerminalState, outcome: RunOutcome, reason: OutcomeReason, detail: string): void => {
      const event = moveTo(state, `${reason}: ${detail}`.slice(0, 300));
      run.outcome = outcome;
      run.outcomeReason = reason;
      run.timestamps.endedAt = event.timestamp;
    };

    const throwIfCancelled = (): void => {
      if (request.signal?.aborted) {
        const shutdown = request.signal.reason === "shutdown";
        throw new Stop("CANCELLED", "cancelled", shutdown ? "shutdown" : "user_cancel", shutdown ? "process shutting down" : "cancellation requested");
      }
      if (execution?.isCancelled()) throw new Stop("CANCELLED", "cancelled", "user_cancel", "cancellation requested");
    };

    const checkLimits = (): void => {
      run.cost.wallMs = Math.max(0, clock.now().getTime() - createdAt.getTime());
      throwIfCancelled();
      if (run.steps >= budget.maxSteps) throw new Stop("FAILED", "failed", "step_limit", `step limit ${budget.maxSteps} reached`);
      if (run.cost.usd > budget.maxUsd) throw new Stop("FAILED", "failed", "budget_exhausted", "cost budget exhausted");
      if (run.cost.wallMs > budget.maxWallMinutes * 60_000) throw new Stop("FAILED", "failed", "budget_exhausted", "wall-clock budget exhausted");
    };

    const capture = (phase: CheckpointPhase): RunCheckpoint => ({
      version: 1,
      dispatchId: execution?.dispatchId ?? "",
      phase,
      run: structuredClone(run),
      events: structuredClone(events),
      evaluation: evaluation ? structuredClone(evaluation) : null,
      before: structuredClone(before),
      workspace: workspace.snapshot(),
      plan,
      observations: structuredClone(observations),
      denials,
      executionFinished,
      cards: structuredClone(cards),
      memoryBlock,
    });

    // No await on the memory-off path: awaiting a resolved promise would yield, and the baseline trace
    // is defined by how many times the stepping clock is read, not by microtasks.
    const persist = (phase: CheckpointPhase): Promise<void> | void => {
      if (!execution) return;
      if (phase === "evaluated") executionFinished = true;
      return execution.save(capture(phase));
    };

    /** One model call with the §7.8 provider and timeout retries; each retry is budget-checked and traced. */
    const invoke = async (stage: "plan" | "step", call: () => Promise<ModelResponse>): Promise<ModelResponse> => {
      let providerRetries = 0;
      let timeoutRetries = 0;
      for (;;) {
        checkLimits();
        try {
          return await withTimeout(call(), modelTimeoutMs);
        } catch (error) {
          if (error instanceof TimedOut) {
            if (timeoutRetries >= MAX_TIMEOUT_RETRIES) {
              throw new Stop("INCONCLUSIVE", "inconclusive", "model_unavailable", `${stage} call timed out after ${modelTimeoutMs} ms, twice`);
            }
            emit("model_retry", modelActor, { stage, cause: "timeout", retry: ++timeoutRetries, delayMs: 0 });
          } else if (error instanceof ModelUnavailableError) {
            if (providerRetries >= PROVIDER_BACKOFF_MS.length) {
              throw new Stop("INCONCLUSIVE", "inconclusive", "model_unavailable", `provider failed ${providerRetries + 1} times: ${error.message}`);
            }
            const delayMs = Math.round(PROVIDER_BACKOFF_MS[providerRetries] * (1 - JITTER + 2 * JITTER * random()));
            emit("model_retry", modelActor, { stage, cause: "provider_error", retry: ++providerRetries, delayMs });
            await sleep(delayMs);
          } else throw error;
        }
      }
    };

    /** Calls the model, validates its output at the boundary, and re-prompts once with the validation error. */
    const callModel = async <S extends z.ZodType>(
      stage: "plan" | "step",
      schema: S,
      call: (validationError?: string) => Promise<ModelResponse>,
    ): Promise<z.output<S>> => {
      let validationError: string | undefined;
      for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt++) {
        const response = await invoke(stage, () => call(validationError));
        run.cost.inputTokens += response.usage.inputTokens;
        run.cost.outputTokens += response.usage.outputTokens;
        run.cost.usd += response.usage.usd;
        const parsed = schema.safeParse(response.output);
        if (parsed.success) return parsed.data;
        const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "output"}: ${i.message}`).slice(0, 5);
        emit("model_output_invalid", modelActor, { stage, attempt, issues });
        validationError = issues.join("; ");
      }
      throw new Stop("FAILED", "failed", "malformed_model_output", `${stage} output failed validation twice`);
    };

    /** Reflection, gate and writeback for a verified run (PRD §7.6, §7.7, §12.2). */
    const learn = async (memory: MemoryRuntime, evaluated: EvaluationResult): Promise<void> => {
      const live = new LiveRecords(memory.records, {
        task,
        run,
        events,
        evaluation: evaluated,
        append: (event) => {
          const valid = EventSchema.parse(event);
          events.push(valid);
          sink?.append(valid);
          run.timestamps.updatedAt = valid.timestamp;
        },
      });
      const retention = memory.retention ?? PROPOSED_RETENTION;
      const service = new MemoryService(memory.repository, live, clock, ids, retention);
      const gate = new WriteGate({ records: live, repo: memory.repository, embedder: memory.embedder, judge: memory.judge, clock }, memory.gate);
      const indexVersion = memory.retrieval?.indexVersion ?? "mem-index-1";
      const writeback = new MemoryWriteback({ service, gate, embedder: memory.embedder, indexVersion, tenantId: task.tenantId });
      const autoApprove = policy.memoryRules.autoApprove ?? ["episodic"];
      const reflectorActor: Actor = { kind: "model", id: memory.reflector?.config.model ?? "reflector" };

      let reflection: ReturnType<typeof parseReflection> | null = null;
      if (memory.reflector) {
        let validationError: string | undefined;
        try {
          for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt++) {
            const response = await memory.reflector.reflect({ task, run: structuredClone(run), evaluation: evaluated, events: structuredClone(events), validationError });
            run.learningCost.reflectionTokens += response.usage.inputTokens + response.usage.outputTokens;
            reflection = parseReflection(response.output, evaluated);
            if (reflection.ok) break;
            emit("model_output_invalid", reflectorActor, { stage: "reflection", attempt, issues: [reflection.issues] });
            validationError = reflection.issues;
          }
        } catch (error) {
          // PRD §7.8: with the reflector down the run outcome stands; only the automatic episodic record is written.
          if (!(error instanceof ReflectorUnavailableError)) throw error;
          emit("reflection_failed", reflectorActor, { cause: "unavailable", detail: error.message.slice(0, 200) });
          reflection = null;
        }
        if (reflection && !reflection.ok) {
          throw new Stop("FAILED", "failed", "malformed_model_output", "reflection output failed validation twice");
        }
      }

      const candidates = [{ candidate: episodicCandidate({ task, run, evaluation: evaluated }), requiresReview: false }];
      if (reflection?.ok) {
        candidates.push({
          candidate: reflectionCandidate(reflection.reflection, { task, run, evaluation: evaluated }),
          requiresReview: reflection.reflection.requiresReview,
        });
        emit("reflection_recorded", reflectorActor, { reflection: redactReflection(reflection.reflection), candidates: candidates.length });
      }

      for (const { candidate, requiresReview } of candidates) {
        let result: Awaited<ReturnType<MemoryWriteback["persist"]>> | null = null;
        for (let attempt = 1; result === null; attempt++) {
          try {
            result = await writeback.persist(candidate, { autoApprove, requiresReview });
          } catch (error) {
            if (error instanceof FrozenMemoryError) {
              emit("writeback_blocked", system, { reason: "repository_frozen" });
              return;
            }
            if (!(error instanceof RepositoryUnavailableError)) throw error;
            if (attempt >= PERSIST_ATTEMPTS) {
              throw new Stop("INCONCLUSIVE", "inconclusive", "internal_error", `memory store unavailable during persistence after ${PERSIST_ATTEMPTS} attempts`);
            }
          }
        }
        run.learningCost.gateTokens += (result.judgeUsage?.inputTokens ?? 0) + (result.judgeUsage?.outputTokens ?? 0);
        emit("gate_decision", system, { memoryId: result.memoryId, decision: result.decision });
      }
    };

    const accessContext = { task, policy, registry, externalWrite: effects ? ("defer" as const) : ("deny" as const) };

    const drive = async (): Promise<void> => {
      const memory = this.deps.memory;
      const retrievalOn = policy.memoryRules.retrievalEnabled;
      const writebackOn = policy.memoryRules.writebackEnabled;
      if (!saved) {
      moveTo("ADMITTED", "task admitted");
      if ((retrievalOn || writebackOn) && !memory) {
        throw new Stop("BLOCKED", "blocked", "policy_denied", "policy enables memory but this runner is memory-disabled");
      }

      moveTo("RETRIEVING", "retrieval step");
      if (retrievalOn && memory) {
        const retriever = new HybridRetriever(memory.repository, memory.records, memory.embedder, clock, memory.retrieval, memory.retention);
        try {
          const found = await retriever.retrieve(
            {
              tenantId: task.tenantId,
              projectId: task.projectId,
              text: [task.objective, task.taskClass].filter(Boolean).join(" "),
              ...(task.taskClass ? { taskClass: task.taskClass } : {}),
              preconditionHolds: preconditionHolds(workspace),
            },
            { maxCards: policy.memoryRules.maxCards, maxContextTokens: policy.memoryRules.maxContextTokens },
          );
          cards = found.cards;
          memoryBlock = found.context;
          run.retrievalSnapshot = {
            mode: "hybrid",
            indexVersion: found.indexVersion,
            embeddingModel: found.embeddingModel,
            embeddingVersion: found.embeddingVersion,
          };
          run.memoryContext = found.trace.map((t) => ({ memoryId: t.memoryId, version: t.version, rank: t.rank, score: t.score, injected: t.injected }));
          emit("retrieval_recorded", system, {
            indexVersion: found.indexVersion,
            considered: found.considered,
            excluded: found.excluded,
            injected: found.cards.map((c) => ({ memoryId: c.memoryId, version: c.version, rank: c.rank, score: c.score })),
            contextTokens: found.contextTokens,
          });
        } catch (error) {
          // PRD §7.8: with the store or embedder down the run proceeds with no memory, tagged so experiments exclude it.
          if (!(error instanceof RepositoryUnavailableError || error instanceof EmbedderUnavailableError)) throw error;
          run.retrievalSnapshot = { mode: "degraded", indexVersion: null };
          emit("retrieval_degraded", system, { reason: error.message.slice(0, 200) });
        }
      } else emit("retrieval_skipped", system, { reason: "memory_disabled" });

      moveTo("PLANNING", "planning");
      plan = await callModel("plan", PlanSchema, (validationError) =>
        model.plan({
          objective: task.objective,
          mode: task.mode,
          authorizedTools: policy.toolAllowlist,
          ...(cards.length > 0 ? { memory: { cards, context: memoryBlock } } : {}),
          validationError,
        }),
      );
      // INV-02: a plan may cite only memory that was actually injected. Citing it grants nothing; tools are checked below regardless.
      const injected = new Set(cards.map((c) => c.memoryId));
      if (plan.memoryIds.some((id) => !injected.has(id))) {
        throw new Stop(
          "BLOCKED",
          "blocked",
          "policy_denied",
          retrievalOn ? "plan cites memory that was not injected (INV-02)" : "plan cites memory but memory is disabled (INV-02)",
        );
      }
      for (const tool of plan.tools) {
        const access = checkToolAccess(tool, accessContext);
        if ("denial" in access) {
          emit("policy_denied", system, { callId: null, tool: tool.slice(0, 100), ...access.denial });
          const reason = access.denial.reasonCode === "external_write_not_permitted" ? "approval_required_p0" : "policy_denied";
          throw new Stop("BLOCKED", "blocked", reason, `plan needs ${tool}: ${access.denial.reasonCode}`);
        }
        if (!effects && actionRequiresApproval(access.tool, policy.approvalRequirements)) {
          throw new Stop("BLOCKED", "blocked", "approval_required_p0", `plan needs approval for ${tool}, and no approval workflow is configured`);
        }
      }
      emit("plan_recorded", modelActor, { plan });
      // FR-27: every injected memory gets a use record. Whether it was followed and whether it helped is not knowable
      // from one run; explicit feedback (`MemoryService.recordFeedback`) and paired evaluation answer that.
      for (const card of cards) {
        emit("memory_use", system, { memoryId: card.memoryId, citedInPlan: plan.memoryIds.includes(card.memoryId), followed: false, outcomeEffect: "unknown" });
      }

      moveTo("EXECUTING", "executing plan");
      const entered = persist("executing");
      if (entered) await entered;
      }

      if (saved?.phase !== "evaluated") {
      if (!plan) throw new Error(`dispatch ${execution?.dispatchId ?? runId} has no plan to resume`);
      const currentPlan = plan;
      if (!executionFinished) {
      for (let finished = false; !finished; ) {
        checkLimits();
        const call = await callModel("step", ToolCallRequest, (validationError) =>
          model.nextStep({ step: run.steps + 1, plan: currentPlan, observations, validationError }),
        );
        run.steps++;
        const callId = ids.next("call");
        const decision = authorizeToolCall(call, accessContext);

        if (!decision.allowed) {
          emit("policy_denied", modelActor, {
            callId,
            tool: call.tool.slice(0, 100),
            reasonCode: decision.reasonCode,
            detail: decision.detail,
          });
          observations.push({ callId, tool: call.tool, ok: false, text: `denied: ${decision.reasonCode}` });
          if (++denials >= MAX_DENIALS) {
            throw new Stop("BLOCKED", "blocked", "policy_denied", `${MAX_DENIALS} policy denials in one run`);
          }
          const denied = persist("executing");
          if (denied) await denied;
          continue;
        }

        const name = decision.tool.descriptor.name;
        const argsSummary = JSON.stringify(decision.args).slice(0, 200);
        if (!effects && actionRequiresApproval(decision.tool, policy.approvalRequirements)) {
          throw new Stop("BLOCKED", "blocked", "approval_required_p0", `${name} requires approval, and no approval workflow is configured`);
        }

        let output: ToolOutput;
        let infraFailure: InfraFailureError | null = null;
        let effectKeyForEvent: string | undefined;
        let startedMs: number;
        if (effects) {
          let approvalId: string | null = null;
          if (actionRequiresApproval(decision.tool, policy.approvalRequirements)) {
            const idempotencyKey = effectKey(runId, run.steps, name, decision.args).key;
            const approval = effects.approvals.request({
              runId,
              taskId: task.id,
              step: run.steps,
              tool: name,
              argsSummary,
              idempotencyKey,
              scope: {
                tenantId: task.tenantId,
                projectId: task.projectId,
                repo: task.scope.repo,
                commit: task.scope.commit,
                ...(task.scope.paths ? { paths: [...task.scope.paths] } : {}),
              },
              requestedBy: task.requestedBy,
            });
            approvalId = approval.id;
            moveTo("AWAITING_APPROVAL", `approval required for ${name}`);
            try {
              const resolved = await effects.approvals.wait(approval.id, request.signal);
              if (resolved.status !== "approved") {
                const reason = resolved.status === "expired" ? "approval_expired" : "approval_denied";
                throw new Stop("BLOCKED", "blocked", reason, resolved.reason ?? reason);
              }
              moveTo("EXECUTING", `approval granted by ${resolved.decidedBy} for ${name}`);
              checkLimits();
            } catch (error) {
              if (error instanceof ApprovalAborted) {
                effects.approvals.failClosed(approval.id, "run cancelled while awaiting approval");
                const shutdown = request.signal?.reason === "shutdown";
                throw new Stop(
                  "CANCELLED",
                  "cancelled",
                  shutdown ? "shutdown" : "user_cancel",
                  shutdown ? "process shutting down" : "cancellation requested",
                );
              }
              throw error;
            }
          }

          startedMs = clock.now().getTime();
          const dispatched = await dispatchEffect({
            runId,
            step: run.steps,
            tool: decision.tool,
            args: decision.args,
            ctx: { workspace, scope: task.scope, commands, artifacts },
            ledger: effects.ledger,
            grants: effects.approvals.store,
            approvalId,
            approvalMarks: policy.approvalRequirements,
            clock,
            timeoutMs: decision.tool.descriptor.timeoutMs,
          });
          if (dispatched.kind === "blocked") {
            const reason =
              dispatched.reason === "approval_expired" ? "approval_expired" : dispatched.reason === "approval_denied" ? "approval_denied" : "approval_required_p0";
            throw new Stop("BLOCKED", "blocked", reason, `unapproved ${name}: ${dispatched.reason}`);
          }
          if (dispatched.kind === "replayed") {
            output = dispatched.output ?? { ok: false, summary: `effect ${dispatched.state}`, observation: "not executed again" };
            effectKeyForEvent = dispatched.key;
          } else {
            output = dispatched.output;
            infraFailure = dispatched.infraFailure;
            effectKeyForEvent = dispatched.key ?? undefined;
          }
          emit("tool_authorized", modelActor, { callId, tool: name, argsSummary });
        } else {
          emit("tool_authorized", modelActor, { callId, tool: name, argsSummary });
          startedMs = clock.now().getTime();
          try {
            output = await withTimeout(
              decision.tool.execute(decision.args, { workspace, scope: task.scope, commands, artifacts }),
              decision.tool.descriptor.timeoutMs,
            );
          } catch (error) {
            if (error instanceof RunHandoff) throw error;
            if (error instanceof InfraFailureError) infraFailure = error;
            output =
              error instanceof InfraFailureError
                ? { ok: false, summary: "sandbox unavailable", observation: error.message }
                : error instanceof TimedOut
                  ? { ok: false, summary: "tool timed out", observation: `${name} timed out after ${decision.tool.descriptor.timeoutMs} ms` }
                  : { ok: false, summary: "tool raised an error", observation: error instanceof Error ? error.message : "tool error" };
          }
          effectKeyForEvent = decision.tool.descriptor.sideEffect === "read_only" ? undefined : `${runId}:${callId}`;
        }
        const durationMs = Math.max(0, clock.now().getTime() - startedMs);
        const key = effectKeyForEvent;
        emit(
          "tool_result",
          { kind: "tool", id: name },
          { callId, tool: name, ok: output.ok, summary: output.summary, durationMs, ...(output.exitStatus !== undefined ? { exitStatus: output.exitStatus } : {}) },
          { ...(key ? { idempotencyKey: key } : {}), ...(output.artifactRef ? { artifactRef: output.artifactRef } : {}) },
        );
        if (infraFailure) throw new Stop("INCONCLUSIVE", "inconclusive", "infra_failure", infraFailure.message);
        observations.push({ callId, tool: name, ok: output.ok, text: output.observation });
        finished = decision.tool.descriptor.endsExecution;
        if (finished) executionFinished = true;
        const stepped = persist("executing");
        if (stepped) await stepped;
      }
      }
      throwIfCancelled();

      moveTo("EVALUATING", "execution ended");
      const evaluated = EvaluationSchema.parse(
        evaluator.evaluate({
          evaluationId: ids.next("eval"),
          runId,
          task,
          workspace,
          before,
          completedAt: clock.now(),
        }),
      );
      evaluation = evaluated;
      emit("evaluation_recorded", { kind: "evaluator", id: evaluator.version }, { evaluationId: evaluation.id, verdict: evaluation.verdict });
      if (evaluation.outcomeReason === "evaluator_tamper_suspected") {
        emit(
          "evaluator_tamper_flag",
          { kind: "evaluator", id: evaluator.version },
          {
            evaluationId: evaluation.id,
            touchedProtectedPaths: evaluation.touchedProtectedPaths,
            signals: evaluation.evidenceRefs.filter((ref) => ref.startsWith("tamper:")),
          },
        );
      }

      if (evaluation.verdict === "inconclusive") {
        throw new Stop("INCONCLUSIVE", "inconclusive", evaluation.outcomeReason, "evaluation could not decide");
      }
      const evaluatedCheckpoint = persist("evaluated");
      if (evaluatedCheckpoint) await evaluatedCheckpoint;
      }

      if (!evaluation) throw new Error(`dispatch ${execution?.dispatchId ?? runId} resumed without an evaluation`);
      const evaluated = evaluation;
      throwIfCancelled();
      moveTo("REFLECTING", "reflection step");
      if (!memory || !writebackOn) {
        emit("reflection_skipped", system, { reason: retrievalOn ? "writeback_disabled" : "memory_disabled" });
      } else if (task.split === "test") {
        // FR-28, PRD §12.3: the held-out test split never writes. Refused here and, for a frozen repository, again below.
        emit("writeback_blocked", system, { reason: "frozen_test_split" });
        emit("reflection_skipped", system, { reason: "writeback_disabled" });
      } else {
        await learn(memory, evaluated);
      }
      stop("COMPLETE", evaluation.verdict, evaluation.outcomeReason, "evaluation recorded");
    };

    if (!saved) emit("state_transition", system, { from: null, to: "CREATED", reason: "run created" });
    try {
      await drive();
    } catch (error) {
      if (error instanceof RunHandoff) throw error;
      if (isTerminal(run.status)) throw error;
      if (error instanceof Stop) stop(error.state, error.outcome, error.reason, error.detail);
      else stop("FAILED", "failed", "internal_error", error instanceof Error ? error.message : "unknown error");
    }

    run.endWorkspaceHash = workspace.hash();
    const parsed = RunSchema.parse(run);
    const terminal = persist("terminal");
    if (terminal) await terminal;
    return { admitted: true, run: parsed, events, evaluation };
  }
}
