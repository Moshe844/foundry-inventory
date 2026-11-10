'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx}=f;await f.subscribe('pro');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const locations=require('../../src/domain/postgres-location-service'),engine=require('../../src/domain/postgres-inventory-engine'),costing=require('../../src/accounting/postgres-costing');
 const from=await locations.createLocation(db,ctx,{name:'Wrong bin',kind:'bin',parentLocationId:f.location.id,barcode:'BIN-WRONG'}),to=await locations.createLocation(db,ctx,{name:'Correct bin',kind:'bin',parentLocationId:f.location.id,barcode:'BIN-RIGHT'}),other=await locations.createLocation(db,ctx,{name:'Another correct bin',kind:'bin',parentLocationId:f.location.id,barcode:'BIN-OTHER'});
 await db.transaction(async c=>{const moved=await engine.transferInTransaction(c,ctx,{skuId:f.item.skuIds[0],sourceLocationId:f.location.id,destinationLocationId:from.id,quantity:20,idempotencyKey:'seed-bin'});await costing.transferInTransaction(c,ctx,{...moved,sourceType:'fixture',sourceRecordId:'seed-bin'});},{isolation:'SERIALIZABLE'});
 const service=require('../../src/warehouse/agent-bin-corrections'),sku=(await db.query('SELECT * FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0];
 const input=(quantity=1,dest=to)=>({requestKey:randomUUID(),productCode:sku.code,fromCode:from.barcode,toCode:dest.barcode,quantity,reason:'wrong-putaway'});
 const open=async(quantity=1,dest=to)=>service.open(db,ctx,input(quantity,dest));
 const scan=async(id,overrides={})=>{const row=await service.get(db,ctx,id);return service.scan(db,ctx,id,{productCode:row.source.productBarcode,fromCode:row.source.from.barcode,toCode:row.source.to.barcode,quantity:row.source.quantity,confirmed:'yes',expectedFingerprint:row.fingerprint,...overrides});};
 const approve=async id=>service.approve(db,ctx,id,{confirmed:'yes',expectedFingerprint:(await service.get(db,ctx,id)).fingerprint});
 const position=async locationId=>Number((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,sku.id,locationId])).rows[0]?.on_hand||0);
 const totals=async()=> (await db.query('SELECT sum(quantity_units)::text units,sum(total_cost_minor)::text cost FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku.id])).rows[0];
 const ledger=async()=>(await db.query("SELECT l.account_id,sum(l.debit_minor-l.credit_minor)::text balance FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id AND e.status='POSTED' WHERE l.workspace_id=$1 GROUP BY l.account_id HAVING sum(l.debit_minor-l.credit_minor)<>0 ORDER BY l.account_id",[ctx.workspaceId])).rows;
 return {...f,service,from,to,other,sku,input,open,scan,approve,position,totals,ledger};
}

test('Pro needs physical scans and a taught scope; Custom retains lower limits and Starter/Growth cannot use the job',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f,before=await f.totals(),beforeLedger=await f.ledger(),journals=Number((await db.query('SELECT count(*) n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
 for(const plan of ['starter','growth']){await f.subscribe(plan);await assert.rejects(f.open(),e=>e.code==='entitlement_required');}
 await f.subscribe('pro');await service.configure(db,ctx,{maximumUnits:3,confirmed:'yes',revision:0});
 const prepared=await f.open();assert.equal(await f.position(f.from.id),20);await assert.rejects(f.approve(prepared.id),/physical scan evidence/);
 await assert.rejects(f.scan(prepared.id,{toCode:f.from.barcode}),/exact product, source bin and destination bin/);
 const held=await f.scan(prepared.id);assert.equal(held.needsApproval,true);assert.equal(await f.position(f.from.id),20);
 const approved=await f.approve(prepared.id);assert.equal(approved.automatic,false);assert.equal(await f.position(f.from.id),19);assert.equal(await f.position(f.to.id),1);
 await service.teach(db,ctx,prepared.id,{maximumUnits:1,confirmed:'yes',revision:0});
 const next=await f.open();const result=await f.scan(next.id);assert.equal(result.automatic,true);assert.equal(await f.position(f.to.id),2);
 assert.equal((await f.scan(next.id)).replayed,true);
 for(const plan of ['pro','enterprise']){await f.subscribe(plan);const large=await f.open(2);const stopped=await f.scan(large.id);assert.equal(stopped.needsApproval,true);assert.match(stopped.reason,/lower owner-taught limit/);}
 const independent=await f.open(2,f.other);assert.equal((await f.scan(independent.id)).automatic,true,'Custom can complete a new bin scope without a taught example');
 assert.deepEqual(await f.totals(),before);assert.deepEqual(await f.ledger(),beforeLedger);
 assert.equal(Number((await db.query('SELECT count(*) n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),journals+6,'Three completed native transfers have exactly one dispatch and receipt journal each; replay adds no journal');
 const roi=await require('../../src/autopilot/time-saved').report(db,ctx);assert.equal(roi.rows.find(r=>r.key==='bin-correction').count,3);assert.equal(roi.rows.find(r=>r.key==='bin-correction').minutes,null);
 await f.subscribe('starter');await service.configure(db,ctx,{stop:'yes',revision:1});await service.teach(db,ctx,prepared.id,{remove:'yes',confirmed:'yes',revision:1});
 assert.equal((await db.query('SELECT enabled FROM stockchief_runtime.agent_bin_correction_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].enabled,false);
});

test('competing scans complete once, watch and downgrade hold work, and a late cost failure rolls back both stock legs',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f;await f.subscribe('enterprise');await service.configure(db,ctx,{maximumUnits:3,confirmed:'yes',revision:0});
 const prepared=await f.open(),results=await Promise.all([f.scan(prepared.id),f.scan(prepared.id)]);assert.equal(results.filter(r=>!r.replayed).length,1);assert.equal(await f.position(f.to.id),1);
 const changed=await f.open();await f.subscribe('growth');await assert.rejects(f.scan(changed.id),e=>e.code==='entitlement_required');await f.subscribe('enterprise');
 await require('../../src/autopilot/job-modes').save(db,ctx,11,{mode:'watch',revision:0});await assert.rejects(f.scan(changed.id),/watch/i);await require('../../src/autopilot/job-modes').save(db,ctx,11,{mode:'routine',revision:1});
 const costing=require('../../src/accounting/postgres-costing'),original=costing.receiveInTransaction,before=await f.totals(),moves=Number((await db.query('SELECT count(*) n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
 costing.receiveInTransaction=async()=>{throw Error('Controlled late costing failure');};try{await assert.rejects(f.scan(changed.id),/Controlled late costing failure/);}finally{costing.receiveInTransaction=original;}
 assert.equal(await f.position(f.to.id),1);assert.deepEqual(await f.totals(),before);assert.equal(Number((await db.query('SELECT count(*) n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),moves);assert.equal((await service.get(db,ctx,changed.id)).status,'OPEN');
 assert.equal((await f.scan(changed.id)).automatic,true);assert.equal(await f.position(f.to.id),2);
 const mismatch=await f.open();await db.query("UPDATE locations SET barcode='BIN-CHANGED' WHERE id=$1",[f.to.id]);await assert.rejects(f.scan(mismatch.id),/layout changed/);
});

test('bin corrections enforce staff operation rights, assigned warehouses, reservations and inventory isolation',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f,auth=require('../../src/domain/postgres-auth-service'),locations=require('../../src/domain/postgres-location-service');
 const outsider=await auth.createBusiness(db,{name:'Other',businessName:'Other inventory',email:randomUUID()+'@example.test',password:'Other!'+randomUUID()}),id='bin-staff-'+randomUUID();
 await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,permissions,warehouse_location_ids,created_at) VALUES($1,$2,$3,'Bin staff','staff',$4,$5,now())",[id,ctx.workspaceId,outsider.accountId,JSON.stringify(['VIEW','REQUEST_TRANSFER']),JSON.stringify([f.location.id])]);
 const staff={workspaceId:ctx.workspaceId,actorId:id},made=await service.open(db,staff,f.input()),row=await service.get(db,staff,made.id),proof={productCode:row.source.productBarcode,fromCode:row.source.from.barcode,toCode:row.source.to.barcode,quantity:row.source.quantity,confirmed:'yes',expectedFingerprint:row.fingerprint};
 await assert.rejects(service.scan(db,staff,made.id,proof),e=>e.code==='forbidden');
 await db.query('UPDATE users SET permissions=$2 WHERE id=$1',[id,JSON.stringify(['VIEW','REQUEST_TRANSFER','OPERATE','PICK_TRANSFER','DISPATCH_TRANSFER','RECEIVE_TRANSFER'])]);
 assert.equal((await service.scan(db,staff,made.id,proof)).needsApproval,true);
 await db.query('UPDATE users SET warehouse_location_ids=$2 WHERE id=$1',[id,JSON.stringify([])]);await assert.rejects(f.approve(made.id),/outside your assigned/);assert.equal(await f.position(f.to.id),0);
 await assert.rejects(service.get(db,{workspaceId:outsider.workspaceId,actorId:outsider.userId},made.id),e=>e.status===404);
 const otherSite=await locations.createLocation(db,ctx,{name:'Other site',kind:'warehouse'}),foreignBin=await locations.createLocation(db,ctx,{name:'Other site bin',kind:'bin',parentLocationId:otherSite.id,barcode:'OTHER-SITE-BIN'});
 await assert.rejects(f.open(1,foreignBin),/between physical sites/);
 await require('../../src/transfers/postgres-transfer-service').request(db,ctx,{fromLocationId:f.from.id,toLocationId:f.to.id,idempotencyKey:randomUUID(),lines:[{skuId:f.sku.id,quantity:19}]});
 await assert.rejects(f.open(2),/enough free stock/);assert.equal(await f.position(f.from.id),20);
});

test('phone bin-correction journey exposes plan locks, physical confirmation, owner approval and taught routine work',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f;
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),origin='http://127.0.0.1:'+server.address().port;page.setDefaultTimeout(12000);
 await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 for(const plan of ['starter','growth','pro','enterprise']){
  await f.subscribe(plan);assert.equal((await page.goto(origin+'/warehouse/stock')).status(),200);
  assert.deepEqual(await page.locator('a[href]').evaluateAll(nodes=>nodes.filter(a=>a.getAttribute('data-dest')!==a.getAttribute('href')).map(a=>a.textContent.trim())),[],plan+' warehouse destinations');
  const [guide]=await Promise.all([page.waitForNavigation(),page.getByRole('link',{name:'Staff guide',exact:true}).click()]);assert.equal(guide.status(),200,plan+' owner guide');assert.equal(new URL(page.url()).pathname,'/guide');
  assert.deepEqual(await page.locator('a[href]').evaluateAll(nodes=>nodes.filter(a=>a.getAttribute('data-dest')!==a.getAttribute('href')).map(a=>a.textContent.trim())),[],plan+' guide destinations');
  await Promise.all([page.waitForNavigation(),page.getByRole('link',{name:'Back to warehouse stock',exact:true}).click()]);
  const destination=['starter','growth'].includes(plan)?'/settings/billing':'/warehouse/bin-corrections',label=['starter','growth'].includes(plan)?'Upgrade':'Prepare or confirm a stock bin correction';
  const [response]=await Promise.all([page.waitForNavigation(),page.getByRole('link',{name:label,exact:true}).click()]);assert.equal(response.status(),200,plan+' warehouse action');assert.equal(new URL(page.url()).pathname,destination);
 }
 await f.subscribe('starter');await page.goto(origin+'/warehouse/stock');assert.match(await page.locator('main').innerText(),/Scanned bin corrections need Pro/);await page.goto(origin+'/warehouse/bin-corrections');assert.equal(await page.getByRole('button',{name:'Prepare bin correction',exact:true}).count(),0);assert.match(await page.locator('main').innerText(),/Pro/);
 await f.subscribe('pro');await page.reload();await page.getByLabel('Product scan code',{exact:true}).fill(f.sku.code);await page.getByLabel('Source bin scan code',{exact:true}).fill(f.from.barcode);await page.getByLabel('Correct destination bin scan code').fill(f.to.barcode);await page.getByLabel('Whole units to move').fill('1');await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Prepare bin correction',exact:true}).click()]);
 const id=new URL(page.url()).pathname.split('/').at(-1);assert.match(await page.locator('main').innerText(),/Prepared — units reserved/);assert.equal(await f.position(f.to.id),0);
 await page.getByLabel('Confirm product code').fill(f.sku.code);await page.getByLabel('Confirm source bin code').fill(f.from.barcode);await page.getByLabel('Confirm destination bin code').fill(f.to.barcode);await page.getByLabel('Actual whole units moved').fill('1');await page.getByLabel('I physically moved these units from the scanned source bin to the scanned destination bin.').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record physical move',exact:true}).click()]);assert.match(await page.locator('main').innerText(),/waiting for owner approval/);
 await page.getByLabel('I approve this exact physically confirmed correction and its recorded stock value.').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve scanned bin correction',exact:true}).click()]);assert.match(await page.locator('main').innerText(),/Completed — stock and value moved once/);
 await page.getByLabel('Maximum whole units per matching correction').fill('1');await page.getByLabel('I authorize this exact product, source bin and destination bin within the maximum above.').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Teach this bin correction',exact:true}).click()]);
 await page.getByLabel('Maximum whole units per routine correction').fill('2');await page.getByLabel('I authorize routine completion of physically confirmed bin moves within this quantity limit.').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Enable routine bin corrections',exact:true}).click()]);
 const next=await f.open();assert.equal((await f.scan(next.id)).automatic,true);const pending=await f.open(3);assert.equal((await f.scan(pending.id)).needsApproval,true);
 await page.goto(origin+'/transfers/'+(await service.get(db,ctx,pending.id)).transfer_id);assert.equal(await page.getByRole('button',{name:'Approve this move',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Cancel transfer',exact:true}).count(),0);await page.getByRole('link',{name:'Review the bin correction',exact:true}).click();
 await f.subscribe('growth');await page.reload();
 assert.equal(await page.getByRole('button',{name:'Record physical move',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Teach this bin correction',exact:true}).count(),0);
 await page.getByLabel('I approve only this existing physical move and its recorded stock value. No new automation is authorized.').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Finish existing move manually',exact:true}).click()]);assert.equal((await service.get(db,ctx,pending.id)).manual_recovery,true);
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Stop routine bin corrections',exact:true}).click()]);assert.equal((await db.query('SELECT enabled FROM stockchief_runtime.agent_bin_correction_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].enabled,false);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.goto(origin+'/warehouse/bin-corrections/'+id);await page.getByLabel('I confirm removing this learned limit. The routine settings still apply on Custom.').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Remove learned bin correction rule',exact:true}).click()]);
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_bin_correction_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
});

test('the approved downgrade exception only settles physical moves recorded on Pro or Custom, never new work or authority',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f,before=await f.totals(),beforeLedger=await f.ledger();
 await db.query("INSERT INTO stockchief_runtime.agent_draft_rules(workspace_id,action_type,scope_key,scope_label,currency,maximum_minor,authorized_by) SELECT $1,'sales_order.repeat','retained-pro-rule-'||i,'Existing bounded routine','USD',100,$2 FROM generate_series(1,500)i",[ctx.workspaceId,ctx.actorId]);
 for(const plan of ['starter','growth']){
  await f.subscribe('pro');const physical=await f.open(),unmoved=await f.open();assert.equal((await f.scan(physical.id)).needsApproval,true);const row=await service.get(db,ctx,physical.id);assert.equal(row.scanned_plan,'pro');
  await f.subscribe(plan);assert.match(await require('../../src/commercial/agent-rule-quota').restriction(db,{accountId:f.owner.accountId,plan}),/Automatic work is paused/);await assert.rejects(f.open(),e=>e.code==='entitlement_required');await assert.rejects(f.approve(physical.id),e=>e.code==='entitlement_required');
  await assert.rejects(service.configure(db,ctx,{maximumUnits:1,confirmed:'yes',revision:0}),e=>e.code==='entitlement_required');
  await assert.rejects(service.approve(db,ctx,unmoved.id,{confirmed:'yes',expectedFingerprint:(await service.get(db,ctx,unmoved.id)).fingerprint,manualRecovery:'yes'}),/physical scan evidence/);
  await assert.rejects(service.approve(db,ctx,physical.id,{expectedFingerprint:row.fingerprint,manualRecovery:'yes'}),/Approve the exact/);
  const made=await service.approve(db,ctx,physical.id,{confirmed:'yes',expectedFingerprint:row.fingerprint,manualRecovery:'yes'});assert.equal(made.manualRecovery,true);assert.equal(made.automatic,false);
  assert.equal((await service.get(db,ctx,physical.id)).status,'COMPLETED');await service.cancel(db,ctx,unmoved.id,{confirmed:'yes'});
  await f.subscribe('pro');await assert.rejects(service.teach(db,ctx,physical.id,{confirmed:'yes',maximumUnits:1,revision:0}),/Manual completion after downgrade cannot teach/);
 }
 assert.deepEqual(await f.totals(),before);assert.deepEqual(await f.ledger(),beforeLedger);const roi=await require('../../src/autopilot/time-saved').report(db,ctx);assert.equal(roi.rows.find(r=>r.key==='bin-correction').count,0,'Manual lower-plan settlement is not counted as a newly available AI duty');
});

test('a pending scan rechecks a concurrently committed downgrade before storing any Pro physical confirmation',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f,prepared=await f.open();let attempt;
 await db.transaction(async c=>{
  await c.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR UPDATE',[f.owner.accountId]);
  attempt=f.scan(prepared.id).then(result=>({result}),error=>({error}));await new Promise(r=>setTimeout(r,100));
  await c.query("UPDATE account_subscriptions SET plan_id='starter',plan_version_id=(SELECT id FROM commercial_plan_versions WHERE plan_id='starter' AND status='ACTIVE') WHERE account_id=$1",[f.owner.accountId]);
 });
 const outcome=await attempt;assert.equal(outcome.error?.code,'entitlement_required');const row=await service.get(db,ctx,prepared.id);assert.equal(row.status,'OPEN');assert.equal(row.scan_proof,null);assert.equal(row.scanned_plan,null);assert.equal(await f.position(f.to.id),0);
});

test('pending bin work reserves stock globally and older transfer writes cannot release or dispatch its units',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f,transfers=require('../../src/transfers/postgres-transfer-service'),availability=require('../../src/domain/postgres-stock-availability');
 const prepared=await f.open(3),row=await service.get(db,ctx,prepared.id);
 assert.equal((await availability.read(db,ctx.workspaceId,f.sku.id,f.from.id)).available,17);
 await assert.rejects(transfers.request(db,ctx,{fromLocationId:f.from.id,toLocationId:f.other.id,idempotencyKey:randomUUID(),lines:[{skuId:f.sku.id,quantity:18}]}),/17 available/);
 await assert.rejects(transfers.cancel(db,ctx,row.transfer_id,{idempotencyKey:randomUUID(),reason:'Bypass original correction'}),/original scanned bin correction/);
 await assert.rejects(db.query("UPDATE inventory_transfers SET status='CANCELLED' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,row.transfer_id]),e=>e.code==='23514');
 await assert.rejects(service.cancel(db,ctx,row.id,{}),/not been physically moved/);
 await service.cancel(db,ctx,row.id,{confirmed:'yes'});assert.equal((await availability.read(db,ctx.workspaceId,f.sku.id,f.from.id)).available,20);assert.equal(await f.position(f.from.id),20);
 const physical=await f.open(2);assert.equal((await f.scan(physical.id)).needsApproval,true);const held=await service.get(db,ctx,physical.id);
 await assert.rejects(service.cancel(db,ctx,held.id,{confirmed:'yes'}),/physically confirmed correction/);
 await assert.rejects(db.query("UPDATE inventory_transfers SET status='SHIPPED' WHERE id=$1",[held.transfer_id]),e=>e.code==='23514');
 await assert.rejects(db.query("UPDATE inventory_transfers SET status='CANCELLED' WHERE id=$1",[held.transfer_id]),e=>e.code==='23514');
 assert.equal((await availability.read(db,ctx.workspaceId,f.sku.id,f.from.id)).available,18);
 await f.approve(held.id);assert.equal((await transfers.verify(db,ctx.workspaceId,held.transfer_id)).ok,true);assert.equal((await transfers.get(db,ctx.workspaceId,held.transfer_id)).status,'RECEIVED');assert.equal((await availability.read(db,ctx.workspaceId,f.sku.id,f.from.id)).available,18);
 assert.equal((await db.query('SELECT count(*)::int n FROM inventory_transfer_pegs WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0,'A bin correction must not silently create a separate customer reservation');
});

test('actual account removal can clean up an inventory with an unresolved physical bin correction',{timeout:240000},async t=>{
 const prior=process.env.STOCKCHIEF_RUNTIME_ENV;process.env.STOCKCHIEF_RUNTIME_ENV='staging';t.after(()=>{if(prior===undefined)delete process.env.STOCKCHIEF_RUNTIME_ENV;else process.env.STOCKCHIEF_RUNTIME_ENV=prior;});
 const f=await fixture(t),{db,ctx,service}=f,physical=await f.open();await f.scan(physical.id);assert.equal((await service.get(db,ctx,physical.id)).status,'SCANNED');
 const password='Admin!'+randomUUID(),admin=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Fixture admin',businessName:'Preserved inventory',email:randomUUID()+'@example.test',password});
 await db.query("INSERT INTO developer_account_administrators(account_id,granted_by) VALUES($1,'isolated bin removal check')",[admin.accountId]);
 const removal=require('../../src/domain/postgres-developer-accounts'),review=await removal.review(db,admin.accountId,f.email);assert.equal(review.canDelete,true,review.blockers.join('; '));
 const queued=await removal.queue(db,admin.accountId,{email:f.email,confirmEmail:f.email,confirmed:'yes',password,reviewHash:review.reviewHash}),result=await removal.execute(db,queued.requestId);assert.equal(result.signInAccountRemoved,true);
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_bin_corrections WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM accounts WHERE id=$1',[admin.accountId])).rows[0].n,1);
});
