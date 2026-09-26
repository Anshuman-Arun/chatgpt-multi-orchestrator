(() => {
  "use strict";

  const Config = globalThis.YOLOConfig;
  const W1 = globalThis.MultiAgentWave1Core;
  const Core = globalThis.MultiAgentWave2Core;
  const Store = globalThis.MultiAgentWave2Store;
  if (!Config || !W1 || !Core || !Store || !globalThis.chrome?.runtime?.onMessage) return;

  const BOOT_ID = globalThis.crypto?.randomUUID ? `wave2_boot_${globalThis.crypto.randomUUID()}` : `wave2_boot_${Date.now().toString(36)}`;
  const RECEIPT_WINDOW_MS = 15_000;

  function senderLocator(sender) { return Config.pageId(sender?.url || sender?.tab?.url || ""); }
  function requireDurableLocator(locator) {
    if (!Config.isDurablePageId(locator)) { const e = new Error("Wave 2 requires a saved ChatGPT conversation"); e.code = "wave2.route_invalid"; throw e; }
    return locator;
  }
  function requireSenderRoute(sender, expected) {
    const actual = requireDurableLocator(senderLocator(sender));
    if (actual !== String(expected || "")) { const e = new Error("content-script route no longer matches the bound conversation"); e.code = "wave2.route_mismatch"; throw e; }
    return actual;
  }
  async function fire(point, deliveryId = "", actorId = "") {
    if (await Store.maybeFireFault({ point, delivery_id: deliveryId, actor_id: actorId, boot_id: BOOT_ID })) {
      const e = new Error(`Injected Wave-2 fault: ${point}`); e.code = "wave2.injected_fault"; e.fault_point = point; throw e;
    }
  }
  function newUserTurns(delivery, snapshot) {
    const users = new Set(Array.isArray(delivery?.baseline?.user_keys) ? delivery.baseline.user_keys : []);
    const assistants = Array.isArray(delivery?.baseline?.assistant_keys) ? delivery.baseline.assistant_keys : [];
    if (!delivery?.baseline?.tail_key && users.size === 0 && assistants.length === 0) return (snapshot?.turns || []).filter(t => t.role === "user");
    return W1.turnsAfterAnchor(snapshot, delivery?.baseline?.tail_key, "user", delivery?.baseline?.tail_fingerprint, delivery?.baseline?.tail_text)
      .filter(t => !users.has(String(t.identity_key || "")));
  }
  function baselineFromSnapshot(snapshot) {
    const turns = Array.isArray(snapshot?.turns) ? snapshot.turns : []; const tail = turns.at(-1) || null;
    return {
      route_identity: String(snapshot?.route_identity || ""), user_keys: turns.filter(t => t.role === "user").map(t => t.identity_key),
      assistant_keys: turns.filter(t => t.role === "assistant").map(t => t.identity_key), tail_key: String(tail?.identity_key || ""),
      tail_fingerprint: String(tail?.fingerprint || ""), tail_text: String(tail?.text || "")
    };
  }

  async function handleBind(message, sender) {
    const locator = requireDurableLocator(Config.pageId(message.provider_locator || senderLocator(sender))); requireSenderRoute(sender, locator);
    return { ok: true, ...(await Store.bindConversation({ provider_locator: locator, actor_id: message.actor_id, boot_id: BOOT_ID })), boot_id: BOOT_ID };
  }
  async function handleStatus(_message, sender) {
    const locator = requireDurableLocator(senderLocator(sender)); return { ok: true, ...(await Store.latestForLocator(locator)), boot_id: BOOT_ID };
  }
  async function handleCreate(message, sender) {
    const locator = requireDurableLocator(senderLocator(sender)); const binding = await Store.getBindingByLocator(locator);
    if (!binding || binding.conversation_id !== message.conversation_id) throw new Error("bind this conversation first");
    const instruction = String(message.instruction || "").trim(); if (!instruction) throw new Error("task instruction required");
    const delivery = await Store.createAssignment({ conversation_id: binding.conversation_id, instruction, budgets: message.budgets || {}, boot_id: BOOT_ID });
    await fire("after_delivery_persist", delivery.delivery_id, message.actor_id);
    return { ok: true, delivery };
  }
  async function requireDeliveryRoute(id, sender) { const d = await Store.getDelivery(id); if (!d) throw new Error("Delivery not found"); requireSenderRoute(sender, d.provider_locator); return d; }
  async function handleClaim(message, sender) { await requireDeliveryRoute(message.delivery_id, sender); return { ok: true, ...(await Store.acquireLease({ delivery_id: message.delivery_id, actor_id: message.actor_id, boot_id: BOOT_ID, force_reclaim: Boolean(message.force_reclaim) })) }; }
  async function handleBeginFill(message, sender) {
    const d = await requireDeliveryRoute(message.delivery_id, sender), snapshot = message.snapshot || {};
    if (snapshot.route_identity !== d.provider_locator) throw new Error("baseline route mismatch");
    if (!snapshot.composer_present) throw new Error("composer unavailable");
    if (Core.canonicalText(snapshot.composer_text)) { const e = new Error("composer contains foreign/manual text"); e.code = "wave2.manual_interference"; throw e; }
    if (snapshot.generating || ["authentication_required", "rate_limited", "unrecognized_ui"].includes(snapshot.ui_state)) throw new Error(`UI not send-safe (${snapshot.ui_state || snapshot.error_code || "busy"})`);
    return { ok: true, delivery: await Store.beginComposerFilling({ delivery_id: d.delivery_id, actor_id: message.actor_id, fence: message.fence, baseline: baselineFromSnapshot(snapshot), boot_id: BOOT_ID }) };
  }
  async function handleComposerFilled(message, sender) {
    const d = await requireDeliveryRoute(message.delivery_id, sender), snapshot = message.snapshot || {};
    if (snapshot.route_identity !== d.provider_locator || !snapshot.composer_present) throw new Error("composer/route changed while filling");
    if (Core.canonicalText(snapshot.composer_text) !== Core.canonicalText(d.payload)) throw new Error("exact composer readback failed");
    const hash = await Core.sha256Hex(Core.canonicalText(snapshot.composer_text)); if (hash !== d.payload_exact_hash) throw new Error("composer hash mismatch");
    if (newUserTurns(d, snapshot).length) { const e = new Error("foreign user turn appeared before Send"); e.code = "wave2.manual_interference"; throw e; }
    return { ok: true, delivery: await Store.markComposerFilled({ delivery_id: d.delivery_id, actor_id: message.actor_id, fence: message.fence, boot_id: BOOT_ID, evidence: { composer_hash: hash } }) };
  }
  async function handleFailPreSend(message, sender) {
    const d = await requireDeliveryRoute(message.delivery_id, sender);
    return { ok: true, delivery: await Store.failPreSend({ delivery_id: d.delivery_id, actor_id: message.actor_id, fence: message.fence, reason: message.reason, manual_pause: Boolean(message.manual_pause), boot_id: BOOT_ID, evidence: message.evidence || {} }) };
  }
  async function handleAuthorize(message, sender) {
    const d = await requireDeliveryRoute(message.delivery_id, sender), snapshot = message.snapshot || {};
    if (snapshot.route_identity !== d.provider_locator || Core.canonicalText(snapshot.composer_text) !== Core.canonicalText(d.payload)) throw new Error("pre-Send route/composer ownership changed");
    if (newUserTurns(d, snapshot).length) { const e=new Error("foreign user turn appeared before Send authorization"); e.code="wave2.manual_interference"; throw e; }
    if (snapshot.generating || ["authentication_required","rate_limited","unrecognized_ui"].includes(snapshot.ui_state)) throw new Error(`UI not send-safe (${snapshot.ui_state||"busy"})`);
    const result = await Store.authorizeSend({ delivery_id: d.delivery_id, actor_id: message.actor_id, fence: message.fence, boot_id: BOOT_ID });
    await fire("after_submitting_commit", d.delivery_id, message.actor_id); return { ok: true, ...result };
  }
  async function handleConsume(message, sender) {
    const d = await requireDeliveryRoute(message.delivery_id, sender); return { ok: true, ...(await Store.consumeSendAuthorization({ delivery_id: d.delivery_id, actor_id: message.actor_id, fence: message.fence, authorization_id: message.authorization_id, boot_id: BOOT_ID })) };
  }
  async function handleSent(message, sender) {
    const d = await requireDeliveryRoute(message.delivery_id, sender); return { ok: true, delivery: await Store.markSentUnconfirmed({ delivery_id: d.delivery_id, actor_id: message.actor_id, fence: message.fence, boot_id: BOOT_ID, evidence: { send_path: message.send_path || "" } }) };
  }
  async function handleUnknown(message) { return { ok: true, delivery: await Store.markDeliveryUnknown({ delivery_id: message.delivery_id, actor_id: message.actor_id, fence: message.fence, reason: message.reason, boot_id: BOOT_ID, evidence: message.evidence || {} }) }; }

  async function finishResponse(delivery, message) {
    const persisted = await Store.persistWorkerResult({ delivery_id: delivery.delivery_id, actor_id: message.actor_id, fence: message.fence, envelope: message.parsed_envelope, boot_id: BOOT_ID });
    await fire("after_result_persist", delivery.delivery_id, message.actor_id);
    const acked = await Store.ackWorkerResult({ delivery_id: delivery.delivery_id, actor_id: message.actor_id, fence: message.fence, boot_id: BOOT_ID });
    const post = await Store.materializePostResult({ delivery_id: delivery.delivery_id, boot_id: BOOT_ID });
    const nextDelivery = post.next_delivery_id ? await Store.getDelivery(post.next_delivery_id) : null;
    return { ok: true, delivery: acked.delivery, result: acked.result, next_delivery: nextDelivery, terminal: !nextDelivery, task_terminal: acked.result.status !== "CONTINUE" || post.next_action === "CONTROLLER_ESCALATION" };
  }

  async function reconcile(message, sender, options = {}) {
    let d = await requireDeliveryRoute(message.delivery_id, sender); let snapshot = { ...(message.snapshot || {}) };
    if (await Store.maybeFireFault({ point: "connection_interruption", delivery_id: d.delivery_id, actor_id: message.actor_id, boot_id: BOOT_ID })) snapshot.ui_state = "connection_waiting";
    if (await Store.maybeFireFault({ point: "retry_error_state", delivery_id: d.delivery_id, actor_id: message.actor_id, boot_id: BOOT_ID })) snapshot.ui_state = "retryable_model_error";
    if (snapshot.route_identity !== d.provider_locator) {
      if (Core.POST_SEND_AMBIGUITY_STATES.has(d.state)) return { ok: true, delivery: await Store.markDeliveryUnknown({ delivery_id:d.delivery_id, actor_id:message.actor_id, fence:message.fence, reason:"ROUTE_MISMATCH_AFTER_SUBMITTING", boot_id:BOOT_ID }), terminal:true };
      return { ok:false, code:"wave2.route_mismatch", reason:"route mismatch; lane paused" };
    }
    if (Core.isTerminalState(d.state)) return { ok:true, delivery:d, terminal:true };
    await Store.renewLease({ delivery_id:d.delivery_id, actor_id:message.actor_id, fence:message.fence, boot_id:BOOT_ID }); d = await Store.getDelivery(d.delivery_id);

    if (Core.POST_SEND_AMBIGUITY_STATES.has(d.state)) {
      const receipt = await W1.findOwnedUserReceipt({ delivery:d, baseline:d.baseline, snapshot });
      if (receipt.ok) {
        d = await Store.markDelivered({ delivery_id:d.delivery_id, actor_id:message.actor_id, fence:message.fence, receipt:receipt.turn, boot_id:BOOT_ID });
        await fire("after_user_receipt", d.delivery_id, message.actor_id);
      } else {
        if (d.state === "SUBMITTING" && !d.send_consumed_at) return { ok:true, delivery:d, terminal:false, resume_action:"RESUME_SEND_CAPABILITY" };
        const elapsed = Date.now() - Math.max(0, Number(d.send_consumed_at) || 0);
        if (options.startup || (d.send_consumed_at && elapsed >= RECEIPT_WINDOW_MS) || newUserTurns(d, snapshot).length) {
          d = await Store.markDeliveryUnknown({ delivery_id:d.delivery_id, actor_id:message.actor_id, fence:message.fence, reason: options.startup?"RESTART_POST_SEND_AMBIGUOUS":"DELIVERY_RECEIPT_UNRESOLVED", boot_id:BOOT_ID, evidence:{receipt_code:receipt.code||"",elapsed_ms:elapsed} });
          return { ok:true, delivery:d, terminal:true, ambiguity:true };
        }
        return { ok:true, delivery:d, terminal:false, waiting_for:"user_receipt" };
      }
    }

    if (["DELIVERED","RESPONSE_STARTED"