(() => {
  "use strict";

  const Config = globalThis.YOLOConfig;
  const Core = globalThis.MultiAgentWave1Core;
  const Store = globalThis.MultiAgentWave1Store;
  if (!Config || !Core || !Store || !globalThis.chrome?.runtime?.onMessage) return;

  const BOOT_ID = globalThis.crypto?.randomUUID ? `boot_${globalThis.crypto.randomUUID()}` : `boot_${Date.now().toString(36)}`;
  const RECEIPT_WINDOW_MS = 15_000;

  function senderLocator(sender) {
    return Config.pageId(sender?.url || sender?.tab?.url || "");
  }

  function requireDurableLocator(locator) {
    if (!Config.isDurablePageId(locator)) {
      const error = new Error("Wave-1 requires an already-saved ChatGPT conversation (/c/...)");
      error.code = "wave1.route_invalid";
      throw error;
    }
    return locator;
  }

  function requireSenderRoute(sender, expected) {
    const actual = requireDurableLocator(senderLocator(sender));
    if (String(actual) !== String(expected || "")) {
      const error = new Error("The active content-script route no longer matches the bound Wave-1 conversation");
      error.code = "wave1.route_mismatch";
      throw error;
    }
    return actual;
  }

  function newUserTurns(delivery, snapshot) {
    const baselineUsers = Array.isArray(delivery?.baseline?.user_keys) ? delivery.baseline.user_keys : [];
    const baselineAssistants = Array.isArray(delivery?.baseline?.assistant_keys) ? delivery.baseline.assistant_keys : [];
    const baseline = new Set(baselineUsers);
    const tailKey = String(delivery?.baseline?.tail_key || "");
    if (!tailKey && baselineUsers.length === 0 && baselineAssistants.length === 0) {
      return (Array.isArray(snapshot?.turns) ? snapshot.turns : [])
        .filter((turn) => turn?.role === "user");
    }
    return Core.turnsAfterAnchor(
      snapshot,
      tailKey,
      "user",
      delivery?.baseline?.tail_fingerprint
    ).filter((turn) => !baseline.has(String(turn.identity_key || "")));
  }

  async function bindingForSender(sender) {
    const locator = requireDurableLocator(senderLocator(sender));
    return { locator, binding: await Store.getBindingByLocator(locator) };
  }

  async function handleBind(message, sender) {
    const locator = requireDurableLocator(Config.pageId(message.provider_locator || senderLocator(sender)));
    requireSenderRoute(sender, locator);
    const result = await Store.bindConversation({ provider_locator: locator, actor_id: message.actor_id, boot_id: BOOT_ID });
    return { ok: true, ...result, boot_id: BOOT_ID };
  }

  async function handleStatus(_message, sender) {
    const locator = requireDurableLocator(senderLocator(sender));
    const status = await Store.getStatusByLocator(locator);
    return { ok: true, ...status, boot_id: BOOT_ID };
  }

  async function handleCreate(message, sender) {
    const { locator, binding } = await bindingForSender(sender);
    if (!binding || binding.conversation_id !== message.conversation_id) throw new Error("Bind this conversation before creating a Wave-1 Delivery");
    requireSenderRoute(sender, locator);
    const instruction = String(message.instruction || "").trim();
    if (!instruction) throw new Error("Wave-1 task instruction is required");
    const delivery = await Store.createDelivery({ conversation_id: binding.conversation_id, instruction, boot_id: BOOT_ID });
    return { ok: true, delivery };
  }

  async function requireDeliveryRoute(deliveryId, sender) {
    const delivery = await Store.getDelivery(deliveryId);
    if (!delivery) throw new Error("Wave-1 Delivery was not found");
    requireSenderRoute(sender, delivery.provider_locator);
    return delivery;
  }

  async function handleClaim(message, sender) {
    await requireDeliveryRoute(message.delivery_id, sender);
    const result = await Store.claimDelivery({ delivery_id: message.delivery_id, actor_id: message.actor_id, boot_id: BOOT_ID });
    return { ok: true, ...result };
  }

  async function handleBeginFill(message, sender) {
    const delivery = await requireDeliveryRoute(message.delivery_id, sender);
    const snapshot = message.snapshot || {};
    if (snapshot.route_identity !== delivery.provider_locator) throw new Error("Wave-1 baseline route mismatch");
    if (!snapshot.composer_present) throw new Error("ChatGPT composer is unavailable");
    if (Core.normalizeText(snapshot.composer_text)) throw new Error("Composer contains a draft; Wave-1 will not overwrite it");
    if (snapshot.generating) throw new Error("ChatGPT is already generating; Wave-1 send is blocked");
    if (snapshot.error_code) throw new Error(`ChatGPT UI is not send-safe (${snapshot.error_code})`);
    const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
    const tail = turns.at(-1) || null;
    const baseline = {
      route_identity: snapshot.route_identity,
      user_keys: turns.filter((turn) => turn.role === "user").map((turn) => turn.identity_key),
      assistant_keys: turns.filter((turn) => turn.role === "assistant").map((turn) => turn.identity_key),
      tail_key: String(tail?.identity_key || ""),
      tail_fingerprint: String(tail?.fingerprint || ""),
      tail_text: String(tail?.text || "")
    };
    const next = await Store.beginComposerFilling({
      delivery_id: delivery.delivery_id,
      actor_id: message.actor_id,
      fence: message.fence,
      baseline,
      boot_id: BOOT_ID
    });
    return { ok: true, delivery: next };
  }

  async function handleComposerFilled(message, sender) {
    const delivery = await requireDeliveryRoute(message.delivery_id, sender);
    const snapshot = message.snapshot || {};
    if (snapshot.route_identity !== delivery.provider_locator) throw new Error("Wave-1 route changed while filling composer");
    if (!snapshot.composer_present) throw new Error("ChatGPT composer disappeared while filling");
    if (snapshot.generating || snapshot.error_code) throw new Error("ChatGPT became non-idle while filling composer");
    const exactComposer = Core.canonicalText(snapshot.composer_text);
    if (exactComposer !== Core.canonicalText(delivery.payload)) throw new Error("Wave-1 exact composer readback failed");
    const composerHash = await Core.sha256Hex(exactComposer);
    if (composerHash !== delivery.payload_exact_hash) throw new Error("Wave-1 exact composer SHA-256 does not match the durable payload");
    const baselineCount = (delivery.baseline?.user_keys?.length || 0) + (delivery.baseline?.assistant_keys?.length || 0);
    if (baselineCount > 0 && !Core.resolveTurnAnchor(
      snapshot,
      delivery.baseline?.tail_key,
      delivery.baseline?.tail_fingerprint,
      delivery.baseline?.tail_text
    )) {
      const error = new Error("Wave-1 baseline tail cannot be re-identified before Send authorization");
      error.code = "wave1.baseline_anchor_missing";
      throw error;
    }
    if (newUserTurns(delivery, snapshot).length) throw new Error("A foreign user turn appeared before Wave-1 Send authorization");
    const next = await Store.markComposerFilled({
      delivery_id: delivery.delivery_id,
      actor_id: message.actor_id,
      fence: message.fence,
      composer_hash: composerHash,
      route_fingerprint: Core.fingerprint(snapshot.route_identity),
      boot_id: BOOT_ID
    });
    return { ok: true, delivery: next };
  }

  async function handleFailPreSend(message, sender) {
    const delivery = await Store.getDelivery(message.delivery_id);
    if (!delivery) throw new Error("Wave-1 Delivery was not found");
    requireSenderRoute(sender, delivery.provider_locator);
    const next = await Store.failPreSend({
      delivery_id: delivery.delivery_id,
      actor_id: message.actor_id,
      fence: message.fence,
      reason: message.reason || "PRE_SEND_FAILURE",
      boot_id: BOOT_ID,
      evidence: message.evidence || {}
    });
    return { ok: true, delivery: next };
  }

  async function handleAuthorize(message, sender) {
    const delivery = await requireDeliveryRoute(message.delivery_id, sender);
    const result = await Store.authorizeSend({ delivery_id: delivery.delivery_id, actor_id: message.actor_id, fence: message.fence, boot_id: BOOT_ID });
    return { ok: true, ...result };
  }

  async function handleConsume(message, sender) {
    const delivery = await requireDeliveryRoute(message.delivery_id, sender);
    const result = await Store.consumeSendAuthorization({
      delivery_id: delivery.delivery_id,
      actor_id: message.actor_id,
      fence: message.fence,
      authorization_id: message.authorization_id,
      boot_id: BOOT_ID
    });
    return { ok: true, ...result };
  }

  async function handleSent(message, sender) {
    const delivery = await requireDeliveryRoute(message.delivery_id, sender);
    const next = await Store.markSentUnconfirmed({
      delivery_id: delivery.delivery_id,
      actor_id: message.actor_id,
      fence: message.fence,
      send_path: message.send_path,
      boot_id: BOOT_ID
    });
    return { ok: true, delivery: next };
  }

  async function handleUnknown(message) {
    const next = await Store.markDeliveryUnknown({
      delivery_id: message.delivery_id,
      actor_id: message.actor_id,
      fence: message.fence,
      reason: message.reason || "DELIVERY_RECEIPT_UNRESOLVED",
      boot_id: BOOT_ID,
      evidence: message.evidence || {}
    });
    return { ok: true, delivery: next };
  }

  async function handleResolveSendUncertainty(message) {
    let delivery = await Store.getDelivery(message.delivery_id);
    if (!delivery) throw new Error("Wave-1 Delivery was not found");
    const evidence = message.evidence || {};
    const reason = message.reason || "SEND_BOUNDARY_ACK_UNCERTAIN";

    if (delivery.state === "COMPOSER_FILLED") {
      delivery = await Store.failPreSend({
        delivery_id: delivery.delivery_id,
        actor_id: message.actor_id,
        fence: message.fence,
        reason: `${reason}_BEFORE_SUBMITTING`,
        boot_id: BOOT_ID,
        evidence
      });
      return { ok: true, delivery, terminal: true, ambiguity: false };
    }

    if (["SUBMITTING", "SENT_UNCONFIRMED"].includes(delivery.state)) {
      delivery = await Store.markDeliveryUnknown({
        delivery_id: delivery.delivery_id,
        actor_id: message.actor_id,
        fence: message.fence,
        reason,
        boot_id: BOOT_ID,
        evidence
      });
      return { ok: true, delivery, terminal: true, ambiguity: true };
    }

    if (["FAILED", "DELIVERY_UNKNOWN"].includes(delivery.state)) {
      return { ok: true, delivery, terminal: true, ambiguity: delivery.state === "DELIVERY_UNKNOWN" };
    }

    return {
      ok: false,
      code: "wave1.uncertainty_state_unexpected",
      reason: `Cannot resolve send uncertainty from ${delivery.state}`,
      delivery
    };
  }

  async function reconcile(message, sender) {
    let delivery = await Store.getDelivery(message.delivery_id);
    if (!delivery) throw new Error("Wave-1 Delivery was not found");
    if (message.send_uncertain) {
      return handleResolveSendUncertainty({
        delivery_id: delivery.delivery_id,
        actor_id: message.actor_id,
        fence: message.fence,
        reason: message.send_uncertain.reason || "SEND_BOUNDARY_ACK_UNCERTAIN",
        evidence: message.send_uncertain.evidence || {}
      });
    }
    const snapshot = message.snapshot || {};
    const actualRoute = Config.pageId(snapshot.route_identity || senderLocator(sender));

    if (actualRoute !== delivery.provider_locator) {
      if (["SUBMITTING", "SENT_UNCONFIRMED"].includes(delivery.state)) {
        delivery = await Store.markDeliveryUnknown({
          delivery_id: delivery.delivery_id,
          actor_id: message.actor_id,
          fence: message.fence,
          reason: "ROUTE_MISMATCH_AFTER_SEND_BOUNDARY",
          boot_id: BOOT_ID,
          evidence: { actual_route_fingerprint: Core.fingerprint(actualRoute) }
        });
        return { ok: true, delivery, terminal: true };
      }
      const error = new Error("Wave-1 reconciliation is paused because the conversation route changed");
      error.code = "wave1.route_mismatch";
      throw error;
    }
    requireSenderRoute(sender, delivery.provider_locator);

    if (["ACKED", "FAILED", "DELIVERY_UNKNOWN", "RESPONSE_FAILED", "RESPONSE_SUPERSEDED"].includes(delivery.state)) {
      return { ok: true, delivery, terminal: true };
    }

    await Store.renewLease({ delivery_id: delivery.delivery_id, actor_id: message.actor_id, fence: message.fence, boot_id: BOOT_ID });
    delivery = await Store.getDelivery(delivery.delivery_id);

    if (["SUBMITTING", "SENT_UNCONFIRMED"].includes(delivery.state)) {
      const receipt = await Core.findOwnedUserReceipt({ delivery, baseline: delivery.baseline, snapshot });
      if (receipt.ok) {
        const appendedUsers = newUserTurns(delivery, snapshot);
        const foreignUsers = appendedUsers.filter((turn) => (
          String(turn.identity_key || "") !== String(receipt.turn.identity_key || "")
          && Core.normalizeText(turn.text) !== Core.normalizeText(delivery.payload)
        ));
        delivery = await Store.markDelivered({
          delivery_id: delivery.delivery_id,
          actor_id: message.actor_id,
          fence: message.fence,
          receipt: receipt.turn,
          boot_id: BOOT_ID
        });
        if (foreignUsers.length) {
          delivery = await Store.markResponseSuperseded({
            delivery_id: delivery.delivery_id,
            actor_id: message.actor_id,
            fence: message.fence,
            reason: "FOREIGN_USER_TURN_IN_DELIVERY_WINDOW",
            boot_id: BOOT_ID,
            evidence: {
              foreign_user_turns: foreignUsers.length,
              first_foreign_identity: foreignUsers[0]?.identity_key || ""
            }
          });
          return { ok: true, delivery, terminal: true, task_terminal: false, response_superseded: true };
        }
      } else {
        const foreign = newUserTurns(delivery, snapshot);
        const elapsed = Date.now() - Math.max(0, Number(delivery.send_consumed_at) || 0);
        if (foreign.length || (delivery.send_consumed_at && elapsed >= RECEIPT_WINDOW_MS)) {
          delivery = await Store.markDeliveryUnknown({
            delivery_id: delivery.delivery_id,
            actor_id: message.actor_id,
            fence: message.fence,
            reason: foreign.length ? "FOREIGN_USER_TURN_BEFORE_RECEIPT" : "EXACT_USER_TURN_RECEIPT_TIMEOUT",
            boot_id: BOOT_ID,
            evidence: { receipt_code: receipt.code || "", elapsed_ms: elapsed, foreign_user_turns: foreign.length }
          });
          return { ok: true, delivery, terminal: true };
        }
        return { ok: true, delivery, terminal: false, waiting_for: "user_receipt", receipt_code: receipt.code };
      }
    }

    if (["DELIVERED", "RESPONSE_STARTED"].includes(delivery.state)) {
      const foreignAfterOwned = Core.turnsAfterAnchor(
        snapshot,
        delivery.user_receipt?.identity_key,
        "user",
        delivery.user_receipt?.fingerprint,
        delivery.payload
      );
      if (foreignAfterOwned.length) {
        delivery = await Store.markResponseSuperseded({
          delivery_id: delivery.delivery_id,
          actor_id: message.actor_id,
          fence: message.fence,
          reason: "FOREIGN_USER_TURN_AFTER_OWNED_RECEIPT",
          boot_id: BOOT_ID,
          evidence: {
            foreign_user_turns: foreignAfterOwned.length,
            first_foreign_identity: foreignAfterOwned[0]?.identity_key || ""
          }
        });
        return { ok: true, delivery, terminal: true, task_terminal: false, response_superseded: true };
      }
    }

    if (["DELIVERED", "RESPONSE_STARTED"].includes(delivery.state) && snapshot.error_code) {
      delivery = await Store.markResponseFailed({
        delivery_id: delivery.delivery_id,
        actor_id: message.actor_id,
        fence: message.fence,
        error_code: snapshot.error_code,
        boot_id: BOOT_ID,
        evidence: {
          route_fingerprint: Core.fingerprint(snapshot.route_identity || ""),
          assistant_identity: delivery.assistant_candidate?.identity_key || ""
        }
      });
      return { ok: true, delivery, terminal: true, task_terminal: false, response_error: snapshot.error_code };
    }

    if (delivery.state === "DELIVERED") {
      const candidate = Core.selectAssistantCandidate({
        baseline: delivery.baseline,
        receipt: { turn: delivery.user_receipt },
        snapshot,
        ownedUserText: delivery.payload
      });
      if (!candidate) return { ok: true, delivery, terminal: false, waiting_for: "assistant_candidate" };
      const textHash = await Core.sha256Hex(Core.normalizeText(candidate.text));
      delivery = await Store.markResponseStarted({
        delivery_id: delivery.delivery_id,
        actor_id: message.actor_id,
        fence: message.fence,
        candidate,
        text_hash: textHash,
        boot_id: BOOT_ID
      });
      return { ok: true, delivery, terminal: false, waiting_for: "assistant_completion" };
    }

    if (delivery.state === "RESPONSE_STARTED") {
      const candidate = Core.selectAssistantCandidate({
        baseline: delivery.baseline,
        receipt: { turn: delivery.user_receipt },
        snapshot,
        ownedUserText: delivery.payload,
        currentIdentity: delivery.assistant_candidate?.identity_key,
        currentIdentityKind: delivery.assistant_candidate?.identity_kind
      });
      if (!candidate) return { ok: true, delivery, terminal: false, waiting_for: "assistant_candidate" };
      const textHash = await Core.sha256Hex(Core.normalizeText(candidate.text));
      const identityChanged = String(candidate.identity_key || "") !== String(delivery.assistant_candidate?.identity_key || "");
      if (identityChanged || textHash !== delivery.assistant_text_hash) {
        delivery = await Store.recordAssistantMutation({
          delivery_id: delivery.delivery_id,
          actor_id: message.actor_id,
          fence: message.fence,
          candidate,
          text_hash: textHash,
          boot_id: BOOT_ID
        });
        return { ok: true, delivery, terminal: false, waiting_for: "assistant_quiescence" };
      }
      const completion = Core.turnCompletionEvidence({
        delivered: Boolean(delivery.user_receipt),
        candidate,
        snapshot,
        last_changed_at: delivery.assistant_last_changed_at,
        now: Date.now()
      });
      if (!completion.complete) return { ok: true, delivery, terminal: false, waiting_for: "assistant_completion", completion };
      const responseHash = textHash;
      delivery = await Store.markResponseReceived({
        delivery_id: delivery.delivery_id,
        actor_id: message.actor_id,
        fence: message.fence,
        response_text: candidate.text,
        response_text_hash: responseHash,
        completion_evidence: completion.evidence,
        boot_id: BOOT_ID
      });
      const parsed = Core.parseWorkerTerminal(delivery.response_text, delivery);
      if (!parsed.ok) {
        delivery = await Store.annotateProtocolFailure({
          delivery_id: delivery.delivery_id,
          actor_id: message.actor_id,
          fence: message.fence,
          code: parsed.code,
          boot_id: BOOT_ID
        });
        return { ok: true, delivery, terminal: true, task_terminal: false, protocol_error: parsed.code };
      }
      const captured = await Store.captureDoneAndAck({
        delivery_id: delivery.delivery_id,
        actor_id: message.actor_id,
        fence: message.fence,
        envelope: parsed.envelope,
        boot_id: BOOT_ID
      });
      return { ok: true, ...captured, terminal: true, task_terminal: true };
    }

    if (delivery.state === "RESPONSE_RECEIVED") {
      const parsed = Core.parseWorkerTerminal(delivery.response_text, delivery);
      if (!parsed.ok) {
        delivery = await Store.annotateProtocolFailure({ delivery_id: delivery.delivery_id, actor_id: message.actor_id, fence: message.fence, code: parsed.code, boot_id: BOOT_ID });
        return { ok: true, delivery, terminal: true, task_terminal: false, protocol_error: parsed.code };
      }
      const captured = await Store.captureDoneAndAck({ delivery_id: delivery.delivery_id, actor_id: message.actor_id, fence: message.fence, envelope: parsed.envelope, boot_id: BOOT_ID });
      return { ok: true, ...captured, terminal: true, task_terminal: true };
    }

    return { ok: true, delivery, terminal: false };
  }

  async function handleJournal(message, sender) {
    const delivery = await requireDeliveryRoute(message.delivery_id, sender);
    const events = await Store.getEventsForDelivery(delivery.delivery_id);
    return { ok: true, reconstruction: Core.reconstructDelivery(events, delivery.delivery_id), events };
  }

  async function dispatch(message, sender) {
    switch (message.type) {
      case "WAVE1_BIND": return handleBind(message, sender);
      case "WAVE1_STATUS": return handleStatus(message, sender);
      case "WAVE1_CREATE_DELIVERY": return handleCreate(message, sender);
      case "WAVE1_CLAIM": return handleClaim(message, sender);
      case "WAVE1_BEGIN_COMPOSER_FILL": return handleBeginFill(message, sender);
      case "WAVE1_COMPOSER_FILLED": return handleComposerFilled(message, sender);
      case "WAVE1_FAIL_PRE_SEND": return handleFailPreSend(message, sender);
      case "WAVE1_AUTHORIZE_SEND": return handleAuthorize(message, sender);
      case "WAVE1_CONSUME_SEND": return handleConsume(message, sender);
      case "WAVE1_MARK_SENT_UNCONFIRMED": return handleSent(message, sender);
      case "WAVE1_MARK_DELIVERY_UNKNOWN": return handleUnknown(message, sender);
      case "WAVE1_RESOLVE_SEND_UNCERTAINTY": return handleResolveSendUncertainty(message);
      case "WAVE1_RECONCILE": return reconcile(message, sender);
      case "WAVE1_JOURNAL": return handleJournal(message, sender);
      default: return { ok: false, code: "wave1.message_unknown", reason: "Unknown Wave-1 operation" };
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message?.type?.startsWith("WAVE1_")) return false;
    Promise.resolve(dispatch(message, sender))
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, code: error?.code || "wave1.error", reason: error?.message || String(error) }));
    return true;
  });
})();
