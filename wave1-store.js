((root, factory) => {
  const Core = typeof module === "object" && module.exports ? require("./wave1-core.js") : root.MultiAgentWave1Core;
  const api = factory(Core);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MultiAgentWave1Store = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (Core) => {
  "use strict";

  if (!Core) throw new Error("MultiAgentWave1Core is required");

  const DB_NAME = "chatgpt_multi_orchestrator_wave1";
  const DB_VERSION = 3;
  const LEASE_MS = 2 * 60 * 1000;
  const LEASE_RENEW_WINDOW_MS = 30 * 1000;
  const STORE_NAMES = Object.freeze([
    "meta", "runs", "tasks", "conversation_bindings", "deliveries", "leases", "worker_results", "events", "upstream_events", "faults"
  ]);
  const ALLOW_NEW_DELIVERY_AFTER = new Set(["ACKED", "FAILED", "RESPONSE_FAILED", "RESPONSE_SUPERSEDED"]);

  let dbPromise = null;

  function now() { return Date.now(); }

  function makeId(prefix) {
    if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  }

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  function transactionPromise(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
      transaction.onerror = () => {};
    });
  }

  function ensureStore(db, name, options) {
    return db.objectStoreNames.contains(name) ? null : db.createObjectStore(name, options);
  }

  function upgradeStore(db, request, name, options) {
    return db.objectStoreNames.contains(name)
      ? request.transaction.objectStore(name)
      : db.createObjectStore(name, options);
  }

  function ensureIndex(objectStore, name, keyPath, options = {}) {
    if (!objectStore.indexNames.contains(name)) objectStore.createIndex(name, keyPath, options);
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    if (!globalThis.indexedDB) return Promise.reject(new Error("IndexedDB is unavailable"));
    dbPromise = new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        upgradeStore(db, request, "meta", { keyPath: "key" });
        upgradeStore(db, request, "runs", { keyPath: "run_id" });
        upgradeStore(db, request, "tasks", { keyPath: "task_id" });
        const bindings = upgradeStore(db, request, "conversation_bindings", { keyPath: "conversation_id" });
        ensureIndex(bindings, "provider_locator", "provider_locator", { unique: true });
        const deliveries = upgradeStore(db, request, "deliveries", { keyPath: "delivery_id" });
        ensureIndex(deliveries, "conversation_id", "conversation_id", { unique: false });
        ensureIndex(deliveries, "created_at", "created_at", { unique: false });
        ensureIndex(deliveries, "task_id", "task_id", { unique: false });
        upgradeStore(db, request, "leases", { keyPath: "conversation_id" });
        const results = upgradeStore(db, request, "worker_results", { keyPath: "delivery_id" });
        ensureIndex(results, "task_id", "task_id", { unique: false });
        const events = upgradeStore(db, request, "events", { keyPath: "seq" });
        ensureIndex(events, "delivery_id", "delivery_id", { unique: false });
        ensureIndex(events, "conversation_id", "conversation_id", { unique: false });
        ensureIndex(events, "task_id", "task_id", { unique: false });
        const upstream = upgradeStore(db, request, "upstream_events", { keyPath: "event_id" });
        ensureIndex(upstream, "task_id", "task_id", { unique: false });
        ensureIndex(upstream, "dedupe_key", "dedupe_key", { unique: true });
        let faults;
        if (db.objectStoreNames.contains("faults")) {
          const existing = request.transaction.objectStore("faults");
          if (String(existing.keyPath) !== "fault_id") {
            db.deleteObjectStore("faults");
            faults = db.createObjectStore("faults", { keyPath: "fault_id" });
          } else {
            faults = existing;
          }
        } else {
          faults = db.createObjectStore("faults", { keyPath: "fault_id" });
        }
        ensureIndex(faults, "delivery_id", "delivery_id", { unique: false });
        ensureIndex(faults, "point", "point", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error("Could not open Wave-1 IndexedDB"));
      };
      request.onblocked = () => reject(new Error("Wave-1 IndexedDB upgrade is blocked"));
    });
    return dbPromise;
  }

  async function withTransaction(names, mode, fn) {
    const db = await openDb();
    const unique = Array.from(new Set(names));
    const tx = db.transaction(unique, mode);
    const done = transactionPromise(tx);
    try {
      const result = await fn(tx);
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }

  function store(tx, name) { return tx.objectStore(name); }

  function compactEvidence(value) {
    if (!value || typeof value !== "object") return {};
    const output = {};
    for (const [key, raw] of Object.entries(value)) {
      if (raw == null) continue;
      if (typeof raw === "boolean" || typeof raw === "number") output[key] = raw;
      else output[key] = String(raw).slice(0, 240);
    }
    return output;
  }

  async function appendEvent(tx, input) {
    const meta = store(tx, "meta");
    const events = store(tx, "events");
    const current = await requestPromise(meta.get("journal_seq"));
    const seq = Math.max(0, Number(current?.value) || 0) + 1;
    meta.put({ key: "journal_seq", value: seq });
    const delivery = input.delivery || {};
    const event = {
      seq,
      timestamp: Number(input.timestamp) || now(),
      event_type: String(input.event_type || "STATE_TRANSITION"),
      run_id: String(delivery.run_id || input.run_id || ""),
      task_id: String(delivery.task_id || input.task_id || ""),
      delivery_id: String(delivery.delivery_id || input.delivery_id || ""),
      conversation_id: String(delivery.conversation_id || input.conversation_id || ""),
      logical_agent_id: String(delivery.logical_agent_id || input.logical_agent_id || ""),
      slot_id: String(delivery.slot_id || input.slot_id || ""),
      previous_state: input.previous_state == null ? null : String(input.previous_state),
      next_state: input.next_state == null ? null : String(input.next_state),
      reason: String(input.reason || "").slice(0, 240),
      lease_fence: Math.max(0, Number(input.lease_fence ?? delivery.lease_fence) || 0),
      actor_id: String(input.actor_id || delivery.actor_id || "").slice(0, 220),
      boot_id: String(input.boot_id || "").slice(0, 220),
      evidence: compactEvidence(input.evidence)
    };
    events.add(event);
    return event;
  }

  function transitionDelivery(delivery, nextState, at = now()) {
    if (delivery.state === nextState) return delivery;
    if (!Core.canTransition(delivery.state, nextState)) {
      throw new Error(`Invalid Wave-1 Delivery transition ${delivery.state} -> ${nextState}`);
    }
    return { ...delivery, state: nextState, updated_at: at };
  }

  async function readDelivery(tx, deliveryId) {
    const delivery = await requestPromise(store(tx, "deliveries").get(String(deliveryId || "")));
    if (!delivery) throw new Error("Wave-1 Delivery was not found");
    return delivery;
  }

  async function assertFence(tx, delivery, actorId, fence, options = {}) {
    const lease = await requestPromise(store(tx, "leases").get(delivery.conversation_id));
    if (!lease
      || String(lease.owner_actor_id) !== String(actorId || "")
      || Number(lease.fence) !== Number(fence)
      || Number(delivery.lease_fence) !== Number(fence)) {
      const error = new Error("Wave-1 sender lease fence is stale");
      error.code = "wave1.lease_stale";
      throw error;
    }
    if (options.requireFresh !== false && Number(lease.expires_at) <= (options.at || now())) {
      const error = new Error("Wave-1 sender lease expired");
      error.code = "wave1.lease_expired";
      throw error;
    }
    return lease;
  }

  async function getBindingByLocator(providerLocator) {
    return withTransaction(["conversation_bindings"], "readonly", async (tx) => (
      requestPromise(store(tx, "conversation_bindings").index("provider_locator").get(String(providerLocator || "")))
    ));
  }

  async function bindConversation({ provider_locator, actor_id = "", boot_id = "" }) {
    const locator = String(provider_locator || "");
    if (!locator) throw new Error("Provider conversation locator is required");
    return withTransaction(["conversation_bindings", "meta", "events"], "readwrite", async (tx) => {
      const bindings = store(tx, "conversation_bindings");
      const existing = await requestPromise(bindings.index("provider_locator").get(locator));
      if (existing) return { binding: existing, created: false };
      const timestamp = now();
      const binding = {
        conversation_id: makeId("conversation"),
        provider: "chatgpt",
        provider_locator: locator,
        next_conversation_seq: 1,
        created_at: timestamp,
        updated_at: timestamp
      };
      bindings.put(binding);
      await appendEvent(tx, {
        event_type: "CONVERSATION_BOUND",
        conversation_id: binding.conversation_id,
        previous_state: null,
        next_state: null,
        reason: "MANUAL_WAVE1_BIND",
        actor_id,
        boot_id,
        evidence: { provider_locator_fingerprint: Core.fingerprint(locator) }
      });
      return { binding, created: true };
    });
  }

  async function createDelivery({ conversation_id, instruction, boot_id = "" }) {
    const cid = String(conversation_id || "");
    const binding = await withTransaction(["conversation_bindings"], "readonly", async (tx) => requestPromise(store(tx, "conversation_bindings").get(cid)));
    if (!binding) throw new Error("Wave-1 conversation binding was not found");
    const context = {
      protocol_version: Core.PROTOCOL_VERSION,
      run_id: makeId("run"),
      task_id: makeId("task"),
      logical_agent_id: makeId("agent"),
      slot_id: makeId("slot"),
      conversation_id: cid,
      delivery_id: makeId("delivery"),
      conversation_seq: Number(binding.next_conversation_seq) || 1,
      ownership_token: makeId("ownership")
    };
    const payload = Core.buildRouterPayload({ ...context, instruction });
    const payloadHash = await Core.sha256Hex(Core.normalizeText(payload));
    const payloadExactHash = await Core.sha256Hex(Core.canonicalText(payload));
    return withTransaction(["runs", "tasks", "conversation_bindings", "deliveries", "meta", "events"], "readwrite", async (tx) => {
      const bindings = store(tx, "conversation_bindings");
      const currentBinding = await requestPromise(bindings.get(cid));
      if (!currentBinding) throw new Error("Wave-1 conversation binding disappeared");
      if (Number(currentBinding.next_conversation_seq) !== context.conversation_seq) {
        throw new Error("Wave-1 conversation sequence changed; create the Delivery again");
      }
      const prior = await requestPromise(store(tx, "deliveries").index("conversation_id").getAll(cid));
      const blocking = prior.find((delivery) => !ALLOW_NEW_DELIVERY_AFTER.has(delivery.state));
      if (blocking) {
        const error = new Error(`Conversation already has unresolved Wave-1 Delivery ${blocking.delivery_id} (${blocking.state})`);
        error.code = "wave1.delivery_inflight";
        throw error;
      }
      const timestamp = now();
      const run = { run_id: context.run_id, status: "RUNNING", created_at: timestamp, updated_at: timestamp };
      const task = {
        task_id: context.task_id,
        run_id: context.run_id,
        logical_agent_id: context.logical_agent_id,
        slot_id: context.slot_id,
        conversation_id: cid,
        status: "RUNNING",
        created_at: timestamp,
        updated_at: timestamp
      };
      const delivery = {
        ...context,
        provider_locator: currentBinding.provider_locator,
        kind: "ASSIGNMENT",
        protocol_version: Core.PROTOCOL_VERSION,
        payload,
        payload_hash: payloadHash,
        payload_exact_hash: payloadExactHash,
        state: "PENDING",
        actor_id: "",
        lease_fence: 0,
        baseline: null,
        send_authorization_id: "",
        send_consumed_at: 0,
        user_receipt: null,
        assistant_candidate: null,
        assistant_text_hash: "",
        assistant_last_changed_at: 0,
        terminal_error: "",
        created_at: timestamp,
        updated_at: timestamp
      };
      store(tx, "runs").put(run);
      store(tx, "tasks").put(task);
      store(tx, "deliveries").put(delivery);
      currentBinding.next_conversation_seq = context.conversation_seq + 1;
      currentBinding.updated_at = timestamp;
      bindings.put(currentBinding);
      await appendEvent(tx, {
        delivery,
        previous_state: null,
        next_state: "PENDING",
        reason: "DELIVERY_CREATED",
        boot_id,
        evidence: { payload_hash: payloadHash, payload_exact_hash: payloadExactHash, conversation_seq: context.conversation_seq }
      });
      return delivery;
    });
  }

  async function claimDelivery({ delivery_id, actor_id, boot_id = "", lease_ms = LEASE_MS }) {
    const actor = String(actor_id || "");
    if (!actor) throw new Error("Wave-1 actor ID is required");
    return withTransaction(["deliveries", "leases", "meta", "events"], "readwrite", async (tx) => {
      const timestamp = now();
      let delivery = await readDelivery(tx, delivery_id);
      if (delivery.state !== "PENDING") throw new Error(`Wave-1 Delivery is ${delivery.state}, not PENDING`);
      const leases = store(tx, "leases");
      const existing = await requestPromise(leases.get(delivery.conversation_id));
      if (existing && Number(existing.expires_at) > timestamp && existing.owner_actor_id !== actor) {
        const error = new Error("Wave-1 conversation sender lease is owned by another actor");
        error.code = "wave1.lease_busy";
        throw error;
      }
      const sameActiveOwner = existing && existing.owner_actor_id === actor && Number(existing.expires_at) > timestamp;
      const fence = sameActiveOwner ? Number(existing.fence) : Math.max(0, Number(existing?.fence) || 0) + 1;
      const lease = {
        conversation_id: delivery.conversation_id,
        owner_actor_id: actor,
        fence,
        expires_at: timestamp + Math.max(30_000, Number(lease_ms) || LEASE_MS),
        updated_at: timestamp
      };
      leases.put(lease);
      const previous = delivery.state;
      delivery = transitionDelivery(delivery, "CLAIMED", timestamp);
      delivery.actor_id = actor;
      delivery.lease_fence = fence;
      store(tx, "deliveries").put(delivery);
      await appendEvent(tx, {
        delivery,
        previous_state: previous,
        next_state: delivery.state,
        reason: "SENDER_LEASE_CLAIMED",
        lease_fence: fence,
        actor_id: actor,
        boot_id,
        evidence: { lease_expires_at: lease.expires_at }
      });
      return { delivery, lease };
    });
  }

  async function renewLease({ delivery_id, actor_id, fence, boot_id = "" }) {
    return withTransaction(["deliveries", "leases", "meta", "events"], "readwrite", async (tx) => {
      const timestamp = now();
      const delivery = await readDelivery(tx, delivery_id);
      const lease = await assertFence(tx, delivery, actor_id, fence, { requireFresh: false, at: timestamp });
      const expired = Number(lease.expires_at) <= timestamp;
      const reconciliationOnlyStates = new Set([
        "SUBMITTING", "SENT_UNCONFIRMED", "DELIVERED", "RESPONSE_STARTED", "RESPONSE_RECEIVED"
      ]);

      if (expired) {
        if (reconciliationOnlyStates.has(delivery.state)) {
          return { delivery, lease, renewed: false, reconciliation_only: true };
        }
        const error = new Error("Wave-1 sender lease expired before the Send ambiguity boundary");
        error.code = "wave1.lease_expired";
        throw error;
      }

      if (Number(lease.expires_at) - timestamp > LEASE_RENEW_WINDOW_MS) {
        return { delivery, lease, renewed: false, reconciliation_only: false };
      }
      lease.expires_at = timestamp + LEASE_MS;
      lease.updated_at = timestamp;
      store(tx, "leases").put(lease);
      await appendEvent(tx, {
        delivery,
        previous_state: delivery.state,
        next_state: delivery.state,
        event_type: "LEASE_RENEWED",
        reason: "ACTIVE_WAVE1_RECONCILIATION",
        lease_fence: fence,
        actor_id,
        boot_id,
        evidence: { lease_expires_at: lease.expires_at }
      });
      return { delivery, lease, renewed: true, reconciliation_only: false };
    });
  }

  async function transitionWithEvidence({ delivery_id, actor_id, fence, expected_state, next_state, reason, boot_id = "", evidence = {}, mutate = null, require_fresh = true }) {
    return withTransaction(["deliveries", "leases", "meta", "events"], "readwrite", async (tx) => {
      const timestamp = now();
      let delivery = await readDelivery(tx, delivery_id);
      if (delivery.state !== expected_state) throw new Error(`Wave-1 Delivery is ${delivery.state}, expected ${expected_state}`);
      await assertFence(tx, delivery, actor_id, fence, { requireFresh: require_fresh, at: timestamp });
      const previous = delivery.state;
      delivery = transitionDelivery(delivery, next_state, timestamp);
      if (typeof mutate === "function") delivery = mutate(delivery, timestamp) || delivery;
      store(tx, "deliveries").put(delivery);
      await appendEvent(tx, { delivery, previous_state: previous, next_state, reason, actor_id, boot_id, lease_fence: fence, evidence });
      return delivery;
    });
  }

  function sanitizeBaseline(baseline) {
    return {
      route_identity: String(baseline?.route_identity || ""),
      user_keys: Array.isArray(baseline?.user_keys) ? baseline.user_keys.map(String) : [],
      assistant_keys: Array.isArray(baseline?.assistant_keys) ? baseline.assistant_keys.map(String) : [],
      tail_key: String(baseline?.tail_key || ""),
      tail_fingerprint: String(baseline?.tail_fingerprint || ""),
      tail_text: String(baseline?.tail_text || "")
    };
  }

  function beginComposerFilling(args) {
    const baseline = sanitizeBaseline(args.baseline);
    return transitionWithEvidence({
      ...args,
      expected_state: "CLAIMED",
      next_state: "COMPOSER_FILLING",
      reason: "BASELINE_CAPTURED_COMPOSER_EMPTY",
      evidence: {
        route_fingerprint: Core.fingerprint(baseline.route_identity),
        user_baseline_size: baseline.user_keys.length,
        assistant_baseline_size: baseline.assistant_keys.length,
        tail_identity_fingerprint: Core.fingerprint(baseline.tail_key),
        tail_content_fingerprint: baseline.tail_fingerprint,
        tail_text_fingerprint: Core.fingerprint(baseline.tail_text)
      },
      mutate: (delivery) => ({ ...delivery, baseline })
    });
  }

  function markComposerFilled(args) {
    return transitionWithEvidence({
      ...args,
      expected_state: "COMPOSER_FILLING",
      next_state: "COMPOSER_FILLED",
      reason: "COMPOSER_EXACT_READBACK_VERIFIED",
      evidence: { composer_hash: args.composer_hash || "", route_fingerprint: args.route_fingerprint || "" }
    });
  }

  async function failPreSend({ delivery_id, actor_id, fence, reason, boot_id = "", evidence = {} }) {
    return withTransaction(["deliveries", "leases", "tasks", "runs", "meta", "events"], "readwrite", async (tx) => {
      const timestamp = now();
      let delivery = await readDelivery(tx, delivery_id);
      if (!["PENDING", "CLAIMED", "COMPOSER_FILLING", "COMPOSER_FILLED"].includes(delivery.state)) {
        throw new Error(`Cannot fail pre-send from ${delivery.state}`);
      }
      if (delivery.state !== "PENDING") await assertFence(tx, delivery, actor_id, fence, { requireFresh: false, at: timestamp });
      const previous = delivery.state;
      delivery = transitionDelivery(delivery, "FAILED", timestamp);
      delivery.failure_reason = String(reason || "PRE_SEND_FAILURE").slice(0, 240);
      store(tx, "deliveries").put(delivery);
      const task = await requestPromise(store(tx, "tasks").get(delivery.task_id));
      if (task) store(tx, "tasks").put({ ...task, status: "FAILED", updated_at: timestamp });
      const run = await requestPromise(store(tx, "runs").get(delivery.run_id));
      if (run) store(tx, "runs").put({ ...run, status: "FAILED", updated_at: timestamp });
      await appendEvent(tx, { delivery, previous_state: previous, next_state: "FAILED", reason: delivery.failure_reason, actor_id, boot_id, lease_fence: fence, evidence });
      return delivery;
    });
  }

  async function authorizeSend({ delivery_id, actor_id, fence, boot_id = "" }) {
    const authorizationId = makeId("sendauth");
    const delivery = await transitionWithEvidence({
      delivery_id,
      actor_id,
      fence,
      expected_state: "COMPOSER_FILLED",
      next_state: "SUBMITTING",
      reason: "DURABLE_SEND_AUTHORIZATION",
      boot_id,
      evidence: { authorization_fingerprint: Core.fingerprint(authorizationId) },
      mutate: (value, timestamp) => ({ ...value, send_authorization_id: authorizationId, send_authorized_at: timestamp, send_consumed_at: 0 })
    });
    return { delivery, authorization_id: authorizationId };
  }

  async function consumeSendAuthorization({ delivery_id, actor_id, fence, authorization_id, boot_id = "" }) {
    return withTransaction(["deliveries", "leases", "meta", "events"], "readwrite", async (tx) => {
      const timestamp = now();
      const delivery = await readDelivery(tx, delivery_id);
      if (delivery.state !== "SUBMITTING") throw new Error(`Send is impossible from ${delivery.state}`);
      const lease = await assertFence(tx, delivery, actor_id, fence, { requireFresh: true, at: timestamp });
      if (!authorization_id || delivery.send_authorization_id !== authorization_id) throw new Error("Wave-1 send authorization does not match durable state");
      if (delivery.send_consumed_at) {
        const error = new Error("Wave-1 send authorization was already consumed");
        error.code = "wave1.send_already_consumed";
        throw error;
      }
      delivery.send_consumed_at = timestamp;
      delivery.updated_at = timestamp;
      store(tx, "deliveries").put(delivery);
      await appendEvent(tx, {
        delivery,
        previous_state: "SUBMITTING",
        next_state: "SUBMITTING",
        event_type: "SEND_CAPABILITY_CONSUMED",
        reason: "ONE_SHOT_SEND_CAPABILITY_CONSUMED",
        actor_id,
        boot_id,
        lease_fence: fence,
        evidence: { authorization_fingerprint: Core.fingerprint(authorization_id) }
      });
      return {
        delivery,
        permit: {
          kind: "wave1-durable-submitting",
          delivery_id: delivery.delivery_id,
          conversation_id: delivery.conversation_id,
          provider_locator: delivery.provider_locator,
          lease_fence: Number(fence),
          lease_expires_at: Number(lease.expires_at),
          authorization_id,
          consumed_at: timestamp
        }
      };
    });
  }

  function markSentUnconfirmed(args) {
    return transitionWithEvidence({
      ...args,
      expected_state: "SUBMITTING",
      next_state: "SENT_UNCONFIRMED",
      reason: "SEND_INVOKED_RECEIPT_PENDING",
      evidence: { send_path: args.send_path || "" },
      mutate: (delivery) => {
        if (!delivery.send_consumed_at) throw new Error("Send capability was not durably consumed");
        return delivery;
      }
    });
  }

  async function markDeliveryUnknown({ delivery_id, actor_id, fence, reason, boot_id = "", evidence = {} }) {
    return withTransaction(["deliveries", "leases", "tasks", "runs", "meta", "events"], "readwrite", async (tx) => {
      const timestamp = now();
      let delivery = await readDelivery(tx, delivery_id);
      if (!["SUBMITTING", "SENT_UNCONFIRMED"].includes(delivery.state)) return delivery;
      await assertFence(tx, delivery, actor_id, fence, { requireFresh: false, at: timestamp });
      const previous = delivery.state;
      delivery = transitionDelivery(delivery, "DELIVERY_UNKNOWN", timestamp);
      delivery.unknown_reason = String(reason || "DELIVERY_RECEIPT_UNRESOLVED").slice(0, 240);
      store(tx, "deliveries").put(delivery);
      const task = await requestPromise(store(tx, "tasks").get(delivery.task_id));
      if (task) store(tx, "tasks").put({ ...task, status: "BLOCKED", updated_at: timestamp });
      const run = await requestPromise(store(tx, "runs").get(delivery.run_id));
      if (run) store(tx, "runs").put({ ...run, status: "BLOCKED", updated_at: timestamp });
      await appendEvent(tx, { delivery, previous_state: previous, next_state: "DELIVERY_UNKNOWN", reason: delivery.unknown_reason, actor_id, boot_id, lease_fence: fence, evidence });
      return delivery;
    });
  }

  async function markDelivered({ delivery_id, actor_id, fence, receipt, boot_id = "" }) {
    return withTransaction(["deliveries", "leases", "meta", "events"], "readwrite", async (tx) => {
      const timestamp = now();
      let delivery = await readDelivery(tx, delivery_id);
      if (delivery.state === "DELIVERED" || delivery.state === "RESPONSE_STARTED" || delivery.state === "RESPONSE_RECEIVED" || delivery.state === "ACKED") return delivery;
      if (!["SUBMITTING", "SENT_UNCONFIRMED"].includes(delivery.state)) throw new Error(`Cannot confirm Delivery from ${delivery.state}`);
      await assertFence(tx, delivery, actor_id, fence, { requireFresh: false, at: timestamp });
      const previous = delivery.state;
      delivery = transitionDelivery(delivery, "DELIVERED", timestamp);
      delivery.user_receipt = {
        identity_key: String(receipt?.identity_key || ""),
        identity_kind: String(receipt?.identity_kind || ""),
        fingerprint: String(receipt?.fingerprint || ""),
        order: Number(receipt?.order) || 0,
        text_hash: String(receipt?.text_hash || "")
      };
      delivery.delivered_at = timestamp;
      store(tx, "deliveries").put(delivery);
      await appendEvent(tx, {
        delivery,
        previous_state: previous,
        next_state: "DELIVERED",
        reason: "EXACT_OWNED_USER_TURN_CONFIRMED",
        actor_id,
        boot_id,
        lease_fence: fence,
        evidence: {
          user_identity: delivery.user_receipt.identity_key,
          identity_kind: delivery.user_receipt.identity_kind,
          user_fingerprint: delivery.user_receipt.fingerprint,
          text_hash: delivery.user_receipt.text_hash
        }
      });
      return delivery;
    });
  }

  async function markResponseSuperseded({ delivery_id, actor_id, fence, reason = "FOREIGN_USER_TURN_AFTER_OWNED_RECEIPT", boot_id = "", evidence = {} }) {
    return withTransaction(["deliveries", "leases", "tasks", "runs", "meta", "events"], "readwrite", async (tx) => {
      const timestamp = now();
      let delivery = await readDelivery(tx, delivery_id);
      if (delivery.state === "RESPONSE_SUPERSEDED") return delivery;
      if (!["DELIVERED", "RESPONSE_STARTED"].includes(delivery.state)) {
        throw new Error(`Cannot supersede response from ${delivery.state}`);
      }
      await assertFence(tx, delivery, actor_id, fence, { requireFresh: false, at: timestamp });
      const previous = delivery.state;
      delivery = transitionDelivery(delivery, "RESPONSE_SUPERSEDED", timestamp);
      delivery.superseded_reason = String(reason || "FOREIGN_USER_TURN_AFTER_OWNED_RECEIPT").slice(0, 180);
      store(tx, "deliveries").put(delivery);
      const task = await requestPromise(store(tx, "tasks").get(delivery.task_id));
      if (task) store(tx, "tasks").put({ ...task, status: "BLOCKED", updated_at: timestamp });
      const run = await requestPromise(store(tx, "runs").get(delivery.run_id));
      if (run) store(tx, "runs").put({ ...run, status: "BLOCKED", updated_at: timestamp });
      await appendEvent(tx, {
        delivery,
        previous_state: previous,
        next_state: "RESPONSE_SUPERSEDED",
        event_type: "RESPONSE_SUPERSEDED",
        reason: delivery.superseded_reason,
        actor_id,
        boot_id,
        lease_fence: fence,
        evidence
      });
      return delivery;
    });
  }

  async function markResponseFailed({ delivery_id, actor_id, fence, error_code, boot_id = "", evidence = {} }) {
    return withTransaction(["deliveries", "leases", "tasks", "runs", "meta", "events"], "readwrite", async (tx) => {
      const timestamp = now();
      let delivery = await readDelivery(tx, delivery_id);
      if (delivery.state === "RESPONSE_FAILED") return delivery;
      if (!["DELIVERED", "RESPONSE_STARTED"].includes(delivery.state)) {
        throw new Error(`Cannot mark response failed from ${delivery.state}`);
      }
      await assertFence(tx, delivery, actor_id, fence, { requireFresh: false, at: timestamp });
      const previous = delivery.state;
      delivery = transitionDelivery(delivery, "RESPONSE_FAILED", timestamp);
      delivery.response_error = String(error_code || "generation_error").slice(0, 160);
      store(tx, "deliveries").put(delivery);
      const task = await requestPromise(store(tx, "tasks").get(delivery.task_id));
      if (task) store(tx, "tasks").put({ ...task, status: "FAILED", updated_at: timestamp });
      const run = await requestPromise(store(tx, "runs").get(delivery.run_id));
      if (run) store(tx, "runs").put({ ...run, status: "FAILED", updated_at: timestamp });
      await appendEvent(tx, {
        delivery,
        previous_state: previous,
        next_state: "RESPONSE_FAILED",
        event_type: "RESPONSE_FAILED",
        reason: delivery.response_error,
        actor_id,
        boot_id,
        lease_fence: fence,
        evidence
      });
      return delivery;
    });
  }

  async function markResponseStarted({ delivery_id, actor_id, fence, candidate, text_hash, boot_id = "" }) {
    return transitionWithEvidence({
      delivery_id,
      actor_id,
      fence,
      expected_state: "DELIVERED",
      next_state: "RESPONSE_STARTED",
      reason: "CAUSAL_ASSISTANT_CANDIDATE_IDENTIFIED",
      boot_id,
      require_fresh: false,
      evidence: { assistant_identity: candidate?.identity_key || "", identity_kind: candidate?.identity_kind || "", text_hash },
      mutate: (delivery, timestamp) => ({
        ...delivery,
        assistant_candidate: {
          identity_key: String(candidate?.identity_key || ""),
          identity_kind: String(candidate?.identity_kind || ""),
          order: Number(candidate?.order) || 0
        },
        assistant_text_hash: String(text_hash || ""),
        assistant_last_changed_at: timestamp
      })
    });
  }

  async function recordAssistantMutation({ delivery_id, actor_id, fence, candidate = null, text_hash, boot_id = "" }) {
    return withTransaction(["deliveries", "leases", "meta", "events"], "readwrite", async (tx) => {
      const timestamp = now();
      const delivery = await readDelivery(tx, delivery_id);
      if (delivery.state !== "RESPONSE_STARTED") return delivery;
      await assertFence(tx, delivery, actor_id, fence, { requireFresh: false, at: timestamp });
      const nextIdentity = String(candidate?.identity_key || delivery.assistant_candidate?.identity_key || "");
      const identityChanged = nextIdentity !== String(delivery.assistant_candidate?.identity_key || "");
      const textChanged = delivery.assistant_text_hash !== String(text_hash || "");
      if (!identityChanged && !textChanged) return delivery;
      delivery.assistant_candidate = {
        identity_key: nextIdentity,
        identity_kind: String(candidate?.identity_kind || delivery.assistant_candidate?.identity_kind || ""),
        order: Number(candidate?.order ?? delivery.assistant_candidate?.order) || 0
      };
      delivery.assistant_text_hash = String(text_hash || "");
      delivery.assistant_last_changed_at = timestamp;
      delivery.updated_at = timestamp;
      store(tx, "deliveries").put(delivery);
      await appendEvent(tx, {
        delivery,
        previous_state: "RESPONSE_STARTED",
        next_state: "RESPONSE_STARTED",
        event_type: "ASSISTANT_MUTATED",
        reason: identityChanged ? "ASSISTANT_IDENTITY_CHANGED" : "ASSISTANT_OUTPUT_CHANGED",
        actor_id,
        boot_id,
        lease_fence: fence,
        evidence: { text_hash, identity_changed: identityChanged, assistant_identity: nextIdentity }
      });
      return delivery;
    });
  }

  async function markResponseReceived({ delivery_id, actor_id, fence, response_text = "", response_text_hash, completion_evidence, boot_id = "" }) {
    return transitionWithEvidence({
      delivery_id,
      actor_id,
      fence,
      expected_state: "RESPONSE_STARTED",
      next_state: "RESPONSE_RECEIVED",
      reason: "TURN_COMPLETE_MULTI_SIGNAL",
      boot_id,
      require_fresh: false,
      evidence: { response_text_hash, quiet_ms: completion_evidence?.quiet_ms || 0, generating: completion_evidence?.generating || false },
      mutate: (delivery, timestamp) => ({
        ...delivery,
        response_text: String(response_text || ""),
        response_text_hash: String(response_text_hash || ""),
        response_received_at: timestamp
      })
    });
  }

  async function annotateProtocolFailure({ delivery_id, actor_id, fence, code, boot_id = "" }) {
    return withTransaction(["deliveries", "leases", "meta", "events"], "readwrite", async (tx) => {
      const timestamp = now();
      const delivery = await readDelivery(tx, delivery_id);
      if (delivery.state !== "RESPONSE_RECEIVED") return delivery;
      await assertFence(tx, delivery, actor_id, fence, { requireFresh: false, at: timestamp });
      if (delivery.terminal_error === code) return delivery;
      delivery.terminal_error = String(code || "protocol.invalid").slice(0, 160);
      delivery.updated_at = timestamp;
      store(tx, "deliveries").put(delivery);
      await appendEvent(tx, {
        delivery,
        previous_state: "RESPONSE_RECEIVED",
        next_state: "RESPONSE_RECEIVED",
        event_type: "TASK_NONTERMINAL",
        reason: delivery.terminal_error,
        actor_id,
        boot_id,
        lease_fence: fence,
        evidence: { response_text_hash: delivery.response_text_hash || "" }
      });
      return delivery;
    });
  }

  async function captureDoneAndAck({ delivery_id, actor_id, fence, envelope, boot_id = "" }) {
    return withTransaction(["deliveries", "leases", "worker_results", "tasks", "runs", "meta", "events"], "readwrite", async (tx) => {
      const timestamp = now();
      let delivery = await readDelivery(tx, delivery_id);
      if (delivery.state === "ACKED") {
        return { delivery, result: await requestPromise(store(tx, "worker_results").get(delivery_id)), already_acked: true };
      }
      if (delivery.state !== "RESPONSE_RECEIVED") throw new Error(`Cannot ACK worker result from ${delivery.state}`);
      await assertFence(tx, delivery, actor_id, fence, { requireFresh: false, at: timestamp });
      if (!delivery.response_text || !delivery.response_text_hash) {
        throw new Error("Cannot ACK before the completed assistant response is durably captured");
      }
      const result = {
        delivery_id: delivery.delivery_id,
        run_id: delivery.run_id,
        task_id: delivery.task_id,
        logical_agent_id: delivery.logical_agent_id,
        slot_id: delivery.slot_id,
        conversation_id: delivery.conversation_id,
        conversation_seq: delivery.conversation_seq,
        protocol_version: delivery.protocol_version,
        status: "DONE",
        envelope: { ...envelope },
        response_text: String(delivery.response_text || ""),
        response_text_hash: delivery.response_text_hash || "",
        captured_at: timestamp
      };
      store(tx, "worker_results").put(result);
      const task = await requestPromise(store(tx, "tasks").get(delivery.task_id));
      if (task) store(tx, "tasks").put({ ...task, status: "DONE", updated_at: timestamp });
      const run = await requestPromise(store(tx, "runs").get(delivery.run_id));
      if (run) store(tx, "runs").put({ ...run, status: "DONE", updated_at: timestamp });
      const previous = delivery.state;
      delivery = transitionDelivery(delivery, "ACKED", timestamp);
      delivery.acked_at = timestamp;
      delivery.terminal_error = "";
      store(tx, "deliveries").put(delivery);
      await appendEvent(tx, {
        delivery,
        previous_state: previous,
        next_state: "ACKED",
        event_type: "WORKER_RESULT_CAPTURED",
        reason: "VALID_CURRENT_DONE_ENVELOPE",
        actor_id,
        boot_id,
        lease_fence: fence,
        evidence: { response_text_hash: result.response_text_hash, status: "DONE" }
      });
      return { delivery, result, already_acked: false };
    });
  }

  async function getDelivery(deliveryId) {
    return withTransaction(["deliveries"], "readonly", async (tx) => requestPromise(store(tx, "deliveries").get(String(deliveryId || ""))));
  }

  async function getStatusByLocator(providerLocator) {
    const locator = String(providerLocator || "");
    return withTransaction(["conversation_bindings", "deliveries", "worker_results"], "readonly", async (tx) => {
      const binding = await requestPromise(store(tx, "conversation_bindings").index("provider_locator").get(locator));
      if (!binding) return { binding: null, delivery: null, result: null };
      const deliveries = await requestPromise(store(tx, "deliveries").index("conversation_id").getAll(binding.conversation_id));
      deliveries.sort((a, b) => (
        Number(b.conversation_seq) - Number(a.conversation_seq)
        || Number(b.created_at) - Number(a.created_at)
        || String(b.delivery_id || "").localeCompare(String(a.delivery_id || ""))
      ));
      const delivery = deliveries[0] || null;
      const result = delivery ? await requestPromise(store(tx, "worker_results").get(delivery.delivery_id)) : null;
      return { binding, delivery, result };
    });
  }

  async function getEventsForDelivery(deliveryId) {
    return withTransaction(["events"], "readonly", async (tx) => {
      const events = await requestPromise(store(tx, "events").index("delivery_id").getAll(String(deliveryId || "")));
      return events.sort((a, b) => Number(a.seq) - Number(b.seq));
    });
  }

  return Object.freeze({
    DB_NAME,
    DB_VERSION,
    LEASE_MS,
    LEASE_RENEW_WINDOW_MS,
    STORE_NAMES,
    openDb,
    bindConversation,
    getBindingByLocator,
    createDelivery,
    claimDelivery,
    renewLease,
    beginComposerFilling,
    markComposerFilled,
    failPreSend,
    authorizeSend,
    consumeSendAuthorization,
    markSentUnconfirmed,
    markDeliveryUnknown,
    markDelivered,
    markResponseSuperseded,
    markResponseFailed,
    markResponseStarted,
    recordAssistantMutation,
    markResponseReceived,
    annotateProtocolFailure,
    captureDoneAndAck,
    getDelivery,
    getStatusByLocator,
    getEventsForDelivery
  });
});
