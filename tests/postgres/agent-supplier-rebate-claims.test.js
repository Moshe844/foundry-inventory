'use strict';process.env.NODE_ENV='test';
// Job 97: rebate tracking per plan, tier alerts, the rebate earned at period end,
// claims sent through the outbox within the owner's limit, credit-note tracking,
// and rebate terms read from email that a person must accept.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:120}),{db,ctx}=f;await f.subscribe('pro');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const days=require('../../src/accounting/customer-money'),today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),yesterday=days.addDays(today,-1),until=days.addDays(today,30);
 await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1 AND accounting_start_date>$2',[ctx.workspaceId,days.addDays(today,-60)]);
 await db.query("UPDATE suppliers SET email='rebates@supplier.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
 await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:f.item.skuIds[0],purchaseUnit:'case',unitsPerPurchaseUnit:12,lastUnitCost:1});
 const po=(await db.query('SELECT * FROM purchase_orders WHERE workspace_id=$1 LIMIT 1',[ctx.workspaceId])).rows[0],line=(await db.query('SELECT * FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2',[ctx.workspaceId,po.id])).rows[0];
 const bill=await f.workflows.recordSupplierInvoice(db,ctx,{supplierId:'fixture-supplier',purchaseOrderId:po.id,supplierInvoiceNumber:'REBATE-'+randomUUID().slice(0,8),issueDate:yesterday,dueDate:until,currency:'USD',lines:[{purchaseOrderLineId:line.id,quantity:120,unitCostMinor:100}],documentTotalMinor:12000,idempotencyKey:randomUUID()});assert.equal(bill.status,'OPEN',JSON.stringify(bill));
 const connector=randomUUID();await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
  VALUES($1,$2,$1,'Buying mailbox','gmail','[]','{}','connected','["MAIL_SEND","MAIL_READ"]',$3,'CONNECTED',$4,'buying@example.test',now(),now())`,[connector,ctx.workspaceId,'connection_credentials:'+connector,ctx.actorId]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',{accessToken:'synthetic-rebate-token'}));
 const service=require('../../src/purchasing/agent-supplier-benefits'),claims=require('../../src/purchasing/agent-supplier-benefit-claims'),sent=[];
 const provider={send:async({message})=>{sent.push(message);return {externalMessageId:'rebate-accepted-'+message.id};}};
 const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create({get:()=>provider});
 async function deliver(){const kind='agent.mail.supplier_benefit_claim.v1',out=[];for(let i=0;i<10;i++){const r=await jobs.processOne(db,{[kind]:handlers[kind]},{owner:'rebate-claim-worker',kinds:[kind]});if(!r)break;out.push(r);}return out;}
 const terms={basis:'net_spend',benefit:'percentage',method:'retroactive',rounding:'half_up',tiers:[{threshold:'0',rateBasisPoints:1000}]};
 const create=(extra={})=>service.configure(db,ctx,{title:'Annual rebate',sourceReference:'Signed rebate letter '+randomUUID(),currency:'USD',startsOn:yesterday,endsOn:yesterday,claimOn:today,claimBy:until,supplierId:'fixture-supplier',allProducts:'yes',skuIds:[],terms,confirmed:'yes',revision:0,...extra});
 const settings=(id,extra={})=>service.get(db,ctx.workspaceId,id).then(p=>claims.configure(db,ctx,id,{connectorId:connector,claimLimit:'20.00',alertPercent:10,confirmed:'yes',revision:p.revision,...extra}));
 const rows=async id=>(await db.query('SELECT *,submitted_on::text FROM stockchief_runtime.agent_supplier_benefit_claims WHERE workspace_id=$1 AND program_id=$2 ORDER BY created_at,id',[ctx.workspaceId,id])).rows;
 const audits=async action=>(await db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ctx.workspaceId,action])).rows[0].n;
 const expire=()=>db.query("UPDATE stockchief_runtime.agent_supplier_benefit_observations SET observed_at='epoch' WHERE workspace_id=$1",[ctx.workspaceId]);
 return {...f,today,yesterday,until,po,line,bill,connector,service,claims,sent,provider,deliver,terms,create,settings,rows,audits,expire};
}
async function postCredit(f,{amountMinor,number,reason}){
 const {db,ctx}=f;return db.transaction(async c=>{const bill=(await c.query('SELECT * FROM accounting_supplier_bills WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,f.bill.billId])).rows[0];
  return require('../../src/accounting/postgres-supplier-credits').applySourceCredit(c,ctx,bill,{amountMinor,taxMinor:0,creditNumber:number,creditDate:f.today,postingDate:f.today,originalBillId:bill.id,sourceHash:randomUUID(),sourceKey:'test-rebate-credit:'+randomUUID(),reason});});
}

test('Starter is locked, Growth gives a one-time estimate, and Pro and Custom track, alert, claim within the limit and follow the credit note',{timeout:300000},async t=>{
 const f=await fixture(t),{db,ctx,service,claims}=f,input={title:'Annual rebate',sourceReference:'Letter',currency:'USD',startsOn:f.yesterday,endsOn:f.yesterday,claimOn:f.today,claimBy:f.until,supplierId:'fixture-supplier',allProducts:'yes',terms:f.terms,confirmed:'yes'};
 await f.subscribe('starter');await assert.rejects(service.estimate(db,ctx,input),e=>e.code==='entitlement_required');
 await f.subscribe('growth');const estimate=await service.estimate(db,ctx,input);assert.equal(estimate.estimateOnly,true);assert.equal(estimate.result.potentialBenefitMinor,'1200');
 await assert.rejects(f.create(),e=>e.code==='entitlement_required');assert.equal((await service.run(db,ctx.workspaceId)).skipped,'plan_or_watch_period');
 await f.subscribe('pro');const made=await f.create();await f.settings(made.id);
 const before=Number((await db.query('SELECT count(*) n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
 const first=await service.run(db,ctx.workspaceId);assert.equal(first.claimed,1,JSON.stringify(first));
 let [claim]=await f.rows(made.id);assert.equal(claim.status,'SENDING');assert.equal(claim.automatic,true);assert.equal(claim.amount_minor,'1200');assert.match(claim.external_reference,/^REB-/);
 const delivered=await f.deliver();assert.equal(delivered.length,1);assert.equal(delivered[0].status,'COMPLETED',JSON.stringify(delivered[0].lastError));assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].recipient,'rebates@supplier.test');assert.match(f.sent[0].body,new RegExp(claim.external_reference));assert.match(f.sent[0].body,/Rebate earned: \$12\.00/);assert.match(f.sent[0].subject,/Rebate claim REB-/);
 await f.expire();await service.run(db,ctx.workspaceId);[claim]=await f.rows(made.id);assert.equal(claim.status,'SUBMITTED');assert.equal(claim.submitted_on,f.today);
 await f.expire();await service.run(db,ctx.workspaceId);assert.equal((await f.rows(made.id)).length,1,'Replays never claim twice');assert.equal(f.sent.length,1);
 assert.equal(Number((await db.query('SELECT count(*) n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),before,'Claiming posts no money');
 await f.subscribe('enterprise');const open=await f.create({title:'Growing rebate',endsOn:f.until,claimBy:require('../../src/accounting/customer-money').addDays(f.until,30),claimOn:require('../../src/accounting/customer-money').addDays(f.until,1),terms:{...f.terms,tiers:[{threshold:'0',rateBasisPoints:500},{threshold:'13000',rateBasisPoints:1000}]}});
 await service.run(db,ctx.workspaceId);const alert=(await service.inbox(db,ctx.workspaceId,ctx.actorId)).find(r=>r.sourceId==='supplier-benefit:'+open.id);assert(alert,'Near-tier alert reaches Needs you');assert.match(alert.title,/Close to the next rebate tier/);assert.match(alert.why,/\$10\.00 of purchases/);
 assert.equal((await f.rows(open.id)).length,0,'Nothing is claimed while the period is open');
 const earned=await f.browser.get('/autopilot/supplier-benefits/'+made.id);assert.match(earned.text,/Rebate earned for the period: \$12\.00/);assert.match(earned.text,/Sent to supplier/);
 const other=await postCredit(f,{amountMinor:300,number:'CN-UNRELATED',reason:'Damaged goods allowance'});void other;
 await postCredit(f,{amountMinor:1200,number:'CN-'+claim.external_reference,reason:'Credit for your rebate claim'});
 await f.expire();await service.run(db,ctx.workspaceId);[claim]=await f.rows(made.id);assert.equal(claim.status,'CREDITED');assert.equal(claim.credited_minor,'1200');
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_supplier_benefit_claim_credits WHERE claim_id=$1',[claim.id])).rows[0].n,1,'Only the credit quoting the claim is matched');
 for(const action of ['Supplier rebate claim prepared','Supplier rebate claim queued to send','Supplier rebate claim sent','Supplier credit note matched to rebate claim'])assert.equal(await f.audits(action),1,action);
 const html=await f.browser.get('/autopilot/supplier-benefits/'+made.id);assert.equal(html.status,200);assert.match(html.text,/Credited by supplier/);
});

test('over the limit, no limit and Ask me first wait for a person; approval sends once; changed purchases and discards stop a claim',{timeout:300000},async t=>{
 const f=await fixture(t),{db,ctx,service,claims}=f,made=await f.create();await f.settings(made.id,{claimLimit:'5.00'});
 await service.run(db,ctx.workspaceId);let [claim]=await f.rows(made.id);assert.equal(claim.status,'PREPARED');assert.match(claim.problem,/over your automatic claim limit/);
 assert.equal((await f.deliver()).length,0);const need=(await service.inbox(db,ctx.workspaceId,ctx.actorId)).find(r=>r.sourceId==='supplier-benefit-claim:'+claim.id);assert.match(need.title,/Approve rebate claim/);
 await assert.rejects(claims.send(db,ctx,made.id,claim.id,{confirmed:'yes',expectedEvidence:'stale'}),/Review this exact claim/);
 await claims.send(db,ctx,made.id,claim.id,{confirmed:'yes',expectedEvidence:claim.source_fingerprint});assert.equal((await claims.send(db,ctx,made.id,claim.id,{confirmed:'yes',expectedEvidence:claim.source_fingerprint})).replayed,true);
 await f.deliver();assert.equal(f.sent.length,1);
 const modes=require('../../src/autopilot/job-modes');await modes.save(db,ctx,97,{mode:'ask',revision:0});
 const asked=await f.create({sourceReference:'Second letter '+randomUUID()});await f.settings(asked.id);await service.run(db,ctx.workspaceId);
 [claim]=await f.rows(asked.id);assert.equal(claim.status,'PREPARED','Ask me first prepares the claim but does not send it');assert.equal((await f.deliver()).length,0);
 await assert.rejects(claims.discard(db,ctx,asked.id,claim.id,{}),/Confirm/);await claims.discard(db,ctx,asked.id,claim.id,{confirmed:'yes'});assert.equal((await f.rows(asked.id)).length,0);
 await modes.save(db,ctx,97,{mode:'routine',revision:1});
 const none=await f.create({sourceReference:'Third letter '+randomUUID()});await f.settings(none.id,{claimLimit:''});await f.expire();await service.run(db,ctx.workspaceId);
 [claim]=await f.rows(none.id);assert.equal(claim.status,'PREPARED');assert.match(claim.problem,/No automatic claim limit/);
 await db.query(`UPDATE accounting_supplier_bills SET charges='[{"kind":"discount","amountMinor":-100}]'::jsonb WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,f.bill.billId]);
 await assert.rejects(claims.send(db,ctx,none.id,claim.id,{confirmed:'yes',expectedEvidence:claim.source_fingerprint}),/purchases behind this claim changed/);assert.equal(f.sent.length,1);
});

