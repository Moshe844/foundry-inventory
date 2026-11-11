'use strict';

process.env.NODE_ENV='test';
process.env.FOUNDRY_PUBLIC_URL='https://stockchief.example.test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const links=require('../../src/purchasing/supplier-order-link');
const portal=require('../../src/purchasing/supplier-portal-invoices');

function pdf(text){
  return new Promise(resolve=>{
    const doc=new(require('pdfkit'))(),parts=[];
    doc.on('data',part=>parts.push(part));
    doc.on('end',()=>resolve(Buffer.concat(parts)));
    doc.fontSize(10).text(text);
    doc.end();
  });
}

test('the supplier portal routes the original PDF into exact invoice matching on all four plans',{timeout:300000},async t=>{
  const f=await require('../helpers/supplier-invoice-intake-fixture').fixture(t),{db,ctx,service}=f;
  const skuId=f.item.skuIds[0];
  const code=(await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,skuId])).rows[0].code;
  const rows=[{sku:code,quantity:2,price:125,total:250}],lines=[{skuId,quantityUnits:2,unitCost:'1.25'}];
  const issue=async order=>new URL(await db.transaction(c=>links.issue(c,ctx.workspaceId,order.purchaseOrderId,f.sender,'https://stockchief.example.test'))).pathname;
  async function share(order){
    const detail='/purchasing/orders/'+order.purchaseOrderId;
    const page=await f.browser.get(detail).expect(200);
    assert.match(page.text,/Share supplier response link/);
    const response=await f.browser.post(detail+'/supplier-link').type('form').send({_csrf:f.csrf(page.text)}).expect(200);
    assert.match(response.headers['cache-control'],/no-store/);
    assert.match(response.text,/Copy supplier link/);
    const url=new URL(/data-copy="(https:\/\/stockchief\.example\.test\/supplier\/order\/[^"]+)"/.exec(response.text)[1]);
    return url.pathname;
  }
  const work=kind=>f.queue.processOne(db,f.handlers,{owner:'supplier-portal-invoice-test',kinds:[kind]});
  const reads=()=>work('import.read-supplier-invoice.v1');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const supplier=require('supertest').agent(app);
  const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
  const browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const errors=[];
  phone.on('pageerror',error=>errors.push(error.message));
  let uploadCsrf;
  async function upload(path,bytes,kind='invoice'){
    if(!uploadCsrf){
      const page=await supplier.get(path).expect(200);
      uploadCsrf=/data-csrf="([^"]+)"/.exec(page.text)[1];
    }
    return supplier.post(path+'/file/'+kind).set('X-CSRF-Token',uploadCsrf).set('Content-Type','application/pdf').send(bytes).expect(200);
  }
  for(const plan of ['starter','growth','pro','enterprise']){
    await f.subscribe(plan);
    const order=await f.po(lines,false),buffer=await pdf(f.text(order,{rows}));
    if(plan==='starter')await db.query('UPDATE workspace_connectors SET paused_at=now() WHERE id=$1',[f.connector]);
    const path=await share(order);
    if(plan==='starter')await db.query('UPDATE workspace_connectors SET paused_at=NULL WHERE id=$1',[f.connector]);
    const open=await supplier.get(path).expect(200);
    const reply=(kind,date,shipDate)=>supplier.post(path+'/respond').type('form').send({_csrf:f.csrf(open.text),kind,date,shipDate});
    await reply('confirm','').expect(303);
    await reply('date','2040-01-14','2040-01-10').expect(303);
    const responses=await links.responses(db,ctx.workspaceId,order.purchaseOrderId);
    assert.deepEqual(responses.map(response=>response.kind).sort(),['confirm','date']);
    assert.equal(responses.find(response=>response.kind==='date').expected_date,'2040-01-14');
    assert.equal(responses.find(response=>response.kind==='date').ship_date,null);
    await f.workflows.receivePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID(),
      lines:[{lineId:order.lineIds[0],quantity:2,locationId:f.location.id}]});
    await reply('date','2040-01-15').set('Accept','application/json').expect(404);
    if(plan==='starter'){
      await phone.goto('http://127.0.0.1:'+server.address().port+path);
      assert.equal(await phone.getByRole('button',{name:'Confirm this order'}).count(),0);
      assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await phone.getByLabel('PDF, up to 4 MB').setInputFiles({name:'invoice.pdf',mimeType:'application/pdf',buffer});
      await phone.getByRole('button',{name:'Upload document'}).click();
      await phone.getByText('Your document was received.',{exact:true}).waitFor();
      assert.deepEqual(errors,[]);
    }else await upload(path,buffer);
    await upload(path,buffer);
    const secondLink=await share(order);
    assert.notEqual(secondLink,path);
    await upload(secondLink,buffer);
    assert.equal((await links.responses(db,ctx.workspaceId,order.purchaseOrderId)).filter(reply=>reply.kind==='invoice').length,1);
    const secondTokenHash=require('node:crypto').createHash('sha256').update(secondLink.split('/').at(-1)).digest('hex');
    await db.query("UPDATE stockchief_runtime.supplier_order_links SET expires_at=now()-interval '1 day' WHERE token_hash=$1",[secondTokenHash]);
    await supplier.get(secondLink).expect(404);
    const bridged=await work(portal.kind);
    assert.equal(bridged.status,'COMPLETED',JSON.stringify(bridged));
    const {uploadId}=bridged.result;
    assert(uploadId,JSON.stringify(bridged.result));
    assert.equal(await work(portal.kind),null);
    const original=(await db.query(`SELECT u.content IS NULL AS linked,u.supplier_submission_id,s.contents
      FROM stockchief_runtime.agent_supplier_invoice_uploads u JOIN stockchief_runtime.supplier_link_submissions s ON s.id=u.supplier_submission_id
      WHERE u.workspace_id=$1 AND u.id=$2`,[ctx.workspaceId,uploadId])).rows[0];
    assert.equal(original.linked,true);
    assert.deepEqual(original.contents,buffer);
    assert.equal((await reads()).result.readable,true);
    const job=await f.runSource();
    const match=await service.get(db,ctx,job.result.id);
    assert.equal(match.prepared_input.purchaseOrderId,order.purchaseOrderId);
    assert.equal(match.prepared_input.documentTotalMinor,250);
    const page=await f.browser.get('/purchasing/orders/'+order.purchaseOrderId).expect(200);
    assert.match(page.text,/Open invoice match/);
    const downloaded=await f.browser.get('/autopilot/supplier-invoice-uploads/'+uploadId+'/original').expect(200);
    assert.deepEqual(downloaded.body,buffer);
    const notice=await pdf('Ship notice for '+order.poNumber);
    await upload(path,notice,'ship-notice');
    await upload(path,notice,'ship-notice');
    const notices=(await links.responses(db,ctx.workspaceId,order.purchaseOrderId)).filter(response=>response.kind==='ship-notice');
    assert.equal(notices.length,1);
    const originalNotice=await f.browser.get('/purchasing/orders/'+order.purchaseOrderId+'/supplier-files/'+notices[0].id).expect(200);
    assert.deepEqual(originalNotice.body,notice);
    assert.equal(await work(portal.kind),null);
    const usage=(await db.query(`SELECT status,units FROM commercial_usage_events WHERE workspace_id=$1 AND meter='agent_documents' AND idempotency_key LIKE $2`,
      [ctx.workspaceId,'supplier-invoice-upload:'+uploadId+':%'])).rows;
    assert.deepEqual(usage.map(event=>[event.status,Number(event.units)]),[['COMMITTED',1]]);
    if(['starter','growth'].includes(plan)){
      assert.equal(match.status,'READY',match.problem);
      assert.equal(match.bill_id,null);
      const approved=await service.approve(db,ctx,match.id,{revision:match.revision,confirmed:'yes',matchFingerprint:match.comparison.matchFingerprint,reason:'Verified this original against the actual receipt.'});
      assert(approved.billId);
    }else assert.equal(match.status,'POSTED',match.problem);
  }

  const intended=await f.po(lines),wrong=await f.po(lines),path=await issue(intended);
  const signedForOtherOrder=await pdf(f.text(wrong,{rows}));
  await upload(path,signedForOtherOrder,'ship-notice');
  assert.equal(await work(portal.kind),null,'A shipping notice cannot open a payable');
  await upload(path,signedForOtherOrder);
  assert((await work(portal.kind)).result.uploadId);
  assert.equal((await reads()).result.readable,true);
  const held=await f.runSource();
  assert.equal(held.result.status,'HELD');
  assert.match(held.result.reason,/different purchase order/);
  const source=(await links.responses(db,ctx.workspaceId,intended.purchaseOrderId)).find(r=>r.kind==='invoice');
  await assert.rejects(portal.prepare(db,ctx.workspaceId,source.id,{actorId:ctx.actorId,purchaseOrderId:wrong.purchaseOrderId}),/not on this purchase/);

  await f.subscribe('starter');
  await db.query("UPDATE suppliers SET email=NULL WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
  const sharedWithoutEmail=await f.po(lines,false),privatePath=await share(sharedWithoutEmail);
  const privatePage=await supplier.get(privatePath).expect(200);
  await supplier.post(privatePath+'/respond').type('form').send({_csrf:f.csrf(privatePage.text),kind:'confirm'}).expect(303);
  const withoutEmailInvoice=await pdf(f.text(sharedWithoutEmail,{rows}));
  await upload(privatePath,withoutEmailInvoice);
  const withoutEmailJob=await work(portal.kind);
  assert(withoutEmailJob.result.uploadId,JSON.stringify(withoutEmailJob.result));
  await db.query("UPDATE suppliers SET email=$2 WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId,f.sender]);
  await supplier.get(privatePath).expect(404);

  const previousEnv=process.env.STOCKCHIEF_RUNTIME_ENV;
  process.env.STOCKCHIEF_RUNTIME_ENV='staging';
  t.after(()=>{if(previousEnv===undefined)delete process.env.STOCKCHIEF_RUNTIME_ENV;else process.env.STOCKCHIEF_RUNTIME_ENV=previousEnv;});
  const password='Removal!'+randomUUID();
  const admin=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Removal admin',businessName:'Separate business',email:randomUUID()+'@example.test',password});
  await db.query("INSERT INTO developer_account_administrators(account_id,granted_by) VALUES($1,'Supplier portal deletion fixture')",[admin.accountId]);
  const remove=require('../../src/domain/postgres-developer-accounts'),review=await remove.review(db,admin.accountId,f.email);
  assert.equal(review.canDelete,true,review.blockers.join(', '));
  const deletion=await remove.queue(db,admin.accountId,{email:f.email,confirmEmail:f.email,confirmed:'yes',password,reviewHash:review.reviewHash});
  assert.equal((await remove.execute(db,deletion.requestId)).signInAccountRemoved,true);
  assert.equal((await db.query('SELECT id FROM stockchief_runtime.supplier_link_submissions WHERE workspace_id=$1',[ctx.workspaceId])).rowCount,0);
  assert.equal((await db.query('SELECT id FROM stockchief_runtime.agent_supplier_invoice_uploads WHERE workspace_id=$1',[ctx.workspaceId])).rowCount,0);
});

