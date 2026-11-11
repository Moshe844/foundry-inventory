'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const discovery=require('../../src/documents/agent-document-discovery');
const scopes=require('../../src/documents/document-filing-scopes');
const queue=require('../../src/operations/postgres-job-queue');

async function pdf(parts){
  const doc=new(require('pdfkit'))(),chunks=[];doc.on('data',c=>chunks.push(c));
  const ended=new Promise(resolve=>doc.on('end',resolve));
  parts.forEach((text,n)=>{if(n)doc.addPage();doc.fontSize(14).text(text);});doc.end();await ended;
  return Buffer.concat(chunks);
}
async function docx(body,footer){
  const zip=new(require('jszip'))();
  const part=(root,text)=>'<w:'+root+' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'+
    text.split('\n').map(line=>'<w:p><w:r><w:t>'+line+'</w:t></w:r></w:p>').join('')+'</w:'+root+'>';
  zip.file('word/document.xml',part('document',body));zip.file('word/footer1.xml',part('ftr',footer));
  return zip.generateAsync({type:'nodebuffer'});
}

async function fixture(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;
  await f.subscribe('growth');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const po=(await db.query('SELECT id,po_number,supplier_id,status FROM purchase_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
  const sku=(await db.query('SELECT id,code,item_id FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0];
  const sale=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',
    fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku.id,quantity:1,unitPriceMinor:1000}]});
  const order=(await db.query('SELECT id,order_number,status FROM sales_orders WHERE id=$1',[sale.salesOrderId])).rows[0];
  const supplier='filing@example.test',customer='receiver@example.test',time=new Date().toISOString();
  await db.query('UPDATE suppliers SET email=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,po.supplier_id,supplier]);
  await db.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,is_active,supplier_sku,created_at,updated_at)
    VALUES($1,$2,$3,$4,1,'VENDOR-EXACT-7',$5,$5) ON CONFLICT(workspace_id,supplier_id,sku_id) DO UPDATE SET supplier_sku=EXCLUDED.supplier_sku`,[randomUUID(),ctx.workspaceId,po.supplier_id,sku.id,time]);
  const mailbox=(await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,
    capabilities,expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
    VALUES('discovery-mail',$1,'discovery-mail','Filing mailbox','gmail','[]','{}','connected','[]',5,'CONNECTED',$2,'fixture-provider-account',$3,$3)
    RETURNING *`,[ctx.workspaceId,ctx.actorId,time])).rows[0];
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const process=(kind=discovery.kind,extra)=>queue.processOne(db,{[kind]:extra?Object.assign(extra,{externalEffect:true}):handlers[kind]},{owner:'document-discovery-test'});
  const configure=(party,targetKinds)=>scopes.configure(db,ctx,{party,connectorId:mailbox.id,targetKinds,confirmed:'yes'});
  const capture=(sender,filename,bytes,opts={})=>require('../../src/connections/postgres-mail').capture(db,mailbox,{sender,externalMessageId:randomUUID(),
    subject:'Original reference file',bodyText:'Please see the original evidence.',receivedAt:new Date(Date.now()+500).toISOString(),...opts,
    attachments:[{filename,contentBase64:bytes.toString('base64')}]});
  const rows=async()=> (await db.query('SELECT * FROM '+discovery.table+' WHERE workspace_id=$1 ORDER BY created_at,id',[ctx.workspaceId])).rows;
  const files=async()=> (await db.query('SELECT * FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 ORDER BY created_at,id',[ctx.workspaceId])).rows;
  const receipts=async()=> (await db.query(`SELECT status,idempotency_key,units FROM commercial_usage_events WHERE workspace_id=$1
    AND meter='agent_documents' ORDER BY occurred_at,id`,[ctx.workspaceId])).rows;
  const submit=(text,opts={})=>discovery.enqueue(db,ctx,{filename:'Original.txt',buffer:Buffer.isBuffer(text)?text:Buffer.from(text),...opts});
  const approve=async(id,opts={})=>{
    const screen=await discovery.screen(db,ctx,{id});
    return discovery.approve(db,ctx,id,{confirmed:'yes',reviewHash:screen.reviewHash,
      targets:screen.selected.evidence.candidates.map(row=>row.kind+':'+row.value),...opts});
  };
  return {...f,po,sku,order,supplier,customer,mailbox,process,configure,capture,rows,files,receipts,submit,approve};
}

function complete(job,status){
  assert.equal(job?.status,'COMPLETED',JSON.stringify(job?.lastError));
  assert.equal(job.result.status,status);
  return job.result;
}

