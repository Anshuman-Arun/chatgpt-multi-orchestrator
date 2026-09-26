# Wave 2 implementation notes

## Verdict scope

Wave 2 implements the reliable **single-worker** layer only. It does not implement multi-worker allocation, orchestrator decision rounds, event batching, dependency scheduling, dynamic chat creation, GitHub artifact routing, or dashboard productization.

The intended code-level verdict after automated validation is:

`WAVE 2 CODE COMPLETE — COMPREHENSIVE LIVE QA PENDING`

No authenticated Wave-2 browser campaign is claimed by this document.

## Runtime layering

Wave 2 deliberately reuses the Wave-1 ChatGPT DOM/send primitives that passed the authenticated Brave smoke test. It adds reliability above them rather than adding a second Send path.

- `wave2-core.js` — universal Delivery kinds, worker protocol, reconciliation classification, UI normalization, budgets.
- `wave2-db.js` — IndexedDB v3 schema/upgrade, append-only journal primitive, durable transitions and fence assertions.
- `wave2-delivery-store.js` — assignment/child Delivery creation, conversation sequence, fenced leases, composer/send/receipt/response Delivery transitions.
- `wave2-result-store.js` — split result persistence vs ACK, upstream-ready events, budgets, manual pause/resume, developer fault plan/evidence.
- `wave2-store.js` — composed persistence surface.
- `wave2-faults.js` — named deterministic fault boundaries.
- `wave2-dom.js` — semantic adapter over the proven Wave-1 DOM adapter, with Wave-2 UI-state normalization.
- `wave2-background.js` — durable reconciler and startup reconstruction.
- `wave2-content.js` — one-tab executor, observer-as-wakeup behavior, recovery/resume developer controls.

The low-level ChatGPT Send actuator remains `Wave1Dom.invokeAuthorizedSend`, backed by the same persisted one-shot `wave1-durable-submitting` permit. Wave 2 does not add a second click/requestSubmit path.

## Schema and migration

Database name remains `chatgpt_multi_orchestrator_wave1` so accepted Wave-1 state remains authoritative. Wave 2 upgrades it to **version 3**.

Wave 2 retains the existing stores and adds/uses:

- `upstream_events` with `task_id` and unique `dedupe_key` indexes;
- `faults` with `delivery_id` and `point` indexes.

The v3 migration is intentionally defensive because an intermediate Wave-2 draft used DB v2 with an incompatible `faults` key. If an existing `faults` store does not use `fault_id` as its key path, v3 replaces that developer-only draft store and recreates the required indexes. Existing Wave-1 Delivery/result/event stores are retained.

Both the Wave-1 and Wave-2 database openers use v3-compatible upgrade logic so a legacy Wave-1 panel cannot hold a lower-version connection and block the reliability migration.

## Universal Delivery

Router-owned user turns use one Delivery model. Wave 2 exercises:

- `ASSIGNMENT`
- `CONTINUATION`
- `PROTOCOL_REPAIR`

The model also recognizes `FOLLOW_UP` and `ORCHESTRATOR_EVENTS` for later layers.

Every child Delivery gets a fresh `delivery_id`, ownership token, monotonically allocated `conversation_seq`, payload hashes, the same task/agent/slot/conversation identities, and a causal parent. Parent+kind child creation is deduplicated transactionally.

The Delivery states are:

`PENDING → CLAIMED → COMPOSER_FILLING → COMPOSER_FILLED → SUBMITTING → SENT_UNCONFIRMED → DELIVERED → RESPONSE_STARTED → RESPONSE_RECEIVED → ACKED`

with terminal side states `DELIVERY_UNKNOWN`, `FAILED`, `RESPONSE_FAILED`, and `RESPONSE_SUPERSEDED`.

`DELIVERY_UNKNOWN` has no automatic outgoing transition. Wave 2 does not implement a convenience risky-retry UI; therefore an unknown Delivery simply remains blocked. A future explicit risky retry must create a new linked Delivery rather than mutate the unknown record.

## Send boundary and fencing

`COMPOSER_FILLED` is definitely pre-send. `SUBMITTING` is the ambiguity boundary.

The one-shot Send capability is durably consumed before the DOM side effect. A recovered `SUBMITTING` Delivery never jumps directly back into Send: it first takes a read-only semantic snapshot and reconciles durable state against browser reality. Only positive non-delivery while the persisted capability is still unconsumed may re-enter the authorized Send path.

Fence transfer increments the conversation fence. An old actor cannot commit a state transition or consume Send under its stale fence. If an actor already consumed a `SUBMITTING` permit and its lease is still live, takeover is deferred until permit expiry. After expiry the old permit is unusable and the replacement actor receives reconciliation-only authority.

## Restart reconstruction

Service-worker startup follows:

`open IndexedDB → enumerate nonterminal Deliveries → journal restart origin → discover current saved-conversation tabs → request fresh semantic snapshot/recovery → reconcile → side effects only when authorized`

