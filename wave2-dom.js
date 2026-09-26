((root, factory) => {
  const api = factory(root.MultiAgentWave1Dom, root.MultiAgentWave2Core);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MultiAgentWave2Dom = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (Wave1Dom, Core) => {
  "use strict";
  function requireRuntime(){if(!Wave1Dom||!Core)throw new Error("Wave-2 DOM adapter dependencies unavailable");}
  function extraVisibleState(documentLike=document){
    const nodes=Array.from(documentLike.querySelectorAll("[role='alert'], [role='status'], [data-testid*='error' i], button"));
    for(const el of nodes){
      const text=Core.normalizeText(el?.innerText||el?.textContent||el?.getAttribute?.("aria-label")||"").toLowerCase();
      if(!text)continue;
      if(/rate limit|too many requests|usage limit|try again later/.test(text))return "rate_limited";
      if(/sign in|log in|authentication required|verify you are human/.test(text))return "auth_required";
    }
    return "";
  }
  function snapshot(documentLike=document, locationLike=globalThis.location){
    requireRuntime();const base=Wave1Dom.snapshot(documentLike,locationLike);const error=extraVisibleState(documentLike)||base.error_code||"";
    const out={...base,error_code:error,thinking:Boolean(base.generating&&Wave1Dom.thinkingActive(documentLike))};
    return {...out,ui_state:Core.normalizeUiState(out)};
  }
  return Object.freeze({
    snapshot,
    routeIdentity:(...a)=>{requireRuntime();return Wave1Dom.routeIdentity(...a);},
    rawComposerText:(...a)=>Wave1Dom.rawComposerText(...a),
    writeComposerExact:(...a)=>Wave1Dom.writeComposerExact(...a),
    composerForExactPayload:(...a)=>Wave1Dom.composerForExactPayload(...a),
    sendPath:(...a)=>Wave1Dom.sendPath(...a),
    invokeAuthorizedSend:(...a)=>Wave1Dom.invokeAuthorizedSend(...a)
  });
});
