'use strict';process.env.NODE_ENV='test';
// Job 45: staff damage reports, the remedy asked for, plan modes, and the
// follow-through of sent claims to a reply, a credit note, replacement goods,
// reminders and a recorded close.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/agent-claim-fixture'),{hash}=require('../../src/pricing/postgres-promotions');
const follow=require('../../src/purchasing/supplier-claim-follow-through');
const DAY=86400000,ago=days=>new Date(Date.now()-days*DAY).toISOString();

async function setup(t,plan){
 const f=await fixture(t,plan,{qc:false}),{db,ctx}=f;
 async function receiveDamaged(po,quantity,note='Two cartons crushed on the pallet; contents broken.'){
  const form=await f.browser.get('/purchasing/orders/'+po.purchaseOrderId+'/receive').expect(200),line=po.lineIds[0];
  await f.browser.post('/purchasing/orders/'+po.purchaseOrderId+'/receive').type('form').send({_csrf:f.csrf(form.text),idempotencyKey:randomUUID(),
   ['qty_'+line]:String(quantity),['location_'+line]:f.location.id,['condition_'+line]:'damaged',note}).expect(303);
  return (await db.query(`SELECT d.*,rl.receipt_id FROM stockchief_runtime.agent_receipt_damage_reports d JOIN purchase_order_receipt_lines rl ON rl.id=d.receipt_line_id
   JOIN purchase_order_receipts r ON r.id=rl.receipt_id WHERE d.workspace_id=$1 AND r.purchase_order_id=$2 ORDER BY d.created_at DESC LIMIT 1`,[ctx.workspaceId,po.purchaseOrderId])).rows[0];
 }
 const claimOf=async reportId=>(await db.query('SELECT * FROM stockchief_runtime.agent_supplier_claims WHERE workspace_id=$1 AND damage_report_id=$2',[ctx.workspaceId,reportId])).rows[0];
 const comm=async id=>(await db.query('SELECT * FROM supplier_communications WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
 const age=async(communicationId,days)=>db.query('UPDATE supplier_communications SET sent_at=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,communicationId,ago(days)]);
 const position=async id=>follow.position(db,ctx,await f.service.claim(db,ctx,id));
 const reply=async(claimId,subject='Re: your claim')=>{const m=await comm((await f.service.claim(db,ctx,claimId)).communication_id);
  return require('../../src/connections/postgres-mail').capture(db,{id:f.connectorId,workspace_id:ctx.workspaceId,provider_type:'gmail'},
   {messageId:randomUUID(),threadId:m.external_thread_id,sender:'damage@example.test',subject,bodyText:'We are looking into it.'});};
 const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 async function bill(po,quantity){
  const booked=await f.workflows.recordSupplierInvoice(db,ctx,{supplierId:'fixture-supplier',purchaseOrderId:po.purchaseOrderId,supplierInvoiceNumber:'INV-'+randomUUID().slice(0,8),
   issueDate:today,dueDate:require('../../src/accounting/customer-money').addDays(today,30),currency:'USD',taxMinor:0,documentTotalMinor:quantity*100,idempotencyKey:randomUUID(),
   lines:[{purchaseOrderLineId:po.lineIds[0],skuId:f.scope.skuId,description:'Delivered goods',quantity,unitCostMinor:100}]});
  assert.equal(booked.status,'OPEN',JSON.stringify(booked));return booked.billId;
 }
 async function credit(billId,{amountMinor,reason,number='CN-'+randomUUID().slice(0,6)}){
  return db.transaction(async c=>{const bill=(await c.query('SELECT * FROM accounting_supplier_bills WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,billId])).rows[0];
   return require('../../src/accounting/postgres-supplier-credits').applySourceCredit(c,ctx,bill,{amountMinor,taxMinor:0,creditNumber:number,creditDate:today,postingDate:today,
    sourceKey:'claim-test-credit:'+randomUUID(),sourceHash:'synthetic-credit-note',reason});},{isolation:'SERIALIZABLE',retrySafe:true});
 }
 const audits=async action=>Number((await db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ctx.workspaceId,action])).rows[0].n);
 return {...f,receiveDamaged,claimOf,comm,age,position,reply,bill,credit,audits,today};
}

test('Staff damage reports become supplier claims per plan: locked on Starter and Growth, drafted on Pro until taught, then sent alone inside the owner’s limits; Custom needs no teaching',{timeout:420000},async t=>{
 const f=await setup(t,'pro'),{db,ctx,service}=f,ws=ctx.workspaceId;
 const stock=await f.balance(),po=await f.order(10);await f.subscribe('starter');const report=await f.receiveDamaged(po,3);
 assert.equal(Number(report.quantity),3);assert.match(report.note,/cartons crushed/);assert.equal(report.reported_by,ctx.actorId);
 assert.equal(await f.balance(),stock,'Damaged units are received and written off at once');
 assert.equal(await f.audits('Staff damage report recorded at receiving'),1);
 for(const plan of ['starter','growth']){
  await f.subscribe(plan);
  const page=await f.browser.get('/autopilot/delivery-evidence/'+report.receipt_id).expect(200);
  assert.match(page.text,/3 unit damaged/);assert.match(page.text,/Supplier claims require Pro or Custom/);assert.doesNotMatch(page.text,/name="remedy"/);
  await f.browser.post('/autopilot/supplier-claims/preview').set('Accept','application/json').type('form').send({_csrf:f.csrf(page.text),reportId:report.id,connectorId:f.connectorId,remedy:'credit'}).expect(402);
  assert.deepEqual((await service.run(db,ws)).results,[]);
  assert.equal((await service.inbox(db,ws,ctx.actorId)).filter(i=>i.sourceId==='damage-report:'+report.id).length,0);
 }
 // Pro, first 14 days: StockChief only watches, so no draft appears yet.
 await f.subscribe('pro');await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
 assert.deepEqual((await service.run(db,ws)).results,[]);assert.equal(await f.claimOf(report.id),undefined);
 assert.equal((await service.inbox(db,ws,ctx.actorId)).filter(i=>i.sourceId==='damage-report:'+report.id).length,1);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 // Pro drafts the claim for the owner, asking for a credit note.
 const drafted=(await service.run(db,ws)).results;assert.equal(drafted.length,1);assert(drafted[0].drafted,JSON.stringify(drafted));
 assert.deepEqual((await service.run(db,ws)).results,[],'A replayed routine never drafts the same report twice');
 let claim=await service.claim(db,ctx,drafted[0].drafted),p=claim.snapshot;
 assert.equal(p.claimKind,'report');assert.equal(p.remedy,'credit');assert.equal(p.damagedQuantity,3);assert.equal(p.totalMinor,300);assert.equal(p.receiptId,report.receipt_id);assert.equal(claim.communication_id,null);
 let words=require('../../src/purchasing/supplier-claim-source').compose(p);
 for(const expected of [new RegExp(p.poNumber),/Damaged on arrival, reported by our receiving team: 3 unit/,/3 unit at \$1\.00 each = \$3\.00/,/We ask for a credit note for \$3\.00/,/cartons crushed/,/does not accept a settlement/])assert.match(words.body,expected);
 assert.equal((await service.inbox(db,ws,ctx.actorId)).filter(i=>i.sourceId==='supplier-claim:'+claim.id).length,1);
 // The owner asks for replacement goods instead; the same claim is updated.
 await assert.rejects(service.preview(db,ctx,{reportId:report.id,connectorId:f.connectorId}),/what to ask the supplier for/);
 await assert.rejects(service.preview(db,ctx,{reportId:report.id,connectorId:f.connectorId,remedy:'discount'}),/what to ask the supplier for/);
 const page=await f.browser.get('/autopilot/supplier-claims/'+claim.id).expect(200);assert.match(page.text,/Change what this claim asks for/);
 await f.browser.post('/autopilot/supplier-claims/preview').type('form').send({_csrf:f.csrf(page.text),reportId:report.id,connectorId:f.connectorId,remedy:'replacement'}).expect(303);
 claim=await service.claim(db,ctx,claim.id);assert.equal(claim.snapshot.remedy,'replacement');
 assert.match(require('../../src/purchasing/supplier-claim-source').compose(claim.snapshot).body,/We ask for replacement goods: 3 unit of /);
 await assert.rejects(service.configure(db,ctx,claim.id,f.limits({includePhotos:''})),/first individually approve/);
 await f.send(claim);await f.deliver();assert.equal(f.sent.length,1);assert.equal(f.sent[0].attachments?.length||0,0);assert.match(f.sent[0].body,/replacement goods/);
 assert.equal(await f.audits('Supplier claim approved and queued'),1);
 // Taught by the completed manual example, Pro now claims alone within its limits.
 const rule=await service.configure(db,ctx,claim.id,f.limits({includePhotos:'',maxUnits:3,maxValue:'3.00',maxWeekly:'9.00',chaseAfterDays:'5'}));
 const saved=await service.rule(db,ctx,rule.id);assert.equal(saved.scope.remedy,'replacement');assert.equal(saved.scope.chaseAfterDays,5);assert.equal(saved.example_id,claim.id);
 const second=await f.receiveDamaged(await f.order(10),2),routine=(await service.run(db,ws)).results;
 assert.equal(routine.length,1);assert(routine[0].communicationId,JSON.stringify(routine));await f.deliver();assert.equal(f.sent.length,2);
 const auto=await f.claimOf(second.id);assert.equal(auto.automatic,true);assert.equal(auto.rule_id,rule.id);assert.equal(auto.chase_after_days,5);assert.equal(auto.snapshot.remedy,'replacement');
 // Over the per-claim value limit: the claim waits for the owner.
 const large=await f.receiveDamaged(await f.order(10),4),over=(await service.run(db,ws)).results;
 assert.equal(over.length,1);assert.match(over[0].needsReview,/exceeds current owner authority/);
 assert.equal((await f.claimOf(large.id)).communication_id,null);
 // Ask me first: routine claims stop and wait in Needs you.
 const modes=require('../../src/autopilot/job-modes');await modes.save(db,ctx,45,{mode:'ask',revision:0});
 const asked=await f.receiveDamaged(await f.order(10),1),held=(await service.run(db,ws)).results.find(r=>r.reportId===asked.id);
 assert.match(held.needsReview,/Ask me first/);assert.equal(f.sent.length,2);
 await modes.save(db,ctx,45,{mode:'inherit',revision:1});
 // Custom works alone inside an owner scope without teaching.
 await f.subscribe('enterprise');await service.configure(db,ctx,null,{ruleId:rule.id,revision:saved.revision,stop:'yes'});
 const custom=await f.receiveDamaged(await f.order(10),1),draft=(await service.run(db,ws)).results.find(r=>r.reportId===custom.id);assert(draft.drafted,JSON.stringify(draft));
 const refund=await service.preview(db,ctx,{reportId:custom.id,connectorId:f.connectorId,remedy:'refund'});
 const customRule=await service.configure(db,ctx,refund.id,f.limits({includePhotos:''}));assert.equal((await service.rule(db,ctx,customRule.id)).example_id,null);
 await service.sendAutomatic(db,ctx,refund.id,customRule.id);await f.deliver();assert.match(f.sent.at(-1).body,/We ask for a refund of \$1\.00/);
 assert.equal((await service.claim(db,ctx,refund.id)).automatic,true);
 const evidence=await f.browser.get('/autopilot/delivery-evidence/'+custom.receipt_id).expect(200);assert.match(evidence.text,new RegExp((await service.claim(db,ctx,refund.id)).reference));
});

test('Sent claims are followed to the supplier’s reply, credit notes and replacement goods; reminders go alone only under the owner’s rule and current authority',{timeout:420000},async t=>{
 const f=await setup(t,'pro'),{db,ctx,service}=f,ws=ctx.workspaceId,outbound=require('../../src/connections/postgres-outbound-mail');
 const po=await f.order(10),report=await f.receiveDamaged(po,3);
 const claim=await service.preview(db,ctx,{reportId:report.id,connectorId:f.connectorId,remedy:'credit'});
 assert.equal((await f.position(claim.id)).state,'DRAFT');await assert.rejects(follow.close(db,ctx,claim.id,{outcome:'WITHDRAWN',confirmed:'yes'}),/Only a sent claim/);
 await f.send(claim);await f.deliver();let sent=await service.claim(db,ctx,claim.id);
 let pos=await f.position(claim.id);assert.equal(pos.state,'WAITING');assert.equal(pos.chaseDue,false);assert.equal(sent.chase_after_days,7);
 // Seven quiet days: the reminder is due. With no claim rule it waits for the owner.
 await f.age(sent.communication_id,8);pos=await f.position(claim.id);assert.equal(pos.chaseDue,true);
 let run=await follow.run(db,ws);assert.match(run.results.find(r=>r.claimId===claim.id).needsPerson,/need your approval/);
 assert.equal((await service.inbox(db,ws,ctx.actorId)).filter(i=>i.sourceId==='supplier-claim-follow:'+claim.id&&/No reply/.test(i.title)).length,1);
 await assert.rejects(follow.chase(db,ctx,claim.id,{confirmed:'yes',number:2}),/Reload/);
 let page=await f.browser.get('/autopilot/supplier-claims/'+claim.id).expect(200);assert.match(page.text,/Send reminder now/);
 await f.browser.post('/autopilot/supplier-claims/'+claim.id+'/remind').type('form').send({_csrf:f.csrf(page.text),confirmed:'yes',number:'1'}).expect(303);
 await assert.rejects(follow.chase(db,ctx,claim.id,{confirmed:'yes',number:2}),/on its way/);
 await f.deliver();assert.equal(f.sent.length,2);assert.match(f.sent[1].subject,/^Reminder 1: Damaged delivery claim/);assert.match(f.sent[1].body,/We have not had a reply/);assert.equal(f.sent[1].attachments?.length||0,0);
 assert.equal(await f.audits('Supplier claim reminder approved'),1);
 // The owner teaches Pro from this sent claim; the next reminder goes alone,
 // except while routine work is paused.
 const rule=await service.configure(db,ctx,claim.id,f.limits({includePhotos:'',maxUnits:3,maxValue:'3.00',maxWeekly:'9.00'}));
 pos=await f.position(claim.id);await f.age(pos.chases[0].communication_id,8);
 await require('../../src/autopilot/postgres-service').pause(db,ctx,{role:'owner'},'Claim reminder pause test');
 run=await follow.run(db,ws);assert.match(run.results.find(r=>r.claimId===claim.id).needsPerson,/paused/);
 await require('../../src/autopilot/postgres-service').resume(db,ctx,{role:'owner'});
 run=await follow.run(db,ws);assert.equal(run.results.find(r=>r.claimId===claim.id).number,2);
 assert.equal((await follow.run(db,ws)).results.find(r=>r.claimId===claim.id).state,'WAITING','A replayed routine queues no second reminder');
 await f.deliver();assert.equal(f.sent.length,3);assert.match(f.sent[2].subject,/^Reminder 2:/);
 const chases=(await db.query('SELECT * FROM stockchief_runtime.agent_supplier_claim_chases WHERE workspace_id=$1 AND claim_id=$2 ORDER BY number',[ws,claim.id])).rows;
 assert.deepEqual(chases.map(c=>[c.number,c.automatic,c.rule_id]),[[1,false,null],[2,true,rule.id]]);
 pos=await f.position(claim.id);await f.age(pos.chases[1].communication_id,8);pos=await f.position(claim.id);assert.equal(pos.exhausted,true);assert.equal(pos.chaseDue,false);
 assert.equal((await service.inbox(db,ws,ctx.actorId)).filter(i=>/after 2 reminders/.test(i.title)).length,1);
 // The supplier replies in the claim's thread: no more reminders.
 await f.reply(claim.id);pos=await f.position(claim.id);assert.equal(pos.state,'REPLIED');assert.equal(pos.replies.length,1);assert.equal(pos.exhausted,false);
 assert.equal((await service.inbox(db,ws,ctx.actorId)).filter(i=>/Supplier replied/.test(i.title)).length,1);
 // A posted credit note that names the claim settles it; a partial one leaves the rest owed.
 const ref=sent.reference,billId=await f.bill(po,3);await f.credit(billId,{amountMinor:100,reason:'Part credit for claim '+ref});
 pos=await f.position(claim.id);assert.equal(pos.state,'PART_SETTLED');assert.equal(pos.creditedMinor,100);assert.equal(pos.remainingMinor,200);
 await f.credit(billId,{amountMinor:200,reason:'Balance for '+ref.toLowerCase()});pos=await f.position(claim.id);assert.equal(pos.state,'SETTLED');assert.equal(pos.remainingMinor,0);
 page=await f.browser.get('/autopilot/supplier-claims/'+claim.id).expect(200);assert.match(page.text,/Follow-through: Settled/);assert.match(page.text,/\$0\.00 still owed/);

 // A shortage claim asking for replacement goods is settled by the later delivery on the same line.
 const checks=require('../../src/purchasing/agent-delivery-comparisons'),order=await f.order(6),snapshot=await checks.source(db,ctx,order.purchaseOrderId);
 const comparison=await checks.save(db,ctx,{orderId:order.purchaseOrderId,observations:[{code:snapshot.lines[0].code,lineId:order.lineIds[0],basis:'stock',quantity:'4'}],
  sourceReference:'SHORT-DELIVERY',requestKey:randomUUID(),sourceHash:hash(snapshot),physicallyChecked:'yes'});
 await f.receive(order,{reference:'SHORT-DELIVERY',lines:[{lineId:order.lineIds[0],quantity:4,locationId:f.location.id}]});
 const shortage=await service.preview(db,ctx,{comparisonId:comparison.id,lineId:order.lineIds[0],connectorId:f.connectorId,shortageConfirmed:'yes',remedy:'replacement'});
 await f.send(shortage);await f.deliver();assert.match(f.sent.at(-1).body,/6 unit due, 4 checked and received, 2 missing/);assert.match(f.sent.at(-1).body,/We ask for replacement goods: 2 unit of /);
 await f.receive(order,{reference:'REPLACEMENT',lines:[{lineId:order.lineIds[0],quantity:2,locationId:f.location.id}]});
 pos=await f.position(shortage.id);assert.equal(pos.state,'SETTLED');assert.equal(pos.replaced,'2');
 page=await f.browser.get('/autopilot/supplier-claims/'+shortage.id).expect(200);assert.match(page.text,/Replacement goods/);assert.doesNotMatch(page.text,/no longer matches|Prepare and review a current claim/);

 // Linking: a credit that does not name the claim is linked by the owner, once.
 const other=await f.receiveDamaged(await f.order(10),2),linked=await service.preview(db,ctx,{reportId:other.id,connectorId:f.connectorId,remedy:'credit'});
 await f.send(linked);await f.deliver();
 const extra=await f.order(10);await f.receive(extra,{lines:[{lineId:extra.lineIds[0],quantity:1,locationId:f.location.id}]});
 const loose=await f.credit(await f.bill(extra,1),{amountMinor:100,reason:'Goodwill credit'});
 assert.equal((await f.position(linked.id)).creditedMinor,0);
 const choices=await follow.candidates(db,ctx,await service.claim(db,ctx,linked.id),await f.position(linked.id));assert(choices.credits.some(c=>c.id===loose.supplierCreditId));
 await assert.rejects(follow.link(db,ctx,linked.id,{creditId:loose.supplierCreditId}),/confirm/);
 await follow.link(db,ctx,linked.id,{creditId:loose.supplierCreditId,confirmed:'yes'});assert.equal((await follow.link(db,ctx,linked.id,{creditId:loose.supplierCreditId,confirmed:'yes'})).replayed,true);
 pos=await f.position(linked.id);assert.equal(pos.creditedMinor,100);assert.equal(pos.state,'PART_SETTLED');
 await assert.rejects(follow.link(db,ctx,claim.id,{creditId:loose.supplierCreditId,confirmed:'yes'}),/already settles another claim/);
 await assert.rejects(follow.link(db,ctx,linked.id,{creditId:'apcredit-not-real',confirmed:'yes'}),/posted credit from this supplier/);
 // Closing records the refund; nothing is posted or paid.
 const journals=Number((await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ws])).rows[0].n);
 await assert.rejects(follow.close(db,ctx,linked.id,{outcome:'REFUNDED',confirmed:'yes',amount:'1.00'}),/payment reference/);
 page=await f.browser.get('/autopilot/supplier-claims/'+linked.id).expect(200);
 await f.browser.post('/autopilot/supplier-claims/'+linked.id+'/close').type('form').send({_csrf:f.csrf(page.text),outcome:'REFUNDED',amount:'1.00',reference:'BANK-REF-1',confirmed:'yes'}).expect(303);
 pos=await f.position(linked.id);assert.equal(pos.state,'CLOSED');assert.equal(pos.outcomeDetail.amountMinor,100);
 assert.equal((await follow.close(db,ctx,linked.id,{outcome:'REFUNDED',confirmed:'yes'})).replayed,true);
 await assert.rejects(follow.close(db,ctx,linked.id,{outcome:'DECLINED',confirmed:'yes'}),/already closed/);
 assert.equal(Number((await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ws])).rows[0].n),journals);
 assert.equal(await f.audits('Supplier claim closed: refund received'),1);
});

