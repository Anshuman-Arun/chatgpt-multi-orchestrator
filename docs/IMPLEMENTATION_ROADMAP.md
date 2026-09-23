# Implementation Roadmap

## Project framing

Build a durable distributed state machine whose only unreliable external edge is the ChatGPT DOM.

The controller contains no AI judgment. Ordinary ChatGPT conversations decide what work to do. The controller validates, routes, persists, retries, reconciles, schedules, and observes.

### Fixed MVP principles

- Normal ChatGPT Project conversations only.
- One orchestrator conversation.
- 2–4 manually pre-created warm worker conversations.
- MV3 extension as primary runtime.
- IndexedDB is authoritative for orchestration state.
- MV3 service-worker memory is never authoritative.
- Persist before every externally visible side effect.
- At-most-once side effects plus reconciliation; never claim exactly-once delivery.
- Uncertain sends become `DELIVERY_UNKNOWN`, never blind resend.
- One sender lease per conversation.
- One in-flight router-owned user turn per worker conversation.
- Every router-generated user turn uses one universal Delivery abstraction.
- Worker output is data. Only validated orchestrator envelopes may cause scheduler actions.
- GitHub is an artifact/project-state layer later, not the low-level delivery database.
- Dynamic chat creation is postponed until the warm-worker system is proven.

---

## Dependency graph

```text
WAVE 0 — FEASIBILITY + CONTRACTS
  A. Protocol/orchestration semantics
  B. Reliability/storage/YOLO reuse
  C. Live DOM/completion feasibility
                ↓
  D. Adversarial integrator/referee
                ↓
        logical contracts v0

WAVE 1 — ONE-CHAT VERTICAL SLICE
  persist → send → confirm → observe
  → detect turn completion → parse envelope → persist result
                ↓
        integration gate

WAVE 2 — SINGLE-CHAT RELIABILITY
  Delivery/reconciliation
  Completion/FSM + worker loop
  Fault-injection framework
                ↓
  adversarial delivery-boundary QA
                ↓
  no multi-chat until all Wave-2 gates pass

WAVE 3 — MULTI-CHAT SCHEDULER
  warm-worker allocator / identity model
  orchestrator inbox + event batching
  dependency / wait scheduler
                ↓
        two-worker E2E gate

WAVE 4 — UNATTENDED RECOVERY
  Chrome/restart reconstruction
  manual-user detection
  tab discard/rebind
  conversation rotation
                ↓
        overnight soak gate

WAVE 5 — PRODUCTIZATION
  GitHub artifacts
  dashboard
  watchdog / alerts

WAVE 6 — EXPANSION
  dynamic chat creation
  higher concurrency
  richer DAG scheduling
  convenience features
```

---

## Wave 0 — Contract + feasibility spike

### Agent A — Protocol and orchestration semantics

Owns:

- identity model;
- controller-generated IDs;
- worker and orchestrator envelopes;
- universal Delivery semantics;
- worker statuses;
- orchestrator action vocabulary;
- event-batch semantics;
- warm-worker allocation;
- dependency/wait semantics;
- replay/idempotency behavior;
- manual intervention semantics.

Preferred worker machine statuses:

- `CONTINUE`
- `DONE`
- `ESCALATE`

Escalation reasons should be structured, e.g.:

- `MISSING_INFORMATION`
- `NEEDS_ORCHESTRATOR_DECISION`
- `NEEDS_USER`
- `TOOL_FAILURE`
- `BUDGET_EXHAUSTED`
- `CONTRADICTION`

### Agent B — Reliability, storage, YOLO reuse

Owns:

- deep audit of upstream YOLO;
- IndexedDB schema;
- universal Delivery lifecycle;
- sender leases;
- reconciliation;
- append-only event journal;
- restart recovery;
- manual-user prompt ownership/fingerprints;
- crash matrices.

Candidate Delivery lifecycle:

```text
PENDING
→ CLAIMED
→ SUBMITTING
→ SENT_UNCONFIRMED
→ DELIVERED
→ RESPONSE_RECEIVED
→ ACKED
```

### Agent C — Live DOM feasibility

Must test against the current ChatGPT UI rather than assume:

- composer detection;
- text insertion;
- send/stop identification;
- positive user-turn confirmation;
- assistant-turn identity;
- MutationObserver behavior;
- Copy-control behavior;
- long reasoning pauses;
- red Retry/problem UI;
- orange connection/waiting UI;
- timeout/truncation behavior;
- reloads;
- navigation and persistent conversation identity.

Output should clearly separate:

- tested facts;
- borrowed implementation patterns;
- inferences;
- unresolved ambiguity.

### Agent D — Adversarial integrator

Receives A/B/C.

Must:

