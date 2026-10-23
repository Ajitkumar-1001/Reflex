import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { excerpt, formatCheckPassed, formatTimestamp } from "@/client/views";
import { loadCatalog } from "../../_components/load";
import { EmptyState, PageHeader, Section, StatusBadge, TableFrame, tableClassName, tdClassName, thClassName } from "../../_components/ui";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: `Run ${id}` };
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const catalog = await loadCatalog();
  const run = await catalog.getRun(id);
  if (!run) notFound();

  const retrievalNote =
    run.item.retrieval === "disabled"
      ? "Retrieval was disabled for this run, so no memories were injected."
      : run.item.retrieval === "degraded"
        ? "Retrieval was degraded. The run continued without memory and is excluded from A/B statistics."
        : "Retrieval ran and injected nothing that cleared the threshold.";

  return (
    <>
      <p className="text-sm">
        <Link href="/runs" className="underline underline-offset-2">
          All runs
        </Link>
      </p>
      <div className="mt-3">
        <PageHeader title={run.item.id} lede={run.item.objective} />
      </div>
      <ul className="mt-4 flex flex-wrap gap-2" aria-label="Run status">
        <li>
          <StatusBadge value={run.item.status} />
        </li>
        {run.item.outcome ? (
          <li>
            <StatusBadge value={run.item.outcome} />
          </li>
        ) : null}
        <li>
          <StatusBadge value={run.item.retrieval} />
        </li>
        <li>
          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-border">Arm {run.item.arm}</span>
        </li>
      </ul>
      <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-xs font-medium text-muted">Task</dt>
          <dd className="mt-1 font-mono text-sm">{run.item.taskId}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Outcome reason</dt>
          <dd className="mt-1 text-sm">{run.item.outcomeReason ?? "Not finished"}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Started</dt>
          <dd className="mt-1 text-sm">
            <time dateTime={run.item.createdAt}>{formatTimestamp(run.item.createdAt)}</time>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Ended</dt>
          <dd className="mt-1 text-sm">{run.item.endedAt ? <time dateTime={run.item.endedAt}>{formatTimestamp(run.item.endedAt)}</time> : "Still running"}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Model</dt>
          <dd className="mt-1 text-sm">{run.model}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Policy</dt>
          <dd className="mt-1 font-mono text-sm">
            {run.policyId}@{run.policyVersion}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Steps</dt>
          <dd className="mt-1 text-sm">
            {run.item.steps} of {run.budget.maxSteps}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Cost</dt>
          <dd className="mt-1 text-sm">
            ${run.cost.usd.toFixed(4)} · {run.cost.inputTokens + run.cost.outputTokens} tokens · {run.cost.wallMs} ms
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Experiment</dt>
          <dd className="mt-1 text-sm">{run.item.experimentId ?? "None"}</dd>
        </div>
      </dl>

      <Section id="timeline" title="State timeline">
        {run.timeline.length === 0 ? (
          <EmptyState title="No state transitions">
            <p>This trace has no state_transition events.</p>
          </EmptyState>
        ) : (
          <ol className="space-y-3">
            {run.timeline.map((step) => (
              <li key={step.sequence} className="grid grid-cols-[auto_1fr] gap-3">
                <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-bar-b" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium">{step.from ? `${step.from} to ${step.to}` : `Entered ${step.to}`}</p>
                  <p className="text-xs text-muted">
                    <time dateTime={step.at}>{formatTimestamp(step.at)}</time>
                    {" · "}
                    {step.reason}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section id="events" title="Events">
        {run.events.length === 0 ? (
          <EmptyState title="No events">
            <p>This run has an empty trace.</p>
          </EmptyState>
        ) : (
          <TableFrame>
            <table className={tableClassName()}>
              <caption className="sr-only">Trace events in sequence order</caption>
              <thead>
                <tr>
                  <th scope="col" className={thClassName()}>#</th>
                  <th scope="col" className={thClassName()}>When</th>
                  <th scope="col" className={thClassName()}>Type</th>
                  <th scope="col" className={thClassName()}>Actor</th>
                  <th scope="col" className={thClassName()}>Summary</th>
                </tr>
              </thead>
              <tbody>
                {run.events.map((event) => (
                  <tr key={event.sequence}>
                    <th scope="row" className={tdClassName()}>{event.sequence}</th>
                    <td className={tdClassName()}>
                      <time dateTime={event.at}>{formatTimestamp(event.at)}</time>
                    </td>
                    <td className={`${tdClassName()} font-mono text-xs`}>{event.type}</td>
                    <td className={`${tdClassName()} font-mono text-xs`}>{event.actor}</td>
                    <td className={tdClassName()}>{excerpt(event.summary, 240)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </Section>

      <Section id="evaluation" title="Evaluation">
        {run.evaluation === null ? (
          <EmptyState title="No evaluation">
            <p>This run did not record an evaluation. Blocked and cancelled runs often stop before the evaluator.</p>
          </EmptyState>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge value={run.evaluation.verdict} />
              <span className="text-sm text-muted">{run.evaluation.outcomeReason}</span>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-muted">Evaluation</dt>
                <dd className="mt-1 font-mono text-sm">{run.evaluation.id}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Hidden checks</dt>
                <dd className="mt-1 text-sm">{formatCheckPassed(run.evaluation.hiddenChecksPassed)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Check bundle</dt>
                <dd className="mt-1 break-all font-mono text-xs">{run.evaluation.checkBundleHash}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Completed</dt>
                <dd className="mt-1 text-sm">
                  <time dateTime={run.evaluation.completedAt}>{formatTimestamp(run.evaluation.completedAt)}</time>
                </dd>
              </div>
            </dl>
            {run.evaluation.touchedProtectedPaths.length > 0 ? (
              <p className="text-sm text-danger" role="status">
                Protected paths touched: {run.evaluation.touchedProtectedPaths.join(", ")}
              </p>
            ) : null}
            {run.evaluation.checks.length === 0 ? (
              <p className="text-sm text-muted">No checks were recorded.</p>
            ) : (
              <TableFrame>
                <table className={tableClassName()}>
                  <caption className="sr-only">Evaluation checks</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={thClassName()}>Check</th>
                      <th scope="col" className={thClassName()}>Result</th>
                      <th scope="col" className={thClassName()}>Command</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.evaluation.checks.map((check) => (
                      <tr key={check.name}>
                        <th scope="row" className={tdClassName()}>{check.name}</th>
                        <td className={tdClassName()}>{formatCheckPassed(check.passed)}</td>
                        <td className={`${tdClassName()} font-mono text-xs`}>{check.command ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            )}
          </div>
        )}
      </Section>

      <Section id="artifacts" title="Artifacts">
        <p className="mb-3 text-sm leading-6 text-muted">
          Artifact refs are sha256 content hashes from the trace and from checks. The blob is not stored on the run record.
        </p>
        {run.artifacts.length === 0 ? (
          <EmptyState title="No artifacts">
            <p>Nothing in this trace crossed the size that the tools store by hash. Short tool output stays on the event.</p>
          </EmptyState>
        ) : (
          <ul className="space-y-2">
            {run.artifacts.map((artifact) => (
              <li key={`${artifact.source}:${artifact.ref}`} className="rounded-lg border border-border bg-card px-3 py-2">
                <p className="text-sm">{artifact.label}</p>
                <p className="mt-1 break-all font-mono text-xs text-muted">{artifact.ref}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="memories" title="Retrieved memories">
        {run.memories.length === 0 ? (
          <EmptyState title="No memories in context">
            <p>{retrievalNote}</p>
          </EmptyState>
        ) : (
          <TableFrame>
            <table className={tableClassName()}>
              <caption className="sr-only">Memories retrieved for this run, with provenance</caption>
              <thead>
                <tr>
                  <th scope="col" className={thClassName()}>Memory</th>
                  <th scope="col" className={thClassName()}>Rank</th>
                  <th scope="col" className={thClassName()}>Use</th>
                  <th scope="col" className={thClassName()}>Provenance</th>
                </tr>
              </thead>
              <tbody>
                {run.memories.map((memory) => (
                  <tr key={memory.memoryId}>
                    <th scope="row" className={tdClassName()}>
                      <Link href={`/memories/${memory.memoryId}`} className="font-mono underline underline-offset-2">
                        {memory.memoryId}
                      </Link>
                      {memory.lifecycleState ? (
                        <span className="mt-1 block">
                          <StatusBadge value={memory.lifecycleState} />
                        </span>
                      ) : null}
                      {memory.text ? <p className="mt-1 max-w-md font-sans font-normal">{memory.text}</p> : null}
                    </th>
                    <td className={tdClassName()}>
                      {memory.rank === null ? "Not in context" : `#${memory.rank}`}
                      {memory.score !== null ? <p className="text-xs text-muted">score {memory.score.toFixed(3)}</p> : null}
                      <p className="text-xs text-muted">{memory.injected ? "injected" : "not injected"}</p>
                    </td>
                    <td className={tdClassName()}>
                      <p>cited {memory.citedInPlan ? "yes" : "no"}</p>
                      <p>followed {memory.followed ? "yes" : "no"}</p>
                      <p>effect {memory.outcomeEffect}</p>
                    </td>
                    <td className={tdClassName()}>
                      {memory.sourceRunIds.length === 0 ? (
                        <span className="text-muted">No source run on record</span>
                      ) : (
                        <ul>
                          {memory.sourceRunIds.map((sourceId) => (
                            <li key={sourceId}>
                              <Link href={`/runs/${sourceId}`} className="font-mono underline underline-offset-2">
                                {sourceId}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
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
