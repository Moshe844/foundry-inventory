'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 208 across every trained job: a run of identical approvals in a job's
// own records becomes that job's own taught rule after one owner confirmation.
test('job 208: trained jobs learn from a run of approvals through their own teaching path, on the plans that train them',{timeout:420000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,subscribe,browser}=f;
 const learning=require('../../src/autopilot/approval-learning'),registry=require('../../src/autopilot/learning-adapters');
 const policy=require('../../src/commercial/agent-plan'),modes=require('../../src/autopilot/job-modes'),autonomy=require('../../src/autopilot/postgres-service');
 await subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const sku=f.item.skuIds[0],ws=ctx.workspaceId;
 // Catalogue fixes (job 126, trained on Pro): SKU fixes the owner approved.
 const fix=async(minutes,{status='DONE',typed=false,automatic=false}={})=>{const id=randomUUID();
  await db.query(`INSERT INTO stockchief_runtime.agent_catalog_fixes(id,workspace_id,kind,sku_id,status,details,fingerprint,automatic,decided_by,applied,decided_at)
   VALUES($1,$2,'SKU',$3,$4,$5,$1,$6,$7,$8,now()-make_interval(mins=>$9))`,[id,ws,sku,status,JSON.stringify(typed?{}:{after:'FX-1'}),automatic,ctx.actorId,
   ['DONE','UNDONE'].includes(status)?'{}':null,minutes]);return id;};
 const ours=async()=>(await learning.offers(db,ctx)).filter(o=>o.source==='job:126');

 // Three approvals, a "no", then four approvals: not yet a run.
 for(const m of [300,290,280])await fix(m);
 await fix(270,{status:'DISMISSED'});
 const run=[];for(const m of [260,250,240,230])run.push(await fix(m));
 assert.equal((await ours()).length,0,'Four approvals after a no are not a run');
 // A value the owner typed themselves always needs a person: it neither counts nor breaks the run.
 await fix(225,{typed:true});
 assert.equal((await ours()).length,0);
 // Work StockChief did on its own never counts.
 await fix(222,{automatic:true});
 run.push(await fix(220));
 let offers=await ours();assert.equal(offers.length,1);let offer=offers[0];
 assert.equal(offer.run,5);assert.equal(offer.job,126);assert.equal(offer.latestId,run.at(-1));assert.equal(offer.label,'Catalogue fixes: SKUs');
 const perDay={};for(const id of run){const d=(await db.query('SELECT decided_at FROM stockchief_runtime.agent_catalog_fixes WHERE id=$1',[id])).rows[0].decided_at.toISOString().slice(0,10);perDay[d]=(perDay[d]||0)+1;}
 const daily=Math.max(...Object.values(perDay));
 assert.equal(offer.limit,'up to '+daily+' a day','The daily limit is the most approvals in one day of the run');
 // Job 210 alongside: what the rule would have done with every answer in this scope.
 assert.match(offer.test.sections[0].summary,/You approved this 5 times in a row/);
 assert.equal(offer.test.sections[0].rows.filter(r=>/you said no/.test(r['Would have'])).length,1);
 assert.equal(offer.test.sections[0].rows.filter(r=>/always needs a person/.test(r['Would have'])).length,1);

 // Each plan follows its own mode for this job.
 await subscribe('growth');assert.equal((await ours()).length,0,'Growth drafts catalogue fixes; there is nothing it can learn');
 await subscribe('enterprise');assert.equal((await ours()).length,0,'Custom fixes alone without training');
 await subscribe('starter');await assert.rejects(learning.offers(db,ctx),e=>e.code==='entitlement_required');await browser.get(learning.path).expect(402);
 await subscribe('pro');

 // Ask me first for the job, Watch only for the inventory and the first 14 days: it keeps asking.
 await modes.save(db,ctx,126,{mode:'ask',revision:0});assert.equal((await ours()).length,0,'Ask me first means keep asking');
 await modes.save(db,ctx,126,{mode:'watch',revision:1});assert.equal((await ours()).length,0,'Watch only for the job');
 await modes.save(db,ctx,126,{mode:'inherit',revision:2});
 await autonomy.setMode(db,ctx,{role:'owner'},'OBSERVE');
 assert.equal((await ours()).length,0,'Watch only for the inventory');
 assert.match((await browser.get(learning.path).expect(200)).text,/data-learning-watching/);
 await autonomy.setMode(db,ctx,{role:'owner'},'SUPERVISED');
 await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
 assert.equal((await ours()).length,0,'Nothing is learned while StockChief only watches');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);

 // Keep asking holds until a new run of approvals.
 await learning.dismiss(db,ctx,{latestId:offer.latestId,source:'job:126'});
 assert.equal((await ours()).length,0);
 for(const m of [200,190,180,170])await fix(m);
 assert.equal((await ours()).length,0,'Four new approvals after keep asking are not a run');
 const latest=await fix(160);
 offers=await ours();assert.equal(offers.length,1);offer=offers[0];assert.equal(offer.latestId,latest);

 // The page shows the offer and its test; one confirmation saves the job's own rule.
 const page=await browser.get(learning.path).expect(200);
 assert.match(page.text,/Catalogue fixes: SKUs/);assert.match(page.text,/data-rule-test/);assert.match(page.text,/name="source" value="job:126"/);
 const csrf=f.csrf(page.text);
 await browser.post(learning.path+'/confirm').type('form').send({_csrf:csrf,latestId:offer.latestId,source:'job:126',maximum:'changed'});
 await assert.rejects(learning.confirm(db,ctx,{latestId:offer.latestId,source:'job:126',maximum:'0'}),/changed since you saw it/);
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_catalog_fix_rules WHERE workspace_id=$1',[ws])).rows[0].n,0,'A changed offer saves nothing');
 await browser.post(learning.path+'/confirm').type('form').send({_csrf:csrf,latestId:offer.latestId,source:'job:126',maximum:offer.token}).expect(303);
 const rule=(await db.query("SELECT daily_limit,example_fix_id,authorized_by,enabled FROM stockchief_runtime.agent_catalog_fix_rules WHERE workspace_id=$1 AND kind='SKU'",[ws])).rows[0];
 assert.equal(rule.authorized_by,ctx.actorId);assert.equal(rule.enabled,true);assert.equal(rule.example_fix_id,latest,'Taught from the newest approval, through the job’s own limit page');
 const audits=(await db.query(`SELECT action FROM security_event_history WHERE workspace_id=$1 AND action IN ('Catalog fix limit saved','Stopped asking about a routine you always approved')`,[ws])).rows.map(r=>r.action).sort();
 assert.deepEqual(audits,['Catalog fix limit saved','Stopped asking about a routine you always approved']);
 // A replay saves nothing new, and the routine is never offered again over its rule.
 assert.equal((await learning.confirm(db,ctx,{latestId:offer.latestId,source:'job:126',maximum:offer.token})).replayed,true);
 for(const m of [100,90,80,70,60])await fix(m);
 assert.equal((await ours()).length,0,'An existing rule is never raised');
 assert.match((await browser.get(learning.path).expect(200)).text,/Catalogue fixes: SKUs/);
 assert.equal(await f.balance(),20,'Learning changes no stock');

 // Every adapter reads and offers against a real database on the plans that
 // train its jobs, without a database error, even with no records of its own.
 const state=await policy.accountState(db,ws),loc=f.location.id,owner=ctx.actorId;
 const samples={
  'job:5':{scope:'sheet|'+loc+'|h',value:3,data:{format:'sheet',location_ids:[loc],layout_hash:'h',status:'POSTED'}},
  'job:9':{scope:'MOVE',data:{kind:'MOVE',quantity:'2',details:{since:120}}},
  'job:11':{scope:'scope',value:2,data:{source:{sku:'A',from:{id:loc,name:'A'},to:{id:loc,name:'B'},quantity:2}}},
  'job:47':{scope:sku+'|'+loc,value:2,data:{source:{skuId:sku,sku:'A',from:{id:loc,name:'A'},to:{id:loc,name:'B'},quantity:2}}},
  'job:51':{scope:'policy',variant:'[]',data:{status:'PASSED'}},
  'job:57':{scope:loc,value:3,data:{place:'Dispatch'}},
  'job:118':{scope:'scope',value:'2',data:{payload:{skuId:sku,sourceId:loc,destinationId:loc,quantity:'2',balanceSummary:{title:'A'}}}},
  'job:120':{scope:sku+'|'+loc,value:'5',data:{sku_id:sku,ev:{locationId:loc,maximum:'5',profileKey:'p'},headline:'A'}},
  'job:126':{scope:'WEIGHT',data:{}},
  'job:132:supplier':{scope:'fixture-supplier',value:2,data:{}},
  'job:132:dead-stock':{scope:'dead-stock',data:{}},
  'job:29':{scope:'fixture-supplier|c',value:3,data:{supplier_id:'fixture-supplier',connector:'c',supplier:'S',follow_up_days:2}},
  'job:31':{scope:'scope',value:{shift:1,total:1,future:5,first:false},data:{snap:{supplierId:'fixture-supplier',supplierName:'S',destinationName:'D',scope:{destinationLocationId:loc,currency:'USD',products:[{skuId:sku}]}}}},
  'job:38':{scope:'rule',variant:'h',value:100,data:{}},
  'job:42':{scope:'contract',value:5,data:{releaseId:'release'}},
  'job:45':{scope:'scope',value:100,data:{snapshot:{remedy:'credit',supplierId:'fixture-supplier',supplierName:'S',skuId:sku,sku:'A',locationId:loc,location:'D',totalMinor:100,currency:'USD',ageDays:3,damagedQuantity:1,photos:[]}}},
  'job:93':{scope:'rule',data:{}},
  'job:95':{scope:'rule|late',value:100,data:{rule_id:'rule',facts:{terms:{amount:100}}}},
  'job:96':{scope:'scope',data:{changes:[{field:'lead_time_days',value:5,before:3}],snap:{supplierName:'S'}}},
  'job:115':{scope:'fixture-supplier|'+loc+'|USD',value:100,data:{supplier_id:'fixture-supplier',place:loc,caseId:'case',evidence:{currency:'USD',expected:100,lines:[{locationId:loc}]}}},
  'job:63':{scope:'scope',value:100,data:{facts:{amountMinor:100,coverageMinor:200,type:'lost',number:'S1'},confirmed:true}},
  'job:71':{scope:loc+'|fleet',value:3,data:{depot_id:loc,fleet_key:'fleet',depot:'D'}},
  'job:78':{scope:'all',data:{draft_id:'draft'}},
  'job:83':{scope:'page|none',data:{page_id:'page',source_hash:'h',snapshot:{input:{lines:[]}}}},
  'job:101':{scope:'fixture-customer|USD',value:'100',data:{customer_id:'fixture-customer',currency:'USD'}},
  'job:111':{scope:'scope',value:1,data:{snap:{customerName:'C',lines:[{code:'A',quantity:1}]}}},
  'job:113':{scope:sku+'|unopened',value:1,data:{observation:{skuId:sku,sku:'A',conditionCode:'unopened'},line:{outcome:'RESTOCK',destinationId:loc},inspector:owner,assessmentId:'a'}}
 };
 const sqlError=e=>typeof e?.code==='string'&&/^[0-9A-Z]{5}$/.test(e.code);
 for(const plan of ['growth','pro']){
  await subscribe(plan);
  await learning.offers(db,ctx);
  const planState={...state,...await policy.accountState(db,ws)};
  for(const adapter of registry.adapters.filter(a=>!['draft-routines','warehouse.release_orders'].includes(a.kind))){
   const sample=samples[adapter.kind];assert(sample,'a sample run for '+adapter.kind);
   if(!adapter.jobs.some(j=>policy.allowance(plan,j)==='trained'))continue;
   await adapter.history(db,ctx,{days:90,state:planState,jobs:adapter.jobs});
   const rows=[1,2,3,4,5].map(n=>({id:'x'+n,scope:sample.scope,at:new Date(Date.now()-n*60000),declined:false,needsPerson:false,variant:sample.variant??null,value:sample.value??null,data:sample.data}));
   const run={kind:adapter.kind,scope:sample.scope,job:adapter.jobs[0],rows,all:rows,latest:rows[0],first:rows.at(-1),variant:sample.variant??null};
   try{await adapter.offer(db,ctx,{state:planState,run});}catch(e){assert(!sqlError(e),adapter.kind+' offer: '+e.message);}
  }
 }
});
