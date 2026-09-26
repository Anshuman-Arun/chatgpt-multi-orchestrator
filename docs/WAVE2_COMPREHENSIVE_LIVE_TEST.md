# Wave 2 comprehensive authenticated live test

**Purpose:** one consolidated authenticated browser campaign after code review. This guide is not evidence that the campaign passed.

Use one already-saved ChatGPT Project worker conversation in the signed-in Brave/Chromium profile. Keep legacy YOLO automation paused for that conversation. Reload the unpacked extension from the Wave-2 packaged build before beginning.

## Preconditions

Record:

- branch and exact commit SHA;
- browser/version and OS;
- Node/npm versions used to package;
- Project conversation URL;
- controller `conversation_id`;
- extension version;
- whether service-worker DevTools is available.

Run the repository command gate before the browser campaign:

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run verify:extension
npm.cmd run validate:core
npm.cmd run package
```

Load `dist/yolo` as the single unpacked extension copy. Open one saved Project worker chat and use the **MultiAgent — Wave 2** panel.

For every scenario capture the Delivery IDs, conversation sequences, visible router-owned user-turn count, final state, and relevant journal event range. Any duplicate router-owned user turn is an immediate Wave-2 gate failure.

## DevTools execution context and evidence capture

Wave 2 runs as an extension content script in Chromium's isolated world. The developer helpers are **not** intentionally published into ChatGPT's normal page JavaScript context.

In DevTools for the managed worker tab:

1. open **Console**;
2. use the JavaScript execution-context dropdown (normally showing `top`);
3. select the unpacked MultiAgent extension/content-script context;
4. verify:

```js
typeof MultiAgentWave2Dev
```

returns `"object"`.

Do not expose these helpers to the page's main world just to simplify QA.

After each scenario, capture one privacy-reduced evidence object:

```js
const wave2Evidence = await MultiAgentWave2Dev.exportEvidence();
wave2Evidence
```

To copy it from DevTools:

```js
copy(JSON.stringify(wave2Evidence.evidence, null, 2))
```

The export is read-only. It includes durable Delivery/task/run state, lease/fence state, worker-result metadata, journal events, upstream events, fired faults, and a sanitized live DOM summary. It deliberately omits router payload text and assistant response text. It still contains conversation/Delivery identifiers and locators, so do not publish raw evidence from a private conversation without reviewing it.

`live.currently_visible_delivery_turn_counts` compares currently materialized user turns against each Delivery's exact payload hash. A count greater than 1 is an immediate duplicate-send failure. Because ChatGPT can virtualize older turns, a visible count of 0 for a Delivery that crossed Send is **not** by itself proof that no turn exists; load/scroll the relevant history and reconcile it with durable receipt/journal evidence before concluding.

## Developer fault control

From the page console in the managed worker tab:

```js
await MultiAgentWave2Dev.armFaults([
  { point: "after_send_invocation", action: "CRASH", remaining: 1 }
]);
```

Clear all developer faults after each injected scenario:

```js
await MultiAgentWave2Dev.clearFaults();
```

Fault injection is disabled by default. A fired fault must have durable `FAULT_INJECTED` evidence in the journal.

## Campaign

### 1. Assignment → DONE

Bind the conversation. Submit a short task that can cleanly finish with the required protocol.

Verify:

- one `ASSIGNMENT` Delivery;
- persisted `PENDING` before any user turn appears;
- one exact router-owned user turn;
- `DELIVERED` only after exact owned receipt;
- one causally attached assistant turn;
- `RESPONSE_RECEIVED`;
- `WORKER_RESULT_PERSISTED`;
- `ACKED`;
- terminal status `DONE`;
- no continuation.

### 2. At least three CONTINUE cycles → DONE

Use a task prompt that explicitly requires four bounded phases and instructs the worker to return `CONTINUE` after phases 1–3 and `DONE` after phase 4.

Verify the path:

```text
Assignment D1 -> CONTINUE
Continuation D2 -> CONTINUE
Continuation D3 -> CONTINUE
Continuation D4 -> DONE
```

Verify:

- four distinct Delivery IDs;
- strictly increasing conversation sequence;
- exactly one router-owned user turn for each Delivery;
- each CONTINUE is durably captured/ACKed before its child exists;
- each child kind is `CONTINUATION`;
- D4 DONE stops the loop.

Repeat once with `after_send_invocation` armed for D2 or D3. After reload/recovery verify the same continuation is not advanced twice and the affected user payload appears exactly once.

### 3. Tab reload during generation

Arm:

```js
await MultiAgentWave2Dev.armFaults([
  { point: "tab_reload_during_generation", action: "CRASH", remaining: 1 }
]);
```

Run a task that generates long enough for active Stop/generation UI to be visible.

Verify:

- the fault fires only while generation is active;
- the tab reloads/reinjects with a new actor;
- durable Delivery state is read before any new send-side effect;
- the original owned user prompt is not duplicated;
- assistant observation reattaches or the lane fails closed;
- journal identifies the restart and recovery decision.

### 4. MV3 service-worker restart at a controlled boundary

Preferred exact test, when extension service-worker DevTools is available: stop the service worker after a durable transition and allow the browser to restart it.

Deterministic fallback:

```js
await MultiAgentWave2Dev.armFaults([
  { point: "service_worker_restart", action: "CRASH", remaining: 1 }
]);
```

This developer fault records evidence then reloads the extension, necessarily replacing the service worker.

Test at least once while a task is active.

Verify startup order from the journal:

```text
service-worker boot
-> open durable DB
-> enumerate nonterminal Deliveries
-> rediscover bound tab
-> request semantic recovery
-> reconcile
-> only then any permitted side effect
```

No prompt duplication is allowed.

### 5. Draft/manual-user interference

#### Before Send

Place a distinctive draft in the composer and launch a Delivery.

Verify:

- draft remains byte-for-byte intact;
- router does not append, clear, or Send it;
- lane stops/pauses before Send.

#### After owned receipt

During a worker response, manually add a user turn in the managed conversation.

Verify:

- current causal chain becomes paused/superseded;
- no automatic CONTINUE is sent;
- reload the tab/extension and verify the pause remains;
- no lease/send authority is reacquired automatically;
- only explicit **Resume** clears quarantine;
- Resume reconciles current durable/browser state and does not reset any historical Delivery to `PENDING`.

### 6. Malformed protocol → bounded repair

Have the worker finish substantive work but deliberately omit or mangle the terminal block.

Verify:

- original response text/hash is retained;
- no arbitrary prose is treated as controller instruction;
- original Delivery is closed as `RESPONSE_SUPERSEDED` only after the repair child is durable;
- one fresh `PROTOCOL_REPAIR` Delivery exists with a new ID/sequence;
- repair asks only for corrected protocol information;
- substantive work is not rerun;
- a duplicate recovery callback does not create a second repair child.

Then deliberately make the repair response malformed too. Verify repair budget exhaustion persists a controller escalation and stops.

### 7. ESCALATE

Run a task instructed to emit a valid current `ESCALATE` block with one allowed reason such as `NEEDS_USER`.

Verify:

- result is persisted and ACKed;
- local loop stops;
- no continuation is created;
- exactly one upstream-ready worker-terminal event exists;
- replay/reload does not create a duplicate upstream event.

### 8. Error/connection states

Where safely reproducible, use actual ChatGPT Retry/connection UI. Otherwise use deterministic developer faults:

```js
await MultiAgentWave2Dev.armFaults([
  { point: "connection_interruption", action: "OBSERVE", remaining: 1 }
]);
```

and separately:

```js
await MultiAgentWave2Dev.armFaults([
  { point: "retry_error_state", action: "OBSERVE", remaining: 1 }
]);
```

Verify:

- connection waiting is not DONE and does not resubmit;
- retry/model error is not DONE;
- repeated observation of the same retryable error does not burn failure budget repeatedly;
- authentication/user-required/rate-limit state blocks the lane;
- unrecognized UI fails closed.

### 9. Journal reconstruction

For at least the simple DONE, one crashed continuation, protocol repair, manual pause, and one error scenario:

- inspect the Wave-2 journal;
- reconstruct Delivery sequence and states without relying on console logs;
- confirm actor/fence changes, restart origin, fault firing, reconciliation choice, child creation, pause/repair, result persistence and terminal outcome are represented.

Restart the extension before inspection for at least one case to prove reconstruction is from durable data rather than in-memory state.

### 10. Zero duplicate router-owned user turns

At the end of the campaign, review every Wave-2 Delivery used in the campaign.

For each Delivery ID:

- count matching router-owned user turns in the ChatGPT conversation;
- the count must be 0 only for a Delivery that provably never crossed Send;
- otherwise it must be exactly 1;
- no Delivery may have count >1.

Specifically recheck all injected crash scenarios, especially after Send, user receipt, service-worker restart, and tab reload.

## Additional ambiguity check

Arm `after_send_invocation` and, during recovery, temporarily make the exact receipt unavailable/ambiguous if it can be done safely.

Verify:

- the Delivery becomes or remains blocked as `DELIVERY_UNKNOWN`;
- it is never mutated back to `PENDING`;
- no automatic resend occurs;
- there is no convenience retry in Wave 2.

## Pass criteria

The authenticated campaign passes only when all ten scenarios above satisfy the stated assertions and there are zero duplicate router-owned user turns.

For each scenario, retain the exported evidence object plus any screenshot/manual note needed to resolve DOM virtualization or visually confirm the exact user-turn count. The durable evidence must be sufficient to reconstruct the state transitions without relying on transient console logs.

A written guide, mock DOM test, or automated harness does **not** certify this live gate.
