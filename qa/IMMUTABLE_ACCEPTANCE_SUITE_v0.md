# Immutable Acceptance Suite v0

> **Governance rule:** Tests may be added. Existing test IDs, intended invariants, and pass criteria may not be deleted or weakened without an explicit human-approved revision of this QA-suite version. Implementation details and test harnesses may change.

## Governance

1. Existing test IDs must never be reused for different behavior.
2. Existing mandatory assertions may not be removed or weakened.
3. Tests may be added freely.
4. Test harness implementation may change.
5. DOM selectors are not immutable.
6. Timing constants may be tuned only when the logical assertion remains unchanged.
7. A test believed to be impossible must remain failing until explicitly adjudicated by the human project owner.
8. A release cannot be declared passing while any test required for its current gate fails.

---

## A. Protocol Safety

### QA-P001 — Reject prose-only commands
If the orchestrator describes an action in ordinary prose but emits no valid orchestrator envelope, the controller performs **zero scheduling side effects**.

### QA-P002 — Reject malformed envelope
Malformed JSON, mismatched sentinels, incorrect schema, invalid enum, or missing required IDs causes no controller action.

### QA-P003 — Reject stale decision round
An otherwise valid orchestrator envelope referencing a decision round other than the currently outstanding round causes no controller action.

### QA-P004 — Replay is harmless
Processing the same valid orchestrator envelope twice must not create a second logical action or Delivery.

### QA-P005 — Worker cannot control scheduler
A worker response containing a perfectly formed orchestrator command must not spawn, stop, message, or otherwise control another worker.

### QA-P006 — Quoted protocol does not execute
Protocol examples quoted/discussed inside ordinary model text must not execute unless they satisfy the complete current-envelope acceptance rules.

### QA-P007 — IDs are controller-owned
The model cannot substitute an invented `task_id`, `delivery_id`, `decision_round_id`, `slot_id`, or equivalent controller-owned identity and have it accepted as current.

---

## B. Delivery Integrity

### QA-D001 — Persist before send
No click/send side effect may occur unless the corresponding Delivery has already been durably persisted.

### QA-D002 — Positive delivery confirmation
A Delivery cannot become `DELIVERED` solely because Send was clicked. The controller must observe sufficient evidence that the corresponding user turn exists in the intended conversation.

### QA-D003 — Crash before send
Crash after durable persistence but before Send produces at most one eventual user turn.

### QA-D004 — Crash immediately after Send
Crash immediately after the Send side effect but before local confirmation must not blindly resend the Delivery.

### QA-D005 — Reconcile confirmed delivery
If recovery finds the exact prior Delivery represented by the matching router-owned user turn, it must reconcile to delivered without sending it again.

### QA-D006 — Ambiguous delivery fails closed
If recovery cannot establish whether an uncertain Delivery was sent, the lane must enter an explicit uncertainty/blocking state rather than guessing or automatically duplicating the turn.

### QA-D007 — Duplicate DOM events
Repeated/duplicated MutationObserver events cannot cause duplicate sends, duplicate results, or duplicate state transitions with external consequences.

### QA-D008 — Universal continuation delivery
A `CONTINUE` prompt receives the same durability, identity, reconciliation, and duplicate-prevention guarantees as `ASSIGN` and `FOLLOWUP`.

### QA-D009 — One in-flight router turn per conversation
The router must never intentionally have two independently outstanding user-turn deliveries to the same worker conversation simultaneously.

### QA-D010 — Wrong-chat protection
A Delivery intended for conversation X must never be accepted as delivered merely because matching-looking content appeared in conversation Y.

---

## C. Turn vs Task Completion

### QA-C001 — Thinking is not completion
A visible/known reasoning or thinking state cannot be classified as turn complete merely because assistant text is temporarily stable.

### QA-C002 — Streaming is not completion
Observed assistant-turn mutation or active generation controls prevent turn completion.

### QA-C003 — UI completion is not task completion
A cleanly finished assistant turn without a valid current worker envelope is **not** task terminal.