test('A reminder queued before the supplier answered is never delivered, Starter keeps no claim powers after a downgrade, and the claim pages fit a phone and a desktop',{timeout:420000},async t=>{
 const f=await setup(t,'pro'),{db,ctx,service}=f,ws=ctx.workspaceId,outbound=require('../../src/connections/postgres-outbound-mail');
 const report=await f.receiveDamaged(await f.order(10),2),claim=await service.preview(db,ctx,{reportId:report.id,connectorId:f.connectorId,remedy:'credit'});
 await f.send(claim);await f.deliver();const sent=await service.claim(db,ctx,claim.id);await f.age(sent.communication_id,8);
 const queued=await follow.chase(db,ctx,claim.id,{confirmed:'yes',number:1});await f.reply(claim.id);
 const effect=(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='mail.outbound.send'",[ws,queued.communicationId])).rows[0];
 await assert.rejects(outbound.executeSendEffect(db,ws,effect.id,{provider:f.provider}),/answered|settled/);assert.equal(f.sent.length,1);
 // Pages: the claim with its follow-through and the delivery damage page, at 390 px and 1440 px.
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
  const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(origin+'/autopilot/supplier-claims/'+claim.id);const text=await page.locator('main').innerText();
  assert.match(text,/Follow-through: The supplier replied/);assert.match(text,/Re: your claim/);assert.match(text,/Asks for: a credit note/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'claim page fits '+viewport.width);
  await page.goto(origin+'/autopilot/delivery-evidence/'+report.receipt_id);assert.match(await page.locator('main').innerText(),/2 unit damaged/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'damage page fits '+viewport.width);
  require('node:fs').mkdirSync('output',{recursive:true});await page.screenshot({path:'output/supplier-claim-follow-through-'+viewport.width+'.png',fullPage:true});
  assert.deepEqual(errors,[]);await page.close();
 }
 // After a downgrade the agent stops: no drafts, reminders or claim actions.
 await f.subscribe('starter');const later=await f.receiveDamaged(await f.order(10),1);
 assert.deepEqual((await service.run(db,ws)).results,[]);assert.equal(await f.claimOf(later.id),undefined);
 await assert.rejects(follow.close(db,ctx,claim.id,{outcome:'WITHDRAWN',confirmed:'yes'}),/Pro|plan|Starter/i);
 const locked=await f.browser.get('/autopilot/supplier-claims').expect(200);assert.match(locked.text,/Supplier claims require Pro or Custom/);
});
