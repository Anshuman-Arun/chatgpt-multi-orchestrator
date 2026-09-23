# Wave 1 Authenticated ChatGPT Smoke Test

This test is required for `QA-G1.9`. Mock/unit tests cannot certify it.

## Prepare

1. Check out/build `wave1/single-chat-vertical-slice` and run `npm run validate:core`.
2. Run `npm run package`, then load `dist/yolo` as an unpacked Chromium extension in a dedicated authenticated ChatGPT profile.
3. Open one already-existing **saved ChatGPT Project conversation** whose canonical URL ends in `/c/<conversation-id>`.
4. Open the normal YOLO popup and turn automation **off** for this conversation. Do not use Send next, Continue, nudge, or other YOLO controls during the smoke pass.
5. Make sure ChatGPT is idle and the composer is completely empty. Do not type manually in the managed conversation while the test is running.

## Execute

1. Expand the fixed **MultiAgent · Wave 1** developer control in the lower-right corner of the ChatGPT page.
2. Click **Bind conversation**. Confirm it reports a controller-local `conversation_id` and no route error.
3. Keep the default tiny smoke instruction or replace it with another harmless one-turn task.
4. Click **Run one Delivery** exactly once.
5. Observe the developer control. A successful run should progress through the durable states and eventually report `ACKED`.
6. Click **Journal**. It must say `reconstructable` and show the state path ending in `ACKED`.

## Required live observations

Record pass/fail for each item:

- **G1.1** The bound route remains the exact intended Project conversation for the entire send/receipt cycle.
- **G1.2** If the composer contains any non-whitespace draft before launch, Wave 1 stops without clearing, appending to, or sending it.
- **G1.3** The inserted router payload appears exactly in the composer before Send. The payload includes the current `delivery_id` and ownership token.
- **G1.4** Only one router-owned user turn appears. A click/requestSubmit is not treated as delivery confirmation by itself.
- **G1.5** `DELIVERED` occurs only after that exact new user turn is observed in the intended conversation.
- **G1.6** The assistant response selected by the controller is the new causal response after that owned user turn, not an older assistant turn.
- **G1.7** The Delivery reaches `ACKED` only if the assistant ends with the current strict `DONE` block; `worker_results` contains the captured result.
- **G1.8** The event journal reconstructs the transaction without console logs, with monotonic `seq`, state pairs, IDs, reasons, fence, and evidence fingerprints.
- **G1.9** The complete authenticated Project smoke path above succeeds on the current ChatGPT UI.

## IndexedDB diagnostics

In DevTools → Application → IndexedDB → `chatgpt_multi_orchestrator_wave1`, inspect:

- `conversation_bindings` for the exact canonical provider locator;
- `deliveries` for the current state, payload SHA-256, lease fence, receipt identity, and assistant identity;
- `leases` for the current fencing token;
- `worker_results` for the `DONE` result after success;
- `events` for the append-only transaction history.

No console output is required to reconstruct the successful path.

## Fail-closed checks

Run these only in a disposable test conversation:

- Put a draft in the composer, then launch. It must stop pre-send and leave the draft untouched.
- After a clean launch crosses `SUBMITTING`, navigate away before receipt. It must not automatically resend the Delivery.
- Ask the worker to omit or corrupt its terminal block. The assistant turn may become `RESPONSE_RECEIVED`, but the task must not become `ACKED`.

If the current ChatGPT UI no longer exposes enough information to prove exact route, composer readback, owned user receipt, or causal assistant identity, stop the test and report the DOM blocker. Do not loosen the predicates.