### QA-C004 — Valid terminal envelope
Task termination requires a schema-valid worker envelope corresponding to the current worker/task/delivery context.

### QA-C005 — Truncated response
A response that visibly finishes but lacks the required envelope is classified nonterminal rather than `DONE`.

### QA-C006 — Old terminal block ignored
A valid terminal envelope from an older task visible in chat history cannot terminate the current task.

### QA-C007 — Wrong-worker envelope ignored
A valid-looking envelope containing the wrong worker/task identity cannot terminate the current task.

### QA-C008 — Multiple candidate envelopes
If a turn contains multiple conflicting terminal envelopes and the acceptance rules cannot deterministically select exactly one valid current envelope, the controller must fail closed rather than choose arbitrarily.

---

## D. Worker Loop

### QA-W001 — Continue produces exactly one next turn
One accepted `CONTINUE` result causes at most one continuation Delivery.

### QA-W002 — Continue survives router restart
If the controller crashes while processing `CONTINUE`, recovery results in either zero or one correctly reconciled continuation—not two.

### QA-W003 — Done stops local loop
Once a current task reaches accepted `DONE`, the controller does not automatically send another continuation for that task.

### QA-W004 — Escalate stops local loop
Accepted `ESCALATE` halts worker-local continuation and generates an upstream event.

### QA-W005 — Loop budget enforcement
Configured hard turn/failure/time budgets cannot be exceeded silently. Budget exhaustion results in escalation.

### QA-W006 — Task isolation
A continuation for task A cannot accidentally continue a newer task B assigned to the same worker slot.

---

## E. Event Journal / Persistence

### QA-J001 — Durable transition journal
Every externally relevant state transition has a durable journal entry sufficient to identify run, task, Delivery, conversation binding, old state, new state, and reason.

### QA-J002 — Monotonic event identity
Journal events possess a deterministic ordering/sequence sufficient to reconstruct the controller's believed history.

### QA-J003 — Restart from durable state only
Following extension/service-worker restart, no correctness-critical decision may depend solely on pre-restart in-memory state.

### QA-J004 — Service-worker death
Killing the MV3 service worker at an arbitrary idle or transition boundary cannot itself lose an acknowledged task/result.

### QA-J005 — Idempotent event consumption
Reprocessing the same stored event cannot repeat a previously completed externally visible action.

---

## F. Browser / Failure States

### QA-F001 — Red Retry error
A retryable generation error never causes the task to be marked complete.

### QA-F002 — Connection warning
A connection-loss/waiting state never causes task completion or automatic duplicate task submission.

### QA-F003 — Reload while streaming
Reloading the worker tab during active generation cannot cause a duplicate original prompt merely because the local observer lost the stream.

### QA-F004 — Tab close/reopen
Closing and reopening a worker conversation preserves/reconstructs its logical task binding before new deliveries are allowed.

### QA-F005 — Content-script reconnect
Reattaching the content script cannot replay prior side effects solely because local observer state was lost.

### QA-F006 — Unrecognized UI
If the UI is in an unrecognized state such that delivery or completion cannot be determined safely, the lane fails closed.

### QA-F007 — Auth/user-required state
A state requiring authentication or explicit human intervention blocks that lane rather than being interpreted as model failure/completion.

---

## G. Human Intervention

### QA-H001 — Foreign user turn pauses lane
If the latest relevant user message was not emitted/owned by the router, the managed conversation pauses before sending another automated message.

### QA-H002 — Human message never marked router-delivered
A manually typed user message cannot accidentally satisfy confirmation for a pending router Delivery unless it contains the exact router-owned delivery identity and passes ownership checks.

### QA-H003 — Resume requires reconciliation
After human intervention, automation cannot resume blindly; the conversation/task state must first be reconciled.

---

## H. Identity Separation

### QA-I001 — Logical agent ≠ slot
Moving a logical agent from one worker slot to another does not change its logical task identity.

