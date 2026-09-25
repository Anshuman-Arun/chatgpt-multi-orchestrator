const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../wave1-core.js");

const ids = Object.freeze({
  protocol_version: 1,
  run_id: "run_test",
  task_id: "task_test",
  logical_agent_id: "agent_test",
  slot_id: "slot_test",
  conversation_id: "conversation_test",
  delivery_id: "delivery_test",
  conversation_seq: 1
});

function doneBlock(overrides = {}) {
  return [
    "Worker prose.",
    "<<<MULTIAGENT:WORKER:v1>>>",
    JSON.stringify({ ...ids, status: "DONE", ...overrides }),
    "<<<END:MULTIAGENT:WORKER:v1>>>"
  ].join("\n");
}

test("router payload carries controller identity and an ownership nonce", async () => {
  const payload = Core.buildRouterPayload({ ...ids, ownership_token: "own_secret", instruction: "Prove 2+2=4." });
  assert.match(payload, /delivery_test/);
  assert.match(payload, /own_secret/);
  assert.match(payload, /Prove 2\+2=4\./);
  assert.match(payload, /<<<MULTIAGENT:WORKER:v1>>>/);
  assert.equal(await Core.sha256Hex(Core.normalizeText(payload)), await Core.sha256Hex(Core.normalizeText(payload)));
});

test("owned user receipt requires exact route, non-baseline identity, marker, nonce, text and hash", async () => {
  const payload = Core.buildRouterPayload({ ...ids, ownership_token: "own_secret", instruction: "Return DONE." });
  const hash = await Core.sha256Hex(Core.normalizeText(payload));
  const delivery = { ...ids, provider_locator: "https://chatgpt.com/c/abc", ownership_token: "own_secret", payload, payload_hash: hash };
  const baseline = { user_keys: ["msg:old-user"], assistant_keys: [] };
  const snapshot = {
    route_identity: "https://chatgpt.com/c/abc",
    turns: [
      { role: "user", identity_key: "msg:old-user", text: "old", order: 0 },
      { role: "user", identity_key: "msg:new-user", text: payload, order: 1 }
    ]
  };
  const receipt = await Core.findOwnedUserReceipt({ delivery, baseline, snapshot });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.turn.identity_key, "msg:new-user");

  assert.equal((await Core.findOwnedUserReceipt({ delivery: { ...delivery, provider_locator: "https://chatgpt.com/c/other" }, baseline, snapshot })).ok, false);
  assert.equal((await Core.findOwnedUserReceipt({ delivery, baseline: { user_keys: ["msg:new-user"], assistant_keys: [] }, snapshot })).ok, false);
  assert.equal((await Core.findOwnedUserReceipt({ delivery, baseline, snapshot: { ...snapshot, turns: [{ ...snapshot.turns[1], text: payload.replace("own_secret", "own_wrong") }] } })).ok, false);
});

test("assistant candidate is non-baseline and structurally follows exact receipt without using counts", () => {
  const baseline = { assistant_keys: ["msg:a0"] };
  const receipt = { turn: { identity_key: "msg:u1", fingerprint: "fp:u1", order: 4 } };
  const snapshot = {
    turns: [
      { role: "assistant", identity_key: "msg:a0", identity_kind: "message_id", order: 2, text: "old" },
      { role: "user", identity_key: "msg:u1", identity_kind: "message_id", fingerprint: "fp:u1", order: 4, text: "owned" },
      { role: "assistant", identity_key: "dom:a1", identity_kind: "dom", order: 5, text: "new response" },
      { role: "assistant", identity_key: "fp:a2", identity_kind: "fingerprint", order: 7, text: "later response" }
    ],
    assistant_count: 999
  };
  const candidate = Core.selectAssistantCandidate({ baseline, receipt, snapshot });
  assert.equal(candidate.identity_key, "dom:a1");
  assert.equal(candidate.text, "new response");
});

test("turn completion requires delivery receipt, assistant, no generation/error, idle composer/send and four-second quiescence", () => {
  const base = {
    delivered: true,
    candidate: { identity_key: "msg:a1", text: "answer" },
    snapshot: { generating: false, error_code: "", composer_present: true, composer_text: "", idle_send_path: true },
    last_changed_at: 1000,
    now: 5001
  };
  assert.equal(Core.turnCompletionEvidence(base).complete, true);
  assert.equal(Core.turnCompletionEvidence({ ...base, delivered: false }).complete, false);
  assert.equal(Core.turnCompletionEvidence({ ...base, snapshot: { ...base.snapshot, generating: true } }).complete, false);
  assert.equal(Core.turnCompletionEvidence({ ...base, snapshot: { ...base.snapshot, error_code: "retry" } }).complete, false);
  assert.equal(Core.turnCompletionEvidence({ ...base, snapshot: { ...base.snapshot, composer_text: "draft" } }).complete, false);
  assert.equal(Core.turnCompletionEvidence({ ...base, now: 4999 }).complete, false);
});

