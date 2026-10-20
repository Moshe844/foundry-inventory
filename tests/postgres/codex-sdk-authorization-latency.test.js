'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('native bookkeeping avoids repeated catalogue construction while retaining fresh authority and full execution checks',{timeout:90000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Latency test',businessName:'Latency fixture',email:randomUUID()+'@example.test',password:'Fake!'+randomUUID()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId},store=require('../../src/assistant/postgres-goal-store');
 const goal=await store.claim(db,ctx,(await store.create(db,ctx,'Investigate an unfamiliar business question.')).id);
 let queries=0;const measured={...db,query:async(...args)=>{queries++;return db.query(...args);}};
 const gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:measured,ctx,goal:goal.original_request,goalId:goal.id,runToken:goal.run_token});
 queries=0;const full=await gateway.authorize(),fullQueries=queries;assert(full.catalogue.list().length);
 const initial=await gateway.initialContracts(),codec=require('../../scripts/environment-agent-demo/interface-presentation');
 t.diagnostic(JSON.stringify({initialBytes:Buffer.byteLength(JSON.stringify(codec.compact(initial))),deliveredDatasets:initial.datasetIndex.filter(d=>d.fields).map(d=>d.name),deliveredReads:initial.operations.filter(c=>c.fields).map(c=>c.name)}));
 assert(Buffer.byteLength(JSON.stringify(codec.compact(initial)))<=18000,'The complete actually delivered metadata stays inside the unchanged bound');
 assert.deepEqual(codec.expand(codec.compact(initial)),initial,'Packing changes no contract, field or authority fact');
 assert.deepEqual(Object.entries(initial.operationIndex).flatMap(([kind,names])=>names.map(name=>({name,kind}))).sort((a,b)=>a.name.localeCompare(b.name)),
  full.catalogue.list().map(({name,kind})=>({name,kind})).sort((a,b)=>a.name.localeCompare(b.name)),
  'Grouping the complete operation index must lose no authorized contract');
 const reportRegistry=require('../../src/reports/postgres-registry');
 assert.deepEqual(initial.datasetIndex.map(({name,label,detailsByName})=>({name,label,detailsByName})),
  reportRegistry.list(full.actor).map(({key:name,label})=>({name,label,detailsByName:true})),
  'Recorded live invoice discovery must see every authorized dataset before the first model call');
 for(const dataset of initial.datasetIndex)if(dataset.fields)
  assert.deepEqual(dataset.fields,reportRegistry.list(full.actor).find(d=>d.key===dataset.name).fields);
 assert(initial.datasetIndex.some(d=>d.name==='customer_invoices'));
 assert.equal(initial.datasetFieldsComplete,initial.datasetIndex.every(d=>Boolean(d.fields)));
 assert(initial.datasetIndex.filter(d=>d.fields).length>=10,'Compact dataset schemas must not be starved by long operation descriptions');
 for(const name of ['suppliers','customers','payments'])assert(initial.datasetIndex.find(d=>d.name===name)?.fields,'Ordinary directory and financial schemas are available without paid rediscovery: '+name);
 assert(!JSON.stringify(initial.datasetIndex).includes('SELECT '),'SQL implementation is never interface metadata');
 assert(initial.operations.some(c=>c.name==='read.payments'&&c.fields),'Recorded live cash investigation must not lose its read contract by measuring the uncompressed intermediate representation');
 const navigation=full.catalogue.list().filter(c=>c.kind==='navigation');
 assert.deepEqual(initial.recordCollections,await gateway.collections());
 for(const [name,collection]of Object.entries(initial.recordCollections)){
  const contract=full.catalogue.get(name);assert(contract?.recordKind);
  assert.deepEqual({href:collection.href,label:collection.label},require('../../src/web/postgres-record-destinations').RECORDS[contract.recordKind].collection);
  assert.equal(collection.recordReferenceRequired,true,'Owning lists never supply the missing identifier for an individual record');
 }
 assert.equal(Object.keys(initial.recordCollections).length,navigation.filter(c=>c.recordKind).length);
 assert.deepEqual(initial.navigationSignatures.flatMap(s=>s.names).sort(),navigation.map(c=>c.name).sort(),'All authorized navigation signatures are available without another discovery round');
 for(const group of initial.navigationSignatures)for(const name of group.names){
  const current=(await gateway.interfaces({names:[name]})).operations.find(c=>c.name===name);
  assert(current);for(const field of ['required','fields','authority','unavailable'])assert.deepEqual(group[field],current[field]);
 }
 t.diagnostic(JSON.stringify({initialBytes:Buffer.byteLength(JSON.stringify(codec.compact(initial))),initialDatasetSchemas:initial.datasetIndex.filter(d=>d.fields).length,navigationContractsSupplied:navigation.length,navigationSignatures:initial.navigationSignatures.length}));
 queries=0;const fresh=await gateway.authorize({catalogue:false}),lightQueries=queries;
 assert.deepEqual(fresh.actor,full.actor);assert.equal(fresh.catalogue,undefined);
 assert(fullQueries<=lightQueries+5,'One catalogue snapshot, not a subscription lookup per capability: '+JSON.stringify({fullQueries,lightQueries}));
 let transactions=0;const sessionDb={...db,transaction:(...args)=>{transactions++;return db.transaction(...args);}};
 const calls=[];const session=require('../../scripts/environment-agent-demo/session').createSession({database:sessionDb,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:settings=>{calls.push(settings);return gateway.authorize(settings);}});
 // The live trace crossed twelve model rounds and seventeen tool rounds.
 // Repeat native checkpoint boundaries at that scale without inference.
 for(let index=0;index<17;index++){await session.load();await session.checkpoint({browserStep:index});}
 const packet={status:200,contentType:'application/json',body:'{}',outcome:{terminal:false,tool:true}};
 for(let index=0;index<12;index++){await session.codexRequest();await session.codexPending('round-'+index);await session.codexDelivered('round-'+index,packet,packet.outcome);}
 assert.equal(transactions,17*2+12*3,'Authority stamps commit with their protected checkpoint, not in separate transactions');
 assert(calls.every(c=>c.catalogue===false));
 assert.equal(calls.length,17+12*2,'Native checkpoints and settled response persistence keep fresh actor/lease validation without another commercial admission');
 const requestAccess=await gateway.authorize({catalogue:false}),admissions=calls.length;
 await session.codexPending('same-http-boundary',requestAccess);
 assert.equal(calls.length,admissions,'Pending delivery uses only this HTTP request\'s fresh admission');
 await session.codexDelivered('same-http-boundary',packet,packet.outcome);
 let browserReads=0;
 const tools=require('../../scripts/environment-agent-demo/candidates').sharedTools({gateway,session,browser:{act:async()=>{browserReads++;return {url:'http://isolated/',text:'Observed records'};}},sandbox:{}});
 queries=0;transactions=0;await tools.find(t=>t.name==='environment_browser').execute({action:'inspect',ref:null,value:null});const browserQueries=queries;
 assert.equal(transactions,2,'Tool admission and durable result; evidence presentation adds no transaction');
 assert(calls.every(c=>c.catalogue===false),'Real shared browser tool path avoids every full catalogue rebuild');
 assert(browserQueries<=lightQueries*2,'Current authority is checked before execution and before releasing evidence');
 const visual={image:{data:'offline-only',mimeType:'image/png'},screen:{url:'http://isolated/',text:'Complete observed inventory'}};
 await session.execute('environment_browser',{action:'visual'},async()=>visual);
 const shown=await session.present(visual,{full:true});assert.equal(shown.screen._stockchiefEvidence.valuePointerPrefix,'/screen');
 transactions=0;await session.evidenceIndex();await session.evidence({id:shown.screen._stockchiefEvidence.evidenceId,offset:0});
 assert.equal(transactions,0,'Retrieving evidence does not rewrite the entire SDK checkpoint');
 const saved=await session.load();assert.equal(JSON.parse(saved.evidence[shown.screen._stockchiefEvidence.evidenceId].text).screen.text,visual.screen.text);
 assert.equal(shown.screen._stockchiefEvidence.complete,true);
 // Historical sessions stored the screen alone. The reference must describe
 // that persisted value, rather than the newer image wrapper presented now.
 const legacy={...visual,screen:{url:'http://isolated/earlier',text:'Earlier observed inventory'}};
 await session.execute('environment_browser',{action:'legacy'},async()=>legacy.screen);
 assert.equal((await session.present(legacy,{full:true})).screen._stockchiefEvidence.valuePointerPrefix,'');
 assert.equal((await session.present(legacy.screen,{full:true}))._stockchiefEvidence.valuePointerPrefix,'');
 queries=0;await tools.find(t=>t.name==='environment_interfaces').execute({search:'policy',names:[],offset:0});const interfaceQueries=queries;
 assert(interfaceQueries<=fullQueries+lightQueries*2,'Discovery builds one catalogue with fresh execution/delivery authority checks');
 const discovered=await gateway.interfaces({search:'products catalog inventory',offset:0,names:[]});
 assert(discovered.operations.length||discovered.datasets.length,'Recorded multiword search returns usable related interfaces');
 assert(discovered.datasets.length,'Related governed datasets remain discoverable');
 assert(discovered.datasets.every(dataset=>dataset.detailsByName),'Discovery advertises exact-name retrieval of complete schemas');
 const detailed={datasets:[]},datasetNames=discovered.datasets.map(dataset=>dataset.name);
 for(let offset=0;offset<datasetNames.length;offset+=6){
  const page=await gateway.interfaces({names:datasetNames.slice(offset,offset+6),offset:0});detailed.datasets.push(...page.datasets);
 }
 for(const dataset of discovered.datasets){
  const contract=detailed.datasets.find(entry=>entry.name===dataset.name);
  assert(contract?.queryContract,'Every discovered dataset has a retrievable query contract: '+dataset.name);
  assert(Object.keys(contract.queryContract).length,'Exact-name lookup preserves the actual query schema');
 }
 assert(discovered.operations.every(operation=>operation.fields||operation.detailsByName));
 const names=new Set();let offset=0;
 do{const page=await gateway.interfaces({search:'',offset,names:[]});
  assert(Buffer.byteLength(JSON.stringify(page.operations))<18500,'Discovery contract pages remain bounded');
  for(const operation of page.operations){assert(!names.has(operation.name));names.add(operation.name);}
  offset=page.nextOffset;
 }while(offset!==null);
 assert.equal(names.size,full.catalogue.list().length,'Byte pagination keeps every authorized operation discoverable');
 await session.execute('business_operations',{stepsJson:JSON.stringify([{capability:'read.operating_rules',arguments:[],dependsOn:[]}])},async()=>({outcomes:[]}));
 assert(calls.some(c=>c.catalogue===true),'Business operations retain fresh catalogue validation');
 t.diagnostic(JSON.stringify({fullQueries,lightQueries,browserQueries,interfaceQueries}));
 await assert.rejects(session.executePresented('environment_browser',{action:'inspect'},async()=>{
  await db.query("UPDATE users SET permissions='{}'::jsonb,role='member' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
  return {text:'Must not release this after permission revocation'};
 },{full:true}),/SESSION_AUTHORITY_CHANGED/);
 await db.query("UPDATE users SET permissions='{}'::jsonb,role='member' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
 await assert.rejects(session.load(),/SESSION_AUTHORITY_CHANGED/);
 await assert.rejects(session.checkpoint({codex:{threadId:'must-not-save'}}),/SESSION_AUTHORITY_CHANGED/);
 const beforeReads=browserReads;
 await assert.rejects(tools.find(t=>t.name==='environment_browser').execute({action:'inspect',ref:null,value:null}),/SESSION_AUTHORITY_CHANGED/);
 assert.equal(browserReads,beforeReads,'Revoked authority fails before browser inspection even without the redundant wrapper check');
 await store.cancel(db,ctx,goal.id);
 await assert.rejects(gateway.authorize({catalogue:false}),/not held/);
});
