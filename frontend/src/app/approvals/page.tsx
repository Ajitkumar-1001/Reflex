import type { Metadata } from "next";
import Link from "next/link";
import { approvalNotice, getApprovalsClient, parseApprovalStatus } from "@/client/approvals";
import type { ApprovalStatus } from "@/client/approvals";
import { formatTimestamp } from "@/client/views";
import { loadCatalog } from "../_components/load";
import { DecisionForm } from "./decision-form";
import { EmptyState, ErrorState, PageHeader, StatusBadge, TableFrame, tableClassName, tdClassName, thClassName } from "../_components/ui";

export const metadata: Metadata = { title: "Approvals" };

const FILTERS: { href: string; label: string; status?: ApprovalStatus }[] = [
  { href: "/approvals", label: "All" },
  { href: "/approvals?status=pending", label: "Pending", status: "pending" },
  { href: "/approvals?status=approved", label: "Approved", status: "approved" },
  { href: "/approvals?status=denied", label: "Denied", status: "denied" },
];

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[]; notice?: string | string[]; id?: string | string[] }>;
}) {
  const params = await searchParams;
  const parsed = parseApprovalStatus(params.status);
  const notice = approvalNotice(params.notice, params.id);
  await loadCatalog();

  if (!parsed.ok) {
    return (
      <>
        <PageHeader title="Approvals" lede="Side-effect approvals. The queue is a typed client with mock data until the ledger service lands." />
        <div className="mt-6">
          <ErrorState title="That status is not valid">
            <p>{parsed.message}</p>
            <p className="mt-3">
              <Link href="/approvals" className="font-medium underline underline-offset-2">
                Show all approvals
              </Link>
            </p>
          </ErrorState>
        </div>
      </>
    );
  }

  const items = await getApprovalsClient().list(parsed.status ? { status: parsed.status } : {});
  const returnStatus = parsed.status ?? "all";

  return (
    <>
      <PageHeader
        title="Approvals"
        lede="Pending, approved, and denied side effects. Approve and deny call the mock ledger client. Runs and memories on the other pages stay read-only."
      />
      <nav aria-label="Approval status" className="mt-6">
        <ul className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => {
            const current = filter.status === parsed.status || (filter.status === undefined && parsed.status === undefined);
            return (
              <li key={filter.label}>
                <Link
                  href={filter.href}
                  aria-current={current ? "page" : undefined}
                  className={`inline-flex rounded-full px-3 py-1.5 text-sm font-medium ${
                    current ? "bg-accent text-accent-foreground" : "ring-1 ring-border"
                  }`}
                >
                  {filter.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {notice ? (
        <p role="status" className="mt-4 rounded-lg border border-ok bg-ok-bg px-4 py-3 text-sm text-ok">
          {notice}
        </p>
      ) : null}
      <div className="mt-6">
        {items.length === 0 ? (
          <EmptyState title={parsed.status ? `No ${parsed.status} approvals` : "No approvals"}>
            <p>
              {parsed.status === "pending"
                ? "Nothing is waiting. Approved and denied decisions are on the other filters."
                : "The mock ledger has no rows for this filter."}
            </p>
          </EmptyState>
        ) : (
          <TableFrame>
            <table className={tableClassName()}>
              <caption className="sr-only">Side-effect approvals</caption>
              <thead>
                <tr>
                  <th scope="col" className={thClassName()}>Request</th>
                  <th scope="col" className={thClassName()}>Status</th>
                  <th scope="col" className={thClassName()}>Run</th>
                  <th scope="col" className={thClassName()}>Decision</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <th scope="row" className={tdClassName()}>
                      <p className="font-sans font-medium">{item.summary}</p>
                      <p className="mt-1 font-mono text-xs font-normal text-muted">
                        {item.id} · {item.effect} · {item.tool}
                      </p>
                      <p className="mt-1 text-xs font-normal text-muted">
                        Requested <time dateTime={item.requestedAt}>{formatTimestamp(item.requestedAt)}</time>
                      </p>
                    </th>
                    <td className={tdClassName()}>
                      <StatusBadge value={item.status} />
                    </td>
                    <td className={tdClassName()}>
                      <Link href={`/runs/${item.runId}`} className="font-mono underline underline-offset-2">
                        {item.runId}
                      </Link>
                      <p className="mt-1 font-mono text-xs text-muted">{item.taskId}</p>
                    </td>
                    <td className={tdClassName()}>
                      {item.status === "pending" ? (
                        <DecisionForm id={item.id} returnStatus={returnStatus} />
                      ) : (
                        <div className="text-sm">
                          <p>
                            {item.decidedBy ?? "unknown"} at{" "}
                            {item.decidedAt ? <time dateTime={item.decidedAt}>{formatTimestamp(item.decidedAt)}</time> : "an unknown time"}
                          </p>
                          <p className="mt-1 text-muted">{item.reason}</p>
                        </div>
                      )}
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
