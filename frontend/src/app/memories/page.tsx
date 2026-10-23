import type { Metadata } from "next";
import Link from "next/link";
import { MEMORY_KINDS, MEMORY_STATUS_FILTERS, UNSCOPED_SCOPE, excerpt, filterMemoryList, parseMemoryQuery, scopeChoices } from "@/client/views";
import { loadCatalog } from "../_components/load";
import { EmptyState, ErrorState, PageHeader, StatusBadge, TableFrame, tableClassName, tdClassName, thClassName } from "../_components/ui";

export const metadata: Metadata = { title: "Memories" };

const fieldClass = "mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm";

export default async function MemoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[]; kind?: string | string[]; scope?: string | string[]; q?: string | string[] }>;
}) {
  const raw = await searchParams;
  const parsed = parseMemoryQuery(raw);
  const catalog = await loadCatalog();
  const all = await catalog.listMemories();

  if (!parsed.ok) {
    return (
      <>
        <PageHeader title="Memories" lede="The filters in the address bar are not a status, kind, or scope this explorer understands." />
        <div className="mt-6">
          <ErrorState title="Those filters are not valid">
            <p>{parsed.message}</p>
            <p className="mt-3">
              <Link href="/memories" className="font-medium underline underline-offset-2">
                Clear filters
              </Link>
            </p>
          </ErrorState>
        </div>
      </>
    );
  }

  const query = parsed.query;
  const choices = scopeChoices(all);
  const ranked = query.q ? await catalog.searchMemories({ ...query, q: query.q }) : null;
  const items = ranked ? filterMemoryList(ranked, { scope: query.scope }) : filterMemoryList(all, query);
  const capped = ranked !== null && ranked.length >= 20;

  return (
    <>
      <PageHeader
        title="Memories"
        lede="Filter the project collection by status, scope, and kind. A query uses the explorer search and keeps the top matches. Open a memory for provenance, usage, and the gate decision."
      />
      <form method="get" className="mt-6 grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5" role="search">
        <div>
          <label htmlFor="status" className="text-xs font-medium text-muted">
            Status
          </label>
          <select id="status" name="status" defaultValue={query.status ?? ""} className={fieldClass}>
            <option value="">All</option>
            {MEMORY_STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="kind" className="text-xs font-medium text-muted">
            Kind
          </label>
          <select id="kind" name="kind" defaultValue={query.kind ?? ""} className={fieldClass}>
            <option value="">All</option>
            {MEMORY_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="scope" className="text-xs font-medium text-muted">
            Scope
          </label>
          <select id="scope" name="scope" defaultValue={query.scope ?? ""} className={fieldClass}>
            <option value="">All</option>
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
            {query.scope && !choices.some((choice) => choice.value === query.scope) ? (
              <option value={query.scope}>{query.scope}</option>
            ) : null}
          </select>
        </div>
        <div className="sm:col-span-2 lg:col-span-1">
          <label htmlFor="q" className="text-xs font-medium text-muted">
            Query
          </label>
          <input id="q" name="q" type="search" defaultValue={query.q ?? ""} placeholder="operator, gen:client…" className={fieldClass} />
        </div>
        <div className="flex items-end gap-3">
          <button type="submit" className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-foreground">
            Apply
          </button>
          <Link href="/memories" className="text-sm underline underline-offset-2">
            Clear
          </Link>
        </div>
      </form>
      <div className="mt-6">
        {items.length === 0 ? (
          <EmptyState title={query.q ? "Nothing cleared the relevance threshold" : "No memories match"}>
            <p>
              {query.q
                ? "Search only returns memories the retriever scores as relevant, then applies the scope filter. A status or kind with no overlap shows up empty."
                : "No stored memory has this status, kind, and scope. Clearing the filters shows the whole project."}
            </p>
            <p className="mt-3">
              <Link href="/memories" className="font-medium underline underline-offset-2">
                Show all memories
              </Link>
            </p>
          </EmptyState>
        ) : (
          <>
            {capped ? <p className="mb-3 text-sm text-muted">Showing the top 20 search matches.</p> : null}
            <TableFrame>
              <table className={tableClassName()}>
                <caption className="sr-only">Memories in this project</caption>
                <thead>
                  <tr>
                    <th scope="col" className={thClassName()}>Memory</th>
                    <th scope="col" className={thClassName()}>Status</th>
                    <th scope="col" className={thClassName()}>Kind</th>
                    <th scope="col" className={thClassName()}>Scope</th>
                    <th scope="col" className={thClassName()}>Confidence</th>
                    {ranked ? (
                      <th scope="col" className={thClassName()}>
                        Score
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {items.map((memory) => (
                    <tr key={memory.id}>
                      <th scope="row" className={tdClassName()}>
                        <Link href={`/memories/${memory.id}`} className="font-mono underline underline-offset-2">
                          {memory.id}
                        </Link>
                        <p className="mt-1 max-w-md font-sans font-normal">{excerpt(memory.text, 140)}</p>
                      </th>
                      <td className={tdClassName()}>
                        <StatusBadge value={memory.lifecycleState} />
                      </td>
                      <td className={tdClassName()}>{memory.kind}</td>
                      <td className={tdClassName()}>{memory.scopeLabel}</td>
                      <td className={tdClassName()}>{memory.confidence.toFixed(2)}</td>
                      {ranked ? <td className={tdClassName()}>{memory.score === null ? "—" : memory.score.toFixed(3)}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          </>
        )}
      </div>
      {choices.some((choice) => choice.value === UNSCOPED_SCOPE) ? (
        <p className="mt-3 text-xs text-muted">Unscoped means the memory has no task class.</p>
      ) : null}
    </>
  );
}
