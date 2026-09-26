(() => {
  "use strict";
  if (globalThis.__MULTIAGENT_WAVE2_CONTENT__) return;
  globalThis.__MULTIAGENT_WAVE2_CONTENT__ = true;

  const Config = globalThis.YOLOConfig;
  const Shared = globalThis.YOLOShared;
  const Core = globalThis.MultiAgentWave2Core;
  const Dom = globalThis.MultiAgentWave2Dom;
  if (!Config || !Shared || !Core || !Dom || !globalThis.chrome?.runtime) return;

  const actorId = globalThis.crypto?.randomUUID ? `wave2_actor_${globalThis.crypto.randomUUID()}` : `wave2_actor_${Date.now().toString(36)}`;
  let active = null;
  let reconcileTimer = null;
  let pollTimer = null;
  let driveBusy = false;
  let els = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
    if(message?.type!=="WAVE2_CONTENT_HEALTH")return false;
    sendResponse({ok:true,actor_id:actorId,route_identity:Dom.routeIdentity(),active_delivery_id:active?.delivery_id||""});
    return false;
  });

  function runtimeSend(message) {
    return new Promise(resolve => chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) resolve({ ok:false, code:"wave2.content_script_detached", reason:chrome.runtime.lastError.message });
      else resolve(response || { ok:false, code:"wave2.empty_response", reason:"No controller response" });
    }));
  }
  function compactError(r) { return String(r?.reason || r?.code || "Wave-2 operation failed").slice(0, 500); }
  function setStatus(text, level="info") { if (!els) return; els.status.textContent=String(text||""); els.status.dataset.level=level; }
  function summary(d, extra="") {
    if (!d) return extra || "No Wave-2 Delivery.";
    return [`state: ${d.state}`,`kind: ${d.kind}`,`delivery: ${d.delivery_id}`,`task: ${d.task_id}`,`seq: ${d.conversation_seq}`,extra].filter(Boolean).join("\n");
  }
  function stopPolling() { clearTimeout(reconcileTimer); reconcileTimer=null; clearInterval(pollTimer); pollTimer=null; }
  function startPolling() { clearInterval(pollTimer); pollTimer=setInterval(()=>{ if(active) scheduleReconcile(0); },750); }
  function scheduleReconcile(delay=150) {
    if (!active || driveBusy || reconcileTimer) return;
    reconcileTimer=setTimeout(()=>{ reconcileTimer=null; reconcileNow().catch(e=>setStatus(`Reconciliation error: ${e.message}`,"error")); },Math.max(0,Number(delay)||0));
  }
  async function fireFault(point, deliveryId) {
    const r=await runtimeSend({type:"WAVE2_FIRE_FAULT",point,delivery_id:deliveryId,actor_id:actorId});
    return Boolean(r?.ok && r.fired);
  }

  async function failPreSend(delivery, fence, reason, manualPause=false) {
    const r=await runtimeSend({type:"WAVE2_FAIL_PRE_SEND",delivery_id:delivery.delivery_id,actor_id:actorId,fence,reason,manual_pause:manualPause});
    if(r.ok){active=null;stopPolling();setStatus(summary(r.delivery,manualPause?"Paused for manual interference.":`Stopped pre-send: ${reason}`),"error");}
    return r;
  }

  async function claim(delivery, force=false) {
    const r=await runtimeSend({type:"WAVE2_CLAIM",delivery_id:delivery.delivery_id,actor_id:actorId,force_reclaim:force});
    if(!r.ok) throw new Error(compactError(r));
    active={delivery_id:r.delivery.delivery_id,fence:r.lease?.fence||r.delivery.lease_fence};
    return r;
  }

  async function sendFromSubmitting(delivery, fence) {
    const authorizationId=delivery.send_authorization_id;
    if (!authorizationId || delivery.send_consumed_at) return false;
    const consumed=await runtimeSend({type:"WAVE2_CONSUME_SEND",delivery_id:delivery.delivery_id,actor_id:actorId,fence,authorization_id:authorizationId});
    if(!consumed.ok){setStatus(summary(delivery,`Send capability reconciliation paused: ${compactError(consumed)}`),"error");startPolling();return false;}
    const invoked=Dom.invokeAuthorizedSend(consumed.permit,{delivery_id:delivery.delivery_id,authorization_id:authorizationId,lease_fence:fence,payload:delivery.payload,baseline:delivery.baseline||null});
    if(!invoked.ok){setStatus(summary(delivery,`Authorized Send could not be actuated (${invoked.code}); no automatic resend.`),"error");startPolling();return false;}
    if(await fireFault("after_send_invocation",delivery.delivery_id)){setStatus(summary(delivery,"Injected crash boundary after Send; recovery will reconcile without resend."),"error");startPolling();return false;}
    const marked=await runtimeSend({type:"WAVE2_MARK_SENT",delivery_id:delivery.delivery_id,actor_id:actorId,fence,send_path:invoked.send_path});
    if(!marked.ok)setStatus(summary(delivery,`Send happened but local acknowledgement was lost: ${compactError(marked)}. Reconciling only.`),"error");
    else setStatus(summary(marked.delivery,`send path: ${invoked.send_path}`));
    startPolling();scheduleReconcile(100);return true;
  }

  async function driveDelivery(initial, suppliedFence=0, resumeAction="") {
    if(!initial || driveBusy)return false;
    driveBusy=true;
    try {
      let delivery=initial, fence=Number(suppliedFence)||0;
      if(!fence || delivery.state==="PENDING") { const c=await claim(delivery); delivery=c.delivery; fence=c.lease.fence; }
      active={delivery_id:delivery.delivery_id,fence};

      if(delivery.state==="CLAIMED") {
        const snap=Dom.snapshot();
        if(Core.canonicalText(snap.composer_text)) return (await failPreSend(delivery,fence,"FOREIGN_COMPOSER_BEFORE_SEND",true)).ok;
        const begin=await runtimeSend({type:"WAVE2_BEGIN_FILL",delivery_id:delivery.delivery_id,actor_id:actorId,fence,snapshot:snap});
        if(!begin.ok) return (await failPreSend(delivery,fence,begin.code||"BASELINE_REJECTED",begin.code==="wave2.manual_interference")).ok;
        delivery=begin.delivery;
      }

      if(delivery.state==="COMPOSER_FILLING") {
        const snap=Dom.snapshot(); const actual=Core.canonicalText(snap.composer_text), expected=Core.canonicalText(delivery.payload);
        if(actual && actual!==expected) return (await failPreSend(delivery,fence,"FOREIGN_COMPOSER_DURING_RECOVERY",true)).ok;
        if(!actual){const wrote=Dom.writeComposerExact(delivery.payload);if(!wrote.ok)return (await failPreSend(delivery,fence,wrote.code||"COMPOSER_WRITE_FAILED")).ok;await sleep(100);if(await fireFault("after_composer_write",delivery.delivery_id)){setStatus(summary(delivery,"Injected crash after composer write; startup recovery will inspect exact composer ownership."),"error");return false;}}
        const filled=await runtimeSend({type:"WAVE2_COMPOSER_FILLED",delivery_id:delivery.delivery_id,actor_id:actorId,fence,snapshot:Dom.snapshot()});
        if(!filled.ok)return (await failPreSend(delivery,fence,filled.code||"COMPOSER_READBACK_FAILED",filled.code==="wave2.manual_interference")).ok;
        delivery=filled.delivery;
      }

      if(delivery.state==="COMPOSER_FILLED") {
        const auth=await runtimeSend({type:"WAVE2_AUTHORIZE_SEND",delivery_id:delivery.delivery_id,actor_id:actorId,fence,snapshot:Dom.snapshot()});
        if(!auth.ok){setStatus(summary(delivery,`Send authorization acknowledgement unavailable: ${compactError(auth)}. Reconstructing from durable state.`),"error");await startupReconcile();return false;}
        delivery=auth.delivery;
      }

      if(delivery.state==="SUBMITTING") return sendFromSubmitting(delivery,fence);
      if(["SENT_UNCONFIRMED","DELIVERED","RESPONSE_STARTED","RESPONSE_RECEIVED"].includes(delivery.state)){startPolling();scheduleReconcile(0);return true;}
      if(Core.isTerminalState(delivery.state)){active=null;stopPolling();return true;}
      if(resumeAction)setStatus(summary(delivery,`recovery action: ${resumeAction}`));
      return true;
    } finally { driveBusy=false; }
  }

  async function reconcileNow() {
    if(!active)return;
    const r=await runtimeSend({type:"WAVE2_RECONCILE",delivery_id:active.delivery_id,actor_id:actorId,fence:active.fence,snapshot:Dom.snapshot()});
    if(!r.ok){setStatus(`Reconciliation paused: ${compactError(r)}`,"error");return;}
    if(r.dropped){scheduleReconcile(500);return;}
    if(r.next_delivery){
      setStatus(summary(r.next_delivery,r.protocol_repair?"Protocol repair created without rerunning substantive work.":"Continuation created exactly once."));
      active=null;stopPolling();await driveDelivery(r.next_delivery);return;
    }
    const d=r.delivery; setStatus(summary(d,r.waiting_for?`waiting for: ${r.waiting_for}`:r.controller_escalation?"Controller escalation persisted.":""),r.manual_pause||r.controller_escalation?"error":d?.state==="ACKED"?"success":"info");
    if(r.resume_action==="RESUME_SEND_CAPABILITY"&&d?.state==="SUBMITTING"&&!d.send_consumed_at){await sendFromSubmitting(d,active.fence);return;}
    if(r.terminal||Core.isTerminalState(d?.state)){active=null;stopPolling();return;}
    scheduleReconcile(500);
  }

  async function startupReconcile() {
    const route=Dom.routeIdentity(); if(!Config.isDurablePageId(route))return null;
    const r=await runtimeSend({type:"WAVE2_STARTUP",actor_id:actorId,snapshot:Dom.snapshot()});
    if(!r.ok){setStatus(`Startup reconciliation blocked: ${compactError(r)}`,"error");return r;}
    if(!r.bound){setStatus("Not bound. Bind this saved conversation before Wave-2 work.");return r;}
    if(!r.delivery){setStatus("Startup reconciliation complete; no nonterminal Delivery.","success");return r;}
    if(r.next_delivery){await driveDelivery(r.next_delivery);return r;}
    if(r.manual_pause||r.delivery.state==="DELIVERY_UNKNOWN"){active=null;stopPolling();setStatus(summary(r.delivery,"Startup reconciliation stopped safely; explicit human action required."),"error");return r;}
    const fence=Number(r.fence)||Number(r.delivery.lease_fence)||0;active={delivery_id:r.delivery.delivery_id,fence};
    if(["CLAIMED","COMPOSER_FILLING","COMPOSER_FILLED"].includes(r.delivery.state)||r.resume_action==="RESUME_SEND_CAPABILITY")await driveDelivery(r.delivery,fence,r.resume_action||"");
    else {startPolling();scheduleReconcile(0);}
    return r;
  }

  async function bindCurrent() {
    const route=Dom.routeIdentity(); if(!Config.isDurablePageId(route)){setStatus("Open a saved /c/... conversation.","error");return;}
    const r=await runtimeSend({type:"WAVE2_BIND",provider_locator:route,actor_id:actorId}); if(!r.ok){setStatus(compactError(r),"error");return;}
    setStatus(`Bound ${r.binding.conversation_id}. Reconciling durable state before enabling sends.`); await startupReconcile();
  }

  async function createAndRun() {
    if(active){setStatus("A managed Delivery is already active.","error");return;}
    const status=await runtimeSend({type:"WAVE2_STATUS"}); if(!status.ok||!status.binding){setStatus("Bind this conversation first.","error");return;}
    if(!status.barrier?.reconciled){await startupReconcile();const again=await runtimeSend({type:"WAVE2_STATUS"});if(!again.barrier?.reconciled)return;}
    const instruction=String(els.instruction.value||"").trim(); if(!instruction){setStatus("Enter a task instruction.","error");return;}
    const budgets={max_continuation_turns:Number(els.turns.value),max_recoverable_failures:Number(els.failures.value),max_elapsed_ms:Number(els.minutes.value)*60000,max_protocol_repairs:1};
    const r=await runtimeSend({type:"WAVE2_CREATE_ASSIGNMENT",conversation_id:status.binding.conversation_id,instruction,budgets});
    if(!r.ok){setStatus(`Assignment creation interrupted: ${compactError(r)}. Running reconstruction.`,"error");await startupReconcile();return;}
    await driveDelivery(r.delivery);
  }

  async function armFault() {
    const point=String(els.fault.value||"").trim(); const remaining=Math.max(1,Number(els.faultCount.value)||1);
    const r=await runtimeSend({type:"WAVE2_CONFIGURE_FAULT",point,remaining,enabled:true});setStatus(r.ok?`Armed ${point} for ${remaining} trigger(s).`:compactError(r),r.ok?"success":"error");
  }

  async function showJournal() {
    const status=await runtimeSend({type:"WAVE2_STATUS"}); if(!status.delivery){setStatus("No Delivery to inspect.","error");return;}
    const r=await runtimeSend({type:"WAVE2_JOURNAL",delivery_id:status.delivery.delivery_id}); if(!r.ok){setStatus(compactError(r),"error");return;}
    setStatus(`events: ${r.events.length}\n${r.events.map(e=>`${e.seq} ${e.event_type} ${e.previous_state||"-"}->${e.next_state||"-"} ${e.reason}`).join("\n")}`);
  }

  function installPanel() {
    const host=document.createElement("div");host.id="multiagent-wave2-host";host.style.cssText="position:fixed;right:16px;bottom:16px;z-index:2147483647";
    const shadow=host.attachShadow({mode:"open"});shadow.innerHTML=`<style>:host{all:initial}details{width:360px;font:12px/1.4 system-ui;color:#eee;background:#151515;border:1px solid #555;border-radius:10px}summary{padding:10px;font-weight:700;cursor:pointer}.body{padding:0 10px 10px;display:grid;gap:7px}textarea,input,select,button{font:inherit}textarea,input,select{box-sizing:border-box;width:100%;background:#222;color:#eee;border:1px solid #555;border-radius:6px;padding:6px}textarea{min-height:80px}.row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px}.actions{display:flex;gap:5px;flex-wrap:wrap}button{background:#2c2c2c;color:#eee;border:1px solid #666;border-radius:6px;padding:6px 8px;cursor:pointer}pre{white-space:pre-wrap;overflow:auto;max-height:210px;background:#0d0d0d;padding:7px;border-radius:6px;margin:0}pre[data-level=error]{color:#ffaaaa}pre[data-level=success]{color:#aaffbb}.small{color:#aaa}</style><details><summary>MultiAgent · Wave 2</summary><div class="body"><div class="small">Reliable single-worker lane. Startup reconciliation runs before new sends.</div><textarea id="instruction">Work on this task autonomously. Use CONTINUE if another turn is needed; use DONE only when complete.</textarea><div class="row"><input id="turns" type="number" min="0" value="8" title="max continuation turns"><input id="failures" type="number" min="0" value="3" title="max recoverable failures"><input id="minutes" type="number" min="1" value="45" title="max minutes"></div><div class="actions"><button id="bind">Bind</button><button id="run">Run assignment</button><button id="reconcile">Reconcile</button><button id="journal">Journal</button></div><select id="fault">${Core.FAULT_POINTS.map(p=>`<option>${p}</option>`).join("")}</select><div class="row"><input id="faultCount" type="number" min="1" value="1"><button id="arm">Arm fault</button><span></span></div><pre id="status" role="status"></pre></div></details>`;
    (document.body||document.documentElement).append(host);
    const q=id=>shadow.getElementById(id);els={instruction:q("instruction"),turns:q("turns"),failures:q("failures"),minutes:q("minutes"),fault:q("fault"),faultCount:q("faultCount"),status:q("status")};
    q("bind").onclick=()=>bindCurrent().catch(e=>setStatus(e.message,"error"));q("run").onclick=()=>createAndRun().catch(e=>setStatus(e.message,"error"));q("reconcile").onclick=()=>startupReconcile().catch(e=>setStatus(e.message,"error"));q("journal").onclick=()=>showJournal().catch(e=>setStatus(e.message,"error"));q("arm").onclick=()=>armFault().catch(e=>setStatus(e.message,"error"));
  }

  const observer=new MutationObserver(()=>{if(active)scheduleReconcile(150);});
  function start(){if(!document.body&&!document.documentElement)return;document.getElementById("multiagent-wave1-host")?.remove();installPanel();observer.observe(document.body||document.documentElement,{childList:true,subtree:true,characterData:true});startupReconcile().catch(e=>setStatus(e.message,"error"));}
  window.addEventListener("pagehide",()=>{stopPolling();observer.disconnect();});
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();
})();
