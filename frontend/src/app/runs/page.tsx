import type { Metadata } from "next";
import Link from "next/link";
import { excerpt, formatTimestamp } from "@/client/views";
import { loadCatalog } from "../_components/load";
import { EmptyState, PageHeader, StatusBadge, TableFrame, tableClassName, tdClassName, thClassName } from "../_components/ui";

export const metadata: Metadata = { title: "Runs" };

export default async function RunsPage() {
  const catalog = await loadCatalog();
  const runs = await catalog.listRuns();

  return (
    <>
      <PageHeader
        title="Runs"
        lede="Every run recorded in the in-memory store, newest first. Open one for its state timeline, trace, evaluation, artifacts, and the memories it retrieved."
      />
      <div className="mt-6">
        {runs.length === 0 ? (
          <EmptyState title="No runs yet">
            <p>The store has no recorded runs. A new process starts from the lab seed, so this is empty only if that seed recorded nothing.</p>
          </EmptyState>
        ) : (
          <TableFrame>
            <table className={tableClassName()}>
              <caption className="sr-only">Recorded runs</caption>
              <thead>
                <tr>
                  <th scope="col" className={thClassName()}>Run</th>
                  <th scope="col" className={thClassName()}>Task</th>
                  <th scope="col" className={thClassName()}>State</th>
                  <th scope="col" className={thClassName()}>Outcome</th>
                  <th scope="col" className={thClassName()}>Arm</th>
                  <th scope="col" className={thClassName()}>Retrieval</th>
                  <th scope="col" className={thClassName()}>Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <th scope="row" className={`${tdClassName()} font-mono font-medium`}>
                      <Link href={`/runs/${run.id}`} className="underline underline-offset-2">
                        {run.id}
                      </Link>
                    </th>
                    <td className={tdClassName()}>
                      <p title={run.objective}>{excerpt(run.objective, 72)}</p>
                      <p className="mt-1 font-mono text-xs text-muted">{run.taskId}</p>
                    </td>
                    <td className={tdClassName()}>
                      <StatusBadge value={run.status} />
                    </td>
                    <td className={tdClassName()}>
                      {run.outcome ? <StatusBadge value={run.outcome} /> : <span className="text-muted">In progress</span>}
                      {run.outcomeReason ? <p className="mt-1 text-xs text-muted">{run.outcomeReason}</p> : null}
                    </td>
                    <td className={tdClassName()}>{run.arm}</td>
                    <td className={tdClassName()}>
                      <StatusBadge value={run.retrieval} />
                    </td>
                    <td className={tdClassName()}>
                      <time dateTime={run.createdAt}>{formatTimestamp(run.createdAt)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </div>
    </>
  );
}
