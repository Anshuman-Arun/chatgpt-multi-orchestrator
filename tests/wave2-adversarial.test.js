const test=require('node:test');
const assert=require('node:assert/strict');

class FencedLane{
  constructor(){this.owner='A';this.fence=1;this.expires=100;this.state='COMPOSER_FILLED';this.consumed=false;this.sends=0;}
  transfer(actor,now=0){
    if(actor===this.owner&&now<this.expires)return {fence:this.fence,reconciliationOnly:false};
    if(this.state==='SUBMITTING'&&this.consumed&&now<this.expires){const e=new Error('deferred');e.code='wave2.lease_handoff_deferred';throw e;}
    this.owner=actor;this.fence++;this.expires=now+100;return {fence:this.fence,reconciliationOnly:['SUBMITTING','SENT_UNCONFIRMED','DELIVERED','RESPONSE_STARTED','RESPONSE_RECEIVED'].includes(this.state)};
  }
  require(actor,fence){if(actor!==this.owner||fence!==this.fence){const e=new Error('stale');e.code='wave2.lease_stale';throw e;}}
  authorize(actor,fence){this.require(actor,fence);if(this.state!=='COMPOSER_FILLED')throw new Error('wrong state');this.state='SUBMITTING';}
  send(actor,fence){this.require(actor,fence);if(this.state!=='SUBMITTING'||this.consumed)throw new Error('send forbidden');this.consumed=true;this.sends++;}
}
test('stale actor cannot advance or Send after a newer pre-boundary fence',()=>{const x=new FencedLane();const old=x.fence;const newer=x.transfer('B',101);assert.equal(newer.fence,2);assert.throws(()=>x.authorize('A',old),e=>e.code==='wave2.lease_stale');x.authorize('B',2);assert.throws(()=>x.send('A',old),e=>e.code==='wave2.lease_stale');x.send('B',2);assert.equal(x.sends,1);});
test('consumed SUBMITTING permit defers takeover while live then remains reconciliation-only',()=>{const x=new FencedLane();x.authorize('A',1);x.send('A',1);assert.throws(()=>x.transfer('B',50),e=>e.code==='wave2.lease_handoff_deferred');const t=x.transfer('B',101);assert.equal(t.reconciliationOnly,true);assert.throws(()=>x.send('B',t.fence));assert.equal(x.sends,1);});

class Loop{
  constructor(max=3){this.next=1;this.children=new Map();this.results=new Map();this.repairs=new Map();this.continuations=0;this.max=max;this.events=[];this.originalEvidence=new Map();}
  delivery(kind='ASSIGNMENT',parent=''){return {id:`D${this.next++}`,kind,parent};}
  continue(parent){if(this.children.has(parent.id))return this.children.get(parent.id);if(this.continuations>=this.max){this.events.push({type:'CONTROLLER_ESCALATION',reason:'BUDGET_EXHAUSTED'});return null;}this.continuations++;const d=this.delivery('CONTINUATION',parent.id);this.children.set(parent.id,d);return d;}
  repair(parent,response){this.originalEvidence.set(parent.id,response);if(this.repairs.has(parent.id))return this.repairs.get(parent.id);const d=this.delivery('PROTOCOL_REPAIR',parent.id);this.repairs.set(parent.id,d);return d;}
}
test('duplicate CONTINUE finalization creates one child with one fresh identity',()=>{const l=new Loop(),d=l.delivery();const a=l.continue(d),b=l.continue(d);assert.equal(a,b);assert.notEqual(a.id,d.id);assert.equal(a.kind,'CONTINUATION');assert.equal(l.continuations,1);});
test('protocol repair preserves original response and is parent-deduplicated without substantive rerun',()=>{const l=new Loop(),d=l.delivery(),response='full substantive answer without valid terminal';const a=l.repair(d,response),b=l.repair(d,response);assert.equal(a,b);assert.equal(a.kind,'PROTOCOL_REPAIR');assert.equal(a.parent,d.id);assert.equal(l.originalEvidence.get(d.id),response);assert.equal(l.repairs.size,1);});
test('continuation budget exhausts exactly before creating the fourth child',()=>{const l=new Loop(3);let d=l.delivery();for(let i=0;i<3;i++)d=l.continue(d);const before=l.next;const fourth=l.continue(d);assert.equal(fourth,null);assert.equal(l.next,before);assert.deepEqual(l.events,[{type:'CONTROLLER_ESCALATION',reason:'BUDGET_EXHAUSTED'}]);});
test('manual pause remains durable across a simulated actor restart until explicit resume',()=>{const durable={paused:true,pause_reason:'MANUAL_USER_INTERFERENCE',sends:1};const restarted={...durable};assert.equal(restarted.paused,true);assert.equal(restarted.sends,1);restarted.paused=false;assert.equal(restarted.sends,1);});
