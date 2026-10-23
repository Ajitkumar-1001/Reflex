import { describe, expect, it } from "vitest";
import { getCatalog } from "./catalog";

describe("dashboard catalog", () => {
  it("seeds runs, the four memory statuses, and a memory-on lift", async () => {
    const catalog = await getCatalog();
    const runs = await catalog.listRuns();
    expect(runs.map((run) => run.id)).toEqual(expect.arrayContaining(["run-1", "run-2", "run-3"]));
    expect(runs.find((run) => run.id === "run-1")).toMatchObject({ taskId: "task-add-train", arm: "B" });
    expect(runs.find((run) => run.id === "run-3")?.retrieval).toBe("hybrid");

    const memories = await catalog.listMemories();
    const states = new Set(memories.map((memory) => memory.lifecycleState));
    expect([...states].sort()).toEqual(expect.arrayContaining(["approved", "candidate", "expired", "quarantined"]));
    expect(memories.some((memory) => memory.kind === "playbook_item" && memory.taskClass === null)).toBe(true);
    expect(JSON.stringify(memories)).not.toContain("embedding");

    const procedural = memories.find((memory) => memory.kind === "procedural" && memory.lifecycleState === "approved");
    expect(procedural).toBeDefined();
    const detail = procedural ? await catalog.getMemory(procedural.id) : null;
    expect(detail?.provenance.runs.length).toBeGreaterThan(0);
    expect(detail?.provenance.runs[0]?.runId).toBe("run-1");

    const mul = await catalog.getRun("run-3");
    expect(mul?.memories.some((memory) => memory.injected)).toBe(true);
    expect(mul?.timeline.length).toBeGreaterThan(1);
    expect(mul?.evaluation?.verdict).toBe("verified_success");

    expect(catalog.report.tasksAnalysed).toBe(6);
    expect(catalog.report.lift.majority).toBe(1);
    expect(catalog.report.frozen).toEqual({ writebackAttemptsBlocked: 0, memoryWrites: 0 });

    const searched = await catalog.searchMemories({ q: "operator follows the function name", status: "approved" });
    expect(searched[0]?.lifecycleState).toBe("approved");
    expect(searched[0]?.score).toBeGreaterThan(0);
  }, 60_000);
});
