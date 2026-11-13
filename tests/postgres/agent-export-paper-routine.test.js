'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-export-paper-fixture');
const {widths}=require('../helpers/page-widths'),routine=require('../../src/shipping/agent-export-paper-routine'),jobs=require('../../src/operations/postgres-job-queue');

// Job 70: Pro and Custom prepare each packed international shipment's
// commercial invoice, packing list and customs declaration on their own;
// Growth prepares the request for a person; Starter is locked. Missing or
// mismatched facts stop and ask, and held modes never act alone.
async function cycle(f,name){
 const scheduled=await routine.schedule(f.db,f.ctx.workspaceId,name);if(!scheduled.queued)return null;
 const handlers=require('../../src/operations/postgres-runtime-handlers').create(),job=await jobs.processOne(f.db,{[routine.KIND]:handlers[routine.KIND]},{owner:'synthetic-export-worker'});
 assert.equal(job.status,'COMPLETED',JSON.stringify(job));return job.result;
}
const packets=async(f,shipmentId)=>(await f.db.query('SELECT id,status FROM stockchief_runtime.agent_export_paper_packets WHERE workspace_id=$1 AND shipment_id=$2 ORDER BY created_at',[f.ctx.workspaceId,shipmentId])).rows;
const checks=async(f,shipmentId)=>(await f.db.query('SELECT * FROM stockchief_runtime.agent_export_paper_checks WHERE workspace_id=$1 AND shipment_id=$2',[f.ctx.workspaceId,shipmentId])).rows[0]||null;
const asks=async f=>(await require('../../src/projections/postgres-service').needs(f.db,f.ctx.workspaceId,f.ctx.actorId)).filter(r=>/^export-paper-check:/.test(r.sourceId||''));
const audits=async(f,action)=>(await f.db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[f.ctx.workspaceId,action])).rows[0].n;

