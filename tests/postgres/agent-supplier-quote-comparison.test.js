'use strict';
process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {addDays}=require('../../src/accounting/customer-money');
const reviews=require('../../src/autopilot/job-reviews');
const mail=require('../../src/connections/postgres-mail');
const evidence=require('../../src/purchasing/postgres-supplier-evidence');

test('current supplier quote comparisons retain exact originals, currency, quantity, delivery and plan authority',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t);
  const {db,ctx,owner,subscribe,workflows,location,item,browser}=f;
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const valid=addDays(today,10),arrival=addDays(today,3);
  const sku=item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  await subscribe('growth');
  await db.query("UPDATE accounts SET created_at=(now()-interval '25 days')::text WHERE id=$1",[owner.accountId]);
  await db.query("UPDATE suppliers SET email='quote-a@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
  const alt=await require('../../src/operations/postgres-commerce').createSupplier(db,ctx,{name:'Alternative',email:'quote-b@example.test'});
  const connector=(await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,created_at,updated_at)
    VALUES($1,$2,$1,'Quote mailbox','gmail','[]','{}','connected','[]',now()::text,now()::text) RETURNING *`,
  [randomUUID(),ctx.workspaceId])).rows[0];
  const capture=async(supplierId,sender,qty,price,freight,currency,expires)=>{
    const po=await workflows.createPurchaseOrder(db,ctx,{supplierId,currency:'USD',destinationLocationId:location.id,
      lines:[{skuId:sku,quantityUnits:qty,unitCost:price/100}],idempotencyKey:randomUUID()});
    const order=(await db.query('SELECT * FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,po.purchaseOrderId])).rows[0];
    const quote='Quotation '+order.po_number+': '+qty+' units of '+code+' at '+currency+' '+(price/100).toFixed(2)+' per unit.';
    const terms='Valid through '+expires+'\nDelivery: '+currency+' '+(freight/100).toFixed(2);
    const original=await mail.capture(db,connector,{messageId:randomUUID(),sender,subject:'Quotation '+order.po_number,bodyText:quote+'\n'+terms});
    const payload={documentType:'quotation',sourceMessageId:original.messageId,evidenceQuote:quote,documentReference:'Q-'+order.po_number,
      currency,expectedArrivalDate:arrival,lines:[{sku:code,quantity:qty,quantityBasis:'stock',unitCostMinor:price}],
      quotationTerms:{validThrough:expires,deliveryMinor:freight,evidence:terms}};
    await assert.rejects(evidence.assess(db,ctx,order,{...payload,quotationTerms:{...payload.quotationTerms,deliveryMinor:freight+1}}),/delivery amount/);
    const prepared=await evidence.assess(db,ctx,order,payload);
    await db.transaction(c=>evidence.execute(c,ctx,prepared.payload));
    return original.messageId;
  };
  const standard=await capture('fixture-supplier','quote-a@example.test',4,150,200,'USD',valid);
  const alternative=await capture(alt.id,'quote-b@example.test',4,125,500,'USD',valid);
  await capture('fixture-supplier','quote-a@example.test',8,90,200,'USD',valid);
  await capture(alt.id,'quote-b@example.test',4,115,400,'EUR',valid);
  const view=options=>reviews.run(db,ctx,'compare-quotes',{filter:code,...options});
  const path='/autopilot/reviews/compare-quotes';
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    if(tier==='starter'){
      await browser.get(path).expect(402);
      await assert.rejects(view(),e=>e.code==='entitlement_required');
      continue;
    }
    if(tier==='growth')await assert.rejects(view({scheduled:true}),e=>e.code==='entitlement_required');
    else assert.equal((await view({scheduled:true})).rows.length,4);
    const result=await view();
    assert.equal(result.mode,tier==='growth'?'draft':'alone');
    const usd=result.rows.filter(row=>row.Currency==='USD'&&Number(row['Quoted stock units'])===4);
    assert.deepEqual(usd.map(r=>[r.Supplier,r['Quoted goods'],r['Goods plus delivery'],Number(r['Goods price rank']),r.link]),
      [['Alternative','$5.00','$10.00',1,'/mail/'+alternative],['Fixture parts','$6.00','$8.00',2,'/mail/'+standard]]);
    assert(result.rows.filter(r=>r.Currency==='EUR'||Number(r['Quoted stock units'])===8).every(r=>r['Goods price rank']===null));
    await browser.get(path+'?filter='+encodeURIComponent(code)).expect(200).expect(/Quoted delivery charge/);
    await browser.get('/mail/'+standard).expect(200).expect(/Quotation/);
  }
  await capture(alt.id,'quote-b@example.test',4,110,500,'USD',addDays(today,-1));
  const outdated=(await view()).rows.filter(r=>r.Currency==='USD'&&Number(r['Quoted stock units'])===4);
  assert.equal(outdated.find(r=>r.Supplier==='Alternative').Status,'Expired');
  assert(outdated.every(r=>r['Goods price rank']===null));
  const playbooks=require('../../src/autopilot/playbooks');
  const config={name:'Read new supplier quotes',cadence:'daily',steps:['compare-quotes','low-stock']};
  await subscribe('growth');
  await assert.rejects(playbooks.create(db,ctx,config),e=>e.code==='entitlement_required');
  await subscribe('pro');
  const playbook=await playbooks.create(db,ctx,config);
  await db.query("UPDATE stockchief_runtime.agent_playbooks SET next_at=now()-interval '1 minute' WHERE workspace_id=$1 AND id=$2",
    [ctx.workspaceId,playbook]);
  await db.transaction(playbooks.schedule);
  const queue=require('../../src/operations/postgres-job-queue');
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const completed=await queue.processOne(db,handlers,{owner:'supplier-quote-comparison-test',kinds:['agent.playbook']});
  assert.equal(completed.status,'COMPLETED',JSON.stringify(completed.lastError));
  assert.equal(completed.result[0].rows.length,4);
  await subscribe('growth');
  const previous=(await playbooks.list(db,ctx)).books.find(row=>row.id===playbook);
  assert.equal(previous.result,null);
  const placed=(await db.query("SELECT count(*)::int AS n FROM purchase_orders WHERE workspace_id=$1 AND status='ORDERED'",
    [ctx.workspaceId])).rows[0].n;
  assert.equal(placed,0);
});
