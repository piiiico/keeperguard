/**
 * The guard: everything that has to happen between "the agent decided" and
 * "the chain saw it", when no human is watching.
 *
 * Order matters. Policy is checked before the network is touched at all, so a
 * decision that violates a cap costs nothing and leaks nothing. Simulation
 * happens before broadcast, on the *same body* that will be broadcast. The
 * Idempotency-Key is derived from the decision rather than generated, so the
 * dangerous case — an agent turn that crashes after broadcast and is retried —
 * converges on the original execution instead of a second transaction.
 */

import { AuditLedger, decisionHash, idempotencyKey } from "./audit.ts";
import { KeeperHubClient, nativeValueOf, targetOf, KeeperHubError } from "./keeperhub.ts";
import type { Decision, GuardResult, Policy } from "./types.ts";

/** ether string -> wei, without pulling in a web3 library for one conversion. */
export function toWei(ether: string): bigint {
  const [whole, frac = ""] = ether.trim().split(".");
  if (!/^\d+$/.test(whole ?? "") || (frac && !/^\d+$/.test(frac))) throw new Error(`bad amount: ${ether}`);
  return BigInt(whole ?? "0") * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18) || "0");
}

export class PolicyViolation extends Error {}

export class ExecutionGuard {
  constructor(
    private readonly client: KeeperHubClient,
    private readonly ledger: AuditLedger,
    private readonly policy: Policy,
  ) {}

  /** Reasons this decision must not reach the network. Empty array = allowed. */
  check(decision: Decision): string[] {
    const problems: string[] = [];
    const target = targetOf(decision);
    const valueWei = toWei(nativeValueOf(decision));

    if (!this.policy.allowedChainIds.includes(decision.chainId)) {
      problems.push(`chain ${decision.chainId} not in allowedChainIds [${this.policy.allowedChainIds}]`);
    }
    if (this.policy.allowedDestinations?.length) {
      const allow = this.policy.allowedDestinations.map((d) => d.toLowerCase());
      if (!allow.includes(target.toLowerCase())) problems.push(`destination ${target} not on allowlist`);
    }
    const perAction = toWei(this.policy.maxValuePerAction);
    if (valueWei > perAction) {
      problems.push(`value ${nativeValueOf(decision)} exceeds maxValuePerAction ${this.policy.maxValuePerAction}`);
    }
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const spent = this.ledger.spentWeiSince(dayAgo);
    const perDay = toWei(this.policy.maxValuePerDay);
    if (spent + valueWei > perDay) {
      problems.push(`rolling 24h spend would reach ${spent + valueWei} wei, over maxValuePerDay ${perDay} wei`);
    }
    return problems;
  }

  async execute(decision: Decision): Promise<GuardResult> {
    const dHash = decisionHash(decision);
    const key = idempotencyKey(decision);
    const target = targetOf(decision);
    const valueWei = toWei(nativeValueOf(decision)).toString();
    const common = {
      agent: decision.agent,
      decisionHash: dHash,
      idempotencyKey: key,
      chainId: decision.chainId,
      target,
      valueWei,
    };

    // 1. Policy, before any network call.
    const problems = this.check(decision);
    if (problems.length > 0) {
      this.ledger.append({ ...common, phase: "refused", detail: problems.join("; ") });
      throw new PolicyViolation(problems.join("; "));
    }

    // 2. Local replay short-circuit. If this exact decision already settled,
    //    do not even ask the network — KeeperHub's own idempotency window is
    //    24h, ours is the lifetime of the ledger.
    const settled = this.ledger.read().find((r) => r.decisionHash === dHash && r.phase === "settled");
    if (settled) {
      this.ledger.append({
        ...common,
        phase: "replayed",
        executionId: settled.executionId,
        transactionHash: settled.transactionHash,
        transactionLink: settled.transactionLink,
        detail: `already settled at seq ${settled.seq}`,
      });
      return {
        phase: "replayed",
        decisionHash: dHash,
        idempotencyKey: key,
        executionId: settled.executionId,
        transactionHash: settled.transactionHash,
        transactionLink: settled.transactionLink,
        deduplicated: true,
        detail: `replayed ledger seq ${settled.seq}`,
      };
    }

    // 3. Dry run the exact body we are about to send.
    const sim = await this.client.simulate(decision);
    if (!sim.success || sim.wouldRevert) {
      const reason = sim.revertReason ?? sim.error ?? "simulation failed";
      this.ledger.append({ ...common, phase: "reverted", detail: reason });
      throw new Error(`pre-flight simulation says this would revert: ${reason}`);
    }
    this.ledger.append({
      ...common,
      phase: "simulated",
      valueWei: sim.value ?? valueWei,
      detail: `from ${sim.from} gasEstimate ${sim.gasEstimate ?? "?"}`,
    });

    // 4. Broadcast, keyed on the decision itself.
    let exec: { executionId: string; status: string };
    try {
      exec = await this.client.execute(decision, key);
    } catch (err) {
      const detail = err instanceof KeeperHubError ? `${err.message} :: ${JSON.stringify(err.body)}` : String(err);
      this.ledger.append({ ...common, phase: "failed", detail });
      throw err;
    }
    this.ledger.append({ ...common, phase: "broadcast", executionId: exec.executionId, detail: `status ${exec.status}` });

    // 5. Settle and record the onchain proof.
    const final = await this.client.waitForSettlement(exec.executionId);
    const phase = final.status === "completed" ? "settled" : "failed";
    this.ledger.append({
      ...common,
      phase,
      executionId: final.executionId,
      transactionHash: final.transactionHash,
      transactionLink: final.transactionLink,
      detail: final.error ?? `gasUsedWei ${final.gasUsedWei ?? "?"}`,
    });
    if (phase === "failed") throw new Error(`execution ${exec.executionId} failed: ${final.error}`);

    return {
      phase: "settled",
      decisionHash: dHash,
      idempotencyKey: key,
      executionId: final.executionId,
      transactionHash: final.transactionHash,
      transactionLink: final.transactionLink,
      deduplicated: false,
    };
  }
}
