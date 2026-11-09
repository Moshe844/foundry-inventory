'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;
 await f.subscribe('growth');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const followups=require('../../src/sales/agent-quote-followups'),quotes=require('../../src/sales/postgres-quotes'),assistant=require('../../src/assistant/postgres-service'),outbound=require('../../src/connections/postgres-outbound-mail');
 const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),connector=randomUUID(),sku=f.item.skuIds[0];
 const price=amount=>db.transaction(c=>require('../../src/pricing/postgres-service').setPricesInTransaction(c,ctx,[{skuId:sku,amountMinor:amount,currency:'USD'}]));await price(1200);
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at) VALUES($1,$2,$1,'Quotes mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'quotes-mailbox',now(),now())`,[connector,ctx.workspaceId,'connection_credentials:'+connector,ctx.actorId]);await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',{accessToken:'test-token'}));
 const quote=(quantity=1)=>quotes.create(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',currency:'USD',orderDate:today,neededBy:null,discountMinor:0,taxMinor:0,codes:[],lines:[{skuId:sku,quantity}],validUntil:require('../../src/accounting/customer-money').addDays(today,14),requestKey:randomUUID()});
 const confirmation=(q,input={})=>({requestKey:randomUUID(),expectedHash:q.pricing_hash,revision:0,presentedOn:today,channel:'in_person',evidence:'Synthetic customer received the printed quotation in our test shop',confirmed:'yes',...input});
 const confirm=(q,input={})=>followups.record(db,ctx,q.id,confirmation(q,input)),prepare=q=>assistant.prepareAction(db,ctx,'Follow up on the customer’s exact quote',{action:'sales_quote.followup',recordReference:q.quote_number,mailbox:connector});
 const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}},deliver=p=>outbound.executeSendEffect(db,ctx.workspaceId,p.result.effectId,{provider});
 return {...f,today,sku,connector,price,quote,confirmation,confirm,prepare,sent,provider,deliver,followups,quotes,assistant,outbound};
}

test('quote follow-ups require actual recorded customer receipt, exact plan access and one confirmed message without creating a sale',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,q=await f.quote(),before=await f.balance();
 await assert.rejects(f.prepare(q),/confirmation.*customer received/);await assert.rejects(f.confirm(q,{confirmed:'no'}),/actually received/);
 await f.subscribe('starter');await assert.rejects(f.confirm(q),e=>e.code==='entitlement_required');const locked=await f.browser.get('/autopilot/quote-followups/'+q.id).expect(402);assert.match(locked.text,/the Growth plan/);await f.subscribe('growth');
 const input=f.confirmation(q),record=await f.followups.record(db,ctx,q.id,input);assert.equal(record.revision,1);assert((await f.followups.record(db,ctx,q.id,input)).replayed);await assert.rejects(f.followups.record(db,ctx,q.id,{...input,evidence:'Different human evidence'}),/different details/);
 for(const tier of ['starter','growth','pro','enterprise']){await f.subscribe(tier);if(tier==='starter')await assert.rejects(f.prepare(q),e=>e.code==='entitlement_required');else{assert.equal((await f.prepare(q)).status,'PREPARED');await f.browser.get('/autopilot/quote-followups/'+q.id).expect(200);}}
 await f.subscribe('growth');const prepared=await f.prepare(q),preview=await f.browser.get('/actions/'+prepared.proposal.id).expect(200);assert.match(preview.text,/\$12.00/);assert.match(preview.text,/Synthetic customer received/);assert(!preview.text.includes('<dt>Source fingerprint</dt>'));
 const queued=await f.assistant.executeProposal(db,ctx,prepared.proposal.id);assert.equal(queued.result.status,'QUEUED');assert.equal(f.sent.length,0);await f.deliver(queued);await f.deliver(queued);assert.equal(f.sent.length,1);assert.match(f.sent[0].body,new RegExp(q.quote_number));assert.match(f.sent[0].body,/\$12.00/);
 const replay=await f.assistant.executeProposal(db,ctx,(await f.prepare(q)).proposal.id);assert.equal(replay.result.replayed,true);assert.equal(replay.result.effectId,queued.result.effectId);await f.browser.get('/messages/customer/'+replay.result.communicationId).expect(200);
 assert.equal(await f.balance(),before);assert.equal((await db.query("SELECT count(*)::integer n FROM sales_orders WHERE workspace_id=$1 AND idempotency_key LIKE 'quotation:%'",[ctx.workspaceId])).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::integer n FROM accounting_customer_invoices WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);assert.equal((await f.quotes.get(db,ctx.workspaceId,q.id)).status,'OPEN');
});
