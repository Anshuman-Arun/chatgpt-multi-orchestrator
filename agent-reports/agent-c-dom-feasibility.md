# Agent C — DOM / Completion Feasibility Findings

## Status

The DOM workstream is treated as evidence about the unreliable transport edge, not as authority over protocol or persisted machine state.

The integration layer freezes **semantic observations and fallback requirements**, not CSS selectors.

## Selected transport architecture

Use:

- Manifest V3 extension;
- content scripts adjacent to each managed ChatGPT DOM;
- ephemeral service worker for short coordination/transactions;
- IndexedDB for authority;
- no hidden iframe dependency for MVP;
- optional external watchdog only after core correctness.

The content script may keep active MutationObservers, but correctness must survive observer loss, content-script reload, and service-worker death.

## Completion is a state machine, not `waitUntilComplete()`

Required semantic observations include:

- matching owned user message observed -> strong Delivery receipt;
- stop-generation control visible -> generation active;
- active assistant-turn mutations -> streaming/tool activity;
- connection-warning UI -> degraded transport;
- retry/error UI -> generation failure state;
- send control available -> weak idle signal only;
- turn-level Copy control -> strong supporting turn-complete signal;
- several seconds without mutation -> supporting quiescence signal only;
- valid current terminal protocol -> task terminal.

No single weak UI observation is sufficient.

## Critical distinction

`TURN_COMPLETE` and `TASK_TERMINAL` are separate.

A cleanly ended assistant response lacking the current valid terminal worker/orchestrator envelope is nonterminal for the task.

This is how truncation and missing protocol blocks are handled without guessing.

## DOM adapter boundary

Higher layers should consume semantic functions rather than selectors. The v0 adapter should expose concepts equivalent to:

```text
getRouteIdentity()
getComposerState()
writeComposerExact()
requestSend()
getLatestOwnedUserTurn()
getActiveAssistantTurn()
observeConversation()
classifyGenerationState()
classifyErrorState()
getTurnCompletionEvidence()
```

Exact names may change, but no durable-core module may query selectors directly.

## Signal hierarchy

### Strong

- exact owned user-turn receipt;
- positive active-generation controls;
- assistant mutation scoped to the current candidate turn;
- explicit retry/error/connection UI when recognized;
- terminal protocol validation for task completion.

### Supporting

- Copy control;
- Send enabled;
- short quiescence/stability window;
- assistant count changes.

Supporting signals may help classify but must not alone cause a correctness-critical transition.

### Unsafe as sole proof

- fixed timeout;
- text stability alone;
- assistant-message count alone;
- composer empty;
- latest visible assistant text without causal binding.

## Error handling requirements

The DOM adapter must normalize, at minimum:

- thinking/long-reasoning state;
- red Retry/problem state;
- connection-waiting state;
- timeout/interrupted generation where detectable;
- unrecognized UI;
- authentication/user-required UI;
- route mismatch;
- tab/content-script rehydration.

Unknown UI degrades to a paused/unrecognized state rather than speculative automation.

## MutationObserver requirements

Observers should be scoped to the current relevant conversation/assistant region where possible.

Duplicate mutation callbacks are expected and must be idempotent.

Observer replacement or full DOM rerender must not itself imply completion or restart a Delivery.

After reload/rehydration, the adapter reports a fresh semantic snapshot and the durable core performs reconciliation.

## Conversation identity

Persistent bindings must not depend on tab ID.

The browser adapter maps controller-local `conversation_id` to the current provider/UI locator and tab/document actors.

Tab close/reopen, SPA navigation, and content-script reinjection must re-establish the binding before the conversation becomes send-eligible.

## What remains deliberately unfrozen

- CSS selectors;
- exact Copy-button selector/availability;
- exact Stop/Send DOM representation;
- exact quiescence duration;
- exact MutationObserver root;
- assistant-card internal structure;
- ChatGPT A/B-test-specific markup.

These remain replaceable adapter details and are covered by live smoke testing.
