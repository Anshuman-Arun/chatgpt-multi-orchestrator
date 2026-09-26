const test=require('node:test');
const assert=require('node:assert/strict');

const clone=value=>JSON.parse(JSON.stringify(value));

class FakeIndexedDb{
  constructor(seed=null){
    this.stores=clone(seed||{deliveries:{},leases:{},tasks:{},results:{},events:[]});
  }
  tx(fn){
    const draft=clone(this.stores);
    const result=fn(draft);
    this.stores=draft;
    return result;
  }
  restart(){
    return new FakeIndexedDb(this.stores);
  }
}

class FakeBrowser{
  constructor(){
    this.composer='';
    this.turns=[];
    this.generating=false;
    this.sendCount=0;
    this.workerRuns=0;
    this.nextTurn=1;
  }
  snapshot(){
    return clone({
      composer_present:true,
      composer_text:this.composer,
      generating:this.generating,
      idle_send_path:!this.generating,
      turns:this.turns.map((turn,index)=>({...turn,order:index}))
    });
  }
  write(text){
    if(this.composer&&this.composer!==text)throw new Error('foreign composer content');
    this.composer=text;
  }
  send(delivery){
    if(this.composer!==delivery.payload)throw new Error('composer mismatch');
    if(this.turns.some(t=>t.role==='user'&&t.delivery_id===delivery.delivery_id))throw new Error('duplicate user turn');
    this.sendCount++;
    this.turns.push({role:'user',identity_key:'u'+this.nextTurn++,delivery_id:delivery.delivery_id,text:delivery.payload});
    this.composer='';
    this.generating=true;
  }
  assistant(delivery,text,{complete=false}={}){
    let turn=this.turns.find(t=>t.role==='assistant'&&t.delivery_id===delivery.delivery_id);
    if(!turn){
      this.workerRuns++;
      turn={role:'assistant',identity_key:'a'+this.nextTurn++,delivery_id:delivery.delivery_id,text:''};
      this.turns.push(turn);
    }
    turn.text=text;
    this.generating=!complete;
  }
  manualUser(text){
    this.turns.push({role:'user',identity_key:'u'+this.nextTurn++,delivery_id:'',text});
  }
}