test('Watch only, pause and the first 14 days stop background claims; a downgrade before delivery stops the send; races claim once',{timeout:300000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f,made=await f.create();await f.settings(made.id);const modes=require('../../src/autopilot/job-modes');
 await modes.save(db,ctx,97,{mode:'watch',revision:0});assert.equal((await service.run(db,ctx.workspaceId)).skipped,'owner_authority');await modes.save(db,ctx,97,{mode:'routine',revision:1});
 await db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1',[ctx.workspaceId]);assert.equal((await service.run(db,ctx.workspaceId)).skipped,'owner_authority');await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1',[ctx.workspaceId]);
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);assert.equal((await service.run(db,ctx.workspaceId)).skipped,'plan_or_watch_period');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 assert.equal((await f.rows(made.id)).length,0);
 await Promise.all([service.run(db,ctx.workspaceId),service.run(db,ctx.workspaceId)]);assert.equal((await f.rows(made.id)).length,1,'Competing cycles prepare one claim');
 await db.query("UPDATE suppliers SET email='someone-else@supplier.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
 const out=await f.deliver();assert.equal(out.length,1);assert.notEqual(out[0].status,'COMPLETED');assert.equal(f.sent.length,0,'A changed supplier address stops the queued claim at delivery');
 await f.expire();await service.run(db,ctx.workspaceId);let [claim]=await f.rows(made.id);assert.equal(claim.status,'PREPARED');assert.match(claim.problem,/not sent/);
 await db.query("UPDATE suppliers SET email='rebates@supplier.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
 await f.subscribe('growth');await assert.rejects(f.claims.send(db,ctx,made.id,claim.id,{confirmed:'yes',expectedEvidence:claim.source_fingerprint}),e=>e.code==='entitlement_required');
 await f.subscribe('pro');await f.claims.send(db,ctx,made.id,claim.id,{confirmed:'yes',expectedEvidence:claim.source_fingerprint});await f.subscribe('growth');
 await f.deliver();assert.equal(f.sent.length,0,'A downgrade after approval stops delivery');[claim]=await f.rows(made.id);assert.notEqual(claim.status,'SUBMITTED');
});

