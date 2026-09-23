# Agent D — Wave 0 Architecture Integration / Referee

## Verdict

**GO for the Wave 1 single-chat vertical slice.**

Do **not** begin Wave 2 reliability hardening or any multi-chat scheduler work until the Wave 1 gate passes and the live DOM adapter proves the required semantic observations on the current ChatGPT UI.

## Inputs reconciled

- two independent protocol/orchestration designs;
- reliability / IndexedDB / YOLO code-level audit;
- DOM/completion feasibility findings;
- immutable acceptance suite v0;
- existing project charter and implementation roadmap.

## Important disagreements resolved

### 1. Task/agent ID creation

Selected: **preallocated controller spawn handles**.

Rejected for v0: model emits an un-IDed spawn and controller generates IDs only after acceptance.

Reason: preallocated handles preserve controller ownership while permitting same-round task dependencies and deterministic replay.

### 2. Conversation identity

Selected: `conversation_id` is controller-local and opaque; provider conversation key/URL is a binding-layer field.

Reason: keeps protocol independent of current ChatGPT route representation and supports future rotation/rebinding.

### 3. Worker response shape

Selected: arbitrary substantive prose may precede one final terminal protocol block.

Rejected: whole response must be machine-only JSON.

Reason: workers remain useful ordinary ChatGPT conversations while machine authority remains confined to the exact terminal block. Terminal position + current IDs + role-scoped parsing provide the safety boundary.

### 4. Slot reuse

Selected for MVP: **no slot recycling into an unrelated logical agent within one run**.

Reason: protocol identity prevents machine-state confusion but cannot erase semantic contamination from prior chat context.

### 5. `needs_user`

Selected: run-level pause for **new** worker Deliveries. In-flight turns may finish and be buffered.

Reason: safest deterministic semantics for MVP; avoids workers autonomously advancing on premises that human input may invalidate.

### 6. Budget exhaustion

Selected: controller emits a controller event describing local-loop budget exhaustion.

Rejected: silently rewriting a worker `CONTINUE` into a fake worker `ESCALATE`.

### 7. Delivery retry identity

Selected distinction:

- provably pre-send transport retry -> same Delivery;
- protocol repair -> new Delivery linked to same task/round;
- explicit retry after `DELIVERY_UNKNOWN` -> **new Delivery** with `retry_of_delivery_id`; old unknown record remains immutable.

### 8. Delivery boundary

Selected strengthened lifecycle:

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

`COMPOSER_FILLED` is the final definitely-not-sent state.

`SUBMITTING` is the irreversible ambiguity boundary.

## Frozen logical contracts

The following are frozen for Wave 1/2 implementation unless a QA-invariant conflict is discovered:

- controller ownership of orchestration IDs;
- logical agent / slot / conversation separation;
- Universal Delivery abstraction;
- one in-flight router Delivery per managed worker conversation;
- terminal sentinel-wrapped strict JSON envelopes;
- worker statuses `CONTINUE / DONE / ESCALATE`;
- orchestrator actions `spawn / message / wait / done / needs_user`;
- atomic orchestrator envelope commit;
- preallocated spawn handles;
- positive receipt required for `DELIVERED`;
- fail-closed `DELIVERY_UNKNOWN`;
- append-only event journal;
- durable fenced sender lease;
- separate worker-result and orchestrator-forwarding state machines;
- IndexedDB authority;
- service-worker ephemerality;
- manual-intervention quarantine;
- wait affects orchestrator wake conditions, not unrelated worker execution.

## Intentionally unfrozen

- ChatGPT selectors;
- Stop/Send/Copy DOM representation;
- MutationObserver root and exact strategy;
- quiescence duration;
- tab activation policy;
- dynamic worker-chat creation;
- conversation rotation implementation;
- GitHub artifact schema;
- dashboard UX.

## Exact Wave 1 target

One designated existing ChatGPT conversation only.

Required path:

```text
bind conversation
→ create Delivery
→ persist Delivery + journal
→ claim fenced sender lease
→ capture baseline
→ fill exact composer text
→ verify composer
→ commit SUBMITTING authorization
→ invoke Send once
→ observe exact owned user-turn receipt
→ mark DELIVERED
→ observe assistant candidate
→ establish turn completion using multi-signal evidence
→ parse exact current terminal worker block
→ persist result + journal
```

### Wave 1 exclusions

No:

- automatic retry after ambiguity;
- worker `CONTINUE` loop;
- protocol repair loop beyond minimal parsing;
- multi-chat scheduler;
- orchestrator routing;
- GitHub writes;
- dynamic chat creation;
- dashboard product work.

## Wave 2 decomposition

After Wave 1 passes:

1. **Delivery/reconciliation**
   - full Delivery FSM;
   - durable lease fencing;
   - crash recovery;
   - unknown handling.

2. **Completion/FSM + local worker loop**
   - response lifecycle;
   - `CONTINUE` deliveries;
   - budget enforcement;
   - protocol repair.

3. **Fault-injection harness**
   - deterministic crash points;
   - duplicate/drop observer events;
   - service-worker kill;
   - tab reload;
   - connection/error injection.

No multi-chat work until all Wave-2 acceptance gates pass.

## Remaining risks before multi-chat

- current ChatGPT DOM may invalidate assumed semantic observations;
- provider virtualization may make historical receipt lookup unreliable after long gaps;
- context contamination may make warm-slot reuse unacceptable even across runs;
- browser storage quota and IndexedDB failure modes need explicit testing;
- a stale actor must be prevented from calling the one Send-capable production function after fence loss;
- response causality after human intervention must remain fail-closed.

## GO condition

Begin Wave 1 only against one manually designated existing ChatGPT conversation. If live DOM work cannot positively prove the owned user-turn receipt or causally bind a new assistant candidate to it, stop and redesign the adapter rather than weakening the delivery invariants.
