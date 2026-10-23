import type { EvaluationResult, Run, RunEvent, Task } from "./contracts";
import type { RunRecords } from "./ports";

/**
 * Read overlay for the run that is still executing. The gate checks provenance against stored records, but the
 * run that produced a lesson is not stored until it ends; this exposes its in-flight task, run, evaluation and
 * trace as if it were, and routes audit events for it back into its own trace. Everything else is the base store.
 */
export class LiveRecords implements RunRecords {
  constructor(
    private readonly base: RunRecords,
    private readonly live: {
      task: Task;
      run: Run;
      events: RunEvent[];
      evaluation: EvaluationResult | null;
      append: (event: RunEvent) => void;
    },
  ) {}

  async getTask(id: string): Promise<Task | undefined> {
    return id === this.live.task.id ? structuredClone(this.live.task) : this.base.getTask(id);
  }

  async getRun(id: string): Promise<Run | undefined> {
    return id === this.live.run.id ? structuredClone(this.live.run) : this.base.getRun(id);
  }

  async getEvaluation(id: string): Promise<EvaluationResult | undefined> {
    return this.live.evaluation && id === this.live.evaluation.id ? structuredClone(this.live.evaluation) : this.base.getEvaluation(id);
  }

  async getEvents(runId: string): Promise<readonly RunEvent[]> {
    return runId === this.live.run.id ? structuredClone(this.live.events) : this.base.getEvents(runId);
  }

  async nextSequence(runId: string): Promise<number> {
    return runId === this.live.run.id ? this.live.events.length + 1 : this.base.nextSequence(runId);
  }

  async appendEvent(event: RunEvent): Promise<void> {
    if (event.runId === this.live.run.id) this.live.append(event);
    else await this.base.appendEvent(event);
  }

  quarantinedRunIds(): Promise<ReadonlySet<string>> {
    return this.base.quarantinedRunIds();
  }
}