test('Growth, Pro and Custom automatically find exact native PO, order and product originals from approved mailboxes without training',{timeout:300000},async t=>{
  const f=await fixture(t),{db,ctx}=f;
  await f.configure('supplier:'+f.po.supplier_id,['purchase_order','item']);
  await f.configure('customer:fixture-customer',['sales_order','item']);
  const po=await pdf(['PACKING SLIP\nDelivery ref PK-408\nSKU: '+f.sku.code,'Purchase order: '+f.po.po_number+'\nDispatch site: Dock 3']);
  const order=Buffer.from('<h1>Delivery Note</h1><p>Customer order: '+f.order.order_number+'</p><p>Dock 10</p><script>Customer order: FALSE-12</script>');
  const product=await docx('Safety data sheet\nWear eye protection.','Supplier SKU: VENDOR-EXACT-7');
  const examples=[
    ['growth',f.supplier,'Original packing slip.pdf',po,'purchase_order',f.po.id,2],
    ['pro',f.customer,'Original delivery note.html',order,'sales_order',f.order.id,1],
    ['enterprise',f.supplier,'Original safety sheet.docx',product,'item',f.sku.item_id,2]
  ];
  for(const [tier,sender,filename,bytes,targetKind,targetId,page] of examples){
    await f.subscribe(tier);
    const message=await f.capture(sender,filename,bytes);
    const received=await f.process('mail.attachment-extract');
    assert.equal(received.status,'COMPLETED',JSON.stringify(received.lastError));
    assert.equal(received.result.filing.queued,1);
    const result=complete(await f.process(),'FILED');
    const saved=await discovery.load(db,ctx,result.id);
    assert.equal(saved.evidence.candidates[0].page,page);
    assert(saved.content.equals(bytes));
    const canonical=(await f.files()).find(file=>file.discovery_id===saved.id);
    assert.equal(canonical.target_kind,targetKind);assert.equal(canonical.target_id,targetId);assert(canonical.content.equals(bytes));
    await f.browser.get('/autopilot/documents?kind='+targetKind+'&record='+targetId).expect(200).expect(new RegExp(filename));
    const download=await f.browser.get('/autopilot/documents/'+canonical.id+'/download').buffer(true).parse((res,done)=>{
      const chunks=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));res.on('end',()=>done(null,Buffer.concat(chunks)));res.on('error',done);
    }).expect(200);
    assert(download.body.equals(bytes));
    await db.query('DELETE FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,message.messageId]);
    assert((await discovery.load(db,ctx,result.id)).content.equals(bytes));
  }
  await f.subscribe('growth');
  await f.capture(f.supplier,'Resent identical packing slip.pdf',po);
  assert.equal((await f.process('mail.attachment-extract')).status,'COMPLETED');
  const replay=complete(await f.process(),'FILED');
  assert.equal(replay.documents,0);
  assert((await discovery.load(db,ctx,replay.id)).filings[0].replayed);
  assert.equal((await f.files()).length,3);
  assert.equal((await f.receipts()).filter(r=>r.status==='COMMITTED').length,3);
  assert.equal(await f.balance(),4);
  assert.equal((await db.query('SELECT status FROM purchase_orders WHERE id=$1',[f.po.id])).rows[0].status,f.po.status);
  assert.equal((await db.query('SELECT status FROM sales_orders WHERE id=$1',[f.order.id])).rows[0].status,f.order.status);
  await f.subscribe('starter');
  await f.browser.get('/autopilot/document-filing').expect(200).expect(/data-filing-plan-locked/);
  await f.browser.get('/autopilot/document-filing/'+(await f.rows())[0].id+'/original').expect(200);
  await assert.rejects(f.submit('Packing slip\nPurchase order: '+f.po.po_number),e=>e.code==='entitlement_required');
  await assert.rejects(f.configure('supplier:'+f.po.supplier_id,['item']),e=>e.code==='entitlement_required');
});

