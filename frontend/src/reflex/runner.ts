import {
  EvaluationSchema,
  EventSchema,
  PlanSchema,
  PolicySchema,
  RunSchema,
  TaskSchema,
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
import { authorizeToolCall, checkToolAccess } from "./permission";
import type { ToolRegistry } from "./permission";
import { ModelUnavailableError } from "./ports";
import type {
  AdmissionIssue,
  CheckSet,
  Clock,
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
const RISK_RANK = { low: 0, medium: 1, high: 2 } as const;

// ----------------------------------------------------------------- admission

export type Admission = { ok: true; task: Task; policy: Policy } | { ok: false; issues: AdmissionIssue[] };

/** FR-01: typed admission. Anything unknown, unregistered or over-privileged is rejected (INV-08). */
export function admitTask(taskInput: unknown, policyInput: unknown, registry: ToolRegistry): Admission {
  const issues: AdmissionIssue[] = [];
  const task = TaskSchema.safeParse(taskInput);
  const policy = PolicySchema.safeParse(policyInput);
  if (!task.success) {
    issues.push(...task.error.issues.map((i) => ({ code: "invalid_task", message: `${i.path.join(".") || "task"}: ${i.message}` })));
  }
  if (!policy.success) {
    issues.push(...policy.error.issues.map((i) => ({ code: "invalid_policy", message: `${i.path.join(".") || "policy"}: ${i.message}` })));
  }
  if (!task.success || !policy.success) return { ok: false, issues };

  const t = task.data;
  const p = policy.data;
  if (t.policy.id !== p.id || t.policy.version !== p.version) {
    issues.push({ code: "policy_mismatch", message: `task pins ${t.policy.id}@${t.policy.version}, got ${p.id}@${p.version}` });
  }
  if (p.status !== "ACTIVE") issues.push({ code: "policy_not_active", message: `policy status is ${p.status}` });
  if (RISK_RANK[t.riskClass] > RISK_RANK[p.riskClass]) {
    issues.push({ code: "risk_exceeds_policy", message: `task risk ${t.riskClass} exceeds policy risk ${p.riskClass}` });
  }
  for (const tool of t.authorizedTools) {
    const access = checkToolAccess(tool, { task: t, policy: p, registry });
    if ("denial" in access) issues.push({ code: access.denial.reasonCode, message: access.denial.detail });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, task: t, policy: p };
}

function effectiveBudget(task: Task, policy: Policy): Budget {
  return {
    maxSteps: Math.min(task.budget.maxSteps, policy.budgets.maxSteps),
    maxWallMs: Math.min(task.budget.maxWallMs, policy.budgets.maxWallMs),
    maxUsd: Math.min(task.budget.maxUsd, policy.budgets.maxUsd),
  };
}

// -------------------------------------------------------------------- runner

export interface RunnerDeps {
  model: ModelAdapter;
  registry: ToolRegistry;
  evaluator: Evaluator;
  /** Fresh per run: the runner mutates it through tools. */
  workspace: Workspace;
  checks: CheckSet;
  clock: Clock;
  ids: IdGenerator;
  sink?: EventSink;
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
    const { model, registry, evaluator, workspace, checks, clock, ids, sink } = this.deps;
    const admission = admitTask(request.task, request.policy, registry);
    if (!admission.ok) return { admitted: false, issues: admission.issues };
    const { task, policy } = admission;

    const budget = effectiveBudget(task, policy);
    const runId = ids.next("run");
    const events: RunEvent[] = [];
    const system: Actor = { kind: "system", id: "reference-runner" };
    const modelActor: Actor = { kind: "model", id: model.config.model };
    const createdAt = clock.now();
    let evaluation: EvaluationResult | null = null;

    const run: Run = {
      id: runId,
      taskId: task.id,
      status: "CREATED",
      policy: task.policy,
      modelConfig: model.config,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      toolRegistryVersion: registry.version,
      retrievalSnapshot: { mode: "disabled", indexVersion: null },
      configArm: "A",
      workspaceRef: workspace.ref,
      startWorkspaceHash: workspace.hash(),
      endWorkspaceHash: null,
      budget,
      ledger: { steps: 0, usd: 0, wallMs: 0 },
      timestamps: { createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(), endedAt: null },
      outcome: null,
      outcomeReason: null,
    };

    const emit = <T extends RunEventType>(
      type: T,
      actor: Actor,
      payload: EventOf<T>["redactedPayload"],
      idempotencyKey?: string,
    ): RunEvent => {
      const event = EventSchema.parse({
        id: ids.next("evt"),
        runId,
        sequence: events.length + 1,
        actor,
        timestamp: clock.now().toISOString(),
        type,
        redactedPayload: payload,
        ...(idempotencyKey ? { idempotencyKey } : {}),
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
      run.ledger.wallMs = Math.max(0, clock.now().getTime() - createdAt.getTime());
      if (request.signal?.aborted) throw new Stop("CANCELLED", "cancelled", "user_cancel", "cancellation requested");
      if (run.ledger.steps >= budget.maxSteps) throw new Stop("FAILED", "failed", "step_limit", `step limit ${budget.maxSteps} reached`);
      if (run.ledger.usd > budget.maxUsd) throw new Stop("FAILED", "failed", "budget_exhausted", "cost budget exhausted");
      if (run.ledger.wallMs > budget.maxWallMs) throw new Stop("FAILED", "failed", "budget_exhausted", "wall-clock budget exhausted");
    };

    /** Calls the model, validates its output at the boundary, and re-prompts once with the validation error. */
    const callModel = async <S extends z.ZodType>(
      stage: "plan" | "step",
      schema: S,
      call: (validationError?: string) => Promise<ModelResponse>,
    ): Promise<z.output<S>> => {
      let validationError: string | undefined;
      for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt++) {
        checkLimits();
        const response = await call(validationError);
        run.ledger.usd += response.usage.usd;
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
        model.plan({ objective: task.objective, mode: task.mode, authorizedTools: task.authorizedTools, validationError }),
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
          model.nextStep({ step: run.ledger.steps + 1, plan, observations, validationError }),
        );
        run.ledger.steps++;
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
        try {
          output = await decision.tool.execute(decision.args, { workspace, checks });
        } catch (error) {
          output = { ok: false, summary: "tool raised an error", observation: error instanceof Error ? error.message : "tool error" };
        }
        const durationMs = Math.max(0, clock.now().getTime() - startedMs);
        const key = decision.tool.descriptor.sideEffect === "read_only" ? undefined : `${runId}:${callId}`;
        emit("tool_result", { kind: "tool", id: name }, { callId, tool: name, ok: output.ok, summary: output.summary, durationMs }, key);
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
          completedAt: clock.now(),
        }),
      );
      emit("evaluation_recorded", { kind: "evaluator", id: evaluator.version }, { evaluationId: evaluation.id, verdict: evaluation.verdict });

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
      else if (error instanceof ModelUnavailableError) stop("INCONCLUSIVE", "inconclusive", "model_unavailable", error.message);
      else stop("FAILED", "failed", "internal_error", error instanceof Error ? error.message : "unknown error");
    }

    run.endWorkspaceHash = workspace.hash();
    return { admitted: true, run: RunSchema.parse(run), events, evaluation };
  }
}
