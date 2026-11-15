/**
 * Workforce plane client — submits maker-checker requests to the gateway.
 * Env: WORKFORCE_API_URL (e.g. http://localhost:3000), WORKFORCE_SERVICE_KEY
 */

export type WorkforceApprovalRequest = {
  id: string;
  status: string;
  actionKey: string;
  resultingResourceId?: string;
};

function configured(): { baseUrl: string; key: string } | null {
  const baseUrl = process.env.WORKFORCE_API_URL?.trim();
  const key = process.env.WORKFORCE_SERVICE_KEY?.trim();
  if (!baseUrl || !key) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), key };
}

export function workforceApprovalsEnabled(): boolean {
  return configured() !== null;
}

export async function submitWorkforceApproval(input: {
  actionKey: string;
  requesterEmail: string;
  payload: Record<string, unknown>;
  amountCents?: number;
  currency?: string;
}): Promise<WorkforceApprovalRequest> {
  const cfg = configured();
  if (!cfg) {
    throw Object.assign(
      new Error(
        "Workforce approvals are not configured. Set WORKFORCE_API_URL and WORKFORCE_SERVICE_KEY."
      ),
      { status: 503 }
    );
  }
  const res = await fetch(`${cfg.baseUrl}/api/internal/workforce-approvals/requests`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-workforce-service-key": cfg.key,
    },
    body: JSON.stringify({
      actionKey: input.actionKey,
      requesterEmail: input.requesterEmail,
      payload: input.payload,
      amountCents: input.amountCents,
      currency: input.currency,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: WorkforceApprovalRequest;
    error?: { message?: string };
  };
  if (!res.ok || !body.data) {
    throw Object.assign(
      new Error(body.error?.message || `Workforce approval failed (${res.status})`),
      { status: res.status >= 400 && res.status < 600 ? res.status : 502 }
    );
  }
  return body.data;
}

export const HRIS_APPROVAL_ACTIONS = {
  CASH_CALL_ISSUE: "hris.cash_call.issue",
  ACCOUNT_CREATE: "hris.account.create",
  ACCOUNT_CLOSE: "hris.account.close",
} as const;
