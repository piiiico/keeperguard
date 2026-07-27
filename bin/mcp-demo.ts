#!/usr/bin/env bun
/**
 * The MCP demo. A real MCP client, over real stdio, driving a real transaction
 * on Base mainnet — the same script that produced the receipt quoted in the
 * README. Nothing here is a transcript.
 *
 *   KEEPERHUB_API_KEY=kh_... bun bin/mcp-demo.ts
 *
 * Five steps, in the order that matters:
 *   1. handshake and list what the model would actually see
 *   2. price an action that is too big — refused without touching the network
 *   3. execute one that fits — settled onchain, hash returned
 *   4. submit the identical decision again, the way a retried agent turn does
 *   5. read the hash-chained ledger back and recompute it
 *
 * The default action is a zero-value transfer to the org's own wallet: it is a
 * real transaction on a real chain, and it moves nothing, so this file is safe
 * to run against a funded account.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const apiKey = process.env.KEEPERHUB_API_KEY;
if (!apiKey) {
  console.error("set KEEPERHUB_API_KEY (org key, kh_ prefix)");
  process.exit(1);
}

const CHAIN_ID = Number(process.env.KEEPERGUARD_CHAIN_ID ?? 8453);
/** Defaults to the org wallet, i.e. a self-transfer that moves nothing. */
const RECIPIENT = process.env.KEEPERGUARD_RECIPIENT ?? "0x0bdf11fd28778dd46a1f65d87f9cf65f6662dfbd";
const AMOUNT = process.env.KEEPERGUARD_AMOUNT ?? "0";
const ledgerPath = join(mkdtempSync(join(tmpdir(), "keeperguard-mcp-demo-")), "audit.jsonl");

const line = (s = "") => console.log(s);
const rule = () => line("─".repeat(72));

const client = new Client({ name: "keeperguard-demo", version: "0.2.0" });
await client.connect(
  new StdioClientTransport({
    command: "bun",
    args: [join(import.meta.dir, "mcp-server.ts")],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      KEEPERHUB_API_KEY: apiKey,
      KEEPERGUARD_CHAIN_ID: String(CHAIN_ID),
      KEEPERGUARD_MAX_PER_ACTION: "0.00005",
      KEEPERGUARD_MAX_PER_DAY: "0.0001",
      KEEPERGUARD_ALLOWED_DESTINATIONS: RECIPIENT,
      KEEPERGUARD_LEDGER: ledgerPath,
      KEEPERGUARD_AGENT: "mcp-demo",
    },
    stderr: "inherit",
  }),
);

const call = async (name: string, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) };
};

line(`keeperguard MCP demo — chain ${CHAIN_ID}, ledger ${ledgerPath}`);

// ── 1. what the model sees ───────────────────────────────────────────────────
rule();
line("1. tools/list — the whole surface an agent gets");
const { tools } = await client.listTools();
for (const t of tools) line(`   ${t.name}`);

// ── 2. an action that does not fit ───────────────────────────────────────────
rule();
line("2. keeperhub_check_policy on 1 ETH");
const priced = await call("keeperhub_check_policy", { recipientAddress: RECIPIENT, amount: "1" });
line(`   allowed: ${priced.body.allowed}`);
for (const p of priced.body.problems) line(`   refused: ${p}`);

// ── 3. one that does, executed for real ──────────────────────────────────────
rule();
line(`3. keeperhub_execute_transfer ${AMOUNT} to ${RECIPIENT}`);
const decision = {
  recipientAddress: RECIPIENT,
  amount: AMOUNT,
  reason: "keeperguard MCP demo: prove the guard is reachable over the protocol",
  epoch: new Date().toISOString().slice(0, 19),
};
const first = await call("keeperhub_execute_transfer", decision);
if (first.isError) {
  line(`   FAILED: ${JSON.stringify(first.body)}`);
  await client.close();
  process.exit(1);
}
line(`   phase:          ${first.body.phase}`);
line(`   executionId:    ${first.body.executionId}`);
line(`   transaction:    ${first.body.transactionHash}`);
line(`   deduplicated:   ${first.body.deduplicated}`);

// ── 4. the retried turn ──────────────────────────────────────────────────────
rule();
line("4. the identical decision, submitted again");
const second = await call("keeperhub_execute_transfer", decision);
line(`   phase:          ${second.body.phase}`);
line(`   transaction:    ${second.body.transactionHash}`);
line(`   deduplicated:   ${second.body.deduplicated}`);
line(
  second.body.transactionHash === first.body.transactionHash && second.body.deduplicated
    ? "   same hash, no second transaction"
    : "   MISMATCH — a retry produced a different execution",
);

// ── 5. the record ────────────────────────────────────────────────────────────
rule();
line("5. keeperhub_audit_log");
const log = await call("keeperhub_audit_log", {});
line(`   chain: ${JSON.stringify(log.body.chain)}`);
for (const r of log.body.records) line(`   #${r.seq} ${r.phase.padEnd(10)} ${r.transactionHash ?? r.detail ?? ""}`);

rule();
line(`verify independently: https://basescan.org/tx/${first.body.transactionHash}`);
await client.close();
