((root, factory) => {
  const Store = typeof module === "object" && module.exports ? (()=>{ try { return require("./wave2-store.js"); } catch { return null; } })() : root.MultiAgentWave2Store;
  const api = factory(Store);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MultiAgentWave2Faults = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (Store) => {
  "use strict";
  const POINTS = Object.freeze([
    "after_delivery_persist", "after_composer_write", "after_submitting_commit", "after_send_invocation",
    "after_user_receipt", "after_response_detected", "after_result_persist", "service_worker_restart",
    "tab_reload_during_generation", "duplicate_observer_callbacks", "drop_observer_callbacks",
    "connection_interruption", "retry_error_state"
  ]);
  class InjectedFault extends Error {
    constructor(point, action="CRASH") { super(`Injected Wave-2 fault at ${point}`); this.name="InjectedFault"; this.code="wave2.injected_fault"; this.point=point; this.action=action; }
  }
  async function maybeFire({point,delivery_id="",actor_id="",boot_id=""}) {
    if (!POINTS.includes(point) || !Store?.consumeFaultPlan) return null;
    const fault = await Store.consumeFaultPlan({point,delivery_id,actor_id,boot_id});
    if (!fault) return null;
    if (fault.action === "CRASH") throw new InjectedFault(point, fault.action);
    return fault;
  }
  return Object.freeze({POINTS, InjectedFault, maybeFire});
});
