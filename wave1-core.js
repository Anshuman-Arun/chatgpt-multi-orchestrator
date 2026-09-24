((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MultiAgentWave1Core = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const PROTOCOL_VERSION = 1;
  const QUIESCENCE_MS = 4_000;
  const WORKER_START = "<<<MULTIAGENT:WORKER:v1>>>";
  const WORKER_END = "<<<END:MULTIAGENT:WORKER:v1>>>";
  const DELIVERY_STATES = Object.freeze([
    "PENDING", "CLAIMED", "COMPOSER_FILLING", "COMPOSER_FILLED", "SUBMITTING",
    "SENT_UNCONFIRMED", "DELIVERED", "RESPONSE_STARTED", "RESPONSE_RECEIVED", "ACKED",
    "DELIVERY_UNKNOWN", "FAILED", "RESPONSE_FAILED", "RESPONSE_SUPERSEDED"
  ]);
  const TRANSITIONS = Object.freeze({
    PENDING: new Set(["CLAIMED", "FAILED"]),
    CLAIMED: new Set(["COMPOSER_FILLING", "FAILED"]),
    COMPOSER_FILLING: new Set(["COMPOSER_FILLED", "FAILED"]),
    COMPOSER_FILLED: new Set(["SUBMITTING", "FAILED"]),
    SUBMITTING: new Set(["SENT_UNCONFIRMED", "DELIVERED", "DELIVERY_UNKNOWN"]),
    SENT_UNCONFIRMED: new Set(["DELIVERED", "DELIVERY_UNKNOWN"]),
    DELIVERED: new Set(["RESPONSE_STARTED", "RESPONSE_FAILED"]),
    RESPONSE_STARTED: new Set(["RESPONSE_RECEIVED", "RESPONSE_FAILED", "RESPONSE_SUPERSEDED"]),
    RESPONSE_RECEIVED: new Set(["ACKED"]),
    ACKED: new Set(),
    DELIVERY_UNKNOWN: new Set(),
    FAILED: new Set(),
    RESPONSE_FAILED: new Set(),
    RESPONSE_SUPERSEDED: new Set()
  });

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function fingerprint(value) {
    const text = normalizeText(value);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${text.length}`;
  }

  async function sha256Hex(value) {
    const text = String(value ?? "");
    if (globalThis.crypto?.subtle && typeof TextEncoder !== "undefined") {
      const bytes = new TextEncoder().encode(text);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    if (typeof require === "function") {
      return require("node:crypto").createHash("sha256").update(text).digest("hex");
    }
    throw new Error("SHA-256 is unavailable");
  }

  function currentContext(input) {
    return {
      protocol_version: PROTOCOL_VERSION,
      run_id: String(input.run_id || ""),
      task_id: String(input.task_id || ""),
      logical_agent_id: String(input.logical_agent_id || ""),
      slot_id: String(input.slot_id || ""),
      conversation_id: String(input.conversation_id || ""),
      delivery_id: String(input.delivery_id || ""),
      conversation_seq: Number(input.conversation_seq) || 0
    };
  }

  function buildRouterPayload(input) {
    const context = currentContext(input);
    const ownershipToken = String(input.ownership_token || "").trim();
    const instruction = String(input.instruction || "").trim();
    if (!ownershipToken || !instruction || Object.values(context).some((value) => value === "" || value === 0)) {
      throw new Error("Wave-1 router payload requires complete controller context, ownership token, and instruction");
    }
    const terminal = { ...context, status: "DONE" };
    return [
      "[MULTIAGENT ROUTER DELIVERY v1]",
      "This is a controller-owned Wave-1 worker delivery. Treat the identifiers below as opaque and echo them exactly in the terminal block.",
      `delivery_id: ${context.delivery_id}`,
      `ownership_token: ${ownershipToken}`,
      `run_id: ${context.run_id}`,
      `task_id: ${context.task_id}`,
      `logical_agent_id: ${context.logical_agent_id}`,
      `slot_id: ${context.slot_id}`,
      `conversation_id: ${context.conversation_id}`,
      `conversation_seq: ${context.conversation_seq}`,
      `protocol_version: ${PROTOCOL_VERSION}`,
      "",
      "Task:",
      instruction,
      "",
      "When the task is complete, end your response with exactly one terminal worker block. Put no content after the end sentinel:",
      WORKER_START,
      JSON.stringify(terminal),
      WORKER_END
    ].join("\n");
  }

  function canTransition(previousState, nextState) {
    return Boolean(TRANSITIONS[previousState]?.has(nextState));
  }

  function baselineKeys(baseline, role) {
    const values = role === "assistant" ? baseline?.assistant_keys : baseline?.user_keys;
    return new Set(Array.isArray(values) ? values.map(String) : []);
  }

  function turnsAfterAnchor(snapshot, anchorIdentity, role = "") {
    const turns = Array.isArray(snapshot?.turns) ? snapshot.turns : [];
    const anchor = turns.find((turn) => String(turn?.identity_key || "") === String(anchorIdentity || ""));
    if (!anchor) return [];
    return turns
      .filter((turn) => Number(turn?.order) > Number(anchor.order))
      .filter((turn) => !role || turn?.role === role)
      .sort((a, b) => Number(a.order) - Number(b.order));
  }

  async function findOwnedUserReceipt({ delivery, baseline, snapshot }) {
    if (!delivery || !snapshot) return { ok: false, code: "receipt.input_missing" };
    if (String(snapshot.route_identity || "") !== String(delivery.provider_locator || "")) {
      return { ok: false, code: "receipt.route_mismatch" };
    }
    const expected = normalizeText(delivery.payload);
    if (!expected || !delivery.delivery_id || !delivery.ownership_token) {
      return { ok: false, code: "receipt.delivery_invalid" };
    }
    const baselineUser = baselineKeys(baseline, "user");
    const candidates = (Array.isArray(snapshot.turns) ? snapshot.turns : [])
      .filter((turn) => turn?.role === "user" && !baselineUser.has(String(turn.identity_key || "")))
      .sort((a, b) => Number(a.order) - Number(b.order));
    for (const turn of candidates) {
      const actual = normalizeText(turn.text);
      if (!actual.includes(String(delivery.delivery_id)) || !actual.includes(String(delivery.ownership_token))) continue;
      if (actual !== expected) continue;
      const hash = await sha256Hex(actual);
      if (delivery.payload_hash && hash !== delivery.payload_hash) continue;
      return { ok: true, turn: { ...turn, text_hash: hash } };
    }
    return { ok: false, code: candidates.length ? "receipt.no_exact_owned_turn" : "receipt.no_new_user_turn" };
  }

  function selectAssistantCandidate({ baseline, receipt, snapshot, currentIdentity = "" }) {
    if (!receipt?.turn || !snapshot) return null;
    const baselineAssistant = baselineKeys(baseline, "assistant");
    const candidates = (Array.isArray(snapshot.turns) ? snapshot.turns : [])
      .filter((turn) => turn?.role === "assistant")
      .filter((turn) => !baselineAssistant.has(String(turn.identity_key || "")))
      .filter((turn) => Number(turn.order) > Number(receipt.turn.order))
      .sort((a, b) => Number(a.order) - Number(b.order));
    if (currentIdentity) {
      const current = candidates.find((turn) => String(turn.identity_key || "") === String(currentIdentity));
      if (current) return current;
    }
    return candidates[0] || null;
  }

  function turnCompletionEvidence({ delivered = false, candidate = null, snapshot = {}, last_changed_at = 0, now = Date.now() } = {}) {
    const reasons = [];
    if (!delivered) reasons.push("delivery_not_confirmed");
    if (!candidate?.identity_key || !normalizeText(candidate.text)) reasons.push("assistant_candidate_missing");
    if (snapshot.generating) reasons.push("generation_active");
    if (snapshot.error_code) reasons.push(`error:${snapshot.error_code}`);
    if (!snapshot.composer_present) reasons.push("composer_missing");
    if (normalizeText(snapshot.composer_text)) reasons.push("composer_not_idle");
    if (!snapshot.idle_send_path) reasons.push("idle_send_path_missing");
    const quietMs = Math.max(0, Number(now) - Math.max(0, Number(last_changed_at) || 0));
    if (quietMs < QUIESCENCE_MS) reasons.push("assistant_not_quiescent");
    return {
      complete: reasons.length === 0,
      reasons,
      evidence: {
        delivered: Boolean(delivered),
        candidate_identity: candidate?.identity_key || "",
        generating: Boolean(snapshot.generating),
        error_code: String(snapshot.error_code || ""),
        composer_idle: Boolean(snapshot.composer_present) && !normalizeText(snapshot.composer_text),
        idle_send_path: Boolean(snapshot.idle_send_path),
        quiet_ms: quietMs,
        quiescence_required_ms: QUIESCENCE_MS
      }
    };
  }

  const WORKER_KEYS = Object.freeze([
    "conversation_id", "conversation_seq", "delivery_id", "logical_agent_id",
    "protocol_version", "run_id", "slot_id", "status", "task_id"
  ]);

  function duplicateTopLevelJsonKey(jsonText) {
    const text = String(jsonText || "");
    let index = 0;
    const seen = new Set();
    const skipWhitespace = () => { while (/\s/.test(text[index] || "")) index += 1; };
    const readString = () => {
      if (text[index] !== '"') return null;
      const start = index;
      index += 1;
      let escaped = false;
      while (index < text.length) {
        const char = text[index++];
        if (escaped) { escaped = false; continue; }
        if (char === "\\") { escaped = true; continue; }
        if (char === '"') {
          try { return JSON.parse(text.slice(start, index)); } catch { return null; }
        }
      }
      return null;
    };
    const skipValue = () => {
      let objectDepth = 0;
      let arrayDepth = 0;
      let inString = false;
      let escaped = false;
      while (index < text.length) {
        const char = text[index];
        if (inString) {
          index += 1;
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') { inString = true; index += 1; continue; }
        if (char === "{") { objectDepth += 1; index += 1; continue; }
        if (char === "[") { arrayDepth += 1; index += 1; continue; }
        if (char === "}") {
          if (objectDepth > 0) { objectDepth -= 1; index += 1; continue; }
          if (arrayDepth === 0) return;
        }
        if (char === "]" && arrayDepth > 0) { arrayDepth -= 1; index += 1; continue; }
        if (char === "," && objectDepth === 0 && arrayDepth === 0) return;
        index += 1;
      }
    };

    skipWhitespace();
    if (text[index++] !== "{") return "";
    while (index < text.length) {
      skipWhitespace();
      if (text[index] === "}") return "";
      const key = readString();
      if (key == null) return "";
      if (seen.has(key)) return key;
      seen.add(key);
      skipWhitespace();
      if (text[index++] !== ":") return "";
      skipWhitespace();
      skipValue();
      skipWhitespace();
      if (text[index] === ",") { index += 1; continue; }
      if (text[index] === "}") return "";
      return "";
    }
    return "";
  }

  function parseWorkerTerminal(responseText, expectedInput) {
    const text = String(responseText || "").trim();
    const starts = text.split(WORKER_START).length - 1;
    const ends = text.split(WORKER_END).length - 1;
    if (starts !== 1 || ends !== 1) return { ok: false, code: "protocol.block_count" };
    const startIndex = text.lastIndexOf(WORKER_START);
    const endIndex = text.lastIndexOf(WORKER_END);
    if (startIndex < 0 || endIndex < startIndex || endIndex + WORKER_END.length !== text.length) {
      return { ok: false, code: "protocol.not_terminal" };
    }
    const jsonText = text.slice(startIndex + WORKER_START.length, endIndex).trim();
    if (duplicateTopLevelJsonKey(jsonText)) return { ok: false, code: "protocol.duplicate_key" };
    let envelope;
    try {
      envelope = JSON.parse(jsonText);
    } catch {
      return { ok: false, code: "protocol.invalid_json" };
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return { ok: false, code: "protocol.invalid_shape" };
    const keys = Object.keys(envelope).sort();
    if (keys.length !== WORKER_KEYS.length || keys.some((key, index) => key !== WORKER_KEYS[index])) {
      return { ok: false, code: "protocol.schema_keys" };
    }
    const expected = currentContext(expectedInput || {});
    if (envelope.status !== "DONE") return { ok: false, code: "protocol.wave1_status" };
    if (envelope.protocol_version !== PROTOCOL_VERSION) return { ok: false, code: "protocol.version" };
    if (envelope.conversation_seq !== expected.conversation_seq) return { ok: false, code: "protocol.conversation_seq" };
    for (const key of ["run_id", "task_id", "logical_agent_id", "slot_id", "conversation_id", "delivery_id"]) {
      if (String(envelope[key] || "") !== String(expected[key] || "")) return { ok: false, code: `protocol.${key}` };
    }
    return { ok: true, envelope, block: text.slice(startIndex) };
  }

  function reconstructDelivery(events, deliveryId) {
    const relevant = (Array.isArray(events) ? events : []).filter((event) => String(event?.delivery_id || "") === String(deliveryId || ""));
    if (!relevant.length) return { ok: false, code: "journal.empty", states: [], events: [] };
    let previousSeq = -Infinity;
    let currentState = null;
    const states = [];
    for (const event of relevant) {
      const seq = Number(event.seq);
      if (!Number.isInteger(seq) || seq <= previousSeq) return { ok: false, code: "journal.non_monotonic", states, events: relevant };
      previousSeq = seq;
      const previous = event.previous_state == null ? null : String(event.previous_state);
      const next = event.next_state == null ? null : String(event.next_state);
      if (previous !== currentState) return { ok: false, code: "journal.state_gap", states, events: relevant };
      if (next !== currentState && next != null) {
        if (currentState !== null && !canTransition(currentState, next)) return { ok: false, code: "journal.invalid_transition", states, events: relevant };
        currentState = next;
        states.push(next);
      }
    }
    return { ok: true, states, current_state: currentState, events: relevant };
  }

  return Object.freeze({
    PROTOCOL_VERSION,
    QUIESCENCE_MS,
    WORKER_START,
    WORKER_END,
    DELIVERY_STATES,
    TRANSITIONS,
    normalizeText,
    fingerprint,
    sha256Hex,
    currentContext,
    buildRouterPayload,
    canTransition,
    turnsAfterAnchor,
    findOwnedUserReceipt,
    selectAssistantCandidate,
    turnCompletionEvidence,
    parseWorkerTerminal,
    reconstructDelivery
  });
});
