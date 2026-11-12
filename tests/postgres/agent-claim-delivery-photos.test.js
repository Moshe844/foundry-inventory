'use strict';process.env.NODE_ENV='test';
// Job 46: photos of damaged boxes taken on the phone at receiving or on a
// delivery check travel with the supplier claim. Growth prepares the photo
// set for the owner; Pro and Custom attach it on their own.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/agent-claim-fixture'),{hash}=require('../../src/pricing/postgres-promotions');
const sharp=require('sharp'),photos=require('../../src/operations/quality-photos');
const image=(shade,format='png',size=64)=>sharp({create:{width:size,height:size,channels:3,background:{r:shade,g:70,b:40}}})[format]().toBuffer();

async function setup(t,plan){
 const f=await fixture(t,plan,{qc:false}),{db,ctx}=f;
 async function receiveDamaged(po,quantity,note='Outer carton crushed, two units broken.'){
  const form=await f.browser.get('/purchasing/orders/'+po.purchaseOrderId+'/receive').expect(200),line=po.lineIds[0];
  await f.browser.post('/purchasing/orders/'+po.purchaseOrderId+'/receive').type('form').send({_csrf:f.csrf(form.text),idempotencyKey:randomUUID(),
   ['qty_'+line]:String(quantity),['location_'+line]:f.location.id,['condition_'+line]:'damaged',note}).expect(303);
  return (await db.query(`SELECT d.*,rl.receipt_id FROM stockchief_runtime.agent_receipt_damage_reports d JOIN purchase_order_receipt_lines rl ON rl.id=d.receipt_line_id
   JOIN purchase_order_receipts r ON r.id=rl.receipt_id WHERE d.workspace_id=$1 AND r.purchase_order_id=$2 ORDER BY d.created_at DESC LIMIT 1`,[ctx.workspaceId,po.purchaseOrderId])).rows[0];
 }
 async function upload(path,buffer,{filename='damaged-box.png',contentType='image/png',caption='Crushed outer carton',json=false}={}){
  const page=await f.browser.get(path).expect(200);
  const request=f.browser.post(path+'/photos').set('x-csrf-token',f.csrf(page.text));if(json)request.set('Accept','application/json');
  return request.field('caption',caption).attach('photo',buffer,{filename,contentType});
 }
 const stored=async parent=>(await db.query(`SELECT * FROM stockchief_runtime.agent_quality_photos WHERE workspace_id=$1 AND ${parent.receiptId?'receipt_id':'delivery_comparison_id'}=$2 ORDER BY created_at,id`,[ctx.workspaceId,parent.receiptId||parent.comparisonId])).rows;
 return {...f,receiveDamaged,upload,stored};
}

