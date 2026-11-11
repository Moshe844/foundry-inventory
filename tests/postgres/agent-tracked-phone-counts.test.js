'use strict';

process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const tasks=require('../../src/operations/agent-count-tasks');
const campaigns=require('../../src/operations/postgres-count-campaigns');
const queue=require('../../src/operations/postgres-job-queue');
const handlers=require('../../src/operations/postgres-runtime-handlers').create();
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');
const receipts=require('../../src/accounting/postgres-stock-receipt');
const removal=require('../../src/accounting/postgres-stock-removal');
const permissions=require('../../src/actions/permissions');
const modes=require('../../src/autopilot/job-modes');
const autopilot=require('../../src/autopilot/postgres-service');
const time=require('../../src/lib/business-time');

test('phone staff record blind lots, exact serials and independent measures for owner review and separate physical approval',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:6});
  const {db,ctx,subscribe,browser,location}=f,{workspaceId}=ctx;
  const email=randomUUID()+'@example.test';
  const account=await require('../../src/domain/postgres-auth-service').createBusiness(db,{email,password:f.password,name:'Physical Counter',businessName:'Counter home'});
  const counter={workspaceId,actorId:randomUUID()};
  const role=permissions.encodeGrant([permissions.VIEW,permissions.COUNT_STOCK,permissions.ADJUST]);
  await db.query(`INSERT INTO users(id,name,workspace_id,account_id,role,permissions,warehouse_location_ids,created_at)
    VALUES($1,'Physical Counter',$2,$3,'staff',$4,$5::jsonb,now()::text)`,
    [counter.actorId,workspaceId,account.accountId,role,JSON.stringify([location.id])]);
  const bin=await locations.createLocation(db,ctx,{name:'Mixed measurement bin',kind:'bin',parentLocationId:location.id});
  const second=await locations.createLocation(db,ctx,{name:'Another serial bin',kind:'bin',parentLocationId:location.id});
  const newItem=async (code,fields)=>(await catalog.createItem(db,ctx,{name:code,baseCode:code,...fields})).skuIds[0];
  const lots=await newItem('COUNT-LOT',{trackingMode:'lot',secondaryUnitLabel:'kg',secondaryPrecision:3});
  const serial=await newItem('COUNT-SERIAL',{trackingMode:'serial',secondaryUnitLabel:'kg',secondaryPrecision:3});
  const weighed=await newItem('COUNT-PIECES',{trackingMode:'quantity',secondaryUnitLabel:'kg',secondaryPrecision:3});
  const bulk=await newItem('COUNT-BULK',{trackingMode:'quantity',unitLabel:'litre',quantityPrecision:2,quantityIncrement:'0.25'});
  const receive=(skuId,loc,quantity,details)=>receipts.receive(db,ctx,{skuId,locationId:loc.id,quantity,unitCost:'2',idempotencyKey:randomUUID(),...details});
  const lotA=await receive(lots,bin,2,{lotCode:'LOT-ACTUAL-1',secondaryQuantity:'4.250'});
  await receive(lots,bin,1,{lotCode:'LOT-SECRET-2',secondaryQuantity:'1.250'});
  const firstSerial=await receive(serial,bin,2,{serials:['SER-FOUND-A','SER-MISSING-B'],secondaryQuantity:'5.625',
    serialWeights:{'SER-FOUND-A':'2.125','SER-MISSING-B':'3.5'}});
  await receive(serial,second,1,{serials:['SER-FOUND-C'],secondaryQuantity:'1.75',serialWeights:{'SER-FOUND-C':'1.75'}});
  await receive(weighed,bin,3,{secondaryQuantity:'5.125'});
  await receive(bulk,bin,'7.75',{});
  const effects=async()=> (await db.query(`SELECT
    (SELECT count(*) FROM movements WHERE workspace_id=$1)::int AS movements,
    (SELECT count(*) FROM accounting_journal_entries WHERE workspace_id=$1)::int AS journals`,[workspaceId])).rows[0];
  const before=await effects(),today=await time.today(db,workspaceId);
  const request={locationId:location.id,counterId:counter.actorId,stockScope:'all',requestKey:randomUUID()};
  const repeat={...request,firstDay:today,days:7};
  await subscribe('starter');
  await assert.rejects(tasks.assign(db,ctx,request),e=>e.code==='entitlement_required');
  await subscribe('growth');
  await assert.rejects(tasks.schedule(db,ctx,repeat),/Complete and approve one manually assigned count/);
  const id=await tasks.assign(db,ctx,request);
  assert.equal(await tasks.assign(db,ctx,request),id);
  await assert.rejects(campaigns.page(db,counter,id),e=>e.code==='forbidden');
  await db.query("UPDATE users SET warehouse_location_ids='[]' WHERE id=$1",[counter.actorId]);
  await assert.rejects(tasks.page(db,counter,id),/assigned warehouses/);
  await db.query('UPDATE users SET warehouse_location_ids=$2::jsonb WHERE id=$1',[counter.actorId,JSON.stringify([location.id])]);

  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const phone=await chrome.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const base='http://127.0.0.1:'+server.address().port,phonePath='/warehouse/my-counts/'+id;
  await phone.goto(base+'/login');await phone.locator('[name=email]').fill(email);await phone.locator('[name=password]').fill(f.password);
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await phone.goto(base+'/inventories');const token=await phone.locator('[name=_csrf]').first().inputValue();
  await phone.request.post(base+'/inventories/switch',{form:{_csrf:token,workspaceId}});
  await phone.goto(base+'/warehouse/stock');
  await phone.getByRole('link',{name:'Open my count'}).click();
  assert.equal(new URL(phone.url()).pathname,phonePath);
  const blind=await phone.locator('main').innerText();
  assert.match(blind,/0 of 6 positions/);
  assert.doesNotMatch(await phone.content(),/LOT-ACTUAL-1|LOT-SECRET-2|SER-FOUND-A|SER-MISSING-B|5\.625|unit cost|recorded quantity/i);
  assert.equal(await phone.locator('body').evaluate(b=>b.scrollWidth<=innerWidth+2),true);
  const form=(skuId,loc)=>phone.locator('form').filter({has:phone.locator('input[name=skuId][value="'+skuId+'"]')})
    .filter({has:phone.locator('input[name=locationId][value="'+loc.id+'"]')});
  const click=async (section,name)=>Promise.all([phone.waitForNavigation(),section.getByRole('button',{name,exact:true}).click()]);
  const lotForm=form(lots,bin);
  await lotForm.getByLabel('Physical lot code').fill('LOT-ACTUAL-1');
  await lotForm.getByLabel('Lot quantity (unit)').fill('1');
  await lotForm.getByLabel('Physical weight (kg)').fill('2.125');
  await lotForm.getByRole('button',{name:'Add a lot'}).click();
  assert.equal(await lotForm.getByLabel('Physical lot code').count(),2);
  await lotForm.getByLabel('Physical lot code').nth(1).fill('LOT-SECRET-2');
  await lotForm.getByLabel('Lot quantity (unit)').nth(1).fill('1');
  await lotForm.getByLabel('Physical weight (kg)').nth(1).fill('1.25');
  await click(lotForm,'Save entries and continue');
  assert.match(await phone.locator('main').innerText(),/2 lot entries saved so far/);
  assert.match(await phone.locator('main').innerText(),/0 of 6 positions/);
  await click(lotForm,'Finish this position');
  const serialForm=form(serial,bin);
  await serialForm.getByLabel('Physical serial number').fill('SER-FOUND-A');
  await serialForm.getByLabel('Physical weight (kg)').fill('2.125');
  await click(serialForm,'Finish this position');
  const duplicate={skuId:serial,locationId:second.id,entries:[{code:'SER-FOUND-A',secondary:'2.125'}]};
  await assert.rejects(tasks.record(db,counter,id,duplicate),/already recorded at another position/);
  const otherSerial=form(serial,second);
  await otherSerial.getByLabel('Physical serial number').fill('SER-FOUND-C');
  await otherSerial.getByLabel('Physical weight (kg)').fill('1.75');
  await click(otherSerial,'Finish this position');
  const weightForm=form(weighed,bin);
  await weightForm.getByLabel('Physical quantity').fill('3');
  await weightForm.getByLabel('Physical weight (kg)').fill('5.125');
  await click(weightForm,'Save count');
  const bulkForm=form(bulk,bin);
  await bulkForm.getByLabel('Physical quantity').fill('7.5');
  await click(bulkForm,'Save count');
  const plain=form(f.item.skuIds[0],location);
  await plain.getByLabel('Physical quantity').fill('6');
  await click(plain,'Save count');
  assert.match(await phone.locator('main').innerText(),/6 of 6 positions counted/);
  assert.match(await phone.locator('main').innerText(),/sent to the owner for review/);
  const observed=async()=> (await db.query(`SELECT location_id,sku_id,observation,reviewed_at
    FROM stockchief_runtime.agent_count_position_evidence WHERE workspace_id=$1 AND campaign_id=$2 ORDER BY location_id,sku_id`,[workspaceId,id])).rows;
  const staffEvidence=await observed();
  assert.equal(staffEvidence.length,4);
  assert.deepEqual(staffEvidence.find(e=>e.sku_id===lots).observation,{mode:'lot',quantity:'2',secondary:'3.375',
    entries:[{code:'LOT-ACTUAL-1',quantity:'1',secondary:'2.125'},{code:'LOT-SECRET-2',quantity:'1',secondary:'1.25'}]});
  assert.deepEqual(staffEvidence.find(e=>e.sku_id===serial&&e.location_id===bin.id).observation.entries,
    [{code:'SER-FOUND-A',quantity:'1',secondary:'2.125'}]);
  await tasks.record(db,counter,id,{skuId:serial,locationId:bin.id,entries:[{code:'SER-FOUND-A',secondary:'2.125'}]});
  await assert.rejects(tasks.record(db,counter,id,{skuId:serial,locationId:bin.id,entries:[{code:'SER-MISSING-B',secondary:'3.5'}]}),/already has a count/);
  assert.deepEqual(await observed(),staffEvidence);
  assert.deepEqual(await effects(),before);
  assert.equal((await tasks.inbox(db,workspaceId,ctx.actorId))[0].actionLabel,'Review counted quantities');

  const path='/warehouse/counts/campaigns/'+id;
  const review=await browser.get(path).expect(200);
  assert.match(review.text,/Physical observation differs from current stock/);
  assert.match(review.text,/LOT-ACTUAL-1|SER-MISSING-B/);
  await browser.post(path+'/staff-quantities').type('form').send({_csrf:f.csrf(review.text),revision:1}).expect(303);
  const worksheet=await campaigns.page(db,ctx,id);
  assert.equal(worksheet.totals.uncounted,0);
  assert.equal(worksheet.totals.variances,3);
  await assert.rejects(campaigns.approve(db,ctx,id,worksheet.campaign.revision),/Resolve any stock discrepancy separately/);
  assert.deepEqual(await effects(),before);

  await removal.issue(db,ctx,{skuId:lots,locationId:bin.id,lotId:lotA.lotId,quantity:1,secondaryQuantity:'2.125',reasonCode:'cycle_count',idempotencyKey:randomUUID()});
  const missing=(await db.query('SELECT id FROM serial_units WHERE workspace_id=$1 AND id=ANY($2::text[]) AND serial=$3',
    [workspaceId,firstSerial.serialUnitIds,'SER-MISSING-B'])).rows[0].id;
  await removal.issue(db,ctx,{skuId:serial,locationId:bin.id,serialUnitIds:[missing],quantity:1,secondaryQuantity:'3.5',reasonCode:'cycle_count',idempotencyKey:randomUUID()});
  const resolved=await browser.get(path).expect(200);
  assert.match(resolved.text,/Matches the current stock after the original snapshot/);
  await browser.post(path+'/approve').type('form').send({_csrf:f.csrf(resolved.text),revision:worksheet.campaign.revision}).expect(303);
  const kind='agent.phone-count.apply.v1';
  for(let i=0;i<2;i++){
    const applied=await queue.processOne(db,handlers,{owner:'phone-count-test',kinds:[kind],leaseMs:120000});
    assert.equal(applied?.status,'COMPLETED',JSON.stringify(applied?.lastError));
  }
  assert.equal((await campaigns.page(db,ctx,id)).campaign.status,'COMPLETED');
  const after=await effects();
  assert.equal(after.movements-before.movements,3);
  assert.equal(after.journals-before.journals,3);
  assert.equal((await campaigns.run({workspaceId,payload:{actorId:ctx.actorId,campaignId:id}},db)).status,'COMPLETED');
  assert.deepEqual(await effects(),after);
  const measured=(await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[workspaceId,bulk,bin.id])).rows[0];
  assert.equal(require('../../src/domain/exact-quantity').canonical(measured.on_hand),'7.5');

  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await tasks.schedule(db,ctx,repeat);
  const stored=async()=> (await db.query('SELECT * FROM stockchief_runtime.agent_count_schedules WHERE workspace_id=$1 AND location_id=$2',[workspaceId,location.id])).rows[0];
  assert.equal((await stored()).example_campaign_id,id);
  const run=()=>db.transaction(c=>tasks.runSchedules(c,workspaceId),{isolation:'SERIALIZABLE',retrySafe:true});
  const lists=async()=> (await db.query('SELECT * FROM stockchief_runtime.agent_count_tasks WHERE workspace_id=$1 ORDER BY scheduled,campaign_id',[workspaceId])).rows;
  await modes.save(db,ctx,7,{mode:'watch',revision:0});
  await run();assert.equal((await lists()).length,1);
  await modes.save(db,ctx,7,{mode:'routine',revision:1});
  await subscribe('starter');await run();assert.equal((await lists()).length,1);
  await subscribe('growth');await run();await run();
  assert.equal((await lists()).filter(r=>r.scheduled&&r.includes_tracking).length,1);
  assert.deepEqual(await effects(),after);
  const roots=[location.id];
  for(const [tier,label] of [['pro','Pro'],['enterprise','Custom']]){
    await subscribe(tier);
    const warehouse=await locations.createLocation(db,ctx,{name:label+' count site',kind:'warehouse'});
    roots.push(warehouse.id);
    await db.query('UPDATE users SET warehouse_location_ids=$2::jsonb WHERE id=$1',[counter.actorId,JSON.stringify(roots)]);
    await receive(lots,warehouse,1,{lotCode:'ROUTINE-'+label,secondaryQuantity:'1.125'});
    const native=await effects();
    await tasks.schedule(db,ctx,{...repeat,locationId:warehouse.id});
    await run();await run();
    const siteLists=(await lists()).filter(list=>list.location_id===warehouse.id);
    assert.equal(siteLists.length,1);
    assert.equal(siteLists[0].scheduled,true);
    assert.equal(siteLists[0].includes_tracking,true);
    assert.equal((await db.query('SELECT example_campaign_id FROM stockchief_runtime.agent_count_schedules WHERE workspace_id=$1 AND location_id=$2',
      [workspaceId,warehouse.id])).rows[0].example_campaign_id,null);
    const sitePage=await tasks.page(db,counter,siteLists[0].campaign_id);
    assert.equal(sitePage.rows[0].tracking_mode,'lot');
    assert.doesNotMatch(JSON.stringify(sitePage),new RegExp('ROUTINE-'+label+'|1\\.125'));
    assert.deepEqual(await effects(),native);
  }
});

