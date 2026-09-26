# Wave 2 authenticated live-QA evidence sheet

Use this sheet while running `docs/WAVE2_COMPREHENSIVE_LIVE_TEST.md`. It is a recording template, not evidence by itself.

## Campaign metadata

- Branch:
- Exact commit SHA:
- Browser + version:
- OS:
- Node:
- npm:
- Extension version:
- Saved Project conversation URL / locator:
- Controller `conversation_id`:
- Service-worker DevTools available: yes / no
- DevTools content-script context verified with `typeof MultiAgentWave2Dev === "object"`: yes / no

Required command gate:

| Command | Result |
| --- | --- |
| `npm.cmd run check` | |
| `npm.cmd test` | |
| `npm.cmd run verify:extension` | |
| `npm.cmd run validate:core` | |
| `npm.cmd run package` | |

## Evidence capture

After each scenario, run from the **extension content-script DevTools execution context**:

```js
const wave2Evidence = await MultiAgentWave2Dev.exportEvidence();
copy(JSON.stringify(wave2Evidence.evidence, null, 2));
```

Save the JSON locally with the scenario number. The export omits router prompt text and assistant response text, but it still contains conversation and Delivery identifiers; review it before publishing or committing it to a public repository.

For `live.currently_visible_delivery_turn_counts`, any value greater than 1 is an immediate failure. A 0 for an already-sent Delivery can be caused by ChatGPT turn virtualization and must be resolved by loading the relevant history plus checking durable receipt/journal evidence.

## Scenario record

| # | Scenario | Task / Delivery IDs | Expected terminal outcome | Evidence JSON | Manual/screenshot evidence | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Assignment → DONE | | DONE, one user turn, no continuation | | | |
| 2a | D1→D4, 3×CONTINUE→DONE | | four distinct deliveries, monotonic seq | | | |
| 2b | D2/D3 after-Send crash | | no duplicate child or user turn | | | |
| 3 | Tab reload during generation | | rebind/reconcile, no resend | | | |
| 4 | MV3 service-worker restart | | DB-first startup barrier, no resend | | | |
| 5a | Foreign composer draft before Send | | draft untouched, lane paused/stopped | | | |
| 5b | Manual user turn after receipt | | durable pause until explicit Resume | | | |
| 6a | Malformed protocol → repair | | one repair child, no substantive rerun | | | |
| 6b | Malformed repair exhausts budget | | controller escalation, stop | | | |
| 7 | ESCALATE | | ACKed, one upstream terminal event | | | |
| 8a | Connection waiting | | no DONE and no resubmit | | | |
| 8b | Retry/model error | | no DONE; repeated observation counted once | | | |
| 9 | Journal reconstruction | | reconstruct selected cases after restart | | | |
| 10 | Global duplicate-turn audit | | no Delivery with >1 router-owned user turn | | | |
| A | Ambiguous after-Send receipt | | immutable DELIVERY_UNKNOWN, no resend | | | |

## Per-scenario durable checks

For each relevant Delivery, record:

- `delivery_id`, `kind`, `conversation_seq`, causal parent;
- state progression and final state;
- `send_consumed_at` and exact-owned receipt evidence when Send was crossed;
- lease actor/fence changes around any restart;
- `FAULT_INJECTED` event/fault record for injected scenarios;
- `WORKER_RESULT_PERSISTED` before `WORKER_RESULT_ACKED`;
- continuation/repair child creation only after the required durable parent boundary;
- upstream event dedupe for DONE/ESCALATE/controller budget escalation;
- pause/resume events for manual interference;
- `RESTART_RECONCILIATION_OBSERVED`, `RESTART_RECONCILIATION_DECISION`, and `STARTUP_RECONCILIATION_READY` for restart scenarios.

## Duplicate-turn audit

| Delivery ID | Kind | Seq | Crossed Send? | Durable exact receipt? | Currently visible matching user turns | History loaded enough to decide? | Final count | Pass? |
| --- | --- | ---: | --- | --- | ---: | --- | ---: | --- |
| | | | | | | | | |

No Delivery may have a final count greater than 1. A Delivery that provably never crossed Send may have count 0; otherwise the final count must be exactly 1.

## Final gate

- All required scenarios passed: yes / no
- Zero duplicate router-owned user turns: yes / no
- Any unresolved `DELIVERY_UNKNOWN`: yes / no
- Any unexplained journal gap: yes / no
- Evidence sufficient to reconstruct restart/fault scenarios without transient console logs: yes / no

Only mark the authenticated Wave-2 browser gate passed when every required assertion in the comprehensive guide is satisfied.
