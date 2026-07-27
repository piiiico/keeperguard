/**
 * Thin client for KeeperHub's Direct Execution API.
 *
 * Only the three endpoints this project actually calls are implemented:
 *   POST /api/execute/transfer
 *   POST /api/execute/contract-call
 *   GET  /api/execute/{executionId}/status
 *
 * Every one of them has been run live against app.keeperhub.com on Base
 * mainnet (chainId 8453) — see the transaction linked in the README.
 */

import type { Decision } from "./types.ts";

const BASE_URL = "https://app.keeperhub.com";

export type SimulateResponse = {
  success: boolean;
  status: "simulated";
  from: string;
  to: string;
  value: string;
  gasEstimate?: string;
  simulatedReturnValue?: unknown;
  wouldRevert: boolean;
  revertReason?: string;
  error?: string;
};

export type ExecuteResponse = { executionId: string; status: string };

export type StatusResponse = {
  executionId: string;
  status: "pending" | "running" | "completed" | "failed";
  type?: string;
  transactionHash?: string;
  transactionLink?: string;
  gasUsedWei?: string;
  error?: string | null;
};

export class KeeperHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "KeeperHubError";
  }
}

/** The path and body KeeperHub expects for a given decision. */
export function toRequest(decision: Decision): { path: string; body: Record<string, unknown> } {
  if (decision.intent === "transfer") {
    return {
      path: "/api/execute/transfer",
      body: {
        chainId: decision.chainId,
        recipientAddress: decision.recipientAddress,
        amount: decision.amount,
        ...(decision.tokenAddress ? { tokenAddress: decision.tokenAddress } : {}),
      },
    };
  }
  return {
    path: "/api/execute/contract-call",
    body: {
      chainId: decision.chainId,
      contractAddress: decision.contractAddress,
      functionName: decision.functionName,
      ...(decision.functionArgs ? { functionArgs: decision.functionArgs } : {}),
      ...(decision.value ? { value: decision.value } : {}),
    },
  };
}

/** The destination a policy should be checked against. */
export function targetOf(decision: Decision): string {
  return decision.intent === "transfer" ? decision.recipientAddress : decision.contractAddress;
}

/** Native value the decision moves, in ether units ("0" for ERC-20 / non-payable). */
export function nativeValueOf(decision: Decision): string {
  if (decision.intent === "transfer") return decision.tokenAddress ? "0" : decision.amount;
  return decision.value ?? "0";
}

export class KeeperHubClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = BASE_URL,
  ) {
    if (!apiKey?.startsWith("kh_")) throw new Error("KeeperHub org API key (kh_...) required");
  }

  private async call(method: string, path: string, body?: unknown, idempotencyKey?: string) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { res, parsed };
  }

  /**
   * Dry run. `simulate` must be a strict boolean — KeeperHub rejects "true"
   * with a 400 specifically so a stringly-typed caller cannot fall through to
   * a real broadcast.
   *
   * A would-revert answer comes back as HTTP 400 with a populated body, which
   * is a normal outcome here, not a transport failure.
   */
  async simulate(decision: Decision): Promise<SimulateResponse> {
    const { path, body } = toRequest(decision);
    const { res, parsed } = await this.call("POST", path, { ...body, simulate: true });
    const payload = parsed as SimulateResponse;
    if (payload && typeof payload === "object" && "wouldRevert" in payload) return payload;
    throw new KeeperHubError(`simulate failed (HTTP ${res.status})`, res.status, parsed);
  }

  async execute(decision: Decision, idempotencyKey: string): Promise<ExecuteResponse> {
    const { path, body } = toRequest(decision);
    const { res, parsed } = await this.call("POST", path, body, idempotencyKey);
    if (!res.ok) {
      const b = parsed as { code?: string; originalExecutionId?: string };
      if (res.status === 409 && b?.code === "idempotency_conflict") {
        throw new KeeperHubError(
          `idempotency conflict: key already used for a different body (original ${b.originalExecutionId})`,
          409,
          parsed,
        );
      }
      throw new KeeperHubError(`execute failed (HTTP ${res.status})`, res.status, parsed);
    }
    return parsed as ExecuteResponse;
  }

  async status(executionId: string): Promise<{ body: StatusResponse; pollHintSeconds: number }> {
    const { res, parsed } = await this.call("GET", `/api/execute/${executionId}/status`);
    if (!res.ok) throw new KeeperHubError(`status failed (HTTP ${res.status})`, res.status, parsed);
    const hint = Number(res.headers.get("x-poll-interval-hint") ?? "1");
    return { body: parsed as StatusResponse, pollHintSeconds: Number.isFinite(hint) ? hint : 1 };
  }

  /** Poll until terminal, honouring X-Poll-Interval-Hint (0 means stop). */
  async waitForSettlement(executionId: string, timeoutMs = 120_000): Promise<StatusResponse> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { body, pollHintSeconds } = await this.status(executionId);
      if (body.status === "completed" || body.status === "failed") return body;
      if (Date.now() > deadline) throw new KeeperHubError(`timed out waiting for ${executionId}`, 408, body);
      await new Promise((r) => setTimeout(r, Math.max(pollHintSeconds, 1) * 1000));
    }
  }
}