test('migration preserves completed manual quantity evidence and legacy recurring scope',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:2,through:'377-agent-return-rate-notices.sql'});
  const {db,ctx,location}=f,{workspaceId,actorId}=ctx;
  const day=await time.today(db,workspaceId),historical=[];
  for(const requestKey of ['legacy-owner-example','schedule:legacy-existing']){
    const {id}=await campaigns.create(db,ctx,{locationId:location.id});
    historical.push(id);
    await db.query(`INSERT INTO stockchief_runtime.agent_count_tasks(workspace_id,campaign_id,counter_id,request_key,location_id,observed_at)
      VALUES($1,$2,$3,$4,$5,now())`,[workspaceId,id,actorId,requestKey,location.id]);
    await db.query(`UPDATE warehouse_count_campaign_lines SET counter_quantity=before_quantity,counted_quantity=before_quantity,applied_at=now()
      WHERE workspace_id=$1 AND campaign_id=$2`,[workspaceId,id]);
    await db.query(`UPDATE warehouse_count_campaigns SET status='COMPLETED',approved_by_user_id=$3,approved_at=now(),completed_at=now()
      WHERE workspace_id=$1 AND id=$2`,[workspaceId,id,actorId]);
  }
  await db.query(`INSERT INTO stockchief_runtime.agent_count_schedules(workspace_id,location_id,counter_id,owner_id,interval_days,next_due)
    VALUES($1,$2,$3,$3,7,$4)`,[workspaceId,location.id,actorId,day]);
  const migrated=await require('../../src/db/migrate-postgres').migratePostgres(db);
  assert(migrated.includes('382-assigned-phone-count-evidence.sql'));
  await f.subscribe('growth');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const run=()=>db.transaction(c=>tasks.runSchedules(c,workspaceId),{isolation:'SERIALIZABLE',retrySafe:true});
  await run();await run();
  const schedule=(await db.query(`SELECT example_campaign_id,includes_tracking,last_issue FROM stockchief_runtime.agent_count_schedules
    WHERE workspace_id=$1 AND location_id=$2`,[workspaceId,location.id])).rows[0];
  assert.deepEqual(schedule,{example_campaign_id:historical[0],includes_tracking:false,last_issue:null});
  const preserved=(await db.query(`SELECT t.campaign_id,t.scheduled,t.includes_tracking,l.counter_quantity,s.status
    FROM stockchief_runtime.agent_count_tasks t JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id
    JOIN warehouse_count_campaign_lines l ON l.workspace_id=t.workspace_id AND l.campaign_id=t.campaign_id WHERE t.workspace_id=$1`,[workspaceId])).rows;
  assert.equal(preserved.length,3);
  assert.deepEqual(historical.map(id=>{const p=preserved.find(row=>row.campaign_id===id);return [p.scheduled,p.includes_tracking,Number(p.counter_quantity),p.status];}),
    [[false,false,2,'COMPLETED'],[true,false,2,'COMPLETED']]);
  const next=preserved.find(row=>!historical.includes(row.campaign_id));
  assert.deepEqual([next.scheduled,next.includes_tracking,next.counter_quantity,next.status],[true,false,null,'DRAFT']);
  assert.equal(await f.balance(),2);
});
