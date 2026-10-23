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
import { authorizeToolCall, checkToolAccess } from "./permission";
import type { ToolRegistry } from "./permission";
import { InfraFailureError, ModelUnavailableError } from "./ports";
import type {
  ArtifactStore,
  Clock,
  CommandTable,
  EventSink,
  Evaluator,
  IdGenerator,
  ModelAdapter,
  ModelResponse,
  Observation,
  RunEngine,
  RunRequest,
  RunResult,
  ToolOutput,
  Workspace,
} from "./ports";
import type { z } from "zod";

/*
 * Phase 0 reference runner: a minimal in-process, memory-disabled executor behind the
 * RunEngine interface. It is the Phase 0 baseline, NOT the DEC-01 orchestration decision,
 * and it is non-durable: a process crash loses the run and nothing resumes it.
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
}

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
    const modelTimeoutMs = this.deps.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const random = this.deps.random ?? Math.random;
    const admission = admitTask(request.task, request.policy, registry);
    if (!admission.ok) return { admitted: false, issues: admission.issues };
    const { task, policy } = admission;

    const budget = effectiveBudget(task, policy);
    const runId = ids.next("run");
    const events: RunEvent[] = [];
    const system: Actor = { kind: "system", id: "reference-runner" };
    const modelActor: Actor = { kind: "model", id: model.config.model };
    const createdAt = clock.now();
    const before = workspace.snapshot();
    let evaluation: EvaluationResult | null = null;

    const run: Run = {
      id: runId,
      taskId: task.id,
      status: "CREATED",
      policyId: task.policyId,
      policyVersion: task.policyVersion,
      modelConfig: model.config,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      toolRegistryVersion: registry.version,
      retrievalSnapshot: { mode: "disabled", indexVersion: null },
      configArm: "A",
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

    const checkLimits = (): void => {
      run.cost.wallMs = Math.max(0, clock.now().getTime() - createdAt.getTime());
      if (request.signal?.aborted) throw new Stop("CANCELLED", "cancelled", "user_cancel", "cancellation requested");
      if (run.steps >= budget.maxSteps) throw new Stop("FAILED", "failed", "step_limit", `step limit ${budget.maxSteps} reached`);
      if (run.cost.usd > budget.maxUsd) throw new Stop("FAILED", "failed", "budget_exhausted", "cost budget exhausted");
      if (run.cost.wallMs > budget.maxWallMinutes * 60_000) throw new Stop("FAILED", "failed", "budget_exhausted", "wall-clock budget exhausted");
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

    const drive = async (): Promise<void> => {
      moveTo("ADMITTED", "task admitted");
      if (policy.memoryRules.retrievalEnabled || policy.memoryRules.writebackEnabled) {
        throw new Stop("BLOCKED", "blocked", "policy_denied", "policy enables memory but this runner is memory-disabled");
      }

      moveTo("RETRIEVING", "retrieval step");
      emit("retrieval_skipped", system, { reason: "memory_disabled" });

      moveTo("PLANNING", "planning");
      const plan: Plan = await callModel("plan", PlanSchema, (validationError) =>
        model.plan({ objective: task.objective, mode: task.mode, authorizedTools: policy.toolAllowlist, validationError }),
      );
      if (plan.memoryIds.length > 0) {
        throw new Stop("BLOCKED", "blocked", "policy_denied", "plan cites memory but memory is disabled (INV-02)");
      }
      for (const tool of plan.tools) {
        const access = checkToolAccess(tool, { task, policy, registry });
        if ("denial" in access) {
          emit("policy_denied", system, { callId: null, tool: tool.slice(0, 100), ...access.denial });
          const reason = access.denial.reasonCode === "external_write_not_permitted" ? "approval_required_p0" : "policy_denied";
          throw new Stop("BLOCKED", "blocked", reason, `plan needs ${tool}: ${access.denial.reasonCode}`);
        }
      }
      emit("plan_recorded", modelActor, { plan });

      moveTo("EXECUTING", "executing plan");
      const observations: Observation[] = [];
      let denials = 0;
      for (let finished = false; !finished; ) {
        checkLimits();
        const call = await callModel("step", ToolCallRequest, (validationError) =>
          model.nextStep({ step: run.steps + 1, plan, observations, validationError }),
        );
        run.steps++;
        const callId = ids.next("call");
        const decision = authorizeToolCall(call, { task, policy, registry });

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
          continue;
        }

        const name = decision.tool.descriptor.name;
        emit("tool_authorized", modelActor, { callId, tool: name, argsSummary: JSON.stringify(call.args).slice(0, 200) });
        const startedMs = clock.now().getTime();
        let output: ToolOutput;
        let infraFailure: InfraFailureError | null = null;
        try {
          output = await withTimeout(
            decision.tool.execute(decision.args, { workspace, scope: task.scope, commands, artifacts }),
            decision.tool.descriptor.timeoutMs,
          );
        } catch (error) {
          if (error instanceof InfraFailureError) infraFailure = error;
          output =
            error instanceof InfraFailureError
              ? { ok: false, summary: "sandbox unavailable", observation: error.message }
              : error instanceof TimedOut
              ? { ok: false, summary: "tool timed out", observation: `${name} timed out after ${decision.tool.descriptor.timeoutMs} ms` }
              : { ok: false, summary: "tool raised an error", observation: error instanceof Error ? error.message : "tool error" };
        }
        const durationMs = Math.max(0, clock.now().getTime() - startedMs);
        const key = decision.tool.descriptor.sideEffect === "read_only" ? undefined : `${runId}:${callId}`;
        emit(
          "tool_result",
          { kind: "tool", id: name },
          { callId, tool: name, ok: output.ok, summary: output.summary, durationMs, ...(output.exitStatus !== undefined ? { exitStatus: output.exitStatus } : {}) },
          { ...(key ? { idempotencyKey: key } : {}), ...(output.artifactRef ? { artifactRef: output.artifactRef } : {}) },
        );
        if (infraFailure) throw new Stop("INCONCLUSIVE", "inconclusive", "infra_failure", infraFailure.message);
        observations.push({ callId, tool: name, ok: output.ok, text: output.observation });
        finished = decision.tool.descriptor.endsExecution;
      }

      moveTo("EVALUATING", "execution ended");
      evaluation = EvaluationSchema.parse(
        evaluator.evaluate({
          evaluationId: ids.next("eval"),
          runId,
          task,
          workspace,
          before,
          completedAt: clock.now(),
        }),
      );
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
      moveTo("REFLECTING", "reflection step");
      emit("reflection_skipped", system, { reason: "memory_disabled" });
      stop("COMPLETE", evaluation.verdict, evaluation.outcomeReason, "evaluation recorded");
    };

    emit("state_transition", system, { from: null, to: "CREATED", reason: "run created" });
    try {
      await drive();
    } catch (error) {
      if (isTerminal(run.status)) throw error;
      if (error instanceof Stop) stop(error.state, error.outcome, error.reason, error.detail);
      else stop("FAILED", "failed", "internal_error", error instanceof Error ? error.message : "unknown error");
    }

    run.endWorkspaceHash = workspace.hash();
    return { admitted: true, run: RunSchema.parse(run), events, evaluation };
  }
}
