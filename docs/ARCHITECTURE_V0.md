# Architecture v0 — Durable Multi-Chat Orchestrator

**Status:** Wave 0 integrated design. Runtime implementation has not begun.

## 1. System boundary

The system turns ordinary ChatGPT Project conversations into an orchestrated multi-agent workflow while keeping all reasoning inside normal ChatGPT chats.

The local controller contains no AI judgment. It performs deterministic:

- validation;
- identity management;
- persistence;
- routing;
- scheduling;
- retry/reconciliation;
- concurrency control;
- observability.

The architecture is a **durable distributed state machine whose unreliable external edge is the ChatGPT DOM**.

## 2. MVP topology

```text
Human
  │
  ▼
Orchestrator ChatGPT conversation
  │ terminal validated orchestrator envelope
  ▼
MV3 controller
  │
  ├── warm worker slot 1 -> existing ChatGPT conversation
  ├── warm worker slot 2 -> existing ChatGPT conversation
  └── optional additional pre-created slots
  │
  ▼
IndexedDB
  runs / rounds / agents / slots / bindings / tasks
  deliveries / results / inbox / leases / errors / events
```

GitHub artifacts, watchdogs, dynamic chat creation, and polished dashboarding are later layers.

## 3. Sources of truth

### Authoritative

IndexedDB stores all machine state.

### Non-authoritative

- MV3 service-worker memory;
- tab IDs;
- DOM node identity;
- model claims about current state;
- old protocol blocks in chat history;
- GitHub issue/artifact state.

On disagreement, durable controller state wins.

## 4. Identity model

Controller-generated opaque identities:

- `run_id` — one top-level orchestration episode;
- `decision_round_id` — one immutable orchestrator event batch awaiting one committed decision;
- `task_id` — delegated unit of work;
- `delivery_id` — one logical router-generated ChatGPT user turn;
- `logical_agent_id` — semantic worker identity;
- `slot_id` — warm physical execution lane;
- `conversation_id` — controller-local managed conversation identity.

The browser adapter separately stores the current provider/UI locator for each conversation.

Never equate logical agent, slot, conversation, tab, or URL identity.

## 5. Spawn handles

Before each orchestrator decision, the controller supplies a bounded pool of unused:

```json
{
  "task_id": "task_...",
  "logical_agent_id": "agent_..."
}
```

pairs.

A `spawn` action may use only a supplied pair. Unused pairs expire after the round commits.

This preserves controller ownership of IDs while allowing same-round dependency references.

## 6. Universal Delivery

Every router-generated ChatGPT user turn uses the same abstraction.

Kinds:

- `ASSIGNMENT`
- `CONTINUATION`
- `FOLLOW_UP`
- `ORCHESTRATOR_EVENTS`
- `PROTOCOL_REPAIR`

A Delivery includes at minimum:

```text
delivery_id
run_id
conversation_seq
kind
target conversation/slot/agent/task identities
causal parent/decision-round identity
payload
protocol version
```

Exactly one unresolved router Delivery may exist per managed worker conversation.

## 7. Delivery state machine

```text
PENDING
  ↓
CLAIMED
  ↓
COMPOSER_FILLING
  ↓
COMPOSER_FILLED
  ↓
SUBMITTING
  ↓
SENT_UNCONFIRMED
  ↓
DELIVERED
  ↓
RESPONSE_STARTED
  ↓
RESPONSE_RECEIVED
  ↓
ACKED
```

Important side states:

- `DELIVERY_UNKNOWN`
- `FAILED`
- `RESPONSE_FAILED`
- `RESPONSE_SUPERSEDED`

### Send boundary

`COMPOSER_FILLED` is the final definitely-not-sent state.

`SUBMITTING` means durable state has authorized exactly one Send side effect.

The sole production function capable of invoking ChatGPT Send must require a valid persisted `SUBMITTING` authorization and current lease fence.

After `SUBMITTING`, negative evidence never proves non-delivery.

## 8. Delivery confirmation and unknown outcomes

`DELIVERED` requires positive evidence of the exact router-owned user turn in the intended conversation.

Evidence includes:

- conversation identity;
- advancing user-turn evidence;
- exact Delivery ownership marker;
- payload/comparable hash checks.

A post-`SUBMITTING` outcome that cannot be positively reconciled becomes `DELIVERY_UNKNOWN`.

Unknown Deliveries never automatically return to `PENDING`.

If a human explicitly accepts duplicate risk, create a new Delivery linked through `retry_of_delivery_id`; retain the original unknown record.

## 9. Sender lease / fencing

Each managed conversation has one durable sender lease.

Lease acquisition/transfer occurs transactionally in IndexedDB and carries a monotonically increasing fencing token.

A stale actor presenting an old fence may not advance durable state or invoke Send after ownership transfers.

Lease expiry for a Delivery at `SUBMITTING` or later grants reconciliation authority only—not resend authority.

## 10. Worker protocol

Workers may provide substantive prose, but the final non-whitespace content must be exactly one terminal block:

```text
<<<MULTIAGENT:WORKER:v1>>>
{ strict JSON }
<<<END:MULTIAGENT:WORKER:v1>>>
```