- attack contradictions;
- reconcile interfaces;
- freeze only logical contracts independent of fragile selectors;
- define exact Wave-1 vertical slice;
- define Wave-2 module boundaries;
- audit against the immutable QA suite;
- add tests if useful, but never weaken existing QA;
- issue GO / NO-GO for Wave 1.

---

## Wave 1 — Minimal one-chat vertical slice

This should be an integration-oriented implementation, not three disconnected libraries.

Required path:

```text
extension loads
→ binds designated test chat
→ creates and persists one Delivery
→ inserts exact prompt
→ persists submission state
→ sends
→ confirms matching router-owned user turn
→ observes corresponding assistant turn
→ detects turn completion using multiple signals
→ extracts valid current worker envelope
→ commits result to IndexedDB
→ journal allows transaction reconstruction
```

Explicitly omitted:

- retries;
- worker continuation loops;
- multi-chat scheduler;
- dynamic chat creation;
- GitHub writes;
- polished dashboard;
- notifications.

Wave 1 passes only when all `QA-G1.*` tests pass.

---

## Wave 2 — Reliable single-chat execution

Parallelizable work:

### 2A. Delivery / reconciliation

One universal `Delivery` abstraction for every router-generated user turn:

```text
Delivery {
  delivery_id
  run_id
  task_id
  logical_agent_id
  slot_id
  conversation_id
  kind: ASSIGN | CONTINUE | FOLLOWUP | ORCHESTRATOR_EVENT
  payload
  state
}
```

Every kind must use identical durability and reconciliation guarantees.

### 2B. Completion FSM + worker-local loop

Suggested chat state model:

```text
IDLE
SUBMITTING
SENT
THINKING
STREAMING
QUIESCENT
TURN_COMPLETE
TASK_TERMINAL
```

Side states include at minimum:

- `RETRYABLE_ERROR`
- `DELIVERY_UNKNOWN`
- `AUTH_REQUIRED`
- `RATE_LIMITED`
- `USER_REQUIRED`

`CONTINUE` must create a fresh Delivery with its own ID; it is not a special lightweight path.

### 2C. Fault-injection harness

Developer-only fault points should include:

- crash after persist before composer insertion;
- crash after composer insertion before send;
- crash immediately after send;
- crash after user turn appears before delivered commit;
- crash after assistant response before capture;
- crash after capture before acknowledgement;
- kill service worker;
- reload during generation;
- duplicate observer events;
- drop/delay observer events;
- network interruption;
- injected retry/error UI.

### Wave-2 gate

**Do not begin multi-chat orchestration until a single worker survives deterministic injected failures at every Delivery boundary without duplicate or lost router-owned user turns.**

A long soak test is additional evidence, not a replacement for deterministic fault injection.

---

## Wave 3 — Multi-chat scheduler

### Identity separation

Never conflate:

- `logical_agent_id`
- `slot_id`
- `conversation_id`

A logical agent may later move between slots or conversations without changing task lineage.

### Warm-worker allocation

MVP workers are manually pre-created.

`spawn(proof-agent)` means:

1. allocate an idle warm slot;
2. bind logical agent/task to that slot;
3. deliver assignment through the standard Delivery machine.

### Orchestrator inbox and batching

Worker events should accumulate in an orchestrator inbox.

Near-simultaneous events should be deliverable in one decision-round batch while preserving each event's identity.

### Wait/dependency semantics

Scheduler internals should support concepts equivalent to:

- `WAIT_ANY`
- `WAIT_ALL`
- `WAIT_DEPENDENCY`

A wait involving some workers must not globally freeze unrelated runnable work.

Wave 3 passes only when all `QA-G3.*` tests pass.

---

## Wave 4 — Unattended recovery

Add:

- extension/service-worker restart reconstruction;
- Chrome restart reconstruction;
- Windows reboot reconstruction;
- tab discard/reload rebinding;
- manual-user intervention detection;
- explicit authentication/user-required blocking;
- conversation rotation/checkpointing.

If the latest relevant user turn in a managed conversation is not router-owned, pause that lane until reconciliation.

Conversation rotation must preserve logical agent/task identity while changing conversation identity.

Wave 4 requires deterministic recovery tests plus overnight soak validation.

---

## Wave 5 — Productization

Only after correctness:

- GitHub artifact/report integration;
- side-panel dashboard;
- run history;
- watchdog;
- notifications;
- pause/resume controls;
- better operator diagnostics.

IndexedDB remains authoritative for low-level orchestration state.

---

## Wave 6 — Expansion

Potential later additions:

- true dynamic Project conversation creation;
- more than ~4 concurrent workers;
- automatic worker recycling;
- richer DAG scheduling;
- multiple simultaneous orchestrators;
- remote controls;
- richer GitHub issue/project integration.

---

## Core gating rule

> No multi-chat implementation until a single managed ChatGPT conversation can survive deliberately injected failures at every Delivery boundary without duplicate or lost router-owned user turns.
