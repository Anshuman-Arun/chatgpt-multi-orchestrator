(() => {
  "use strict";

  if (globalThis.__MULTIAGENT_WAVE1_CONTENT__) return;
  globalThis.__MULTIAGENT_WAVE1_CONTENT__ = true;

  const Config = globalThis.YOLOConfig;
  const Shared = globalThis.YOLOShared;
  const Core = globalThis.MultiAgentWave1Core;
  const Dom = globalThis.MultiAgentWave1Dom;
  if (!Config || !Shared || !Core || !Dom || !globalThis.chrome?.runtime) return;

  const actorId = globalThis.crypto?.randomUUID ? `wave1_actor_${globalThis.crypto.randomUUID()}` : `wave1_actor_${Date.now().toString(36)}`;
  let active = null;
  let reconcileTimer = null;
  let pollTimer = null;
  let panel = null;
  let els = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function runtimeSend(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) resolve({ ok: false, code: "wave1.runtime_unavailable", reason: chrome.runtime.lastError.message });
        else resolve(response || { ok: false, code: "wave1.empty_response", reason: "No response from Wave-1 controller" });
      });
    });
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (value) => resolve(chrome.runtime.lastError ? {} : value || {}));
    });
  }

  async function legacyAutomationEnabled(pageId) {
    const pageKey = Config.pageSettingsKey(pageId);
    const stored = await storageGet([Config.STORAGE_KEYS.global, Config.STORAGE_KEYS.pages, pageKey]);
    const settings = Config.mergeSettings(
      Config.DEFAULT_SETTINGS,
      stored[Config.STORAGE_KEYS.global] || {},
      stored[pageKey] || stored[Config.STORAGE_KEYS.pages]?.[pageId] || {}
    );
    return Boolean(settings.enabled);
  }

  function compactError(response) {
    return String(response?.reason || response?.code || "Wave-1 operation failed").slice(0, 500);
  }

  function setStatus(message, level = "info") {
    if (!els) return;
    els.status.textContent = String(message || "");
    els.status.dataset.level = level;
  }

  function stateSummary(delivery, extra = "") {
    if (!delivery) return extra || "No Wave-1 Delivery for this conversation.";
    const lines = [
      `state: ${delivery.state}`,
      `delivery: ${delivery.delivery_id}`,
      `conversation: ${delivery.conversation_id}`,
      `task: ${delivery.task_id}`,
      `seq: ${delivery.conversation_seq}`
    ];
    if (delivery.terminal_error) lines.push(`terminal protocol: ${delivery.terminal_error}`);
    if (extra) lines.push(extra);
    return lines.join("\n");
  }

  async function refreshStatus() {
    const response = await runtimeSend({ type: "WAVE1_STATUS" });
    if (!response.ok) {
      setStatus(compactError(response), "error");
      return response;
    }
    setStatus(response.binding
      ? stateSummary(response.delivery, response.delivery?.state === "ACKED" ? "Wave-1 DONE result durably ACKED." : "Conversation is bound.")
      : "Not bound. Pause normal YOLO automation, then bind this saved conversation.", response.delivery?.state === "ACKED" ? "success" : "info");
    return response;
  }

  async function bindCurrentConversation() {
    const route = Dom.routeIdentity();
    if (!Config.isDurablePageId(route)) {
      setStatus("Open an already-saved ChatGPT conversation whose URL ends in /c/<id>.", "error");
      return null;
    }
    if (await legacyAutomationEnabled(route)) {
      setStatus("Pause normal YOLO automation for this conversation before binding the isolated Wave-1 lane.", "error");
      return null;
    }
    const response = await runtimeSend({ type: "WAVE1_BIND", provider_locator: route, actor_id: actorId });
    if (!response.ok) {
      setStatus(compactError(response), "error");
      return null;
    }
    setStatus(`Bound ${response.binding.conversation_id}\nprovider route fingerprint: ${Core.fingerprint(route)}`, "success");
    return response.binding;
  }

  async function failPreSend(deliveryId, fence, reason, evidence = {}) {
    const response = await runtimeSend({
      type: "WAVE1_FAIL_PRE_SEND",
      delivery_id: deliveryId,
      actor_id: actorId,
      fence,
      reason,
      evidence
    });
    if (response.ok) setStatus(stateSummary(response.delivery, `Stopped pre-send: ${reason}`), "error");
    return response;
  }

  async function markUnknown(deliveryId, fence, reason, evidence = {}) {
    const response = await runtimeSend({
      type: "WAVE1_MARK_DELIVERY_UNKNOWN",
      delivery_id: deliveryId,
      actor_id: actorId,
      fence,
      reason,
      evidence
    });
    active = null;
    stopPolling();
    setStatus(response.ok ? stateSummary(response.delivery, "Ambiguous send stopped safely; no automatic resend will occur.") : `Send is ambiguous and could not be journaled immediately: ${compactError(response)}`, "error");
    return response;
  }

  function stopPolling() {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function scheduleReconcile(delay = 150) {
    if (!active || reconcileTimer) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      reconcileNow().catch((error) => setStatus(`Reconciliation error: ${error.message}`, "error"));
    }, Math.max(0, Number(delay) || 0));
  }

  async function reconcileNow() {
    if (!active) return;
    const snapshot = Dom.snapshot();
    const response = await runtimeSend({
      type: "WAVE1_RECONCILE",
      delivery_id: active.delivery_id,
      actor_id: actorId,
      fence: active.fence,
      snapshot
    });
    if (!response.ok) {
      setStatus(`Reconciliation paused: ${compactError(response)}`, "error");
      return;
    }
    const delivery = response.delivery;
    setStatus(stateSummary(delivery, response.waiting_for ? `waiting for: ${response.waiting_for}` : ""), delivery?.state === "ACKED" ? "success" : "info");
    if (response.terminal || ["ACKED", "FAILED", "DELIVERY_UNKNOWN", "RESPONSE_FAILED", "RESPONSE_SUPERSEDED"].includes(delivery?.state)) {
      active = null;
      stopPolling();
      if (delivery?.state === "ACKED") setStatus(stateSummary(delivery, "Wave-1 DONE result durably captured. Use Journal to reconstruct the transaction."), "success");
      else if (delivery?.state === "RESPONSE_RECEIVED") setStatus(stateSummary(delivery, `Turn complete, but task is NOT terminal (${response.protocol_error || delivery.terminal_error || "invalid terminal block"}).`), "error");
      return;
    }
    scheduleReconcile(500);
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (active) scheduleReconcile(0);
    }, 750);
  }

  async function executeDelivery(deliveryId) {
    const claim = await runtimeSend({ type: "WAVE1_CLAIM", delivery_id: deliveryId, actor_id: actorId });
    if (!claim.ok) throw new Error(compactError(claim));
    const delivery = claim.delivery;
    const fence = claim.lease.fence;
    active = { delivery_id: delivery.delivery_id, fence };
    setStatus(stateSummary(delivery, `lease fence: ${fence}`));

    let snapshot = Dom.snapshot();
    const begin = await runtimeSend({
      type: "WAVE1_BEGIN_COMPOSER_FILL",
      delivery_id: delivery.delivery_id,
      actor_id: actorId,
      fence,
      snapshot
    });
    if (!begin.ok) {
      await failPreSend(delivery.delivery_id, fence, begin.code || "BASELINE_REJECTED", { detail: Core.fingerprint(begin.reason || "") });
      active = null;
      return false;
    }

    const wrote = Dom.writeComposerExact(delivery.payload);
    if (!wrote.ok) {
      await failPreSend(delivery.delivery_id, fence, wrote.code || "COMPOSER_WRITE_FAILED");
      active = null;
      return false;
    }
    await sleep(150);
    snapshot = Dom.snapshot();
    const filled = await runtimeSend({
      type: "WAVE1_COMPOSER_FILLED",
      delivery_id: delivery.delivery_id,
      actor_id: actorId,
      fence,
      snapshot
    });
    if (!filled.ok) {
      await failPreSend(delivery.delivery_id, fence, filled.code || "COMPOSER_READBACK_FAILED", { detail: Core.fingerprint(filled.reason || "") });
      active = null;
      return false;
    }

    const exact = Dom.composerForExactPayload(delivery.payload);
    const path = exact.ok ? Dom.sendPath(exact.adapter, exact.composer) : null;
    if (!exact.ok || !path) {
      await failPreSend(delivery.delivery_id, fence, exact.code || "SEND_PATH_MISSING");
      active = null;
      return false;
    }

    const authorized = await runtimeSend({ type: "WAVE1_AUTHORIZE_SEND", delivery_id: delivery.delivery_id, actor_id: actorId, fence });
    if (!authorized.ok) {
      // A lost response may hide a committed COMPOSER_FILLED -> SUBMITTING transition.
      // Read durable state before deciding whether this is still safely pre-send.
      const durable = await runtimeSend({ type: "WAVE1_STATUS" });
      if (durable?.delivery?.delivery_id === delivery.delivery_id && durable.delivery.state === "COMPOSER_FILLED") {
        await failPreSend(delivery.delivery_id, fence, authorized.code || "SUBMITTING_AUTHORIZATION_FAILED");
      } else if (durable?.delivery?.delivery_id === delivery.delivery_id && durable.delivery.state === "SUBMITTING") {
        await markUnknown(delivery.delivery_id, fence, "SUBMITTING_AUTHORIZATION_ACK_UNKNOWN", { response_code: authorized.code || "" });
      } else {
        setStatus(`Send authorization outcome is uncertain: ${compactError(authorized)}. No Send will be attempted.`, "error");
        active = null;
        stopPolling();
      }
      return false;
    }

    const consumed = await runtimeSend({
      type: "WAVE1_CONSUME_SEND",
      delivery_id: delivery.delivery_id,
      actor_id: actorId,
      fence,
      authorization_id: authorized.authorization_id
    });
    if (!consumed.ok) {
      // Consumption itself is persisted before the side effect. A lost response therefore
      // makes the boundary ambiguous even though this actor will not invoke Send.
      await markUnknown(delivery.delivery_id, fence, "SEND_CAPABILITY_CONSUME_ACK_UNKNOWN", { response_code: consumed.code || "" });
      return false;
    }

    const invoked = Dom.invokeAuthorizedSend(consumed.permit, {
      delivery_id: delivery.delivery_id,
      authorization_id: authorized.authorization_id,
      lease_fence: fence,
      payload: delivery.payload
    });
    if (!invoked.ok) {
      await markUnknown(delivery.delivery_id, fence, invoked.code || "SEND_ACTUATOR_FAILED");
      return false;
    }

    const marked = await runtimeSend({
      type: "WAVE1_MARK_SENT_UNCONFIRMED",
      delivery_id: delivery.delivery_id,
      actor_id: actorId,
      fence,
      send_path: invoked.send_path
    });
    if (!marked.ok) {
      // The DOM side effect already happened. Do not invoke Send again; reconcile durable SUBMITTING state instead.
      setStatus(`Send was invoked but SENT_UNCONFIRMED could not be persisted immediately: ${compactError(marked)}. Reconciling without resend.`, "error");
    } else {
      setStatus(stateSummary(marked.delivery, `send path: ${invoked.send_path}`));
    }
    startPolling();
    scheduleReconcile(100);
    return true;
  }

  async function createAndRun() {
    if (active) {
      setStatus("A Wave-1 Delivery is already active in this tab.", "error");
      return;
    }
    const route = Dom.routeIdentity();
    if (await legacyAutomationEnabled(route)) {
      setStatus("Pause normal YOLO automation for this conversation before launching the Wave-1 slice.", "error");
      return;
    }
    const status = await runtimeSend({ type: "WAVE1_STATUS" });
    if (!status.ok || !status.binding) {
      setStatus("Bind this conversation first.", "error");
      return;
    }
    const instruction = String(els.instruction.value || "").trim();
    if (!instruction) {
      setStatus("Enter a worker task instruction.", "error");
      return;
    }
    const created = await runtimeSend({
      type: "WAVE1_CREATE_DELIVERY",
      conversation_id: status.binding.conversation_id,
      instruction
    });
    if (!created.ok) {
      setStatus(compactError(created), "error");
      return;
    }
    try {
      await executeDelivery(created.delivery.delivery_id);
    } catch (error) {
      if (active) {
        const current = await runtimeSend({ type: "WAVE1_STATUS" });
        const state = current?.delivery?.state;
        if (["SUBMITTING", "SENT_UNCONFIRMED"].includes(state)) {
          await markUnknown(created.delivery.delivery_id, active.fence, "UNHANDLED_POST_SEND_EXCEPTION", { error_fingerprint: Core.fingerprint(error.message) });
          return;
        }
        await failPreSend(created.delivery.delivery_id, active.fence, "UNHANDLED_PRE_SEND_EXCEPTION", { error_fingerprint: Core.fingerprint(error.message) });
      }
      active = null;
      stopPolling();
      setStatus(`Wave-1 stopped: ${error.message}`, "error");
    }
  }

  async function showJournal() {
    const status = await runtimeSend({ type: "WAVE1_STATUS" });
    if (!status.ok || !status.delivery) {
      setStatus("No Wave-1 Delivery exists for this conversation.", "error");
      return;
    }
    const response = await runtimeSend({ type: "WAVE1_JOURNAL", delivery_id: status.delivery.delivery_id });
    if (!response.ok) {
      setStatus(compactError(response), "error");
      return;
    }
    const r = response.reconstruction;
    setStatus([
      `journal: ${r.ok ? "reconstructable" : r.code}`,
      `events: ${response.events.length}`,
      `states: ${(r.states || []).join(" -> ")}`,
      `current: ${r.current_state || "n/a"}`
    ].join("\n"), r.ok ? "success" : "error");
  }

  function installPanel() {
    const host = document.createElement("div");
    host.id = "multiagent-wave1-host";
    host.style.position = "fixed";
    host.style.right = "16px";
    host.style.bottom = "16px";
    host.style.zIndex = "2147483646";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      details { width: 340px; font: 12px/1.4 system-ui, sans-serif; color: #e7e7e7; background: #171717; border: 1px solid #454545; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.35); }
      summary { cursor: pointer; padding: 10px 12px; font-weight: 700; user-select: none; }
      .body { padding: 0 12px 12px; display: grid; gap: 8px; }
      textarea { width: 100%; box-sizing: border-box; min-height: 88px; resize: vertical; border-radius: 7px; border: 1px solid #555; background: #222; color: inherit; padding: 8px; font: inherit; }
      .actions { display: flex; gap: 6px; flex-wrap: wrap; }
      button { border: 1px solid #666; border-radius: 7px; padding: 6px 9px; background: #2d2d2d; color: inherit; cursor: pointer; font: inherit; }
      button:hover { background: #3a3a3a; }
      pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow: auto; border-radius: 7px; background: #0f0f0f; padding: 8px; color: #ccc; }
      pre[data-level='error'] { color: #ff9c9c; }
      pre[data-level='success'] { color: #9ee6ad; }
      .note { color: #aaa; }
    `;
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "MultiAgent - Wave 1";
    const body = document.createElement("div");
    body.className = "body";
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "Developer smoke control. Normal YOLO automation must be paused.";
    const instruction = document.createElement("textarea");
    instruction.value = "Reply briefly that the Wave-1 vertical slice reached you, then emit the required terminal DONE block exactly as instructed.";
    instruction.setAttribute("aria-label", "Wave-1 worker task instruction");
    const actions = document.createElement("div");
    actions.className = "actions";
    const bind = document.createElement("button");
    bind.type = "button";
    bind.textContent = "Bind conversation";
    const run = document.createElement("button");
    run.type = "button";
    run.textContent = "Run one Delivery";
    const journal = document.createElement("button");
    journal.type = "button";
    journal.textContent = "Journal";
    const status = document.createElement("pre");
    status.setAttribute("role", "status");
    actions.append(bind, run, journal);
    body.append(note, instruction, actions, status);
    details.append(summary, body);
    shadow.append(style, details);
    (document.body || document.documentElement).append(host);
    panel = host;
    els = { details, instruction, bind, run, journal, status };
    bind.addEventListener("click", () => bindCurrentConversation().catch((error) => setStatus(error.message, "error")));
    run.addEventListener("click", () => createAndRun().catch((error) => setStatus(error.message, "error")));
    journal.addEventListener("click", () => showJournal().catch((error) => setStatus(error.message, "error")));
    refreshStatus().catch((error) => setStatus(error.message, "error"));
  }

  // Mutation callbacks are wake signals only. Durable state transitions happen
  // exclusively inside the background reconciler after it receives a snapshot.
  const observer = new MutationObserver(() => {
    if (active) scheduleReconcile(150);
  });

  function start() {
    if (!document.body && !document.documentElement) return;
    installPanel();
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  window.addEventListener("pagehide", () => {
    stopPolling();
    observer.disconnect();
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