test('review holds conflict and OCR originals, requires human source confirmation, and respects the shipping tier ceiling',{timeout:300000},async t=>{
  const f=await fixture(t),authority={automatic:'yes',authorized:'yes'};
  await f.configure('supplier:'+f.po.supplier_id,['purchase_order','item']);
  await f.capture(f.supplier,'Conflicting records.txt',Buffer.from('Packing slip\nPurchase order: '+f.po.po_number+'\nCustomer order: '+f.order.order_number));
  assert.equal((await f.process('mail.attachment-extract')).status,'COMPLETED');
  const conflict=complete(await f.process(),'REVIEW');
  await assert.rejects(f.approve(conflict.id,{targets:[],targetKind:'sales_order',reference:f.order.order_number,reason:'Checked sender and original.'}),/does not match the recorded sender/);
  await assert.rejects(f.approve(conflict.id),/verified the uncertain match/);
  assert.equal((await f.approve(conflict.id,{reason:'Verified the PO on the original and checked the supplier.'})).links[0].reference,f.po.po_number);
  const shipped=await f.submit('BILL OF LADING\nPurchase order: '+f.po.po_number+'\nB/L No: 42',authority);
  assert.equal(complete(await f.process(),'REVIEW').id,shipped.id);
  assert.match((await discovery.load(f.db,f.ctx,shipped.id)).issue,/requires owner approval/);
  assert.equal((await f.approve(shipped.id,{reason:'Verified the bill and exact purchase order.'})).links.length,1);
  const canvas=require('@napi-rs/canvas').createCanvas(950,260),paint=canvas.getContext('2d');
  paint.fillStyle='white';paint.fillRect(0,0,950,260);paint.fillStyle='black';paint.font='42px sans-serif';
  paint.fillText('Packing slip',35,65);paint.fillText('Purchase order: '+f.po.po_number,35,135);
  const scan=await f.submit(canvas.toBuffer('image/png'),{filename:'Original scan.png',...authority});
  assert.equal(complete(await f.process(),'REVIEW').id,scan.id);
  const reviewed=await discovery.load(f.db,f.ctx,scan.id);
  assert.equal(reviewed.sections[0].sourceKind,'scan');assert.match(reviewed.issue,/Check the scan/);
  assert.equal((await f.files()).length,2);
  assert((await require('../../src/projections/postgres-service').needs(f.db,f.ctx.workspaceId,f.ctx.actorId)).some(n=>n.sourceId==='document-discoveries'));
  const approved=await f.approve(scan.id,{targetKind:'purchase_order',reference:f.po.po_number,reason:'Read the printed number on the original PNG.'});
  assert.equal(approved.links.length,1);
});

test('dispatch checks source, stopped authority, plan, quota and lease and deduplicates finished evidence',{timeout:300000},async t=>{
  const f=await fixture(t),{db,ctx}=f,authority={automatic:'yes',authorized:'yes'};
  await assert.rejects(f.submit('Exact source', {automatic:'yes'}),/Confirm automatic filing authority/);
  const scope=await f.configure('supplier:'+f.po.supplier_id,['purchase_order']);
  const mail=await f.capture(f.supplier,'Stopped original.txt',Buffer.from('Packing slip\nPurchase order: '+f.po.po_number+'\nOriginal 220'));
  assert.equal((await f.process('mail.attachment-extract')).status,'COMPLETED');
  await scopes.configure(db,ctx,{stop:'yes',id:scope.id,revision:1});
  assert.equal((await f.process()).status,'DEAD');
  const stopped=(await f.rows())[0];assert.match(stopped.issue,/scope changed or stopped/);
  await discovery.retry(db,ctx,stopped.id);complete(await f.process(),'REVIEW');
  assert.equal((await f.approve(stopped.id)).links.length,1);
  await db.query('DELETE FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,mail.messageId]);
  const bytes='Packing slip\nPurchase order: '+f.po.po_number+'\nExact unique original 499';
  const concurrent=await Promise.all([f.submit(bytes,authority),f.submit(bytes,authority)]);
  assert.equal(concurrent[0].id,concurrent[1].id);assert.equal(concurrent.filter(x=>x.replayed).length,1);
  await f.subscribe('starter');assert.equal((await f.process()).status,'PAUSED');
  assert((await discovery.load(db,ctx,concurrent[0].id)).content.equals(Buffer.from(bytes)));
  await f.subscribe('growth');await discovery.retry(db,ctx,concurrent[0].id);
  const cap=randomUUID();
  await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'agent_documents',0,'Verify original document quota')",[cap,f.owner.accountId]);
  assert.equal((await f.process()).status,'PAUSED');
  assert.match((await discovery.load(db,ctx,concurrent[0].id)).issue,/plan limit/);
  await db.query('DELETE FROM commercial_entitlement_overrides WHERE id=$1',[cap]);
  await discovery.retry(db,ctx,concurrent[0].id);
  const leaseLost=await f.process(discovery.kind,async job=>discovery.run(job,db,{readSource:async()=>{
    await db.query("UPDATE stockchief_runtime.jobs SET lease_expires_at=0 WHERE id=$1",[job.id]);
    return [{page:1,text:bytes,sourceKind:'text'}];
  }}));
  assert.notEqual(leaseLost?.status,'COMPLETED');
  const original=await discovery.load(db,ctx,concurrent[0].id);assert.equal(original.status,'FAILED');
  assert((await f.receipts()).some(r=>r.status==='REVERSED'));
  assert.equal((await f.files()).length,1);
  await discovery.retry(db,ctx,original.id);complete(await f.process(),'REVIEW');
  await f.approve(original.id);await f.approve(original.id);
  assert.equal((await f.files()).length,2);
  assert.equal((await f.receipts()).filter(r=>r.status==='COMMITTED').length,2);

  await f.configure('supplier:'+f.po.supplier_id,['purchase_order']);
  const unchanged=Buffer.from(bytes+'\nRead the preserved mailbox original.');
  const changed=await f.capture(f.supplier,'Changed original.txt',unchanged);
  assert.equal((await f.process('mail.attachment-extract')).status,'COMPLETED');
  const saved=(await f.rows()).find(row=>row.source_message_id===changed.messageId);
  await db.query('UPDATE connection_email_attachments SET content=$2 WHERE id=$1',[saved.attachment_id,Buffer.from('Different original bytes.')]);
  assert.equal((await f.process()).status,'DEAD');
  const held=await discovery.load(db,ctx,saved.id);
  assert.equal(held.status,'FAILED');assert(held.content.equals(unchanged));
  assert.equal((await f.files()).length,2);

  const mode=require('../../src/autopilot/job-modes');
  await mode.save(db,ctx,142,{mode:'watch',revision:0});
  await assert.rejects(f.submit(bytes+'\nNo filing during Watch.'),/Watch only/);
  await mode.save(db,ctx,142,{mode:'inherit',revision:1});
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  await assert.rejects(f.submit(bytes+'\nFirst two weeks.'),/first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'storage_bytes',0,'Verify filing original storage cap')",[cap,f.owner.accountId]);
  await assert.rejects(f.submit(bytes+'\nOver the storage allowance.'),e=>e.code==='entitlement_required');
  assert.equal((await f.rows()).length,3);
});

