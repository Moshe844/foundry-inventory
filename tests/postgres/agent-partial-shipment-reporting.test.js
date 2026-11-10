'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('Partial shipment savings and history need exact completed physical quantities and use only owner-timed administration',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-partial-shipment-fixture').fixture(t),{db,ctx}=f,savings=require('../../src/autopilot/time-saved'),digest=require('../../src/autopilot/agent-work-digest'),authority=require('../../src/autopilot/draft-authority');
 const row=async()=>(await savings.report(db,ctx)).rows.find(r=>r.key==='partial-shipment'),history=async()=>(await digest.report(db,ctx)).rows.filter(r=>r.link==='/actions/'+p.proposal.id);
 const p=await f.prepare(f.target);await f.assistant.executeProposal(db,ctx,p.proposal.id);assert.equal((await row()).count,0);assert.equal((await history()).length,0);
 const stored=await f.assistant.getProposal(db,ctx.workspaceId,p.proposal.id);await f.handoff(stored.result.waveId);assert.equal((await row()).count,1);assert.equal((await row()).minutes,null);assert.equal((await history()).length,1);
 await savings.sample(db,ctx,{activity:'partial-shipment',manualMinutes:'5',reviewMinutes:'2',requestKey:randomUUID()});assert.equal((await row()).minutes,3);
 await f.assistant.executeProposal(db,ctx,p.proposal.id);assert.equal((await row()).count,1);
 await db.query("UPDATE stockchief_runtime.assistant_action_proposals SET payload=jsonb_set(payload,'{partialAllocations,0,quantity}','3') WHERE id=$1",[p.proposal.id]);
 assert.equal((await authority.settings(db,ctx,p.proposal.id)).canTeach,false);assert.equal((await authority.settings(db,ctx,p.proposal.id,'72.00')).preview.total,0);assert.equal((await row()).count,0);assert.equal((await history()).length,0);
 assert.equal(await f.balance(),1);assert.equal(Number((await db.query('SELECT total_minor FROM accounting_customer_invoices WHERE sales_order_id=$1',[f.target.salesOrderId])).rows[0].total_minor),4800);
});

test('Partial shipment timing migration adds one boundary and preserves all previous checksums on replay',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});const migrate=require('../../src/db/migrate-postgres').migratePostgres;
 await migrate(db,{through:'309-agent-annual-stocktakes.sql'});const before=(await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows;
 await migrate(db,{through:'310-agent-partial-shipment-timing.sql'});const after=(await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows;assert.equal(after.length,before.length+1);assert.deepEqual(after.filter(r=>r.name!=='310-agent-partial-shipment-timing.sql'),before);
 await migrate(db,{through:'310-agent-partial-shipment-timing.sql'});assert.deepEqual((await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows,after);
});
