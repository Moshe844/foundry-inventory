'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const evidence=require('../../src/autopilot/lot-certificate-evidence');
const coverage=require('../../src/autopilot/lot-certificate-coverage');
const reviews=require('../../src/autopilot/job-reviews');
const days=require('../../src/accounting/customer-money').addDays;

async function fixture(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t);
  await f.subscribe('pro');
  await f.db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(f.db,f.ctx,{role:'owner'},'POLICY_AUTOMATED');
  const today=await require('../../src/lib/business-time').today(f.db,f.ctx.workspaceId);
  const catalog=require('../../src/domain/postgres-catalog-service');
  const item=await catalog.createItem(f.db,f.ctx,{name:'Quality tracked product',baseCode:'QA-PRODUCT',trackingMode:'lot',purchaseCost:'2'});
  const skuId=item.skuIds[0],sku='QA-PRODUCT',lot='QA-BATCH-0001';
  await require('../../src/accounting/postgres-stock-receipt').receive(f.db,f.ctx,{skuId,locationId:f.location.id,lotCode:lot,expiresAt:days(today,90),quantity:5,idempotencyKey:'lot-certificate-fixture'});
  const target={sku,lot},at=new Date().toISOString(),supplierId='fixture-supplier';
  await f.db.query("UPDATE suppliers SET email='qa-certs@example.test' WHERE workspace_id=$1 AND id=$2",[f.ctx.workspaceId,supplierId]);
  await require('../../src/operations/postgres-commerce').linkSupplierItem(f.db,f.ctx,{supplierId,skuId,purchaseUnit:'unit',unitsPerPurchaseUnit:1,minimumOrderQuantity:1,orderMultiple:1,lastUnitCost:'2.00'});
  const connector=(await f.db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provider_account_id,provides,config,status,capabilities,expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
    VALUES('certificate-mail',$1,'certificate-mail','Supplier certificate mailbox','gmail','qa-certs-test-mailbox','[]','{}','connected','[]',5,'CONNECTED',$2,$3,$3) RETURNING *`,[f.ctx.workspaceId,f.ctx.actorId,at])).rows[0];
  const original=(kind='CoA',expiry=days(today,30),extra='')=>Buffer.from(`${kind==='CoA'?'Certificate of Analysis':'Safety Data Sheet'}\nSKU: ${sku}\nLot: ${lot}\nExpiry date: ${expiry}\nSynthetic original quality evidence.\n${extra}`);
  const requireKind=(kind='CoA',required='yes')=>evidence.requirement(f.db,f.ctx,{...target,kind,required});
  const scope=(mode='automatic')=>evidence.configure(f.db,f.ctx,{...target,supplierId,connectorId:connector.id,kinds:['CoA','Safety sheet'],mode,confirmed:'yes'});
  async function mail(bytes,filename='Supplier CoA.txt'){
    const message=await require('../../src/connections/postgres-mail').capture(f.db,connector,{externalMessageId:randomUUID(),sender:'qa-certs@example.test',subject:'Original certificate',bodyText:'Supplier original attached.',attachments:[{filename,contentBase64:bytes.toString('base64')}]});
    return message.messageId;
  }
  const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const processKind=kind=>queue.processOne(f.db,{[kind]:handlers[kind]},{owner:'lot-cert-test-worker'});
  const status=async(kind='CoA')=>(await reviews.run(f.db,f.ctx,'lot-documents',{filter:sku})).rows.find(r=>r.Document===kind)?.Status;
  return {...f,target,today,skuId,supplierId,connector,original,requireKind,scope,mail,processKind,status};
}

test('Growth approves each exact original. Business-day expiry, revocation, duplicate replay and private downgrade history use the native lot',{timeout:240000},async t=>{
  const f=await fixture(t);await f.subscribe('growth');await f.requireKind();assert.equal(await f.status(),'Missing');
  const pending=await evidence.prepare(f.db,f.ctx,{...f.target,kind:'CoA',filename:'Expired original.txt',buffer:f.original('CoA',days(f.today,-1))});
  const draft=await evidence.draft(f.db,f.ctx,pending.id);
  assert.equal(draft.state,'DRAFT');assert.equal(await f.status(),'Missing');
  await assert.rejects(evidence.approve(f.db,f.ctx,draft.id,{confirmed:'yes',reviewHash:'stale',expiryMode:'dated',expiresOn:days(f.today,-1)}),/current exact original/);
  await evidence.approve(f.db,f.ctx,draft.id,{confirmed:'yes',reviewHash:draft.reviewHash,expiryMode:'dated',expiresOn:days(f.today,-1)});
  assert.equal(await f.status(),'Expired');
  const bytes=f.original('CoA',f.today),data={...f.target,kind:'CoA',filename:'Current original.txt',buffer:bytes};
  const [a,b]=await Promise.all([evidence.prepare(f.db,f.ctx,data),evidence.prepare(f.db,f.ctx,data)]);
  assert.equal(a.id,b.id);const approved=await evidence.draft(f.db,f.ctx,a.id);
  await evidence.approve(f.db,f.ctx,a.id,{confirmed:'yes',reviewHash:approved.reviewHash,expiryMode:'dated',expiresOn:f.today});
  assert.equal(await f.status(),'On file');
  assert.equal((await coverage.rows(f.db,f.ctx,{today:days(f.today,1),filter:f.target.sku})).rows[0].Status,'Expired');
  const source=(await evidence.draft(f.db,f.ctx,a.id)).source_id;
  assert((await evidence.load(f.db,f.ctx,source)).content.equals(bytes));
  await f.subscribe('starter');
  await assert.rejects(evidence.prepare(f.db,f.ctx,data),e=>e.code==='entitlement_required');
  assert.equal((await f.browser.get('/autopilot/lot-certificates/'+a.id).expect(200)).text.includes('data-lot-cert-plan-locked'),true);
  await f.browser.get('/autopilot/lot-certificates/source/'+source).expect(200);
  const other=await require('../../src/domain/postgres-auth-service').createBusiness(f.db,{name:'Other owner',businessName:'Other certificate inventory',email:randomUUID()+'@example.test',password:f.password});
  await assert.rejects(evidence.load(f.db,{workspaceId:other.workspaceId,actorId:other.userId},source),/not in this inventory/);
  await assert.rejects(reviews.run(f.db,f.ctx,'lot-documents'),e=>e.code==='entitlement_required');
  await f.subscribe('growth');
  const current=await evidence.draft(f.db,f.ctx,a.id);
  await evidence.revoke(f.db,f.ctx,a.id,{reviewHash:current.reviewHash,reason:'Supplier replaced this original'});
  assert.equal(await f.status(),'Expired');
  assert((await evidence.load(f.db,f.ctx,source)).content.equals(bytes));
  await f.db.query("UPDATE users SET role='staff',permissions='[\"VIEW\"]' WHERE workspace_id=$1 AND id=$2",[f.ctx.workspaceId,f.ctx.actorId]);
  await f.browser.get('/autopilot/lot-certificates/source/'+source).expect(403);
  await assert.rejects(evidence.load(f.db,f.ctx,source),/current inventory owner/);
  assert.equal(await f.balance(),9);
});

test('Growth mailbox processing drafts and Pro and Custom link newly received proven originals within current exact scope without training',{timeout:300000},async t=>{
  const f=await fixture(t);await f.subscribe('growth');await f.requireKind();await f.requireKind('Safety sheet');
  await assert.rejects(f.scope('automatic'),e=>e.code==='entitlement_required');
  let rule=await f.scope('draft');
  const message=await f.mail(f.original());
  const extracted=await f.processKind('mail.attachment-extract');assert.equal(extracted.status,'COMPLETED',JSON.stringify(extracted.lastError));
  const pending=await f.processKind(evidence.jobKind);assert.equal(pending.status,'COMPLETED',JSON.stringify(pending.lastError));assert.equal(pending.result.drafted,1);
  assert.equal(await f.status(),'Missing');
  const links=(await coverage.screen(f.db,f.ctx)).list;assert.equal(links.length,1);assert.equal(links[0].state,'DRAFT');
  const d=await evidence.draft(f.db,f.ctx,links[0].id);assert.match(d.proof.lotQuote,/QA-BATCH-0001/);
  await evidence.approve(f.db,f.ctx,d.id,{confirmed:'yes',reviewHash:d.reviewHash,expiryMode:'dated',expiresOn:d.expiry});assert.equal(await f.status(),'On file');
  await evidence.configure(f.db,f.ctx,{id:rule.id,revision:1,stop:'yes'});
  for(const [tier,revision] of [['pro',2],['enterprise',3]]){
    await f.subscribe(tier);
    await evidence.configure(f.db,f.ctx,{...f.target,supplierId:f.supplierId,connectorId:f.connector.id,kinds:['CoA','Safety sheet'],mode:'automatic',confirmed:'yes',revision});
    const bytes=f.original('Safety sheet','No expiration','Original for '+tier);
    await f.mail(bytes,'Supplier Safety sheet '+tier+'.txt');assert.equal((await f.processKind('mail.attachment-extract')).status,'COMPLETED');
    const linked=await f.processKind(evidence.jobKind);assert.equal(linked.status,'COMPLETED',JSON.stringify(linked.lastError));assert.equal(linked.result.linked,1);
    assert.equal(await f.status('Safety sheet'),'On file');assert((await evidence.load(f.db,f.ctx,linked.result.sourceId)).content.equals(bytes));
  }
  const usage=(await f.db.query("SELECT meter,sum(units)::int AS n FROM commercial_usage_events WHERE workspace_id=$1 AND status='COMMITTED' AND meter IN('agent_documents','ai_work_credits') GROUP BY meter",[f.ctx.workspaceId])).rows;
  assert.equal(usage.find(r=>r.meter==='agent_documents').n,2,'Two Agent-plan incoming originals use their existing receipts; Custom fixture follows its contractual offer.');assert(!usage.some(r=>r.meter==='ai_work_credits'));
  await f.db.query('DELETE FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[f.ctx.workspaceId,message]);
  assert((await evidence.load(f.db,f.ctx,d.source_id)).content.equals(f.original()));
  assert.equal(await f.balance(),9);
});

test('trusted mailbox dispatch rechecks scope, plan, Watch and pause; ambiguous originals create owner review and cannot close missing coverage',{timeout:300000},async t=>{
  const f=await fixture(t);await f.requireKind();const rule=await f.scope();
  const modes=require('../../src/autopilot/job-modes');
  async function stage(extra){const message=await f.mail(f.original('CoA',days(f.today,30),extra));assert.equal((await f.processKind('mail.attachment-extract')).status,'COMPLETED');return message;}
  await stage('Downgrade test');await f.subscribe('growth');assert.equal((await f.processKind(evidence.jobKind)).result.skipped,true);assert.equal(await f.status(),'Missing');await f.subscribe('pro');
  await stage('Pause test');await f.db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1',[f.ctx.workspaceId]);assert.equal((await f.processKind(evidence.jobKind)).result.skipped,true);await f.db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1',[f.ctx.workspaceId]);
  await stage('Job mode test');await modes.save(f.db,f.ctx,196,{mode:'watch',revision:0});assert.equal((await f.processKind(evidence.jobKind)).result.skipped,true);await modes.save(f.db,f.ctx,196,{mode:'routine',revision:1});
  await stage('First fourteen days');await f.db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);assert.equal((await f.processKind(evidence.jobKind)).result.skipped,true);await f.db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await stage('Ambiguity\nExpiry date: '+days(f.today,40));const held=(await f.processKind(evidence.jobKind)).result;assert.equal(held.held,true);assert.equal(await f.status(),'Missing');
  assert((await coverage.screen(f.db,f.ctx)).held.some(r=>r.id===held.sourceId&&/different expiration/.test(r.review_reason)));
  const notifications=await require('../../src/projections/postgres-service').needs(f.db,f.ctx.workspaceId,f.ctx.actorId);assert(notifications.some(n=>n.sourceId==='lot-certificate-coverage'));assert(notifications.some(n=>n.sourceId==='lot-certificate-reviews'));
  await stage('Stopped exact scope');await evidence.configure(f.db,f.ctx,{id:rule.id,revision:1,stop:'yes'});assert.equal((await f.processKind(evidence.jobKind)).result.skipped,true);assert.equal(await f.status(),'Missing');
});

test('serialized stock with a native lot raises coverage, and an owner can upload, approve and download the original on a phone',{timeout:300000},async t=>{
  const f=await fixture(t),catalog=require('../../src/domain/postgres-catalog-service');
  const item=await catalog.createItem(f.db,f.ctx,{name:'Serialized QA product',baseCode:'QA-SERIAL',trackingMode:'serial',purchaseCost:'3'});
  const target={sku:'QA-SERIAL',lot:'SERIAL-BATCH-QA'};
  await require('../../src/accounting/postgres-stock-receipt').receive(f.db,f.ctx,{skuId:item.skuIds[0],locationId:f.location.id,quantity:1,serials:['QA-SERIAL-1'],lotCode:target.lot,idempotencyKey:'serial-lot-certificate'});
  await evidence.requirement(f.db,f.ctx,{...target,kind:'Safety sheet',required:'yes'});
  const row=(await reviews.run(f.db,f.ctx,'lot-documents',{filter:target.sku})).rows[0];assert.equal(row.Status,'Missing');assert.equal(row.Lot,target.lot);
  await f.subscribe('growth');
  const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),url='http://127.0.0.1:'+server.address().port;
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url+'/login');await page.getByLabel('Work email',{exact:true}).fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(url+row.link);await page.getByRole('link',{name:'Review and link original certificates'}).click();
  assert.equal(await page.getByLabel('Exact SKU',{exact:true}).inputValue(),target.sku);
  await page.getByLabel('Certificate type',{exact:true}).selectOption('Safety sheet');
  const original=Buffer.from('Safety Data Sheet\nSKU: QA-SERIAL\nLot: SERIAL-BATCH-QA\nNo expiry is stated.\n');
  await page.getByLabel('Original file, up to 20 MB',{exact:true}).setInputFiles({name:'Original safety evidence.txt',mimeType:'text/plain',buffer:original});
  await page.getByRole('button',{name:'Prepare exact lot link'}).click();await page.getByText('Awaiting approval',{exact:true}).first().waitFor();
  const download=page.waitForEvent('download');await page.getByRole('link',{name:'Download original Original safety evidence.txt'}).click();
  assert(require('node:fs').readFileSync(await(await download).path()).equals(original));
  await page.getByLabel('Expiry shown on the original',{exact:true}).selectOption('none');await page.getByLabel(/I checked this original belongs/).check();
  await page.getByRole('button',{name:'Approve original certificate link'}).click();await page.getByText('Linked to the exact lot',{exact:true}).waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  require('node:fs').mkdirSync('output',{recursive:true});await page.screenshot({path:'output/lot-certificate-mobile.png',fullPage:true});
  assert.equal((await reviews.run(f.db,f.ctx,'lot-documents',{filter:target.sku})).rows[0].Status,'On file');assert.equal(await f.balance(),10);
});

test('supplier-direct recorded lots have coverage and original links without creating local stock or altering fulfillment',{timeout:300000},async t=>{
  const f=await fixture(t),direct=require('../../src/purchasing/agent-direct-shipments'),hash=require('../../src/pricing/postgres-promotions').hash;
  await require('../../src/operations/postgres-company-profile').save(f.db,f.ctx,{legalName:'Direct certificate fixture',addressLine1:'1 Main St',city:'Albany',region:'NY',postalCode:'12207',country:'US',revision:0});
  const order=await f.workflows.createSalesOrder(f.db,f.ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:f.skuId,quantity:1,unitPriceMinor:1500}]});
  const prepared=await direct.prepare(f.db,f.ctx,{salesOrderId:order.salesOrderId,supplierId:f.supplierId,requestKey:randomUUID(),confirmed:'yes',lines:[{lineId:order.lineIds[0],quantity:1}]});
  const approved=await direct.approve(f.db,f.ctx,prepared.id,{confirmed:'yes',revision:prepared.revision,sourceHash:prepared.source_hash,releaseReserved:'yes'});
  await direct.place(f.db,f.ctx,prepared.id,{confirmed:'yes',sentExternally:'yes',revision:approved.revision,sourceHash:approved.source_hash,externalReference:'Synthetic supplier-direct dispatch'});
  const source=(await f.db.query('SELECT id FROM stockchief_runtime.agent_direct_order_lines WHERE workspace_id=$1 AND direct_order_id=$2',[f.ctx.workspaceId,prepared.id])).rows[0];
  const target={sku:f.target.sku,lot:'QA-DIRECT-LOT'};
  const dispatch=await direct.capture(f.db,f.ctx,prepared.id,{actualShipment:'yes',supplierReference:randomUUID(),shippedAt:new Date(Date.now()-1000).toISOString(),carrier:'UPS',trackingNumber:'1Z999AA10123456784',
    lines:[{lineId:source.id,quantity:1,lots:[{lotCode:target.lot,quantity:1}]}]});
  const applied=await direct.applyDispatch(f.db,f.ctx,dispatch.id,{confirmed:'yes',revision:dispatch.revision,evidenceHash:hash(dispatch.original)});assert.equal(applied.status,'FULFILLED');
  await evidence.requirement(f.db,f.ctx,{...target,kind:'CoA',required:'yes'});
  const find=async()=>(await reviews.run(f.db,f.ctx,'lot-documents',{filter:target.lot})).rows[0];assert.equal((await find()).Status,'Missing');
  const r=await evidence.prepare(f.db,f.ctx,{...target,kind:'CoA',filename:'Direct lot original.txt',buffer:Buffer.from('Certificate of Analysis\nSKU: '+target.sku+'\nLot: '+target.lot)});
  const d=await evidence.draft(f.db,f.ctx,r.id);await evidence.approve(f.db,f.ctx,r.id,{confirmed:'yes',reviewHash:d.reviewHash,expiryMode:'none'});
  assert.equal((await find()).Status,'On file');assert.equal(await f.balance(),9);
});
