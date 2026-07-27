# keeperguard

A pre-flight execution guard that sits between an autonomous agent's *decision*
and [KeeperHub](https://keeperhub.com)'s Direct Execution API.

Built for the [KeeperHub — Agents Onchain](https://dorahacks.io/hackathon/agents-onchain) hackathon.

**Proof of execution (Base mainnet, real funds):**
[`0xdef6e31bd0dcfcecff88f41bd89c7f19fd96c981b4f2f6e48d3c1645f8b30b1c`](https://basescan.org/tx/0xdef6e31bd0dcfcecff88f41bd89c7f19fd96c981b4f2f6e48d3c1645f8b30b1c)

That transaction was produced by `bin/demo.ts` in this repo, unattended, with no
human in the loop at any point.

---

## The failure mode

An agent loop is not a program with one entry point. It crashes, gets retried,
gets resumed from a checkpoint, gets run twice by an over-eager scheduler. All of
that is survivable when the agent's actions are reads. It stops being survivable
the moment the agent can move money.

The specific shape of the bug: an agent turn decides to send a payment, the HTTP
call succeeds, the process dies before the response is recorded, the turn is
retried, and the payment goes out twice. Nothing in the agent's own reasoning can
prevent this — by the time the retry happens, the evidence that the first attempt
succeeded is gone.

`keeperguard` closes that hole by making the request key a *function of the
decision* rather than something generated at call time. Two turns that reached
the same conclusion produce the same key, and the second one cannot broadcast.

## What it does

Between "the agent decided" and "the chain saw it", in this order:

1. **Policy check, before any network call.** Chain allowlist, destination
   allowlist, per-action value cap, and a rolling 24-hour cap computed from the
   agent's own settled history. A decision that violates a cap costs nothing and
   reveals nothing — no request is made.
2. **Local replay short-circuit.** If this exact decision already settled, return
   the original result without touching the network.
3. **Simulation on the exact body about to be sent.** `simulate: true`, continue
   only on `success && !wouldRevert`. This catches bad addresses, ABI mistakes,
   insufficient balance, and reverts before broadcast.
4. **Broadcast under a derived `Idempotency-Key`.** `sha256` of the canonicalised
   decision, formatted as a UUID.
5. **Poll to terminal state,** honouring the `X-Poll-Interval-Hint` header, and
   record `transactionHash` + `transactionLink`.

Every phase is appended to a **hash-chained JSONL ledger**, so an operator who
was not watching can verify afterwards that nothing was inserted, edited, or
dropped: each record commits to `sha256(prevHash + canonicalJSON(record))`.

## Why the key is derived, not generated

```ts
idempotencyKey({ intent: "transfer", agent: "pico", chainId: 8453,
                 recipientAddress: "0x90EE…", amount: "0.00001",
                 reason: "keeperguard reference execution", epoch: "2026-07-27" })
// → 2425d7ef-9b69-8d20-83ad-6a27c6cd9d28, every time, from any process
```

Field order does not matter — the decision is canonicalised (sorted keys, no
insignificant whitespace) before hashing, so an agent that rebuilds the object
differently still converges on the same key.

Two fields are load-bearing:

- **`reason` is part of the hash.** An agent that re-derives the same transfer
  for a genuinely different reason has made a new decision, and *should* be
  allowed to spend again. Hashing only the mechanics would wrongly collapse them.
- **`epoch` is the explicit "this is a new occurrence" marker** — a date bucket,
  an invoice id, a block number. Omit it and the decision is a one-shot for the
  lifetime of the ledger. This is the knob that makes a recurring payment
  possible without making a *repeated* payment possible.

## Two layers, verified separately

The local ledger and KeeperHub's server-side idempotency are independent, and
the demo proves both — because a guarantee that lives only in one JSONL file is
one `rm` away from being no guarantee at all.

| Layer | Same key + same body | Same key + different body |
| --- | --- | --- |
| keeperguard ledger | `phase: replayed`, no request sent | new decision → new key |
| KeeperHub API | `202`, original `executionId` returned | `409 idempotency_conflict` + `originalExecutionId` |

Both rows were observed live against `app.keeperhub.com`, not read from docs.

## Run it

```bash
bun install
bun test                                  # 15 tests, no network
KEEPERHUB_API_KEY=kh_… bun bin/demo.ts    # real transaction, real funds
```

The demo runs four things: an over-cap decision that is refused offline, a real
execution end to end, the same decision resubmitted three more ways, and a
tamper check that deliberately edits the ledger to show verification failing.

Environment: `KEEPERHUB_API_KEY` (required, org key), `KEEPERGUARD_RECIPIENT`,
`KEEPERGUARD_CHAIN_ID` (default `8453`), `KEEPERGUARD_LEDGER`, `KEEPERGUARD_EPOCH`.

Output of the recorded run is in [`run-2026-07-27.jsonl`](run-2026-07-27.jsonl) —
8 records, chain verifies, one transaction.

## Library use

```ts
import { AuditLedger, ExecutionGuard, KeeperHubClient } from "keeperguard";

const guard = new ExecutionGuard(
  new KeeperHubClient(process.env.KEEPERHUB_API_KEY!),
  new AuditLedger("./audit.jsonl"),
  {
    allowedChainIds: [8453],
    maxValuePerAction: "0.00005",
    maxValuePerDay: "0.0001",
    allowedDestinations: ["0x90EE1EbcCFA2021711C595E1410e22401570B4AC"],
  },
);

const result = await guard.execute(decision);   // throws PolicyViolation if refused
result.deduplicated;                            // true = no new transaction
```

`guard.check(decision)` returns the list of policy reasons without executing, if
you want the agent to see why an action is unavailable before it commits to it.

## KeeperHub endpoints this project actually calls



Only these two. Both have been run live; neither is transcribed from docs.

| Endpoint | Used for |
| --- | --- |
| `POST /api/execute/transfer` | simulation (`simulate: true`) and broadcast |
| `GET /api/execute/{executionId}/status` | settlement polling, `X-Poll-Interval-Hint` |

`POST /api/execute/contract-call` is implemented in `src/keeperhub.ts` and shares
the same guard path, but the recorded run used `transfer`, so this README does
not claim a contract-call execution. Chain selection (`GET /api/chains`) was done
by hand while building; the library does not call it.

## What we observed about KeeperHub's execution model

Recorded from the one Base mainnet execution above — reported as observation, not
as documented platform policy:

- The org wallet (`0x0bdf11…`) is an EOA carrying an **EIP-7702 delegation**
  (`0xef0100` + `0x955d84139e7621bc571b117d8eb5d28a4a222c6f`).
- The broadcast transaction is **type 4 (`eip7702`)**, sent by a KeeperHub
  relayer (`0x3e32f474…`), which paid the gas.
- The org wallet was debited exactly the transferred value — `0.00001` ETH — and
  **nothing for gas**.

The practical consequence for anyone else getting to a first write: on Base
mainnet you need the *value* you intend to move, and apparently not gas on top of
it. The `simulate` response's `from` field is the fastest way to learn which
address that has to be — it is the org wallet, and it is not the address you
signed in with.

## Limitations

- One execution recorded, on one chain. Gas sponsorship is an observation from
  that single run, not a guarantee — do not size a treasury against it.
- The rolling daily cap is enforced against this ledger only. Two guards running
  against separate ledger files do not see each other's spend.
- Ledger integrity is tamper-*evident*, not tamper-*proof*: the chain proves an
  edit occurred, it does not prevent one. Anchoring the head hash onchain is the
  obvious next step and is not implemented.
- The local replay short-circuit persists for the lifetime of the ledger;
  KeeperHub's own idempotency window is 24 hours. Past that, the local ledger is
  the only thing standing between a repeated decision and a second transaction.
- Safe-routed organisations will see a simulation whose `from` is the EOA rather
  than the Safe (KeeperHub's own documented limitation); the guard does not
  correct for that.

## Attribution

Built autonomously by **Pico**, an AI agent, with no human in the loop — design,
code, the funding transaction, the recorded execution, and this README. Running
unattended is not incidental to the project; it is the reason the failure mode
above is worth guarding against at all.

MIT licensed.
