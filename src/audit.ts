/**
 * Deterministic hashing + a tamper-evident, append-only audit ledger.
 *
 * Two jobs:
 *   1. Turn an agent's *decision* into a stable fingerprint, so that the same
 *      decision replayed on a retried agent turn produces the same
 *      Idempotency-Key and therefore cannot broadcast twice.
 *   2. Record every phase of every action in a hash-chained JSONL file, so an
 *      operator who was not watching can verify afterwards that nothing was
 *      inserted, removed, or edited.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision, LedgerRecord, Phase } from "./types.ts";

/**
 * RFC 8785-style canonical JSON: object keys sorted, no insignificant
 * whitespace, undefined dropped. Without this, `{a:1,b:2}` and `{b:2,a:1}`
 * would hash differently and the idempotency guarantee would silently vanish.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Stable fingerprint of *what the agent decided to do*. */
export function decisionHash(decision: Decision): string {
  return sha256(canonicalize(decision));
}

/**
 * Format the decision hash as a UUID-shaped string (version nibble 8, per
 * RFC 9562 custom UUIDs). KeeperHub accepts any client-chosen string, but a
 * UUID shape is what its docs recommend and what its dashboard renders well.
 *
 * The point: this key is *derived*, never generated. A crashed-and-restarted
 * agent that re-reaches the same decision re-derives the same key and gets the
 * original execution back instead of a second transaction.
 */
export function idempotencyKey(decision: Decision): string {
  const h = decisionHash(decision);
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return [h.slice(0, 8), h.slice(8, 12), `8${h.slice(13, 16)}`, `${variant}${h.slice(17, 20)}`, h.slice(20, 32)].join("-");
}

/**
 * Append-only ledger where each record commits to its predecessor:
 *   hash = sha256(prevHash + canonical(record without `hash`))
 * Editing or dropping any earlier line breaks every hash after it.
 */
export class AuditLedger {
  constructor(private readonly path: string) {
    const dir = dirname(path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  read(): LedgerRecord[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as LedgerRecord);
  }

  append(entry: Omit<LedgerRecord, "seq" | "ts" | "prevHash" | "hash">): LedgerRecord {
    const prior = this.read();
    const prev = prior.at(-1);
    const base = {
      ...entry,
      seq: prior.length,
      ts: new Date().toISOString(),
      prevHash: prev?.hash ?? "genesis",
    };
    const record: LedgerRecord = { ...base, hash: sha256(base.prevHash + canonicalize(base)) };
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  /** Recompute the whole chain. Returns the first index that fails, or null. */
  verify(): { ok: true; count: number } | { ok: false; brokenAt: number; reason: string } {
    let prevHash = "genesis";
    const records = this.read();
    for (const [i, rec] of records.entries()) {
      if (rec.prevHash !== prevHash) return { ok: false, brokenAt: i, reason: "prevHash mismatch" };
      const { hash, ...base } = rec;
      if (sha256(prevHash + canonicalize(base)) !== hash) return { ok: false, brokenAt: i, reason: "content hash mismatch" };
      if (rec.seq !== i) return { ok: false, brokenAt: i, reason: "sequence gap" };
      prevHash = hash;
    }
    return { ok: true, count: records.length };
  }

  /** Every phase already recorded for a given decision fingerprint. */
  phasesFor(hash: string): Phase[] {
    return this.read().filter((r) => r.decisionHash === hash).map((r) => r.phase);
  }

  /** Native value (in wei) actually broadcast since `since`. Used for the rolling spend cap. */
  spentWeiSince(since: Date): bigint {
    return this.read()
      .filter((r) => r.phase === "settled" && new Date(r.ts) >= since)
      .reduce((sum, r) => sum + BigInt(r.valueWei ?? "0"), 0n);
  }
}
