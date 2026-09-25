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

Record pass/fail against the immutable Wave-1 gate exactly:

- **QA-G1.1 — bind:** The developer control binds the designated existing Project conversation, and the bound canonical route remains the intended conversation.
- **QA-G1.2 — persist before Send:** Before the browser Send side effect, IndexedDB contains the current Delivery and journal history through durable `SUBMITTING` authorization / one-shot capability consumption. There must be no user turn before that durable record exists.
- **QA-G1.3 — positive exact receipt:** Exactly one new router-owned user turn is positively confirmed in the intended conversation. It contains the current `delivery_id` and ownership token, and its normalized text/hash matches the durable payload. A click/requestSubmit alone is not confirmation.
- **QA-G1.4 — new assistant turn:** The controller identifies a non-baseline assistant candidate causally after the exact owned user turn; it must not select an older assistant message merely because it is latest/visible.
- **QA-G1.5 — multi-signal turn completion:** `RESPONSE_RECEIVED` occurs only after the owned receipt and assistant candidate exist, generation/thinking is inactive, no recognized error is visible, composer/send state is idle, and assistant output has been quiescent for about four seconds. A fixed duration or text stability alone must not complete the turn.
- **QA-G1.6 — terminal envelope:** The assistant ends with exactly one schema-valid current `DONE` worker block using the current controller-owned IDs, conversation sequence, and protocol version; that exact block is extracted successfully.
- **QA-G1.7 — durable result:** `worker_results` contains the substantive assistant response, terminal envelope, identities, and response hash, and the Delivery reaches `ACKED` only after that result is committed.
- **QA-G1.8 — journal reconstruction:** The append-only event journal reconstructs the Delivery state path through `ACKED` with monotonic `seq`, state pairs, identities, reasons, fence, and compact evidence, without relying on console logs.
- **QA-G1.9 — authenticated Project smoke:** The complete path above succeeds in the current authenticated ChatGPT Project UI.

Additional invariant checks, not substitutes for the G1 items:

- **QA-R009:** Put non-whitespace text in the composer before launch. Wave 1 must stop pre-send without clearing, appending to, or sending that draft.
- **QA-D006:** After crossing `SUBMITTING`, make receipt ambiguous (for example, navigate away before confirmation). The controller must stop in explicit uncertainty rather than automatically resend.
- **QA-C003–C005:** Omit/corrupt the terminal block. The assistant turn may reach `RESPONSE_RECEIVED`, but the task must not reach `ACKED`.

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
