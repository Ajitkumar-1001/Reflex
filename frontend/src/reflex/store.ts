import { EvaluationSchema, EventSchema, MemoryRecordSchema, PolicySchema, RunSchema, TaskSchema } from "./contracts";
import type { EvaluationResult, MemoryRecord, Policy, Run, RunEvent, Task } from "./contracts";
import { FrozenMemoryError, StaleVersionError } from "./ports";
import type { MemoryFilter, MemoryRepository, RunRecords } from "./ports";

/*
 * In-memory stand-in for the six Atlas collections (PRD §10; the Atlas client is blocked on DEC-08). It enforces
 * the unique indexes the PRD names (`(run_id, sequence)` on events, `(experiment_id, config_arm, task_id,
 * trial_index)` on runs, `(policy_id, version)` on policies) and the `(tenant_id, project_id, …)` pre-filter on
 * memories. Every document is validated on the way in and copied on the way out.
 */

const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly records = new Map<string, MemoryRecord>();

  async insert(record: MemoryRecord): Promise<void> {
    const valid = MemoryRecordSchema.parse(record);
    if (this.records.has(valid.id)) throw new Error(`duplicate memory id ${valid.id}`);
    this.records.set(valid.id, copy(valid));
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    const found = this.records.get(id);
    return found && copy(found);
  }

  async find(filter: MemoryFilter): Promise<MemoryRecord[]> {
    return [...this.records.values()]
      .filter(
        (m) =>
          m.tenantId === filter.tenantId &&
          m.projectId === filter.projectId &&
          (filter.lifecycleStates === undefined || filter.lifecycleStates.includes(m.lifecycleState)) &&
          (filter.kinds === undefined || filter.kinds.includes(m.kind)),
      )
      .map(copy);
  }

  async replace(next: MemoryRecord, expectedVersion: number): Promise<void> {
    const valid = MemoryRecordSchema.parse(next);
    const current = this.records.get(valid.id);
    if (!current) throw new Error(`no such memory ${valid.id}`);
    if (current.version !== expectedVersion || valid.version !== expectedVersion + 1) {
      throw new StaleVersionError(`memory ${valid.id} is at version ${current.version}, not ${expectedVersion}`);
    }
    this.records.set(valid.id, copy(valid));
  }
}

/** Read-only view for the frozen arm of an experiment (PRD §12.3, FR-28): reads pass through, writes throw. */
export class FrozenMemoryRepository implements MemoryRepository {
  constructor(private readonly inner: MemoryRepository) {}

  insert(): Promise<void> {
    throw new FrozenMemoryError();
  }

  replace(): Promise<void> {
    throw new FrozenMemoryError();
  }

  get(id: string): Promise<MemoryRecord | undefined> {
    return this.inner.get(id);
  }

  find(filter: MemoryFilter): Promise<MemoryRecord[]> {
    return this.inner.find(filter);
  }
}

export interface RecordedRun {
  task: Task;
  policy: Policy;
  run: Run;
  events: readonly RunEvent[];
  evaluation: EvaluationResult | null;
}

export class InMemoryStore implements RunRecords {
  readonly memories = new InMemoryMemoryRepository();
  private readonly tasks = new Map<string, Task>();
  private readonly runs = new Map<string, Run>();
  private readonly evaluations = new Map<string, EvaluationResult>();
  private readonly policies = new Map<string, Policy>();
  private readonly events = new Map<string, RunEvent[]>();

  /** Persists a finished run with its task, policy, evaluation and trace, as one unit. */
  recordRun({ task, policy, run, events, evaluation }: RecordedRun): void {
    const validRun = RunSchema.parse(run);
    if (this.runs.has(validRun.id)) throw new Error(`duplicate run id ${validRun.id}`);
    if (validRun.experimentId !== undefined) {
      const clash = [...this.runs.values()].find(
        (r) =>
          r.experimentId === validRun.experimentId &&
          r.configArm === validRun.configArm &&
          r.taskId === validRun.taskId &&
          r.trialIndex === validRun.trialIndex,
      );
      if (clash) throw new Error(`run ${clash.id} already holds experiment slot ${validRun.experimentId}/${validRun.configArm}/${validRun.taskId}/${validRun.trialIndex}`);
    }
    const parsedEvents = events.map((e) => EventSchema.parse(e));
    parsedEvents.forEach((e, i) => {
      if (e.runId !== validRun.id || e.sequence !== i + 1) throw new Error(`event ${e.id} breaks the (run_id, sequence) index`);
    });
    this.tasks.set(task.id, copy(TaskSchema.parse(task)));
    this.policies.set(`${policy.id}@${policy.version}`, copy(PolicySchema.parse(policy)));
    this.runs.set(validRun.id, copy(validRun));
    this.events.set(validRun.id, copy(parsedEvents));
    if (evaluation) this.evaluations.set(evaluation.id, copy(EvaluationSchema.parse(evaluation)));
  }

  async getTask(id: string): Promise<Task | undefined> {
    const found = this.tasks.get(id);
    return found && copy(found);
  }

  async getRun(id: string): Promise<Run | undefined> {
    const found = this.runs.get(id);
    return found && copy(found);
  }

  async getEvaluation(id: string): Promise<EvaluationResult | undefined> {
    const found = this.evaluations.get(id);
    return found && copy(found);
  }

  async getPolicy(id: string, version: number): Promise<Policy | undefined> {
    const found = this.policies.get(`${id}@${version}`);
    return found && copy(found);
  }

  async getEvents(runId: string): Promise<readonly RunEvent[]> {
    return copy(this.events.get(runId) ?? []);
  }

  async nextSequence(runId: string): Promise<number> {
    return (this.events.get(runId)?.length ?? 0) + 1;
  }

  async appendEvent(event: RunEvent): Promise<void> {
    const valid = EventSchema.parse(event);
    const trace = this.events.get(valid.runId);
    if (!trace) throw new Error(`no such run ${valid.runId}`);
    if (valid.sequence !== trace.length + 1) throw new Error(`event ${valid.id} breaks the (run_id, sequence) index`);
    trace.push(copy(valid));
  }

  /** Per run, the last quarantine event stamped on its own trace decides (quarantine and restore are both appended there). */
  async quarantinedRunIds(): Promise<ReadonlySet<string>> {
    const held = new Set<string>();
    for (const [runId, trace] of this.events) {
      let quarantined = false;
      for (const e of trace) {
        if (e.type === "quarantine_recorded" && e.redactedPayload.runIds.includes(runId)) quarantined = !e.redactedPayload.restored;
      }
      if (quarantined) held.add(runId);
    }
    return held;
  }

  /** Runs of one task, oldest first. */
  async runsOfTask(taskId: string): Promise<Run[]> {
    return [...this.runs.values()].filter((r) => r.taskId === taskId).map(copy);
  }

  async allRuns(): Promise<Run[]> {
    return [...this.runs.values()].map(copy);
  }
}
