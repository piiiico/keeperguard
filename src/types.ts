/**
 * A decision is what the agent *chose to do*, expressed without any
 * transport detail. Everything in here is hashed, so two fields matter a lot:
 *
 *  - `reason` is included deliberately. An agent that re-derives the same
 *    action for a *different* reason has made a new decision and should be
 *    allowed to spend again.
 *  - `epoch` is the caller's explicit "this is a new occurrence" marker
 *    (a date bucket, an invoice id, a block number). Omit it and the decision
 *    is a one-shot for the lifetime of the ledger.
 */
export type Decision =
  | {
      intent: "transfer";
      agent: string;
      chainId: number;
      recipientAddress: string;
      amount: string;
      tokenAddress?: string;
      reason: string;
      epoch?: string;
    }
  | {
      intent: "contract-call";
      agent: string;
      chainId: number;
      contractAddress: string;
      functionName: string;
      functionArgs?: string;
      value?: string;
      reason: string;
      epoch?: string;
    };

export type Policy = {
  /** Chain ids the agent may touch at all. */
  allowedChainIds: number[];
  /** Hard ceiling on native value per single action, in ether units. */
  maxValuePerAction: string;
  /** Rolling 24h ceiling on native value actually broadcast, in ether units. */
  maxValuePerDay: string;
  /**
   * Optional destination allowlist (case-insensitive). When set, any recipient
   * or contract outside it is refused before the network is ever touched.
   */
  allowedDestinations?: string[];
};

export type Phase =
  | "refused" // policy said no; nothing was sent
  | "replayed" // ledger already had a settled execution for this decision
  | "simulated" // dry run passed
  | "reverted" // dry run said the chain would reject it
  | "broadcast" // handed to KeeperHub with an Idempotency-Key
  | "settled" // terminal state reached, hash recorded
  | "failed"; // terminal state reached, execution failed

export type LedgerRecord = {
  seq: number;
  ts: string;
  phase: Phase;
  agent: string;
  decisionHash: string;
  idempotencyKey: string;
  chainId: number;
  target: string;
  /** Native value in wei, as reported by KeeperHub's simulation/settlement. */
  valueWei?: string;
  executionId?: string;
  transactionHash?: string;
  transactionLink?: string;
  detail?: string;
  prevHash: string;
  hash: string;
};

export type GuardResult = {
  phase: Phase;
  decisionHash: string;
  idempotencyKey: string;
  executionId?: string;
  transactionHash?: string;
  transactionLink?: string;
  detail?: string;
  /** True when this call did NOT produce a new onchain transaction. */
  deduplicated: boolean;
};
