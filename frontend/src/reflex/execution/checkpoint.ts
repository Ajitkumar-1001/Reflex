import type { RunCheckpoint } from "./types";

/**
 * Latest checkpoint per dispatch. Only the last completed step is kept; a crashed attempt that
 * never reached `save` leaves the previous record in place.
 */

export interface CheckpointRecord {
  checkpoint: RunCheckpoint;
  /** Next id counters, so a resumed attempt does not reuse event or call ids. */
  ids: Readonly<Record<string, number>>;
  /** Next stepping-clock position, so resumed timestamps continue the original run. */
  clock: { readonly startMs: number; readonly stepMs: number; readonly tick: number };
}

export interface CheckpointStore {
  save(dispatchId: string, record: CheckpointRecord): Promise<void>;
  load(dispatchId: string): Promise<CheckpointRecord | null>;
}

const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly records = new Map<string, CheckpointRecord>();

  async save(dispatchId: string, record: CheckpointRecord): Promise<void> {
    if (record.checkpoint.dispatchId !== dispatchId) {
      throw new Error(`checkpoint ${record.checkpoint.dispatchId} does not match dispatch ${dispatchId}`);
    }
    if (record.checkpoint.version !== 1) throw new Error(`unsupported checkpoint version ${record.checkpoint.version}`);
    this.records.set(dispatchId, copy(record));
  }

  async load(dispatchId: string): Promise<CheckpointRecord | null> {
    const found = this.records.get(dispatchId);
    return found ? copy(found) : null;
  }
}
