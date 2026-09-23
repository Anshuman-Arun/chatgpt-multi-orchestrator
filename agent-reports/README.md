# Wave 0 Agent Reports

This directory is the handoff point for the independent Wave 0 architecture agents.

## Required reports

- `agent-a-protocol.md` — protocol and orchestration semantics
- `agent-b-reliability.md` — reliability, persistence, reconciliation, and YOLO reuse
- `agent-c-dom-feasibility.md` — live ChatGPT DOM/completion feasibility
- `agent-d-integration.md` — adversarial integration/referee report

## Workflow

1. Agents A, B, and C work independently.
2. Their reports are added here without reconciling contradictions.
3. Agent D receives all three reports plus:
   - `docs/PROJECT_CHARTER.md`
   - `docs/IMPLEMENTATION_ROADMAP.md`
   - `qa/IMMUTABLE_ACCEPTANCE_SUITE_v0.md`
4. Agent D attacks contradictions and produces the proposed logical-contract freeze.
5. No production multi-chat scheduler implementation begins before Agent D's GO decision and the Wave 1 vertical slice.

## Report discipline

Each report should explicitly distinguish:

- verified facts;
- tested observations;
- architectural recommendations;
- assumptions;
- unresolved questions.

Agent C in particular must distinguish live-UI observations from inference or behavior merely copied from another repository.

## QA governance

Agents may propose new acceptance tests.

They may not weaken or delete existing tests in `qa/IMMUTABLE_ACCEPTANCE_SUITE_v0.md`.

Any existing test believed to be impossible or internally inconsistent must be flagged for human adjudication.
