'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 184: customer invoices and supplier bills sent to QuickBooks or Xero.
async function fixture(t,plan){
 for(const [name,value] of [['QUICKBOOKS_CLIENT_ID','offline-fake'],['QUICKBOOKS_CLIENT_SECRET','offline-fake'],['QUICKBOOKS_ENVIRONMENT','sandbox'],['XERO_CLIENT_ID','offline-fake'],['XERO_CLIENT_SECRET','offline-fake']]){
  const prior=process.env[name];process.env[name]=value;t.after(()=>{if(prior===undefined)delete process.env[name];else process.env[name]=prior;});
 }
 const books=require('../helpers/fake-accounting-books').install(t);
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx}=f;
 await f.subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const autopilot=require('../../src/autopilot/postgres-service');await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');await f.subscribe(plan);
 const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 const accounts=Object.fromEntries((await db.query('SELECT system_key,id FROM accounting_accounts WHERE workspace_id=$1 AND system_key IS NOT NULL',[ctx.workspaceId])).rows.map(r=>[r.system_key,r.id]));
 const connect=async(type,name)=>{
  const id=randomUUID(),account=(type==='quickbooks'?'realm-':'tenant-')+id.slice(0,8),at=new Date().toISOString();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
   VALUES($1,$2,$1,$3,$4,'[]','{}','connected','["accounting:read","accounting:post"]',$5,'ACCOUNTING_WRITE_ENABLED',$6,$7,now(),now())`,[id,ctx.workspaceId,name,type,'connection_credentials:'+id,ctx.actorId,account]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,id,'provider',{accessToken:'fake-books-token',refreshToken:'fake-refresh',
   expiresAt:new Date(Date.now()+86400000).toISOString(),...(type==='quickbooks'?{realmId:account}:{tenantId:account})}));
  await db.query(`INSERT INTO accounting_sync_policies(id,workspace_id,connector_id,provider_type,accounting_source,posting_direction,requested_authority,stage,verified_fact,verified_at,write_enabled_by_user_id,write_enabled_at,created_at,updated_at)
   VALUES($1,$2,$3,$4,'FOUNDRY','FOUNDRY_TO_EXTERNAL','POST','WRITE_ENABLED','{}',$5,$6,$5,$5,$5)`,[randomUUID(),ctx.workspaceId,id,type,at,ctx.actorId]);
  await db.query(`INSERT INTO accounting_shadow_runs(id,workspace_id,connector_id,status,as_of,local_snapshot,external_snapshot,started_at,completed_at) VALUES($1,$2,$3,'MATCHED',$4,'{}',$5,$6,$6)`,
   [randomUUID(),ctx.workspaceId,id,today,JSON.stringify({currency:'USD',accounts:[{externalId:'ext-sales',code:'4000'},{externalId:'ext-expense',code:'6000'},{externalId:'ext-cogs',code:'5000'},{externalId:'ext-stock',code:'1200'}]}),at]);
  return (await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[id])).rows[0];
 };
 const documents=require('../../src/accounting/agent-accounting-documents'),sync=require('../../src/accounting/postgres-integration-sync');
 const invoice=async(number,amount,tax='0',issueDate=today)=>require('../../src/accounting/postgres-manual-invoices').createCustomerInvoice(db,ctx,{customerId:'fixture-customer',description:'Install service',quantity:1,unitAmount:amount,tax,issueDate,idempotencyKey:randomUUID(),documentNumber:number});
 const bill=async(number,cents)=>f.workflows.recordSupplierInvoice(db,ctx,{supplierId:'fixture-supplier',supplierInvoiceNumber:number,currency:'USD',issueDate:today,idempotencyKey:randomUUID(),lines:[{description:'Freight in',quantity:1,unitCostMinor:cents}]});
 const row=async(box,kind,id)=>(await db.query('SELECT * FROM stockchief_runtime.agent_accounting_documents WHERE workspace_id=$1 AND connector_id=$2 AND document_kind=$3 AND document_id=$4',[ctx.workspaceId,box.id,kind,id])).rows[0];
 const runtime=require('../../src/operations/postgres-runtime-handlers').create();
 const run=()=>runtime['agent.accounting-documents.v1']({workspaceId:ctx.workspaceId,payload:{}},db);
 const deliver=async()=>{const out=[];for(const e of (await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='accounting.document.export' AND status='PENDING' ORDER BY created_at,id",[ctx.workspaceId])).rows){
  try{out.push(await runtime['provider.effect']({workspaceId:ctx.workspaceId,payload:{effectId:e.id},kind:'provider.effect'},db));}catch(error){out.push({error:error.message,code:error.code});}}return out;};
 // Mapping an account resets verified posting until the books are compared
 // again (the connection page); the test turns it back on as the owner would.
 const map=async(box,kind,localKey,externalId)=>{await documents.saveMapping(db,ctx,{connectorId:box.id,kind,localKey,externalId});
  if(kind==='account')await db.query("UPDATE accounting_sync_policies SET stage='WRITE_ENABLED',write_enabled_by_user_id=$2,write_enabled_at=now()::text WHERE connector_id=$1",[box.id,ctx.actorId]);};
 const needs=()=>require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);
 const pending=box=>sync.pendingEntries(db,ctx.workspaceId,box.id);
 const journalOf=async id=>(await db.query('SELECT journal_entry_id FROM accounting_customer_invoices WHERE id=$1 UNION ALL SELECT journal_entry_id FROM accounting_supplier_bills WHERE id=$1',[id])).rows[0].journal_entry_id;
 return {...f,books,autopilot,today,accounts,connect,documents,sync,invoice,bill,row,run,deliver,map,needs,pending,journalOf,modes:require('../../src/autopilot/job-modes')};
}

test('each plan by its mode: Starter and Growth locked, Pro drafts until taught by an approved example or the rule, nothing counted twice',{timeout:600000},async t=>{
 const f=await fixture(t,'starter'),{db,ctx}=f,qb=await f.connect('quickbooks','Main books');
 // Starter and Growth: not included. Nothing is read, sent or saved.
 assert.equal((await f.run()).skipped,true);
 await assert.rejects(f.documents.saveSettings(db,ctx,{connectorId:qb.id,kinds:['invoice','bill']}),/Pro plan/);
 await f.subscribe('growth');assert.equal((await f.run()).skipped,true);
 await assert.rejects(f.documents.saveSettings(db,ctx,{connectorId:qb.id,kinds:['invoice','bill']}),/Pro plan/);
 // Pro: turned on for these books from today.
 await f.subscribe('pro');
 await f.documents.saveSettings(db,ctx,{connectorId:qb.id,kinds:['invoice','bill'],startDate:f.today});
 const first=await f.invoice('INV-A1','120.00');
 // Each missing link stops and asks, one at a time; nothing is guessed.
 let r=await f.run();assert.equal(r.held,1,JSON.stringify(r));
 let saved=await f.row(qb,'invoice',first.id);assert.equal(saved.status,'HELD');assert.match(saved.reason,/Link Receiver to a QuickBooks customer/);assert.equal(saved.need.kind,'customer');
 assert((await f.needs()).some(n=>n.sourceId==='accounting-document:'+qb.id+':invoice:'+first.id&&/needs you/.test(n.title)));
 assert(!(await f.pending(qb)).some(e=>e.id===saved.journal_entry_id),'Its journal waits for the invoice, so nothing is counted twice.');
 await f.map(qb,'customer','fixture-customer','qb-cust-1');await f.run();
 assert.match((await f.row(qb,'invoice',first.id)).reason,/Map the Sales revenue account to QuickBooks/);
 await f.map(qb,'account',f.accounts.SALES_REVENUE,'ext-sales');await f.run();
 assert.match((await f.row(qb,'invoice',first.id)).reason,/QuickBooks product or service used for Sales revenue/);
 await f.map(qb,'sales_item',f.accounts.SALES_REVENUE,'qb-item-sales');await f.run();
 assert.match((await f.row(qb,'invoice',first.id)).reason,/tax code for untaxed sales/);
 await f.map(qb,'tax_code','sale_untaxed','NON');
 // Untaught Pro prepares it for approval.
 r=await f.run();assert.equal(r.drafted,1);saved=await f.row(qb,'invoice',first.id);assert.equal(saved.status,'DRAFTED');assert.match(saved.reason,/not taught StockChief to send invoices/);
 assert.equal(f.books.posts.quickbooks,0);
 assert.equal((await f.run()).drafted,1);assert.equal((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action='Invoice or bill prepared for approval'",[ctx.workspaceId])).rows[0].n,1,'An unchanged outcome is not audited again.');
 // The owner sends the exact document.
 const page=await f.documents.detail(db,ctx,qb.id,'invoice',first.id);assert.equal(page.canSend,true);assert.equal(page.document.total,'120.00');
 await assert.rejects(f.documents.approve(db,ctx,qb.id,'invoice',first.id,{expectedFingerprint:page.fingerprint}),/Confirm/);
 await f.documents.approve(db,ctx,qb.id,'invoice',first.id,{confirmed:'yes',expectedFingerprint:page.fingerprint});
 let out=await f.deliver();assert.equal(out.length,1);assert.equal(out[0].externalId,'qb-1',JSON.stringify(out));
 saved=await f.row(qb,'invoice',first.id);assert.equal(saved.status,'SENT');assert.equal(saved.external_id,'qb-1');assert.equal(saved.automatic,false);
 const posted=f.books.docs.quickbooks[0];assert.equal(posted.DocNumber,'INV-A1');assert.equal(posted.CustomerRef.value,'qb-cust-1');assert.equal(posted.TotalAmt,120);
 assert.equal(posted.Line[0].SalesItemLineDetail.ItemRef.value,'qb-item-sales');assert.equal(posted.Line[0].SalesItemLineDetail.TaxCodeRef.value,'NON');assert.match(posted.PrivateNote,/StockChief invoice/);
 assert.equal((await db.query("SELECT external_id FROM accounting_external_identities WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='customer_invoice' AND foundry_record_id=$3",[ctx.workspaceId,qb.id,first.id])).rows[0].external_id,'qb-1');
 assert(!(await f.needs()).some(n=>n.sourceId==='accounting-document:'+qb.id+':invoice:'+first.id));
 assert(!(await f.pending(qb)).some(e=>e.id===saved.journal_entry_id),'The invoice carries its whole journal.');
 // Replays change nothing and post nothing.
 const effect=(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='accounting.document.export'",[ctx.workspaceId])).rows[0].id;
 assert.equal((await f.documents.executeEffect(db,ctx.workspaceId,effect)).replayed,true);
 assert.equal((await f.run()).queued,0);assert.equal(f.books.posts.quickbooks,1);
 await assert.rejects(f.documents.approve(db,ctx,qb.id,'invoice',first.id,{confirmed:'yes',expectedFingerprint:page.fingerprint}),/no longer waiting/);
 // That confirmed example taught Pro invoices: the next one goes on its own.
 const second=await f.invoice('INV-A2','80.00');
 r=await f.run();assert.equal(r.queued,1,JSON.stringify(r));await f.deliver();
 saved=await f.row(qb,'invoice',second.id);assert.equal(saved.status,'SENT');assert.equal(saved.automatic,true);assert.equal(f.books.posts.quickbooks,2);
 assert.equal((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action='Invoice or bill sent to the books by StockChief'",[ctx.workspaceId])).rows[0].n,1);
 // Bills are taught separately: here by the saved rule.
 const freight=await f.bill('FRT-9',4000);
 await f.map(qb,'supplier','fixture-supplier','qb-vendor-1');await f.map(qb,'account',f.accounts.OPERATING_EXPENSE,'ext-expense');await f.map(qb,'tax_code','purchase_untaxed','NON');
 r=await f.run();assert.equal(r.drafted,1);assert.match((await f.row(qb,'bill',freight.billId)).reason,/not taught StockChief to send bills/);
 const before=await require('../../src/commercial/agent-rule-quota').count(db,f.owner.accountId);
 const settings=(await db.query('SELECT revision FROM stockchief_runtime.agent_accounting_document_settings WHERE connector_id=$1',[qb.id])).rows[0];
 await f.documents.saveSettings(db,ctx,{connectorId:qb.id,kinds:['invoice','bill'],startDate:f.today,sendAlone:'yes',revision:settings.revision});
 assert.equal(await require('../../src/commercial/agent-rule-quota').count(db,f.owner.accountId),before+1,'The saved rule counts against the plan’s rules.');
 r=await f.run();assert.equal(r.queued,1);await f.deliver();
 saved=await f.row(qb,'bill',freight.billId);assert.equal(saved.status,'SENT');
 const billDoc=f.books.docs.quickbooks.find(d=>d.Entity==='Bill');assert.equal(billDoc.VendorRef.value,'qb-vendor-1');assert.equal(billDoc.DocNumber,'FRT-9');
 assert.equal(billDoc.Line[0].AccountBasedExpenseLineDetail.AccountRef.value,'ext-expense');assert.equal(billDoc.TotalAmt,40);
 // An order's invoice goes once it shipped in full; its journal then carries only the cost of goods.
 const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:3,unitPriceMinor:1500}]});
 await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
 const shipped=await f.workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:order.lineIds[0],quantity:3,locationId:f.location.id}]});
 const shipment=(await db.query("SELECT id FROM accounting_journal_entries WHERE workspace_id=$1 AND source_type='sale_fulfillment' AND source_record_id=$2",[ctx.workspaceId,order.salesOrderId])).rows[0].id;
 await f.map(qb,'account',f.accounts.COST_OF_GOODS_SOLD,'ext-cogs');await f.map(qb,'account',f.accounts.INVENTORY_ASSET,'ext-stock');
 r=await f.run();assert.equal(r.queued,1,JSON.stringify(r));await f.deliver();
 saved=await f.row(qb,'invoice',shipped.invoiceId);assert.equal(saved.status,'SENT',saved.reason);assert.equal(f.books.docs.quickbooks.at(-1).TotalAmt,45);
 const rest=(await f.pending(qb)).find(e=>e.id===shipment);assert(rest,'The shipment’s journal still goes, for what the invoice does not carry.');
 assert.deepEqual(rest.lines.map(l=>l.external_account_id).sort(),['ext-cogs','ext-stock']);
 assert.equal(rest.lines.reduce((s,l)=>s+l.debit_minor-l.credit_minor,0),0);
});

test('Custom sends to Xero alone; pause, Watch, Ask me first and the first 14 days hold; duplicates, refusals and unclear sends are safe',{timeout:600000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx}=f,xero=await f.connect('xero','Xero books');
 await f.documents.saveSettings(db,ctx,{connectorId:xero.id,kinds:['invoice'],startDate:f.today});
 await f.map(xero,'customer','fixture-customer','xero-contact-1');await f.map(xero,'account',f.accounts.SALES_REVENUE,'ext-sales');
 await f.map(xero,'tax_code','sale_taxed','OUTPUT');await f.map(xero,'tax_code','sale_untaxed','NONE');
 // Custom sends on its own without teaching, with the tax it recorded.
 const taxed=await f.invoice('X-100','100.00','8.00');
 let r=await f.run();assert.equal(r.queued,1,JSON.stringify(r));await f.deliver();
 let saved=await f.row(xero,'invoice',taxed.id);assert.equal(saved.status,'SENT',saved.reason);assert.equal(saved.automatic,true);
 const sent=f.books.docs.xero[0];assert.equal(sent.Type,'ACCREC');assert.equal(sent.Total,108);assert.equal(sent.TotalTax,8);assert.equal(sent.LineItems[0].AccountCode,'4000');assert.equal(sent.LineItems[0].TaxType,'OUTPUT');assert.equal(sent.Reference,'StockChief invoice '+taxed.id);
 // Pause, Watch only, Ask me first and the first 14 days send nothing on their own.
 const held=await f.invoice('X-101','10.00');
 await f.autopilot.pause(db,ctx,{role:'owner'},'Books check');r=await f.run();assert.equal(r.watched,1);saved=await f.row(xero,'invoice',held.id);assert.equal(saved.status,'WATCHED');assert.match(saved.reason,/paused.*would have sent Invoice X-101 to Xero books/);
 await f.autopilot.resume(db,ctx,{role:'owner'});
 await f.modes.save(db,ctx,184,{mode:'watch',revision:0});await f.run();assert.match((await f.row(xero,'invoice',held.id)).reason,/Watch only/);
 await f.modes.save(db,ctx,184,{mode:'ask',revision:1});r=await f.run();assert.equal(r.drafted,1);assert.match((await f.row(xero,'invoice',held.id)).reason,/Ask me first/);
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);await f.run();assert.match((await f.row(xero,'invoice',held.id)).reason,/first 14 days/);
 const page=await f.documents.detail(db,ctx,xero.id,'invoice',held.id);
 await assert.rejects(f.documents.approve(db,ctx,xero.id,'invoice',held.id,{confirmed:'yes',expectedFingerprint:page.fingerprint}),/first 14 days/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 assert(!(await f.pending(xero)).some(e=>e.id===saved.journal_entry_id),'A waiting invoice holds its journal back.');
 await f.modes.save(db,ctx,184,{mode:'inherit',revision:2});r=await f.run();assert.equal(r.queued,1);await f.deliver();assert.equal((await f.row(xero,'invoice',held.id)).status,'SENT');
 let posts=f.books.posts.xero;assert.equal(posts,2);
 // A different document with the same number in the books: nothing is sent; a person checks.
 const clash=await f.invoice('X-102','30.00');
 f.books.add('xero',{Type:'ACCREC',InvoiceID:'typed-in-1',InvoiceNumber:'X-102',Contact:{ContactID:'xero-contact-1'},Status:'AUTHORISED',CurrencyCode:'USD',DateString:f.today+'T00:00:00',Total:99,TotalTax:0,LineItems:[{AccountCode:'4000',LineAmount:99}]});
 await f.run();let out=await f.deliver();assert.match(out[0].error,/already has Invoice X-102 and it is different/);
 saved=await f.row(xero,'invoice',clash.id);assert.equal(saved.status,'FAILED');assert.equal(f.books.posts.xero,posts);
 // The same document someone already typed in is linked, not sent again.
 const typed=await f.invoice('X-103','50.00');
 f.books.add('xero',{Type:'ACCREC',InvoiceID:'typed-in-2',InvoiceNumber:'X-103',Contact:{ContactID:'xero-contact-1'},Status:'AUTHORISED',CurrencyCode:'USD',DateString:f.today+'T00:00:00',Total:50,TotalTax:0,LineItems:[{AccountCode:'4000',LineAmount:50}]});
 await f.run();await f.deliver();saved=await f.row(xero,'invoice',typed.id);assert.equal(saved.status,'SENT');assert.equal(saved.external_id,'typed-in-2');assert.match(saved.reason,/linked it/);assert.equal(f.books.posts.xero,posts);
 // A refusal is definite: the owner sends it again after fixing it, once.
 const refused=await f.invoice('X-104','20.00');f.books.next='refuse';
 await f.run();out=await f.deliver();assert(out[0].error);saved=await f.row(xero,'invoice',refused.id);assert.equal(saved.status,'FAILED');assert.equal(f.books.posts.xero,posts);
 const retry=await f.documents.detail(db,ctx,xero.id,'invoice',refused.id);assert.equal(retry.canSend,true);
 await f.documents.approve(db,ctx,xero.id,'invoice',refused.id,{confirmed:'yes',expectedFingerprint:retry.fingerprint});await f.deliver();
 saved=await f.row(xero,'invoice',refused.id);assert.equal(saved.status,'SENT');assert.equal(saved.attempt,1);assert.equal(f.books.posts.xero,++posts);
 // An unclear send is never repeated: a person checks the books, which link it.
 const lost=await f.invoice('X-105','15.00');f.books.next='lost';
 await f.run();out=await f.deliver();f.books.next=null;assert.equal(out[0].code,'accounting_document_ambiguous',JSON.stringify(out));posts++;
 saved=await f.row(xero,'invoice',lost.id);assert.equal(saved.status,'UNCERTAIN');
 assert((await f.needs()).some(n=>n.sourceId==='accounting-document:'+xero.id+':invoice:'+lost.id&&/Check Invoice X-105/.test(n.title)));
 assert(!(await f.pending(xero)).some(e=>e.id===saved.journal_entry_id),'An unclear invoice holds its journal back.');
 assert.equal((await f.run()).queued,0,'It is not queued again.');
 assert.equal((await f.documents.check(db,ctx,xero.id,'invoice',lost.id)).found,true);
 saved=await f.row(xero,'invoice',lost.id);assert.equal(saved.status,'SENT');assert.equal(f.books.posts.xero,posts);
 // The books showing a different total after the post is unclear too.
 const changed=await f.invoice('X-106','12.00');f.books.tamper='xero-'+(f.books.docs.xero.length+1);
 await f.run();out=await f.deliver();assert.equal(out[0].code,'accounting_document_ambiguous');assert.equal((await f.row(xero,'invoice',changed.id)).status,'UNCERTAIN');
 // A downgrade sends nothing more, and releases waiting journals to go as journals.
 await f.modes.save(db,ctx,184,{mode:'ask',revision:3});const waiting=await f.invoice('X-107','9.00');await f.run();
 saved=await f.row(xero,'invoice',waiting.id);assert.equal(saved.status,'DRAFTED');assert(!(await f.pending(xero)).some(e=>e.id===saved.journal_entry_id));
 await f.subscribe('growth');assert.equal((await f.run()).skipped,true);
 await assert.rejects(f.documents.approve(db,ctx,xero.id,'invoice',waiting.id,{confirmed:'yes',expectedFingerprint:'x'}),/Pro plan/);
 assert((await f.pending(xero)).some(e=>e.id===saved.journal_entry_id),'Without the job, the journal goes as before.');
 // Every outcome is audited.
 assert((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action LIKE 'Invoice%'",[ctx.workspaceId])).rows[0].n>=8);
});

test('the review and document pages work at desktop and phone width, and older terms see the plan card',{timeout:600000},async t=>{
 const f=await fixture(t,'pro'),{db,ctx}=f,qb=await f.connect('quickbooks','Main books');
 await f.documents.saveSettings(db,ctx,{connectorId:qb.id,kinds:['invoice'],startDate:f.today});
 const first=await f.invoice('INV-P1','64.00');await f.run();
 const review=await f.browser.get('/autopilot/reviews/accounting-documents').expect(200);
 assert.match(review.text,/Books that get invoices and bills/);assert.match(review.text,/Links your books still need/);assert.match(review.text,/Stopped for you/);
 // The missing link is saved from the page.
 await f.browser.post('/autopilot/accounting-documents/mappings').type('form').send({_csrf:f.csrf(review.text),connectorId:qb.id,kind:'customer',localKey:'fixture-customer',externalId:'qb-cust-9'}).expect(303);
 assert.equal((await db.query("SELECT external_id FROM accounting_external_identities WHERE connector_id=$1 AND entity_type='customer'",[qb.id])).rows[0].external_id,'qb-cust-9');
 for(const [kind,key,value] of [['account',f.accounts.SALES_REVENUE,'ext-sales'],['sales_item',f.accounts.SALES_REVENUE,'qb-item'],['tax_code','sale_untaxed','NON']])await f.map(qb,kind,key,value);
 await f.run();assert.equal((await f.row(qb,'invoice',first.id)).status,'DRAFTED');
 const href='/autopilot/accounting-documents/'+qb.id+'/invoice/'+first.id;
 const detail=await f.browser.get(href).expect(200);assert.match(detail.text,/Send to QuickBooks/);assert.match(detail.text,/64\.00/);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
 try{
  const base='http://127.0.0.1:'+server.address().port;
  for(const [width,height,phone] of [[1600,1000,false],[390,844,true]]){
   const tab=await chrome.newPage({viewport:{width,height},isMobile:phone,hasTouch:phone});
   await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
   await tab.goto(base+'/autopilot/reviews/accounting-documents');assert(await tab.locator('[data-accounting-document-settings]').isVisible());
   assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scrolling at '+width);
   await tab.goto(base+href);assert(await tab.locator('[data-accounting-document]').isVisible());
   assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scrolling on the document at '+width);
   const path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});await tab.screenshot({path:path.join(folder,'accounting-document-'+width+'.png'),fullPage:true});
   if(phone){await tab.getByLabel('I checked these amounts and the books.').check();await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Send to QuickBooks'}).click()]);assert.match(await tab.locator('body').innerText(),/Queued/);}
   await tab.close();
  }
 }finally{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();}
 await f.deliver();assert.equal((await f.row(qb,'invoice',first.id)).status,'SENT');assert.equal(f.books.posts.quickbooks,1);
 // Agent terms below Pro keep the lock; older terms see the shared plan card.
 await f.subscribe('growth');await f.browser.get(href).expect(402);
 await db.query(`UPDATE account_subscriptions SET plan_version_id=(SELECT id FROM commercial_plan_versions WHERE plan_id='growth' AND (configuration->>'offerId') IS DISTINCT FROM 'agent-v3' ORDER BY version_number LIMIT 1) WHERE account_id=$1`,[f.owner.accountId]);
 assert.match((await f.browser.get(href).expect(200)).text,/data-agent-plan-locked/);
 await f.browser.get('/autopilot/reviews/accounting-documents').expect(200);
});