### QA-I002 — Slot ≠ conversation
Replacing/rotating the conversation associated with a slot does not require creating a new logical agent identity.

### QA-I003 — Conversation rotation preserves task lineage
After a supported conversation rotation, subsequent results remain attributable to the same logical worker/task while the old conversation cannot accidentally resume acting as current.

---

## I. Orchestrator Event Routing

### QA-O001 — Worker result exactly once upstream
One accepted worker terminal result produces at most one logical orchestrator-inbox event.

### QA-O002 — Event batching preserves every event
If several worker events are batched into one orchestrator Delivery, every constituent event remains individually identifiable and none is silently dropped.

### QA-O003 — Batch replay harmless
Re-observing or reprocessing the same orchestrator event batch cannot create duplicate scheduler actions.

### QA-O004 — Waiting does not globally freeze
A dependency wait involving workers A/B cannot prevent unrelated runnable worker C from progressing unless an explicit global condition requires it.

### QA-O005 — Barrier semantics deterministic
For any defined wait/dependency condition, identical persisted scheduler state produces the same determination of whether the barrier is satisfied.

---

## J. Fault Injection — Required Before Multi-Chat

The harness must support deterministic interruption at least at these boundaries:

- **QA-X001:** Crash after Delivery persistence, before composer insertion.
- **QA-X002:** Crash after composer insertion, before Send.
- **QA-X003:** Crash immediately after Send side effect.
- **QA-X004:** Crash after matching user turn appears, before local `DELIVERED` commit.
- **QA-X005:** Crash after assistant response appears, before result capture.
- **QA-X006:** Crash after result capture, before acknowledgement/upstream delivery.
- **QA-X007:** Kill MV3 service worker during an active task.
- **QA-X008:** Reload worker tab during generation.
- **QA-X009:** Emit duplicate observer events.
- **QA-X010:** Drop/delay observer events.
- **QA-X011:** Simulate connection interruption.
- **QA-X012:** Inject retry/error UI.

For each fault above, post-recovery behavior must satisfy all relevant Delivery, duplication, journaling, and completion invariants.

---

## K. Wave 1 Gate — One-Chat Vertical Slice

All are mandatory:

- **QA-G1.1:** Extension can bind to the designated test conversation.
- **QA-G1.2:** One Delivery is durably persisted before Send.
- **QA-G1.3:** The exact submitted router-owned user turn is positively confirmed.
- **QA-G1.4:** A new assistant turn is observed.
- **QA-G1.5:** Turn completion is detected without fixed-duration-only logic.
- **QA-G1.6:** A valid current terminal worker envelope is extracted.
- **QA-G1.7:** The result is durably committed.
- **QA-G1.8:** Journal records allow reconstruction of the complete transaction.

Wave 1 passes only if G1.1–G1.8 all pass.

---

## L. Wave 2 Gate — Reliable Single Worker

Before any multi-chat scheduler implementation:

- **QA-G2.1:** All `QA-X001` through `QA-X012` are implemented and pass where applicable.
- **QA-G2.2:** No injected crash produces duplicate logical user turns.
- **QA-G2.3:** No ambiguous send is automatically retried without reconciliation.
- **QA-G2.4:** A worker performs at least three consecutive `CONTINUE` cycles using independent Delivery IDs.
- **QA-G2.5:** Crash/restart during one of those continuation deliveries recovers without advancing twice.
- **QA-G2.6:** `DONE` terminates the worker loop.
- **QA-G2.7:** `ESCALATE` reaches the upstream event boundary exactly once.
- **QA-G2.8:** Manual human intervention causes a safe pause.

Only after all G2 tests pass may multi-worker orchestration begin.

---

## M. Wave 3 Gate — Two-Worker Orchestration