Accepted statuses:

- `CONTINUE`
- `DONE`
- `ESCALATE`

Allowed escalation reasons:

- `MISSING_INFORMATION`
- `NEEDS_ORCHESTRATOR_DECISION`
- `NEEDS_USER`
- `TOOL_FAILURE`
- `BUDGET_EXHAUSTED`
- `CONTRADICTION`

The block must match the current:

- run;
- task;
- logical agent;
- slot;
- conversation;
- Delivery;
- conversation sequence;
- protocol version.

Worker schema has no cross-task action vocabulary.

## 11. Worker-local continuation

An accepted `CONTINUE` does not wake the orchestrator unless policy/budget requires it.

If budget remains, the controller creates exactly one new `CONTINUATION` Delivery to the same task/agent/slot/conversation.

That continuation uses the full universal Delivery machinery and its own Delivery ID.

Controller-side budget exhaustion creates a controller event; it does not falsify the worker's returned status.

## 12. Orchestrator protocol

The final non-whitespace content of a controlled orchestrator response must be:

```text
<<<MULTIAGENT:ORCHESTRATOR:v1>>>
{ strict JSON }
<<<END:MULTIAGENT:ORCHESTRATOR:v1>>>
```

MVP actions are exactly:

- `spawn`
- `message`
- `wait`
- `done`
- `needs_user`

The entire orchestrator envelope is validated and committed atomically before any resulting external Delivery begins.

No partial execution.

## 13. Scheduling semantics

### Warm slots

Worker conversations are manually pre-created for MVP.

One slot binds to at most one unrelated logical agent during a run. Do not recycle a warm chat into a fresh agent mid-run.

### Dependencies

`spawn.depends_on` uses AND dependencies.

Only successful `DONE` satisfies a dependency.

An escalated dependency keeps downstream tasks blocked and creates an orchestrator-visible event.

### Wait

`wait` supports `ANY` and `ALL` over tasks.

A wait controls when the orchestrator is awakened. It does not suspend unrelated runnable workers or local continuation loops.

## 14. Orchestrator inbox / batching

Worker terminal results are durably captured before upstream forwarding.

Worker capture and orchestrator forwarding are separate state machines:

```text
worker response
→ worker_results
→ orchestrator_inbox
→ ORCHESTRATOR_EVENTS Delivery
→ orchestrator response
```

Near-simultaneous events may be delivered in one immutable decision-round batch.

Events arriving after a round begins are buffered for the next round.

## 15. Human intervention

### Worker chat

Any unexpected non-router user turn pauses the lane and invalidates automatic causal assumptions across it.

### Orchestrator chat

Manual human input becomes a `HUMAN_INPUT` event. An unmanaged assistant response immediately following that human turn has no controller authority.

A new controller-issued orchestrator decision round is required before state-changing commands are accepted.

### `needs_user`

For MVP, `needs_user` pauses issuance of new worker Deliveries globally. Already in-flight turns may finish and be buffered.

## 16. DOM adapter contract

Durable-core modules consume semantic observations, never CSS selectors.

The adapter should expose concepts equivalent to:

- route identity;
- composer state;
- exact composer write;
- request Send;
- latest owned user turn;
- current assistant candidate;
- generation state;
- error state;
- completion evidence.

Selectors, MutationObserver roots, Copy/Stop/Send markup, and stability timing remain unfrozen adapter details.

## 17. Turn completion vs task completion

Turn completion uses multiple signals.

Strong/supporting observations may include:

- active generation controls;
- scoped assistant mutations;
- explicit error/connection UI;
- Copy control;
- Send state;
- quiescence window.

No fixed timeout, text stability, assistant count, or composer state alone is sufficient.

A task is terminal only after the current schema-valid protocol block is accepted.

`TURN_COMPLETE` without a valid terminal block is nonterminal.

## 18. Event journal

Append-only from the first implementation.

Every correctness-relevant durable state mutation and its journal entry commit in the same IndexedDB transaction.

The journal contains monotonic sequence, identities, state transition, reason, fence, actor/boot identity, and compact DOM fingerprint.

Do not silently truncate forensic history.

## 19. Recovery

All recovery begins:

```text
open IndexedDB
→ read durable state
→ discover/rebind live conversations
→ obtain read-only DOM snapshots
→ reconcile existing Deliveries
→ only then schedule new side effects
```

No startup path is allowed to inspect the page first and invent what durable state should have been.

## 20. Wave gates

### Wave 1

One-chat vertical slice only.

### Wave 2

Full single-chat reliability, continuation, reconciliation, and deterministic fault injection.

### Wave 3

Only after every Wave-2 delivery-boundary fault test passes:
- two warm workers;
- batching;
- dependencies;
- orchestrator routing.

## 21. Explicit non-goals for v0

- dynamic ChatGPT chat creation;
- task migration;
- slot recycling within one run;
- cancellation protocol;
- worker-to-worker messaging;
- multiple orchestrators;
- complex priority scheduler;
- GitHub as orchestration database;
- polished dashboard.
