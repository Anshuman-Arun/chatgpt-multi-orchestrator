(() => {
  "use strict";
  const Config=globalThis.YOLOConfig, Core=globalThis.MultiAgentWave2Core, Store=globalThis.MultiAgentWave2Store, Faults=globalThis.MultiAgentWave2Faults;
  if(!Config||!Core||!Store||!globalThis.chrome?.runtime?.onMessage)return;
  const BOOT_ID=globalThis.crypto?.randomUUID?`wave2_boot_${globalThis.crypto.randomUUID()}`:`wave2_boot_${Date.now().toString(36)}`;
  let recoveryReady=false,recoveryFailure=null;
  const RECOVERY_GATED_TYPES=new Set(["WAVE2_CREATE_ASSIGNMENT","WAVE2_ACQUIRE","WAVE2_BEGIN_COMPOSER_FILL","WAVE2_COMPOSER_FILLED","WAVE2_AUTHORIZE_SEND","WAVE2_CONSUME_SEND","WAVE2_MARK_SENT_UNCONFIRMED","WAVE2_FAIL_PRE_SEND","WAVE2_PAUSE_MANUAL","WAVE2_RECONCILE","WAVE2_RESUME_MANUAL"]);
  function requireRecoveryReady(type){if(!RECOVERY_GATED_TYPES.has(type))return;if(recoveryReady)return;const e=new Error(recoveryFailure?`Wave-2 startup reconciliation failed: ${recoveryFailure.message||recoveryFailure}`:"Wave-2 startup reconciliation is still running");e.code=recoveryFailure?"wave2.recovery_failed":"wave2.recovery_not_ready";e.retry_at=Date.now()+250;throw e;}

  function senderLocator(sender){return Config.pageId(sender?.url||sender?.tab?.url||"");}
  function durable(locator){if(!Config.isDurablePageId(locator)){const e=new Error("Wave-2 requires a saved ChatGPT conversation (/c/...)");e.code="wave2.route_invalid";throw e;}return locator;}
  function requireRoute(sender,expected){const actual=durable(senderLocator(sender));if(actual!==String(expected||"")){const e=new Error("Content route does not match bound Wave-2 conversation");e.code="wave2.route_mismatch";throw e;}return actual;}
  async function bindingForSender(sender){const locator=durable(senderLocator(sender));return {locator,binding:await Store.getBindingByLocator(locator)};}
  async function deliveryForSender(id,sender){const d=await Store.getDelivery(id);if(!d)throw new Error("Wave-2 Delivery not found");requireRoute(sender,d.provider_locator);return d;}
  function newUserTurns(delivery,snapshot){const baseline=delivery?.baseline||{}, base=new Set(Array.isArray(baseline.user_keys)?baseline.user_keys:[]);const tail=String(baseline.tail_key||"");if(!tail&&!baseline.user_keys?.length&&!baseline.assistant_keys?.length)return (snapshot.turns||[]).filter(t=>t.role==="user");if(!Core.turnsAfterAnchor)return [];return Core.turnsAfterAnchor(snapshot,tail,"user",baseline.tail_fingerprint,baseline.tail_text).filter(t=>!base.has(String(t.identity_key||"")));}
  async function maybeFault(point,d,actor){return Faults?.maybeFire?.({point,delivery_id:d?.delivery_id||"",actor_id:actor||"",boot_id:BOOT_ID});}

  async function handleBind(m,s){const locator=durable(Config.pageId(m.provider_locator||senderLocator(s)));requireRoute(s,locator);const out=await Store.bindConversation({provider_locator:locator,actor_id:m.actor_id,boot_id:BOOT_ID});return {ok:true,...out,boot_id:BOOT_ID};}
  async function handleStatus(_m,s){const locator=durable(senderLocator(s));return {ok:true,...await Store.getStatusByLocator(locator),boot_id:BOOT_ID};}
  async function handleCreate(m,s){const {locator,binding}=await bindingForSender(s);if(!binding||binding.conversation_id!==m.conversation_id)throw new Error("Bind this conversation first");requireRoute(s,locator);const instruction=String(m.instruction||"").trim();if(!instruction)throw new Error("Wave-2 task instruction required");const out=await Store.createAssignment({conversation_id:binding.conversation_id,instruction,budgets:m.budgets||{},boot_id:BOOT_ID});await maybeFault("after_delivery_persist",out.delivery,m.actor_id);return {ok:true,...out};}
  async function handleAcquire(m,s){
    const current=await deliveryForSender(m.delivery_id,s);
    const binding=await Store.getBindingByLocator(current.provider_locator);
    const currentTask=await Store.getTask(current.task_id);
    if(binding?.paused||currentTask?.manual_pause)throw Object.assign(new Error("Conversation is paused for explicit manual reconciliation"),{code:"wave2.conversation_paused"});
    const out=await Store.acquireLease({delivery_id:m.delivery_id,actor_id:m.actor_id,boot_id:BOOT_ID});
    const task=await Store.getTask(out.delivery.task_id);
    const budget=Core.budgetDecision(task||{},Date.now(),{forContinuation:false});
    if(!budget.ok&&Core.PRE_SEND_STATES.has(out.delivery.state)){
      const stopped=await Store.failPreSend({delivery_id:out.delivery.delivery_id,actor_id:m.actor_id,fence:out.lease.fence,reason:"BUDGET_EXHAUSTED_BEFORE_SEND",boot_id:BOOT_ID,evidence:{dimension:budget.dimension}});
      const esc=await Store.emitBudgetEscalation({task_id:out.delivery.task_id,boot_id:BOOT_ID,dimension:budget.dimension});
      return {ok:true,...out,delivery:stopped,terminal:true,controller_escalation:esc.event};
    }
    return {ok:true,...out};
  }
  async function handleBeginFill(m,s){const d=await deliveryForSender(m.delivery_id,s), snap=m.snapshot||{};if(snap.route_identity!==d.provider_locator)throw new Error("Wave-2 baseline route mismatch");if(!snap.composer_present)throw Object.assign(new Error("Composer unavailable"),{code:"wave2.ui_unrecognized"});if(Core.canonicalText(snap.composer_text))throw Object.assign(new Error("Composer contains user content"),{code:"wave2.composer_busy"});if(snap.generating)throw Object.assign(new Error("Generation active"),{code:"wave2.generation_active"});const ui=Core.normalizeUiState(snap);if(ui!=="IDLE")throw Object.assign(new Error(`UI not send-safe (${ui})`),{code:"wave2.ui_not_idle"});const turns=Array.isArray(snap.turns)?snap.turns:[], tail=turns.at(-1)||null;const baseline={route_identity:snap.route_identity,user_keys:turns.filter(t=>t.role==="user").map(t=>t.identity_key),assistant_keys:turns.filter(t=>t.role==="assistant").map(t=>t.identity_key),tail_key:String(tail?.identity_key||""),tail_fingerprint:String(tail?.fingerprint||""),tail_text:String(tail?.text||"")};const next=await Store.beginComposerFilling({delivery_id:d.delivery_id,actor_id:m.actor_id,fence:m.fence,baseline,boot_id:BOOT_ID});return {ok:true,delivery:next};}
  async function handleFilled(m,s){const d=await deliveryForSender(m.delivery_id,s), snap=m.snapshot||{};if(snap.route_identity!==d.provider_locator)throw new Error("Route changed while filling composer");const exact=Core.canonicalText(snap.composer_text);if(exact!==Core.canonicalText(d.payload))throw Object.assign(new Error("Exact composer readback failed"),{code:"wave2.composer_mismatch"});const hash=await Core.sha256Hex(exact);if(hash!==d.payload_exact_hash)throw new Error("Exact composer hash mismatch");if(d.baseline?.tail_key&&Core.resolveTurnAnchor&&!Core.resolveTurnAnchor(snap,d.baseline.tail_key,d.baseline.tail_fingerprint,d.baseline.tail_text))throw Object.assign(new Error("Baseline anchor missing"),{code:"wave2.baseline_anchor_missing"});if(newUserTurns(d,snap).length)throw Object.assign(new Error("Foreign user turn appeared before Send"),{code:"wave2.foreign_user_turn"});const next=await Store.markComposerFilled({delivery_id:d.delivery_id,actor_id:m.actor_id,fence:m.fence,boot_id:BOOT_ID,evidence:{composer_hash:hash}});await maybeFault("after_composer_write",next,m.actor_id);return {ok:true,delivery:next};}
  async function handleAuthorize(m,s){const d=await deliveryForSender(m.delivery_id,s);const out=await Store.authorizeSend({delivery_id:d.delivery_id,actor_id:m.actor_id,fence:m.fence,boot_id:BOOT_ID});await maybeFault("after_submitting_commit",out.delivery,m.actor_id);return {ok:true,...out};}
  async function handleConsume(m,s){await deliveryForSender(m.delivery_id,s);return {ok:true,...await Store.consumeSendAuthorization({delivery_id:m.delivery_id,actor_id:m.actor_id,fence:m.fence,authorization_id:m.authorization_id,boot_id:BOOT_ID})};}
  async function handleSent(m,s){const d=await deliveryForSender(m.delivery_id,s);const next=await Store.markSentUnconfirmed({delivery_id:d.delivery_id,actor_id:m.actor_id,fence:m.fence,boot_id:BOOT_ID,evidence:{send_path:m.send_path||""}});return {ok:true,delivery:next};}
  async function handleFailPreSend(m,s){const d=await deliveryForSender(m.delivery_id,s);return {ok:true,delivery:await Store.failPreSend({delivery_id:d.delivery_id,actor_id:m.actor_id,fence:m.fence,reason:m.reason||"PRE_SEND_FAILURE",boot_id:BOOT_ID,evidence:m.evidence||{}})};}
  async function handlePauseManual(m,s){const d=await deliveryForSender(m.delivery_id,s);return {ok:true,delivery:await Store.pauseManual({delivery_id:d.delivery_id,actor_id:m.actor_id,fence:m.fence,reason:m.reason||"MANUAL_USER_INTERFERENCE",boot_id:BOOT_ID,evidence:m.evidence||{}})};}
  async function handleFaultPoint(m){const fault=await Store.consumeFaultPlan({point:m.point,delivery_id:m.delivery_id||"",actor_id:m.actor_id||"",boot_id:BOOT_ID});return {ok:true,fault};}
  async function handleResume(m,s){const {binding}=await bindingForSender(s);if(!binding||binding.conversation_id!==m.conversation_id)throw new Error("Binding mismatch");return {ok:true,...await Store.resumeManual({conversation_id:m.conversation_id,task_id:m.task_id,actor_id:m.actor_id||"human",boot_id:BOOT_ID})};}

  async function processResponseReceived(d,actor,fence){
    const existingResult=await Store.getWorkerResult(d.delivery_id);
    if(existingResult){const acked=await Store.ackPersistedResult({delivery_id:d.delivery_id,actor_id:actor,fence,boot_id:BOOT_ID});return continueAfterAck(acked.delivery,acked.result,acked.task,actor);}
    const parsed=Core.parseWorkerTerminal(d.response_text,d);
    if(!parsed.ok){
      await Store.annotateProtocolFailure({delivery_id:d.delivery_id,actor_id:actor,fence,code:parsed.code,boot_id:BOOT_ID});
      const task=await Store.getTask(d.task_id);
      if(Number(task?.protocol_repair_attempts||0)>=Number(task?.max_protocol_repairs||0)){
        const esc=await Store.emitBudgetEscalation({task_id:d.task_id,boot_id:BOOT_ID,dimension:"protocol_repair"});
        return {ok:true,delivery:d,terminal:true,task_terminal:true,protocol_error:parsed.code,controller_escalation:esc.event};
      }
      const repair=await Store.createChildDelivery({parent_delivery_id:d.delivery_id,kind:"PROTOCOL_REPAIR",instruction:Core.protocolRepairInstruction(d),boot_id:BOOT_ID});
      return {ok:true,delivery:d,terminal:true,task_terminal:false,protocol_error:parsed.code,next_delivery:repair.delivery};
    }
    const persisted=await Store.persistWorkerResult({delivery_id:d.delivery_id,actor_id:actor,fence,envelope:parsed.envelope,boot_id:BOOT_ID});
    await maybeFault("after_result_persist",d,actor);
    const acked=await Store.ackPersistedResult({delivery_id:d.delivery_id,actor_id:actor,fence,boot_id:BOOT_ID});
    return continueAfterAck(acked.delivery,acked.result,acked.task,actor);
  }

  async function continueAfterAck(d,result,task,actor){
    if(task?.controller_escalation?.reason==="BUDGET_EXHAUSTED")return {ok:true,delivery:d,result,terminal:true,task_terminal:true,controller_escalation:task.controller_escalation};
    if(result.status==="DONE")return {ok:true,delivery:d,result,terminal:true,task_terminal:true};
    if(result.status==="ESCALATE")return {ok:true,delivery:d,result,terminal:true,task_terminal:true,escalated:true};
    const budget=Core.budgetDecision(task,Date.now());
    if(!budget.ok){const esc=await Store.emitBudgetEscalation({task_id:d.task_id,boot_id:BOOT_ID,dimension:budget.dimension});return {ok:true,delivery:d,result,terminal:true,task_terminal:true,controller_escalation:esc.event};}
    const next=await Store.createChildDelivery({parent_delivery_id:d.delivery_id,kind:"CONTINUATION",instruction:Core.continuationInstruction(d.task_id),boot_id:BOOT_ID});
    return {ok:true,delivery:d,result,terminal:true,task_terminal:false,next_delivery:next.delivery};
  }

  async function reconcile(m,s){
    let d=await deliveryForSender(m.delivery_id,s);const snap=m.snapshot||{};const actor=m.actor_id,fence=m.fence;
    const restartFault=await Store.consumeFaultPlan({point:"service_worker_restart",delivery_id:d.delivery_id,actor_id:actor||"",boot_id:BOOT_ID});
    if(restartFault){setTimeout(()=>globalThis.chrome?.runtime?.reload?.(),0);return {ok:false,code:"wave2.injected_service_worker_restart",reason:"Developer fault requested extension/service-worker restart after durable fault evidence."};}
    if(String(Config.pageId(snap.route_identity||senderLocator(s)))!==d.provider_locator){if(["SUBMITTING","SENT_UNCONFIRMED"].includes(d.state)){d=await Store.markUnknown({delivery_id:d.delivery_id,actor_id:actor,fence,reason:"ROUTE_MISMATCH_AFTER_SEND_BOUNDARY",boot_id:BOOT_ID});return {ok:true,delivery:d,terminal:true};}throw Object.assign(new Error("Route mismatch during reconciliation"),{code:"wave2.route_mismatch"});}
    if(Core.TERMINAL_DELIVERY_STATES.has(d.state))return {ok:true,delivery:d,terminal:true};
    await Store.renewLease({delivery_id:d.delivery_id,actor_id:actor,fence,boot_id:BOOT_ID}).catch(e=>{if(e.code!=="wave2.lease_expired")throw e;});
    d=await Store.getDelivery(d.delivery_id);
    const taskBudget=await Store.getTask(d.task_id);
    const runtimeBudget=Core.budgetDecision(taskBudget||{},Date.now(),{forContinuation:false});
    let runtimeBudgetEscalation=null;
    if(!runtimeBudget.ok){
      runtimeBudgetEscalation=(await Store.emitBudgetEscalation({task_id:d.task_id,boot_id:BOOT_ID,dimension:runtimeBudget.dimension})).event;
      if(Core.PRE_SEND_STATES.has(d.state))return {ok:true,delivery:d,terminal:true,task_terminal:true,controller_escalation:runtimeBudgetEscalation};
    }
    const ui=Core.normalizeUiState(snap,m.transport||{});
    if(ui==="AUTHENTICATION_REQUIRED"||ui==="USER_REQUIRED"||ui==="RATE_LIMITED"||ui==="UNRECOGNIZED_UI"||ui==="CONTENT_SCRIPT_DETACHED"||ui==="TAB_UNAVAILABLE"){
      await Store.recordEvent({event_type:"LANE_BLOCKED_UI",reason:ui,delivery_id:d.delivery_id,actor_id:actor,boot_id:BOOT_ID});return {ok:true,delivery:d,terminal:false,blocked:true,ui_state:ui};
    }
    if(ui==="CONNECTION_WAITING"||ui==="RETRYABLE_MODEL_ERROR"){
      await Store.recordEvent({event_type:"RECOVERABLE_UI_STATE",reason:ui,delivery_id:d.delivery_id,actor_id:actor,boot_id:BOOT_ID});
      if(ui==="RETRYABLE_MODEL_ERROR"){const counted=await Store.recordRecoverableFailure({delivery_id:d.delivery_id,actor_id:actor,fence,code:ui,boot_id:BOOT_ID});const failureBudget=Core.budgetDecision(counted.task,Date.now(),{forContinuation:false});if(!failureBudget.ok){const esc=await Store.emitBudgetEscalation({task_id:d.task_id,boot_id:BOOT_ID,dimension:failureBudget.dimension});return {ok:true,delivery:d,terminal:true,task_terminal:true,controller_escalation:esc.event};}}
      return {ok:true,delivery:d,terminal:false,waiting_for:"ui_recovery",ui_state:ui};
    }
    if(["SUBMITTING","SENT_UNCONFIRMED"].includes(d.state)){
      const receipt=await Core.findOwnedUserReceipt({delivery:d,baseline:d.baseline,snapshot:snap});
      if(receipt?.ok){await maybeFault("after_user_receipt",d,actor);d=await Store.markDelivered({delivery_id:d.delivery_id,actor_id:actor,fence,expected:d.state,receipt:receipt.turn,boot_id:BOOT_ID});} else {
        const foreign=newUserTurns(d,snap).filter(t=>Core.normalizeText(t.text)!==Core.normalizeText(d.payload));
        if(foreign.length){d=await Store.pauseManual({delivery_id:d.delivery_id,actor_id:actor,fence,reason:"FOREIGN_USER_TURN_BEFORE_RECEIPT",boot_id:BOOT_ID,evidence:{foreign_user_turns:foreign.length}});return {ok:true,delivery:d,terminal:true,manual_pause:true};}
        if(d.send_consumed_at){d=await Store.markUnknown({delivery_id:d.delivery_id,actor_id:actor,fence,reason:"POST_SEND_RECEIPT_AMBIGUOUS",boot_id:BOOT_ID,evidence:{receipt_code:receipt?.code||""}});return {ok:true,delivery:d,terminal:true};}
        return {ok:true,delivery:d,terminal:false,waiting_for:"safe_send_resume",positive_non_delivery:true};
      }
    }
    if(["DELIVERED","RESPONSE_STARTED","RESPONSE_RECEIVED"].includes(d.state)){
      const anchor=Core.resolveTurnAnchor?.(snap,d.user_receipt?.identity_key,d.user_receipt?.fingerprint,d.payload);if(!anchor)return {ok:true,delivery:d,terminal:false,waiting_for:"owned_user_anchor"};
      const foreign=Core.turnsAfterAnchor?.(snap,d.user_receipt?.identity_key,"user",d.user_receipt?.fingerprint,d.payload)||[];if(foreign.length){d=await Store.pauseManual({delivery_id:d.delivery_id,actor_id:actor,fence,reason:"FOREIGN_USER_TURN_AFTER_OWNED_RECEIPT",boot_id:BOOT_ID,evidence:{foreign_user_turns:foreign.length}});return {ok:true,delivery:d,terminal:true,manual_pause:true};}
    }
    if(d.state==="DELIVERED"){
      const c=Core.selectAssistantCandidate({baseline:d.baseline,receipt:{turn:d.user_receipt},snapshot:snap,ownedUserText:d.payload});if(!c)return {ok:true,delivery:d,terminal:false,waiting_for:"assistant_candidate"};const h=await Core.sha256Hex(Core.normalizeText(c.text));d=await Store.markResponseStarted({delivery_id:d.delivery_id,actor_id:actor,fence,candidate:c,text_hash:h,boot_id:BOOT_ID});return {ok:true,delivery:d,terminal:false,waiting_for:"assistant_completion"};
    }
    if(d.state==="RESPONSE_STARTED"){
      const c=Core.selectAssistantCandidate({baseline:d.baseline,receipt:{turn:d.user_receipt},snapshot:snap,ownedUserText:d.payload,currentIdentity:d.assistant_candidate?.identity_key,currentIdentityKind:d.assistant_candidate?.identity_kind});if(!c)return {ok:true,delivery:d,terminal:false,waiting_for:"assistant_candidate"};const h=await Core.sha256Hex(Core.normalizeText(c.text));if(h!==d.assistant_text_hash||String(c.identity_key||"")!==String(d.assistant_candidate?.identity_key||"")){d=await Store.recordAssistantMutation({delivery_id:d.delivery_id,actor_id:actor,fence,candidate:c,text_hash:h,boot_id:BOOT_ID});return {ok:true,delivery:d,terminal:false,waiting_for:"assistant_quiescence"};}
      const complete=Core.turnCompletionEvidence({delivered:Boolean(d.user_receipt),candidate:c,snapshot:snap,last_changed_at:d.assistant_last_changed_at,now:Date.now()});if(!complete.complete)return {ok:true,delivery:d,terminal:false,waiting_for:"assistant_completion",completion:complete};await maybeFault("after_response_detected",d,actor);d=await Store.markResponseReceived({delivery_id:d.delivery_id,actor_id:actor,fence,response_text:c.text,response_text_hash:h,boot_id:BOOT_ID});return processResponseReceived(d,actor,fence);
    }
    if(d.state==="RESPONSE_RECEIVED")return processResponseReceived(d,actor,fence);
    return {ok:true,delivery:d,terminal:false,waiting_for:"content_execution"};
  }

  async function journal(m,s){const d=await deliveryForSender(m.delivery_id,s), events=await Store.getEventsForDelivery(d.delivery_id);return {ok:true,events};}
  async function configureFaults(m){const plan=await Store.setFaultPlan({enabled:Boolean(m.enabled),points:m.points||[],actor_id:m.actor_id||"developer",boot_id:BOOT_ID});return {ok:true,plan};}

  async function dispatch(m,s){requireRecoveryReady(m.type);switch(m.type){
    case"WAVE2_BIND":return handleBind(m,s);case"WAVE2_STATUS":return handleStatus(m,s);case"WAVE2_CREATE_ASSIGNMENT":return handleCreate(m,s);case"WAVE2_ACQUIRE":return handleAcquire(m,s);case"WAVE2_BEGIN_COMPOSER_FILL":return handleBeginFill(m,s);case"WAVE2_COMPOSER_FILLED":return handleFilled(m,s);case"WAVE2_AUTHORIZE_SEND":return handleAuthorize(m,s);case"WAVE2_CONSUME_SEND":return handleConsume(m,s);case"WAVE2_MARK_SENT_UNCONFIRMED":return handleSent(m,s);case"WAVE2_FAIL_PRE_SEND":return handleFailPreSend(m,s);case"WAVE2_PAUSE_MANUAL":return handlePauseManual(m,s);case"WAVE2_FAULT_POINT":return handleFaultPoint(m);case"WAVE2_RECONCILE":return reconcile(m,s);case"WAVE2_RESUME_MANUAL":return handleResume(m,s);case"WAVE2_JOURNAL":return journal(m,s);case"WAVE2_CONFIGURE_FAULTS":return configureFaults(m);default:return {ok:false,code:"wave2.message_unknown",reason:"Unknown Wave-2 operation"};}}
  chrome.runtime.onMessage.addListener((m,s,reply)=>{if(!m?.type?.startsWith("WAVE2_"))return false;Promise.resolve(dispatch(m,s)).then(reply).catch(e=>reply({ok:false,code:e?.code||"wave2.error",reason:e?.message||String(e),retry_at:e?.retry_at||0}));return true;});

  const sendTab=(tabId,message)=>new Promise(resolve=>chrome.tabs?.sendMessage?.(tabId,message,r=>resolve(chrome.runtime.lastError?null:r||null))||resolve(null));
  const queryTabs=(query)=>new Promise(resolve=>{if(!chrome.tabs?.query)return resolve([]);chrome.tabs.query(query,tabs=>resolve(chrome.runtime.lastError?[]:tabs||[]));});
  async function startupReconcile(){
    await Store.openDb();
    const ds=await Store.listNonterminalDeliveries();
    await Store.recordEvent({event_type:"STARTUP_RECONCILIATION",reason:"SERVICE_WORKER_BOOT",boot_id:BOOT_ID,evidence:{nonterminal_deliveries:ds.length}});
    const tabs=await queryTabs({url:["https://chatgpt.com/*","https://*.chatgpt.com/*"]});
    const recoverable=[];
    for(const d of ds){
      const tab=tabs.find(t=>Config.pageId(t.url||t.pendingUrl||"")===d.provider_locator);
      if(!tab){await Store.recordEvent({event_type:"RECOVERY_TAB_UNAVAILABLE",reason:"TAB_UNAVAILABLE",delivery_id:d.delivery_id,boot_id:BOOT_ID});continue;}
      const observed=await sendTab(tab.id,{type:"WAVE2_READONLY_SNAPSHOT",delivery_id:d.delivery_id,boot_id:BOOT_ID});
      if(!observed?.ok||!observed.snapshot){await Store.recordEvent({event_type:"RECOVERY_CONTENT_DETACHED",reason:"CONTENT_SCRIPT_DETACHED",delivery_id:d.delivery_id,boot_id:BOOT_ID,evidence:{tab_id:tab.id}});continue;}
      const snap=observed.snapshot;
      await Store.recordEvent({event_type:"RESTART_RECONCILIATION_OBSERVED",reason:String(snap.ui_state||Core.normalizeUiState(snap)||"READ_ONLY_SNAPSHOT"),delivery_id:d.delivery_id,boot_id:BOOT_ID,evidence:{tab_id:tab.id,route_fingerprint:Core.fingerprint(snap.route_identity||""),turns:Array.isArray(snap.turns)?snap.turns.length:0,composer_present:Boolean(snap.composer_present),generating:Boolean(snap.generating)}});
      let exactReceipt=false,foreignUser=false,causalResponseComplete=d.state==="RESPONSE_RECEIVED";
      if(["SUBMITTING","SENT_UNCONFIRMED"].includes(d.state)){
        const receipt=await Core.findOwnedUserReceipt({delivery:d,baseline:d.baseline,snapshot:snap});
        exactReceipt=Boolean(receipt?.ok);
      }
      if(d.baseline){
        const windowUsers=newUserTurns(d,snap);
        foreignUser=windowUsers.some(t=>Core.normalizeText(t.text)!==Core.normalizeText(d.payload));
      }
      if(d.state==="RESPONSE_STARTED"&&d.user_receipt){
        const candidate=Core.selectAssistantCandidate({baseline:d.baseline,receipt:{turn:d.user_receipt},snapshot:snap,ownedUserText:d.payload,currentIdentity:d.assistant_candidate?.identity_key,currentIdentityKind:d.assistant_candidate?.identity_kind});
        if(candidate){
          const completion=Core.turnCompletionEvidence({delivered:true,candidate,snapshot:snap,last_changed_at:d.assistant_last_changed_at,now:Date.now()});
          causalResponseComplete=Boolean(completion.complete);
        }
      }
      const observation={
        exact_owned_user_turn:exactReceipt,
        exact_composer_payload:Core.canonicalText(snap.composer_text)===Core.canonicalText(d.payload),
        composer_empty:!Core.canonicalText(snap.composer_text),
        foreign_user_turn:foreignUser,
        causal_response_complete:causalResponseComplete,
        positive_non_delivery:d.state==="SUBMITTING"&&!d.send_consumed_at
      };
      const decision=Core.classifyReconciliation(d,observation);
      await Store.recordEvent({event_type:"RESTART_RECONCILIATION_DECISION",reason:decision.action,delivery_id:d.delivery_id,boot_id:BOOT_ID,evidence:{exact_owned_user_turn:observation.exact_owned_user_turn,exact_composer_payload:observation.exact_composer_payload,composer_empty:observation.composer_empty,foreign_user_turn:observation.foreign_user_turn,causal_response_complete:observation.causal_response_complete,positive_non_delivery:observation.positive_non_delivery}});
      recoverable.push({tab,d});
    }
    recoveryReady=true;
    await Store.recordEvent({event_type:"STARTUP_RECONCILIATION_READY",reason:"READ_ONLY_RECONCILIATION_COMPLETE",boot_id:BOOT_ID,evidence:{recoverable_tabs:recoverable.length,nonterminal_deliveries:ds.length}});
    for(const item of recoverable)sendTab(item.tab.id,{type:"WAVE2_RECOVER_DELIVERY",delivery_id:item.d.delivery_id,boot_id:BOOT_ID}).catch?.(()=>{});
  }
  startupReconcile().catch(async e=>{recoveryFailure=e;await Store.recordEvent({event_type:"STARTUP_RECONCILIATION_FAILED",reason:e?.message||String(e),boot_id:BOOT_ID}).catch(()=>{});console.error(`Wave-2 startup reconciliation failed: ${e?.message||e}`);});
})();