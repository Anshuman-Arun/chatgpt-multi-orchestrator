# Agent A — Merged Protocol / Orchestration Report

This report reconciles two independent protocol-agent runs. Where they disagree, the selected v0 rule is stated explicitly.

## Shared conclusions

Both runs converge on the core trust rule:

> The controller never infers intent from prose. It executes only a currently eligible, schema-valid orchestrator envelope or a deterministic worker-local transition that was previously authorized.

Workers may return only `CONTINUE`, `DONE`, or `ESCALATE`. Worker output never creates cross-task actions.

## Frozen identity model

All orchestration identities are controller-owned opaque IDs:

- `run_id`
- `decision_round_id`
- `task_id`
- `delivery_id`
- `logical_agent_id`
- `slot_id`
- `conversation_id`

`conversation_id` is controller-local. Provider/UI locators such as a ChatGPT `/c/<id>` URL are stored separately in the browser binding layer.

Logical agent, slot, and conversation identity are distinct from day one.

## Selected spawn model: preallocated spawn handles

One protocol run generated task/agent IDs after accepting `spawn`; the other preallocated controller-owned spawn handles before the orchestrator decision.

v0 selects **preallocated spawn handles**.

Each decision round supplies a bounded set of pairs:

```json
{
  "task_id": "task_...",
  "logical_agent_id": "agent_..."
}
```

The orchestrator may use only supplied unused pairs. Unused handles expire with the round.

Reasons:

- controller retains ownership of every ID;
- same-round dependency graphs can reference concrete task IDs;
- deterministic replay is simpler;
- invented task IDs invalidate the envelope.

## Universal Delivery protocol

Every router-generated ChatGPT user turn uses the same Delivery abstraction:

- `ASSIGNMENT`
- `CONTINUATION`
- `FOLLOW_UP`
- `ORCHESTRATOR_EVENTS`
- `PROTOCOL_REPAIR`

Retries before the irreversible send boundary retain the same logical Delivery. A protocol repair is a new Delivery associated with the same task/decision round.

Each conversation also has a monotonically increasing `conversation_seq`, retained across retries of the same logical Delivery.

## Worker response format

v0 permits substantive worker prose before the machine block. The machine block must be the final non-whitespace content of the assistant turn.

```text
<<<MULTIAGENT:WORKER:v1>>>
{ strict JSON }
<<<END:MULTIAGENT:WORKER:v1>>>
```

The controller accepts it only when conversation role, current outstanding Delivery, all controller-owned IDs, `conversation_seq`, protocol version, schema, and terminal position all match.

The worker schema contains no action or recipient fields.

### Worker statuses

`CONTINUE`
- same task only;
- may create exactly one bounded local continuation Delivery if budget remains.

`DONE`
- current assignment/follow-up is complete;
- task becomes quiescent;
- creates one upstream worker-terminal event.

`ESCALATE`
- local loop stops;
- carries one structured reason:
  - `MISSING_INFORMATION`
  - `NEEDS_ORCHESTRATOR_DECISION`
  - `NEEDS_USER`
  - `TOOL_FAILURE`
  - `BUDGET_EXHAUSTED`
  - `CONTRADICTION`

If the controller itself exhausts a continuation budget, it emits a controller event describing budget exhaustion rather than pretending the worker returned `ESCALATE`.

## Orchestrator response format

```text
<<<MULTIAGENT:ORCHESTRATOR:v1>>>
{ strict JSON }
<<<END:MULTIAGENT:ORCHESTRATOR:v1>>>
```

Core v0 actions are exactly:

- `spawn`
- `message`
- `wait`
- `done`
- `needs_user`

The entire envelope is semantically preflighted and committed atomically before any resulting UI Delivery begins. Partial action-array execution is forbidden.

### Structural rules

A scheduling envelope contains:

- zero or more `spawn` / `message` actions;
- exactly one final `wait` action.

Or it contains only:

- `done`; or
- `needs_user`.

`done` is valid only when no nonterminal worker task remains.

`needs_user` pauses issuance of new worker Deliveries globally for MVP. Already in-flight turns may finish and their results are buffered.

## Wait semantics

Public `wait` supports `ANY` and `ALL` over explicit task IDs.

Dependency waiting is derived from `spawn.depends_on`; it is not another public action.

A wait determines **when to wake the orchestrator**, not whether unrelated workers may continue.

Only successful `DONE` satisfies a task dependency. `ESCALATE` leaves dependents blocked and creates a decision-worthy event.

## Warm-slot rule

For the MVP, one warm slot is bound to at most one logical agent during a run. Do not recycle a conversation into an unrelated logical agent within the same run. This intentionally limits semantic contamination from prior chat history.

A completed logical agent may receive follow-ups on its same task through the same slot.

## Human intervention

A manual user turn in a managed worker conversation invalidates the current causal chain and pauses the lane.

A manual user turn in the orchestrator conversation is normalized into a `HUMAN_INPUT` event. The immediate unmanaged assistant reply has no controller authority. A new controlled orchestrator decision round must follow.

## Replay/idempotency

- one committed orchestrator response per decision round;
- duplicate identical observation = no-op;
- conflicting second response for the same round = protocol conflict;
- one committed worker result per Delivery;
- stale historical protocol blocks have no authority;
- embedded sentinel-looking text inside payload strings is inert;
- the parser never recursively parses worker/human text.

## Deliberately excluded from v1

- cancellation protocol;
- dynamic worker-chat creation;
- slot recycling within a run;
- task migration;
- worker priorities;
- mid-generation interruption;
- worker-to-worker messaging;
- nested runs;
- multiple orchestrators.
