'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const reader=require('../../src/documents/agent-shipping-document-reader');
const filing=require('../../src/documents/agent-filing');
const queue=require('../../src/operations/postgres-job-queue');

async function pdf(sections){
  const PDF=require('pdfkit'),doc=new PDF({margin:40}),chunks=[];doc.on('data',b=>chunks.push(b));
  const ended=new Promise(resolve=>doc.on('end',resolve));sections.forEach((s,i)=>{if(i)doc.addPage();doc.fontSize(12).text(s);});doc.end();await ended;
  return Buffer.concat(chunks);
}
async function word(body,footer){
  const zip=new(require('jszip'))(),xml=text=>'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+text.split('\n').map(line=>'<w:p><w:r><w:t>'+line+'</w:t></w:r></w:p>').join('')+'</w:body></w:document>';
  zip.file('word/document.xml',xml(body));zip.file('word/footer1.xml',xml(footer));return zip.generateAsync({type:'nodebuffer'});
}
async function fixture(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t);
  await f.subscribe('pro');await f.db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(f.db,f.ctx,{role:'owner'},'POLICY_AUTOMATED');
  const po=(await f.db.query('SELECT id,po_number,supplier_id,status FROM purchase_orders WHERE workspace_id=$1',[f.ctx.workspaceId])).rows[0];
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const process=async()=>queue.processOne(f.db,{[reader.kind]:handlers[reader.kind]},{owner:'shipping-original-test-worker'});
  const submit=(buffer,extra={})=>reader.enqueue(f.db,f.ctx,{buffer,filename:'Shipping original.txt',...extra});
  const approve=async(id,input={})=>{const screen=await reader.screen(f.db,f.ctx,{id});return reader.approve(f.db,f.ctx,id,{confirmed:'yes',reviewHash:screen.reviewHash,
    purchaseOrderIds:screen.selected.evidence.candidates.map(p=>p.id),...input});};
  const totals=async()=> (await f.db.query("SELECT meter,sum(units)::int AS n FROM commercial_usage_events WHERE workspace_id=$1 AND status='COMMITTED' AND meter IN('agent_documents','ai_work_credits') GROUP BY meter",[f.ctx.workspaceId])).rows;
  const links=async()=> (await f.db.query('SELECT id,target_id,source_hash,document_kind,shipping_reading_id FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 ORDER BY id',[f.ctx.workspaceId])).rows;
  return {...f,po,process,submit,approve,totals,links};
}

test('Growth uploads and reads a complete real PDF on a phone, approves each PO batch, then downloads the preserved original after Starter downgrade',{timeout:300000},async t=>{
  const f=await fixture(t);await f.subscribe('growth');
  const bytes=await pdf(['BILL OF LADING\nB/L No: SC-LAD-9\nContainer: ABCD1234567','Purchase order: '+f.po.po_number+'\nPort of discharge: Rotterdam']);
  const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),url='http://127.0.0.1:'+server.address().port;
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url+'/login');await page.getByLabel('Work email',{exact:true}).fill(f.email);await page.locator('[name=password]').fill(f.password);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(url+'/purchasing/orders/'+f.po.id);await page.getByRole('link',{name:'Read a bill of lading or customs original'}).click();
  assert.equal(await page.getByLabel('Expected purchase order number (optional)',{exact:true}).inputValue(),f.po.po_number);
  assert.equal(await page.locator('[name=automatic]').count(),0);
  await page.getByLabel('Original file up to 20 MB',{exact:true}).setInputFiles({name:'Original bill of lading.pdf',mimeType:'application/pdf',buffer:bytes});
  await page.getByRole('button',{name:'Read complete original'}).click();await page.locator('[data-shipping-reading-status]').waitFor();
  const id=(await reader.screen(f.db,f.ctx)).rows[0].id,job=await f.process();assert.equal(job.status,'COMPLETED',JSON.stringify(job.lastError));assert.equal(job.result.status,'READY');
  assert.equal((await f.links()).length,0);await page.reload();assert.match(await page.locator('[data-shipping-reading-status]').innerText(),/Ready/);
  assert.match(await page.locator('main').innerText(),/Section 2.*Purchase order/);
  assert((await require('../../src/projections/postgres-service').needs(f.db,f.ctx.workspaceId,f.ctx.actorId)).some(n=>n.sourceId==='shipping-document-readings'));
  await page.getByLabel(/I reviewed this complete original/).check();await page.getByRole('button',{name:'Approve exact PO links'}).click();
  await page.getByText('Filed on the purchase order',{exact:true}).waitFor();const link=(await f.links())[0];assert.equal(link.target_id,f.po.id);assert.equal(link.document_kind,'bill_of_lading');
  assert.equal((await f.totals()).find(r=>r.meter==='agent_documents').n,1);assert((await filing.load(f.db,f.ctx,link.id)).content.equals(bytes));
  const getDownload=page.waitForEvent('download');await page.getByRole('link',{name:'Download exact original'}).click();assert(require('node:fs').readFileSync(await(await getDownload).path()).equals(bytes));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  require('node:fs').mkdirSync('output',{recursive:true});await page.screenshot({path:'output/shipping-document-reading-phone.png',fullPage:true});
  await f.subscribe('starter');await page.reload();assert.equal(await page.locator('[data-shipping-original-plan-locked]').count(),1);
  assert.equal((await f.browser.get('/autopilot/documents/'+link.id+'/download').expect(200)).body.equals(bytes),true);
  await assert.rejects(f.submit(bytes,{filename:'Duplicate.pdf'}),e=>e.code==='entitlement_required');
  assert.equal(await f.balance(),4);assert.equal((await f.db.query('SELECT status FROM purchase_orders WHERE id=$1',[f.po.id])).rows[0].status,f.po.status);
});

