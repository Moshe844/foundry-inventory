'use strict';

process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const request=require('supertest');
const sop=require('../../src/documents/agent-sop-sources');
const {pricedUsage}=require('../helpers/postgres-model-fixture');

// Job 212: StockChief reads a procedure and follows it. Each clause that maps
// exactly onto a rule kind becomes a rule the owner confirms; it keeps its
// link to the clause, counts against the plan's rules and then applies on
// its own. Everything else is kept for people, with the reason. Pro and
// Custom only.
test('procedure clauses become confirmed standing rules on Pro and Custom, and the rest is kept for people',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx}=f,ws=ctx.workspaceId;
  const age=interval=>db.query(`UPDATE accounts SET created_at=(now()-interval '${interval}')::text WHERE id=$1`,[f.owner.accountId]);
  await age('30 days');
  await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason)
    VALUES($1,$2,'ai_work_credits',100000,'Synthetic allowance'),($3,$2,'agent_documents',100,'Synthetic allowance')`,[randomUUID(),f.owner.accountId,randomUUID()]);
  const sku=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
  const second=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Seal tape',baseCode:'TAPE-'+randomUUID().slice(0,6),trackingMode:'quantity'});
  const tape=(await db.query('SELECT code FROM skus WHERE id=$1',[second.skuIds[0]])).rows[0].code;
  const clauses={
    alert:`Show a Needs You warning when ${sku} has 7 units or fewer on hand at Dispatch.`,
    reorder:`Keep ${sku} at Dispatch with a reorder point of 5 and a target stock of 12.`,
    split:'Always split purchase orders over $10,000 into two deliveries.',
    missing:'Warn me in Needs You when NOSUCH-1 has 3 units or fewer on hand.',
    team:'Count damaged cartons before moving them to the inspection bench.',
    unclear:'If a seal looks odd, ask the supervisor what to do.',
    tapeAlert:`Show a Needs You warning when ${tape} has 4 units or fewer on hand at Dispatch.`,
    tapeReorder:`Keep ${tape} at Dispatch with a reorder point of 2 and a target stock of 9.`,
  };
  const blank={domain:'',operation:'set',sku:'',supplier:'',location:'',sourceLocation:'',reorderPoint:-1,targetStock:-1,safetyStock:-1,
    leadTimeDays:-1,unitsPerPurchaseUnit:-1,minimumOrderQuantity:-1,orderMultiple:-1,maximumQuantity:-1,maximumValue:-1,weeklyValue:-1,
    daysOfStock:-1,preferTransferBeforePurchasing:false,guardMode:'',guardComparator:'',guardThreshold:-1,guardReleaseCondition:'',
    notificationThreshold:-1,notificationMetric:'',notificationComparator:'',capabilityName:''};
  const alert=(code,n)=>({...blank,domain:'stock_alert',sku:code,location:'Dispatch',notificationThreshold:n,notificationMetric:'on_hand',notificationComparator:'at_or_below'});
  const reorder=(code,point,target)=>({...blank,domain:'replenishment',sku:code,location:'Dispatch',reorderPoint:point,targetStock:target});
  const understood=changes=>({understood:true,summary:'Rule',clarifyingQuestion:'',unsupportedReason:'',changes});
  const meaning={[clauses.alert]:understood([alert(sku,7)]),[clauses.reorder]:understood([reorder(sku,5,12)]),
    [clauses.missing]:understood([alert('NOSUCH-1',3)]),[clauses.tapeAlert]:understood([alert(tape,4)]),[clauses.tapeReorder]:understood([reorder(tape,2,9)]),
    [clauses.split]:{understood:false,summary:'',clarifyingQuestion:'',unsupportedReason:'StockChief has no rule that splits purchase orders into deliveries.',changes:[]}};
  let lines=[];
  const provider={name:'anthropic',model:'claude-haiku-4-5-20251001',async complete(input){
    let data;
    if(input.schemaName==='stockchief_sop_source'){
      data={complete:true,steps:lines.map(([quote,category])=>({page:1,quote,label:quote.split(' ').slice(0,4).join(' '),category}))};
    }else if(input.schemaName==='postgres_operating_instruction'){
      const said=JSON.parse(input.prompt).instruction;
      assert(meaning[said],'Unexpected clause '+said);data=meaning[said];
    }else if(input.schemaName==='postgres_operating_instruction_effect_fit')data={equivalent:true,difference:''};
    else throw new Error('Unexpected model schema '+input.schemaName);
    return {data,usage:pricedUsage()};
  }};
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),aiProvider:provider});
  f.cleanup(()=>app.locals.sessionStore.close());
  const browser=request.agent(app),login=await browser.get('/login');
  await browser.post('/login').type('form').send({_csrf:f.csrf(login.text),email:f.email,password:f.password});
  const queue=require('../../src/operations/postgres-job-queue');
  const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{aiProvider:provider});
  const drain=async kinds=>{const done=[];for(let job;(job=await queue.processOne(db,handlers,{owner:'sop-follow-test',kinds}));)done.push(job);return done;};
  const root=sop.path,original=(title,list)=>{lines=list;return Buffer.from(title+'\n'+list.map(([quote])=>quote).join('\n')+'\n');};
  const upload=async(title,list)=>{
    const home=await browser.get(root).expect(200);
    const response=await browser.post(root).field('_csrf',f.csrf(home.text)).attach('procedure',original(title,list),title+'.txt').expect(303);
    const id=response.headers.location.split('/').at(-1);
    const [read]=await drain(['import.read-sop.v1']);assert.equal(read.status,'COMPLETED',JSON.stringify(read.lastError));
    return id;
  };
  const followJobs=async id=>(await db.query("SELECT id,status FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2 AND payload->>'id'=$3",[ws,sop.followKind,id])).rows;
  const uses=async id=>Object.fromEntries((await sop.clauseUses(db,ctx,await sop.load(db,ctx,id))).map(c=>[c.quote,c]));
  const proposals=async()=>Number((await db.query('SELECT count(*) n FROM operating_instruction_proposals WHERE workspace_id=$1 AND sop_source IS NOT NULL',[ws])).rows[0].n);
  const alertRule=async skuId=>(await db.query(`SELECT threshold FROM stockchief_runtime.stock_threshold_rules WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 AND is_active`,[ws,skuId,f.location.id])).rows[0];
  const reorderRule=async skuId=>(await db.query('SELECT reorder_point,target_stock FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ws,skuId,f.location.id])).rows[0];
  const notices=async()=>(await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).filter(n=>n.sourceId==='agent-notice-212');
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const form=async(href,body)=>{const page=await browser.get(href).expect(200);return browser.post(href+'/'+body.step).type('form').send({_csrf:f.csrf(page.text),...body.fields});};
  const all=[[clauses.alert,'standing_rule'],[clauses.reorder,'standing_rule'],[clauses.split,'standing_rule'],[clauses.missing,'standing_rule'],
    [clauses.team,'team_step'],[clauses.unclear,'human_review']];

  // Starter and Growth: the job is not on the plan.
  for(const tier of ['starter','growth']){
    await f.subscribe(tier);
    assert.match((await browser.get(root).expect(200)).text,/data-agent-plan-locked/);
    await assert.rejects(sop.follow(db,ctx,'sop_missing',{confirmed:'yes'}),error=>error.code==='entitlement_required');
  }

  // Pro: once read, StockChief follows the procedure on its own.
  await f.subscribe('pro');
  const first=await upload('Receiving procedure',all);
  assert.equal((await followJobs(first)).length,1,'following starts on its own after the reading');
  const [followed]=await drain([sop.followKind]);
  assert.equal(followed.status,'COMPLETED',JSON.stringify(followed.lastError));
  assert.deepEqual({rules:followed.result.rules,kept:followed.result.kept},{rules:2,kept:4});
  let use=await uses(first);
  assert.equal(use[clauses.alert].use,'waiting');assert.equal(use[clauses.reorder].use,'waiting');
  assert.equal(use[clauses.split].use,'kept');assert.match(use[clauses.split].text,/no rule that splits/);
  assert.equal(use[clauses.missing].use,'kept');assert.match(use[clauses.missing].text,/needs clarification/);
  assert.equal(use[clauses.team].use,'kept');assert.match(use[clauses.team].text,/your team/);
  assert.equal(use[clauses.unclear].use,'kept');assert.match(use[clauses.unclear].text,/A person decides/);
  assert.equal(await proposals(),2,'nothing is guessed for clauses that do not map exactly');
  assert.equal(await alertRule(f.item.skuIds[0]),undefined,'nothing applies before the owner confirms');
  assert.equal(await reorderRule(f.item.skuIds[0]),undefined);
  assert.equal((await notices()).length,1,'the rules wait in Needs you');
  let page=await browser.get(root+'/'+first).expect(200);
  assert.match(page.text,/Confirm all 2 rules/);assert.match(page.text,/Kept for people: A step for your team/);
  assert.match(page.text,/2 waiting for you · 4 kept for people/);
  // Running the same follow again prepares nothing new.
  const job=(await queue.get(db,followed.id,ws));
  assert.deepEqual(await sop.runFollow(job,db,{provider}),{id:first,rules:0,kept:0});
  assert.equal(await proposals(),2);
  // The owner confirms both: each counts, applies and keeps its clause.
  await form(root+'/'+first,{step:'confirm',fields:{confirmed:'yes'}}).then(r=>assert.equal(r.status,303));
  assert.equal(Number((await alertRule(f.item.skuIds[0])).threshold),7);
  assert.deepEqual(Object.values(await reorderRule(f.item.skuIds[0])).map(Number),[5,12]);
  assert.equal(await audits('Procedure rule confirmed'),2);
  assert.equal((await notices()).length,0);
  assert.deepEqual(await sop.confirm(db,ctx,first,{confirmed:'yes'}),{id:first,confirmed:0,waiting:0,problem:null},'confirming again changes nothing');
  use=await uses(first);
  assert.equal(use[clauses.alert].use,'rule');
  const rulePage=await browser.get('/operating-instructions/'+use[clauses.alert].proposalId).expect(200);
  assert.match(rulePage.text,/Original procedure clause/);assert(rulePage.text.includes(root+'/'+first));
  const read=require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review');
  const guidance=await read.prepare(null,db,ctx,'Show the procedure in order',{agentJob:'procedure-originals',search:first});
  assert.deepEqual(guidance.rows.map(r=>r.Use),['Approved instruction recorded','Approved instruction recorded',
    'Kept for people: StockChief has no rule that splits purchase orders into deliveries.',
    'Kept for people: This original clause needs clarification. Upload a version with the complete settings.','Team procedure',
    'Kept for people: Unclear or conflicting in the original. A person decides what it means.']);

  // The plan's rule allowance: the first rule fits, the second stops and waits.
  await db.query(`INSERT INTO operating_instruction_proposals(id,workspace_id,created_by_user_id,stated_as,summary,resolved_changes,status,integrity_hash,approved_at,created_at,updated_at)
    SELECT 'filler-'||g,$1,$2,'Earlier rule','Earlier rule',json_build_array(json_build_object('domain','stock_alert','operation','set','skuId','filler-sku-'||g))::text,
      'APPROVED','filler',now()::text,now()::text,now()::text FROM generate_series(1,497) g`,[ws,ctx.actorId]);
  const capped=await upload('Tape procedure',[[clauses.tapeAlert,'standing_rule'],[clauses.tapeReorder,'standing_rule']]);
  await drain([sop.followKind]);
  const result=await sop.confirm(db,ctx,capped,{confirmed:'yes'});
  assert.equal(result.confirmed,1);assert.equal(result.waiting,1);assert.match(result.problem,/500 active rules/);
  assert.equal(Number((await alertRule(second.skuIds[0])).threshold),4);assert.equal(await reorderRule(second.skuIds[0]),undefined);
  assert.equal((await notices()).length,1);
  // The owner keeps the other clause for people instead.
  const waiting=Object.values(await uses(capped)).find(c=>c.use==='waiting');
  await form(root+'/'+capped,{step:'keep',fields:{quoteId:waiting.id}}).then(r=>assert.equal(r.status,303));
  assert.equal((await uses(capped))[clauses.tapeReorder].use,'kept');
  assert.equal((await notices()).length,0);
  await db.query("DELETE FROM operating_instruction_proposals WHERE workspace_id=$1 AND id LIKE 'filler-%'",[ws]);

  // Watch only for this job: StockChief does not start alone; the owner can.
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,212,{mode:'watch',revision:0});
  const watched=await upload('Watched procedure',[[clauses.alert,'standing_rule'],[clauses.team,'team_step']]);
  assert.equal((await followJobs(watched)).length,0);
  page=await browser.get(root+'/'+watched).expect(200);
  assert.match(page.text,/did not start on its own: This job is set to Watch only/);
  const record=await sop.load(db,ctx,watched);
  await form(root+'/'+watched,{step:'follow',fields:{confirmed:'yes',sourceHash:record.source_hash}}).then(r=>assert.equal(r.status,303));
  assert.equal((await drain([sop.followKind]))[0].result.rules,1);
  await modes.save(db,ctx,212,{mode:'inherit',revision:1});
  // First 14 days: only watching.
  await age('1 day');
  const early=await upload('Early procedure',[[clauses.reorder,'standing_rule']]);
  assert.equal((await followJobs(early)).length,0);
  assert.match((await browser.get(root+'/'+early).expect(200)).text,/first 14 days/);
  await age('30 days');

  // Custom: the same, confirmed one rule at a time.
  await f.subscribe('enterprise');
  const custom=await upload('Custom procedure',[[clauses.tapeReorder,'standing_rule'],[clauses.unclear,'human_review']]);
  assert.equal((await drain([sop.followKind]))[0].result.rules,1);
  const tapeRule=(await uses(custom))[clauses.tapeReorder];
  await form(root+'/'+custom,{step:'confirm',fields:{confirmed:'yes',quoteId:tapeRule.id}}).then(r=>assert.equal(r.status,303));
  assert.deepEqual(Object.values(await reorderRule(second.skuIds[0])).map(Number),[2,9]);

  // Downgrade: nothing more is followed or confirmed.
  await sop.follow(db,ctx,early,{confirmed:'yes',sourceHash:(await sop.load(db,ctx,early)).source_hash});
  await f.subscribe('growth');
  const [held]=await drain([sop.followKind]);
  assert.equal(held.result.held,true);
  assert.equal((await uses(early))[clauses.reorder].use,'open');
  await assert.rejects(sop.confirm(db,ctx,watched,{confirmed:'yes'}),error=>error.code==='entitlement_required');
  assert.match((await browser.get(root+'/'+watched).expect(200)).text,/data-agent-plan-locked/);

  // The page reads well on a desktop and on a 390 px phone.
  await f.subscribe('pro');
  const listener=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();listener.closeAllConnections();await new Promise(r=>listener.close(r));});
  const base='http://127.0.0.1:'+listener.address().port,folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+root+'/'+first);
    assert(await tab.getByText('Kept for people: A step for your team to carry out.').isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:path.join(folder,'procedure-follow-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
