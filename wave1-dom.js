((root, factory) => {
  const api = factory(root.YOLOConfig, root.YOLOPlatforms, root.MultiAgentWave1Core);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MultiAgentWave1Dom = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (Config, Platforms, Core) => {
  "use strict";

  const nodeTokens = new WeakMap();
  let nextNodeToken = 1;

  function requireRuntime() {
    if (!Config || !Platforms || !Core) throw new Error("Wave-1 DOM adapter dependencies are unavailable");
  }

  function routeIdentity(locationLike = globalThis.location) {
    requireRuntime();
    return Config.pageId(locationLike?.href || String(locationLike || ""));
  }

  function nodeToken(node) {
    if (!node || (typeof node !== "object" && typeof node !== "function")) return "";
    if (!nodeTokens.has(node)) nodeTokens.set(node, `n${nextNodeToken++}`);
    return nodeTokens.get(node);
  }

  function messageRoot(element) {
    return element?.closest?.("[data-message-id], article[data-testid^='conversation-turn'], article") || element || null;
  }

  function explicitMessageIdentity(element) {
    const root = messageRoot(element);
    const messageId = String(element?.getAttribute?.("data-message-id") || root?.getAttribute?.("data-message-id") || "").trim();
    if (messageId) return { identity_key: `msg:${messageId}`, identity_kind: "message_id" };
    const testId = String(root?.getAttribute?.("data-testid") || "").trim();
    if (/^conversation-turn-/i.test(testId)) return { identity_key: `turn:${testId}`, identity_kind: "turn_id" };
    const id = String(root?.id || "").trim();
    if (id && /message|conversation|turn/i.test(id)) return { identity_key: `id:${id}`, identity_kind: "element_id" };
    return null;
  }

  function turnDescriptor(element, order) {
    const role = String(element?.getAttribute?.("data-message-author-role") || "").toLowerCase();
    const text = String(element?.innerText || element?.textContent || "")
      .replace(/\r\n?/g, "\n")
      .trim();
    const root = messageRoot(element);
    const explicit = explicitMessageIdentity(element);
    const dom = nodeToken(root);
    const textFingerprint = Core.fingerprint(text);
    const identity = explicit || (dom
      ? {
          identity_key: role === "user" ? `dom-user:${dom}:${textFingerprint}` : `dom:${dom}`,
          identity_kind: "dom"
        }
      : { identity_key: `fp:${textFingerprint}:${order}`, identity_kind: "fingerprint" });
    return {
      role,
      identity_key: identity.identity_key,
      identity_kind: identity.identity_kind,
      fingerprint: textFingerprint,
      text,
      order: Number(order) || 0
    };
  }

  function classifyError(adapter, documentLike = document) {
    const turnNodes = Array.from(documentLike.querySelectorAll("[data-message-author-role='user'], [data-message-author-role='assistant']"));
    const latestTurnRoot = messageRoot(turnNodes.at(-1));
    const explicit = Platforms.findErrorState(adapter, documentLike);
    const candidates = [];
    if (explicit) candidates.push(explicit);
    for (const element of documentLike.querySelectorAll("[role='alert'], [data-testid*='error' i], button")) candidates.push(element);
    for (const element of Array.from(new Set(candidates))) {
      if (Platforms.visible && !Platforms.visible(element)) continue;
      const turnNode = element.closest?.("[data-message-author-role='user'], [data-message-author-role='assistant'], article[data-testid^='conversation-turn'], article");
      const containingTurn = turnNode ? messageRoot(turnNode) : null;
      if (containingTurn && containingTurn !== latestTurnRoot) continue;
      const text = Core.normalizeText(element?.innerText || element?.textContent || element?.getAttribute?.("aria-label") || "").toLowerCase();
      if (!text) continue;
      if (/\b(sign in|log in|login|authentication required)\b/i.test(text)) return "auth_required";
      if (/\b(reconnect|connection|network error|offline|disconnected)\b/i.test(text)) return "connection_error";
      if (/\b(retry|try again|something went wrong|failed|error)\b/i.test(text)) return "generation_error";
    }
    return "";
  }

  function sendPath(adapter, composer, documentLike = document) {
    if (!adapter || !composer) return null;
    const button = Platforms.findSendButton(adapter, composer, documentLike);
    if (button) return { kind: "button", element: button };
    const form = composer.closest?.("form");
    if (typeof form?.requestSubmit === "function") return { kind: "form", element: form };
    return null;
  }

  function thinkingActive(documentLike = document) {
    const assistantNodes = Array.from(documentLike.querySelectorAll("[data-message-author-role='assistant']"));
    const latestAssistantRoot = messageRoot(assistantNodes.at(-1));
    const candidates = documentLike.querySelectorAll(
      "[data-testid*='thinking' i], [data-testid*='reasoning' i], [aria-label*='thinking' i], [aria-label*='reasoning' i]"
    );
    return Array.from(candidates).some((element) => {
      if (Platforms.visible && !Platforms.visible(element)) return false;
      if (element.closest?.("form")) return false;
      const role = String(element.getAttribute?.("role") || "").toLowerCase();
      const ariaLive = String(element.getAttribute?.("aria-live") || "").toLowerCase();
      return Boolean(
        latestAssistantRoot?.contains?.(element)
        || role === "status"
        || role === "progressbar"
        || ariaLive === "polite"
        || ariaLive === "assertive"
      );
    });
  }

  function snapshot(documentLike = document, locationLike = globalThis.location) {
    requireRuntime();
    const adapter = Platforms.adapterForLocation(locationLike);
    const composer = Platforms.findComposer(adapter, documentLike);
    const nodes = Array.from(documentLike.querySelectorAll("[data-message-author-role='user'], [data-message-author-role='assistant']"));
    const seen = new Set();
    const turns = [];
    for (const node of nodes) {
      const root = messageRoot(node);
      if (!root || seen.has(root)) continue;
      seen.add(root);
      const descriptor = turnDescriptor(node, turns.length);
      if (descriptor.role === "user" || descriptor.role === "assistant") turns.push(descriptor);
    }
    return {
      route_identity: routeIdentity(locationLike),
      composer_present: Boolean(composer),
      composer_text: composer ? Platforms.composerText(composer) : "",
      generating: Boolean(Platforms.isGenerating(adapter, documentLike) || thinkingActive(documentLike)),
      error_code: classifyError(adapter, documentLike),
      idle_send_path: Boolean(composer && sendPath(adapter, composer, documentLike)),
      turns,
      observed_at: Date.now()
    };
  }

  function baselineFromSnapshot(value) {
    return {
      route_identity: String(value?.route_identity || ""),
      user_keys: (Array.isArray(value?.turns) ? value.turns : []).filter((turn) => turn.role === "user").map((turn) => turn.identity_key),
      assistant_keys: (Array.isArray(value?.turns) ? value.turns : []).filter((turn) => turn.role === "assistant").map((turn) => turn.identity_key)
    };
  }

  function currentCandidate(snapshotValue, identityKey) {
    return (Array.isArray(snapshotValue?.turns) ? snapshotValue.turns : []).find((turn) => (
      turn.role === "assistant" && String(turn.identity_key || "") === String(identityKey || "")
    )) || null;
  }

  function composerForExactPayload(expectedPayload, documentLike = document, locationLike = globalThis.location) {
    requireRuntime();
    const adapter = Platforms.adapterForLocation(locationLike);
    const composer = Platforms.findComposer(adapter, documentLike);
    if (!composer) return { ok: false, code: "composer.missing", composer: null, adapter };
    const actual = Core.normalizeText(Platforms.composerText(composer));
    const expected = Core.normalizeText(expectedPayload);
    if (actual !== expected) return { ok: false, code: "composer.readback_mismatch", composer, adapter, actual };
    return { ok: true, composer, adapter, actual };
  }

  function writeComposerExact(payload, documentLike = document, locationLike = globalThis.location) {
    requireRuntime();
    const adapter = Platforms.adapterForLocation(locationLike);
    const composer = Platforms.findComposer(adapter, documentLike);
    if (!composer) return { ok: false, code: "composer.missing" };
    if (Core.normalizeText(Platforms.composerText(composer))) return { ok: false, code: "composer.busy" };
    Platforms.setComposerValue(composer, payload);
    return { ok: true };
  }

  // This is the only Wave-1 DOM function that can invoke ChatGPT Send.
  // Its permit can only be returned after the IndexedDB store atomically consumes
  // a persisted SUBMITTING authorization under the current lease fence.
  function invokeAuthorizedSend(permit, expected, documentLike = document, locationLike = globalThis.location) {
    requireRuntime();
    if (!permit || permit.kind !== "wave1-durable-submitting") return { ok: false, code: "send.permit_missing" };
    if (String(permit.delivery_id || "") !== String(expected?.delivery_id || "")
      || String(permit.authorization_id || "") !== String(expected?.authorization_id || "")
      || Number(permit.lease_fence) !== Number(expected?.lease_fence)) {
      return { ok: false, code: "send.permit_mismatch" };
    }
    if (!Number.isFinite(Number(permit.lease_expires_at)) || Number(permit.lease_expires_at) <= Date.now()) {
      return { ok: false, code: "send.lease_expired" };
    }
    if (routeIdentity(locationLike) !== String(permit.provider_locator || "")) return { ok: false, code: "send.route_mismatch" };
    const exact = composerForExactPayload(expected?.payload, documentLike, locationLike);
    if (!exact.ok) return exact;
    if (Platforms.isGenerating(exact.adapter, documentLike) || thinkingActive(documentLike)) {
      return { ok: false, code: "send.ui_not_idle" };
    }
    const errorCode = classifyError(exact.adapter, documentLike);
    if (errorCode) return { ok: false, code: `send.ui_error:${errorCode}` };
    const path = sendPath(exact.adapter, exact.composer, documentLike);
    if (!path) return { ok: false, code: "send.path_missing" };
    if (!Platforms.submitComposer(exact.adapter, exact.composer, documentLike)) {
      return { ok: false, code: "send.invoke_failed" };
    }
    return { ok: true, send_path: path.kind };
  }

  return Object.freeze({
    routeIdentity,
    snapshot,
    baselineFromSnapshot,
    currentCandidate,
    classifyError,
    thinkingActive,
    sendPath,
    writeComposerExact,
    composerForExactPayload,
    invokeAuthorizedSend
  });
});