class Runtime{
  constructor(db,browser,actor){
    this.db=db;
    this.browser=browser;
    this.actor=actor;
    this.fence=0;
  }
  event(stores,type,d){
    stores.events.push({seq:stores.events.length+1,type,delivery_id:d?.delivery_id||'',state:d?.state||''});
  }
  create(delivery_id='D1'){
    const payload='router payload '+delivery_id;
    this.db.tx(s=>{
      s.deliveries[delivery_id]={delivery_id,payload,state:'PENDING',lease_fence:0,actor_id:'',baseline:null,send_consumed_at:0,user_receipt:null,response_text:'',response_hash:'',created:true};
      s.tasks.T1=s.tasks.T1||{task_id:'T1',paused:false};
      this.event(s,'DELIVERY_CREATED',s.deliveries[delivery_id]);
    });
    return this.delivery(delivery_id);
  }
  delivery(id){return clone(this.db.stores.deliveries[id]);}
  acquire(id){
    this.db.tx(s=>{
      const d=s.deliveries[id],old=s.leases.C1;
      const fence=Math.max(0,Number(old?.fence)||0)+1;
      s.leases.C1={conversation_id:'C1',owner:this.actor,fence};
      if(d.state==='PENDING')d.state='CLAIMED';
      d.actor_id=this.actor;d.lease_fence=fence;
      this.fence=fence;
      this.event(s,'LEASE_ACQUIRED',d);
    });
    return this.delivery(id);
  }
  assertFence(s,d){
    const lease=s.leases.C1;
    if(!lease||lease.owner!==this.actor||lease.fence!==this.fence||d.lease_fence!==this.fence){
      const e=new Error('stale fence');e.code='wave2.lease_stale';throw e;
    }
  }
  begin(id){
    const snap=this.browser.snapshot();
    if(snap.composer_text)throw new Error('composer busy');
    this.db.tx(s=>{
      const d=s.deliveries[id];this.assertFence(s,d);
      assert.equal(d.state,'CLAIMED');
      d.baseline={user_keys:snap.turns.filter(t=>t.role==='user').map(t=>t.identity_key),assistant_keys:snap.turns.filter(t=>t.role==='assistant').map(t=>t.identity_key)};
      d.state='COMPOSER_FILLING';
      this.event(s,'COMPOSER_FILLING',d);
    });
  }
  fillOrPause(id){
    const d=this.delivery(id),snap=this.browser.snapshot();
    if(snap.composer_text&&snap.composer_text!==d.payload){
      this.db.tx(s=>{const x=s.deliveries[id];this.assertFence(s,x);x.state='FAILED';s.tasks.T1.paused=true;this.event(s,'MANUAL_PAUSE',x);});
      return false;
    }
    if(!snap.composer_text)this.browser.write(d.payload);
    this.db.tx(s=>{const x=s.deliveries[id];this.assertFence(s,x);assert.equal(x.state,'COMPOSER_FILLING');assert.equal(this.browser.snapshot().composer_text,x.payload);x.state='COMPOSER_FILLED';this.event(s,'COMPOSER_FILLED',x);});
    return true;
  }
  authorize(id){
    this.db.tx(s=>{const d=s.deliveries[id];this.assertFence(s,d);assert.equal(d.state,'COMPOSER_FILLED');d.state='SUBMITTING';d.authorization='A:'+id;this.event(s,'SUBMITTING',d);});
  }
  consumeAndSend(id,{crashAfterSend=false}={}){
    this.db.tx(s=>{const d=s.deliveries[id];this.assertFence(s,d);assert.equal(d.state,'SUBMITTING');assert.equal(d.send_consumed_at,0);d.send_consumed_at=1;this.event(s,'SEND_CAPABILITY_CONSUMED',d);});
    const d=this.delivery(id);
    this.browser.send(d);
    if(crashAfterSend)throw new Error('crash after send');
    this.db.tx(s=>{const x=s.deliveries[id];this.assertFence(s,x);assert.equal(x.state,'SUBMITTING');x.state='SENT_UNCONFIRMED';this.event(s,'SENT_UNCONFIRMED',x);});
  }
  exactReceipt(d,snap){
    return snap.turns.find(t=>t.role==='user'&&t.delivery_id===d.delivery_id&&t.text===d.payload)||null;
  }
  reconcile(id){
    const d=this.delivery(id);
    if(['ACKED','FAILED','DELIVERY_UNKNOWN','RESPONSE_SUPERSEDED'].includes(d.state))return d.state;
    const snap=this.browser.snapshot();
    if(['SUBMITTING','SENT_UNCONFIRMED'].includes(d.state)){
      const receipt=this.exactReceipt(d,snap);
      if(receipt){
        this.db.tx(s=>{const x=s.deliveries[id];this.assertFence(s,x);x.state='DELIVERED';x.user_receipt={identity_key:receipt.identity_key};this.event(s,'DELIVERED',x);});
      }else if(d.send_consumed_at){
        this.db.tx(s=>{const x=s.deliveries[id];this.assertFence(s,x);x.state='DELIVERY_UNKNOWN';this.event(s,'DELIVERY_UNKNOWN',x);});
        return 'DELIVERY_UNKNOWN';
      }
    }
    let current=this.delivery(id);
    if(['DELIVERED','RESPONSE_STARTED','RESPONSE_RECEIVED'].includes(current.state)){
      const fresh=this.browser.snapshot();
      const ownedIndex=fresh.turns.findIndex(t=>t.role==='user'&&t.delivery_id===id);
      if(ownedIndex>=0&&fresh.turns.slice(ownedIndex+1).some(t=>t.role==='user')){
        this.db.tx(s=>{const x=s.deliveries[id];this.assertFence(s,x);if(x.state==='DELIVERED'||x.state==='RESPONSE_STARTED')x.state='RESPONSE_SUPERSEDED';s.tasks.T1.paused=true;this.event(s,'MANUAL_PAUSE',x);});
        return 'RESPONSE_SUPERSEDED';
      }
    }
    current=this.delivery(id);
    if(current.state==='DELIVERED'){
      const fresh=this.browser.snapshot(),candidate=fresh.turns.find(t=>t.role==='assistant'&&t.delivery_id===id);
      if(candidate)this.db.tx(s=>{const x=s.deliveries[id];this.assertFence(s,x);x.state='RESPONSE_STARTED';x.assistant_identity=candidate.identity_key;x.response_text=candidate.text;this.event(s,'RESPONSE_STARTED',x);});
    }
    current=this.delivery(id);
    if(current.state==='RESPONSE_STARTED'){
      const fresh=this.browser.snapshot(),candidate=fresh.turns.find(t=>t.role==='assistant'&&t.delivery_id===id);
      if(candidate&&!fresh.generating)this.db.tx(s=>{const x=s.deliveries[id];this.assertFence(s,x);x.state='RESPONSE_RECEIVED';x.response_text=candidate.text;x.response_hash='hash:'+candidate.text;this.event(s,'RESPONSE_RECEIVED',x);});
    }
    return this.delivery(id).state;
  }
  persistResult(id,status='DONE'){
    this.db.tx(s=>{const d=s.deliveries[id];this.assertFence(s,d);assert.equal(d.state,'RESPONSE_RECEIVED');if(!s.results[id]){s.results[id]={delivery_id:id,status,response_text:d.response_text};this.event(s,'WORKER_RESULT_PERSISTED',d);}});
  }
  ack(id){
    this.db.tx(s=>{const d=s.deliveries[id];this.assertFence(s,d);if(d.state==='ACKED')return;assert.ok(s.results[id]);assert.equal(d.state,'RESPONSE_RECEIVED');d.state='ACKED';this.event(s,'ACKED',d);});
  }
}