test('portal invoice migration preserves stored bytes and original owner uploads',{timeout:180000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{through:'352-agent-supplier-ship-date-email.sql'}),{db,ctx,workflows}=f;
  await f.subscribe('pro');
  const order=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:2,unitCost:1}]});
  const original=await pdf('Original owner-uploaded supplier invoice');
  const contentHash=require('node:crypto').createHash('sha256').update(original).digest('hex'),id=randomUUID();
  await db.query(`INSERT INTO stockchief_runtime.agent_supplier_invoice_uploads(id,workspace_id,owner_id,supplier_id,purchase_order_id,filename,content,content_hash)
    VALUES($1,$2,$3,'fixture-supplier',$4,'existing-original.pdf',$5,$6)`,[id,ctx.workspaceId,ctx.actorId,order.purchaseOrderId,original,contentHash]);
  const storage=require('../../src/commercial/storage-capacity');
  await storage.refresh(db,ctx.workspaceId);
  const before=await storage.state(db,f.owner.accountId);
  const migrate=require('../../src/db/migrate-postgres').migratePostgres,upgrade={through:'353-agent-supplier-portal-invoices.sql'};
  assert.deepEqual(await migrate(db,upgrade),[upgrade.through]);
  await storage.refresh(db,ctx.workspaceId);
  assert.equal(await storage.state(db,f.owner.accountId),before);
  const row=(await db.query('SELECT content,content_hash,supplier_submission_id FROM stockchief_runtime.agent_supplier_invoice_uploads WHERE id=$1',[id])).rows[0];
  assert.deepEqual(row,{content:original,content_hash:contentHash,supplier_submission_id:null});
  assert.deepEqual(await migrate(db,upgrade),[]);
});