test("terminal parser accepts exactly one terminal DONE block with exact current context", () => {
  const parsed = Core.parseWorkerTerminal(doneBlock(), ids);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.envelope.status, "DONE");
  assert.equal(Core.parseWorkerTerminal(`${doneBlock()}\ntrailing`, ids).ok, false);
  assert.equal(Core.parseWorkerTerminal(doneBlock({ delivery_id: "delivery_stale" }), ids).ok, false);
  assert.equal(Core.parseWorkerTerminal(`${doneBlock()}\n${doneBlock()}`, ids).ok, false);
  assert.equal(Core.parseWorkerTerminal("No terminal block", ids).ok, false);
});

test("terminal parser rejects extra command-shaped fields and non-DONE Wave-1 statuses", () => {
  assert.equal(Core.parseWorkerTerminal(doneBlock({ action: "spawn" }), ids).ok, false);
  assert.equal(Core.parseWorkerTerminal(doneBlock({ status: "CONTINUE" }), ids).ok, false);
});

test("delivery transitions preserve the irreversible send boundary", () => {
  assert.equal(Core.canTransition("PENDING", "CLAIMED"), true);
  assert.equal(Core.canTransition("COMPOSER_FILLED", "SUBMITTING"), true);
  assert.equal(Core.canTransition("COMPOSER_FILLED", "SENT_UNCONFIRMED"), false);
  assert.equal(Core.canTransition("SUBMITTING", "DELIVERY_UNKNOWN"), true);
  assert.equal(Core.canTransition("DELIVERY_UNKNOWN", "PENDING"), false);
});

test("journal reconstruction requires monotonic sequence and returns the exact transition path", () => {
  const events = [
    { seq: 8, delivery_id: ids.delivery_id, previous_state: null, next_state: "PENDING" },
    { seq: 9, delivery_id: ids.delivery_id, previous_state: "PENDING", next_state: "CLAIMED" },
    { seq: 10, delivery_id: ids.delivery_id, previous_state: "CLAIMED", next_state: "COMPOSER_FILLING" }
  ];
  const result = Core.reconstructDelivery(events, ids.delivery_id);
  assert.equal(result.ok, true);
  assert.deepEqual(result.states, ["PENDING", "CLAIMED", "COMPOSER_FILLING"]);
  assert.equal(Core.reconstructDelivery([events[1], events[0]], ids.delivery_id).ok, false);
});


test("terminal parser rejects duplicate top-level JSON keys", () => {
  const response = [
    "Worker prose.",
    "<<<MULTIAGENT:WORKER:v1>>>",
    '{"protocol_version":1,"run_id":"run_test","run_id":"run_test","task_id":"task_test","logical_agent_id":"agent_test","slot_id":"slot_test","conversation_id":"conversation_test","delivery_id":"delivery_test","conversation_seq":1,"status":"DONE"}',
    "<<<END:MULTIAGENT:WORKER:v1>>>"
  ].join("\n");
  const parsed = Core.parseWorkerTerminal(response, ids);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "protocol.duplicate_key");
});


test("tail-anchored appended-turn detection ignores virtualized older history", () => {
  const snapshot = {
    turns: [
      { role: "user", identity_key: "old-late-render", order: 0 },
      { role: "assistant", identity_key: "baseline-tail", order: 1 },
      { role: "user", identity_key: "new-user", order: 2 },
      { role: "assistant", identity_key: "new-assistant", order: 3 }
    ]
  };
  assert.deepEqual(
    Core.turnsAfterAnchor(snapshot, "baseline-tail", "user").map((turn) => turn.identity_key),
    ["new-user"]
  );
  assert.deepEqual(Core.turnsAfterAnchor(snapshot, "missing-tail", "user"), []);

  const rerendered = {
    turns: [
      { role: "assistant", identity_key: "new-tail-node", fingerprint: "tail-fp", order: 1 },
      { role: "user", identity_key: "new-user", order: 2 }
    ]
  };
  assert.deepEqual(
    Core.turnsAfterAnchor(rerendered, "old-tail-node", "user", "tail-fp").map((turn) => turn.identity_key),
    ["new-user"]
  );
  const ambiguous = {
    turns: [
      { role: "assistant", identity_key: "a", fingerprint: "tail-fp", order: 0 },
      { role: "assistant", identity_key: "b", fingerprint: "tail-fp", order: 1 },
      { role: "user", identity_key: "new-user", order: 2 }
    ]
  };
  assert.deepEqual(Core.turnsAfterAnchor(ambiguous, "old-tail-node", "user", "tail-fp"), []);
});


