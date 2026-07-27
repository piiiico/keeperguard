import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLedger, canonicalize, decisionHash, idempotencyKey } from "./audit.ts";
import { ExecutionGuard, PolicyViolation, toWei } from "./guard.ts";
import { KeeperHubClient } from "./keeperhub.ts";
import type { Decision, Policy } from "./types.ts";

const ledgerPath = () => join(mkdtempSync(join(tmpdir(), "kg-test-")), "audit.jsonl");

const base: Decision = {
  intent: "transfer",
  agent: "test",
  chainId: 8453,
  recipientAddress: "0x90EE1EbcCFA2021711C595E1410e22401570B4AC",
  amount: "0.00001",
  reason: "unit test",
};

describe("canonical hashing", () => {
  test("key order does not change the hash", () => {
    expect(canonicalize({ a: 1, b: [2, { d: 4, c: 3 }] })).toBe(canonicalize({ b: [2, { c: 3, d: 4 }], a: 1 }));
  });

  test("same decision yields the same idempotency key", () => {
    const reordered = { reason: base.reason, amount: base.amount, agent: base.agent, chainId: base.chainId, recipientAddress: base.recipientAddress, intent: base.intent } as Decision;
    expect(idempotencyKey(reordered)).toBe(idempotencyKey(base));
  });

  test("a different reason is a different decision", () => {
    expect(idempotencyKey({ ...base, reason: "something else" })).not.toBe(idempotencyKey(base));
  });

  test("a different amount is a different decision", () => {
    expect(decisionHash({ ...base, amount: "0.00002" })).not.toBe(decisionHash(base));
  });

  test("key is UUID-shaped", () => {
    expect(idempotencyKey(base)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("audit ledger", () => {
  test("chain verifies, and breaks when a record is edited", async () => {
    const path = ledgerPath();
    const ledger = new AuditLedger(path);
    for (const phase of ["simulated", "broadcast", "settled"] as const) {
      ledger.append({ phase, agent: "test", decisionHash: "d", idempotencyKey: "k", chainId: 8453, target: "0x0", valueWei: "10" });
    }
    expect(ledger.verify()).toEqual({ ok: true, count: 3 });

    const raw = (await Bun.file(path).text()).trimEnd().split("\n");
    const forged = JSON.parse(raw[1]!);
    forged.valueWei = "999999";
    const tampered = `${path}.t`;
    await Bun.write(tampered, [raw[0], JSON.stringify(forged), raw[2]].join("\n") + "\n");
    const result = new AuditLedger(tampered).verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAt).toBe(1);
  });

  test("rolling spend only counts settled records", () => {
    const ledger = new AuditLedger(ledgerPath());
    const common = { agent: "t", decisionHash: "d", idempotencyKey: "k", chainId: 8453, target: "0x0" };
    ledger.append({ ...common, phase: "simulated", valueWei: "100" });
    ledger.append({ ...common, phase: "settled", valueWei: "100" });
    ledger.append({ ...common, phase: "refused", valueWei: "5000" });
    expect(ledger.spentWeiSince(new Date(Date.now() - 60_000))).toBe(100n);
  });
});

describe("policy", () => {
  const policy: Policy = {
    allowedChainIds: [8453],
    maxValuePerAction: "0.00005",
    maxValuePerDay: "0.0001",
    allowedDestinations: [base.recipientAddress],
  };
  const guard = () => new ExecutionGuard(new KeeperHubClient("kh_test"), new AuditLedger(ledgerPath()), policy);

  test("allows a compliant decision", () => {
    expect(guard().check(base)).toEqual([]);
  });

  test("blocks an unlisted chain", () => {
    expect(guard().check({ ...base, chainId: 1 })[0]).toContain("not in allowedChainIds");
  });

  test("blocks an unlisted destination, case-insensitively allowing the listed one", () => {
    expect(guard().check({ ...base, recipientAddress: "0xdead" })[0]).toContain("not on allowlist");
    expect(guard().check({ ...base, recipientAddress: base.recipientAddress.toLowerCase() })).toEqual([]);
  });

  test("blocks an over-cap amount", () => {
    expect(guard().check({ ...base, amount: "0.5" })[0]).toContain("maxValuePerAction");
  });

  test("refusal is recorded and no network call is attempted", async () => {
    const path = ledgerPath();
    const ledger = new AuditLedger(path);
    const g = new ExecutionGuard(new KeeperHubClient("kh_test"), ledger, policy);
    await expect(g.execute({ ...base, amount: "0.5" })).rejects.toBeInstanceOf(PolicyViolation);
    const records = ledger.read();
    expect(records).toHaveLength(1);
    expect(records[0]!.phase).toBe("refused");
  });

  test("rolling daily cap counts prior settlements", async () => {
    const ledger = new AuditLedger(ledgerPath());
    ledger.append({ phase: "settled", agent: "t", decisionHash: "old", idempotencyKey: "k", chainId: 8453, target: base.recipientAddress, valueWei: toWei("0.000095").toString() });
    const g = new ExecutionGuard(new KeeperHubClient("kh_test"), ledger, policy);
    expect(g.check(base)[0]).toContain("maxValuePerDay");
  });
});

describe("toWei", () => {
  test("converts ether strings", () => {
    expect(toWei("1")).toBe(10n ** 18n);
    expect(toWei("0.00001")).toBe(10_000_000_000_000n);
    expect(toWei("0")).toBe(0n);
  });
  test("rejects junk", () => {
    expect(() => toWei("abc")).toThrow();
  });
});
