(() => {
  "use strict";
  if(globalThis.__MULTIAGENT_WAVE2_CONTENT__)return;globalThis.__MULTIAGENT_WAVE2_CONTENT__=true;
  const Config=globalThis.YOLOConfig, Core=globalThis.MultiAgentWave2Core, Dom=globalThis.MultiAgentWave2Dom;
  if(!Config||!Core||!Dom||!globalThis.chrome?.runtime)return;
  const actorId=globalThis.crypto?.randomUUID?`wave2_actor_${globalThis.crypto.randomUUID()}`:`wave2_actor_${Date.now().toString(36)}`;
  let active=null,reconcileTimer=null,pollTimer=null,sendCritical=false,els=null;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  function runtimeSend(message){return new Promise(resolve=>chrome.runtime.sendMessage(message,response=>resolve(chrome.runtime.lastError?{ok:false,code:"wave2.runtime_unavailable",reason:chrome.runtime.lastError.message}:response||{ok:false,code:"wave2.empty_response"})));}
  const compact=r=>String(r?.reason||r?.code||"Wave-2 operation failed").slice(0,500);
  function setStatus(text,level="info"){if(!els)return;els.status.textContent=String(text||"");els.status.dataset.level=level;}
  function summary(d,extra=""){if(!d)return extra||"No Wave-2 Delivery.";return [`state: ${d.state}`,`kind: ${d.kind}`,`delivery: ${d.delivery_id}`,`task: ${d.task_id}`,`seq: ${d.conversation_seq}`,extra].filter(Boolean).join("\n");}
  function stopPolling(){clearTimeout(reconcileTimer);reconcileTimer=null;clearInterval(pollTimer);pollTimer=null;}
  function scheduleReconcile(delay=150){if(!active||sendCritical||reconcileTimer)return;reconcileTimer=setTimeout(()=>{reconcileTimer=null;reconcileNow().catch(e=>setStatus(`Reconcile error: ${e.message}`,"error"));},Math.max(0,Number(delay)||0));}
  function startPolling(){clearInterval(pollTimer);pollTimer=setInterval(()=>active&&scheduleReconcile(0),750);}
  async function faultPoint(point,deliveryId){const r=await runtimeSend({type:"WAVE2_FAULT_POINT",point,delivery_id:deliveryId||active?.delivery_id||"",actor_id:actorId});return r?.fault||null;}
  function crashIfFault(fault){if(fault?.action==="CRASH"){active=null;stopPolling();globalThis.location?.reload?.();const e=new Error(`Injected Wave-2 content crash at ${fault.point}`);e.code="wave2.injected_fault";throw e;}}
  async function snapshotWithInjectedUi(){const snap=Dom.snapshot();const connection=await faultPoint("connection_interruption",active?.delivery_id);if(connection)snap.error_code="connection_waiting";const retry=await faultPoint("retry_error_state",active?.delivery_id);if(retry)snap.error_code="retryable_model_error";return snap;}
  async function pauseManual(d,fence,reason,evidence={}){const r=await runtimeSend({type:"WAVE2_PAUSE_MANUAL",delivery_id:d.delivery_id,actor_id:actorId,fence,reason,evidence});active=null;stopPolling();setStatus(summary(r.delivery||d,"Automation paused; explicit reconciliation/resume is required."),"error");return r;}
  async function failPreSend(d,fence,reason,evidence={}){const r=await runtimeSend({type:"WAVE2_FAIL_PRE_SEND",delivery_id:d.delivery_id,actor_id:actorId,fence,reason,evidence});active=null;stopPolling();setStatus(summary(r.delivery||d,`Stopped before Send: ${reason}`),"error");return r;}

  async function continuePreSend(delivery,fence){
    let d=delivery,snap=Dom.snapshot();
    if(d.state==="CLAIMED"){
      if(Core.canonicalText(snap.composer_text))return pauseManual(d,fence,"MANUAL_COMPOSER_INTERFERENCE");
      const b=await runtimeSend({type:"WAVE2_BEGIN_COMPOSER_FILL",delivery_id:d.delivery_id,actor_id:actorId,fence,snapshot:snap});
      if(!b.ok)return failPreSend(d,fence,b.code||"BASELINE_REJECTED",{detail:Core.fingerprint(b.reason||"")});d=b.delivery;
    }
    if(d.state==="COMPOSER_FILLING"){
      snap=Dom.snapshot();const current=Core.canonicalText(snap.composer_text),expected=Core.canonicalText(d.payload);
      if(current&&current!==expected)return pauseManual(d,fence,"MANUAL_COMPOSER_INTERFERENCE");
      if(!current){const wrote=Dom.writeComposerExact(d.payload);if(!wrote.ok)return pauseManual(d,fence,wrote.code||"COMPOSER_BUSY");await sleep(100);crashIfFault(await faultPoint("after_composer_write",d.delivery_id));}
      snap=Dom.snapshot();const filled=await runtimeSend({type:"WAVE2_COMPOSER_FILLED",delivery_id:d.delivery_id,actor_id:actorId,fence,snapshot:snap});if(!filled.ok)return pauseManual(d,fence,filled.code||"COMPOSER_READBACK_FAILED",{detail:Core.fingerprint(filled.reason||"")});d=filled.delivery;
    }
    if(d.state==="COMPOSER_FILLED"){
      const exact=Dom.composerForExactPayload(d.payload);if(!exact.ok)return pauseManual(d,fence,exact.code||"COMPOSER_CHANGED");
      const auth=await runtimeSend({type:"WAVE2_AUTHORIZE_SEND",delivery_id:d.delivery_id,actor_id:actorId,fence});if(!auth.ok){active=null;stopPolling();setStatus(summary(d,`Send authorization unresolved: ${compact(auth)}. Recovery will reconcile without blind resend.`),"error");return false;}d=auth.delivery;
    }
    if(d.state==="SUBMITTING"){
      if(d.send_consumed_at){sendCritical=false;startPolling();scheduleReconcile(0);return true;}
      const exact=Dom.composerForExactPayload(d.payload);if(!exact.ok){active=null;stopPolling();setStatus(summary(d,"SUBMITTING but exact composer payload is unavailable; lane blocked for reconciliation."),"error");return false;}
      const consumed=await runtimeSend({type:"WAVE2_CONSUME_SEND",delivery_id:d.delivery_id,actor_id:actorId,fence,authorization_id:d.send_authorization_id});if(!consumed.ok){active=null;stopPolling();setStatus(summary(d,`Send capability could not be consumed: ${compact(consumed)}. No Send was invoked.`),"error");return false;}
      const invoked=Dom.invokeAuthorizedSend(consumed.permit,{delivery_id:d.delivery_id,authorization_id:d.send_authorization_id,lease_fence:fence,payload:d.payload,baseline:d.baseline||null});if(!invoked.ok){active=null;stopPolling();setStatus(summary(d,`Authorized Send actuator refused: ${invoked.code}. Reconciliation only.`),"error");return false;}
      crashIfFault(await faultPoint("after_send_invocation",d.delivery_id));
      const marked=await runtimeSend({type:"WAVE2_MARK_SENT_UNCONFIRMED",delivery_id:d.delivery_id,actor_id:actorId,fence,send_path:invoked.send_path});
      if(!marked.ok)setStatus(summary(d,`Send occurred; local SENT_UNCONFIRMED commit was unavailable (${compact(marked)}). Never resending; reconciling.`),"error");else setStatus(summary(marked.delivery,`send path: ${invoked.send_path}`));
    }
    sendCritical=false;startPolling();scheduleReconcile(100);return true;
  }

  async function recoverDelivery(deliveryId){
    if(active&&active.delivery_id!==deliveryId)return false;
    const acquired=await runtimeSend({type:"WAVE2_ACQUIRE",delivery_id:deliveryId,actor_id:actorId});
    if(!acquired.ok){if(acquired.code==="wave2.lease_handoff_deferred"){setStatus(`Recovery deferred until the prior consumed Send permit expires. No resend will occur.`,"info");return false;}setStatus(`Recovery blocked: ${compact(acquired)}`,"error");return false;}
    let d=acquired.delivery;const fence=acquired.lease.fence;active={delivery_id:d.delivery_id,fence};setStatus(summary(d,`lease fence: ${fence}${acquired.reconciliation_only?" (reconciliation only)":""}`));
    if(["CLAIMED","COMPOSER_FILLING","COMPOSER_FILLED"].includes(d.state)||(d.state==="SUBMITTING"&&!d.send_consumed_at)){sendCritical=true;try{return await continuePreSend(d,fence);}finally{sendCritical=false;}}
    startPolling();scheduleReconcile(0);return true;
  }

  async function reconcileNow(){
    if(!active)return;
    const reloadFault=await faultPoint("tab_reload_during_generation",active.delivery_id);
    if(reloadFault){setStatus("Injected Wave-2 tab reload; durable recovery will rebind before any new side effect.","error");globalThis.location?.reload?.();return;}
    const snap=await snapshotWithInjectedUi();const r=await runtimeSend({type:"WAVE2_RECONCILE",delivery_id:active.delivery_id,actor_id:actorId,fence:active.fence,snapshot:snap});
    if(!r.ok){setStatus(`Reconciliation paused: ${compact(r)}`,"error");return;}
    const d=r.delivery;setStatus(summary(d,r.waiting_for?`waiting for: ${r.waiting_for}`:r.ui_state?`UI: ${r.ui_state}`:""),d?.state==="ACKED"?"success":"info");
    if(r.next_delivery){active=null;stopPolling();await recoverDelivery(r.next_delivery.delivery_id);return;}
    if(r.manual_pause||r.controller_escalation||r.task_terminal||["DELIVERY_UNKNOWN","FAILED","RESPONSE_FAILED","RESPONSE_SUPERSEDED"].includes(d?.state)){active=null;stopPolling();setStatus(summary(d,r.manual_pause?"Paused for manual reconciliation.":r.controller_escalation?"Controller escalation persisted.":r.task_terminal?"Task terminal.":"Lane stopped safely."),d?.state==="ACKED"?"success":"error");return;}
    if(r.positive_non_delivery&&d?.state==="SUBMITTING"&&!d.send_consumed_at){sendCritical=true;try{await continuePreSend(d,active.fence);}finally{sendCritical=false;}return;}
    scheduleReconcile(500);
  }

  async function bind(){const route=Dom.routeIdentity();if(!Config.isDurablePageId(route)){setStatus("Open a saved ChatGPT conversation ending in /c/<id>.","error");return;}const r=await runtimeSend({type:"WAVE2_BIND",provider_locator:route,actor_id:actorId});setStatus(r.ok?`Bound ${r.binding.conversation_id}`:compact(r),r.ok?"success":"error");}
  async function run(){if(active){setStatus("A Wave-2 Delivery is already active.","error");return;}const status=await runtimeSend({type:"WAVE2_STATUS"});if(!status.ok||!status.binding){setStatus("Bind this conversation first.","error");return;}if(status.binding.paused){setStatus(`Conversation paused: ${status.binding.pause_reason}. Reconcile and press Resume first.`,"error");return;}const instruction=String(els.instruction.value||"").trim();if(!instruction){setStatus("Enter a task instruction.","error");return;}const created=await runtimeSend({type:"WAVE2_CREATE_ASSIGNMENT",conversation_id:status.binding.conversation_id,instruction,budgets:{max_continuations:Number(els.continuations.value)||3,max_recoverable_failures:2,max_elapsed_ms:30*60*1000,max_protocol_repairs:1},actor_id:actorId});if(!created.ok){setStatus(compact(created),"error");return;}await recoverDelivery(created.delivery.delivery_id);}
  async function resume(){const status=await runtimeSend({type:"WAVE2_STATUS"});if(!status?.binding||!status?.task){setStatus("No paused task to resume.","error");return;}const r=await runtimeSend({type:"WAVE2_RESUME_MANUAL",conversation_id:status.binding.conversation_id,task_id:status.task.task_id,actor_id:actorId});setStatus(r.ok?"Manual pause cleared after explicit reconciliation. No prior Delivery is resent automatically.":compact(r),r.ok?"success":"error");}
  async function journal(){const status=await runtimeSend({type:"WAVE2_STATUS"});if(!status?.delivery){setStatus("No Delivery exists.","error");return;}const r=await runtimeSend({type:"WAVE2_JOURNAL",delivery_id:status.delivery.delivery_id});setStatus(r.ok?`journal events: ${r.events.length}\n${r.events.map(e=>`${e.seq} ${e.event_type} ${e.previous_state??""}->${e.next_state??""}`).join("\n")}`:compact(r),r.ok?"success":"error");}
  async function recoverCurrent(){const status=await runtimeSend({type:"WAVE2_STATUS"});if(!status?.ok||!status.delivery)return;if(!Core.TERMINAL_DELIVERY_STATES.has(status.delivery.state))await recoverDelivery(status.delivery.delivery_id);}
  globalThis.MultiAgentWave2Dev=Object.freeze({
    armFaults:(points)=>runtimeSend({type:"WAVE2_CONFIGURE_FAULTS",enabled:true,points:Array.isArray(points)?points:[],actor_id:actorId}),
    clearFaults:()=>runtimeSend({type:"WAVE2_CONFIGURE_FAULTS",enabled:false,points:[],actor_id:actorId})
  });

  chrome.runtime.onMessage.addListener((m,_s,reply)=>{if(m?.type==="WAVE2_CONTENT_HEALTH"){reply({ok:true,actor_id:actorId,route_identity:Dom.routeIdentity(),active_delivery_id:active?.delivery_id||""});return false;}if(m?.type==="WAVE2_RECOVER_DELIVERY"){recoverDelivery(m.delivery_id).then(ok=>reply({ok,actor_id:actorId})).catch(e=>reply({ok:false,reason:e.message}));return true;}return false;});

  function installPanel(){const host=document.createElement("div");host.id="multiagent-wave2-host";host.style.cssText="position:fixed;right:16px;bottom:16px;z-index:2147483646";const sh=host.attachShadow({mode:"open"});sh.innerHTML=`<style>:host{all:initial}details{width:350px;font:12px/1.4 system-ui;color:#e8e8e8;background:#171717;border:1px solid #555;border-radius:10px}summary{padding:10px 12px;font-weight:700;cursor:pointer}.b{padding:0 12px 12px;display:grid;gap:8px}textarea,input{box-sizing:border-box;width:100%;background:#222;color:inherit;border:1px solid #555;border-radius:7px;padding:7px}textarea{min-height:80px}.a{display:flex;gap:6px;flex-wrap:wrap}button{background:#2d2d2d;color:inherit;border:1px solid #666;border-radius:7px;padding:6px 9px;cursor:pointer}pre{max-height:190px;overflow:auto;white-space:pre-wrap;background:#0f0f0f;padding:8px;border-radius:7px;margin:0}pre[data-level=error]{color:#ff9c9c}pre[data-level=success]{color:#9ee6ad}</style><details><summary>MultiAgent — Wave 2</summary><div class=b><textarea aria-label="Wave-2 task"></textarea><label>Max continuations <input type=number min=0 max=50 value=3></label><div class=a><button data-x=bind>Bind</button><button data-x=run>Run</button><button data-x=resume>Resume</button><button data-x=journal>Journal</button></div><pre role=status></pre></div></details>`;(document.body||document.documentElement).append(host);els={instruction:sh.querySelector("textarea"),continuations:sh.querySelector("input"),status:sh.querySelector("pre")};sh.querySelector('[data-x=bind]').onclick=()=>bind().catch(e=>setStatus(e.message,"error"));sh.querySelector('[data-x=run]').onclick=()=>run().catch(e=>setStatus(e.message,"error"));sh.querySelector('[data-x=resume]').onclick=()=>resume().catch(e=>setStatus(e.message,"error"));sh.querySelector('[data-x=journal]').onclick=()=>journal().catch(e=>setStatus(e.message,"error"));}
  const observer=new MutationObserver(()=>{if(!active)return;faultPoint("drop_observer_callbacks",active.delivery_id).then(drop=>{if(drop)return;scheduleReconcile(150);return faultPoint("duplicate_observer_callbacks",active.delivery_id);}).then(dup=>{if(dup){scheduleReconcile(150);scheduleReconcile(150);}}).catch(()=>{});});
  function start(){if(!document.body&&!document.documentElement)return;installPanel();observer.observe(document.body||document.documentElement,{childList:true,subtree:true,characterData:true});recoverCurrent().catch(e=>setStatus(`Startup recovery paused: ${e.message}`,"error"));}
  window.addEventListener("pagehide",()=>{stopPolling();observer.disconnect();});if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();
})();
