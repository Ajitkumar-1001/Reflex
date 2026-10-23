"use client";

import { useActionState } from "react";
import { decideApproval } from "./actions";

const initial: { message: string | null } = { message: null };

export function DecisionForm({ id, returnStatus }: { id: string; returnStatus: string }) {
  const [state, action, pending] = useActionState(decideApproval, initial);
  const reasonId = `reason-${id}`;
  return (
    <form action={action} className="flex min-w-56 flex-col gap-2" aria-busy={pending}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="returnStatus" value={returnStatus} />
      <label htmlFor={reasonId} className="text-xs font-medium text-muted">
        Reason
      </label>
      <input
        id={reasonId}
        name="reason"
        required
        // Keep in step with DECISION_REASON_MAX in client/approvals.ts, which the server enforces. Not imported: that would pull Zod into this client bundle.
        maxLength={240}
        disabled={pending}
        className="rounded-md border border-border bg-card px-2 py-1.5 text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          name="decision"
          value="approve"
          disabled={pending}
          className="rounded-full bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {pending ? "Saving…" : "Approve"}
        </button>
        <button
          type="submit"
          name="decision"
          value="deny"
          disabled={pending}
          className="rounded-full px-3 py-1.5 text-sm font-medium ring-1 ring-border disabled:opacity-50"
        >
          Deny
        </button>
      </div>
      {state.message ? (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
