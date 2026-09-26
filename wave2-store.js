((root, factory) => {
  const Core = typeof module === "object" && module.exports ? require("./wave2-core.js") : root.MultiAgentWave2Core;
  const api = factory(Core);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MultiAgentWave2Store = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (Core) => {
  "use strict";
  if (!Core) throw new Error("MultiAgentWave2Core is required");

  const DB_NAME = "chatgpt_multi_orchestrator_wave1";
  const DB_VERSION = 2;
  const LEASE_MS = 2 * 60 * 1000;
  const NEW_STORES = Object.freeze(["task_budgets", "upstream_events", "faults", "startup_barriers", "protocol_repairs"]);
  const STORE_NAMES = Object.freeze([
    "meta", "runs", "tasks", "conversation_bindings", "deliveries", "leases", "worker_results", "events", ...NEW_STORES
  ]);
  const NONTERMINAL = new Set(Core.DELIVERY_STATES.filter((s) => !Core.isTerminalState(s)));
  let dbPromise = null;

  const now = () => Date.now();
  function makeId(prefix) {
    if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  }
  function req(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || new Error("IndexedDB request failed")); }); }
  function txDone(tx) { return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted")); tx.onerror = () => {}; }); }
  const os = (tx, name) => tx.objectStore(name);
  function ensureStore(db, name, options) { return db.objectStoreNames.contains(name) ? null : db.createObjectStore(name, options); }

  function openDb() {
    if (dbPromise) return dbPromise;
    if (!globalThis.indexedDB) return Promise.reject(new Error("IndexedDB unavailable"));
    dbPromise = new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        ensureStore(db, "meta", { keyPath: "key" });
        ensureStore(db, "runs", { keyPath: "run_id" });
        ensureStore(db, "tasks", { keyPath: "task_id" });
        const bindings = ensureStore(db, "conversation_bindings", { keyPath: "conversation_id" });
        if (bindings) bindings.createIndex("provider_locator", "provider_locator", { unique: true });
        const deliveries = ensureStore(db, "deliveries", { keyPath: "delivery_id" });
        if (deliveries) { deliveries.createIndex("conversation_id", "conversation_id", { unique: false }); deliveries.createIndex("created_at", "created_at", { unique: false }); }
        ensureStore(db, "leases", { keyPath: "conversation_id" });
        ensureStore(db, "worker_results", { keyPath: "delivery_id" });
        const events = ensureStore(db, "events", { keyPath: "seq" });
        if (events) { events.createIndex("delivery_id", "delivery_id", { unique: false }); events.createIndex("conversation_id", "conversation_id", { unique: false }); }
        ensureStore(db, "task_budgets", { keyPath: "task_id" });
        const upstream = ensureStore(db, "upstream_events", { keyPath: "event_id" });
        if (upstream) { upstream.createIndex("task_id", "task_id", { unique: false }); upstream.createIndex("delivery_id", "delivery_id", { unique: false }); }
        ensureStore(db, "faults", { keyPath: "point" });
        ensureStore(db, "startup_barriers", { keyPath: "conversation_id" });
        ensureStore(db, "protocol_repairs", { keyPath: "original_delivery_id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { dbPromise = null; reject(request.error || new Error("Could not open Wave-2 IndexedDB")); };
      request.onblocked = () => reject(new Error("Wave-2 IndexedDB upgrade blocked"));
    });
    return dbPromise;
  }
  async function withTx(names, mode, fn) {
    const db = await openDb(); const tx = db.transaction([...new Set(names)], mode); const done = txDone(tx);
    try { const out = await fn(tx); await done; return out; }
    catch (e) { try { tx.abort(); } catch {} await done.catch(() => {}); throw e; }
  }
  function compactEvidence(value) {
    if (!value || typeof value !== "object") return {};
    const out = {}; for (const [k, v] of Object.entries(value)) { if (v == null) continue; out[k] = (typeof v === "number" || typeof v === "boolean") ? v : String(v).slice(0, 240); }
    return out;
  }
  async function appendEvent(tx, input = {}) {
    const meta = os(tx, "meta"), events = os(tx, "events");
    const cur = await req(meta.get("journal_seq")); const seq = Math.max(0, Number(cur?.value) || 0) + 1; meta.put({ key: "journal_seq", value: seq });
    const d = input.delivery || {};
    const event = {
      seq, timestamp: Number(input.timestamp) || now(), event_type: String(input.event_type || "STATE_TRANSITION"),
      run_id: String(d.run_id || input.run_id || ""), task_id: String(d.task_id || input.task_id || ""),
      delivery_id: String(d.delivery_id || input.delivery_id || ""), conversation_id: String(d.conversation_id || input.conversation_id || ""),
      logical_agent_id: String(d.logical_agent_id || input.logical_agent_id || ""), slot_id: String(d.slot_id || input.slot_id || ""),
      previous_state: input.previous_state == null ? null : String(input.previous_state), next_state: input.next_state == null ? null : String(input.next_state),
      reason: String(input.reason || "").slice(0, 240), lease_fence: Math.max(0, Number(input.lease_fence ?? d.lease_fence) || 0),
      actor_id: String(input.actor_id || d.actor_id || "").slice(0, 220), boot_id: String(input.boot_id || "").slice(0, 220), evidence: compactEvidence(input.evidence)
    };
    events.add(event); return event;
  }
  async function getDeliveryTx(tx, id) { const d = await req(os(tx, "deliveries").get(String(id || ""))); if (!d) throw new Error("Delivery not found"); return d; }
  function transition(d, next, at = now()) { if (d.state === next) return d; if (!Core.canTransition(d.state, next)) throw new Error(`Invalid Delivery transition ${d.state} -> ${next}`); return { ...d, state: next, updated_at: at }; }
  async function assertFence(tx, d, actor, fence, { requireFresh = true, at = now() } = {}) {
    const lease = await req(os(tx, "leases").get(d.conversation_id));
    if (!lease || lease.owner_actor_id !== String(actor || "") || Number(lease.fence) !== Number(fence) || Number(d.lease_fence) !== Number(fence)) {
      const e = new Error("sender lease fence is stale"); e.code = "wave2.lease_stale"; throw e;
    }
    if (requireFresh && Number(lease.expires_at) <= at) { const e = new Error("sender lease expired"); e.code = "wave2.lease_expired"; throw e; }
    return lease;
  }
  async function payloadFor(base, kind, instruction) {
    const ownership_token = makeId("ownership");
    const payload = Core.buildRouterPayload({ ...base, kind, instruction, ownership_token });
    return { ownership_token, payload, payload_hash: await Core.sha256Hex(Core.normalizeText(payload)), payload_exact_hash: await Core.sha256Hex(Core.canonicalText(payload)) };
  }

  async function bindConversation({ provider_locator, actor_id = "", boot_id = "" }) {
    const locator = String(provider_locator || ""); if (!locator) throw new Error("provider locator required");
    return withTx(["conversation_bindings", "startup_barriers", "meta", "events"], "readwrite", async (tx) => {
      const bindings = os(tx, "conversation_bindings"); const existing = await req(bindings.index("provider_locator").get(locator));
      if (existing) return { binding: existing, created: false };
      const at = now(); const binding = { conversation_id: makeId("conversation"), provider: "chatgpt", provider_locator: locator, next_conversation_seq: 1, created_at: at, updated_at: at };
      bindings.put(binding); os(tx, "startup_barriers").put({ conversation_id: binding.conversation_id, reconciled: false, actor_id: "", updated_at: at });
      await appendEvent(tx, { event_type: "CONVERSATION_BOUND", conversation_id: binding.conversation_id, reason: "MANUAL_WAVE2_BIND", actor_id, boot_id, evidence: { provider_locator_fingerprint: Core.fingerprint(locator) } });
      return { binding, created: true };
    });
  }
  async function getBindingByLocator(locator) { return withTx(["conversation_bindings"], "readonly", tx => req(os(tx, "conversation_bindings").index("provider_locator").get(String(locator || "")))); }
  async function listDeliveriesForConversation(conversationId) {
    return withTx(["deliveries"], "readonly", async tx => (await req(os(tx, "deliveries").index("conversation_id").getAll(String(conversationId || "")))).sort((a,b)=>Number(a.conversation_seq)-Number(b.conversation_seq)));
  }
  async function listNonterminalDeliveries() {
    return withTx(["deliveries"], "readonly", async tx => (await req(os(tx, "deliveries").getAll())).filter(d => NONTERMINAL.has(d.state)));
  }
  async function latestForLocator(locator) {
    const binding = await getBindingByLocator(locator); if (!binding) return { binding:null, delivery:null, result:null, budget:null, barrier:null };
    return withTx(["deliveries","worker_results","task_budgets","startup_barriers"], "readonly", async tx => {
      const ds = await req(os(tx,"deliveries").index("conversation_id").getAll(binding.conversation_id));
      ds.sort((a,b)=>Number(b.conversation_seq)-Number(a.conversation_seq)||Number(b.created_at)-Number(a.created_at));
      const d=ds[0]||null; return { binding, delivery:d, result:d?await req(os(tx,"worker_results").get(d.delivery_id)):null, budget:d?await req(os(tx,"task_budgets").get(d.task_id)):null, barrier:await req(os(tx,"startup_barriers").get(binding.conversation_id)) };
    });
  }

  async function createAssignment({ conversation_id, instruction, budgets = {}, boot_id = "" }) {
    const cid=String(conversation_id||""); const binding=await withTx(["conversation_bindings"],"readonly",tx=>req(os(tx,"conversation_bindings").get(cid))); if(!binding) throw new Error("binding not found");
    const ids={ run_id:makeId("run"), task_id:makeId("task"), logical_agent_id:makeId("agent"), slot_id:makeId("slot"), conversation_id:cid, delivery_id:makeId("delivery"), conversation_seq:Number(binding.next_conversation_seq)||1, protocol_version:1 };
    const p=await payloadFor(ids,"ASSIGNMENT",String(instruction||"").trim()); const limits=Core.normalizeBudgets(budgets);
    return withTx(["runs","tasks","conversation_bindings","deliveries","task_budgets","startup_barriers","meta","events"],"readwrite",async tx=>{
      const barrier=await req(os(tx,"startup_barriers").get(cid)); if(!barrier?.reconciled) { const e=new Error("startup reconciliation required before new side effects"); e.code="wave2.startup_barrier"; throw e; }
      const existing=await req(os(tx,"deliveries").index("conversation_id").getAll(cid)); if(existing.some(d=>NONTERMINAL.has(d.state))) { const e=new Error("conversation already has an in-flight Delivery"); e.code="wave2.delivery_inflight"; throw e; }
      const b=await req(os(tx,"conversation_bindings").get(cid)); if(Number(b.next_conversation_seq)!==ids.conversation_seq) throw new Error("conversation sequence changed");
      const at=now(); const task={task_id:ids.task_id,run_id:ids.run_id,logical_agent_id:ids.logical_agent_id,slot_id:ids.slot_id,conversation_id:cid,status:"RUNNING",started_at:at,created_at:at,updated_at:at};
      const d={...ids,...p,provider_locator:b.provider_locator,kind:"ASSIGNMENT",causal_parent_delivery_id:"",retry_of_delivery_id:"",state:"PENDING",actor_id:"",lease_fence:0,baseline:null,send_authorization_id:"",send_consumed_at:0,user_receipt:null,assistant_candidate:null,response_text:"",response_text_hash:"",terminal_error:"",created_at:at,updated_at:at};
      os(tx,"runs").put({run_id:ids.run_id,status:"RUNNING",created_at:at,updated_at:at}); os(tx,"tasks").put(task); os(tx,"deliveries").put(d);
      os(tx,"task_budgets").put({task_id:ids.task_id,...limits,continuation_turns:0,recoverable_failures:0,protocol_repairs:0,started_at:at,updated_at:at});
      b.next_conversation_seq=ids.conversation_seq+1;b.updated_at=at;os(tx,"conversation_bindings").put(b);
      await appendEvent(tx,{delivery:d,previous_state:null,next_state:"PENDING",reason:"DELIVERY_CREATED",boot_id,evidence:{kind:"ASSIGNMENT",payload_hash:d.payload_hash}}); return d;
    });
  }

  async function createChildDelivery({ parent_delivery_id, kind, instruction, boot_id = "", retry_of_delivery_id = "" }) {
    const parent=await withTx(["deliveries"],"readonly",tx=>getDeliveryTx(tx,parent_delivery_id));
    const binding=await withTx(["conversation_bindings"],"readonly",tx=>req(os(tx,"conversation_bindings").get(parent.conversation_id)));
    const id=makeId("delivery"); const base={run_id:parent.run_id,task_id:parent.task_id,logical_agent_id:parent.logical_agent_id,slot_id:parent.slot_id,conversation_id:parent.conversation_id,delivery_id:id,conversation_seq:Number(binding?.next_conversation_seq)||1,protocol_version:1};
    const p=await payloadFor(base,kind,instruction);
    return withTx(["conversation_bindings","deliveries","worker_results","task_budgets","meta","events"],"readwrite",async tx=>{
      const existing=await req(os(tx,"deliveries").index("conversation_id").getAll(parent.conversation_id));
      const sameChild=existing.find(d=>String(d.causal_parent_delivery_id||"")===parent.delivery_id&&d.kind===kind&&String(d.retry_of_delivery_id||"")===String(retry_of_delivery_id||""));
      if(sameChild)return sameChild;
      const blocking=existing.find(d=>NONTERMINAL.has(d.state)&&!(kind==="PROTOCOL_REPAIR"&&d.delivery_id===parent.delivery_id&&d.state==="RESPONSE_RECEIVED"));
      if(blocking) { const e=new Error("cannot create child while another Delivery is in flight"); e.code="wave2.delivery_inflight"; throw e; }
      const b=await req(os(tx,"conversation_bindings").get(parent.conversation_id)); if(Number(b.next_conversation_seq)!==base.conversation_seq)throw new Error("conversation sequence changed while creating child");
      const at=now(); const d={...base,...p,provider_locator:parent.provider_locator,kind,causal_parent_delivery_id:parent.delivery_id,retry_of_delivery_id:String(retry_of_delivery_id||""),state:"PENDING",actor_id:"",lease_fence:0,baseline:null,send_authorization_id:"",send_consumed_at:0,user_receipt:null,assistant_candidate:null,response_text:"",response_text_hash:"",terminal_error:"",created_at:at,updated_at:at};
      os(tx,"deliveries").put(d); b.next_conversation_seq=base.conversation_seq+1;b.updated_at=at;os(tx,"conversation_bindings").put(b);
      if(kind==="CONTINUATION") { const budget=await req(os(tx,"task_budgets").get(parent.task_id)); if(budget){budget.continuation_turns=(Number(budget.continuation_turns)||0)+1;budget.updated_at=at;os(tx,"task_budgets").put(budget);} }
      if(kind==="PROTOCOL_REPAIR") { const budget=await req(os(tx,"task_budgets").get(parent.task_id)); if(budget){budget.protocol_repairs=(Number(budget.protocol_repairs)||0)+1;budget.updated_at=at;os(tx,"task_budgets").put(budget);} }
      await appendEvent(tx,{delivery:d,previous_state:null,next_state:"PENDING",reason:"CHILD_DELIVERY_CREATED",boot_id,evidence:{kind,parent_delivery_id:parent.delivery_id,retry_of_delivery_id}}); return d;
    });
  }

  async function acquireLease({ delivery_id, actor_id, boot_id = "", force_reclaim = false, lease_ms = LEASE_MS }) {
    const actor=String(actor_id||""); if(!actor) throw new Error("actor required");
    return withTx(["deliveries","leases","meta","events"],"readwrite",async tx=>{
      const at=now(); let d=await getDeliveryTx(tx,delivery_id); if(Core.isTerminalState(d.state)) return {delivery:d,lease:null,terminal:true};
      const leases=os(tx,"leases"), old=await req(leases.get(d.conversation_id));
      if(old && old.owner_actor_id!==actor && Number(old.expires_at)>at && !force_reclaim){const e=new Error("sender lease busy");e.code="wave2.lease_busy";throw e;}
      const transfer=!old||old.owner_actor_id!==actor||Number(old.expires_at)<=at||force_reclaim; const fence=transfer?Math.max(0,Number(old?.fence)||0)+1:Number(old.fence);
      const lease={conversation_id:d.conversation_id,owner_actor_id:actor,fence,expires_at:at+Math.max(30000,Number(lease_ms)||LEASE_MS),updated_at:at};leases.put(lease);
      const previous=d.state; if(d.state==="PENDING") d=transition(d,"CLAIMED",at); d={...d,actor_id:actor,lease_fence:fence,updated_at:at};os(tx,"deliveries").put(d);
      await appendEvent(tx,{delivery:d,previous_state:previous,next_state:d.state,event_type:transfer?"LEASE_ACQUIRED":"LEASE_RENEWED",reason:force_reclaim?"ACTOR_RESTART_RECLAIM":"SENDER_LEASE_ACQUIRED",actor_id:actor,boot_id,lease_fence:fence,evidence:{lease_expires_at:lease.expires_at}}); return {delivery:d,lease};
    });
  }
  async function renewLease({delivery_id,actor_id,fence,boot_id=""}){
    return withTx(["deliveries","leases","meta","events"],"readwrite",async tx=>{const at=now();const d=await getDeliveryTx(tx,delivery_id);const lease=await assertFence(tx,d,actor_id,fence,{requireFresh:false,at});if(Number(lease.expires_at)<=at){return {delivery:d,lease,reconciliation_only:!Core.PRE_SEND_STATES.has(d.state)}};lease.expires_at=at+LEASE_MS;lease.updated_at=at;os(tx,"leases").put(lease);await appendEvent(tx,{delivery:d,previous_state:d.state,next_state:d.state,event_type:"LEASE_RENEWED",reason:"ACTIVE_RECONCILIATION",actor_id,boot_id,lease_fence:fence});return {delivery:d,lease,reconciliation_only:false};});
  }
  async function transitionWithFence({delivery_id,actor_id,fence,expected_state,next_state,reason,boot_id="",evidence={},mutate=null,require_fresh=true}){
    return withTx(["deliveries","leases","meta","events"],"readwrite",async tx=>{const at=now();let d=await getDeliveryTx(tx,delivery_id);if(d.state!==expected_state)throw new Error(`Delivery is ${d.state}, expected ${expected_state}`);await assertFence(tx,d,actor_id,fence,{requireFresh:require_fresh,at});const prev=d.state;d=transition(d,next_state,at);if(mutate)d=mutate(d,at)||d;os(tx,"deliveries").put(d);await appendEvent(tx,{delivery:d,previous_state:prev,next_state,reason,actor_id,boot_id,lease_fence:fence,evidence});return d;});
  }
  function beginComposerFilling(args){return transitionWithFence({...args,expected_state:"CLAIMED",next_state:"COMPOSER_FILLING",reason:"BASELINE_CAPTURED",mutate:d=>({...d,baseline:args.baseline})});}
  function markComposerFilled(args){return transitionWithFence({...args,expected_state:"COMPOSER_FILLING",next_state:"COMPOSER_FILLED",reason:"COMPOSER_EXACT_READBACK_VERIFIED"});}
  async function failPreSend({delivery_id,actor_id,fence,reason="PRE_SEND_FAILURE",boot_id="",evidence={},manual_pause=false}){
    return withTx(["deliveries","leases","tasks","meta","events"],"readwrite",async tx=>{const at=now();let d=await getDeliveryTx(tx,delivery_id);if(!Core.PRE_SEND_STATES.has(d.state))throw new Error(`cannot fail pre-send from ${d.state}`);if(d.state!=="PENDING")await assertFence(tx,d,actor_id,fence,{requireFresh:false,at});const prev=d.state;d=transition(d,"FAILED",at);d.failure_reason=String(reason);os(tx,"deliveries").put(d);const task=await req(os(tx,"tasks").get(d.task_id));if(task)os(tx,"tasks").put({...task,status:manual_pause?"PAUSED_MANUAL":"FAILED",updated_at:at});await appendEvent(tx,{delivery:d,previous_state:prev,next_state:"FAILED",reason,actor_id,boot_id,lease_fence:fence,evidence:{...evidence,manual_pause}});return d;});
  }
  async function authorizeSend({delivery_id,actor_id,fence,boot_id=""}){const auth=makeId("sendauth");const d=await transitionWithFence({delivery_id,actor_id,fence,expected_state:"COMPOSER_FILLED",next_state:"SUBMITTING",reason:"DURABLE_SEND_AUTHORIZATION",boot_id,mutate:(x,at)=>({...x,send_authorization_id:auth,send_authorized_at:at,send_consumed_at:0})});return {delivery:d,authorization_id:auth};}
  async function consumeSendAuthorization({delivery_id,actor_id,fence,authorization_id,boot_id=""}){
    return withTx(["deliveries","leases","meta","events"],"readwrite",async tx=>{const at=now();const d=await getDeliveryTx(tx,delivery_id);if(d.state!=="SUBMITTING")throw new Error(`send impossible from ${d.state}`);const lease=await assertFence(tx,d,actor_id,fence,{requireFresh:true,at});if(d.send_authorization_id!==authorization_id||!authorization_id)throw new Error("send authorization mismatch");if(d.send_consumed_at){const e=new Error("send authorization consumed");e.code="wave2.send_consumed";throw e;}d.send_consumed_at=at;d.updated_at=at;os(tx,"deliveries").put(d);await appendEvent(tx,{delivery:d,previous_state:"SUBMITTING",next_state:"SUBMITTING",event_type:"SEND_CAPABILITY_CONSUMED",reason:"ONE_SHOT_SEND_CAPABILITY_CONSUMED",actor_id,boot_id,lease_fence:fence});return {delivery:d,permit:{kind:"wave1-durable-submitting",delivery_id:d.delivery_id,conversation_id:d.conversation_id,provider_locator:d.provider_locator,lease_fence:Number(fence),lease_expires_at:Number(lease.expires_at),authorization_id,consumed_at:at}};});
  }
  function markSentUnconfirmed(args){return transitionWithFence({...args,expected_state:"SUBMITTING",next_state:"SENT_UNCONFIRMED",reason:"SEND_INVOKED_RECEIPT_PENDING",mutate:d=>{if(!d.send_consumed_at)throw new Error("send capability not consumed");return d;}});}
  async function markDeliveryUnknown({delivery_id,actor_id,fence,reason="DELIVERY_RECEIPT_UNRESOLVED",boot_id="",evidence={}}){
    return withTx(["deliveries","leases","tasks","meta","events"],"readwrite",async tx=>{const at=now();let d=await getDeliveryTx(tx,delivery_id);if(d.state==="DELIVERY_UNKNOWN")return d;if(!Core.POST_SEND_AMBIGUITY_STATES.has(d.state))throw new Error(`cannot mark unknown from ${d.state}`);await assertFence(tx,d,actor_id,fence,{requireFresh:false,at});const prev=d.state;d=transition(d,"DELIVERY_UNKNOWN",at);d.unknown_reason=reason;os(tx,"deliveries").put(d);const task=await req(os(tx,"tasks").get(d.task_id));if(task)os(tx,"tasks").put({...task,status:"BLOCKED_UNKNOWN",updated_at:at});await appendEvent(tx,{delivery:d,previous_state:prev,next_state:"DELIVERY_UNKNOWN",reason,actor_id,boot_id,lease_fence:fence,evidence});return d;});
  }
  async function markDelivered({delivery_id,actor_id,fence,receipt,boot_id=""}){return withTx(["deliveries","leases","meta","events"],"readwrite",async tx=>{const at=now();let d=await getDeliveryTx(tx,delivery_id);if(["DELIVERED","RESPONSE_STARTED","RESPONSE_RECEIVED","ACKED"].includes(d.state))return d;if(!Core.POST_SEND_AMBIGUITY_STATES.has(d.state))throw new Error(`cannot confirm from ${d.state}`);await assertFence(tx,d,actor_id,fence,{requireFresh:false,at});const prev=d.state;d=transition(d,"DELIVERED",at);d.user_receipt={identity_key:String(receipt?.identity_key||""),identity_kind:String(receipt?.identity_kind||""),fingerprint:String(receipt?.fingerprint||""),order:Number(receipt?.order)||0,text_hash:String(receipt?.text_hash||"")};d.delivered_at=at;os(tx,"deliveries").put(d);await appendEvent(tx,{delivery:d,previous_state:prev,next_state:"DELIVERED",reason:"EXACT_OWNED_USER_TURN_CONFIRMED",actor_id,boot_id,lease_fence:fence,evidence:{user_identity:d.user_receipt.identity_key}});return d;});}
  function markResponseStarted(args){return transitionWithFence({...args,expected_state:"DELIVERED",next_state:"RESPONSE_STARTED",reason:"CAUSAL_ASSISTANT_CANDIDATE_IDENTIFIED",require_fresh:false,mutate:(d,at)=>({...d,assistant_candidate:args.candidate,assistant_text_hash:String(args.text_hash||""),assistant_last_changed_at:at})});}
  async function recordAssistantMutation({delivery_id,actor_id,fence,candidate,text_hash,boot_id=""}){return withTx(["deliveries","leases","meta","events"],"readwrite",async tx=>{const at=now();const d=await getDeliveryTx(tx,delivery_id);if(d.state!=="RESPONSE_STA