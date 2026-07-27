/**
 * These tests speak actual MCP over actual stdio to the actual entrypoint —
 * spawned as a subprocess, handshaken with the reference client. Nothing here
 * pokes the server object directly, because the thing being tested is whether a
 * real MCP client can reach the guard, not whether the functions compose.
 *
 * No network is touched: every path exercised here is refused or answered
 * before the guard would call KeeperHub, which is exactly why the API key below
 * can be a fake one. If a change ever lets a refused decision reach the wire,
 * these tests fail with a connection error instead of a refusal — which is the
 * failure mode worth having.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ALLOWED = "0x90EE1EbcCFA2021711C595E1410e22401570B4AC";
const ELSEWHERE = "0x000000000000000000000000000000000000dEaD";

let client: Client;
let ledgerPath: string;

const call = async (name: string, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) };
};

beforeEach(async () => {
  ledgerPath = join(mkdtempSync(join(tmpdir(), "keeperguard-mcp-")), "audit.jsonl");
  client = new Client({ name: "keeperguard-tests", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "bun",
      args: [join(import.meta.dir, "..", "bin", "mcp-server.ts")],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        KEEPERHUB_API_KEY: "kh_test_never_used_no_network_path_is_exercised",
        KEEPERGUARD_MAX_PER_ACTION: "0.001",
        KEEPERGUARD_MAX_PER_DAY: "0.002",
        KEEPERGUARD_ALLOWED_DESTINATIONS: ALLOWED,
        KEEPERGUARD_LEDGER: ledgerPath,
        KEEPERGUARD_AGENT: "test-agent",
      },
      stderr: "ignore",
    }),
  );
});

afterEach(async () => {
  await client.close();
});

test("a real MCP client can list the guard's tools", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    "keeperhub_audit_log",
    "keeperhub_check_policy",
    "keeperhub_execute_contract_call",
    "keeperhub_execute_transfer",
  ]);
  // The execute tools must state what they need, or a model will guess.
  const transfer = tools.find((t) => t.name === "keeperhub_execute_transfer")!;
  expect(transfer.inputSchema.required).toEqual(["recipientAddress", "amount", "reason"]);
});

test("check_policy prices an action without touching the network or the ledger", async () => {
  const under = await call("keeperhub_check_policy", { recipientAddress: ALLOWED, amount: "0.0001" });
  expect(under.isError).toBe(false);
  expect(under.body.allowed).toBe(true);
  expect(under.body.spentLast24hWei).toBe("0");

  const over = await call("keeperhub_check_policy", { recipientAddress: ALLOWED, amount: "5" });
  expect(over.body.allowed).toBe(false);
  expect(over.body.problems.join(" ")).toContain("maxValuePerAction");

  // A probe is not an event: nothing was written.
  const log = await call("keeperhub_audit_log", {});
  expect(log.body.total).toBe(0);
});

test("an over-cap transfer is refused as a tool error, before any network call", async () => {
  const res = await call("keeperhub_execute_transfer", {
    recipientAddress: ALLOWED,
    amount: "10",
    reason: "test: over the per-action cap",
  });
  expect(res.isError).toBe(true);
  expect(res.body.error).toBe("policy_violation");
  expect(res.body.problems.join(" ")).toContain("exceeds maxValuePerAction");

  // The refusal is recorded, and it never got as far as simulating.
  const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(rows.map((r) => r.phase)).toEqual(["refused"]);
  expect(rows[0].agent).toBe("test-agent");
});

test("a destination outside the allowlist is refused even when the amount fits", async () => {
  const res = await call("keeperhub_execute_transfer", {
    recipientAddress: ELSEWHERE,
    amount: "0.0000001",
    reason: "test: exfiltrate to an address the operator never approved",
  });
  expect(res.isError).toBe(true);
  expect(res.body.problems.join(" ")).toContain("not on allowlist");
});

test("a contract call on a chain the operator did not allow is refused", async () => {
  const res = await call("keeperhub_execute_contract_call", {
    contractAddress: ALLOWED,
    functionName: "approve(address,uint256)",
    chainId: 1,
    reason: "test: wrong chain",
  });
  expect(res.isError).toBe(true);
  expect(res.body.problems.join(" ")).toContain("not in allowedChainIds");
});

test("the audit log returns a verifiable chain of everything, refusals included", async () => {
  await call("keeperhub_execute_transfer", { recipientAddress: ELSEWHERE, amount: "0.0000001", reason: "one" });
  await call("keeperhub_execute_transfer", { recipientAddress: ALLOWED, amount: "10", reason: "two" });

  const log = await call("keeperhub_audit_log", {});
  expect(log.body.chain).toEqual({ ok: true, count: 2 });
  expect(log.body.total).toBe(2);
  expect(log.body.records.map((r: { phase: string }) => r.phase)).toEqual(["refused", "refused"]);
  expect(log.body.records[0].prevHash).toBe("genesis");
  expect(log.body.records[1].prevHash).toBe(log.body.records[0].hash);
});

test("an unknown tool is an error, not a crash", async () => {
  await expect(client.callTool({ name: "keeperhub_drain_everything", arguments: {} })).rejects.toThrow();
});
