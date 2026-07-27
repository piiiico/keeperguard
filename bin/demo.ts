#!/usr/bin/env bun
/**
 * Live demo. This is the script that produced the transaction linked in the
 * README — it is not a transcript, it runs against Base mainnet for real.
 *
 *   KEEPERHUB_API_KEY=kh_... bun bin/demo.ts
 *
 * Four things happen, in this order:
 *   1. A decision that breaks the spend cap is refused before any network call.
 *   2. A decision inside the cap is simulated, then broadcast, then settled.
 *   3. The *same* decision is submitted again, the way a crashed-and-restarted
 *      agent turn would submit it. No second transaction is produced.
 *   4. The audit chain is verified, then deliberately tampered with in memory
 *      to show the verification actually fails when it should.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLedger } from "../src/audit.ts";
import { ExecutionGuard, PolicyViolation } from "../src/guard.ts";
import { KeeperHubClient } from "../src/keeperhub.ts";
import type { Decision, Policy } from "../src/types.ts";

const apiKey = process.env.KEEPERHUB_API_KEY;
if (!apiKey) {
  console.error("set KEEPERHUB_API_KEY (org key, kh_ prefix)");
  process.exit(1);
}

// Where the value goes. Defaults to the funding wallet used in the recorded run.
const RECIPIENT = process.env.KEEPERGUARD_RECIPIENT ?? "0x90EE1EbcCFA2021711C595E1410e22401570B4AC";
const CHAIN_ID = Number(process.env.KEEPERGUARD_CHAIN_ID ?? 8453); // Base mainnet
const ledgerPath = process.env.KEEPERGUARD_LEDGER ?? join(mkdtempSync(join(tmpdir(), "keeperguard-")), "audit.jsonl");

const policy: Policy = {
  allowedChainIds: [CHAIN_ID],
  maxValuePerAction: "0.00005",
  maxValuePerDay: "0.0001",
  allowedDestinations: [RECIPIENT],
};

const ledger = new AuditLedger(ledgerPath);
const guard = new ExecutionGuard(new KeeperHubClient(apiKey), ledger, policy);

const line = (s: string) => console.log(s);
const rule = () => line("─".repeat(72));

line(`keeperguard demo — chain ${CHAIN_ID}, ledger ${ledgerPath}`);
line(`policy: ${policy.maxValuePerAction} per action, ${policy.maxValuePerDay} rolling 24h, 1 allowed destination`);

// ── 1. over-cap decision is refused before the network is touched ────────────
rule();
line("1. a decision that breaks the spend cap");
const tooBig: Decision = {
  intent: "transfer",
  agent: "pico",
  chainId: CHAIN_ID,
  recipientAddress: RECIPIENT,
  amount: "0.5",
  reason: "demo: deliberately over the per-action cap",
};
try {
  await guard.execute(tooBig);
  line("   UNEXPECTED: the guard let this through");
  process.exit(1);
} catch (err) {
  if (!(err instanceof PolicyViolation)) throw err;
  line(`   refused, no network call made: ${err.message}`);
}

// ── 2. the real thing ────────────────────────────────────────────────────────
rule();
line("2. a decision inside the caps — simulate, broadcast, settle");
const decision: Decision = {
  intent: "transfer",
  agent: "pico",
  chainId: CHAIN_ID,
  recipientAddress: RECIPIENT,
  amount: "0.00001",
  reason: "keeperguard reference execution",
  epoch: process.env.KEEPERGUARD_EPOCH ?? "2026-07-27",
};
const first = await guard.execute(decision);
line(`   decision hash   ${first.decisionHash}`);
line(`   idempotency key ${first.idempotencyKey}   (derived, not generated)`);
line(`   execution       ${first.executionId}`);
line(`   tx              ${first.transactionHash}`);
line(`   ${first.transactionLink}`);

// ── 3. the same decision again, as a retried agent turn ──────────────────────
rule();
line("3. the same decision resubmitted (crashed agent turn, restarted)");
const second = await guard.execute(decision);
line(`   idempotency key ${second.idempotencyKey}   ${second.idempotencyKey === first.idempotencyKey ? "(identical)" : "(DIFFERENT — bug)"}`);
line(`   phase           ${second.phase}`);
line(`   deduplicated    ${second.deduplicated}`);
line(`   tx              ${second.transactionHash}`);
if (!second.deduplicated || second.transactionHash !== first.transactionHash) {
  line("   UNEXPECTED: a second transaction was produced");
  process.exit(1);
}
line("   no second transaction was broadcast (stopped locally, by the ledger)");

// ── 3b. the same again, with the local ledger bypassed ───────────────────────
// The step above never reaches the network, so on its own it proves only that
// *our* ledger works. Go around it and confirm KeeperHub's own idempotency
// layer holds too, otherwise the guarantee is only as good as one JSONL file.
rule();
line("3b. same key, same body, local short-circuit bypassed");
const client = new KeeperHubClient(apiKey);
const remote = await client.execute(decision, first.idempotencyKey!);
line(`   execution       ${remote.executionId}   ${remote.executionId === first.executionId ? "(original returned, nothing re-executed)" : "(DIFFERENT — a second execution)"}`);
if (remote.executionId !== first.executionId) process.exit(1);

line("3c. same key, different body — must be rejected, not silently replayed");
try {
  await client.execute({ ...decision, amount: "0.00002" }, first.idempotencyKey!);
  line("   UNEXPECTED: the conflicting request was accepted");
  process.exit(1);
} catch (err) {
  line(`   rejected: ${err instanceof Error ? err.message : String(err)}`);
}

// ── 4. the audit chain ───────────────────────────────────────────────────────
rule();
line("4. audit chain");
for (const r of ledger.read()) {
  line(`   #${r.seq} ${r.phase.padEnd(10)} ${r.hash.slice(0, 12)}…  ${r.detail ?? ""}`);
}
const verified = ledger.verify();
line(`   verify: ${JSON.stringify(verified)}`);
if (!verified.ok) process.exit(1);

const raw = readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
const forged = JSON.parse(raw[0]!);
forged.detail = "tampered";
const tamperedPath = `${ledgerPath}.tampered`;
writeFileSync(tamperedPath, [JSON.stringify(forged), ...raw.slice(1)].join("\n") + "\n");
const tamperCheck = new AuditLedger(tamperedPath).verify();
line(`   after editing record #0: ${JSON.stringify(tamperCheck)}`);
if (tamperCheck.ok) {
  line("   UNEXPECTED: tampering was not detected");
  process.exit(1);
}
rule();
line("done.");
