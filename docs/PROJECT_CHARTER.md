# ChatGPT Multi-Chat Orchestrator — Project Charter

## Goal

Turn ordinary ChatGPT Project conversations into a practical multi-agent workflow without using the OpenAI API, Codex, Work mode, CrewAI, AutoGen, or non-ChatGPT reasoning agents.

The problem being solved is human routing overhead: manually copying orchestrator prompts into specialist chats, waiting for results, copying results back, issuing follow-ups, and recovering from UI/network/model failures.

All reasoning remains inside normal ChatGPT conversations using the user's existing ChatGPT plan/model access.

## System boundary

The local software is a **deterministic router**, not an AI agent.

It handles:

- identity;
- routing;
- validation;
- persistence;
- scheduling;
- retries;
- reconciliation;
- concurrency;
- observability.

It does not decide what research/proof/coding work should be done.

## MVP topology

```text
ChatGPT Project

Orchestrator conversation
        │
        │ validated control envelopes
        ▼
MV3 router/controller
        │
        ├── warm worker conversation 1
        ├── warm worker conversation 2
        ├── warm worker conversation 3
        └── warm worker conversation 4
        │
        ▼
IndexedDB
  runs / agents / slots / tasks
  deliveries / inbox / leases
  results / errors / event journal

Later:
  GitHub artifacts
  Windows watchdog
  dashboard/notifications
```

## Architectural framing

Treat the system as a **durable distributed state machine whose only unreliable external edge is the ChatGPT DOM**.

Key implications:

- IndexedDB is authoritative.
- The MV3 service worker is ephemeral.
- Persist before every external side effect.
- Never claim exactly-once delivery.
- Use at-most-once side effects plus reconciliation.
- Uncertain delivery fails closed.
- UI turn completion and task completion are distinct.
- Worker output cannot directly control the router.
- Manual user intervention pauses automation for that conversation.
- Logical agent identity is distinct from slot and conversation identity.

## Initial implementation strategy

1. Audit and reuse YOLO reliability machinery wherever appropriate.
2. Validate current live ChatGPT DOM assumptions before freezing DOM-dependent interfaces.
3. Build one minimal end-to-end single-chat vertical slice.
4. Add deterministic fault injection and crash-boundary reconciliation.
5. Only then implement two-worker orchestration.
6. Add unattended recovery.
7. Add GitHub artifact integration and operator UX after correctness.

See:

- [Implementation Roadmap](IMPLEMENTATION_ROADMAP.md)
- [Immutable Acceptance Suite v0](../qa/IMMUTABLE_ACCEPTANCE_SUITE_v0.md)

## MVP non-goals

Do not initially build:

- dynamic ChatGPT conversation creation;
- large worker pools;
- GitHub as the delivery/orchestration database;
- complex DAG UI;
- Telegram/remote control;
- automatic model switching;
- multiple orchestrators;
- cross-machine coordination;
- polished dashboard.

## First decisive milestone

One orchestrator and two pre-created worker chats must be able to:

- receive independent goals;
- run worker-local continuation loops;
- recover from a deliberately injected failure;
- return terminal results automatically;
- receive a follow-up from the orchestrator;
- survive controller/Chrome restart without duplicated router-owned user turns.

Multi-chat work is blocked until the single-chat delivery system passes the Wave-2 acceptance gate.
