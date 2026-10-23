'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
test('Ask connection reads expose saved shipping mode and delivery evidence without reading any credential',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,account=(await require('../../src/connections/postgres-service').list(db,ctx.workspaceId))[0],at=new Date().toISOString();
 await db.query("INSERT INTO shipping_webhook_setups(workspace_id,connector_id,status,updated_at) VALUES($1,$2,'CONNECTED',$3)",[ctx.workspaceId,account.id,at]);
 const inspected=await require('../../src/connections/postgres-inspection').inspect({query(sql,args){assert(!/connection_credentials|credential_envelope|encrypted_payload/i.test(sql),'Read capability must never load a saved credential');return db.query(sql,args);}},ctx);
 assert.equal(inspected.rows.length,1);const row=inspected.rows[0];assert.equal(row.shipping.accountMode,'TEST');assert.equal(row.shipping.automaticUpdates,'CONNECTED');assert.equal(row.shipping.lastCarrierEventAt,null);assert.match(row.href,/^\/settings\/shipping#account-/);assert(!JSON.stringify(row).includes('shippo_test_fixture'));
 assert.match(row.shipping.verification,/registration.*delivery/i);
 await db.query("UPDATE workspace_connectors SET config=(config::jsonb-'shippingAccountMode')::text WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,account.id]);
 const repaired=await db.transaction(client=>require('../../src/shipping/postgres-webhook-setup').schedule(client,{publicOrigin:'https://stockchief.example.test'}));assert.equal(repaired.queued,0,'Materializing existing account mode does not register another callback');
 assert.equal((await require('../../src/connections/postgres-inspection').inspect(db,ctx)).rows[0].shipping.accountMode,'TEST');
});
