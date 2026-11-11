'use strict';

process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const sources=require('../../src/imports/physical-count-sources');
const queue=require('../../src/operations/postgres-job-queue');
const handlers=require('../../src/operations/postgres-runtime-handlers').create();
const receipt=require('../../src/accounting/postgres-stock-receipt');
const catalog=require('../../src/domain/postgres-catalog-service');
const autopilot=require('../../src/autopilot/postgres-service');
const rules=require('../../src/autopilot/count-rules');
const modes=require('../../src/autopilot/job-modes');
const exact=require('../../src/domain/exact-quantity');

const headings=['SKU','Location','Quantity','Unit','Lot','Serial','Actual weight','Weight unit','Unit cost','Currency'];
const csv=rows=>Buffer.from([headings,...rows].map(row=>row.join(',')).join('\n'));

// Job 6 (Pro and Custom alone): small count differences post on their own under the owner's
// limit. Lots count like any other stock; a serial is one identified unit, so a person
// confirms it. Over the limit, in shadow, under Watch or Ask me first, or on Pro without a
// taught count routine (job 5 is trained there), the count waits for a person.
test('exact count sheets post small differences on their own under the owner limit and otherwise wait for a person',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:1}),{db,ctx,subscribe,location}=f;
  const make=async(code,options)=>(await catalog.createItem(db,ctx,{name:code,baseCode:code,...options})).skuIds[0];
  const lot=await make('SMALLLOT',{trackingMode:'lot'}),plain=await make('SMALLPLAIN',{trackingMode:'quantity'}),serial=await make('SMALLSERIAL',{trackingMode:'serial'});
  const receive=(skuId,quantity,details={})=>receipt.receive(db,ctx,{skuId,locationId:location.id,quantity,unitCost:'2',idempotencyKey:randomUUID(),...details});
  await receive(lot,6,{lotCode:'L-1'});await receive(plain,20);await receive(serial,2,{serials:['SN-1','SN-2']});
  const work=async()=>{const result=await queue.processOne(db,handlers,{owner:'small-difference-test',kinds:[sources.kind],leaseMs:120000});
    assert.equal(result?.status,'COMPLETED',JSON.stringify(result?.lastError));return result.result;};
  const idle=async()=>assert.equal(await queue.processOne(db,handlers,{owner:'small-difference-test',kinds:[sources.kind],leaseMs:120000}),null);
  const onHand=async skuId=>exact.canonical((await db.query('SELECT coalesce(sum(on_hand),0) q FROM balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,skuId])).rows[0].q);
  const movements=async()=>Number((await db.query('SELECT count(*) n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
  const audits=async()=>Number((await db.query("SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action='Count sheet posted under the count limit'",[ctx.workspaceId])).rows[0].n);
  const row=(code,quantity,{lotCode='',serialCode=''}={})=>[code,location.name,quantity,'unit',lotCode,serialCode,'','','',''];
  const counts=(lotQ,plainQ)=>[row('SMALLLOT',lotQ,{lotCode:'L-1'}),row('SMALLPLAIN',plainQ)];
  const input={locationIds:[location.id]};
  const view=id=>sources.page(db,ctx,{id});
  // Read a sheet and expect it to wait for a person, changing nothing.
  async function waits(enqueued,note=null){
    const before=await movements();
    await work();
    const page=await view(enqueued.id);
    assert.equal(page.source.status,'REVIEW');
    if(note)assert.match(page.source.reading_note,note);else assert.equal(page.source.reading_note,null);
    assert.equal(await movements(),before);
    await idle();
    return page;
  }

  await subscribe('growth');
  await assert.rejects(rules.configure(db,ctx,{mode:'automatic',limit:'5.00'}),e=>e.code==='entitlement_required');
  await assert.rejects(sources.enqueue(db,ctx,{...input,filename:'Growth count.csv',buffer:csv(counts('5','19'))}),e=>e.code==='entitlement_required');

  await subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '25 days')::text WHERE id=$1",[f.owner.accountId]);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await rules.configure(db,ctx,{mode:'automatic',limit:'5.00'});

  // On Pro a sheet uploaded by hand is approved by the owner; it then teaches the routine.
  const manual=await sources.enqueue(db,ctx,{...input,filename:'Monday count.csv',buffer:csv(counts('5','19'))});
  let page=await waits(manual);
  await sources.approve(db,ctx,manual.id,{revision:page.source.revision,evidence:page.source.evidence_hash,confirmed:'yes'});
  assert.equal((await work()).posted,true);
  assert.deepEqual([await onHand(lot),await onHand(plain)],['5','19']);
  const routine=(await sources.configure(db,ctx,{...input,label:'Weekly count sheet',format:'sheet',maximumRows:50,confirmed:'yes',exampleId:manual.id})).id;

  // Small differences through the taught routine post on their own, once.
  const small=await sources.enqueue(db,ctx,{ruleId:routine,filename:'Tuesday count.csv',buffer:csv(counts('4','18'))});
  assert.equal((await work()).posting,true);
  assert.equal((await work()).posted,true);
  await idle();
  page=await view(small.id);
  assert.equal(page.source.status,'POSTED');
  assert.match(page.source.reading_note,/^Posted on its own: the differences come to \$4\.00, within your \$5\.00 count limit\.$/);
  assert.deepEqual([await onHand(lot),await onHand(plain)],['4','18']);
  assert.equal(await audits(),1);
  const shown=(await f.browser.get(sources.path+'/'+small.id).expect(200)).text;
  assert.match(shown,/Posted on its own: the differences come to \$4\.00, within your \$5\.00 count limit\./);
  assert.match(shown,/Verified/);
  assert.equal((await sources.enqueue(db,ctx,{ruleId:routine,filename:'Tuesday again.csv',buffer:csv(counts('4','18'))})).id,small.id,'the same original replays');
  await idle();
  assert.deepEqual([await onHand(lot),await onHand(plain)],['4','18']);

  // Over the limit, a person approves; so does any serial added or removed, however cheap.
  await waits(await sources.enqueue(db,ctx,{ruleId:routine,filename:'Wednesday count.csv',buffer:csv(counts('4','12'))}),
    /^The differences come to \$12\.00, over your \$5\.00 count limit\. Check the counts and approve them yourself\.$/);
  await waits(await sources.enqueue(db,ctx,{ruleId:routine,filename:'Serial count.csv',buffer:csv([...counts('4','18'),row('SMALLSERIAL','0',{serialCode:'SN-2'})])}));

  // Ask me first on job 6 leaves the small count for a person.
  await modes.save(db,ctx,6,{mode:'ask',revision:0});
  await waits(await sources.enqueue(db,ctx,{ruleId:routine,filename:'Ask first.csv',buffer:csv(counts('3','18'))}));
  await modes.save(db,ctx,6,{mode:'inherit',revision:1});

  // A sheet uploaded by hand on Pro still waits: job 5 needs its taught routine there.
  await waits(await sources.enqueue(db,ctx,{...input,filename:'By hand on Pro.csv',buffer:csv(counts('4','16'))}));

  // Custom needs no teaching, but during the first 14 days (shadow mode) it only watches.
  await subscribe('enterprise');
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  await waits(await sources.enqueue(db,ctx,{...input,filename:'Shadow.csv',buffer:csv(counts('4','17'))}));
  await db.query("UPDATE accounts SET created_at=(now()-interval '25 days')::text WHERE id=$1",[f.owner.accountId]);
  const custom=await sources.enqueue(db,ctx,{...input,filename:'Custom count.csv',buffer:csv(counts('3','17'))});
  assert.equal((await work()).posting,true);
  assert.equal((await work()).posted,true);
  assert.equal((await view(custom.id)).source.status,'POSTED');
  assert.deepEqual([await onHand(lot),await onHand(plain)],['3','17']);
  assert.equal(await audits(),2);
  assert.equal(await onHand(serial),'2','no serial ever left without a person');
});

// Job 6 for staff phone counts (job 7): once the counter finishes, small differences post
// through the owner's own review and approval. Lots seen on the phone that differ from the
// records, differences over the limit, and plans without job 6 leave the count for the owner.
test('finished phone counts post small plain differences on their own; lot changes and large differences go to the owner',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,subscribe}=f;
  const tasks=require('../../src/operations/agent-count-tasks'),campaigns=require('../../src/operations/postgres-count-campaigns'),rights=require('../../src/actions/permissions');
  const account=await require('../../src/domain/postgres-auth-service').createBusiness(db,{email:randomUUID()+'@example.test',password:f.password,name:'Counter',businessName:'Separate counter inventory'});
  const counter={workspaceId:ctx.workspaceId,actorId:randomUUID()};
  await db.query(`INSERT INTO users(id,name,workspace_id,account_id,role,permissions,warehouse_location_ids,created_at)
    VALUES($1,'Warehouse counter',$2,$3,'staff',$4,$5::jsonb,now()::text)`,[counter.actorId,ctx.workspaceId,account.accountId,rights.encodeGrant([rights.VIEW,rights.COUNT_STOCK]),JSON.stringify([f.location.id])]);
  const plain=f.item.skuIds[0],lot=(await catalog.createItem(db,ctx,{name:'PHONELOT',baseCode:'PHONELOT',trackingMode:'lot'})).skuIds[0];
  await receipt.receive(db,ctx,{skuId:lot,locationId:f.location.id,quantity:6,unitCost:'2',lotCode:'L-1',idempotencyKey:randomUUID()});
  const onHand=async skuId=>exact.canonical((await db.query('SELECT coalesce(sum(on_hand),0) q FROM balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,skuId])).rows[0].q);
  const status=async id=>(await db.query('SELECT status FROM warehouse_count_campaigns WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0].status;
  const audits=async()=>Number((await db.query("SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action='Phone count posted under the count limit'",[ctx.workspaceId])).rows[0].n);
  const apply=async id=>{const job={workspaceId:ctx.workspaceId,payload:{actorId:ctx.actorId,campaignId:id}};
    for(let step=0;step<5;step++)if((await campaigns.run(job,db)).status==='COMPLETED')return;assert.fail('The approved count did not finish.');};
  const count=async(plainQ,lotQ)=>{
    const id=await tasks.assign(db,ctx,{locationId:f.location.id,counterId:counter.actorId,stockScope:'all',requestKey:randomUUID()});
    await tasks.record(db,counter,id,{locationId:f.location.id,skuId:plain,quantity:plainQ});
    await tasks.record(db,counter,id,{locationId:f.location.id,skuId:lot,entries:[{code:'L-1',quantity:lotQ}]});
    return id;
  };

  await subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '25 days')::text WHERE id=$1",[f.owner.accountId]);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await rules.configure(db,ctx,{mode:'automatic',limit:'5.00'});

  const small=await count('18','6');
  assert.equal(await status(small),'APPLYING','the counter’s last entry approved the small count');
  assert.equal(await onHand(plain),'20','nothing posts before the apply job runs');
  await apply(small);
  assert.equal(await onHand(plain),'18');
  assert.equal(await audits(),1);

  const large=await count('10','6');
  assert.equal(await status(large),'DRAFT');
  assert.equal((await tasks.inbox(db,ctx.workspaceId,ctx.actorId)).some(n=>n.href?.includes(large)||n.sourceId?.includes?.(large)||n.actionLabel==='Review counted quantities'),true);
  const lotChanged=await count('18','5');
  assert.equal(await status(lotChanged),'DRAFT','a lot that differs on the phone needs the owner');

  await subscribe('growth');
  assert.equal(await status(await count('17','6')),'DRAFT','Growth does not post count differences on its own');
  assert.deepEqual([await onHand(plain),await onHand(lot)],['18','6']);
  assert.equal(await audits(),1);
});
