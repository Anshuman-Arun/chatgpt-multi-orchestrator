# Wave 0 Agent Reports

This directory contains the reconciled Wave 0 architecture work.

## Reports

- `agent-a-protocol.md` — merged result of **two independent protocol/orchestration runs**, with disagreements explicitly resolved.
- `agent-b-reliability.md` — persistence, Delivery reconciliation, crash recovery, event journal, leases, and YOLO reuse.
- `agent-c-dom-feasibility.md` — DOM/completion transport findings and selector-independent adapter contract.
- `agent-d-integration.md` — adversarial integration/referee report and Wave 1 GO/NO-GO decision.

## Canonical output

The reports are evidence and design history.

The canonical integrated contract is:

- `docs/ARCHITECTURE_V0.md`

The execution order remains:

1. Wave 1 single-chat vertical slice.
2. Wave 2 single-chat reconciliation/continuation/fault injection.
3. Only after the Wave-2 QA gate: Wave 3 multi-chat orchestration.

## QA governance

The immutable baseline remains:

- `qa/IMMUTABLE_ACCEPTANCE_SUITE_v0.md`

Existing test IDs and pass criteria may not be weakened or removed. New tests may be added.

## Important process note

DOM selectors and exact UI markup are intentionally **not frozen**. The logical protocol, Delivery semantics, and durable-state invariants are frozen independently of the current ChatGPT DOM adapter implementation.