function prepareToSubmitting(db,browser,actor='actor-1'){
  const r=new Runtime(db,browser,actor);r.create();r.acquire('D1');r.begin('D1');r.fillOrPause('D1');r.authorize('D1');return r;
}

test('controlled durable store reconstructs after crash after Send without duplicate user turn',()=>{
  const db=new FakeIndexedDb(),browser=new FakeBrowser(),first=prepareToSubmitting(db,browser);
  assert.throws(()=>first.consumeAndSend('D1',{crashAfterSend:true}),/crash after send/);
  assert.equal(first.delivery('D1').state,'SUBMITTING');
  assert.equal(first.delivery('D1').send_consumed_at,1);
  const restartedDb=db.restart(),second=new Runtime(restartedDb,browser,'actor-2');second.acquire('D1');
  assert.equal(second.reconcile('D1'),'DELIVERED');
  assert.equal(browser.sendCount,1);
  assert.equal(browser.snapshot().turns.filter(t=>t.role==='user'&&t.delivery_id==='D1').length,1);
});

test('controlled restart reuses exact router composer but fails closed on foreign draft',()=>{
  const db=new FakeIndexedDb(),browser=new FakeBrowser(),r=new Runtime(db,browser,'actor-1');r.create();r.acquire('D1');r.begin('D1');
  browser.write(r.delivery('D1').payload);
  const db2=db.restart(),r2=new Runtime(db2,browser,'actor-2');r2.acquire('D1');
  assert.equal(r2.fillOrPause('D1'),true);
  assert.equal(r2.delivery('D1').state,'COMPOSER_FILLED');
  const db3=new FakeIndexedDb(),browser2=new FakeBrowser(),x=new Runtime(db3,browser2,'actor-a');x.create();x.acquire('D1');x.begin('D1');browser2.write('human draft');
  const x2=new Runtime(db3.restart(),browser2,'actor-b');x2.acquire('D1');
  assert.equal(x2.fillOrPause('D1'),false);
  assert.equal(x2.delivery('D1').state,'FAILED');
  assert.equal(x2.db.stores.tasks.T1.paused,true);
  assert.equal(browser2.sendCount,0);
});

test('stale actor fence cannot mutate after a replacement actor acquires authority',()=>{
  const db=new FakeIndexedDb(),browser=new FakeBrowser(),old=new Runtime(db,browser,'old');old.create();old.acquire('D1');
  const staleFence=old.fence,newer=new Runtime(db,browser,'new');newer.acquire('D1');
  assert.ok(newer.fence>staleFence);
  assert.throws(()=>old.begin('D1'),e=>e.code==='wave2.lease_stale');
});

