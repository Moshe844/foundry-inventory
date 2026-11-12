'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('../helpers/supplier-invoice-intake-fixture');
const catalog=require('../../src/domain/postgres-catalog-service');
const commerce=require('../../src/operations/postgres-commerce');
const reviews=require('../../src/autopilot/job-reviews');
const notices=require('../../src/autopilot/operational-notices');
const modes=require('../../src/autopilot/job-modes');
const lists=require('../../src/purchasing/agent-supplier-price-lists');

const supplierId='fixture-supplier';
const header=['Supplier SKU','Pack price','Currency','Pack size'];
const csv=rows=>Buffer.from([header,...rows].map(row=>row.join(',')).join('\n')+'\n');

test('verified supplier invoices and retained price lists find exact increases across all four plans',{timeout:300000},async t=>{
  const f=await fixture(t),{db,ctx,browser,queue,handlers}=f;
  const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  const second=await catalog.createItem(db,ctx,{name:'Another vendor pack',baseCode:'PRICE-PACK-8',trackingMode:'quantity'});
  const link=(skuId,supplierSku,units,lastUnitCost)=>commerce.linkSupplierItem(db,ctx,{skuId,supplierId,supplierSku,purchaseUnit:'case',
    unitsPerPurchaseUnit:units,lastUnitCost});
  await link(sku,'VENDOR-6',6,'1.25');
  await link(second.skuIds[0],'VENDOR-8',8,'2.00');
  const po=await f.po([{skuId:sku,quantityUnits:12,unitsPerPurchaseUnit:6,purchaseUnit:'case',unitCost:'1.25'}]);
  const original=f.text(po,{number:'ORIGINAL-HIGHER',headers:'SKU|Purchase packs|Unit price|Line total',rows:[{sku:code,quantity:2,price:751,total:1502}]});
  const invoice=(await require('../../src/purchasing/supplier-invoice-uploads').enqueue(db,ctx,{buffer:Buffer.from(original),filename:'invoice.txt',purchaseOrderId:po.purchaseOrderId})).uploadId;
  const invoiceRead=await queue.processOne(db,handlers,{owner:'invoice-original-reader',kinds:['import.read-supplier-invoice.v1']});
  assert.equal(invoiceRead.status,'COMPLETED',JSON.stringify(invoiceRead.lastError));
  await f.runSource();
  const intake=(await db.query("SELECT * FROM stockchief_runtime.agent_supplier_invoice_intakes WHERE workspace_id=$1 AND source_upload_id=$2",[ctx.workspaceId,invoice])).rows[0];
  assert.equal(intake.status,'EXCEPTION',intake.problem);
  assert.equal(intake.comparison.differences[0].kind,'price_outside_approved_cost');
  const input=csv([['VENDOR-6','7.51','USD',6],['VENDOR-8','16.00','USD',8]]);
  const uploadPage=await browser.get(lists.path).expect(200);
  const created=await browser.post(lists.path+'/upload').field('_csrf',f.csrf(uploadPage.text)).field('supplierId',supplierId)
    .attach('priceListFile',input,'new-price-list.csv').expect(303);
  const id=created.headers.location.split('/').at(-1);
  assert.equal((await lists.upload(db,ctx,{buffer:input,filename:'another-filename.csv',supplierId})).id,id);
  const read=()=>queue.processOne(db,handlers,{owner:'price-list-reader',kinds:[lists.kind]});
  const checked=await read();
  assert.equal(checked.status,'COMPLETED',JSON.stringify(checked.lastError));
  assert.deepEqual(checked.result,{status:'READY',rows:2,increases:1});
  const saved=await lists.page(db,ctx,id);
  assert.deepEqual(saved.rows.map(r=>[r.result,Number(r.amount_minor),Number(r.pricing_quantity),r.prior.amountMinor]),[
    ['HIGHER',751,6,125],['NO_INCREASE',1600,8,200]
  ]);
  assert.deepEqual((await lists.download(db,ctx,id)).original,input);
  assert.deepEqual((await browser.get(lists.path+'/'+id+'/original').expect(200)).body,input);
  assert.match((await browser.get(lists.path+'/'+id).expect(200)).text,/VENDOR|Higher price/);
  assert.equal((await lists.run({workspaceId:ctx.workspaceId,payload:{sourceId:id}},db)).replayed,true);
  assert.equal(await read(),null);

  const wrong=await lists.upload(db,ctx,{buffer:csv([['VENDOR-6','14.00','USD',12],['VENDOR-8','19.00','EUR',8],['UNKNOWN','20','USD',1]]),
    filename:'unclear-price-list.csv',supplierId});
  assert.equal((await read()).status,'COMPLETED');
  assert.deepEqual((await lists.page(db,ctx,wrong.id)).rows.map(r=>r.result),['HELD','HELD','HELD']);
  assert.match((await lists.page(db,ctx,wrong.id)).rows[0].reason,/pack size differs/);
  assert.match((await lists.page(db,ctx,wrong.id)).rows[1].reason,/same currency/);
  await link(sku,'VENDOR-6',6,'4.00');
  assert.equal((await lists.page(db,ctx,id)).rows[0].prior.amountMinor,125,'later catalogue updates preserve the original comparison');

  const review=()=>reviews.run(db,ctx,'supplier-price-increases');
  const refresh=()=>db.transaction(c=>notices.refresh(c,ctx.workspaceId));
  const notice=async(actor=ctx.actorId)=>(await notices.inbox(db,ctx.workspaceId,actor)).find(n=>n.sourceId==='agent-notice-91');
  const state=async()=>(await db.query(`SELECT
    (SELECT count(*) FROM accounting_supplier_bills WHERE workspace_id=$1) AS bills,
    (SELECT count(*) FROM accounting_payments WHERE workspace_id=$1) AS payments,
    (SELECT count(*) FROM accounting_journal_entries WHERE workspace_id=$1) AS journals,
    (SELECT count(*) FROM movements WHERE workspace_id=$1) AS movements,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM supplier_items x WHERE workspace_id=$1) AS supplier_prices`,[ctx.workspaceId])).rows[0];
  const before=await state();
  for(const plan of ['growth','pro','enterprise']){
    await f.subscribe(plan);
    await refresh();
    const result=await review();
    assert.equal(result.mode,'alone');
    assert.deepEqual(result.rows.map(r=>r.Source).sort(),['Invoice','Price list']);
    assert(result.rows.every(r=>r['Supplier unit price']==='$7.51 per 6 pricing units'&&r['Previous trusted price']==='$1.25'));
    assert(result.rows.some(r=>r.link==='/autopilot/supplier-invoices/'+intake.id));
    assert.match((await notice()).happened,/^2 supplier documents/);
    assert.equal(await notice('another-member'),undefined);
  }
  const page=await browser.get('/autopilot/reviews/supplier-price-increases').expect(200);
  assert.match(page.text,/ORIGINAL-HIGHER/);
  assert.match(page.text,/Upload or review a supplier price list/);
  await f.subscribe('starter');
  assert.equal(await notice(),undefined,'a downgrade hides existing automatic notices immediately');
  const starter=await review();
  assert.equal(starter.mode,'suggest');
  assert.equal(starter.rows.length,1);
  assert.deepEqual(Object.keys(starter.rows[0]),['Suggestion']);
  assert.match(starter.rows[0].Suggestion,/7.51 per 6 pricing units.*1.25/);
  assert.equal((await lists.page(db,ctx,id)).rows.length,1);
  assert.deepEqual((await lists.download(db,ctx,id)).original,input);
  await assert.rejects(lists.acknowledge(db,ctx,id),/requires the Growth plan/);
  await refresh();
  assert.equal(await notice(),undefined);
  await f.subscribe('pro');
  await modes.save(db,ctx,91,{mode:'watch',revision:0});
  await refresh();
  assert.equal(await notice(),undefined);
  assert.equal((await review()).rows.length,2);
  await modes.save(db,ctx,91,{mode:'inherit',revision:1});
  await db.query("UPDATE accounts SET created_at=(now()-interval '7 days')::text WHERE id=$1",[f.owner.accountId]);
  await refresh();
  assert.equal(await notice(),undefined);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await refresh();
  await refresh();
  assert.match((await notice()).happened,/^2 supplier documents/);
  await lists.acknowledge(db,ctx,id);
  await lists.acknowledge(db,ctx,id);
  await refresh();
  assert.match((await notice()).happened,/^1 supplier document/);
  assert.equal((await review()).rows.length,2,'acknowledgement retains historical evidence');
  assert.deepEqual(await state(),before);
  await db.query("UPDATE stockchief_runtime.agent_supplier_invoice_uploads SET extracted_text=extracted_text||' revised' WHERE id=$1",[invoice]);
  assert.deepEqual((await review()).rows.map(r=>r.Source),['Price list'],'changed invoice extraction cannot support the saved comparison');
  await refresh();
  assert.equal(await notice(),undefined);
  const canvas=require('@napi-rs/canvas').createCanvas(1000,210),pen=canvas.getContext('2d');
  pen.fillStyle='white';pen.fillRect(0,0,1000,210);pen.fillStyle='black';pen.font='30px monospace';
  pen.fillText('Supplier SKU    Pack price    Currency    Pack size',30,75);
  pen.fillText('VENDOR-6          25.00         USD          6',30,145);
  const scan=canvas.toBuffer('image/png'),originalScan=await lists.upload(db,ctx,{filename:'price-list-scan.png',buffer:scan,supplierId});
  const held=await read();
  assert.equal(held.status,'COMPLETED',JSON.stringify(held.lastError));
  assert.equal(held.result.status,'HELD');
  const confirmationPage=await browser.get(lists.path+'/'+originalScan.id).expect(200);
  assert.match(confirmationPage.text,/Confirm the pricing table from the original/);
  const sourceHash=(await lists.page(db,ctx,originalScan.id)).list.content_hash;
  const form={_csrf:f.csrf(confirmationPage.text),sourceHash,confirmed:'yes',sourceTable:csv([['VENDOR-6','25.00','USD',6]]).toString()};
  await assert.rejects(lists.confirm(db,ctx,originalScan.id,{...form,sourceHash:'incorrect'}),/exact preserved original/);
  await browser.post(lists.path+'/'+originalScan.id+'/confirm').type('form').send(form).expect(303);
  assert.equal((await lists.confirm(db,ctx,originalScan.id,form)).replayed,true);
  const confirmed=await lists.page(db,ctx,originalScan.id);
  assert.ok(confirmed.list.confirmed_at);
  assert.equal(confirmed.rows[0].result,'HIGHER');
  assert.equal(confirmed.rows[0].prior.amountMinor,400);
  assert.deepEqual((await lists.download(db,ctx,originalScan.id)).original,scan);
  const relation='stockchief_runtime.agent_supplier_price_lists';
  await require('../../src/commercial/storage-capacity').baseline(db,ctx.workspaceId,relation);
  const storage=(await db.query('SELECT baseline_bytes FROM commercial_storage_usage WHERE workspace_id=$1 AND relation=$2::regclass',[ctx.workspaceId,relation])).rows[0];
  assert(Number(storage.baseline_bytes)>input.length+scan.length);
  await refresh();
  assert.match((await notice()).happened,/^1 supplier document/);
  assert.deepEqual(await state(),before);
  const committed=(await db.query(`SELECT count(*)::int n FROM commercial_usage_events WHERE workspace_id=$1 AND meter='agent_documents'
    AND idempotency_key LIKE 'supplier-price-list:%' AND status='COMMITTED'`,[ctx.workspaceId])).rows[0];
  assert.equal(committed.n,3,'each distinct successfully compared original consumes one document');
});
