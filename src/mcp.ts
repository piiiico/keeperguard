/**
 * keeperguard as an MCP server.
 *
 * The library form of this project asks the agent's *code* to call the guard.
 * That is fine when you wrote the agent. It is worthless when the agent is a
 * model with tools, because the model can only do what its tools let it do —
 * and if the tool is KeeperHub's execute endpoint, the spend limit lives in the
 * prompt. A prompt is a suggestion. A tool boundary is not.
 *
 * So this exposes the guard itself as the tool surface. The model never sees an
 * execute endpoint; it sees `keeperhub_execute_transfer`, and the cap it cannot
 * exceed is enforced in this process, from a policy loaded before the first
 * token was generated. Injected instructions, a jailbroken system prompt and an
 * honest mistake all hit the same wall, and all three land in the same
 * hash-chained ledger the operator can read afterwards.
 *
 * Refusals come back as tool errors rather than protocol errors on purpose: the
 * model should be able to read "over the per-action cap of 0.00005" and retry
 * smaller, not lose the connection.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AuditLedger } from "./audit.ts";
import { ExecutionGuard, PolicyViolation } from "./guard.ts";
import type { Decision, Policy } from "./types.ts";

export type GuardServerOptions = {
  guard: ExecutionGuard;
  ledger: AuditLedger;
  policy: Policy;
  /** Used when a tool call omits `chainId`. Must be in policy.allowedChainIds. */
  defaultChainId: number;
  /** Recorded in every ledger row. Identifies *which* agent spent. */
  agent: string;
};

const decisionCore = {
  reason: {
    type: "string",
    description:
      "Why this action, in the agent's own words. Part of the idempotency fingerprint: the same " +
      "action for a genuinely different reason is a new decision and is allowed to spend again.",
  },
  epoch: {
    type: "string",
    description:
      "Optional occurrence marker (a date bucket, invoice id, block number). Omit it and this " +
      "decision can only ever execute once for the lifetime of the ledger.",
  },
  chainId: { type: "number", description: "EVM chain id. Defaults to the server's configured chain." },
} as const;

const TOOLS = [
  {
    name: "keeperhub_execute_transfer",
    description:
      "Move value onchain through KeeperHub, behind the guard: policy caps are checked before any " +
      "network call, the exact body is simulated before it is broadcast, and the Idempotency-Key is " +
      "derived from the decision so a retried turn converges on the original transaction instead of " +
      "sending a second one. Returns the settled transaction hash.",
    inputSchema: {
      type: "object",
      properties: {
        recipientAddress: { type: "string", description: "0x-prefixed destination address." },
        amount: { type: "string", description: 'Amount in whole units, as a string. e.g. "0.0001". "0" is valid.' },
        tokenAddress: { type: "string", description: "ERC-20 contract. Omit for the chain's native asset." },
        ...decisionCore,
      },
      required: ["recipientAddress", "amount", "reason"],
    },
  },
  {
    name: "keeperhub_execute_contract_call",
    description:
      "Call a contract function onchain through KeeperHub, behind the same guard as transfers " +
      "(policy, simulate-before-broadcast, decision-derived idempotency, audit row).",
    inputSchema: {
      type: "object",
      properties: {
        contractAddress: { type: "string", description: "0x-prefixed contract address." },
        functionName: { type: "string", description: 'Function signature or name, e.g. "approve(address,uint256)".' },
        functionArgs: { type: "string", description: "Arguments, encoded the way KeeperHub expects them." },
        value: { type: "string", description: 'Native value to attach, in whole units. Defaults to "0".' },
        ...decisionCore,
      },
      required: ["contractAddress", "functionName", "reason"],
    },
  },
  {
    name: "keeperhub_check_policy",
    description:
      "Ask what the guard would do with a decision without touching the network or the ledger. " +
      "Returns the active policy, the remaining 24h allowance, and the exact refusal reasons if any. " +
      "Use this to size an action before proposing it.",
    inputSchema: {
      type: "object",
      properties: {
        recipientAddress: { type: "string", description: "Destination for a transfer." },
        contractAddress: { type: "string", description: "Destination for a contract call." },
        amount: { type: "string", description: "Native amount in whole units. Defaults to 0." },
        chainId: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "keeperhub_audit_log",
    description:
      "Read the hash-chained execution ledger and recompute it. Every phase of every decision this " +
      "server handled is here — including the ones it refused. Tamper-evident, not tamper-proof: a " +
      "broken chain proves an edit happened.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Most recent N rows. Default 20." },
      },
      required: [],
    },
  },
] as const;

const ok = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] });
const fail = (payload: unknown) => ({ ...ok(payload), isError: true });

export function createGuardServer(opts: GuardServerOptions): Server {
  const { guard, ledger, policy, defaultChainId, agent } = opts;

  const server = new Server(
    { name: "keeperguard", version: "0.2.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Onchain execution through KeeperHub, behind a policy the model cannot change. Call " +
        "keeperhub_check_policy first if you are unsure an action fits; a refusal is final and " +
        "retrying the identical decision will not produce a second transaction.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as typeof TOOLS[number][] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = (req.params.arguments ?? {}) as Record<string, unknown>;
    const chainId = typeof a.chainId === "number" ? a.chainId : defaultChainId;

    try {
      switch (req.params.name) {
        case "keeperhub_check_policy": {
          const target = String(a.recipientAddress ?? a.contractAddress ?? "0x");
          const probe: Decision = {
            intent: "transfer",
            agent,
            chainId,
            recipientAddress: target,
            amount: String(a.amount ?? "0"),
            reason: "policy probe (not executed)",
          };
          const problems = guard.check(probe);
          const spent = ledger.spentWeiSince(new Date(Date.now() - 24 * 60 * 60 * 1000));
          return ok({ allowed: problems.length === 0, problems, policy, spentLast24hWei: spent.toString() });
        }

        case "keeperhub_audit_log": {
          const limit = typeof a.limit === "number" ? a.limit : 20;
          const rows = ledger.read();
          return ok({ chain: ledger.verify(), total: rows.length, records: rows.slice(-limit) });
        }

        case "keeperhub_execute_transfer": {
          const decision: Decision = {
            intent: "transfer",
            agent,
            chainId,
            recipientAddress: String(a.recipientAddress),
            amount: String(a.amount),
            ...(a.tokenAddress ? { tokenAddress: String(a.tokenAddress) } : {}),
            reason: String(a.reason),
            ...(a.epoch ? { epoch: String(a.epoch) } : {}),
          };
          return ok(await guard.execute(decision));
        }

        case "keeperhub_execute_contract_call": {
          const decision: Decision = {
            intent: "contract-call",
            agent,
            chainId,
            contractAddress: String(a.contractAddress),
            functionName: String(a.functionName),
            ...(a.functionArgs ? { functionArgs: String(a.functionArgs) } : {}),
            ...(a.value ? { value: String(a.value) } : {}),
            reason: String(a.reason),
            ...(a.epoch ? { epoch: String(a.epoch) } : {}),
          };
          return ok(await guard.execute(decision));
        }

        default:
          // A tool that does not exist is a protocol-level mistake, not a
          // failed execution — `isError` would tell the model to try again.
          throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${req.params.name}`);
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      // A refusal is a normal outcome the model is expected to read and adapt
      // to, so it comes back as a tool error, not a dropped connection.
      if (err instanceof PolicyViolation) {
        return fail({ error: "policy_violation", problems: err.message.split("; "), policy });
      }
      return fail({ error: "execution_failed", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  return server;
}
