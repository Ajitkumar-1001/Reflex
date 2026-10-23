"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApprovalClientError, isApprovalStatus, parseDecisionForm } from "@/client/approvals";
import { getApprovalsClient } from "@/client/ledger-approvals";

export interface DecisionState {
  message: string | null;
}

function returnQuery(returnStatus: FormDataEntryValue | null, notice: "approved" | "denied", id: string): string {
  const params = new URLSearchParams();
  if (typeof returnStatus === "string" && (returnStatus === "all" || isApprovalStatus(returnStatus))) {
    params.set("status", returnStatus);
  }
  params.set("notice", notice);
  params.set("id", id);
  return params.toString();
}

/** The approve and deny buttons submit here. The handler calls the typed approvals client and nothing else. */
export async function decideApproval(_previous: DecisionState, formData: FormData): Promise<DecisionState> {
  const input = parseDecisionForm({ id: formData.get("id"), decision: formData.get("decision"), reason: formData.get("reason") });
  if (!input.ok) return { message: input.message };

  let status: "approved" | "denied";
  try {
    const record = await getApprovalsClient().decide(input.id, input.decision, { actor: "dashboard-operator", reason: input.reason });
    status = record.status === "denied" ? "denied" : "approved";
  } catch (error) {
    if (error instanceof ApprovalClientError) return { message: error.message };
    throw error;
  }

  revalidatePath("/approvals");
  redirect(`/approvals?${returnQuery(formData.get("returnStatus"), status, input.id)}`);
}
