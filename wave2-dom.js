((root, factory) => {
  const api = factory(root.MultiAgentWave1Dom, root.MultiAgentWave1Core, root.MultiAgentWave2Core);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MultiAgentWave2Dom = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (Wave1Dom, Wave1Core, Core) => {
  "use strict";

  function requireRuntime() {
    if (!Wave1Dom || !Wave1Core || !Core) throw new Error("Wave-2 DOM dependencies unavailable");
  }

  function extraVisibleState(documentLike = document) {
    const candidates = Array.from(documentLike.querySelectorAll("[role='alert'], [role='status'], button, [data-testid*='error' i]"));
    for (const el of candidates) {
      const text = Core.normalizeText(el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || "").toLowerCase();
      if (!text) continue;
      if (/rate limit|too many requests|usage limit|try again later/.test(text)) return "rate_limited";
      if (/sign in|log in|authentication required/.test(text)) return "authentication_required";
    }
    return "";
  }

  function snapshot(documentLike = document, locationLike = globalThis.location) {
    requireRuntime();
    const base = Wave1Dom.snapshot(documentLike, locationLike);
    const thinking = Boolean(Wave1Dom.thinkingActive(documentLike));
    const extra = extraVisibleState(documentLike);
    let ui_state = "idle";
    if (thinking) ui_state = "long_thinking";
    else if (base.generating) ui_state = "generation_active";
    else if (extra) ui_state = extra;
    else if (base.error_code === "generation_error") ui_state = "retryable_model_error";
    else if (base.error_code === "connection_error") ui_state = "connection_waiting";
    else if (base.error_code === "auth_required") ui_state = "authentication_required";
    else if (!base.composer_present) ui_state = "unrecognized_ui";
    return { ...base, thinking, ui_state, error_code: extra || base.error_code || "" };
  }

  return Object.freeze({
    routeIdentity: (...args) => Wave1Dom.routeIdentity(...args),
    snapshot,
    baselineFromSnapshot: (...args) => Wave1Dom.baselineFromSnapshot(...args),
    writeComposerExact: (...args) => Wave1Dom.writeComposerExact(...args),
    composerForExactPayload: (...args) => Wave1Dom.composerForExactPayload(...args),
    sendPath: (...args) => Wave1Dom.sendPath(...args),
    invokeAuthorizedSend: (...args) => Wave1Dom.invokeAuthorizedSend(...args),
    currentCandidate: (...args) => Wave1Dom.currentCandidate(...args)
  });
});