- **QA-G3.1:** Two logical workers occupy two separate warm slots concurrently.
- **QA-G3.2:** Each can independently execute worker-local continuation loops.
- **QA-G3.3:** Completion of one worker does not corrupt or terminate the other.
- **QA-G3.4:** Two near-simultaneous worker results can be batched into one orchestrator decision round without losing either.
- **QA-G3.5:** Orchestrator follow-up to one worker does not affect the other.
- **QA-G3.6:** A waiting dependency on one worker does not block unrelated runnable work.
- **QA-G3.7:** Replaying an orchestrator decision round does not duplicate spawned assignments or messages.
- **QA-G3.8:** One worker may fail/recover while the other continues safely.

---

## N. Wave 4 Gate — Unattended Recovery

- **QA-G4.1:** Chrome restart reconstructs all nonterminal tasks before sending anything new.
- **QA-G4.2:** Extension reload reconstructs all nonterminal tasks.
- **QA-G4.3:** A discarded/reloaded tab is safely rebound.
- **QA-G4.4:** Manual user intervention is detected after restart.
- **QA-G4.5:** Conversation rotation preserves logical worker/task identity.
- **QA-G4.6:** An overnight soak run produces no unexplained Delivery duplication or disappearance.
- **QA-G4.7:** Every abnormal transition encountered during soak is diagnosable from the event journal without relying on ephemeral console logs.

---

## Definition of Core Correctness

Regardless of implementation, the following are absolute project invariants:

1. **Never silently duplicate a user turn when delivery is uncertain.**
2. **Never call a task complete merely because a ChatGPT turn stopped generating.**
3. **Never execute worker-produced controller commands.**
4. **Never rely on volatile service-worker memory for correctness.**
5. **Never automatically progress through an ambiguous state.**
6. **Every external side effect has a durable identity and prior persisted intent.**
7. **Every managed conversation has at most one router-owned user turn in flight.**
8. **Human intervention pauses rather than competes with automation.**
9. **Logical worker identity is independent of browser tab and conversation identity.**
10. **Any system restart must reconcile existing reality before producing new side effects.**


---

## O. Additive Wave-0 Integration Invariants

These tests were added after reconciling the independent protocol, reliability, and DOM workstreams. They do not alter any earlier test.

### QA-R001 — Send impossible before SUBMITTING
No production code path may invoke the ChatGPT Send action while the Delivery is in `PENDING`, `CLAIMED`, `COMPOSER_FILLING`, or `COMPOSER_FILLED`. The Send-capable function must require a current persisted `SUBMITTING` authorization.

### QA-R002 — Stale lease fence cannot act
After a sender lease expires and another actor acquires a newer fencing token for the same conversation, the stale actor must be unable to advance durable Delivery state or invoke Send.

### QA-R003 — Unknown retry preserves history
A `DELIVERY_UNKNOWN` record may not be mutated back to `PENDING`. If a human explicitly authorizes retry despite duplicate risk, the retry must create a new Delivery with a new `delivery_id` linked through `retry_of_delivery_id`.

### QA-R004 — State transition and journal append are atomic
For every correctness-relevant durable state mutation, the state update and corresponding append-only journal record must commit in the same IndexedDB transaction. If journal insertion aborts, the state transition must also abort.

### QA-R005 — Result forwarding cannot rerun worker work
Once a worker response is durably captured, any crash or failure while enqueuing/delivering that result to the orchestrator must recover from the captured result/inbox state. It must never cause the worker's original prompt or completed worker turn to be rerun.

### QA-R006 — Orchestrator action envelope is all-or-nothing
If any action in an orchestrator envelope is structurally or semantically invalid, none of the actions in that envelope may commit or create Deliveries.

### QA-R007 — Spawn handles are authoritative
A v0 orchestrator `spawn` may use only an unused controller-supplied spawn handle for the current decision round. An invented, stale, mismatched, or already-used `task_id` / `logical_agent_id` pair invalidates the complete orchestrator envelope.

### QA-R008 — needs_user pauses new worker deliveries
While a v0 run is in `needs_user`, already in-flight worker turns may finish and be persisted, but no new worker Assignment, Continuation, or Follow-up Delivery may be issued until the human input is incorporated through a controlled orchestrator decision round.
