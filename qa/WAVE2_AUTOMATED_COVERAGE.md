# Wave 2 automated coverage map

This file maps the frozen acceptance suite to the Wave-2 automated tests. It does not replace the immutable suite and does not certify the authenticated browser campaign.

## Delivery integrity QA-D001–D010

- D001 persist before Send — existing Wave-1 production-contract tests plus `tests/wave2-production-contract.test.js` one-shot actuator assertion.
- D002 positive delivery confirmation — inherited Wave-1 receipt tests and Wave-2 reconciler use of exact owned receipt.
- D003 crash before Send — `tests/wave2-harness.test.js` X001/X002.
- D004 crash immediately after Send — X003.
- D005 reconcile confirmed delivery — X004 and X003 recovery.
- D006 ambiguous delivery fails closed — immutable unknown test.
- D007 duplicate DOM events — X009.
- D008 universal continuation delivery — D1→D4 scenario plus continuation child contract.
- D009 one in-flight router turn — parent+kind child dedupe and unresolved-Delivery guards.
- D010 wrong-chat protection — inherited Wave-1 route/receipt tests and Wave-2 route guard.

## Worker loop QA-W001–W006

- W001 exactly one next continuation — D1→D4 + adversarial duplicate CONTINUE.
- W002 CONTINUE survives restart — crash in D2 continuation.
- W003 DONE stops loop — D1→D4 terminal assertion.
- W004 ESCALATE stops loop — parser/result/upstream contract and comprehensive live case.
- W005 budgets — core exact-boundary tests + adversarial fourth-child rejection + pre-send budget production contract.
- W006 task isolation — child Delivery preserves parent task/agent/slot/conversation identities and causal parent.

## Journal/persistence QA-J001–J005

- J001 durable journal — inherited Wave-1 atomic journal tests plus Wave-2 DB/event production contracts.
- J002 monotonic event identity — inherited append-only sequence implementation/tests.
- J003 restart from durable state — startup production contract asserts DB open/enumeration before tab query.
- J004 service-worker death — X007 harness and real extension-reload developer fault.
- J005 idempotent event/result consumption — result persistence/ACK split, parent-child dedupe and X006.

## Browser/failure QA-F001–F007

- F001 Retry error — X012; retryable state cannot complete.
- F002 connection warning — X011.
- F003 reload while streaming — X008; production source contract requires generation-active reload.
- F004 tab close/reopen — startup tab rediscovery; unavailable tab blocks/journals. Full close/reopen remains part of authenticated campaign evidence.
- F005 content-script reconnect — new actor + fenced reacquisition; X008/adversarial fence tests.
- F006 unrecognized UI — normalized blocking state contract.
- F007 auth/user-required — blocking-state production contract; rate limit is also blocking.

## Human intervention QA-H001–H003

- H001 foreign user pauses — harness manual-pause test and production pause path.
- H002 manual text cannot confirm router Delivery — inherited exact owned-receipt checks.
- H003 explicit reconciliation/resume — production Resume path + durable pause adversarial test.

## Fault injection QA-X001–X012

| QA | Deterministic point / automated scenario |
| --- | --- |
| X001 | `after_delivery_persist` / crash after persist |
| X002 | `after_composer_write` / crash before Send |
| X003 | `after_send_invocation` / crash immediately after Send |
| X004 | `after_user_receipt` / crash before DELIVERED commit |
| X005 | `after_response_detected` / crash before response capture |
| X006 | `after_result_persist` / crash before ACK/upstream |
| X007 | `service_worker_restart` / extension reload after durable fault evidence |
| X008 | `tab_reload_during_generation` / reload only while generating |
| X009 | `duplicate_observer_callbacks` |
| X010 | `drop_observer_callbacks` + polling recovery |
| X011 | `connection_interruption` |
| X012 | `retry_error_state` |

The stateful harness asserts execute → crash → reconstruct → reconcile semantics for the X boundaries rather than only searching source text. Production-contract tests separately assert the named developer points are wired to the extension/tab runtime.

## Wave-2 gate QA-G2.1–G2.8

- G2.1 X001–X012 implemented — `tests/wave2-harness.test.js` plus production fault-point contract.
- G2.2 no crash duplicates logical user turns — X001–X010 send-count/turn assertions.
- G2.3 no ambiguous automatic resend — consumed SUBMITTING immutable-unknown test and reconcile-first source contract.
- G2.4 three consecutive CONTINUE cycles — D1→D4 automated scenario.
- G2.5 crash during continuation — D2 crash scenario.
- G2.6 DONE terminates — D4 assertion.
- G2.7 ESCALATE upstream exactly once — durable result/upstream dedupe production implementation; authenticated case is in the live campaign.
- G2.8 manual human intervention safe pause — harness/adversarial durable-pause tests plus production quarantine across restart.

## Additional adversarial cases

`tests/wave2-adversarial.test.js` covers:

- stale actor blocked after fence transfer;
- consumed Send permit prevents unsafe takeover while live;
- duplicate CONTINUE finalization;
- protocol-repair child deduplication and evidence preservation;
- exact continuation-budget boundary;
- durable manual pause across actor restart.

`tests/wave2-core.test.js` covers strict protocol variants, immutable terminal states, exact budget boundaries, UI normalization, and reconciliation classification.

`tests/wave2-production-contract.test.js` audits runtime wiring, DB v3 migration, one low-level Send actuator, split result persistence/ACK, real crash/reload wiring, protocol-repair parent closure, pre-send budget gating, blocking UI states, and packaging.

## Live evidence still required

Automated coverage is necessary but not sufficient. `docs/WAVE2_COMPREHENSIVE_LIVE_TEST.md` defines the single authenticated campaign required before treating the Wave-2 browser gate as passed.
