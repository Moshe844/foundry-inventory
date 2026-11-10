'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('An added parcel cannot leave a queued return email sending only the original box label',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-return-label-fixture').fixture(t),{db,ctx}=f,r=await f.rma(),p=await f.prepare(r);await f.assistant.executeProposal(db,ctx,p.proposal.id);const saved=await f.assistant.getProposal(db,ctx.workspaceId,p.proposal.id);
 await assert.rejects(require('../../src/connections/postgres-outbound-mail').executeSendEffect(db,ctx.workspaceId,saved.result.effectId,{provider:f.provider,beforeSend:async()=>db.query(`INSERT INTO shipment_packages(id,workspace_id,shipment_id,position,weight_grams,length_mm,width_mm,height_mm,weight_source,created_at,updated_at)
 SELECT $1,workspace_id,shipment_id,2,weight_grams,length_mm,width_mm,height_mm,weight_source,created_at,updated_at FROM shipment_packages WHERE workspace_id=$2 AND shipment_id=$3 AND position=1`,[randomUUID(),ctx.workspaceId,r.shipmentId])}),/multiple-parcel|one verified parcel/);
 assert.equal(f.sent.length,0);assert.equal(await f.balance(),19);await assert.rejects(f.prepare(r),/multiple-parcel|one verified parcel/);
});

test('A return label must match the actual carrier purchase receipt before its link can be emailed',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-return-label-fixture').fixture(t),{db,ctx}=f,r=await f.rma();assert.equal((await f.prepare(r)).status,'PREPARED');
 await db.query("UPDATE sales_shipments SET label_url='https://example.test/unverified-label.pdf' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,r.shipmentId]);await assert.rejects(f.prepare(r),/actual label-purchase receipt/);assert.equal(f.sent.length,0);assert.equal(await f.balance(),19);
});
