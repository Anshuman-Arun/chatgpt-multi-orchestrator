# Agent B — Reliability / Persistence / YOLO Reuse Report

## Core model

The controller is a durable state machine with an unreliable DOM actuator/sensor.

Two rules dominate the design:

1. no browser-visible side effect occurs unless durable state committed beforehand authorizes that exact effect;
2. after the send boundary, absence of evidence is never treated as proof that Send did not happen.

The system therefore provides at-most-once automatic send attempts plus positive-receipt reconciliation, not exactly-once delivery.

## YOLO reuse

Reuse/adapt heavily:

- DOM-adapter separation from `platforms.js`;
- positive user-message receipt concept;
- route identity checks;
- draft protection;
- bounded hydration/generation settling;
- claimed/executing/unknown delivery semantics;
- idempotent completion after lost acknowledgements;
- tab-supervisor health/reinjection pattern;
- user-prompt ownership fingerprints.

Strengthen/replace:

- `chrome.storage.local` orchestration maps -> normalized IndexedDB;
- service-worker Promise locks -> IndexedDB transactions + durable fenced leases;
- bounded completion/event history -> retained Delivery records + append-only journal;
- weak text fingerprint -> Delivery ownership marker + SHA-256;
- resetting unknown delivery -> immutable unknown plus explicitly linked retry Delivery.

## IndexedDB

Authoritative stores should include at minimum:

- `meta`
- `runs`
- `logical_agents`
- `worker_slots`
- `conversation_bindings`
- `tasks`
- `deliveries`
- `leases`
- `worker_results`
- `orchestrator_inbox`
- `errors`
- `events`
- optional recovery checkpoints

The MV3 service worker is an executor, not the coordinator of record. Empty in-memory maps after restart mean nothing.

## Delivery state machine

Selected v0 lifecycle:

```text
PENDING
→ CLAIMED
→ COMPOSER_FILLING
→ COMPOSER_FILLED
→ SUBMITTING
→ SENT_UNCONFIRMED
→ DELIVERED
→ RESPONSE_STARTED
→ RESPONSE_RECEIVED
→ ACKED
```

Important side states include:

- `DELIVERY_UNKNOWN`
- `FAILED`
- `RESPONSE_FAILED`
- `RESPONSE_SUPERSEDED`

### Irreversible boundary

`COMPOSER_FILLED` is the last definitely-not-sent state.

`SUBMITTING` means the controller has durably authorized exactly one Send side effect. The production code path capable of invoking Send must be structurally inaccessible before this commit.

After recovery from `SUBMITTING` or later, negative DOM evidence cannot authorize an automatic resend.

## Delivery confirmation

`DELIVERED` requires positive evidence of a new owned user turn in the intended conversation:

- baseline user-turn sequence advanced;
- ownership marker / Delivery ID matches;
- normalized payload hash matches;
- route/conversation binding matches.

Composer clearing, lack of generation, error banners, and missing assistant output are not enough.

## Unknown delivery

An unresolved post-`SUBMITTING` outcome becomes `DELIVERY_UNKNOWN` and the lane pauses.

It never transitions automatically back to `PENDING`.

If the human explicitly accepts duplicate risk, create a **new** Delivery with:

```text
retry_of_delivery_id = original_delivery_id
```

The original unknown record remains immutable.

## Sender lease and fencing

One durable sender lease exists per conversation.

Lease transfer increments a fencing token. A stale content-script actor holding an older fence cannot advance durable state or send after a newer actor takes ownership.

Lease expiry after `SUBMITTING` permits reconciliation only, never resending the same Delivery.

## Result handoff

Capturing a worker result and delivering it to the orchestrator are separate durable state machines.

Transactionally:

1. capture worker response into `worker_results`;
2. enqueue a deduplicated `orchestrator_inbox` record;
3. mark the worker Delivery internally acknowledged;
4. later create a distinct `ORCHESTRATOR_EVENTS` Delivery.

Failure forwarding a result must never rerun the worker turn.

## Event journal

Append-only from the first implementation.

Every externally relevant durable transition commits its journal event in the same IndexedDB transaction.

Journal records include at least:

- monotonic `seq`;
- wall timestamp;
- browser boot / actor identity;
- run / agent / slot / conversation / task / Delivery identity;
- event type;
- previous / next state;
- reason;
- lease fence;
- compact DOM fingerprint.

No silent last-N truncation.

## Recovery algorithm

Every startup path:

```text
open IndexedDB
→ read durable state
→ discover/bind live tabs
→ read-only DOM reconciliation
→ reconcile existing Deliveries
→ only then schedule new side effects
```

Never reconstruct authoritative state from page appearance first.

## Hard invariants

- IndexedDB is authoritative.
- Every side effect has prior persisted authorization.
- One active Delivery per worker conversation.
- One fenced sender lease per conversation.
- Stale executors cannot advance state.
- Send is structurally impossible before `SUBMITTING`.
- Post-send negative evidence never causes automatic resend.
- `DELIVERED` requires positive owned-turn evidence.
- unexpected human turns pause the lane.
- every transition and journal event commit atomically.
- worker-result forwarding cannot rerun worker work.
- all router user turns use the same Delivery machinery.
