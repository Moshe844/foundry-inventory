'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('original documents file on the exact business record, retain plan limits and survive mailbox deletion',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe,browser,workflows}=f;
 await subscribe('growth');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 await db.query("UPDATE suppliers SET email='files@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
 const now=new Date().toISOString(),connection=(await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
  VALUES('filing-mailbox',$1,'filing-mailbox','Filing mailbox','gmail','[]','{}','connected','[]',5,'CONNECTED',$2,$3,$3) RETURNING *`,[ctx.workspaceId,ctx.actorId,now])).rows[0];
 const po=(await db.query('SELECT id,po_number FROM purchase_orders WHERE workspace_id=$1 ORDER BY id LIMIT 1',[ctx.workspaceId])).rows[0];
 const sale=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:1000}]});
 const number=(await db.query('SELECT order_number FROM sales_orders WHERE id=$1',[sale.salesOrderId])).rows[0].order_number;
 const mail=require('../../src/connections/postgres-mail'),attachments=require('../../src/connections/postgres-attachments'),assistant=require('../../src/assistant/postgres-service');
 async function captured(filename,content,sender='files@example.test'){
  const saved=await mail.capture(db,connection,{externalMessageId:randomUUID(),sender,subject:'Source documents',bodyText:'See attached source.',receivedAt:now,attachments:[{filename,contentBase64:content.toString('base64')}]});
  const result=await attachments.extractMessage(db,ctx.workspaceId,saved.messageId);assert.equal(result.attachments[0].status,'READABLE');
  return (await db.query('SELECT * FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2',[ctx.workspaceId,saved.messageId])).rows[0];
 }
 const pdf=new (require('pdfkit'))({compress:false}),chunks=[];pdf.on('data',b=>chunks.push(b));const ended=new Promise(resolve=>pdf.on('end',resolve));pdf.text('BILL OF LADING\nPurchase order '+po.po_number+'\nContainer ABCD1234567\nCustoms reference CUSTOMS-42');pdf.end();await ended;
 const original=Buffer.concat(chunks),bol=await captured('Bill of lading.pdf',original),args={action:'document.file_to_purchase_order',recordReference:po.po_number,fileAttachment:bol.id,documentKind:'bill_of_lading'};
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);if(tier==='starter'){await assert.rejects(assistant.prepareAction(db,ctx,'File the bill of lading',args),e=>e.code==='entitlement_required');await browser.get('/autopilot/reviews/shipping-documents').expect(402);}
  else{const prepared=await assistant.prepareAction(db,ctx,'File the bill of lading',args);assert.match(prepared.proposal.summary,/File Bill of lading.pdf/);await browser.get('/autopilot/reviews/shipping-documents').expect(200);}
 }
 await subscribe('growth');const p=await assistant.prepareAction(db,ctx,'File the bill of lading',{...args,documentKind:'other'});
 assert.equal((await db.query('SELECT payload FROM stockchief_runtime.assistant_action_proposals WHERE id=$1',[p.proposal.id])).rows[0].payload.documentKind,'bill_of_lading','Relabelling shipping paperwork cannot bypass its plan ceiling.');
 const plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
 await plans.save(db,ctx,'File then inspect shipping documents',randomUUID(),[{contract:registry.get(args.action),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'shipping-documents'},dependsOn:[0]}],[{result:p},{result:{status:'CLARIFY'}}]);
 await assert.rejects(assistant.executeMission(db,ctx,p.proposal.id),e=>e.code==='entitlement_required');
 await subscribe('starter');await assert.rejects(assistant.executeProposal(db,ctx,p.proposal.id),e=>e.code==='entitlement_required');
 await subscribe('growth');const modes=require('../../src/autopilot/job-modes');await modes.save(db,ctx,142,{mode:'watch',revision:0});
 await assert.rejects(assistant.executeProposal(db,ctx,p.proposal.id),/Watch only/);await modes.save(db,ctx,142,{mode:'inherit',revision:1});
 const filed=await assistant.executeProposal(db,ctx,p.proposal.id);await assistant.executeProposal(db,ctx,p.proposal.id);
 const id=filed.result.documentId,view=await browser.get('/autopilot/documents/'+id).expect(200);assert.match(view.text,/Container ABCD1234567/);assert.match(view.text,new RegExp('/purchasing/orders/'+po.id));
 const download=await browser.get('/autopilot/documents/'+id+'/download').expect(200);assert.deepEqual(download.body,original);
 await db.query('DELETE FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,bol.message_id]);
 const retained=(await db.query('SELECT * FROM stockchief_runtime.agent_filed_documents WHERE id=$1',[id])).rows[0];assert.equal(retained.source_attachment_id,null);assert.deepEqual(retained.content,original);
 assert.match((await browser.get('/autopilot/documents/'+id).expect(200)).text,/CUSTOMS-42/);
 const recordList='/autopilot/documents?'+new URLSearchParams({kind:'purchase_order',record:po.id});
 assert.match((await browser.get('/purchasing/orders/'+po.id).expect(200)).text,/Filed documents/);
 assert.match((await browser.get(recordList).expect(200)).text,/Bill of lading.pdf/);
 await subscribe('starter');await browser.get('/autopilot/documents/'+id).expect(200);await browser.get(recordList).expect(200);await assert.rejects(assistant.prepareAction(db,ctx,'File an old source',args),e=>e.code==='entitlement_required');
 await subscribe('growth');const renamed=await captured('Renamed BOL.pdf',original),again=await assistant.prepareAction(db,ctx,'File renamed source',{...args,fileAttachment:renamed.id});
 assert.equal((await assistant.executeProposal(db,ctx,again.proposal.id)).result.documentId,id);
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
 for(const tier of ['pro','enterprise']){
  await subscribe(tier);const customs=await captured('Customs '+tier+'.txt',Buffer.from('Customs declaration '+tier+'\nPurchase order '+po.po_number+'\nEntry 42'));
  const automatic=await assistant.prepareAction(db,ctx,'File this customs declaration',{...args,fileAttachment:customs.id,documentKind:'customs'});
  await plans.save(db,ctx,'File customs then inspect sources',randomUUID(),[{contract:registry.get(args.action),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'shipping-documents'},dependsOn:[0]}],[{result:automatic},{result:{status:'CLARIFY'}}]);
  await assistant.executeMission(db,ctx,automatic.proposal.id);
  assert((await db.query('SELECT 1 FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 AND source_hash=$2 AND target_id=$3',[ctx.workspaceId,customs.content_hash,po.id])).rowCount);
 }
 await subscribe('growth');
 const orderText=Buffer.from('Customer order '+number+'\nAgreed delivery note. <script>do not execute</script>'),customerFile=await captured('Customer order.txt',orderText,'receiver@example.test');
 const customerArgs={action:'document.file_to_sales_order',recordReference:number,fileAttachment:customerFile.id,documentKind:'other'};
 const orderProposal=await assistant.prepareAction(db,ctx,'File customer source',customerArgs);
 await plans.save(db,ctx,'File this matching order source then inspect documents',randomUUID(),[{contract:registry.get(customerArgs.action),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'filed-documents'},dependsOn:[0]}],[{result:orderProposal},{result:{status:'CLARIFY'}}]);
 await assistant.executeMission(db,ctx,orderProposal.proposal.id);
 const customerDoc=(await db.query("SELECT id FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 AND target_kind='sales_order'",[ctx.workspaceId])).rows[0];assert(customerDoc);
 const escaped=await browser.get('/autopilot/documents/'+customerDoc.id).expect(200);assert.match(escaped.text,/&lt;script&gt;/);assert(!escaped.text.includes('<script>do not execute'));
 const sku=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code,productFile=await captured('Safety sheet.txt',Buffer.from('Product '+sku+'\nWear protective gloves.'));
 const productArgs={action:'document.file_to_item',recordReference:'Parcel item',fileAttachment:productFile.id,documentKind:'safety_sheet'},product=await assistant.prepareAction(db,ctx,'File product source',productArgs);
 await db.query("UPDATE connection_email_attachments SET extracted_text=extracted_text||'Changed' WHERE id=$1",[productFile.id]);
 await assert.rejects(assistant.executeProposal(db,ctx,product.proposal.id),/changed after review/);
 const current=await assistant.prepareAction(db,ctx,'File reviewed product source',productArgs),productResult=await assistant.executeProposal(db,ctx,current.proposal.id);
 assert.match((await browser.get('/autopilot/documents/'+productResult.result.documentId).expect(200)).text,new RegExp('/inventory/'+f.item.itemId));
 assert.match((await browser.get('/inventory/'+f.item.itemId).expect(200)).text,/Filed documents/);
 assert.match((await browser.get('/orders/'+sale.salesOrderId).expect(200)).text,/Filed documents/);
 const unrelated=await captured('Unrelated.txt',Buffer.from('A document without a target number.'));
 const mismatch=await assistant.prepareAction(db,ctx,'File unmatched source',{...args,fileAttachment:unrelated.id,documentKind:'other'});
 await plans.save(db,ctx,'File unmatched source and inspect records',randomUUID(),[{contract:registry.get(args.action),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'filed-documents'},dependsOn:[0]}],[{result:mismatch},{result:{status:'CLARIFY'}}]);
 await assert.rejects(assistant.executeMission(db,ctx,mismatch.proposal.id),/own confirmation/);
 const limitedFile=await captured('Storage test.txt',Buffer.from('Purchase order '+po.po_number+'\nOriginal source retained under the account storage limit.'));
 const limited=await assistant.prepareAction(db,ctx,'File within storage allowance',{...args,fileAttachment:limitedFile.id,documentKind:'other'}),override=randomUUID();
 await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'storage_bytes',0,'Verify document filing capacity')",[override,f.owner.accountId]);
 await assert.rejects(assistant.executeProposal(db,ctx,limited.proposal.id),e=>e.code==='entitlement_required');
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 AND source_hash=$2',[ctx.workspaceId,limitedFile.content_hash])).rows[0].n,0);
 await db.query('DELETE FROM commercial_entitlement_overrides WHERE id=$1',[override]);await assistant.executeProposal(db,ctx,limited.proposal.id);
 await require('../../src/commercial/storage-capacity').refresh(db,ctx.workspaceId);
 const measured=(await db.query("SELECT baseline_bytes FROM commercial_storage_usage WHERE workspace_id=$1 AND relation='stockchief_runtime.agent_filed_documents'::regclass",[ctx.workspaceId])).rows[0];assert(Number(measured.baseline_bytes)>original.length);
 assert.equal(await f.balance(),4);assert.equal((await db.query('SELECT count(*)::int n FROM accounting_supplier_bills WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
 const service=require('../../src/documents/agent-filing');await assert.rejects(service.load(db,{...ctx,actorId:'other-user'},id),/owner/);await assert.rejects(service.load(db,{...ctx,workspaceId:'other-inventory'},id),/owner/);
 assert((await db.query("SELECT 1 FROM commercial_storage_usage WHERE workspace_id=$1 AND relation='stockchief_runtime.agent_filed_documents'::regclass",[ctx.workspaceId])).rowCount);
 const crypto=require('node:crypto'),history=Array.from({length:51},(_,i)=>{const content='Original archived source '+i+' for '+po.po_number,hash=crypto.createHash('sha256').update(content).digest('hex');return {id:randomUUID(),content,hash};});
 await db.query(`INSERT INTO stockchief_runtime.agent_filed_documents(id,workspace_id,source_hash,source_text_hash,filename,content,extracted_text,document_kind,target_kind,target_id,target_reference,filed_by)
  SELECT x.id,$1,x.hash,x.hash,'Archive '||x.id||'.txt',convert_to(x.content,'UTF8'),x.content,'other','purchase_order',$3,$4,$5 FROM jsonb_to_recordset($2::jsonb)x(id text,content text,hash text)`,[ctx.workspaceId,JSON.stringify(history),po.id,po.po_number,ctx.actorId]);
 const first=await service.forRecord(db,ctx,'purchase_order',po.id),second=await service.forRecord(db,ctx,'purchase_order',po.id,first.next),allIds=[...first.rows,...second.rows].map(r=>r.id);
 assert.equal(first.rows.length,50);assert(second.rows.length>0);assert.equal(new Set(allIds).size,allIds.length);
 assert.equal(allIds.length,(await db.query("SELECT count(*)::int n FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 AND target_kind='purchase_order' AND target_id=$2",[ctx.workspaceId,po.id])).rows[0].n);
 await assert.rejects(service.forRecord(db,ctx,'purchase_order',po.id,customerDoc.id),/Reopen the document list/);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
 try{
  const page=await chrome.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),base='http://127.0.0.1:'+server.address().port;
  await page.goto(base+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(base+recordList);assert(await page.getByRole('link',{name:'Next documents',exact:true}).isVisible());
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.goto(base+'/autopilot/documents/'+id);assert(await page.getByRole('link',{name:'Download original file',exact:true}).isVisible());assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:'output/agent-plan-review/filed-document-phone.png',fullPage:true});
 }finally{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();}
});