test('assistant streaming survives runtime restart and completes without rerunning worker',()=>{
  const db=new FakeIndexedDb(),browser=new FakeBrowser(),r=prepareToSubmitting(db,browser);r.consumeAndSend('D1');r.reconcile('D1');
  browser.assistant(r.delivery('D1'),'partial',{complete:false});
  assert.equal(r.reconcile('D1'),'RESPONSE_STARTED');
  assert.equal(browser.workerRuns,1);
  const r2=new Runtime(db.restart(),browser,'actor-2');r2.acquire('D1');
  assert.equal(r2.reconcile('D1'),'RESPONSE_STARTED');
  browser.assistant(r2.delivery('D1'),'final answer',{complete:true});
  assert.equal(r2.reconcile('D1'),'RESPONSE_RECEIVED');
  assert.equal(browser.workerRuns,1);
});

test('result persistence survives restart and acknowledgement does not rerun worker',()=>{
  const db=new FakeIndexedDb(),browser=new FakeBrowser(),r=prepareToSubmitting(db,browser);r.consumeAndSend('D1');r.reconcile('D1');browser.assistant(r.delivery('D1'),'done',{complete:true});r.reconcile('D1');r.persistResult('D1','DONE');
  const runs=browser.workerRuns,db2=db.restart(),r2=new Runtime(db2,browser,'actor-2');r2.acquire('D1');r2.ack('D1');
  assert.equal(r2.delivery('D1').state,'ACKED');
  assert.equal(browser.workerRuns,runs);
  assert.deepEqual(r2.db.stores.results.D1,{delivery_id:'D1',status:'DONE',response_text:'done'});
});

test('duplicate and dropped observer wakeups are harmless because polling reconciles durable state',()=>{
  const db=new FakeIndexedDb(),browser=new FakeBrowser(),r=prepareToSubmitting(db,browser);r.consumeAndSend('D1');
  for(let i=0;i<8;i++)r.reconcile('D1');
  assert.equal(browser.sendCount,1);
  browser.assistant(r.delivery('D1'),'stream',{complete:false});
  assert.equal(r.delivery('D1').state,'DELIVERED');
  r.reconcile('D1');
  assert.equal(r.delivery('D1').state,'RESPONSE_STARTED');
  browser.assistant(r.delivery('D1'),'complete',{complete:true});
  r.reconcile('D1');
  assert.equal(r.delivery('D1').state,'RESPONSE_RECEIVED');
  assert.equal(browser.sendCount,1);
});

test('manual user turn after owned receipt pauses durably across a fresh runtime',()=>{
  const db=new FakeIndexedDb(),browser=new FakeBrowser(),r=prepareToSubmitting(db,browser);r.consumeAndSend('D1');r.reconcile('D1');
  browser.manualUser('manual interruption');
  assert.equal(r.reconcile('D1'),'RESPONSE_SUPERSEDED');
  const db2=db.restart(),r2=new Runtime(db2,browser,'actor-2');
  assert.equal(r2.db.stores.tasks.T1.paused,true);
  assert.equal(r2.delivery('D1').state,'RESPONSE_SUPERSEDED');
  assert.equal(browser.sendCount,1);
});

test('ambiguous consumed SUBMITTING becomes immutable unknown after reconstruction',()=>{
  const db=new FakeIndexedDb(),browser=new FakeBrowser(),r=prepareToSubmitting(db,browser);
  db.tx(s=>{s.deliveries.D1.send_consumed_at=1;});
  const db2=db.restart(),r2=new Runtime(db2,browser,'actor-2');r2.acquire('D1');
  assert.equal(r2.reconcile('D1'),'DELIVERY_UNKNOWN');
  const sends=browser.sendCount;
  assert.equal(r2.reconcile('D1'),'DELIVERY_UNKNOWN');
  assert.equal(browser.sendCount,sends);
  assert.equal(r2.delivery('D1').state,'DELIVERY_UNKNOWN');
});
