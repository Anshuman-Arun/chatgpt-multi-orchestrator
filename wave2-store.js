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
      os(tx,"runs").put({run_id:i