((root, factory) => {
  const api = factory(root.MultiAgentWave1Dom, root.MultiAgentWave2Core);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MultiAgentWave2Dom = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (Wave1Dom, Core) => {
  "use strict";
  function requireRuntime(){if(!Wave1Dom||!Core)throw new Error("Wave-2 DOM adapter dependencies unavailable");}
  function snapshot(documentLike=document, locationLike=globalThis.location){requireRuntime();const s=Wave1Dom.snapshot(documentLike,locationLike);return {...s,thinking:Boolean(s.generating&&Wave1Dom.thinkingActive(documentLike)),ui_state:Core.normalizeUiState(s)};}
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
