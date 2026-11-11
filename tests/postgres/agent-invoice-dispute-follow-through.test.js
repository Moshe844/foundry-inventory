'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const flow=require('../../src/purchasing/invoice-dispute-follow-through');
const mode=require('../../src/autopilot/job-modes');
const mail=require('../../src/connections/postgres-mail');
const outbound=require('../../src/connections/postgres-outbound-mail');
const assistant=require('../../src/assistant/postgres-service');
const training=require('../../src/autopilot/draft-authority');

test('native invoice exceptions discover disputes and resolve actual supplier replies against the exact corrected original',{timeout:300000},async t=>{
  const f=await require('../helpers/supplier-invoice-intake-fixture').fixture(t);
  const {db,ctx,connector,sender,browser,csrf}=f;
  const sku=f.item.skuIds[0];
  const code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  await db.query(`UPDATE workspace_connectors SET capabilities='["MAIL_READ","MAIL_SEND"]',credential_ref=$3
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,connector,'connection_credentials:'+connector]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',{accessToken:'test-token'}));
  const body=(p,number,price,extra='')=>f.text(p,{number,rows:[{sku:code,quantity:1,price,total:price}]})
    .replace('Currency: USD\n','Currency: USD\n'+extra);
  const capture=async({threadId,text,subject='Supplier reply',receivedAt,sourceConnector=connector,providerType='gmail'})=>{
    const response=await mail.capture(db,{id:sourceConnector,workspace_id:ctx.workspaceId,provider_type:providerType},
      {messageId:randomUUID(),threadId,sender,subject,receivedAt,bodyText:'Please check the attached correction or reply.',
        ...(text?{attachments:[{filename:'corrected-original.txt',mimeType:'text/plain',contentBase64:Buffer.from(text).toString('base64')}]}:{})});
    if(!text)return response;
    await require('../../src/connections/postgres-attachments').extractMessage(db,ctx.workspaceId,response.messageId);
    await f.runSource();
    const row=(await db.query(`SELECT q.* FROM stockchief_runtime.agent_supplier_invoice_intakes q
      JOIN connection_email_attachments a ON a.id=q.attachment_id WHERE q.workspace_id=$1 AND a.message_id=$2`,[ctx.workspaceId,response.messageId])).rows[0];
    assert(row);
    return {...response,row};
  };
  const pending=async()=>{
    const jobs=[];
    for(;;){
      const j=await f.queue.processOne(db,f.handlers,{owner:'invoice-dispute-worker',kinds:[flow.KIND]});
      if(!j)return jobs;
      assert.equal(j.status,'COMPLETED',JSON.stringify(j.lastError));
      jobs.push(j.result);
    }
  };
  const work=async id=>(await db.query('SELECT * FROM stockchief_runtime.agent_invoice_dispute_work WHERE workspace_id=$1 AND intake_id=$2',[ctx.workspaceId,id])).rows[0];
  const bill=async id=>(await db.query('SELECT * FROM accounting_supplier_bills WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
  const effect=async billId=>(await db.query(`SELECT e.id,m.id communication_id FROM stockchief_runtime.provider_effects e
    JOIN supplier_communications m ON m.workspace_id=e.workspace_id AND m.id=e.aggregate_id
    WHERE m.workspace_id=$1 AND m.invoice_dispute_bill_id=$2 AND e.kind='mail.outbound.send'`,[ctx.workspaceId,billId])).rows[0];
  const send=async(billId,threadId)=>outbound.executeSendEffect(db,ctx.workspaceId,(await effect(billId)).id,
    {provider:{send:async({message})=>({externalMessageId:'gmail-verified-'+message.id,externalThreadId:threadId})}});
  const newCase=async (number,mailbox={})=>{
    const po=await f.po([{skuId:sku,quantityUnits:1,unitCost:'1.25'}]);
    const original=await capture({threadId:'incoming-'+number,text:body(po,number,175),subject:'Original invoice '+number,...mailbox});
    assert.equal(original.row.status,'EXCEPTION');
    return {po,number,...original};
  };

  await mode.save(db,ctx,100,{mode:'routine',revision:0});
  const first=await newCase('WRONG-100');
  const tierJobs=(await db.query('SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2',[ctx.workspaceId,flow.KIND])).rows[0];
  assert(tierJobs.n>0);
  const discovered=await pending();
  assert(discovered.some(j=>j.status==='HELD'&&j.billId));
  const originalBill=(await work(first.row.id)).bill_id;
  assert.equal((await bill(originalBill)).status,'DISPUTED');
  assert.equal((await bill(originalBill)).journal_entry_id,null);
  assert.equal(await effect(originalBill),undefined);
  const review=await browser.get('/autopilot/supplier-disputes/'+originalBill).expect(200);
  assert.match(review.text,/Prepare for approval/);
  assert.match(review.text,/Original invoice/);

  const prepared=await assistant.prepareAction(db,ctx,'Ask this supplier about the exact invoice difference',
    {action:'supplier_invoice.dispute',recordReference:originalBill,mailbox:connector});
  const proposal=await assistant.getProposal(db,ctx.workspaceId,prepared.proposal.id);
  assert.equal(proposal.payload.needsDisputeConfirmation,false);
  await assistant.executeProposal(db,ctx,prepared.proposal.id);
  await send(originalBill,'supplier-thread-one');
  assert.equal((await training.settings(db,ctx,prepared.proposal.id)).canTeach,true);
  await training.save(db,ctx,prepared.proposal.id,{mode:'save',maximum:'5.00',revision:0});

  const trained=await newCase('WRONG-101');
  const trainedJobs=await pending(),trainedBill=(await work(trained.row.id)).bill_id;
  assert(trainedJobs.some(j=>j.billId===trainedBill&&j.status==='QUEUED'));
  const trainedEffect=await effect(trainedBill);
  await f.subscribe('growth');
  await assert.rejects(outbound.executeSendEffect(db,ctx.workspaceId,trainedEffect.id,{provider:{send:()=>assert.fail('downgraded send')}}),
    error=>error.code==='entitlement_required');
  await browser.get('/autopilot/supplier-disputes/'+originalBill).expect(402);
  await f.subscribe('starter');
  await assert.rejects(flow.prepare(db,ctx,first.row.id,{confirmed:'yes',revision:first.row.revision}),error=>error.code==='entitlement_required');

  await f.subscribe('enterprise');
  await training.save(db,ctx,prepared.proposal.id,{mode:'remove',revision:1});
  const custom=await newCase('WRONG-102');
  await pending();
  const customBill=(await work(custom.row.id)).bill_id;
  assert(await effect(customBill),'Custom must prepare a source-proven dispute without a taught example');
  await send(customBill,'supplier-thread-custom');

  const oldDate=new Date(Date.now()-86400000).toISOString();
  const beforeSend=await capture({threadId:'supplier-thread-one',subject:'Earlier supplier reply',receivedAt:oldDate});
  const wrongThread=await capture({threadId:'other-thread',subject:'Same supplier, unrelated thread'});
  assert.equal(await flow.replyContext(db,ctx.workspaceId,beforeSend.messageId),null);
  assert.equal(await flow.replyContext(db,ctx.workspaceId,wrongThread.messageId),null);
  const text=await capture({threadId:'supplier-thread-one',subject:'We will send a corrected invoice'});
  assert.equal((await flow.replyContext(db,ctx.workspaceId,text.messageId)).bill_id,originalBill);
  assert.equal((await bill(originalBill)).status,'DISPUTED');

  const bad=await capture({threadId:'supplier-thread-one',text:body(first.po,'WRONG-100',165),subject:'A still-incorrect original'});
  const held=(await flow.page(db,ctx,originalBill,{source:bad.row.id})).selected;
  assert.match(held.hold,/still differs/);
  const unnamed=await capture({threadId:'supplier-thread-one',text:body(first.po,'UNNAMED-100',125),subject:'Replacement with a new number'});
  const unnamedMatch=(await flow.page(db,ctx,originalBill,{source:unnamed.row.id})).selected;
  assert.equal(unnamedMatch.requiresReferenceConfirmation,true);
  await assert.rejects(flow.resolve(db,ctx,originalBill,{confirmed:'yes',sourceId:unnamed.row.id,fingerprint:unnamedMatch.fingerprint,
    reason:'Reviewed the actual supplier attachment'}),/Confirm the supplier identified/);
  const candidate=await capture({threadId:'supplier-thread-one',
    text:body(first.po,'CORRECTED-100',125,'Replaces invoice: WRONG-100\n'),subject:'Verified corrected invoice'});
  assert.equal(candidate.row.status,'EXCEPTION');
  assert.equal(candidate.row.duplicate_bill_id,originalBill);
  await assert.rejects(f.service.replaceUnposted(db,ctx,candidate.row.id,{confirmed:'yes',revision:candidate.row.revision}),/Open the supplier dispute/);
  const savedSourcePage=(await browser.get('/autopilot/supplier-invoices/'+candidate.row.id).expect(200)).text;
  assert.match(savedSourcePage,/Open supplier dispute/);
  const page=(await browser.get('/autopilot/supplier-disputes/'+originalBill).query({source:candidate.row.id}).expect(200)).text;
  assert.match(page,/We will send a corrected invoice/);
  assert.match(page,/Verified corrected invoice/);
  assert(!page.includes('Same supplier, unrelated thread'));
  assert.match(page,/Post corrected invoice/);
  const selected=(await flow.page(db,ctx,originalBill,{source:candidate.row.id})).selected;
  assert.equal(selected.hold,null);
  const input={_csrf:csrf(page),confirmed:'yes',sourceId:candidate.row.id,fingerprint:selected.fingerprint,reason:'Verified the replacement against the supplier reply and received stock'};
  const startPayments=(await db.query('SELECT count(*)::int n FROM accounting_payments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
  await browser.post('/autopilot/supplier-disputes/'+originalBill+'/resolve').type('form').send(input).expect(303);
  const corrected=await flow.resolve(db,ctx,originalBill,input);
  assert.equal(corrected.replayed,true);
  assert.equal((await bill(originalBill)).status,'VOID');
  assert.equal((await bill(originalBill)).journal_entry_id,null);
  const posted=await bill(corrected.billId);
  assert.equal(posted.status,'OPEN');
  assert.equal(posted.supplier_invoice_number,'CORRECTED-100');
  assert.equal(Number(posted.balance_minor),125);
  assert(posted.journal_entry_id);
  assert.equal((await db.query('SELECT count(*)::int n FROM accounting_payments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,startPayments);
  const preserved=await f.service.get(db,ctx,first.row.id);
  assert.equal(preserved.source_hash,first.row.source_hash);
  assert.match((await browser.get('/autopilot/supplier-disputes/'+originalBill).expect(200)).text,/Posted corrected invoice/);
  const oldNumber=await capture({threadId:'separate-original-thread',text:body(first.po,'WRONG-100',125)});
  assert.equal(oldNumber.row.status,'EXCEPTION');
  assert.equal(oldNumber.row.duplicate_bill_id,originalBill);
  assert.equal(oldNumber.row.bill_id,null);

  await t.test('Outlook queues once and resolves uncertain acceptance only from the exact Sent Items record',async subtest=>{
    const outlook=randomUUID();
    await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,
      capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
      VALUES($1,$2,$1,'Microsoft disputes','microsoft365','[]','{}','connected','["MAIL_READ","MAIL_SEND"]',$3,'CONNECTED',$4,'dispute-ms-mailbox',now(),now())`,
    [outlook,ctx.workspaceId,'connection_credentials:'+outlook,ctx.actorId]);
    await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,outlook,'provider',
      {accessToken:'test-graph-token',expiresAt:Date.now()+3600000}));
    await f.service.configure(db,ctx,{connectorIds:[connector,outlook],revision:1,confirmed:'yes'});
    const original=await newCase('WRONG-M365',{sourceConnector:outlook,providerType:'microsoft365'});
    await pending();
    const m365Bill=(await work(original.row.id)).bill_id;
    const queued=await effect(m365Bill);
    let recorded=null,allowVerification=false,sends=0;
    const providerConfiguration=subtest.mock.getter(require('../../src/config').connections.microsoft365,'configured',()=>true);
    const stub=subtest.mock.method(globalThis,'fetch',async(url,options)=>{
      const path=new URL(url).pathname.toLowerCase();
      if(path.endsWith('/me/sendmail')){
        sends++;
        recorded=JSON.parse(options.body).message;
        return new Response(null,{status:202});
      }
      assert(path.endsWith('/me/mailfolders/sentitems/messages'),String(url));
      return Response.json({value:allowVerification?[{id:'graph-actual-message',conversationId:'graph-actual-conversation',
        sentDateTime:new Date().toISOString(),toRecipients:recorded.toRecipients,internetMessageHeaders:recorded.internetMessageHeaders}]:[]});
    });
    try{
      await assert.rejects(outbound.executeSendEffect(db,ctx.workspaceId,queued.id),error=>error.code==='email_send_ambiguous');
      assert.equal(sends,1);
      const uncertain=(await db.query('SELECT status,result FROM stockchief_runtime.provider_effects WHERE id=$1',[queued.id])).rows[0];
      assert.equal(uncertain.status,'AMBIGUOUS');
      assert.equal(Boolean(uncertain.result?.externalMessageId),false);
      assert.equal((await flow.page(db,ctx,m365Bill)).message.verified,false);
      allowVerification=true;
      const verified=await flow.worker(db,ctx.workspaceId,{verifyEffectId:queued.id});
      const stored=(await db.query('SELECT error_message FROM stockchief_runtime.provider_effects WHERE id=$1',[queued.id])).rows[0];
      assert.equal(verified.verified,true,stored.error_message);
      assert.equal(sends,1);
      const accepted=(await flow.page(db,ctx,m365Bill)).message;
      assert.equal(accepted.verified,true);assert.equal(accepted.external_thread_id,'graph-actual-conversation');
      const reply=await capture({threadId:accepted.external_thread_id,sourceConnector:outlook,providerType:'microsoft365'});
      assert.equal((await flow.replyContext(db,ctx.workspaceId,reply.messageId)).bill_id,m365Bill);
    }finally{stub.mock.restore();providerConfiguration.mock.restore();}
  });
});
