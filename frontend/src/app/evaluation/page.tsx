import type { Metadata } from "next";
import Link from "next/link";
import { formatPValue, formatRate, toChartBars, toComparisonRows } from "@/client/views";
import { ArmChart } from "../_components/chart";
import { loadCatalog } from "../_components/load";
import { EmptyState, PageHeader, Section, TableFrame, tableClassName, tdClassName, thClassName } from "../_components/ui";

export const metadata: Metadata = { title: "Evaluation" };

export default async function EvaluationPage() {
  const catalog = await loadCatalog();
  const report = catalog.report;
  const rows = toComparisonRows(report);
  const bars = toChartBars(report);
  const target =
    report.meetsTarget === null ? "Not set. The lift target is still an open decision." : report.meetsTarget ? "Meets the target." : "Below the target.";

  return (
    <>
      <PageHeader
        title="Evaluation"
        lede={`Paired memory-off (A) and memory-on (B) results for ${report.experimentId}. The model is the lab double: it follows a lesson when the lesson is in context. This is not a claim about a production model.`}
      />
      <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-xs font-medium text-muted">Tasks analysed</dt>
          <dd className="mt-1 text-sm">
            {report.tasksAnalysed} of {report.tasksPlanned}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Trials per arm</dt>
          <dd className="mt-1 text-sm">{report.trials}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Runs executed</dt>
          <dd className="mt-1 text-sm">{report.runsExecuted}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Majority lift</dt>
          <dd className="mt-1 text-sm">{formatRate(report.lift.majority)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">pass^1 lift</dt>
          <dd className="mt-1 text-sm">{formatRate(report.lift.pass1)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">95% CI, majority lift</dt>
          <dd className="mt-1 text-sm">
            {formatRate(report.lift.majorityCi95[0])} to {formatRate(report.lift.majorityCi95[1])}
            {report.lift.ciLowerBoundPositive ? " · lower bound above 0" : ""}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">McNemar</dt>
          <dd className="mt-1 text-sm">
            p {formatPValue(report.mcnemar.pValue)}
            {report.mcnemar.significantAt05 ? " · significant at 0.05" : " · not significant at 0.05"}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Discordant tasks</dt>
          <dd className="mt-1 text-sm">
            B only {report.paired.bOnly}, A only {report.paired.aOnly}, both {report.paired.bothSucceed}, neither {report.paired.neither}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted">Target</dt>
          <dd className="mt-1 text-sm">{target}</dd>
        </div>
      </dl>
      {report.frozen.memoryWrites > 0 || report.frozen.writebackAttemptsBlocked > 0 ? (
        <p role="status" className="mt-4 rounded-lg border border-warn bg-warn-bg px-4 py-3 text-sm text-warn">
          Arm B did not stay frozen: {report.frozen.memoryWrites} writes, {report.frozen.writebackAttemptsBlocked} blocked writeback attempts.
        </p>
      ) : (
        <p className="mt-4 text-sm text-muted">Arm B wrote nothing. The comparison is frozen.</p>
      )}

      <Section id="chart" title="Arm rates">
        <ArmChart bars={bars} />
      </Section>

      <Section id="tasks" title="Per task">
        {rows.length === 0 ? (
          <EmptyState title="No paired tasks">
            <p>Every task was excluded or the experiment recorded no complete pairs.</p>
          </EmptyState>
        ) : (
          <TableFrame>
            <table className={tableClassName()}>
              <caption className="sr-only">Memory-off versus memory-on by task</caption>
              <thead>
                <tr>
                  <th scope="col" className={thClassName()}>Task</th>
                  <th scope="col" className={thClassName()}>A memory off</th>
                  <th scope="col" className={thClassName()}>B memory on</th>
                  <th scope="col" className={thClassName()}>Runs</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.taskId}>
                    <th scope="row" className={`${tdClassName()} font-mono font-medium`}>
                      {row.taskId}
                    </th>
                    <td className={tdClassName()}>
                      {row.armA.successes}/{row.trials} {row.armA.majority ? "majority pass" : "majority fail"}
                    </td>
                    <td className={tdClassName()}>
                      {row.armB.successes}/{row.trials} {row.armB.majority ? "majority pass" : "majority fail"}
                    </td>
                    <td className={tdClassName()}>
                      <ul>
                        {row.armA.runIds.map((id) => (
                          <li key={id}>
                            <Link href={`/runs/${id}`} className="font-mono underline underline-offset-2">
                              {id}
                            </Link>{" "}
                            <span className="text-muted">A</span>
                          </li>
                        ))}
                        {row.armB.runIds.map((id) => (
                          <li key={id}>
                            <Link href={`/runs/${id}`} className="font-mono underline underline-offset-2">
                              {id}
                            </Link>{" "}
                            <span className="text-muted">B</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </Section>

      <Section id="excluded" title="Excluded tasks">
        {report.tasksExcluded.length === 0 ? (
          <EmptyState title="No tasks excluded">
            <p>No run was retrieval-degraded, an infra failure, or stopped by the run budget.</p>
          </EmptyState>
        ) : (
          <TableFrame>
            <table className={tableClassName()}>
              <caption className="sr-only">Tasks excluded from the comparison</caption>
              <thead>
                <tr>
                  <th scope="col" className={thClassName()}>Task</th>
                  <th scope="col" className={thClassName()}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {report.tasksExcluded.map((task) => (
                  <tr key={task.taskId}>
                    <th scope="row" className={`${tdClassName()} font-mono`}>
                      {task.taskId}
                    </th>
                    <td className={tdClassName()}>{task.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </Section>

      <Section id="per-memory" title="Per memory">
        {report.perMemory.length === 0 ? (
          <EmptyState title="No injected memories">
            <p>Arm B recorded no memory_use events, so there is no descriptive per-memory effect.</p>
          </EmptyState>
        ) : (
          <TableFrame>
            <table className={tableClassName()}>
              <caption className="sr-only">Descriptive effect of each injected memory</caption>
              <thead>
                <tr>
                  <th scope="col" className={thClassName()}>Memory</th>
                  <th scope="col" className={thClassName()}>Injected trials</th>
                  <th scope="col" className={thClassName()}>Success when injected</th>
                  <th scope="col" className={thClassName()}>Control</th>
                  <th scope="col" className={thClassName()}>Delta</th>
                </tr>
              </thead>
              <tbody>
                {report.perMemory.map((memory) => (
                  <tr key={memory.memoryId}>
                    <th scope="row" className={tdClassName()}>
                      <Link href={`/memories/${memory.memoryId}`} className="font-mono underline underline-offset-2">
                        {memory.memoryId}
                      </Link>
                    </th>
                    <td className={tdClassName()}>{memory.injectedTrials}</td>
                    <td className={tdClassName()}>{formatRate(memory.successRateWhenInjected)}</td>
                    <td className={tdClassName()}>{formatRate(memory.controlSuccessRate)}</td>
                    <td className={tdClassName()}>{formatRate(memory.delta)}</td>
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
