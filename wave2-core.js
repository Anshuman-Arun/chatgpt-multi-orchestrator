((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MultiAgentWave2Core = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const PROTOCOL_VERSION = 1;
  const WORKER_START = "<<<MULTIAGENT:WORKER:v1>>>";
  const WORKER_END = "<<<END:MULTIAGENT:WORKER:v1>>>";
  const DELIVERY_KINDS = Object.freeze(["ASSIGNMENT", "CONTINUATION", "FOLLOW_UP", "PROTOCOL_REPAIR", "ORCHESTRATOR_EVENTS"]);
  const WORKER_STATUSES = Object.freeze(["CONTINUE", "DONE", "ESCALATE"]);
  const ESCALATION_REASONS = Object.freeze([
    "MISSING_INFORMATION", "NEEDS_ORCHESTRATOR_DECISION", "NEEDS_USER",
    "TOOL_FAILURE", "BUDGET_EXHAUSTED", "CONTRADICTION"
  ]);
  const DELIVERY_STATES = Object.freeze([
    "PENDING", "CLAIMED", "COMPOSER_FILLING", "COMPOSER_FILLED", "SUBMITTING",
    "SENT_UNCONFIRMED", "DELIVERED", "RESPONSE_STARTED", "RESPONSE_RECEIVED", "ACKED",
    "DELIVERY_UNKNOWN", "FAILED", "RESPONSE_FAILED", "RESPONSE_SUPERSEDED"
  ]);
  const TERMINAL_STATES = new Set(["ACKED", "DELIVERY_UNKNOWN", "FAILED", "RESPONSE_FAILED", "RESPONSE_SUPERSEDED"]);
  const PRE_SEND_STATES = new Set(["PENDING", "CLAIMED", "COMPOSER_FILLING", "COMPOSER_FILLED"]);
  const POST_SEND_AMBIGUITY_STATES = new Set(["SUBMITTING", "SENT_UNCONFIRMED"]);
  const RESPONSE_STATES = new Set(["DELIVERED", "RESPONSE_STARTED", "RESPONSE_RECEIVED"]);
  const TRANSITIONS = Object.freeze({
    PENDING: new Set(["CLAIMED", "FAILED"]),
    CLAIMED: new Set(["COMPOSER_FILLING", "FAILED"]),
    COMPOSER_FILLING: new Set(["COMPOSER_FILLED", "FAILED"]),
    COMPOSER_FILLED: new Set(["SUBMITTING", "FAILED"]),
    SUBMITTING: new Set(["SENT_UNCONFIRMED", "DELIVERED", "DELIVERY_UNKNOWN"]),
    SENT_UNCONFIRMED: new Set(["DELIVERED", "DELIVERY_UNKNOWN"]),
    DELIVERED: new Set(["RESPONSE_STARTED", "RESPONSE_FAILED", "RESPONSE_SUPERSEDED"]),
    RESPONSE_STARTED: new Set(["RESPONSE_RECEIVED", "RESPONSE_FAILED", "RESPONSE_SUPERSEDED"]),
    RESPONSE_RECEIVED: new Set(["ACKED", "RESPONSE_SUPERSEDED"]),
    ACKED: new Set(), DELIVERY_UNKNOWN: new Set(), FAILED: new Set(), RESPONSE_FAILED: new Set(), RESPONSE_SUPERSEDED: new Set()
  });
  const FAULT_POINTS = Object.freeze([
    "after_delivery_persist", "after_composer_write", "after_submitting_commit", "after_send_invocation",
    "after_user_receipt", "after_response_detected", "after_result_persist", "service_worker_restart",
    "tab_reload_during_generation", "duplicate_observer_callback", "drop_observer_callback",
    "connection_interruption", "retry_error_state"
  ]);

  const DEFAULT_BUDGETS = Object.freeze({
    max_continuation_turns: 8,
    max_recoverable_failures: 3,
    max_elapsed_ms: 45 * 60 * 1000,
    max_protocol_repairs: 1
  });

  function canonicalText(value) { return String(value ?? "").replace(/\r\n?/g, "\n"); }
  function normalizeText(value) {
    return canonicalText(value).replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function fingerprint(value) {
    const text = normalizeText(value);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${text.length}`;
  }
  async function sha256Hex(value) {
    const text = String(value ?? "");
    if (globalThis.crypto?.subtle && typeof TextEncoder !== "undefined") {
      const bytes = new TextEncoder().encode(text);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    }
    if (typeof require === "function") return require("node:crypto").createHash("sha256").update(text).digest("hex");
    throw new Error("SHA-256 unavailable");
  }
  function canTransition(from, to) { return Boolean(TRANSITIONS[from]?.has(to)); }
  function isTerminalState(state) { return TERMINAL_STATES.has(String(state || "")); }
  function currentContext(input = {}) {
    return {
      protocol_version: PROTOCOL_VERSION,
      run_id: String(input.run_id || ""), task_id: String(input.task_id || ""),
      logical_agent_id: String(input.logical_agent_id || ""), slot_id: String(input.slot_id || ""),
      conversation_id: String(input.conversation_id || ""), delivery_id: String(input.delivery_id || ""),
      conversation_seq: Number(input.conversation_seq) || 0
    };
  }
  function assertContext(context) {
    if (!context.run_id || !context.task_id || !context.logical_agent_id || !context.slot_id || !context.conversation_id || !context.delivery_id || !context.conversation_seq) {
      throw new Error("Complete controller-owned delivery context is required");
    }
  }
  function terminalTemplate(context) {
    return { ...context, status: "DONE", escalation_reason: null };
  }
  function buildRouterPayload(input = {}) {
    const context = currentContext(input);
    assertContext(context);
    const ownershipToken = String(input.ownership_token || "").trim();
    const kind = String(input.kind || "ASSIGNMENT");
    const instruction = String(input.instruction || "").trim();
    if (!DELIVERY_KINDS.includes(kind) || !ownershipToken || !instruction) throw new Error("Delivery kind, ownership token, and instruction are required");
    return [
      "[MULTIAGENT ROUTER DELIVERY v1]",
      `kind: ${kind}`,
      "This is a controller-owned worker delivery. Treat identifiers as opaque and echo them exactly in the terminal block.",
      `delivery_id: ${context.delivery_id}`, `ownership_token: ${ownershipToken}`, `run_id: ${context.run_id}`,
      `task_id: ${context.task_id}`, `logical_agent_id: ${context.logical_agent_id}`, `slot_id: ${context.slot_id}`,
      `conversation_id: ${context.conversation_id}`, `conversation_seq: ${context.conversation_seq}`, `protocol_version: ${PROTOCOL_VERSION}`,
      "", "Task:", instruction, "",
      "End this turn with exactly one terminal worker block. status must be CONTINUE, DONE, or ESCALATE. escalation_reason must be null unless status is ESCALATE.",
      WORKER_START, JSON.stringify(terminalTemplate(context)), WORKER_END
    ].join("\n");
  }
  function continuationInstruction(taskId) {
    return [`Continue task ${String(taskId || "")} from your current state.`, "Do not restart.", "Do not merely summarize prior work.", "Return the normal terminal worker block when this turn ends."].join("\n");
  }
  function protocolRepairInstruction(originalDeliveryId) {
    return [
      `Repair only the terminal protocol for delivery ${String(originalDeliveryId || "")}.`,
      "Do not redo the substantive task.",
      "Return only one corrected terminal worker block for the current repair delivery, with no prose before or after it."
    ].join("\n");
  }

  function duplicateTopLevelJsonKey(jsonText) {
    const text = String(jsonText || ""); let i = 0; const seen = new Set();
    const ws = () => { while (/\s/.test(text[i] || "")) i += 1; };
    const str = () => { if (text[i] !== '"') return null; const s = i++; let esc = false; while (i < text.length) { const c = text[i++]; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') { try { return JSON.parse(text.slice(s, i)); } catch { return null; } } } return null; };
    const val = () => { let od = 0, ad = 0, ins = false, esc = false; while (i < text.length) { const c = text[i]; if (ins) { i++; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') ins = false; continue; } if (c === '"') { ins = true; i++; continue; } if (c === "{") { od++; i++; continue; } if (c === "[") { ad++; i++; continue; } if (c === "}") { if (od > 0) { od--; i++; continue; } if (!ad) return; } if (c === "]" && ad > 0) { ad--; i++; continue; } if (c === "," && !od && !ad) return; i++; } };
    ws(); if (text[i++] !== "{") return "";
    while (i < text.length) { ws(); if (text[i] === "}") return ""; const key = str(); if (key == null) return ""; if (seen.has(key)) return key; seen.add(key); ws(); if (text[i++] !== ":") return ""; ws(); val(); ws(); if (text[i] === ",") { i++; continue; } if (text[i] === "}") return ""; return ""; }
    return "";
  }
  const WORKER_KEYS = Object.freeze(["conversation_id", "conversation_seq", "delivery_id", "escalation_reason", "logical_agent_id", "protocol_version", "run_id", "slot_id", "status", "task_id"]);
  function parseWorkerTerminal(responseText, expectedInput = {}) {
    const text = String(responseText || "").trim();
    const starts = text.split(WORKER_START).length - 1, ends = text.split(WORKER_END).length - 1;
    if (starts !== 1 || ends !== 1) return { ok: false, code: "protocol.block_count" };
    const si = text.lastIndexOf(WORKER_START), ei = text.lastIndexOf(WORKER_END);
    if (si < 0 || ei < si || ei + WORKER_END.length !== text.length) return { ok: false, code: "protocol.not_terminal" };
    const jsonText = text.slice(si + WORKER_START.length, ei).trim();
    if (duplicateTopLevelJsonKey(jsonText)) return { ok: false, code: "protocol.duplicate_key" };
    let e; try { e = JSON.parse(jsonText); } catch { return { ok: false, code: "protocol.invalid_json" }; }
    if (!e || typeof e !== "object" || Array.isArray(e)) return { ok: false, code: "protocol.invalid_shape" };
    const keys = Object.keys(e).sort();
    if (keys.length !== WORKER_KEYS.length || keys.some((k, idx) => k !== WORKER_KEYS[idx])) return { ok: false, code: "protocol.schema_keys" };
    const expected = currentContext(expectedInput);
    for (const k of ["run_id", "task_id", "logical_agent_id", "slot_id", "conversation_id", "delivery_id", "status"]) if (typeof e[k] !== "string") return { ok: false, code: `protocol.type.${k}` };
    if (!(e.escalation_reason === null || typeof e.escalation_reason === "string")) return { ok: false, code: "protocol.type.escalation_reason" };
    if (!Number.isInteger(e.protocol_version) || !Number.isInteger(e.conversation_seq)) return { ok: false, code: "protocol.type.number" };
    if (!WORKER_STATUSES.includes(e.status)) return { ok: false, code: "protocol.status" };
    if (e.status === "ESCALATE") { if (!ESCALATION_REASONS.includes(e.escalation_reason)) return { ok: false, code: "protocol.escalation_reason" }; }
    else if (e.escalation_reason !== null) return { ok: false, code: "protocol.escalation_reason_unexpected" };
    if (e.protocol_version !== PROTOCOL_VERSION || e.conversation_seq !== expected.conversation_seq) return { ok: false, code: "protocol.context_number" };
    for (const k of ["run_id", "task_id", "logical_agent_id", "slot_id", "conversation_id", "delivery_id"]) if (e[k] !== expected[k]) return { ok: false, code: `protocol.${k}` };
    return { ok: true, envelope: e, block: text.slice(si) };
  }

  function normalizeBudgets(input = {}) {
    const out = { ...DEFAULT_BUDGETS };
    for (const key of Object.keys(out)) if (Number.isFinite(Number(input[key])) && Number(input[key]) >= 0) out[key] = Math.floor(Number(input[key]));
    return out;
  }
  function budgetDecision(record = {}, at = Date.now()) {
    const limits = normalizeBudgets(record);
    const startedAt = Math.max(0, Number(record.started_at) || Number(at));
    if ((Number(record.continuation_turns) || 0) >= limits.max_continuation_turns) return { ok: false, reason: "continuation_turns" };
    if ((Number(record.recoverable_failures) || 0) >= limits.max_recoverable_failures) return { ok: false, reason: "recoverable_failures" };
    if (Number(at) - startedAt >= limits.max_elapsed_ms) return { ok: false, reason: "elapsed_time" };
    return { ok: true };
  }
  function protocolRepairBudgetDecision(record = {}) {
    const limits = normalizeBudgets(record);
    return (Number(record.protocol_repairs) || 0) < limits.max_protocol_repairs;
  }

  function restartPlan(delivery, observation = {}) {
    const state = String(delivery?.state || "");
    if (!DELIVERY_STATES.includes(state)) return { action: "BLOCK", reason: "unknown_delivery_state" };
    if (isTerminalState(state)) return { action: "NOOP", reason: "terminal" };
    if (POST_SEND_AMBIGUITY_STATES.has(state)) {
      if (observation.exact_owned_receipt) return { action: "RECONCILE_DELIVERED" };
      if (state === "SUBMITTING" && !delivery?.send_consumed_at) return { action: "RESUME_SEND_CAPABILITY" };
      return { action: "DELIVERY_UNKNOWN", reason: "post_submit_ambiguous" };
    }
    if (state === "PENDING" || state === "CLAIMED") {
      if (observation.foreign_composer_text) return { action: "PAUSE_MANUAL", reason: "foreign_composer" };
      return { action: "RESUME_PRE_SEND" };
    }
    if (state === "COMPOSER_FILLING") {
      if (observation.composer_exact_payload) return { action: "MARK_COMPOSER_FILLED" };
      if (observation.composer_empty) return { action: "RESUME_PRE_SEND" };
      return { action: "PAUSE_MANUAL", reason: "composer_not_owned" };
    }
    if (state === "COMPOSER_FILLED") {
      if (observation.composer_exact_payload) return { action: "RESUME_SEND_AUTHORIZATION" };
      return { action: "PAUSE_MANUAL", reason: "filled_payload_missing" };
    }
    if (state === "DELIVERED" || state === "RESPONSE_STARTED") return { action: "REATTACH_RESPONSE" };
    if (state === "RESPONSE_RECEIVED") return { action: "CAPTURE_RESULT_ONLY" };
    return { action: "BLOCK", reason: "unhandled_state" };
  }

  return Object.freeze({
    PROTOCOL_VERSION, WORKER_START, WORKER_END, DELIVERY_KINDS, WORKER_STATUSES, ESCALATION_REASONS,
    DELIVERY_STATES, TERMINAL_STATES, PRE_SEND_STATES, POST_SEND_AMBIGUITY_STATES, RESPONSE_STATES, TRANSITIONS,
    FAULT_POINTS, DEFAULT_BUDGETS, canonicalText, normalizeText, fingerprint, sha256Hex, canTransition, isTerminalState,
    currentContext, buildRouterPayload, continuationInstruction, protocolRepairInstruction, parseWorkerTerminal,
    normalizeBudgets, budgetDecision, protocolRepairBudgetDecision, restartPlan
  });
});
