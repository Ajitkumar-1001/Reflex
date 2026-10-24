import Link from "next/link";
import { getApprovalsClient } from "@/client/ledger-approvals";
import { countsBy, formatRate } from "@/client/views";
import { loadCatalog } from "./_components/load";
import { PageHeader, StatusBadge } from "./_components/ui";

const MEMORY_FILTERS = new Set(["candidate", "approved", "quarantined", "expired"]);

export default async function HomePage() {
  const catalog = await loadCatalog();
  const [runs, memories, pending] = await Promise.all([
    catalog.listRuns(),
    catalog.listMemories(),
    getApprovalsClient().list({ status: "pending" }),
  ]);
  const runCounts = countsBy(runs.map((run) => run.status));
  const memoryCounts = countsBy(memories.map((memory) => memory.lifecycleState));

  return (
    <>
      <PageHeader
        title="Dashboard"
        lede={`Project ${catalog.projectId} in ${catalog.tenantId}, read as ${catalog.principalLabel}. The figures come from the Phase 1 lab stored in this process.`}
      />
      <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <li>
          <Link href="/runs" className="block rounded-lg border border-border bg-card p-4 hover:border-foreground">
            <p className="text-xs font-medium text-muted">Runs</p>
            <p className="mt-2 text-2xl font-semibold">{runs.length}</p>
          </Link>
        </li>
        <li>
          <Link href="/memories" className="block rounded-lg border border-border bg-card p-4 hover:border-foreground">
            <p className="text-xs font-medium text-muted">Memories</p>
            <p className="mt-2 text-2xl font-semibold">{memories.length}</p>
          </Link>
        </li>
        <li>
          <Link href="/approvals?status=pending" className="block rounded-lg border border-border bg-card p-4 hover:border-foreground">
            <p className="text-xs font-medium text-muted">Pending approvals</p>
            <p className="mt-2 text-2xl font-semibold">{pending.length}</p>
          </Link>
        </li>
        <li>
          <Link href="/evaluation" className="block rounded-lg border border-border bg-card p-4 hover:border-foreground">
            <p className="text-xs font-medium text-muted">Majority lift, B minus A</p>
            <p className="mt-2 text-2xl font-semibold">{formatRate(catalog.report.lift.majority)}</p>
          </Link>
        </li>
      </ul>
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="run-states">
          <h2 id="run-states" className="text-lg font-medium">
            Runs by state
          </h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {runCounts.map((entry) => (
              <li key={entry.key} className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1">
                <StatusBadge value={entry.key} />
                <span className="text-sm">{entry.count}</span>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="memory-states">
          <h2 id="memory-states" className="text-lg font-medium">
            Memories by status
          </h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {memoryCounts.map((entry) => (
              <li key={entry.key}>
                {MEMORY_FILTERS.has(entry.key) ? (
                  <Link
                    href={`/memories?status=${entry.key}`}
                    className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1"
                  >
                    <StatusBadge value={entry.key} />
                    <span className="text-sm">{entry.count}</span>
                  </Link>
                ) : (
                  <span className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1">
                    <StatusBadge value={entry.key} />
                    <span className="text-sm">{entry.count}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
