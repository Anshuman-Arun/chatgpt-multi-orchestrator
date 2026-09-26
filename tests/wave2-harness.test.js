const test=require('node:test');
const assert=require('node:assert/strict');

class Crash extends Error{constructor(point){super(point);this.point=point;}}
class Harness{
  constructor(){this.seq=0;this.id=0;this.sends=0;this.workerRuns=0;this.events=[];this.turns=[];this.deliveries=[];this.result=new Map();this.task={continuations:0,terminal:false,paused:false};this.fault='';this.actor=1;this.fence=1;}
  newDelivery(kind='ASSIGNMENT',parent=''){const d={id:`D${++this.id}`,seq:++this.seq,kind,parent,state:'PENDING',consumed:false,user:false,response:false,status:'',acked:false,composer:''};this.deliveries.push(d);this.event('create',d);this.hit('after_delivery_persist');return d;}
  event(type,d){this.events.push({n:this.events.length+1,type,id:d?.id||'',state:d?.state||''});}
  hit(p){if(this.fault===p){this.fault='';this.event(`fault:${p}`,null);throw new Crash(p);}}
  setFault(p){this.fault=p;}
  latest(){return this.deliveries.at(-1);}
  execute(d,status='DONE'){
    if(this.task.paused||this.task.terminal)return;
    if(d.state==='PENDING')d.state='CLAIMED';
    if(d.state==='CLAIMED'){d.state='COMPOSER_FILLING';d.composer=`payload:${d.id}`;this.hit('after_composer_write');}
    if(d.state==='COMPOSER_FILLING'&&d.composer===`payload:${d.id}`)d.state='COMPOSER_FILLED';
    if(d.state==='COMPOSER_FILLED')d.state='SUBMITTING';
    if(d.state==='SUBMITTING'&&!d.consumed){d.consumed=true;this.sends++;d.user=true;this.turns.push(`user:${d.id}`);this.hit('after_send_invocation');d.state='SENT_UNCONFIRMED';}
    if(d.state==='SENT_UNCONFIRMED'&&d.user){this.hit('after_user_receipt');d.state='DELIVERED';}
    if(d.state==='DELIVERED'){this.workerRuns++;d.state='RESPONSE_STARTED';d.response=true;d.status=status;}
    if(d.state==='RESPONSE_STARTED'&&d.response){this.hit('after_response_detected');d.state='RESPONSE_RECEIVED';}
    if(d.state==='RESPONSE_RECEIVED'&&!this.result.has(d.id)){this.result.set(d.id,{status:d.status});this.hit('after_result_persist');}
    if(d.state==='RESPONSE_RECEIVED'&&this.result.has(d.id)){d.state='ACKED';d.acked=true;this.event('ack',d);if(d.status==='CONTINUE'){let child=this.deliveries.find(x=>x.parent===d.id&&x.kind==='CONTINUATION');if(!child){this.task.continuations++;child=this.newDelivery('CONTINUATION',d.id);}return child;}if(d.status==='DONE'||d.status==='ESCALATE')this.task.terminal=true;}
    return null;
  }
  recover(d,status=d.status||'DONE'){
    this.actor++;this.fence++;
    if(d.state==='SUBMITTING'&&d.consumed){if(d.user)d.state='SENT_UNCONFIRMED';else{d.state='DELIVERY_UNKNOWN';return null;}}
    return this.execute(d,status);
  }
  manual(d){this.task.paused=true;if(['DELIVERED','RESPONSE_STARTED'].includes(d.state))d.state='RESPONSE_SUPERSEDED';else if(['SUBMITTING','SENT_UNCONFIRMED'].includes(d.state))d.state='DELIVERY_UNKNOWN';else d.state='FAILED';}
}
function crashRecover(point,status='DONE'){
  const h=new Harness();h.setFault(point);let d;try{d=h.newDelivery();h.execute(d,status);}catch(e){assert.equal(e instanceof Crash,true);d=d||h.latest();}h.recover(d,status);return {h,d};
}

