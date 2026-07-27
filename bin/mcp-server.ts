#!/usr/bin/env bun
/**
 * stdio entrypoint for the keeperguard MCP server.
 *
 *   KEEPERHUB_API_KEY=kh_... \
 *   KEEPERGUARD_MAX_PER_ACTION=0.0001 \
 *   KEEPERGUARD_MAX_PER_DAY=0.0005 \
 *   KEEPERGUARD_ALLOWED_DESTINATIONS=0xabc...,0xdef... \
 *   bun bin/mcp-server.ts
 *
 * Drop that into any MCP client (Claude Code / Cursor / ElizaOS / your own) as
 * a stdio server and the agent gets onchain execution it cannot exceed.
 *
 * It fails closed. There is no default spend cap: a server started without
 * KEEPERGUARD_MAX_PER_ACTION and KEEPERGUARD_MAX_PER_DAY exits before it
 * speaks protocol, because a guard with an implicit "unlimited" default is
 * worse than no guard — it reads as protection while being none.
 *
 * Everything diagnostic goes to stderr. stdout belongs to the protocol.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuditLedger } from "../src/audit.ts";
import { ExecutionGuard } from "../src/guard.ts";
import { KeeperHubClient } from "../src/keeperhub.ts";
import { createGuardServer } from "../src/mcp.ts";
import type { Policy } from "../src/types.ts";

const die = (msg: string): never => {
  console.error(`keeperguard-mcp: ${msg}`);
  process.exit(1);
};

const apiKey = process.env.KEEPERHUB_API_KEY ?? die("set KEEPERHUB_API_KEY (org key, kh_ prefix)");
const maxPerAction = process.env.KEEPERGUARD_MAX_PER_ACTION ?? die("set KEEPERGUARD_MAX_PER_ACTION (whole units, e.g. 0.0001)");
const maxPerDay = process.env.KEEPERGUARD_MAX_PER_DAY ?? die("set KEEPERGUARD_MAX_PER_DAY (whole units, e.g. 0.0005)");

const chainId = Number(process.env.KEEPERGUARD_CHAIN_ID ?? 8453); // Base mainnet
const allowedChainIds = (process.env.KEEPERGUARD_ALLOWED_CHAINS ?? String(chainId))
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));
if (!allowedChainIds.includes(chainId)) die(`default chain ${chainId} is not in KEEPERGUARD_ALLOWED_CHAINS`);

const allowedDestinations = (process.env.KEEPERGUARD_ALLOWED_DESTINATIONS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const policy: Policy = {
  allowedChainIds,
  maxValuePerAction: maxPerAction,
  maxValuePerDay: maxPerDay,
  ...(allowedDestinations.length ? { allowedDestinations } : {}),
};

const ledgerPath = process.env.KEEPERGUARD_LEDGER ?? "./keeperguard-audit.jsonl";
const ledger = new AuditLedger(ledgerPath);
const guard = new ExecutionGuard(new KeeperHubClient(apiKey), ledger, policy);
const agent = process.env.KEEPERGUARD_AGENT ?? "mcp-client";

console.error(
  `keeperguard-mcp: chain ${chainId} (allowed ${allowedChainIds.join(",")}), ` +
    `${maxPerAction}/action, ${maxPerDay}/24h, ` +
    `${allowedDestinations.length ? `${allowedDestinations.length} allowed destination(s)` : "no destination allowlist"}, ` +
    `ledger ${ledgerPath}`,
);

await createGuardServer({ guard, ledger, policy, defaultChainId: chainId, agent }).connect(new StdioServerTransport());
