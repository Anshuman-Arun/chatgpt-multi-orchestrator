((root, factory) => {
  const Wave1 = typeof module === "object" && module.exports ? (() => { try { return require("./wave1-core.js"); } catch { return null; } })() : root.MultiAgentWave1Core;
  const api = factory(Wave1);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MultiAgentWave2Core = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (Wave1) => {
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
  const TERMINAL_DELIVERY_STATES = Object.freeze(new Set([
    "ACKED", "DELIVERY_UNKNOWN", "FAILED", "RESPONSE_FAILED", "RESPONSE_SUPERSEDED"
  ]));
  const PRE_SEND_STATES = Object.freeze(new Set(["PENDING", "CLAIMED", "COMPOSER_FILLING", "COMPOSER_FILLED"]));
  const POST_BOUNDARY_STATES = Object.freeze(new Set([
    "SUBMITTING", "SENT_UNCONFIRMED", "DELIVERED", "RESPONSE_STARTED", "RESPONSE_RECEIVED"
  ]));
  const TRANSITIONS = Object.freeze({
    PENDING: new Set(["CLAIMED", "FAILED"]),
    CLAIMED: new Set(["COMPOSER_FILLING", "FAILED"]),
    COMPOSER_FILLING: new Set(["COMPOSER_FILLED", "FAILED"]),
    COMPOSER_FILLED: new Set(["SUBMITTING", "FAILED"]),
    SUBMITTING: new Set(["SENT_UNCONFIRMED", "DELIVERED", "DELIVERY_UNKNOWN"]),
    SENT_UNCONFIRMED: new Set(["DELIVERED", "DELIVERY_UNKNOWN"]),
    DELIVERED: new Set(["RESPONSE_STARTED", "RESPONSE_FAILED", "RESPONSE_SUPERSEDED"]),
    RESPONSE_STARTED: new Set(["RESPONSE_RECEIVED", "RESPONSE_FAILED", "RESPONSE_SUPERSEDED"]),
    RESPONSE_RECEIVED: new Set(["ACKED", "FAILED"]),
    ACKED: new Set(), DELIVERY_UNKNOWN: new Set(), FAILED: new Set(), RESPONSE_FAILED: new Set(), RESPONSE_SUPERSEDED: new Set()
  });

  function canonicalText(value) { return String(value ?? "").replace(/\r\n?/g, "\n"); }
  function normalizeText(value) {
    return canonicalText(value).replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function fingerprint(value) {
    if (Wave1?.fingerprint) return Wave1.fingerprint(value);
    const text = normalizeText(value); let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${text.length}`;
  }
  async function sha256Hex(value) {
    if (Wave1?.sha256Hex) return Wave1.sha256Hex(value);
    const text = String(value ?? "");
    if (globalThis.crypto?.subtle && typeof TextEncoder !== "undefined") {
      const bytes = new TextEncoder().encode(text); const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    }
    if (typeof require === "function") return require("node:crypto").createHash("sha256").update(text).digest("hex");
    throw new Error("SHA-256 is unavailable");
  }
  function canTransition(from, to) { return Boolean(TRANSITIONS[from]?.has(to)); }
  function currentContext(input = {}) {
    return {
      protocol_version: PROTOCOL_VERSION,
      run_id: String(input.run_id || ""), task_id: String(input.task_id || ""), logical_agent_id: String(input.logical_agent_id || ""),
      slot_id: String(input.slot_id || ""), conversation_id: String(input.conversation_id || ""), delivery_id: String(input.delivery_id || ""),
      conversation_seq: Number(input.conversation_seq) || 0
    };
  }
  function requireContext(input) {
    const c = currentContext(input);
    if (Object.entries(c).some(([k,v]) => k === "protocol_version" ? v !== PROTOCOL_VERSION : (v === "" || v === 0))) {
      throw new Error("Wave-2 Delivery requires complete controller context");
    }
    return c;
  }
  function terminalExample(context, status = "DONE", reason = "") {
    const body = { ...context, status };
    if (status === "ESCALATE") body.reason = reason || "NEEDS_ORCHESTRATOR_DECISION";
    return body;
  }
  function buildRouterPayload(input = {}) {
    const context = requireContext(input);
    const kind = String(input.kind || "ASSIGNMENT");
    if (!DELIVERY_KINDS.includes(kind)) throw new Error(`Unsupported Wave-2 Delivery kind ${kind}`);
    const ownershipToken = String(input.ownership_token || "").trim();
    const instruction = String(input.instruction || "").trim();
    if (!ownershipToken || !instruction) throw new Error("Wave-2 Delivery requires ownership token and instruction");
    return [
      "[MULTIAGENT ROUTER DELIVERY v1]",
      `kind: ${kind}`,
      "This is a controller-owned worker delivery. Treat all identifiers as opaque and echo them exactly in the terminal block.",
      `delivery_id: ${context.delivery_id}`, `ownership_token: ${ownershipToken}`, `run_id: ${context.run_id}`, `task_id: ${context.task_id}`,
      `logical_agent_id: ${context.logical_agent_id}`, `slot_id: ${context.slot_id}`, `conversation_id: ${context.conversation_id}`,
      `conversation_seq: ${context.conversation_seq}`, `protocol_version: ${PROTOCOL_VERSION}`,
      input.causal_parent_delivery_id ? `causal_parent_delivery_id: ${String(input.causal_parent_delivery_id)}` : "",
      "", "Task:", instruction, "",
      "End this turn with exactly one terminal worker block and nothing after it. status must be CONTINUE, DONE, or ESCALATE. ESCALATE must also include one allowed reason.",
      WORKER_START, JSON.stringify(terminalExample(context, "DONE")), WORKER_END
    ].filter((line, i, arr) => !(line === "" && arr[i - 1] === "")).join("\n");
  }
  function continuationInstruction(taskId) {
    return `Continue task ${String(taskId || "")} from your current state. Do not restart. Do not merely summarize prior work. Return the normal terminal worker block when this turn ends.`;
  }
  function protocolRepairInstruction() {
    return [
      "Return only the corrected terminal worker protocol block for the completed prior turn.",
      "Do not repeat, restart, extend, or reinterpret the substantive task.",
      "Use exactly the controller identifiers in this repair delivery header; do not reuse identifiers from the prior turn.",
      "status must truthfully report the prior completed turn as CONTINUE, DONE, or ESCALATE. If ESCALATE, include exactly one allowed reason."
    ].join("\n");
  }

  function duplicateTopLevelJsonKey(jsonText) {
    const text = String(jsonText || ""); let i = 0; const seen = new Set();
    const ws = () => { while (/\s/.test(text[i] || "")) i += 1; };
    const str = () => { if (text[i] !== '"') return null; const s=i++; let esc=false; while(i<text.length){const ch=text[i++]; if(esc){esc=false;continue;} if(ch==='\\'){esc=true;continue;} if(ch==='"'){try{return JSON.parse(text.slice(s,i));}catch{return null;}}} return null; };
    const value = () => { let o=0,a=0,q=false,e=false; while(i<text.length){const ch=text[i]; if(q){i++; if(e)e=false; else if(ch==='\\')e=true; else if(ch==='"')q=false; continue;} if(ch==='"'){q=true;i++;continue;} if(ch==='{'){o++;i++;continue;} if(ch==='['){a++;i++;continue;} if(ch==='}'){if(o){o--;i++;continue;} if(!a)return;} if(ch===']'&&a){a--;i++;continue;} if(ch===','&&!o&&!a)return; i++;} };
    ws(); if(text[i++]!=='{') return "";
    while(i<text.length){ws(); if(text[i]==='}') return ""; const k=str(); if(k==null)return ""; if(seen.has(k))return k; seen.add(k); ws(); if(text[i++]!==':')return ""; ws(); value(); ws(); if(text[i]===','){i++;continue;} if(text[i]==='}')return ""; return "";} return "";
  }
  function parseWorkerTerminal(responseText, expectedInput = {}) {
    const text = String(responseText || "").trim();
    const starts = text.split(WORKER_START).length - 1, ends = text.split(WORKER_END).length - 1;
    if (starts !== 1 || ends !== 1) return { ok:false, code:"protocol.block_count" };
    const s=text.lastIndexOf(WORKER_START), e=text.lastIndexOf(WORKER_END);
    if(s<0||e<s||e+WORKER_END.length!==text.length) return {ok:false,code:"protocol.not_terminal"};
    const jsonText=text.slice(s+WORKER_START.length,e).trim();
    if(duplicateTopLevelJsonKey(jsonText)) return {ok:false,code:"protocol.duplicate_key"};
    let env; try{env=JSON.parse(jsonText);}catch{return {ok:false,code:"protocol.invalid_json"};}
    if(!env||typeof env!=="object"||Array.isArray(env)) return {ok:false,code:"protocol.invalid_shape"};
    const status=env.status;
    if(typeof status!=="string"||!WORKER_STATUSES.includes(status)) return {ok:false,code:"protocol.status"};
    const base=["conversation_id","conversation_seq","delivery_id","logical_agent_id","protocol_version","run_id","slot_id","status","task_id"];
    const expectedKeys=(status==="ESCALATE"?[...base,"reason"]:base).sort();
    const keys=Object.keys(env).sort();
    if(keys.length!==expectedKeys.length||keys.some((k,j)=>k!==expectedKeys[j])) return {ok:false,code:"protocol.schema_keys"};
    for(const k of ["run_id","task_id","logical_agent_id","slot_id","conversation_id","delivery_id","status"]) if(typeof env[k]!=="string") return {ok:false,code:`protocol.type.${k}`};
    if(!Number.isInteger(env.protocol_version)) return {ok:false,code:"protocol.type.protocol_version"};
    if(!Number.isInteger(env.conversation_seq)) return {ok:false,code:"protocol.type.conversation_seq"};
    if(status==="ESCALATE" && (typeof env.reason!=="string" || !ESCALATION_REASONS.includes(env.reason))) return {ok:false,code:"protocol.escalation_reason"};
    const expected=requireContext(expectedInput);
    if(env.protocol_version!==expected.protocol_version) return {ok:false,code:"protocol.version"};
    if(env.conversation_seq!==expected.conversation_seq) return {ok:false,code:"protocol.conversation_seq"};
    for(const k of ["run_id","task_id","logical_agent_id","slot_id","conversation_id","delivery_id"]) if(env[k]!==expected[k]) return {ok:false,code:`protocol.${k}`};
    return {ok:true,envelope:env,block:text.slice(s)};
  }

  function normalizeUiState(snapshot = {}, transport = {}) {
    if (transport.content_detached) return "CONTENT_SCRIPT_DETACHED";
    if (transport.tab_unavailable) return "TAB_UNAVAILABLE";
    const code=String(snapshot.error_code||"").toLowerCase();
    if(code.includes("auth")) return "AUTHENTICATION_REQUIRED";
    if(code.includes("rate")) return "RATE_LIMITED";
    if(code.includes("connection")||code.includes("offline")||code.includes("waiting")) return "CONNECTION_WAITING";
    if(code.includes("retry")||code.includes("generation")||code.includes("model")) return "RETRYABLE_MODEL_ERROR";
    if(snapshot.generating) return snapshot.thinking ? "LONG_THINKING" : "GENERATION_ACTIVE";
    if(!snapshot.composer_present || (!snapshot.idle_send_path && !snapshot.generating)) return "UNRECOGNIZED_UI";
    return "IDLE";
  }

  function classifyReconciliation(delivery = {}, observation = {}) {
    const state=String(delivery.state||"");
    if(TERMINAL_DELIVERY_STATES.has(state)) return {action:"NOOP_TERMINAL"};
    const exactReceipt=Boolean(observation.exact_owned_user_turn);
    const exactComposer=Boolean(observation.exact_composer_payload);
    const composerEmpty=Boolean(observation.composer_empty);
    const foreign=Boolean(observation.foreign_user_turn);
    const response=Boolean(observation.causal_response_complete);
    if(foreign) return {action:"PAUSE_MANUAL"};
    if(PRE_SEND_STATES.has(state)) {
      if(state==="PENDING"||state==="CLAIMED") return composerEmpty?{action:"RESUME_PRE_SEND"}:{action:"PAUSE_COMPOSER"};
      if(state==="COMPOSER_FILLING"||state==="COMPOSER_FILLED") return exactComposer?{action:"RESUME_PRE_SEND"}:(composerEmpty?{action:"RESUME_PRE_SEND"}:{action:"PAUSE_COMPOSER"});
    }
    if(state==="SUBMITTING"||state==="SENT_UNCONFIRMED") {
      if(exactReceipt) return {action:"RECONCILE_DELIVERED"};
      if(observation.positive_non_delivery && !delivery.send_consumed_at) return {action:"RECOVER_PRE_SEND"};
      return {action:"DELIVERY_UNKNOWN"};
    }
    if(state==="DELIVERED"||state==="RESPONSE_STARTED") return response?{action:"CAPTURE_RESPONSE"}:{action:"REATTACH_RESPONSE"};
    if(state==="RESPONSE_RECEIVED") return {action:"PROCESS_DURABLE_RESULT"};
    return {action:"FAIL_CLOSED"};
  }

  function budgetDecision(task = {}, now = Date.now(), options = {}) {
    const maxContinuations=Math.max(0,Number(task.max_continuations ?? 3));
    const maxFailures=Math.max(0,Number(task.max_recoverable_failures ?? 2));
    const maxElapsed=Math.max(0,Number(task.max_elapsed_ms ?? 30*60*1000));
    const continuations=Math.max(0,Number(task.continuation_count)||0), failures=Math.max(0,Number(task.recoverable_failure_count)||0);
    const started=Math.max(0,Number(task.started_at||task.created_at)||0);
    if(options.forContinuation !== false && continuations>=maxContinuations) return {ok:false,reason:"BUDGET_EXHAUSTED",dimension:"continuations"};
    if(failures>=maxFailures) return {ok:false,reason:"BUDGET_EXHAUSTED",dimension:"recoverable_failures"};
    if(started && maxElapsed && Number(now)-started>=maxElapsed) return {ok:false,reason:"BUDGET_EXHAUSTED",dimension:"elapsed"};
    return {ok:true};
  }

  return Object.freeze({
    PROTOCOL_VERSION, WORKER_START, WORKER_END, DELIVERY_KINDS, WORKER_STATUSES, ESCALATION_REASONS,
    DELIVERY_STATES, TERMINAL_DELIVERY_STATES, PRE_SEND_STATES, POST_BOUNDARY_STATES, TRANSITIONS,
    canonicalText, normalizeText, fingerprint, sha256Hex, canTransition, currentContext, buildRouterPayload,
    continuationInstruction, protocolRepairInstruction, parseWorkerTerminal, normalizeUiState, classifyReconciliation, budgetDecision,
    findOwnedUserReceipt: Wave1?.findOwnedUserReceipt, selectAssistantCandidate: Wave1?.selectAssistantCandidate,
    turnCompletionEvidence: Wave1?.turnCompletionEvidence, resolveTurnAnchor: Wave1?.resolveTurnAnchor, turnsAfterAnchor: Wave1?.turnsAfterAnchor
  });
});
