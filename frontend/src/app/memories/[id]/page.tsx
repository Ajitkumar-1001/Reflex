import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatTimestamp, scopeLabel } from "@/client/views";
import { loadCatalog } from "../../_components/load";
import { EmptyState, PageHeader, Section, StatusBadge, TableFrame, tableClassName, tdClassName, thClassName } from "../../_components/ui";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: `Memory ${id}` };
}

export default async function MemoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const catalog = await loadCatalog();
  const detail = await catalog.getMemory(id);
  if (!detail) notFound();
  const memory = detail.memory;
  const flags = [
    detail.flags.expired ? "Expired" : null,
    detail.flags.idle ? "Idle episodic record" : null,
    detail.flags.sourceQuarantined ? "A source run is quarantined" : null,
    detail.flags.needsReverification ? "Needs re-verification before it can be trusted again" : null,
  ].filter((flag): flag is string => flag !== null);

  return (
    <>
      <p className="text-sm">
        <Link href="/memories" className="underline underline-offset-2">
          All memories
        </Link>
      </p>
      <div className="mt-3">
        <PageHeader title={memory.id} lede={memory.text} />
      </div>
      <ul className="mt-4 flex flex-wrap gap-2" aria-label="Memory status">
        <li>
          <StatusBadge value={memory.lifecycleState} />
        </li>
        <li>
          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-border">{memory.kind}</span>
        </li>
        <li>
          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-border">v{memory.version}</span>
        </li>
      </ul>
      <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-xs font-medium text-muted">Scope</dt>
          <dd className="mt-1 text-sm">{scopeLabel(memory.scope)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Confidence</dt>
          <dd className="mt-1 text-sm">{memory.confidence.toFixed(2)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Age</dt>
          <dd className="mt-1 text-sm">{detail.ageDays} days</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Last verified</dt>
          <dd className="mt-1 text-sm">{memory.lastVerifiedAt ? <time dateTime={memory.lastVerifiedAt}>{formatTimestamp(memory.lastVerifiedAt)}</time> : "Never"}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Expires</dt>
          <dd className="mt-1 text-sm">{memory.expiresAt ? <time dateTime={memory.expiresAt}>{formatTimestamp(memory.expiresAt)}</time> : "No expiry"}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Helpful / harmful</dt>
          <dd className="mt-1 text-sm">
            {detail.usage.helpful} / {detail.usage.harmful}
          </dd>
        </div>
      </dl>
      {memory.scope.conditions.length > 0 ? (
        <p className="mt-4 text-sm text-muted">Conditions: {memory.scope.conditions.join("; ")}</p>
      ) : null}
      {memory.preconditions.length > 0 ? <p className="mt-1 text-sm text-muted">Preconditions: {memory.preconditions.join("; ")}</p> : null}

      <Section id="flags" title="Retrieval flags">
        {flags.length === 0 ? (
          <p className="text-sm text-muted">Retrieval would not skip this memory for expiry, idleness, or a quarantined source.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {flags.map((flag) => (
              <li key={flag}>{flag}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="provenance" title="Provenance">
        {detail.provenance.runs.length === 0 && detail.provenance.evaluations.length === 0 ? (
          <EmptyState title="No provenance on record">
            <p>The source runs and evaluations named by this memory are not in the store.</p>
          </EmptyState>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-medium">Source runs</h3>
              {detail.provenance.runs.length === 0 ? (
                <p className="mt-2 text-sm text-muted">No source run was found.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {detail.provenance.runs.map((run) => (
                    <li key={run.runId}>
                      <Link href={`/runs/${run.runId}`} className="font-mono underline underline-offset-2">
                        {run.runId}
                      </Link>
                      <p className="text-xs text-muted">
                        {run.taskId} · {run.outcome ?? "no outcome"}
                        {run.outcomeReason ? ` / ${run.outcomeReason}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="text-sm font-medium">Evaluations</h3>
              {detail.provenance.evaluations.length === 0 ? (
                <p className="mt-2 text-sm text-muted">No evaluation was found.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {detail.provenance.evaluations.map((evaluation) => (
                    <li key={evaluation.evaluationId} className="text-sm">
                      <span className="font-mono">{evaluation.evaluationId}</span>
                      <span className="text-muted"> · {evaluation.verdict}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Section>

      <Section id="usage" title="Usage">
        {detail.usage.uses.length === 0 ? (
          <EmptyState title="No recorded uses">
            <p>Nothing in the trace cites this memory yet.</p>
          </EmptyState>
        ) : (
          <TableFrame>
            <table className={tableClassName()}>
              <caption className="sr-only">Runs that used this memory</caption>
              <thead>
                <tr>
                  <th scope="col" className={thClassName()}>Run</th>
                  <th scope="col" className={thClassName()}>Cited</th>
                  <th scope="col" className={thClassName()}>Followed</th>
                  <th scope="col" className={thClassName()}>Effect</th>
                </tr>
              </thead>
              <tbody>
                {detail.usage.uses.map((use, index) => (
                  <tr key={`${use.runId}-${index}`}>
                    <th scope="row" className={tdClassName()}>
                      <Link href={`/runs/${use.runId}`} className="font-mono underline underline-offset-2">
                        {use.runId}
                      </Link>
                    </th>
                    <td className={tdClassName()}>{use.citedInPlan ? "yes" : "no"}</td>
                    <td className={tdClassName()}>{use.followed ? "yes" : "no"}</td>
                    <td className={tdClassName()}>{use.outcomeEffect}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </Section>

      <Section id="supersession" title="Supersession">
        {detail.supersession.supersedes.length === 0 && detail.supersession.supersededBy === null ? (
          <p className="text-sm text-muted">This memory does not replace another, and nothing replaces it.</p>
        ) : (
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-muted">Replaces</dt>
              <dd className="mt-1 text-sm">
                {detail.supersession.supersedes.length === 0 ? (
                  "None"
                ) : (
                  <ul>
                    {detail.supersession.supersedes.map((prior) => (
                      <li key={prior}>
                        <Link href={`/memories/${prior}`} className="font-mono underline underline-offset-2">
                          {prior}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted">Replaced by</dt>
              <dd className="mt-1 text-sm">
                {detail.supersession.supersededBy ? (
                  <Link href={`/memories/${detail.supersession.supersededBy}`} className="font-mono underline underline-offset-2">
                    {detail.supersession.supersededBy}
                  </Link>
                ) : (
                  "None"
                )}
              </dd>
            </div>
          </dl>
        )}
      </Section>

      <Section id="gate" title="Gate decision">
        {detail.gate === null ? (
          <EmptyState title="No gate decision">
            <p>This record was inserted without a gate decision.</p>
          </EmptyState>
        ) : (
          <div>
            <StatusBadge value={detail.gate.result} />
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-muted">Reason codes</dt>
                <dd className="mt-1 text-sm">{detail.gate.reasonCodes.join(", ") || "None"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Reviewer</dt>
                <dd className="mt-1 text-sm">{detail.gate.reviewer ?? "None"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Decided</dt>
                <dd className="mt-1 text-sm">
                  <time dateTime={detail.gate.decidedAt}>{formatTimestamp(detail.gate.decidedAt)}</time>
                </dd>
              </div>
            </dl>
          </div>
        )}
      </Section>

      <Section id="history" title="Audit history">
        {detail.history.length === 0 ? (
          <EmptyState title="No lifecycle events">
            <p>No memory_lifecycle event names this memory.</p>
          </EmptyState>
        ) : (
          <TableFrame>
            <table className={tableClassName()}>
              <caption className="sr-only">Lifecycle audit history</caption>
              <thead>
                <tr>
                  <th scope="col" className={thClassName()}>When</th>
                  <th scope="col" className={thClassName()}>Actor</th>
                  <th scope="col" className={thClassName()}>Change</th>
                  <th scope="col" className={thClassName()}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {detail.history.map((entry) => (
                  <tr key={`${entry.at}-${entry.version}-${entry.reasonCode}`}>
                    <td className={tdClassName()}>
                      <time dateTime={entry.at}>{formatTimestamp(entry.at)}</time>
                    </td>
                    <td className={tdClassName()}>{entry.actor}</td>
                    <td className={tdClassName()}>
                      {entry.from ?? "new"} to {entry.to} (v{entry.version})
                    </td>
                    <td className={tdClassName()}>{entry.reasonCode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </Section>
    </>
  );
}