test('Pro and Custom prepare the packet alone and once; Growth asks a person first; Starter is locked; domestic parcels are left alone',{timeout:600000},async t=>{
 const f=await fixture(t,'pro'),{db,ctx}=f;
 const s=await f.parcel();
 const ran=await cycle(f,'pro-1');assert.equal(ran.prepared,1,JSON.stringify(ran));
 const [packet]=await packets(f,s.shipmentId);assert.equal(packet.status,'DRAFT');assert.equal(await audits(f,'Export papers prepared on its own'),1);
 const file=await f.service.download(db,ctx,packet.id),library=await import('pdfjs-dist/legacy/build/pdf.mjs'),loading=library.getDocument({data:new Uint8Array(file.content)}),parsed=await loading.promise;
 assert.equal(parsed.numPages,3);const customs=(await (await parsed.getPage(3)).getTextContent()).items.map(i=>i.str).join(' ').replace(/\s+/g,' ');await loading.destroy();
 for(const label of ['CUSTOMS DECLARATION','HS tariff number 820559','Country of origin US','Destination country: CA','Total value: $12.00','A person checks, signs and submits it'])assert(customs.includes(label),label);
 const needs=await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);
 assert.equal(needs.filter(r=>r.sourceId==='export-paper-drafts').length,1,'the owner reviews the prepared draft');
 assert.equal((await asks(f)).length,0);
 assert.match(JSON.stringify((await require('../../src/autopilot/agent-activity').report(db,ctx)).rows),/Export papers prepared on its own/);
 // Replays and a stopped draft never prepare the same facts twice.
 assert.equal(await cycle(f,'pro-1'),null);assert.equal(await cycle(f,'pro-2'),null);
 await f.service.stop(db,ctx,packet.id,{revision:1,confirmed:'yes'});
 await db.query("UPDATE stockchief_runtime.agent_export_paper_checks SET checked_at=checked_at-interval '2 days' WHERE workspace_id=$1",[ctx.workspaceId]);
 const again=await cycle(f,'pro-3');assert.equal(again.prepared,0,JSON.stringify(again));assert.equal((await packets(f,s.shipmentId)).length,1);
 // A domestic parcel with saved fields is not international paperwork.
 const home=await f.parcel();await db.query(`UPDATE sales_shipments SET ship_to_address_fields=jsonb_set(ship_to_address_fields,'{country}','"US"') WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,home.shipmentId]);
 assert.equal((await routine.pending(db,ctx.workspaceId)).some(r=>r.id===home.shipmentId),false);
 // Custom prepares alone too.
 await f.subscribe('enterprise');const custom=await f.parcel();assert.equal((await cycle(f,'custom-1')).prepared,1);assert.equal((await packets(f,custom.shipmentId))[0].status,'DRAFT');
 // Growth prepares the exact request; the person approves it in Needs you.
 await f.subscribe('growth');const grown=await f.parcel();const proposed=await cycle(f,'growth-1');assert.equal(proposed.proposed,1,JSON.stringify(proposed));
 assert.equal((await packets(f,grown.shipmentId)).length,0);const ask=(await asks(f)).find(r=>r.sourceId==='export-paper-check:'+grown.shipmentId);
 assert.match(ask.title,/Approve export papers for SHP-/);assert.match(ask.href,/^\/actions\//);
 assert.equal(await cycle(f,'growth-2'),null,'the same request is not proposed twice');
 await f.assistant.executeProposal(db,ctx,ask.href.split('/').at(-1));assert.equal((await packets(f,grown.shipmentId))[0].status,'DRAFT');assert.equal((await asks(f)).length,0);
 // Starter is locked: no routine, no asks.
 await f.subscribe('starter');const locked=await f.parcel();assert.equal(await cycle(f,'starter-1'),null);assert.equal((await routine.run(db,{workspaceId:ctx.workspaceId})).skipped,'plan');assert.deepEqual(await routine.inbox(db,ctx.workspaceId),[]);
 assert.equal((await packets(f,locked.shipmentId)).length,0);assert.equal(await f.balance(),20,'paperwork never moves stock');
});

test('Missing HS code, weight or a currency mismatch stops and asks; Ask me first, Watch only, pause and shadow never prepare alone',{timeout:600000},async t=>{
 const f=await fixture(t,'pro'),{db,ctx}=f;
 // No confirmed trade facts for the product: it asks for them by SKU.
 await db.query('DELETE FROM stockchief_runtime.agent_export_product_facts WHERE workspace_id=$1',[ctx.workspaceId]);
 const s=await f.parcel();
 assert.equal((await cycle(f,'facts-1')).held,1);
 const held=await checks(f,s.shipmentId);assert.equal(held.status,'HELD');assert.match(held.reason,new RegExp('Confirm the HS code, country of origin and net weight for '+f.sku));
 const ask=(await asks(f))[0];assert.match(ask.title,/need your facts/);assert.equal(ask.href,'/autopilot/export-papers?'+new URLSearchParams({sku:f.sku})+'#trade-facts');
 assert.equal((await cycle(f,'facts-2')).held,1);assert.equal(await audits(f,'Export papers held for a person'),1,'one audit per hold, not per run');
 const screen=await f.browser.get('/autopilot/export-papers').expect(200);assert.match(screen.text,/Waiting for your facts/);assert.match(screen.text,/Confirm the HS code/);
 await f.service.saveProducts(db,ctx,{confirmed:'yes',products:[{sku:f.sku,description:'Recorded sample whole-unit product',hsCode:'820559',originCountry:'US',netWeightGrams:100}]});
 // Measured parcels lighter than the goods' net weight: it stops.
 await f.shipping.setPackages(db,ctx,s.shipmentId,[{weightGrams:50,lengthMm:200,widthMm:150,heightMm:100}]);
 assert.equal((await cycle(f,'weight-1')).held,1);assert.match((await checks(f,s.shipmentId)).reason,/net weight exceeds the measured parcel weight/);
 await f.shipping.setPackages(db,ctx,s.shipmentId,[{weightGrams:350,lengthMm:200,widthMm:150,heightMm:100}]);
 // The shipment's currency differs from the sale's: it stops.
 await db.query("UPDATE sales_shipments SET currency='EUR' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,s.shipmentId]);
 assert.equal((await cycle(f,'currency-1')).held,1);assert.match((await checks(f,s.shipmentId)).reason,/priced in USD but the shipment is recorded in EUR/);
 await db.query("UPDATE sales_shipments SET currency='USD' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,s.shipmentId]);
 // Held modes: Ask me first and routine work off prepare a request for a
 // person; Watch only, pause and the first 14 days do nothing.
 const modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
 await modes.save(db,ctx,70,{mode:'ask',revision:0});
 assert.equal((await cycle(f,'ask-1')).proposed,1);assert.equal((await packets(f,s.shipmentId)).length,0);assert.equal((await checks(f,s.shipmentId)).status,'PROPOSED');
 await modes.save(db,ctx,70,{mode:'watch',revision:1});const watched=await f.parcel();
 assert.match((await routine.run(db,{workspaceId:ctx.workspaceId})).skipped,/Watch only/);
 await modes.save(db,ctx,70,{mode:'inherit',revision:2});
 await autopilot.pause(db,ctx,{role:'owner'},'Paperwork check');assert.match((await routine.run(db,{workspaceId:ctx.workspaceId})).skipped,/paused/);await autopilot.resume(db,ctx,{role:'owner'});
 await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);assert.match((await routine.run(db,{workspaceId:ctx.workspaceId})).skipped,/14 days/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await autopilot.setMode(db,ctx,{role:'owner'},'SUPERVISED');assert.equal((await cycle(f,'supervised-1')).proposed,1);assert.equal((await packets(f,watched.shipmentId)).length,0);
 await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 assert.equal(await audits(f,'Export papers prepared on its own'),0);assert.equal(await f.balance(),20);
 // A database without the new table keeps Needs you and the routine quiet.
 const older={query:async(sql,args)=>/to_regclass/.test(sql)?{rows:[{ok:false}]}:db.query(sql,args)};
 assert.deepEqual(await routine.inbox(older,ctx.workspaceId),[]);assert.equal((await routine.run(older,{workspaceId:ctx.workspaceId})).skipped,'not_installed');
});

test('International paperwork shows shipments waiting for facts at phone and desktop width',{timeout:300000},async t=>{
 const f=await fixture(t,'pro'),{db,ctx}=f;
 await db.query('DELETE FROM stockchief_runtime.agent_export_product_facts WHERE workspace_id=$1',[ctx.workspaceId]);await f.parcel();assert.equal((await cycle(f,'page-1')).held,1);
 await widths(f,[['/autopilot/export-papers','export-papers-waiting']],async page=>{const text=await page.locator('main').innerText();assert.match(text,/Waiting for your facts/);assert.match(text,/customs declaration/);});
});
