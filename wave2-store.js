((root, factory) => {
  const Db = typeof module === "object" && module.exports ? require("./wave2-db.js") : root.MultiAgentWave2Db;
  const Delivery = typeof module === "object" && module.exports ? require("./wave2-delivery-store.js") : root.MultiAgentWave2DeliveryStore;
  const Results = typeof module === "object" && module.exports ? require("./wave2-result-store.js") : root.MultiAgentWave2ResultStore;
  const api = factory(Db, Delivery, Results);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MultiAgentWave2Store = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (Db, Delivery, Results) => {
  "use strict";
  if(!Db||!Delivery||!Results)throw new Error("Wave-2 store dependencies unavailable");
  return Object.freeze({DB_NAME:Db.DB_NAME,DB_VERSION:Db.DB_VERSION,LEASE_MS:Db.LEASE_MS,LEASE_RENEW_WINDOW_MS:Db.LEASE_RENEW_WINDOW_MS,STORE_NAMES:Db.STORE_NAMES,openDb:Db.openDb,...Delivery,...Results});
});