test('Starter cannot add photos; Growth preserves the phone photos of damaged boxes and prepares the photo set for the owner, without opening claims',{timeout:300000},async t=>{
 const f=await setup(t,'pro'),{db,ctx,service}=f,ws=ctx.workspaceId,po=await f.order(10);
 await f.subscribe('starter');const report=await f.receiveDamaged(po,2),path='/autopilot/delivery-evidence/'+report.receipt_id;
 let page=await f.browser.get(path).expect(200);assert.match(page.text,/Adding delivery photos requires Growth/);assert.doesNotMatch(page.text,/name="photo"/);
 assert.equal((await f.upload(path,f.bytes,{json:true})).status,402,'Starter photo upload is refused');assert.equal((await f.stored({receiptId:report.receipt_id})).length,0);
 await f.subscribe('growth');page=await f.browser.get(path).expect(200);assert.match(page.text,/name="photo"/);assert.match(page.text,/capture="environment"/);
 const ok=await f.upload(path,f.bytes);assert.equal(ok.status,303,ok.text);
 let rows=await f.stored({receiptId:report.receipt_id});assert.equal(rows.length,1);
 assert.deepEqual(rows[0].content,f.bytes,'The original bytes are kept unchanged');assert.equal(rows[0].content_hash,photos.digest(f.bytes));assert(rows[0].email_content.length<=photos.maxEmailBytes);
 assert.equal((await sharp(rows[0].email_content).metadata()).format,'jpeg');assert.equal(rows[0].hold_id,null);
 // Replay keeps one photo; wrong types, corrupt files and oversize files are refused.
 assert.equal((await f.upload(path,f.bytes)).status,303);assert.equal((await f.stored({receiptId:report.receipt_id})).length,1);
 for(const [buffer,options,message] of [[Buffer.from('GIF89a not a photo'),{filename:'box.gif',contentType:'image/gif'},/JPEG or PNG/],
  [Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('broken')]),{filename:'broken.png'},/could not be read/],
  [Buffer.alloc(10*1024*1024+1,1),{filename:'huge.png'},/10 MB|too large/i]]){
  const refused=await f.upload(path,buffer,{...options,json:true});assert.notEqual(refused.status,303);assert.match(refused.text,message);
 }
 assert.equal((await f.stored({receiptId:report.receipt_id})).length,1);
 // Growth: the prepared set is ready to attach by hand, and no claim can be opened.
 page=await f.browser.get(path).expect(200);assert.match(page.text,/Photo set for your claim/);assert.match(page.text,/Email copy/);
 const copy=await f.browser.get('/autopilot/quality-photos/'+rows[0].id+'?copy=email').expect(200);assert.deepEqual(copy.body,rows[0].email_content);
 const original=await f.browser.get('/autopilot/quality-photos/'+rows[0].id).expect(200);assert.deepEqual(original.body,f.bytes);
 const ready=(await service.inbox(db,ws,ctx.actorId)).filter(i=>i.sourceId==='delivery-photos:'+report.receipt_id);assert.equal(ready.length,1);assert.match(ready[0].title,/Photos ready/);
 await f.browser.post('/autopilot/supplier-claims/preview').set('Accept','application/json').set('x-csrf-token',f.csrf(page.text)).type('form')
  .send({reportId:report.id,connectorId:f.connectorId,remedy:'credit',photoIds:rows[0].id}).expect(402);
 assert.deepEqual((await service.run(db,ws)).results,[]);
 // Ten photos per delivery at most.
 for(let i=0;i<9;i++)await photos.upload(db,ctx,{receiptId:report.receipt_id},{filename:'box-'+i+'.png',buffer:await image(80+i)},{caption:'Box '+i});
 await assert.rejects(photos.upload(db,ctx,{receiptId:report.receipt_id},{filename:'one-more.png',buffer:await image(120)},{}),/ten photos/);
});