test('rebate terms in a supplier email wait for a person to accept them, on every plan that has the job',{timeout:300000},async t=>{
 const f=await fixture(t),{db,ctx,service,claims}=f,connection=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[f.connector])).rows[0];
 const body='Hello,\nWe are pleased to offer a volume rebate on purchases from '+f.yesterday+' to '+f.yesterday+'.\n2% rebate on purchases over $50.00\n5% rebate on purchases over $100.00\nThe rebate applies to all purchases once a tier is reached.\nClaims can be made from '+f.today+' and must be submitted by '+f.until+'.\nThanks';
 await f.subscribe('starter');const locked=await require('../../src/connections/postgres-mail').capture(db,connection,{externalMessageId:randomUUID(),sender:'rebates@supplier.test',subject:'Rebate offer',bodyText:body});
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_supplier_benefit_offers WHERE message_id=$1',[locked.messageId])).rows[0].n,0);
 await f.subscribe('growth');const mail=await require('../../src/connections/postgres-mail').capture(db,connection,{externalMessageId:randomUUID(),sender:'rebates@supplier.test',subject:'Rebate offer',bodyText:body});
 const offer=(await db.query('SELECT * FROM stockchief_runtime.agent_supplier_benefit_offers WHERE message_id=$1',[mail.messageId])).rows[0];assert(offer);assert.deepEqual(offer.reading.tiers,[{threshold:'50.00',rate:'2'},{threshold:'100.00',rate:'5'}]);assert.equal(offer.reading.method,'retroactive');
 const need=(await service.inbox(db,ctx.workspaceId,ctx.actorId)).find(r=>r.sourceId==='supplier-benefit-offer:'+offer.id);assert.match(need.title,/Check rebate terms/);
 const growthPage=await f.browser.get('/autopilot/supplier-benefits?offer='+offer.id);assert.equal(growthPage.status,200);assert.match(growthPage.text,/Saving accepts these terms/);assert.match(growthPage.text,/50\.00 \| 2/);
 const filled=claims.offerInput(await claims.offer(db,ctx,offer.id)),estimate=await service.estimate(db,ctx,{...filled,rounding:'half_up',confirmed:'yes'});assert.equal(estimate.result.potentialBenefitMinor,'600','Growth estimates once from the emailed terms');
 assert.equal((await db.query("SELECT status FROM stockchief_runtime.agent_supplier_benefit_offers WHERE id=$1",[offer.id])).rows[0].status,'OPEN','An estimate accepts nothing');
 await f.subscribe('pro');const saved=await service.configure(db,ctx,{...filled,rounding:'half_up',confirmed:'yes',revision:0});
 const after=(await db.query('SELECT status,program_id FROM stockchief_runtime.agent_supplier_benefit_offers WHERE id=$1',[offer.id])).rows[0];assert.equal(after.status,'SAVED');assert.equal(after.program_id,saved.id);
 assert.equal((await service.get(db,ctx.workspaceId,saved.id)).source_message_id,mail.messageId);await assert.rejects(service.configure(db,ctx,{...filled,sourceReference:'Again',rounding:'half_up',confirmed:'yes',revision:0}),/already handled/);
 const second=await require('../../src/connections/postgres-mail').capture(db,connection,{externalMessageId:randomUUID(),sender:'rebates@supplier.test',subject:'Revised rebate',bodyText:'Updated volume rebate for 2031: 3% on purchases over $1,000.00.',attachments:[]});
 const secondOffer=(await db.query('SELECT id FROM stockchief_runtime.agent_supplier_benefit_offers WHERE message_id=$1',[second.messageId])).rows[0];await claims.dismissOffer(db,ctx,secondOffer.id,{confirmed:'yes'});
 assert.equal((await service.inbox(db,ctx.workspaceId,ctx.actorId)).filter(r=>String(r.sourceId).startsWith('supplier-benefit-offer:')).length,0);
 const attached=await require('../../src/connections/postgres-mail').capture(db,connection,{externalMessageId:randomUUID(),sender:'rebates@supplier.test',subject:'Agreement attached',bodyText:'Please see the attached agreement.',attachments:[{filename:'rebate.txt',mimeType:'text/plain',contentBase64:Buffer.from('Volume rebate for the year 2030\n1% rebate on purchases over $500.00').toString('base64')}]});
 const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();const read=await jobs.processOne(db,{'mail.attachment-extract':handlers['mail.attachment-extract']},{owner:'rebate-reader',kinds:['mail.attachment-extract']});assert.equal(read.status,'COMPLETED',JSON.stringify(read.lastError));
 const fromFile=(await db.query('SELECT reading FROM stockchief_runtime.agent_supplier_benefit_offers WHERE message_id=$1',[attached.messageId])).rows[0];assert.equal(fromFile.reading.startsOn,'2030-01-01');assert.deepEqual(fromFile.reading.tiers,[{threshold:'500.00',rate:'1'}]);
});

test('the agreement page shows the claim, the email and the settings at desktop and phone widths, and sends on approval',{timeout:300000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f,made=await f.create();await f.settings(made.id,{claimLimit:''});await service.run(db,ctx.workspaceId);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});const origin='http://127.0.0.1:'+server.address().port;
 for(const [width,height,mobile]of [[1440,900,false],[390,844,true]]){
  const page=await browser.newPage({viewport:{width,height},isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(12000);
  await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(origin+'/autopilot/supplier-benefits/'+made.id);const text=await page.locator('main').innerText();
  assert.match(text,/Rebate earned for the period: \$12\.00/);assert.match(text,/Waiting for your approval/);assert.match(text,/Please send a credit note for \$12\.00/);assert.match(text,/Send claims on their own up to/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scrolling at '+width+'px');
  if(mobile){await page.getByLabel(/Send this exact claim to rebates@supplier\.test/).check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Send claim to supplier',exact:true}).click()]);
   assert.match(await page.locator('main').innerText(),/Sending from your mailbox/);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  await page.close();
 }
 await f.deliver();assert.equal(f.sent.length,1);
});
