# Wave 1 Single-Chat Vertical Slice — Implementation Notes

## Scope

Wave 1 adds one isolated, manually launched Delivery lane for one already-existing saved ChatGPT conversation. It does not add worker scheduling, orchestrator routing, continuation loops, retries after ambiguous Send, crash recovery, dynamic chat creation, or GitHub artifact writes.

The implementation is intentionally separate from the legacy YOLO queue. For the Wave-1 lane, normal YOLO automation must be paused for the bound conversation before the developer control will bind or launch a Delivery.

## Durable authority

IndexedDB database `chatgpt_multi_orchestrator_wave1` is authoritative for the Wave-1 lane. Stores are:

- `meta` — monotonic journal sequence;
- `runs` — minimum run identity/status;
- `tasks` — minimum task/agent/slot/conversation identity/status;
- `conversation_bindings` — controller-local conversation ID to exact canonical ChatGPT locator;
- `deliveries` — universal Delivery state and evidence;
- `leases` — one sender owner/fencing token per conversation;
- `worker_results` — one terminal result per Delivery;
- `events` — append-only correctness journal.

Every Delivery transition is written with its event in the same IndexedDB transaction. Lease renewals, Send-capability consumption, assistant-output mutation evidence, and protocol-failure annotations are also journaled.

## Send boundary

The Wave-1 path is:

`PENDING → CLAIMED → COMPOSER_FILLING → COMPOSER_FILLED → SUBMITTING → SENT_UNCONFIRMED → DELIVERED → RESPONSE_STARTED → RESPONSE_RECEIVED → ACKED`

`COMPOSER_FILLED` is definitely not sent. `SUBMITTING` is the ambiguity boundary.

The store creates a durable `send_authorization_id` while transitioning to `SUBMITTING`. Immediately before DOM actuation, a second IndexedDB transaction validates the current sender fence and atomically consumes that one-shot authorization. Only the resulting permit can enter `invokeAuthorizedSend`, the sole Wave-1 DOM function that calls either the explicit Send button or `form.requestSubmit()`.

If authorization consumption, DOM actuation, or post-actuation acknowledgement becomes uncertain, the Delivery is not returned to a pre-send state and Send is never retried automatically.

## Browser evidence model

The DOM adapter reuses YOLO's proven composer discovery, native textarea/contenteditable insertion, Send-button discovery, generation controls, and visible-error detection.

Wave 1 adds semantic snapshots containing:

- exact canonical conversation route;
- composer presence/text;
- generation/thinking state;
- visible error class;
- idle send-path availability;
- ordered user/assistant turns with identity strength and text fingerprints.

Correctness logic consumes these normalized snapshots in the background; selectors do not appear in the durable state machine.

A positive user receipt requires all of:

1. exact bound route;
2. a non-baseline user-turn identity;
3. the current controller-owned `delivery_id`;
4. the current random ownership token;
5. exact normalized payload text;
6. matching SHA-256.

Assistant identity prefers explicit provider/turn IDs, then stable DOM identity, then structural position after the exact owned user turn, with fingerprinting only as fallback. Message count is never authoritative.

MutationObserver callbacks only schedule reconciliation. They do not transition state, send, or capture results.

## Turn completion versus task terminality

A turn is complete only when the owned user receipt is already confirmed, the causal assistant candidate exists, no generation/thinking control is active, no visible error is present, the composer is idle, an idle send path exists, and the assistant output has been unchanged for at least four seconds.

That moves the Delivery to `RESPONSE_RECEIVED`. It does **not** make the task successful.

Wave 1 accepts only the `DONE` worker status. The final non-whitespace response content must contain exactly one canonical block:

```text
<<<MULTIAGENT:WORKER:v1>>>
{"protocol_version":1,"run_id":"...","task_id":"...","logical_agent_id":"...","slot_id":"...","conversation_id":"...","delivery_id":"...","conversation_seq":1,"status":"DONE"}
<<<END:MULTIAGENT:WORKER:v1>>>
```

For Wave 1, that JSON object has exactly the nine fields shown above. Every controller-owned ID, sequence, and protocol version must match the current Delivery. Extra action/recipient fields, stale IDs, multiple blocks, malformed JSON, a nonterminal block, or content after the end sentinel are rejected. Invalid/missing protocol leaves the turn at `RESPONSE_RECEIVED` with a journaled nonterminal reason; it is not ACKed as task success.

## Recovery boundary for this wave

Full crash recovery is explicitly out of scope. Durable state is nevertheless safe across service-worker loss because no authoritative scheduler state exists only in service-worker memory. A consumed or otherwise uncertain `SUBMITTING` authorization cannot be replayed by this implementation.

The authenticated smoke test is still required to validate current live ChatGPT DOM selectors/identity attributes and Project-conversation behavior. If live UI behavior cannot provide exact receipt or causal assistant identity, Wave 1 must stop rather than weaken the predicates.