test('Pro and Custom attach the delivery photo set to claims on their own, keep it with the claim and send it with the email; selections stay with their delivery',{timeout:420000},async t=>{
 const f=await setup(t,'pro'),{db,ctx,service}=f,ws=ctx.workspaceId,outbound=require('../../src/connections/postgres-outbound-mail');
 const report=await f.receiveDamaged(await f.order(10),2),path='/autopilot/delivery-evidence/'+report.receipt_id;
 assert.equal((await f.upload(path,f.bytes)).status,303);const [photo]=await f.stored({receiptId:report.receipt_id});
 // Pro drafts the claim and attaches the delivery's photo set without being asked.
 const drafted=(await service.run(db,ws)).results.find(r=>r.reportId===report.id);assert(drafted.drafted,JSON.stringify(drafted));
 let claim=await service.claim(db,ctx,drafted.drafted);assert.deepEqual(claim.snapshot.photos.map(p=>p.id),[photo.id]);assert.equal(claim.snapshot.photos[0].emailHash,photo.email_hash);
 let page=await f.browser.get('/autopilot/supplier-claims/'+claim.id).expect(200);assert.match(page.text,/Download email copy/);
 assert.match(require('../../src/purchasing/supplier-claim-source').compose(claim.snapshot).body,/Attached: 1 resized copies of the delivery photos/);
 // A photo from another delivery cannot be added to this claim.
 const other=await f.receiveDamaged(await f.order(10),1);await f.upload('/autopilot/delivery-evidence/'+other.receipt_id,await image(200));
 const [foreign]=await f.stored({receiptId:other.receipt_id});
 await assert.rejects(service.preview(db,ctx,{reportId:report.id,connectorId:f.connectorId,remedy:'credit',photoIds:[photo.id,foreign.id]}),/exact delivery inspection, its receipt/);
 const otherDraft=await service.preview(db,ctx,{reportId:other.id,connectorId:f.connectorId,remedy:'credit',photoIds:[foreign.id]});assert.equal(otherDraft.snapshot.photos.length,1);
 await f.send(claim);await f.deliver();assert.equal(f.sent.length,1);assert.equal(f.sent[0].attachments.length,1);assert.deepEqual(f.sent[0].attachments[0].content,photo.email_content);
 assert.equal(f.sent[0].attachments[0].contentType,'image/jpeg');
 // The photos stay with the claim record after sending.
 claim=await service.claim(db,ctx,claim.id);assert.equal(claim.snapshot.photos.length,1);
 page=await f.browser.get('/autopilot/supplier-claims/'+claim.id).expect(200);assert.match(page.text,new RegExp('/autopilot/quality-photos/'+photo.id));
 // Taught by that claim with photos, Pro claims and attaches photos alone.
 const rule=await service.configure(db,ctx,claim.id,f.limits({includePhotos:'yes',maxUnits:2,maxValue:'2.00',maxWeekly:'6.00'}));
 const next=await f.receiveDamaged(await f.order(10),2);await f.upload('/autopilot/delivery-evidence/'+next.receipt_id,await image(40));
 const sent=(await service.run(db,ws)).results.find(r=>r.reportId===next.id);assert(sent.communicationId,JSON.stringify(sent));await f.deliver();
 assert.equal(f.sent.length,2);assert.equal(f.sent[1].attachments.length,1);
 // More than three photos: the owner chooses which go.
 const many=await f.receiveDamaged(await f.order(10),1);for(let i=0;i<4;i++)await photos.upload(db,ctx,{receiptId:many.receipt_id},{filename:'m'+i+'.png',buffer:await image(10+i)},{});
 assert.match((await service.run(db,ws)).results.find(r=>r.reportId===many.id).needsReview,/three photos/);
 // Watch only on job 46 stops photo attachment under the rule; nothing is sent.
 const modes=require('../../src/autopilot/job-modes');await modes.save(db,ctx,46,{mode:'watch',revision:0});
 const watched=await f.receiveDamaged(await f.order(10),1);await f.upload('/autopilot/delivery-evidence/'+watched.receipt_id,await image(90));
 assert.match((await service.run(db,ws)).results.find(r=>r.reportId===watched.id).needsReview,/Watch only/);assert.equal(f.sent.length,2);
 await modes.save(db,ctx,46,{mode:'inherit',revision:1});
 // Once Watch only is lifted, the same delivery is claimed with its photo.
 const resumed=(await service.run(db,ws)).results.find(r=>r.reportId===watched.id);assert(resumed.communicationId,JSON.stringify(resumed));
 await f.deliver();assert.equal(f.sent.length,3);assert.equal(f.sent[2].attachments.length,1);
 // Custom: a shortage photo from the delivery check goes with the shortage claim, without teaching.
 await f.subscribe('enterprise');await service.configure(db,ctx,null,{ruleId:rule.id,revision:(await service.rule(db,ctx,rule.id)).revision,stop:'yes'});
 const checks=require('../../src/purchasing/agent-delivery-comparisons');
 async function shortageWithPhoto(reference,shade){
  const order=await f.order(6),snapshot=await checks.source(db,ctx,order.purchaseOrderId);
  const comparison=await checks.save(db,ctx,{orderId:order.purchaseOrderId,observations:[{code:snapshot.lines[0].code,lineId:order.lineIds[0],basis:'stock',quantity:'4'}],
   sourceReference:reference,requestKey:randomUUID(),sourceHash:hash(snapshot),physicallyChecked:'yes'});
  const checkPath='/autopilot/delivery-checks/'+comparison.id;assert.equal((await f.upload(checkPath,await image(shade,'jpeg',1200),{filename:'open-box.jpg',contentType:'image/jpeg'})).status,303);
  const [boxPhoto]=await f.stored({comparisonId:comparison.id});
  await f.receive(order,{reference,lines:[{lineId:order.lineIds[0],quantity:4,locationId:f.location.id}]});
  const page=await f.browser.get(checkPath).expect(200);assert.match(page.text,new RegExp('value="'+boxPhoto.id+'"'));
  const claim=await service.preview(db,ctx,{comparisonId:comparison.id,lineId:order.lineIds[0],connectorId:f.connectorId,shortageConfirmed:'yes',remedy:'credit',photoIds:boxPhoto.id});
  return {claim,boxPhoto};
 }
 const first=await shortageWithPhoto('SHORT-WITH-PHOTO',60);assert.equal(first.claim.snapshot.photos.length,1);
 const shortRule=await service.configure(db,ctx,first.claim.id,f.limits({includePhotos:'yes'}));assert.equal((await service.rule(db,ctx,shortRule.id)).include_photos,true);
 const shortSend=await service.sendAutomatic(db,ctx,first.claim.id,shortRule.id);await f.deliver();
 const shortMessage=f.sent.find(m=>m.subject.includes(first.claim.reference));assert(shortMessage,'shortage claim delivered');
 assert.equal(shortMessage.attachments.length,1);assert.deepEqual(shortMessage.attachments[0].content,first.boxPhoto.email_content);assert.match(shortMessage.body,/Attached: 1 resized copy of our delivery photos/);
 // A tampered email copy is never delivered.
 const second=await shortageWithPhoto('SHORT-TAMPERED',160),queued=await service.sendAutomatic(db,ctx,second.claim.id,shortRule.id),count=f.sent.length;
 await db.query("UPDATE stockchief_runtime.agent_quality_photos SET email_content=decode('ffd8ff00','hex') WHERE workspace_id=$1 AND id=$2",[ws,second.boxPhoto.id]);
 const effect=(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='mail.outbound.send'",[ws,queued.communicationId])).rows[0];
 await assert.rejects(outbound.executeSendEffect(db,ws,effect.id,{provider:f.provider}),/integrity review/);assert.equal(f.sent.length,count);
});

test('The delivery damage page with photos fits a phone and a desktop, and staff upload from the phone camera',{timeout:300000},async t=>{
 const f=await setup(t,'pro'),{db,ctx}=f,report=await f.receiveDamaged(await f.order(10),2);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
  const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(origin+'/autopilot/delivery-evidence/'+report.receipt_id);
  await page.locator('[name=photo]').setInputFiles({name:'phone-'+viewport.width+'.png',mimeType:'image/png',buffer:await image(viewport.width%200)});
  await page.locator('[name=caption]').fill('Taken at the dock');
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save photo',exact:true}).click()]);
  const text=await page.locator('main').innerText();assert.match(text,/Photo saved/);assert.match(text,/phone-/);assert.match(text,/Taken at the dock/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'damage page fits '+viewport.width);
  require('node:fs').mkdirSync('output',{recursive:true});await page.screenshot({path:'output/delivery-damage-photos-'+viewport.width+'.png',fullPage:true});
  assert.deepEqual(errors,[]);await page.close();
 }
 assert.equal((await f.stored({receiptId:report.receipt_id})).length,2);
 // Stored-data measurement covers the photos and the claim follow-through tables.
 const measured=(await db.query("SELECT relation::text AS relation,bytes_expression FROM commercial_storage_tables WHERE relation::text IN ('stockchief_runtime.agent_quality_photos','stockchief_runtime.agent_supplier_claims','stockchief_runtime.agent_receipt_damage_reports','stockchief_runtime.agent_supplier_claim_chases','stockchief_runtime.agent_supplier_claim_settlements')")).rows;
 assert.equal(measured.length,5);
 for(const row of measured){const bytes=Number((await db.query('SELECT coalesce(sum('+row.bytes_expression+'),0)::bigint AS n FROM '+row.relation+' t WHERE t.workspace_id=$1',[ctx.workspaceId])).rows[0].n);assert(bytes>=0,row.relation);if(/photos|damage_reports/.test(row.relation))assert(bytes>0,row.relation);}
});
