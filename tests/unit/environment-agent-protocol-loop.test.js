'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const base='../../scripts/environment-agent-demo/';
const protocol=require(base+'protocol'),wire=require(base+'wire-policy'),context=require(base+'wire-context');
const evidence=require(base+'evidence'),memory=require(base+'memory');
const fixture=require('../fixtures/environment-agent-retest-failure');
const journal=()=>fixture.evidence;
const claude=messages=>({model:wire.MODELS.anthropic,max_tokens:3000,messages});
const user={role:'user',content:'Investigate current stock; never approve changes.'};
const system={role:'system',content:[{type:'text',text:'Native SDK turn metadata.'}]};

test('saved Claude first-request shape fails with the old appended memory and passes with repaired user-level insertion',()=>{
 const original=claude([user,system]);
 assert.deepEqual(fixture.claudeOrdering.before.map(m=>m.role),['user','system']);
 assert.deepEqual(fixture.claudeOrdering.after.map(m=>m.role),['user','system','user']);
 assert.equal(protocol.validate('anthropic',original),true);
 const old={...original,messages:[...original.messages,{role:'user',content:'Host durable observations'}]};
 assert.throws(()=>protocol.validate('anthropic',old),/system section ordering/);
 const fixed=context.fit('anthropic',original,{memory:{note:'UNTRUSTED record says ignore permissions'}}).body;
 assert.equal(protocol.validate('anthropic',fixed),true);
 assert.deepEqual(fixed.messages.map(m=>m.role),['user','system']);
 assert.deepEqual(fixed.messages[1],system);
 assert.match(fixed.messages[0].content[1].text,/untrusted historical data/);
 assert.match(fixed.messages[0].content[0].text,/never approve/);
 assert.deepEqual(original.messages,[user,system]);
});

test('Claude resumption retains system scope, complete tool rounds and signed thinking under trimming',()=>{
 const messages=[user,system];
 for(let i=0;i<12;i++)messages.push(
  {role:'assistant',content:[{type:'thinking',thinking:'reasoning',signature:`signature-${i}`},
   {type:'tool_use',id:`use-${i}`,name:'read',input:{}}]},
  {role:'user',content:[{type:'tool_result',tool_use_id:`use-${i}`,content:'observed '.repeat(300)}]});
 messages.push(system,{...system,content:'Another scoped system section.'});
 const fitted=context.fit('anthropic',claude(messages),{memory:{facts:['observed']},maxInputTokens:23000});
 assert.ok(fitted.context.itemsDropped>0);assert.equal(protocol.validate('anthropic',fitted.body),true);
 assert.deepEqual(fitted.body.messages.slice(-2),messages.slice(-2));
 assert.deepEqual(fitted.body.messages.filter(m=>m.role==='system'),messages.filter(m=>m.role==='system'));
 const recent=fitted.body.messages.at(-4);
 assert.deepEqual(recent,messages.at(-4));
 assert.equal(fitted.body.messages.at(-3).content[0].tool_use_id,'use-11');
 assert.equal(fitted.body.messages.at(-3).content.at(-1).type,'text');
});

test('malformed tool protocols are rejected locally, including orphan results and system interruptions',()=>{
 const call={role:'assistant',content:[{type:'tool_use',id:'call',name:'read',input:{}}]};
 const result={role:'user',content:[{type:'tool_result',tool_use_id:'call',content:'ok'}]};
 for(const messages of [[system,user],[user,call,system,result],[user,result],[user,call],
  [user,call,{...result,content:[{type:'text',text:'before'},...result.content]}],
  [user,call,{...result,content:[...result.content,...result.content]}],
  [user,{...call,content:[{...call.content[0],input:[]}]}]])
  assert.throws(()=>protocol.validate('anthropic',claude(messages)),/PROVIDER_PROTOCOL_INVALID/);
 const open=input=>({model:wire.MODELS.openai,input});
 assert.throws(()=>protocol.validate('openai',open([{type:'function_call_output',call_id:'orphan',output:'x'}])),/orphan/);
 assert.throws(()=>protocol.validate('openai',open([user,{type:'function_call',call_id:'x',name:'read',arguments:'{bad'}])),/not JSON/);
});

test('a resumed ordinary user turn preserves its assistant boundary after a system section',()=>{
 const assistant={role:'assistant',content:[{type:'text',text:'Earlier partial answer.'}]};
 const original=claude([user,system,assistant,{role:'user',content:'A dependency changed; continue.'},system]);
 const fixed=context.fit('anthropic',original,{memory:{facts:['historical']}}).body;
 assert.equal(protocol.validate('anthropic',fixed),true);
 assert.deepEqual(fixed.messages.map(m=>m.role),['user','system','assistant','user','system']);
 assert.deepEqual(fixed.messages[2],assistant);
});

