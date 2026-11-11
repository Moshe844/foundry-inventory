'use strict';

process.env.NODE_ENV='test';
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
  async function upload(path,bytes,kind='invoice'){
    const page=await supplier.get(path).expect(200);
    const token=/data-csrf="([^"]+)"/.exec(page.text)[1];
    return supplier.post(path+'/file/'+kind).set('X-CSRF-Token',token).set('Content-Type','application/pdf').send(bytes).expect(200);
  }
  for(const plan of ['starter','growth','pro','enterprise']){
    await f.subscribe(plan);
    const order=await f.po(lines),path=await issue(order),buffer=await pdf(f.text(order,{rows}));
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
});