Tab IDs and in-memory actor state are never authoritative. Missing tabs are journaled as `TAB_UNAVAILABLE`; Wave 2 does not create or navigate to missing conversations automatically.

A content-script reload creates a new actor ID. Manual pause state is durable in the binding/task and blocks lease acquisition after restart until explicit Resume.

## Worker-local loop

The strict worker statuses are:

- `CONTINUE`
- `DONE`
- `ESCALATE`

Allowed escalation reasons are exactly:

- `MISSING_INFORMATION`
- `NEEDS_ORCHESTRATOR_DECISION`
- `NEEDS_USER`
- `TOOL_FAILURE`
- `BUDGET_EXHAUSTED`
- `CONTRADICTION`

A valid `CONTINUE` result is persisted and ACKed before exactly one deduplicated `CONTINUATION` Delivery is materialized. The continuation uses the full Delivery machine and a fresh ID/sequence. `DONE` and `ESCALATE` stop the local loop. Terminal worker results produce one deduplicated upstream-ready event; no cross-worker action exists in Wave 2.

## Result-capture crash boundary

Wave 2 splits:

1. `WORKER_RESULT_PERSISTED`
2. Delivery `ACKED` / upstream-ready event

This is intentional. A crash at QA-X006 occurs after result evidence is durable but before ACK. Recovery finds the stored result and ACKs/forwards that evidence without rerunning the worker response.

## Hard budgets

Task records durably carry:

- maximum continuation turns;
- maximum recoverable failures;
- maximum elapsed task duration;
- maximum protocol repairs.

Pre-send budget exhaustion is checked when authority is reacquired and fails the Delivery before any new user turn, then emits a controller-originated `BUDGET_EXHAUSTED` event. Post-send work may still be read-only reconciled so an already-produced receipt/response is not lost, but no new continuation is issued after exhaustion.

Retryable model-error classifications are counted once per Delivery/error class. A connection-waiting observation is journaled but does not consume the retry budget on each poll.

## Protocol repair

A completed response with a malformed/missing terminal block is never reinterpreted as controller authority and never reruns the substantive task.

If repair budget remains:

1. original response text/hash remains durable;
2. a fresh `PROTOCOL_REPAIR` child is created;
3. the malformed parent becomes `RESPONSE_SUPERSEDED` with a link/evidence to the repair child;
4. the repair prompt asks only for the corrected terminal block using the repair Delivery's current controller-owned IDs.

Repair creation is parent-deduplicated. Invalid repair output or repair-budget exhaustion creates a controller escalation and stops.

## Manual-user interference

Before Send, foreign composer/user content is never overwritten. After an owned receipt, a foreign user turn pauses/supersedes the causal chain. If it appears after `RESPONSE_RECEIVED`, the completed response evidence is retained while the binding/task are durably paused.

Restart preserves the pause. Automation cannot reacquire lease authority while paused. The developer panel's explicit Resume action clears the pause and re-enters reconciliation; it never turns an unknown or failed historical Delivery back into `PENDING`.

## UI/failure states

Wave 2 normalizes:

- generation active;
- long thinking;
- retryable model error;
- connection waiting/offline;
- authentication required;
- user required;
- rate limited;
- unrecognized UI;
- content-script detached;
- tab unavailable.

Thinking is not an error. Retry/error and connection states are not completion. Authentication, user-required, rate-limit, unknown UI, detached script, and unavailable tab block the lane rather than authorizing progress.

## Deterministic fault injection

Developer fault plans are disabled by default and persisted. Every firing writes a `FAULT_INJECTED` journal event/fault record before disruption.

Mapped boundaries:

- X001 `after_delivery_persist`
- X002 `after_composer_write`
- X003 `after_send_invocation`
- X004 `after_user_receipt`
- X005 `after_response_detected`
- X006 `after_result_persist`
- X007 `service_worker_restart`
- X008 `tab_reload_during_generation`
- X009 `duplicate_observer_callbacks`
- X010 `drop_observer_callbacks`
- X011 `connection_interruption`
- X012 `retry_error_state`

The production developer injector uses extension reload for background crash boundaries and page reload for content/tab crash boundaries. X008 is consumed only while the semantic snapshot says generation is active. Observer callbacks remain wake signals only.

## Known limitations

- Comprehensive authenticated Wave-2 live QA has **not** been executed yet.
- Startup recovery rediscoveries currently use already-open saved-conversation tabs; `TAB_UNAVAILABLE` blocks and journals rather than opening a conversation automatically.
- No human risky-retry UI for `DELIVERY_UNKNOWN` is implemented. This is intentionally safer than an automatic resend.
- The deterministic X007 developer action reloads the extension, which necessarily replaces the MV3 worker; the comprehensive live campaign may additionally use service-worker DevTools stop/restart when available.
- No Wave-3 multi-worker scheduler or orchestrator routing is included.
