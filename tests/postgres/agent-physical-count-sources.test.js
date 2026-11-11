'use strict';

process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const sources=require('../../src/imports/physical-count-sources');
const queue=require('../../src/operations/postgres-job-queue');
const handlers=require('../../src/operations/postgres-runtime-handlers').create();
const stock=require('../../src/accounting/postgres-stock-receipt');
const catalog=require('../../src/domain/postgres-catalog-service');
const locationService=require('../../src/domain/postgres-location-service');
const autopilot=require('../../src/autopilot/postgres-service');
const modes=require('../../src/autopilot/job-modes');
const exact=require('../../src/domain/exact-quantity');

const headings=['SKU','Location','Quantity','Unit','Lot','Serial','Actual weight','Weight unit','Unit cost','Currency'];
const csv=rows=>Buffer.from(rows.map(row=>row.join(',')).join('\n'));
function workbook(tabs){
  const xlsx=require('xlsx'),book=xlsx.utils.book_new();
  for(const [name,grid] of tabs)xlsx.utils.book_append_sheet(book,xlsx.utils.aoa_to_sheet(grid),name);
  return xlsx.write(book,{type:'buffer',bookType:'xlsx'});
}

test('physical count originals use native tracked and measured adjustments after separate approval',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:1}),{db,ctx,subscribe,browser,location}=f;
  const {workspaceId}=ctx,annex=await locationService.createLocation(db,ctx,{name:'Count annex',kind:'warehouse'});
  const input={locationIds:[location.id,annex.id]},sku=async(code,options)=>(await catalog.createItem(db,ctx,{name:code,baseCode:code,...options})).skuIds[0];
  const lot=await sku('SOURCELOT',{trackingMode:'lot',secondaryUnitLabel:'kg',secondaryPrecision:3});
  const serial=await sku('SOURCESERIAL',{trackingMode:'serial',secondaryUnitLabel:'kg',secondaryPrecision:3});
  const bulk=await sku('SOURCEVOLUME',{trackingMode:'quantity',unitLabel:'litre',quantityPrecision:2,quantityIncrement:'0.25'});
  const weighed=await sku('SOURCEWEIGH',{trackingMode:'quantity',secondaryUnitLabel:'kg',secondaryPrecision:3});
  const receive=(skuId,loc,quantity,details={})=>stock.receive(db,ctx,{skuId,locationId:loc.id,quantity,unitCost:'2',idempotencyKey:randomUUID(),...details});
  const lotA=await receive(lot,location,5,{lotCode:'A-0001',secondaryQuantity:'10.25'});
  const lotB=await receive(lot,location,2,{lotCode:'B-0002',secondaryQuantity:'3.5'});
  const serials=await receive(serial,location,2,{serials:['EXACT-0001','EXACT-0002'],secondaryQuantity:'3.25',serialWeights:{'EXACT-0001':'1.125','EXACT-0002':'2.125'}});
  await receive(bulk,annex,'9.25');
  await receive(weighed,annex,3,{secondaryQuantity:'4.75'});
  const bodyRows=[
    ['SOURCELOT',location.name,'4','unit','A-0001','','8.125','kg','',''],
    ['SOURCELOT',location.name,'3','unit','B-0002','','5.5','kg','2.00','USD'],
    ['SOURCESERIAL',location.name,'0','unit','','WRONG-0001','0','kg','',''],
    ['SOURCESERIAL',location.name,'1','unit','','EXACT-0002','2.125','kg','',''],
    ['SOURCEVOLUME',annex.name,'8.75','litre','','','','','',''],
    ['SOURCEWEIGH',annex.name,'2','unit','','','3.125','kg','',''],
  ];
  const original=workbook([['Dispatch counts',[headings,...bodyRows.slice(0,4)]],['Annex counts',[headings,...bodyRows.slice(4)]]]);
  const route=sources.path,job=()=>queue.processOne(db,handlers,{owner:'physical-source-test',kinds:[sources.kind],leaseMs:120000});
  const work=async()=>{const result=await job();assert.equal(result?.status,'COMPLETED',JSON.stringify(result?.lastError));return result.result;};
  const effect=async()=> (await db.query(`SELECT
    (SELECT count(*) FROM movements WHERE workspace_id=$1)::int movements,
    (SELECT count(*) FROM accounting_journal_entries WHERE workspace_id=$1)::int journals`,[workspaceId])).rows[0];
  const ruleInput={...input,label:'Count workbooks for two sites',format:'sheet',maximumRows:100,confirmed:'yes'};
  const before=await effect();
  for(const tier of ['starter','growth']){
    await subscribe(tier);
    const locked=await browser.get(route).expect(200);
    assert.match(locked.text,/data-agent-plan-locked/);
    assert.match(locked.text,/Pro/);
    await browser.get(route).set('Accept','application/json').expect(402);
    await assert.rejects(sources.enqueue(db,ctx,{...input,filename:'Physical count.xlsx',buffer:original}),e=>e.code==='entitlement_required');
  }
  await subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '25 days')::text WHERE id=$1",[f.owner.accountId]);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await assert.rejects(sources.configure(db,ctx,ruleInput),e=>e.code==='entitlement_required');
  const form=await browser.get(route).expect(200);
  const uploaded=await browser.post(route).field('_csrf',f.csrf(form.text)).field('locationIds',location.id).field('locationIds',annex.id)
    .attach('file',original,'Physical count.xlsx').expect(303);
  const id=uploaded.headers.location.split('/').at(-1),href=route+'/'+id;
  assert.equal((await work()).positions,6);
  let view=await sources.page(db,ctx,{id});
  assert.equal(view.totals.held,1);
  assert.match(view.rows[2].issue,/existing exact serial/);
  const wrong=view.rows[2].raw;
  const approval=()=>({revision:view.source.revision,evidence:view.source.evidence_hash,confirmed:'yes'});
  await assert.rejects(sources.approve(db,ctx,id,approval()),/Resolve all uncertain/);
  assert.deepEqual(await effect(),before);
  const revise=async(number,fields={})=>{
    const row=view.rows.find(r=>r.number===number);
    await sources.revise(db,ctx,id,{...row.observed,...fields,number,revision:view.source.revision,confirmed:'yes'});
    view=await sources.page(db,ctx,{id});
  };
  await revise(3,{serial:'EXACT-0001'});
  assert.deepEqual(view.rows[2].raw,wrong);
  assert.deepEqual((await sources.load(db,ctx,id,{original:true})).content,original);
  assert.equal(view.totals.held,0);
  assert.deepEqual(view.rows.map(r=>r.preview.costDelta),[-425,400,-225,0,-100,-325]);
  let review=await browser.get(href).expect(200);
  assert.match(review.text,/Approve the physical adjustments/);
  await browser.post(href+'/approve').type('form').send({_csrf:f.csrf(review.text),...approval()}).expect(303);
  await subscribe('growth');
  assert.match((await work()).held,/Pro/);
  assert.deepEqual(await effect(),before);
  await subscribe('pro');
  await sources.revise(db,ctx,id,{revision:view.source.revision});
  view=await sources.page(db,ctx,{id});
  const accepted=await sources.approve(db,ctx,id,approval());
  assert.equal((await sources.approve(db,ctx,id,approval())).replayed,true);
  await receive(lot,location,1,{lotId:lotA.lotId,secondaryQuantity:'2.125'});
  assert.match((await work()).held,/changed after review/);
  assert.equal((await effect()).movements,before.movements+1);
  await sources.revise(db,ctx,id,{revision:view.source.revision});
  view=await sources.page(db,ctx,{id});
  assert.equal(view.totals.held,2);
  await assert.rejects(sources.approve(db,ctx,id,approval()),/Resolve all uncertain/);
  await revise(1,{quantity:'5',secondary:'10.25'});
  await revise(2);
  assert.equal(view.totals.held,0);
  await sources.approve(db,ctx,id,approval());
  assert.equal((await work()).posted,true);
  assert.equal((await sources.approve(db,ctx,id,approval())).replayed,true);
  assert.equal((await sources.enqueue(db,ctx,{...input,filename:'Renamed copy.xlsx',buffer:original})).id,id);
  assert.equal(await job(),null);
  view=await sources.page(db,ctx,{id});
  assert.equal(view.totals.done,6);
  assert.equal(view.source.status,'POSTED');
  assert.equal(view.rows.filter(r=>r.effect.movementId).length,5);
  const counted=await db.query(`SELECT l.id,lb.quantity,lb.secondary_quantity FROM lots l JOIN lot_balances lb ON lb.lot_id=l.id AND lb.workspace_id=l.workspace_id
    WHERE l.workspace_id=$1 AND l.id=ANY($2::text[]) AND lb.location_id=$3 ORDER BY l.code`,[workspaceId,[lotA.lotId,lotB.lotId],location.id]);
  assert.deepEqual(counted.rows.map(r=>[exact.canonical(r.quantity),exact.canonical(r.secondary_quantity)]),[['5','10.25'],['3','5.5']]);
  const exactSerial=(await db.query('SELECT serial,status,location_id FROM serial_units WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY serial',
    [workspaceId,serials.serialUnitIds])).rows;
  assert.deepEqual(exactSerial.map(r=>[r.serial,r.status,r.location_id]),[['EXACT-0001','issued',null],['EXACT-0002','in_stock',location.id]]);
  const positions=(await db.query('SELECT sku_id,on_hand,secondary_on_hand FROM balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[])',
    [workspaceId,[bulk,weighed]])).rows;
  assert.deepEqual(Object.fromEntries(positions.map(r=>[r.sku_id,[exact.canonical(r.on_hand),r.secondary_on_hand==null?null:exact.canonical(r.secondary_on_hand)]])),
    {[bulk]:['8.75',null],[weighed]:['2','3.125']});
  const journal=(await db.query(`SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1 AND source_type='physical_count_source' AND source_record_id=$2`,
    [workspaceId,id])).rows[0];
  assert.equal(journal.n,5);
  assert.equal((await queue.get(db,accepted.jobId,workspaceId)).result.held.includes('changed'),true);
  assert.match((await browser.get('/autopilot/reviews/count-sources').expect(200)).text,/Verified/);

  const trained=(await sources.configure(db,ctx,{...ruleInput,exampleId:id})).id;
  const changedRows=bodyRows.map((row,index)=>index===2?row.map((v,i)=>i===5?'EXACT-0001':v):row);
  changedRows[0]=['SOURCELOT',location.name,'5','unit','A-0001','','10.25','kg','',''];
  const routineFile=workbook([['Dispatch counts',[headings,...changedRows.slice(0,4)]],['Annex counts',[headings,...changedRows.slice(4)]]]);
  const trainedRead=await sources.enqueue(db,ctx,{ruleId:trained,filename:'Next observed count.xlsx',buffer:routineFile});
  const beforeRoutine=await effect();
  assert.equal((await work()).positions,6);
  assert.equal((await sources.page(db,ctx,{id:trainedRead.id})).source.status,'REVIEW');
  assert.deepEqual(await effect(),beforeRoutine);
  const different=await sources.enqueue(db,ctx,{ruleId:trained,filename:'Changed layout.csv',buffer:csv([headings,changedRows[0]])});
  assert.match((await work()).held,/taught layout/);
  assert.equal((await sources.load(db,ctx,different.id,{original:true})).status,'HELD');

  await subscribe('enterprise');
  const photoRule=(await sources.configure(db,ctx,{locationIds:[annex.id],format:'visual',label:'Count tags at annex',maximumRows:10,confirmed:'yes'})).id;
  const {createCanvas}=require('@napi-rs/canvas'),canvas=createCanvas(1420,390),drawing=canvas.getContext('2d');
  drawing.fillStyle='#fff';drawing.fillRect(0,0,1420,390);drawing.fillStyle='#12334d';drawing.fillRect(0,25,1420,80);
  drawing.fillStyle='#fff';drawing.font='37px Arial';
  for(const [x,text] of [[45,'Product'],[430,'SKU'],[850,'Quantity'],[1120,'Unit']])drawing.fillText(text,x,74);
  drawing.fillStyle='#172b3d';
  for(const [x,text] of [[45,'Measured volume'],[430,'SOURCEVOLUME'],[850,'7.75'],[1120,'litre']])drawing.fillText(text,x,165);
  const png=canvas.toBuffer('image/png'),image=await sources.enqueue(db,ctx,{ruleId:photoRule,filename:'Photographed shelf count tag.png',buffer:png});
  const photoBefore=await effect();
  assert.equal((await work()).positions,1);
  let photographed=await sources.page(db,ctx,{id:image.id});
  assert.equal(photographed.rows[0].raw.cells.some(v=>v.includes('7.75')),true);
  assert.equal(photographed.rows[0].checked,false);
  await assert.rejects(sources.approve(db,ctx,image.id,{revision:photographed.source.revision,evidence:photographed.source.evidence_hash,confirmed:'yes'}),/uncertain/);
  await sources.revise(db,ctx,image.id,{...photographed.rows[0].observed,sku:'SOURCEVOLUME',unit:'litre',quantity:'7.75',number:1,confirmed:'yes',revision:photographed.source.revision});
  photographed=await sources.page(db,ctx,{id:image.id});
  const imageApproval={revision:photographed.source.revision,evidence:photographed.source.evidence_hash,confirmed:'yes'};
  assert.deepEqual(await effect(),photoBefore);
  await modes.save(db,ctx,5,{mode:'watch',revision:0});
  await assert.rejects(sources.approve(db,ctx,image.id,imageApproval),/Watch only/);
  await modes.save(db,ctx,5,{mode:'inherit',revision:1});
  await sources.approve(db,ctx,image.id,imageApproval);
  assert.equal((await work()).posted,true);
  assert.deepEqual((await sources.load(db,ctx,image.id,{original:true})).content,png);
  assert.equal(exact.canonical((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
    [workspaceId,bulk,annex.id])).rows[0].on_hand),'7.75');

  const label=createCanvas(1120,850),paint=label.getContext('2d');
  paint.fillStyle='#203144';paint.fillRect(0,0,1120,850);paint.fillStyle='#fff';paint.fillRect(110,90,900,660);
  paint.fillStyle='#172b3d';paint.font='46px Arial';
  for(const [index,line] of ['SKU: SOURCELOT','COUNT: 3','UNIT: unit','LOT: B-0002','WEIGHT: 5.625','WEIGHT UNIT: kg'].entries())
    paint.fillText(line,190,190+index*95);
  const tag=await sources.enqueue(db,ctx,{locationIds:[location.id],filename:'Shelf label on retained lot.png',buffer:label.toBuffer('image/png')});
  const tagPrepared=await work();
  assert.equal(tagPrepared.positions,1,JSON.stringify(tagPrepared));
  let tagPage=await sources.page(db,ctx,{id:tag.id});
  assert.match(tagPage.rows[0].raw.sheet,/Shelf photo/);
  assert.match(tagPage.rows[0].raw.cells.join(' '),/5\.625/);
  const tagged=tagPage.rows[0],tagBefore=await effect();
  await sources.revise(db,ctx,tag.id,{...tagged.observed,sku:'SOURCELOT',quantity:'3',unit:'unit',lot:'B-0002',secondary:'5.625',secondaryUnit:'kg',
    number:1,confirmed:'yes',revision:tagPage.source.revision});
  tagPage=await sources.page(db,ctx,{id:tag.id});
  assert.match(tagPage.rows[0].issue,/same physical stock and its retained recorded cost/);
  await sources.revise(db,ctx,tag.id,{...tagPage.rows[0].observed,number:1,confirmed:'yes',revision:tagPage.source.revision,
    measureCorrection:'yes',measureReason:'Verified the same three retained pieces on the calibrated scale.'});
  tagPage=await sources.page(db,ctx,{id:tag.id});
  assert.equal(tagPage.rows[0].preview.reweigh,true);
  const approveTag={revision:tagPage.source.revision,evidence:tagPage.source.evidence_hash,confirmed:'yes'};
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const phone=await chrome.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const base='http://127.0.0.1:'+server.address().port;
  await phone.goto(base+'/login');await phone.locator('[name=email]').fill(f.email);await phone.locator('[name=password]').fill(f.password);
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await phone.goto(base+route+'/'+tag.id);
  assert.match(await phone.locator('main').innerText(),/Retain the acquisition cost of the same stock/);
  assert.equal(await phone.locator('body').evaluate(b=>b.scrollWidth<=innerWidth+2),true);
  await phone.getByLabel('I verified the physical counts, identities, measures and value changes.').check();
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Approve the physical adjustments'}).click()]);
  assert.match(await phone.locator('main').innerText(),/Posting approved adjustments/);
  assert.deepEqual(await effect(),tagBefore);
  assert.equal((await work()).posted,true);
  assert.equal((await sources.approve(db,ctx,tag.id,approveTag)).replayed,true);
  const corrected=(await db.query(`SELECT m.quantity_delta,m.secondary_quantity_delta,c.cost_delta_minor,c.balance_cost_minor,c.balance_secondary_quantity
    FROM movements m JOIN accounting_inventory_cost_movements c ON c.workspace_id=m.workspace_id AND c.inventory_movement_id=m.id
    WHERE m.workspace_id=$1 AND m.lot_id=$2 AND c.cost_source_record_id=$3`,[workspaceId,lotB.lotId,tag.id])).rows[0];
  assert.deepEqual([exact.canonical(corrected.quantity_delta),exact.canonical(corrected.secondary_quantity_delta),Number(corrected.cost_delta_minor),
    Number(corrected.balance_cost_minor),exact.canonical(corrected.balance_secondary_quantity)],['0','0.125',0,3150,'15.875']);
  assert.deepEqual(await effect(),{movements:tagBefore.movements+1,journals:tagBefore.journals});

  const sourceWithReview=await sources.enqueue(db,ctx,{...input,filename:'Explicit counts and a note.csv',buffer:csv([
    headings,['SOURCEWEIGH',annex.name,'2','unit','','','','kg','',''],
    ['SOURCESERIAL',location.name,'1','unit','','EXACT-0002','2.25','kg','',''],
    ['Warehouse note',annex.name,'','','','','','','',''],
  ])});
  assert.equal((await work()).positions,3);
  let pending=await sources.page(db,ctx,{id:sourceWithReview.id});
  assert.match(pending.rows[0].issue,/actual kg/);
  assert.match(pending.rows[1].issue,/same physical stock/);
  assert.match(pending.rows[2].issue,/exact active SKU/);
  const correct=async(number,patch)=>{
    const row=pending.rows.find(r=>r.number===number);
    await sources.revise(db,ctx,sourceWithReview.id,{...row.observed,...patch,number,confirmed:'yes',revision:pending.source.revision});
    pending=await sources.page(db,ctx,{id:sourceWithReview.id});
  };
  await correct(1,{secondary:'3.125'});
  await correct(2,{measureCorrection:'yes',measureReason:'Reweighed the same physical serial on the scale.'});
  await correct(3,{exclude:'yes',excludeReason:'The original contains a warehouse note without a physical quantity.'});
  const beforeFinal=await effect();
  await sources.approve(db,ctx,sourceWithReview.id,{confirmed:'yes',revision:pending.source.revision,evidence:pending.source.evidence_hash});
  assert.equal((await work()).posted,true);
  pending=await sources.page(db,ctx,{id:sourceWithReview.id});
  assert.equal(pending.rows[0].effect.unchanged,true);
  assert.equal(pending.rows[2].effect.excluded,true);
  assert.deepEqual(await effect(),{movements:beforeFinal.movements+1,journals:beforeFinal.journals});
  assert.equal(exact.canonical((await db.query("SELECT secondary_quantity FROM serial_units WHERE workspace_id=$1 AND serial='EXACT-0002'",[workspaceId])).rows[0].secondary_quantity),'2.25');
});