test("assistant causality re-anchors the owned user turn after DOM reorder", () => {
  const baseline = { assistant_keys: ["old-assistant"] };
  const receipt = { turn: { identity_key: "old-owned-user-node", fingerprint: "fp-owned", order: 99 } };
  const snapshot = {
    turns: [
      { role: "user", identity_key: "new-owned-user-node", fingerprint: "fp-owned", order: 1, text: "owned" },
      { role: "assistant", identity_key: "new-assistant", fingerprint: "fp-answer", order: 2, text: "answer" }
    ]
  };
  assert.equal(Core.selectAssistantCandidate({ baseline, receipt, snapshot })?.identity_key, "new-assistant");

  const noAnchor = { turns: [{ role: "assistant", identity_key: "new-assistant", order: 2, text: "answer" }] };
  assert.equal(Core.selectAssistantCandidate({ baseline, receipt, snapshot: noAnchor }), null);
  assert.equal(
    Core.selectAssistantCandidate({ baseline, receipt, snapshot: noAnchor, currentIdentity: "new-assistant" })?.identity_key,
    "new-assistant"
  );
});


test("assistant causality prefers exact owned user text when identity is replaced", () => {
  const receipt = { turn: { identity_key: "gone", fingerprint: "weak-fp", order: 90 } };
  const snapshot = {
    turns: [
      { role: "user", identity_key: "rehydrated", fingerprint: "different-fp", order: 3, text: "owned payload" },
      { role: "assistant", identity_key: "answer", order: 4, text: "response" }
    ]
  };
  assert.equal(
    Core.selectAssistantCandidate({
      baseline: { assistant_keys: [] },
      receipt,
      snapshot,
      ownedUserText: "owned   payload"
    })?.identity_key,
    "answer"
  );
});


test("terminal parser rejects type-coercible malformed schema values", () => {
  assert.equal(Core.parseWorkerTerminal(doneBlock({ run_id: ["run_test"] }), ids).ok, false);
  assert.equal(Core.parseWorkerTerminal(doneBlock({ task_id: { toString: "task_test" } }), ids).ok, false);
  assert.equal(Core.parseWorkerTerminal(doneBlock({ conversation_seq: "1" }), ids).ok, false);
  assert.equal(Core.parseWorkerTerminal(doneBlock({ protocol_version: "1" }), ids).ok, false);
  assert.equal(Core.parseWorkerTerminal(doneBlock({ status: ["DONE"] }), ids).ok, false);
});


test("canonical composer text preserves whitespace while normalizing line endings only", () => {
  assert.equal(Core.canonicalText("a  b\r\nc"), "a  b\nc");
  assert.notEqual(Core.canonicalText("a  b"), Core.canonicalText("a b"));
  assert.equal(Core.normalizeText("a  b"), Core.normalizeText("a b"));
});


test("response failures are legal only after delivery", () => {
  assert.equal(Core.canTransition("DELIVERED", "RESPONSE_FAILED"), true);
  assert.equal(Core.canTransition("RESPONSE_STARTED", "RESPONSE_FAILED"), true);
  assert.equal(Core.canTransition("SENT_UNCONFIRMED", "RESPONSE_FAILED"), false);
});


test("manual user intervention can supersede a delivered response", () => {
  assert.equal(Core.canTransition("DELIVERED", "RESPONSE_SUPERSEDED"), true);
  assert.equal(Core.canTransition("RESPONSE_STARTED", "RESPONSE_SUPERSEDED"), true);
  const snapshot = {
    turns: [
      { role: "user", identity_key: "owned-new", fingerprint: "owned-fp", order: 1, text: "router payload" },
      { role: "assistant", identity_key: "a1", order: 2, text: "partial" },
      { role: "user", identity_key: "manual", order: 3, text: "human interruption" }
    ]
  };
  assert.deepEqual(
    Core.turnsAfterAnchor(snapshot, "owned-old", "user", "owned-fp", "router   payload").map((turn) => turn.identity_key),
    ["manual"]
  );
});


test("baseline anchor resolution is explicit and fails closed when identity/text/fingerprint are all unavailable", () => {
  const rerendered = {
    turns: [
      { role: "assistant", identity_key: "new-tail", fingerprint: "new-fp", order: 4, text: "same tail text" },
      { role: "user", identity_key: "later-user", order: 5, text: "later" }
    ]
  };
  assert.equal(
    Core.resolveTurnAnchor(rerendered, "old-tail", "old-fp", "same   tail text")?.identity_key,
    "new-tail"
  );
  assert.equal(Core.resolveTurnAnchor(rerendered, "old-tail", "old-fp", "missing"), null);
});