test('the phone UI approves a new mailbox scope, reviews an upload and protects archived source after role changes',{timeout:300000},async t=>{
  const f=await fixture(t),{db,ctx}=f;
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),url='http://127.0.0.1:'+server.address().port;
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url+'/login');await page.getByLabel('Work email',{exact:true}).fill(f.email);await page.locator('[name=password]').fill(f.password);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(url+'/autopilot/documents');
  await page.getByRole('link',{name:'Discover and file originals',exact:true}).click();
  await page.getByLabel('Connected mailbox',{exact:true}).selectOption(f.mailbox.id);
  await page.getByLabel('Known sender',{exact:true}).selectOption('supplier:'+f.po.supplier_id);
  await page.getByLabel('Purchase orders for this supplier',{exact:true}).check();
  await page.getByLabel(/I authorize filing proven links from new originals/).check();
  await page.getByRole('button',{name:'Approve mailbox filing scope'}).click();
  await page.getByRole('button',{name:'Stop this scope'}).waitFor();
  const bytes=Buffer.from('Packing slip\nPurchase order: '+f.po.po_number+'\nOriginal phone upload proof.');
  await page.getByLabel('Original file up to 20 MB',{exact:true}).setInputFiles({name:'Exact original phone.txt',mimeType:'text/plain',buffer:bytes});
  await page.getByRole('button',{name:'Find exact filing records'}).click();
  await page.locator('[data-filing-status]').waitFor();
  const result=complete(await f.process(),'REVIEW');
  await page.reload();
  await page.getByLabel('File on Purchase order '+f.po.po_number,{exact:true}).check();
  await page.getByLabel(/I checked the exact original and confirm these records/).check();
  await page.getByRole('button',{name:'File on confirmed records'}).click();
  await page.getByRole('link',{name:'Filed copy',exact:true}).waitFor();
  const link=(await f.files())[0];
  const pendingDownload=page.waitForEvent('download');
  await page.getByRole('link',{name:'Download exact original',exact:true}).click();
  const downloaded=await pendingDownload;
  assert(require('node:fs').readFileSync(await downloaded.path()).equals(bytes));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);
  await require('../../src/commercial/storage-capacity').refresh(db,ctx.workspaceId);
  const measured=(await db.query(`SELECT baseline_bytes FROM commercial_storage_usage WHERE workspace_id=$1
    AND relation='stockchief_runtime.agent_document_discoveries'::regclass`,[ctx.workspaceId])).rows[0];
  assert(Number(measured.baseline_bytes)>bytes.length);
  await db.query("UPDATE users SET role='staff' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
  await assert.rejects(discovery.load(db,ctx,result.id),e=>e.code==='forbidden');
  await assert.rejects(require('../../src/documents/agent-filing').load(db,ctx,link.id),e=>e.code==='forbidden');
  await f.browser.get('/autopilot/document-filing/'+result.id+'/original').expect(403);
  await f.browser.get('/autopilot/documents/'+link.id+'/download').expect(403);
});