test('Pro and Custom file exact complete Word and HTML originals without training and with explicit per-original authority',{timeout:300000},async t=>{
  const f=await fixture(t),authority={automatic:'yes',authorized:'yes',purchaseOrder:f.po.po_number};
  const bytes=await word('Déclaration en douane\nRéférence douanière: A001','Bon de commande: '+f.po.po_number);
  await assert.rejects(f.submit(bytes,{filename:'Original declaration.docx',automatic:'yes'}),/Explicitly authorize/);
  const requests=await Promise.all([f.submit(bytes,{filename:'Original declaration.docx',...authority}),f.submit(bytes,{filename:'Renamed customs.docx',...authority})]);
  assert.equal(requests[0].id,requests[1].id);const job=await f.process();assert.equal(job.status,'COMPLETED',JSON.stringify(job.lastError));assert.equal(job.result.status,'FILED');
  const source=await reader.load(f.db,f.ctx,requests[0].id);assert.equal(source.original_sections.length,2);assert.equal(source.evidence.referenceEvidence[0].page,2);assert.equal(source.document_kind,'customs');
  await f.subscribe('enterprise');const html=Buffer.from('<h1>Bill of Lading</h1><p>Purchase order: '+f.po.po_number+'</p><p>Carrier: Exact carrier</p><script>Purchase order: FALSE-PO</script>');
  const another=await f.submit(html,{filename:'Complete carrier original.html',...authority});const completed=await f.process();assert.equal(completed.status,'COMPLETED',JSON.stringify(completed.lastError));assert.equal(completed.result.status,'FILED',JSON.stringify((await reader.load(f.db,f.ctx,another.id)).evidence));
  const links=await f.links();assert.equal(links.length,2);assert(links.every(link=>link.target_id===f.po.id));assert((await filing.load(f.db,f.ctx,links.find(l=>l.shipping_reading_id===another.id).id)).content.equals(html));
  assert.equal((await f.totals()).find(r=>r.meter==='agent_documents').n,2);assert(!(await f.totals()).some(r=>r.meter==='ai_work_credits'));
});

