'use strict';process.env.NODE_ENV='test';
// Job 96: ordinary supplier emails and attached files keep lead times, minimum
// orders, pack sizes and contacts current, per plan, with a person for anything
// unclear and always for a new order email address.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx}=f;await f.subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 await db.query("UPDATE suppliers SET email='supplier@example.test',contact_name='Original contact',phone='555-000-0000' WHERE id='fixture-supplier'");
 await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:f.item.skuIds[0],supplierSku:'VENDOR-1',purchaseUnit:'case',unitsPerPurchaseUnit:12,lastUnitCost:9.50,leadTimeDays:7,minimumOrderQuantity:2,orderMultiple:1,isPreferred:true,notes:'Keep these notes'});
 const connector=randomUUID();await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at) VALUES($1,$2,$1,'Supplier mailbox','gmail','[]','{}','connected','["MAIL_READ"]','CONNECTED',$3,'supplier-source-mailbox',now(),now())`,[connector,ctx.workspaceId,ctx.actorId]);
 const connection=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[connector])).rows[0],service=require('../../src/purchasing/agent-supplier-email-terms');
 const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
 const incoming=(body,{subject='Supplier news',sender='supplier@example.test',files=[]}={})=>require('../../src/connections/postgres-mail').capture(db,connection,{externalMessageId:randomUUID(),sender,subject,bodyText:body,
  attachments:files.map(([filename,text])=>({filename,mimeType:'text/csv',contentBase64:Buffer.from(text).toString('base64')}))});
 const run=async kind=>{const out=[];for(let i=0;i<10;i++){const r=await jobs.processOne(db,{[kind]:handlers[kind]},{owner:'supplier-detail-test',kinds:[kind]});if(!r)break;assert.equal(r.status,'COMPLETED',JSON.stringify(r.lastError));out.push(r.result);}return out;};
 const queued=async id=>(await db.query("SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2 AND payload->>'messageId'=$3",[ctx.workspaceId,service.jobKind,id])).rows[0].n;
 const approve=async(id,extra={})=>{const p=await service.preview(db,ctx,id);return service.apply(db,ctx,id,{confirmed:'yes',expectedFingerprint:p.facts.sourceFingerprint,...extra});};
 const caps={maximumLeadDays:30,maximumLeadChangeDays:10,maximumMoq:10,maximumMoqChange:3,maximumPackChange:2};
 const enable=(extra={})=>service.configure(db,ctx,'fixture-supplier',{connectorId:connector,allProducts:'yes',fields:['lead_time_days','minimum_order_quantity','units_per_purchase_unit'],...caps,confirmed:'yes',revision:0,...extra});
 const item=async()=>(await db.query("SELECT * FROM supplier_items WHERE workspace_id=$1 AND supplier_id='fixture-supplier'",[ctx.workspaceId])).rows[0];
 const supplier=async()=>(await db.query("SELECT * FROM suppliers WHERE id='fixture-supplier'")).rows[0];
 const audits=async action=>(await db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ctx.workspaceId,action])).rows[0].n;
 return {...f,connector,connection,service,jobs,handlers,incoming,run,queued,approve,caps,enable,item,supplier,audits};
}

test('Starter is locked, Growth asks until taught, and Pro and Custom apply plain emails within the owner’s limits with undo',{timeout:300000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f,before=await f.item(),stock=await f.balance();
 await f.subscribe('starter');const locked=await f.incoming('Hello,\nFrom now on the lead time for VENDOR-1 is 10 days and the minimum order is 3 cases.\nThanks');
 assert.equal(await f.queued(locked.messageId),0,'Starter does not queue supplier detail reading');await assert.rejects(service.preview(db,ctx,locked.messageId),e=>e.code==='entitlement_required');
 await f.subscribe('growth');const first=await f.incoming('Hello,\nFrom now on the lead time for VENDOR-1 is 10 days and the minimum order is 3 cases.\nThanks');
 assert.equal(await f.queued(first.messageId),1);const proposed=await f.run(f.service.jobKind);assert.equal(proposed[0].held,true,'Growth proposes the change until it is taught');
 assert.equal((await service.inbox(db,ctx.workspaceId,ctx.actorId)).filter(r=>r.href.includes(first.messageId)).length,1);
 const shown=(await service.preview(db,ctx,first.messageId)).facts;assert.deepEqual(shown.changes.map(c=>[c.field,c.before,c.value]),[['lead_time_days',7,10],['minimum_order_quantity',2,3]]);assert.equal(shown.freeForm,true);
 assert.equal((await f.approve(first.messageId)).changedCount,2);await service.teach(db,ctx,first.messageId,{...f.caps,confirmed:'yes',revision:0});
 assert.equal((await service.inbox(db,ctx.workspaceId,ctx.actorId)).filter(r=>r.href.includes(first.messageId)).length,0);
 const taught=await f.incoming('Please note the lead time for VENDOR-1 is now 11 days, and the minimum order quantity is now 4 cases.');assert.equal((await f.run(service.jobKind))[0].automatic,true,'A taught example lets Growth apply matching changes alone');
 assert.equal(Number((await f.item()).lead_time_days),11);assert.equal(Number((await f.item()).minimum_order_quantity),4);
 const ruleRevision=(await db.query('SELECT revision FROM stockchief_runtime.agent_supplier_term_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].revision;
 await service.teach(db,ctx,first.messageId,{remove:'yes',confirmed:'yes',revision:ruleRevision});
 await f.subscribe('pro');await f.enable();
 const pro=await f.incoming('Hi team,\nVENDOR-1:\n- lead time is now 12 days\n- now packed 10 per case\nRegards,\nSam\nPhone: 555-999-0000');
 const proResult=(await f.run(service.jobKind))[0];assert.equal(proResult.automatic,true,JSON.stringify(proResult));
 let now=await f.item();assert.equal(Number(now.lead_time_days),12);assert.equal(Number(now.units_per_purchase_unit),10);assert.equal(now.last_unit_cost,before.last_unit_cost,'Unit cost is not changed by a pack size');assert.equal(now.notes,before.notes);
 assert.equal((await f.supplier()).phone,'555-000-0000','A signature phone is not read as a change');
 await f.subscribe('enterprise');const custom=await f.incoming('The minimum order for VENDOR-1 is changing to 5 cases.');assert.equal((await f.run(service.jobKind))[0].automatic,true);assert.equal(Number((await f.item()).minimum_order_quantity),5);
 assert.equal((await service.onArrival(db,ctx.workspaceId,custom.messageId)).replayed,true,'Replaying the same email changes nothing again');
 const big=await f.incoming('The lead time for VENDOR-1 is now 40 days.');const held=(await f.run(service.jobKind))[0];assert.equal(held.held,true);assert.match(held.reason,/maximum/);assert.equal(Number((await f.item()).lead_time_days),12);
 const pack=await f.incoming('VENDOR-1 now comes in cases of 6.');assert.equal((await f.run(service.jobKind))[0].held,true,'A pack-size jump over the owner limit waits');assert.equal(Number((await f.item()).units_per_purchase_unit),10);
 assert.equal(await f.audits('Supplier details updated from original email'),4);
 await service.undo(db,ctx,custom.messageId,{confirmed:'yes'});assert.equal(Number((await f.item()).minimum_order_quantity),4);assert.equal((await service.undo(db,ctx,custom.messageId,{confirmed:'yes'})).replayed,true);
 await db.query("UPDATE supplier_items SET units_per_purchase_unit=11,updated_at=clock_timestamp()::text WHERE workspace_id=$1 AND supplier_id='fixture-supplier'",[ctx.workspaceId]);
 await assert.rejects(service.undo(db,ctx,pro.messageId,{confirmed:'yes'}),/changed again/,'An owner edit after the email blocks undo');
 assert.equal(await f.audits('Supplier details update undone'),1);assert.equal(await f.balance(),stock,'No stock moves');
 const history=await require('../../src/autopilot/agent-work-digest').report(db,ctx);assert(history.rows.some(r=>r.Status==='Undone'));
 void taught;void big;void pack;
});

test('attached files are read; conflicts, ranges, wrong units, prices and unreadable files wait for a person',{timeout:300000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f;await f.enable();
 const csv='Supplier SKU,Purchase unit,Lead time (days),MOQ,Case pack,Price\nVENDOR-1,case,9,3,12,9.99\nNOT-OURS,case,1,1,1,1\n';
 const filed=await f.incoming('Please see the attached updated lead times.',{subject:'Updated item terms',files:[['lead-times.csv',csv]]});
 assert.equal(await f.queued(filed.messageId),0,'Waits for the attachment to be read');const read=await f.run('mail.attachment-extract');assert.equal(read[0].attachments[0].status,'READABLE',JSON.stringify(read));
 const applied=(await f.run(service.jobKind))[0];assert.equal(applied.automatic,true,JSON.stringify(applied));
 assert.equal(Number((await f.item()).lead_time_days),9);assert.equal(Number((await f.item()).minimum_order_quantity),3);assert.equal(Number((await f.item()).last_unit_cost),9.5,'Prices in the file are left to the price-list job');
 const conflict=await f.incoming('The lead time for VENDOR-1 is now 15 days.',{files:[['terms.csv','Supplier SKU,Lead time (days)\nVENDOR-1,16\n']]});await f.run('mail.attachment-extract');
 const c=(await f.run(service.jobKind))[0];assert.equal(c.held,true);assert.match(c.reason,/different values/);
 for(const [body,pattern]of [['The lead time for VENDOR-1 is now 3-4 weeks.',/range|working days/],['The minimum order for VENDOR-1 is now 24 units.',/purchase unit/],['Our prices increase 4% from next month. The lead time for VENDOR-1 is now 10 days.',/prices, payment/],['The lead time for VENDOR-1 has changed from 5 days to 10 days.',/old lead time/]]){
  const mail=await f.incoming(body);const r=(await f.run(service.jobKind))[0];assert.equal(r.held,true,body);assert.match(r.reason,pattern,body);
 }
 const chatter=await f.incoming('Sorry about the lead time on your last order. Thanks for your patience.');assert.equal(await f.queued(chatter.messageId),0,'Chatter without a stated change is not queued');
 const scan=await f.incoming('New lead times attached.',{files:[['scan.bin','not a document']]});await f.run('mail.attachment-extract');
 const r=await service.onArrival(db,ctx.workspaceId,scan.messageId);assert.equal(r.held,true);assert.match(r.reason,/could not be read/);
 assert.equal(Number((await f.item()).lead_time_days),9,'Nothing unclear changed the record');
 const page=await f.browser.get('/mail/'+conflict.messageId+'/supplier-details');assert.equal(page.status,200);assert.match(page.text,/different values/);
 const listing=await f.browser.get('/autopilot/reviews/supplier-email-details');assert.equal(listing.status,200);assert.match(listing.text,/Needs review/);
});

test('a new order email address always waits for a person, even on Custom, and supplier-wide lead times respect product lead times',{timeout:300000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f;await f.subscribe('enterprise');
 await assert.rejects(f.enable({fields:['lead_time_days','email']}),/order email address always needs a person/);
 await f.enable({fields:['lead_time_days','minimum_order_quantity','units_per_purchase_unit','default_lead_time_days','contact_name','phone'],allowUnset:'yes'});
 const redirect=await f.incoming('Hello,\nPlease send all purchase orders to orders@new-supplier.test from now on. Our new phone number is +1 555 222 3344.\nThanks');
 const held=(await f.run(service.jobKind))[0];assert.equal(held.held,true);assert.match(held.reason,/order email address always needs you/);assert.equal((await f.supplier()).email,'supplier@example.test');
 const need=(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).filter(r=>r.href.includes(redirect.messageId));assert.equal(need.length,1);assert.equal(need[0].priority,88);
 await assert.rejects(f.approve(redirect.messageId),/checked the new order email address/);
 await assert.rejects(service.teach(db,ctx,redirect.messageId,{...f.caps,confirmed:'yes',revision:0}),/Approve an original/);
 assert.equal((await f.approve(redirect.messageId,{confirmAddress:'yes'})).changedCount,2);const s=await f.supplier();assert.equal(s.email,'orders@new-supplier.test');assert.equal(s.phone,'+1 555 222 3344');
 const fromOld=await f.incoming('The lead time for VENDOR-1 is now 9 days.',{sender:'supplier@example.test'});assert.equal(fromOld.accepted,false,'The old address is no longer this supplier');
 const wide=await f.incoming('Our standard lead time is now 21 days.',{sender:'orders@new-supplier.test'});const r=(await f.run(service.jobKind))[0];assert.equal(r.held,true);assert.match(r.reason,/their own lead time/);
 await db.query("UPDATE supplier_items SET lead_time_days=NULL,updated_at=(now()-interval '1 day')::text WHERE workspace_id=$1 AND supplier_id='fixture-supplier'",[ctx.workspaceId]);
 await db.query("UPDATE suppliers SET updated_at=(now()-interval '1 day')::text WHERE id='fixture-supplier'");
 await service.configure(db,ctx,'fixture-supplier',{connectorId:f.connector,allProducts:'yes',fields:['lead_time_days','minimum_order_quantity','units_per_purchase_unit','default_lead_time_days','contact_name','phone'],...f.caps,maximumLeadChangeDays:30,allowUnset:'yes',confirmed:'yes',revision:1});
 const supplierWide=await f.incoming('Our standard lead time is now 21 days.',{sender:'orders@new-supplier.test'});const done=(await f.run(service.jobKind))[0];assert.equal(done.automatic,true,JSON.stringify(done));
 assert.equal(Number((await f.supplier()).default_lead_time_days),21);
 const sign=await f.incoming('Thanks for the order.\n\nBest regards,\nAnn\nPhone: 555-111-2222\nEmail: ann@new-supplier.test',{sender:'orders@new-supplier.test'});assert.equal((await service.onArrival(db,ctx.workspaceId,sign.messageId)).skipped,'not_relevant','Signature details are not read as changes');assert.equal(await service.saved(db,ctx.workspaceId,sign.messageId),null);
 void wide;void supplierWide;
});

test('Ask me first, Watch only, pause and the first 14 days hold changes; keeping current values clears Needs you; retries apply once',{timeout:300000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f;await f.enable();const modes=require('../../src/autopilot/job-modes');
 const mail=await f.incoming('The lead time for VENDOR-1 is now 10 days.');
 await modes.save(db,ctx,96,{mode:'ask',revision:0});let r=await service.onArrival(db,ctx.workspaceId,mail.messageId);assert.equal(r.held,true);assert.match(r.reason,/Ask me first/);
 await modes.save(db,ctx,96,{mode:'watch',revision:1});assert.equal((await service.onArrival(db,ctx.workspaceId,mail.messageId)).held,true);await modes.save(db,ctx,96,{mode:'routine',revision:2});
 await db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1',[ctx.workspaceId]);assert.equal((await service.onArrival(db,ctx.workspaceId,mail.messageId)).held,true);await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1',[ctx.workspaceId]);
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);assert.equal((await service.onArrival(db,ctx.workspaceId,mail.messageId)).held,true);await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 assert.equal(Number((await f.item()).lead_time_days),7);
 const results=await Promise.all([service.onArrival(db,ctx.workspaceId,mail.messageId),service.onArrival(db,ctx.workspaceId,mail.messageId)]);assert.equal(results.filter(x=>x.automatic&&!x.replayed).length,1);assert.equal(Number((await f.item()).lead_time_days),10);
 const ignored=await f.incoming('Please note our lead time for VENDOR-1 is now 3-4 weeks.');await service.onArrival(db,ctx.workspaceId,ignored.messageId);
 assert.equal((await service.inbox(db,ctx.workspaceId,ctx.actorId)).filter(x=>x.href.includes(ignored.messageId)).length,1);
 await assert.rejects(service.dismiss(db,ctx,ignored.messageId,{}),/Confirm/);await service.dismiss(db,ctx,ignored.messageId,{confirmed:'yes'});
 assert.equal((await service.inbox(db,ctx.workspaceId,ctx.actorId)).filter(x=>x.href.includes(ignored.messageId)).length,0);assert.equal((await service.onArrival(db,ctx.workspaceId,ignored.messageId)).skipped,'kept_current_values');
 await assert.rejects(service.dismiss(db,ctx,mail.messageId,{confirmed:'yes'}),/already applied/);
 await f.subscribe('starter');assert.deepEqual(await service.inbox(db,ctx.workspaceId,ctx.actorId),[]);
});

test('the review page shows the change, the address warning, approval and undo at desktop and phone widths',{timeout:300000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f;await f.subscribe('enterprise');
 const mail=await f.incoming('Hi,\nPlease send all purchase orders to po@new-supplier.test from now on.\nThe lead time for VENDOR-1 is now 9 days.');await service.onArrival(db,ctx.workspaceId,mail.messageId);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 for(const [width,height,mobile]of [[1440,900,false],[390,844,true]]){
  const page=await browser.newPage({viewport:{width,height},isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(12000);
  await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(origin+'/mail/'+mail.messageId);await Promise.all([page.waitForNavigation(),page.getByRole('link',{name:'Review supplier detail updates',exact:true}).click()]);
  const text=await page.locator('main').innerText();assert.match(text,/po@new-supplier\.test/);assert.match(text,/payment scam/);assert.match(text,/Order email address/);assert.match(text,/Keep current values/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scrolling at '+width+'px');
  if(mobile){
   await page.getByLabel('I checked the new order email address with the supplier by phone or another contact I already know.').check();await page.getByLabel('I approve these exact supplier values and purchase units.').check();
   await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Apply reviewed supplier updates',exact:true}).click()]);assert.match(await page.locator('main').innerText(),/Processed once · 2 fields changed/);
   await page.getByLabel('Put back the values from before this email.').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Undo supplier updates',exact:true}).click()]);
   assert.match(await page.locator('main').innerText(),/Undone/);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }
  await page.close();
 }
 const s=(await db.query("SELECT email FROM suppliers WHERE id='fixture-supplier'")).rows[0];assert.equal(s.email,'supplier@example.test','Undo put the order address back');assert.equal(Number((await f.item()).lead_time_days),7);
});