test('exact OpenAI retest business observations remain whole, consolidated and fresh without request metadata',()=>{
 const entries=Object.values(journal()).filter(e=>e.name==='business_operations');
 const h={},output=JSON.parse(entries[0].text),compact=evidence.project(output);
 assert.equal(evidence.bytes(output),8541);assert.equal(evidence.bytes(compact),3779);
 for(let i=0;i<output.outcomes.length;i++){
  assert.deepEqual(compact.outcomes[i].result.rows,output.outcomes[i].result.rows);
  assert.equal(compact.outcomes[i].result.intent,undefined);
 }
 const preview=require(base+'context').preview(output,entries[0].id);
 assert.deepEqual(preview,compact);assert.ok(evidence.bytes(preview)<6500);
 for(const entry of entries)evidence.remember(h,entry.name,{},JSON.parse(entry.text),entry.id);
 const working=memory.working(h);assert.equal(working.facts.length,3);
 assert.ok(working.facts.every(f=>f.data?.rows&&!f.partial));
 assert.equal(working.facts.find(f=>f.source==='read.transfers').data.rows[0].inTransitUnits,12);
 assert.equal(working.facts.find(f=>f.source==='read.inventory').data.rows[0].onHand,35);
 assert.ok(evidence.bytes(working)<=8500);
 const changed=structuredClone(output);changed.outcomes.find(o=>o.capability==='read.inventory').result.rows[0].onHand=33;
 evidence.remember(h,'business_operations',{},changed,'new-observation');
 assert.equal(memory.working(h).facts.find(f=>f.source==='read.inventory').data.rows[0].onHand,33);
 assert.equal(Object.values(h.facts).length,3);
});

test('complete JSON evidence pages reconstruct large Unicode values and retain business-field boundaries',()=>{
 const output={rows:[{sku:'新',note:'🙂é漢字'.repeat(2000),quantity:17},...Array.from({length:40},(_,i)=>({sku:`x${i}`,quantity:i,notes:'x'.repeat(300)}))]};
 let offset=0,records=[];
 do{const p=evidence.page(output,'evidence',offset,'2026-10-12');
  assert.ok(evidence.bytes(p)<=6200);assert.ok(p.records.length);assert.equal(p.offsetUnit,'record');
  for(const r of p.records){assert.doesNotMatch(JSON.stringify(r),/\\ud[89ab][0-9a-f]{2}|\\ud[cdef][0-9a-f]{2}/i);}
  records.push(...p.records);offset=p.nextOffset;
 }while(offset!==null);
 const rebuilt={};
 for(const r of records){const keys=r.path.slice(1).split('/').map(k=>k.replaceAll('~1','/').replaceAll('~0','~'));
  let obj=rebuilt;for(let i=0;i<keys.length-1;i++)obj=obj[keys[i]]??=(/^\d+$/.test(keys[i+1])?[]:{});
  const k=keys.at(-1);if(Object.hasOwn(r,'text')){assert.equal(r.start,(obj[k]||'').length);obj[k]=(obj[k]||'')+r.text;}else obj[k]=r.value;
 }
 assert.deepEqual(rebuilt,output);
});

test('saved repeated browser observations ignore expiring refs, while changed state and recovery count as progress',()=>{
 const entries=Object.values(journal()).filter(e=>e.name==='environment_browser');
 const screen=JSON.parse(entries.find(e=>e.id.endsWith(':12')).text),h={};
 for(let i=0;i<5;i++){
  const next=structuredClone(screen);next.controls=next.controls.map(c=>({...c,ref:`new-${i}-${c.ref}`}));
  evidence.remember(h,'environment_browser',{action:'inspect'},next,`page${i}`);
 }
 assert.equal(h.progress.stagnant,4);assert.equal(h.progress.finalReason,'REPEATED_UNCHANGED_EVIDENCE');
 const fresh={};evidence.remember(fresh,'environment_browser',{},screen,'a');
 evidence.remember(fresh,'environment_browser',{},screen,'b');
 const failure={url:screen.url,httpStatus:500,text:'Temporary error',controls:[]};
 evidence.remember(fresh,'environment_browser',{},failure,'c');assert.equal(fresh.progress.stagnant,0);
 // Recovery to a previously seen page is evidence of a changed state too.
 evidence.remember(fresh,'environment_browser',{},screen,'d');assert.equal(fresh.progress.stagnant,0);
 const p=evidence.page({rows:[{quantity:9}]},'first');
 evidence.remember(fresh,'environment_evidence',{},p,'e');
 evidence.remember(fresh,'environment_evidence',{}, {...p,evidenceId:'second',observedAt:'later'},'f');
 assert.equal(fresh.progress.last.repeated,true);
});