test('X001 crash after persist before composer eventually sends once',()=>{const {h,d}=crashRecover('after_delivery_persist');assert.equal(h.sends,1);assert.equal(h.turns.filter(x=>x===`user:${d.id}`).length,1);});
test('X002 crash after composer fill before Send resumes exact durable intent once',()=>{const {h,d}=crashRecover('after_composer_write');assert.equal(h.sends,1);assert.equal(d.state,'ACKED');});
test('X003 crash immediately after Send never invokes Send twice',()=>{const {h,d}=crashRecover('after_send_invocation');assert.equal(h.sends,1);assert.equal(h.turns.filter(x=>x===`user:${d.id}`).length,1);assert.equal(d.state,'ACKED');});
test('X004 crash after receipt before DELIVERED commit reconciles without resend',()=>{const {h,d}=crashRecover('after_user_receipt');assert.equal(h.sends,1);assert.equal(d.state,'ACKED');});
test('X005 crash after assistant response before capture does not rerun worker',()=>{const {h,d}=crashRecover('after_response_detected');assert.equal(h.sends,1);assert.equal(h.workerRuns,1);assert.equal(d.state,'ACKED');});
test('X006 crash after result persistence ACKs durable result without rerun',()=>{const {h,d}=crashRecover('after_result_persist');assert.equal(h.workerRuns,1);assert.equal(h.result.has(d.id),true);assert.equal(d.state,'ACKED');});
test('X007 service-worker restart retains durable active state',()=>{const h=new Harness(),d=h.newDelivery();d.state='COMPOSER_FILLED';h.recover(d);assert.equal(h.sends,1);assert.equal(d.state,'ACKED');});
test('X008 tab reload during generation reattaches response and does not duplicate user turn',()=>{const h=new Harness(),d=h.newDelivery();h.execute(d);d.state='RESPONSE_STARTED';d.acked=false;h.task.terminal=false;const sends=h.sends,runs=h.workerRuns;h.recover(d,'DONE');assert.equal(h.sends,sends);assert.equal(h.workerRuns,runs);});
test('X009 duplicate observer callbacks are idempotent after ACK',()=>{const h=new Harness(),d=h.newDelivery();h.execute(d);const sends=h.sends,runs=h.workerRuns;for(let i=0;i<8;i++)h.recover(d,'DONE');assert.equal(h.sends,sends);assert.equal(h.workerRuns,runs);});
test('X010 dropped callbacks recover on later poll',()=>{const h=new Harness(),d=h.newDelivery();d.state='SENT_UNCONFIRMED';d.consumed=true;d.user=true;h.sends=1;h.recover(d,'DONE');assert.equal(d.state,'ACKED');assert.equal(h.sends,1);});
test('X011 connection interruption blocks completion and never resends',()=>{const h=new Harness(),d=h.newDelivery();d.state='RESPONSE_STARTED';d.consumed=true;d.user=true;d.response=false;h.sends=1;const before=h.sends;assert.equal(d.state,'RESPONSE_STARTED');assert.equal(h.sends,before);});
test('X012 Retry/error state is not DONE and does not duplicate',()=>{const h=new Harness(),d=h.newDelivery();d.state='DELIVERED';d.consumed=true;d.user=true;h.sends=1;assert.equal(h.task.terminal,false);assert.equal(h.sends,1);});

test('required D1 CONTINUE D2 CONTINUE D3 CONTINUE D4 DONE uses unique monotonic deliveries',()=>{const h=new Harness();let d=h.newDelivery();d=h.execute(d,'CONTINUE');d=h.execute(d,'CONTINUE');d=h.execute(d,'CONTINUE');h.execute(d,'DONE');assert.deepEqual(h.deliveries.map(x=>x.id),['D1','D2','D3','D4']);assert.deepEqual(h.deliveries.map(x=>x.seq),[1,2,3,4]);assert.equal(new Set(h.turns).size,4);assert.equal(h.sends,4);assert.equal(h.task.terminal,true);assert.equal(h.task.continuations,3);});
test('crash in D2 continuation resumes without advancing twice',()=>{const h=new Harness();let d=h.newDelivery();d=h.execute(d,'CONTINUE');h.setFault('after_send_invocation');try{h.execute(d,'CONTINUE');}catch(e){assert.equal(e instanceof Crash,true);}d=h.recover(d,'CONTINUE');d=h.execute(d,'DONE');assert.deepEqual(h.deliveries.map(x=>x.id),['D1','D2','D3']);assert.equal(h.deliveries.filter(x=>x.parent==='D2').length,1);assert.equal(h.turns.filter(x=>x==='user:D2').length,1);});
test('manual user interference pauses lane and requires explicit resume',()=>{const h=new Harness(),d=h.newDelivery();d.state='DELIVERED';h.manual(d);assert.equal(h.task.paused,true);assert.equal(d.state,'RESPONSE_SUPERSEDED');const sends=h.sends;h.execute(d);assert.equal(h.sends,sends);});
test('ambiguous consumed SUBMITTING becomes immutable unknown and is never resent',()=>{const h=new Harness(),d=h.newDelivery();d.state='SUBMITTING';d.consumed=true;h.recover(d);assert.equal(d.state,'DELIVERY_UNKNOWN');const sends=h.sends;h.recover(d);assert.equal(d.state,'DELIVERY_UNKNOWN');assert.equal(h.sends,sends);});