test('trusted saved attachment receipt is reused and preserved after mail deletion, while the wrong supplier cannot be linked',{timeout:300000},async t=>{
  const f=await fixture(t);await f.subscribe('growth');
  const now=new Date().toISOString(),connector=(await f.db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
    VALUES('shipping-original-mail',$1,'shipping-original-mail','Shipping original mailbox','gmail','[]','{}','connected','[]',5,'CONNECTED',$2,$3,$3) RETURNING *`,[f.ctx.workspaceId,f.ctx.actorId,now])).rows[0];
  await f.db.query("UPDATE suppliers SET email='shipping-original@example.test' WHERE workspace_id=$1 AND id=$2",[f.ctx.workspaceId,f.po.supplier_id]);
  const source=Buffer.from('CUSTOMS DECLARATION\nPurchase order: '+f.po.po_number+'\nMRN: CUSTOMS-01');
  const message=await require('../../src/connections/postgres-mail').capture(f.db,connector,{externalMessageId:randomUUID(),sender:'shipping-original@example.test',subject:'Original customs paper',bodyText:'Original enclosed.',attachments:[{filename:'Customs original.txt',contentBase64:source.toString('base64')}]});
  await require('../../src/connections/postgres-attachments').extractMessage(f.db,f.ctx.workspaceId,message.messageId);
  const attachment=(await f.db.query('SELECT id FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2',[f.ctx.workspaceId,message.messageId])).rows[0];
  assert.equal((await f.totals()).find(r=>r.meter==='agent_documents').n,1);
  const r=await reader.enqueue(f.db,f.ctx,{fileAttachment:attachment.id,purchaseOrder:f.po.po_number});const job=await f.process();assert.equal(job.status,'COMPLETED',JSON.stringify(job.lastError));assert.equal(job.result.documents,0);
  const wrong=await require('../../src/operations/postgres-commerce').createSupplier(f.db,f.ctx,{name:'Different exact supplier'});
  await f.db.query('UPDATE purchase_orders SET supplier_id=$3 WHERE workspace_id=$1 AND id=$2',[f.ctx.workspaceId,f.po.id,wrong.id]);
  await assert.rejects(f.approve(r.id),/selected purchase order changed/);assert.equal((await f.links()).length,0);
  await f.db.query('UPDATE purchase_orders SET supplier_id=$3 WHERE workspace_id=$1 AND id=$2',[f.ctx.workspaceId,f.po.id,f.po.supplier_id]);
  const applied=await f.approve(r.id);await f.db.query('DELETE FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[f.ctx.workspaceId,message.messageId]);
  assert((await filing.load(f.db,f.ctx,applied.links[0].id)).content.equals(source));assert((await reader.load(f.db,f.ctx,r.id)).content.equals(source));
  assert.equal((await f.totals()).find(r=>r.meter==='agent_documents').n,1);
  const oldBytes=Buffer.from('CUSTOMS DECLARATION\nPurchase order: '+f.po.po_number+'\nMRN: LEGACY-ORIGINAL');
  const oldMail=await require('../../src/connections/postgres-mail').capture(f.db,connector,{externalMessageId:randomUUID(),sender:'shipping-original@example.test',subject:'Previously filed original',bodyText:'Original enclosed.',attachments:[{filename:'Legacy customs original.txt',contentBase64:oldBytes.toString('base64')}]});
  await require('../../src/connections/postgres-attachments').extractMessage(f.db,f.ctx.workspaceId,oldMail.messageId);
  const oldAttachment=(await f.db.query('SELECT id FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2',[f.ctx.workspaceId,oldMail.messageId])).rows[0];
  const assistant=require('../../src/assistant/postgres-service'),prepared=await assistant.prepareAction(f.db,f.ctx,'File the original customs paper',{action:'document.file_to_purchase_order',recordReference:f.po.po_number,fileAttachment:oldAttachment.id,documentKind:'customs'});
  const oldFiling=(await assistant.executeProposal(f.db,f.ctx,prepared.proposal.id)).result.documentId;
  await f.db.query('DELETE FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[f.ctx.workspaceId,oldMail.messageId]);
  const reread=await reader.enqueue(f.db,f.ctx,{filedDocument:oldFiling,purchaseOrder:f.po.po_number});
  const done=await f.process();assert.equal(done.status,'COMPLETED',JSON.stringify(done.lastError));assert.equal(done.result.documents,0);
  const preserved=await f.approve(reread.id);assert.equal(preserved.links[0].id,oldFiling);assert.equal((await f.links()).length,2);
  assert.equal((await filing.load(f.db,f.ctx,oldFiling)).shipping_reading_id,reread.id);assert.equal((await f.totals()).find(r=>r.meter==='agent_documents').n,2);
});

test('actual photographed originals and unresolved references stay for owner review, while complete multi-PO batches link only proven records',{timeout:300000},async t=>{
  const f=await fixture(t),authority={automatic:'yes',authorized:'yes'};
  const second=await f.workflows.createPurchaseOrder(f.db,f.ctx,{supplierId:f.po.supplier_id,destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:1,unitCost:'2.00'}]});
  const other=(await f.db.query('SELECT id,po_number FROM purchase_orders WHERE id=$1',[second.purchaseOrderId])).rows[0];
  const canvas=require('@napi-rs/canvas').createCanvas(1400,450),c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,1400,450);c.fillStyle='black';c.font='42px Arial';
  c.fillText('BILL OF LADING',40,80);c.fillText('Purchase order: '+f.po.po_number,40,160);c.fillText('Container: ABCD1234567',40,240);
  const image=await f.submit(canvas.toBuffer('image/png'),{filename:'Photographed bill.png',purchaseOrder:f.po.po_number,...authority});
  let job=await f.process();assert.equal(job.status,'COMPLETED',JSON.stringify(job.lastError));assert.equal(job.result.status,'READY');
  let r=await reader.load(f.db,f.ctx,image.id);assert.equal(r.original_sections[0].sourceKind,'scan');assert(r.evidence.references.every(ref=>ref.uncertain));assert.equal((await f.links()).length,0);
  await assert.rejects(f.approve(r.id,{purchaseOrder:f.po.po_number}),/how you verified/);
  await f.approve(r.id,{purchaseOrder:f.po.po_number,matchReason:'Compared the printed PO number directly with the stored original image.'});
  const multi=Buffer.from('CUSTOMS DECLARATION\nPurchase orders: '+f.po.po_number+', '+other.po_number+'\nMRN: SC-CUSTOMS-MULTI');
  const both=await f.submit(multi,authority);job=await f.process();assert.equal(job.status,'COMPLETED',JSON.stringify(job.lastError));assert.equal(job.result.links,2);
  r=await reader.load(f.db,f.ctx,both.id);assert.deepEqual(new Set(r.linked_documents.map(l=>l.poId)),new Set([f.po.id,other.id]));
  const conflict=await f.submit(Buffer.from('CUSTOMS DECLARATION\nPurchase order: '+f.po.po_number+'-LOOKALIKE\nOther note mentions '+f.po.po_number),authority);
  job=await f.process();assert.equal(job.result.status,'READY');assert.equal(job.result.links,0);
  await assert.rejects(f.approve(conflict.id,{purchaseOrder:f.po.po_number,matchReason:'Caller chose another order.'}),/identifies different purchase orders/);
  assert.equal((await f.links()).length,3);assert.equal(await f.balance(),4);
});

test('current plan, Watch, credits, stale PO identity and worker recovery fence new reads and return unused document reservations',{timeout:300000},async t=>{
  const f=await fixture(t),raw=Buffer.from('BILL OF LADING\nPurchase order: '+f.po.po_number+'\nCarrier: Exact carrier'),request={purchaseOrder:f.po.po_number};
  let reading=await f.submit(raw,{...request,automatic:'yes',authorized:'yes'});await f.subscribe('growth');
  let job=await f.process();assert.equal(job.status,'PAUSED');assert.equal((await reader.load(f.db,f.ctx,reading.id)).status,'FAILED');assert.equal((await f.totals()).length,0);await f.subscribe('pro');
  reading=await f.submit(raw,request);const modes=require('../../src/autopilot/job-modes');await modes.save(f.db,f.ctx,137,{mode:'watch',revision:0});
  job=await f.process();assert.equal(job.status,'DEAD');assert.match((await reader.load(f.db,f.ctx,reading.id)).issue,/Watch only/);await modes.save(f.db,f.ctx,137,{mode:'inherit',revision:1});
  reading=await f.submit(raw,request);await f.db.query('UPDATE purchase_orders SET po_number=$3 WHERE workspace_id=$1 AND id=$2',[f.ctx.workspaceId,f.po.id,f.po.po_number+'-CHANGED']);
  job=await f.process();assert.equal(job.status,'DEAD');assert.match((await reader.load(f.db,f.ctx,reading.id)).issue,/purchase order changed/);
  await f.db.query('UPDATE purchase_orders SET po_number=$3 WHERE workspace_id=$1 AND id=$2',[f.ctx.workspaceId,f.po.id,f.po.po_number]);
  await f.db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES('shipping-document-cap',$1,'agent_documents',0,'Synthetic document allowance test')",[f.owner.accountId]);
  reading=await f.submit(raw,request);job=await f.process();assert.equal(job.status,'PAUSED');assert.equal((await reader.load(f.db,f.ctx,reading.id)).status,'FAILED');
  await f.db.query("DELETE FROM commercial_entitlement_overrides WHERE id='shipping-document-cap'");
  reading=await f.submit(raw,request);const leased=await queue.claim(f.db,{owner:'simulated interrupted shipping reader',kinds:[reader.kind],leaseMs:60000});
  const ent=require('../../src/commercial/entitlements'),scope=await ent.ownerScopeForWorkspace(f.db,f.ctx.workspaceId),key='simulated shipping document crash';
  await f.db.transaction(async c=>{await ent.reserveUsage(c,scope,{meter:'agent_documents',units:1,idempotencyKey:key});await c.query(`UPDATE ${reader.table} SET status='RUNNING',owns_document_usage=true,document_usage_key=$2 WHERE id=$1`,[reading.id,key]);await c.query('UPDATE stockchief_runtime.jobs SET lease_expires_at=0 WHERE id=$1',[leased.id]);});
  await queue.claim(f.db,{owner:'recovery shipping reader',kinds:[reader.kind]});
  assert.equal((await reader.load(f.db,f.ctx,reading.id)).status,'FAILED');assert.equal((await f.db.query('SELECT status FROM commercial_usage_events WHERE workspace_id=$1 AND idempotency_key=$2',[f.ctx.workspaceId,key])).rows[0].status,'REVERSED');
  const broken=await f.submit(Buffer.from('%PDF-1.7\nInvalid whole PDF original'),{filename:'Broken.pdf'});job=await f.process();assert.equal(job.status,'DEAD');
  assert.equal((await reader.load(f.db,f.ctx,broken.id)).status,'FAILED');assert.equal((await f.totals()).length,0);assert.equal((await f.links()).length,0);
});