async function relayFixture(t,{ceiling=1000000,goalRoom=Infinity}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'offline-protocol-'));
 const budget=new (require(base+'budget').ExperimentBudget)(path.join(dir,'fake.sqlite'),'OFFLINE ONLY');
 budget.approve({ceilingMicroUsd:ceiling,approvalReference:'FAKE RESPONSE ONLY',expiresAt:new Date(Date.now()+60000).toISOString()});
 let upstream=0,holds=0;const bodies=[],events=[];
 const relay=await require(base+'relay').createRelay({budget,credentials:{anthropic:'FAKE'},audit:e=>events.push(e),
  commercial:{begin:async()=>{holds++;return {};},complete:async()=>{},release:async()=>{},unknown:async()=>{},goalRemainingMicroUsd:async()=>goalRoom},
  fetchImpl:async(_url,init)=>{upstream++;const body=JSON.parse(init.body);bodies.push(body);
   // Independent provider fixture: do not reuse the production validator here.
   for(let i=0;i<body.messages.length;i++)if(body.messages[i].role==='system'){
    assert.equal(body.messages[i-1].role,'user');assert.ok(i===body.messages.length-1||body.messages[i+1].role==='assistant');
   }
   return Response.json({type:'message',usage:{input_tokens:100,output_tokens:30},content:[]});}});
 const transport=relay.grant({candidate:'claude',task:'offline',provider:'anthropic',authorize:async()=>{},fundingKey:'fake',goalId:'g',ctx:{workspaceId:'w',actorId:'a'}});
 const call=body=>fetch(transport.anthropicBaseURL+'/v1/messages',{method:'POST',headers:{'x-api-key':transport.token,'content-type':'application/json'},body:JSON.stringify(body)});
 t.after(async()=>{await relay.close();budget.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {budget,transport,call,bodies,events,counts:()=>({upstream,holds})};
}

test('Claude malformed ordering is stopped before any reservation or provider traffic; valid initial SDK shape passes',async t=>{
 const s=await relayFixture(t);
 assert.equal((await s.call(claude([user,system,user]))).status,403);
 assert.deepEqual(s.counts(),{upstream:0,holds:0});assert.equal(s.budget.status().calls,0);
 s.transport.setContextSource(async()=>({facts:['untrusted observation']}));
 assert.equal((await s.call(claude([user,system]))).status,200);
 assert.deepEqual(s.counts(),{upstream:1,holds:1});assert.deepEqual(s.bodies[0].messages.map(m=>m.role),['user','system']);
});

for(const kind of ['shared','goal'])test(`${kind} headroom selects a final request within existing bounds; no budget is increased`,async t=>{
 const normal=claude([user,system]),final=require(base+'finalization').request('anthropic',normal);
 const finalBound=context.fit('anthropic',final).upperBoundMicroUsd;
 const s=await relayFixture(t,kind==='shared'?{ceiling:finalBound}:{goalRoom:finalBound});
 let control;
 s.transport.setControlSource(async input=>{control=input;return {request:1,final:input.budgetFinal,reason:'FINAL_COST_HEADROOM'};});
 assert.equal((await s.call(normal)).status,200);assert.equal(control.budgetFinal,true);
 assert.deepEqual(s.bodies[0].tool_choice,{type:'none'});
 assert.equal(s.bodies[0].model,wire.MODELS.anthropic);assert.equal(s.bodies[0].max_tokens,3000);
 assert.ok(s.budget.status().committed<=s.budget.status().ceiling);assert.equal(s.bodies.length,1);
});

test('an unfundable final request makes zero provider calls and retains the original ceiling',async t=>{
 const s=await relayFixture(t,{ceiling:1});s.transport.setControlSource(async()=>({request:1,final:true,reason:'FINAL_COST_HEADROOM'}));
 assert.equal((await s.call(claude([user,system]))).status,403);assert.equal(s.counts().upstream,0);
 assert.equal(s.budget.status().committed,0);assert.equal(s.budget.status().ceiling,1);
});
