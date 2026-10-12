'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');
const locations=require('../../src/domain/postgres-location-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const commerce=require('../../src/operations/postgres-commerce');
const autonomy=require('../../src/autopilot/postgres-service');
const credentials=require('../../src/connections/postgres-credential-store');
const mail=require('../../src/connections/postgres-mail');
const jobs=require('../../src/operations/postgres-job-queue');
const runtimeHandlers=require('../../src/operations/postgres-runtime-handlers');
const reconciliation=require('../../src/operations/postgres-reconciliation');
const missionPlans=require('../../src/assistant/postgres-capability-plans');
const {newId,nowIso}=require('../../src/lib/util');

function step(capability,args={},dependsOn=[]){return {capability,
  arguments:Object.entries(args).map(([name,value])=>({name,value:String(value)})),dependsOn,continuesPending:false};}
function instructionChange(domain,values={}){return {domain,operation:'set',sku:'',supplier:'',location:'',sourceLocation:'',
  reorderPoint:-1,targetStock:-1,safetyStock:-1,leadTimeDays:-1,unitsPerPurchaseUnit:-1,
  minimumOrderQuantity:-1,orderMultiple:-1,maximumQuantity:-1,maximumValue:-1,weeklyValue:-1,daysOfStock:-1,
  preferTransferBeforePurchasing:false,guardMode:'',guardComparator:'',guardThreshold:-1,
  guardReleaseCondition:'',notificationThreshold:-1,notificationMetric:'on_hand',
  notificationComparator:'at_or_below',capabilityName:'',...values};}

test('real Chromium proves one-approval missions, verified memory, supplier follow-through and reconciliation stops',
  {timeout:240000},async(context)=>{
    const delivered=[];let ambiguousRecipient=null;let supplierAssessment='ACCEPTED';
    const adapter={metadata(){return {type:'gmail',name:'Gmail',category:'email',authMode:'oauth',available:true};},
      async send({credentials:providerCredentials,message}){assert.equal(providerCredentials.accessToken,'mission-mail-token');
        delivered.push(message);if(message.recipient===ambiguousRecipient){const error=new Error('Connection ended after provider acceptance');
          error.code='ECONNRESET';throw error;}return {externalMessageId:`mission-message-${delivered.length}`,
          externalThreadId:`mission-thread-${delivered.length}`};}};
    const providers={get(type){return type==='gmail'?adapter:null;},catalog(){return [adapter.metadata()];}};
    const first=step('catalog.create_item',{search:'Mission Widget',baseCode:'MISSION-WIDGET'});
    const second=step('inventory.receive',{sku:'MISSION-WIDGET',location:'Mission Warehouse',quantity:3,
      reference:'MISSION-OPENING'},[0]);
    const aiProvider={name:'anthropic',model:PRICED_MODEL,async complete(input){
      if(input.schemaName==='stockchief_supplier_acceptance'){
        const evidence=JSON.parse(input.prompt).supplierReplies;
        assert.ok(evidence.length>0);
        return {data:{decision:supplierAssessment,messageId:evidence.at(-1).id,
          evidenceQuote:supplierAssessment==='ACCEPTED'?'We accept this purchase order':
            'We are checking availability',changedTerms:false},usage:pricedUsage()};
      }
      if(input.schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''},usage:pricedUsage()};
      if(input.schemaName==='stockchief_capability_plan'){
        const message=JSON.parse(input.prompt).message;
        const planned=/email suppliers automatically/i.test(message)?[step('policy.propose')]:
          /order two Follow Through Parts/i.test(message)?[
            step('purchase_order.create',{supplier:'Mission Supply',sku:'FOLLOW-MISSION',quantity:2,
              location:'Mission Warehouse',amount:'2.50',currency:'USD'}),
            step('purchase_order.approve',{},[0]),
            step('communication.send_email',{recipient:'Mission Supply',recipientKind:'supplier',
              subject:'Follow Through Part purchase order',body:'Please accept two Follow Through Parts.',
              supplierAcceptance:'required'},[1]),
            step('purchase_order.place',{},[2]),
          ]:
          /add Resume Supply/i.test(message)?[
            step('contact.create',{recipient:'Resume Supply',recipientKind:'supplier',
              recipientEmail:'resume@mission-supply.example'}),
            step('communication.send_email',{recipient:'Resume Supply',recipientKind:'supplier',
              subject:'Approved mission follow-through',body:'This is the approved mission follow-through.'},[0]),
          ]:[first,second];
        return {data:{steps:planned,
          clarifyingQuestion:''},usage:pricedUsage()};
      }
      if(input.schemaName==='postgres_operating_instruction')return {data:{understood:true,
        summary:'Authorize StockChief to email suppliers through its registered delivery engine',
        clarifyingQuestion:'',unsupportedReason:'',changes:[instructionChange('capability_authority',
          {capabilityName:'supplier_emails'})]},usage:pricedUsage()};
      if(input.schemaName==='postgres_operating_instruction_effect_fit')return {data:{equivalent:true,difference:''},
        usage:pricedUsage()};
      throw new Error(`Unexpected model request ${input.schemaName}`);
    }};
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-autonomous-manager'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'autonomous-manager-secret',aiProvider,
      connectionProviders:providers});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(20000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Autonomous Mission Business');
    await page.getByLabel('Your name').fill('Mission Owner');await page.getByLabel('Work email').fill('mission@example.test');
    await page.locator('input[name="password"]').fill('mission-password');
    if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('mission-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id WHERE w.name='Autonomous Mission Business'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const warehouse=await locations.createLocation(database,ctx,{name:'Mission Warehouse',kind:'warehouse'});

    await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief').fill(
      'Create Mission Widget with SKU MISSION-WIDGET and record three delivered units at Mission Warehouse.');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    assert.equal(await page.getByRole('link',{name:'Review prepared change'}).count(),1,
      await page.locator('main').innerText());
    await page.getByRole('link',{name:'Review prepared change'}).click();
    assert.match(await page.locator('main').innerText(),/One outcome, one approval[\s\S]*catalog create item[\s\S]*inventory receive/i);
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Approve the whole mission'}).click()]);
    const mission=(await database.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0];
    assert.equal(mission.status,'DONE');assert.equal(mission.verification_status,'VERIFIED');
    assert.equal(mission.metrics.approvalInteractions,1);assert.equal(mission.metrics.automaticSteps,1);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 AND status='EXECUTED'`,[ctx.workspaceId])).rows[0].count,2);
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND location_id=$2`,
      [ctx.workspaceId,warehouse.id])).rows[0].on_hand),3);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM stockchief_runtime.assistant_business_memory
      WHERE workspace_id=$1 AND memory_type='OUTCOME'`,[ctx.workspaceId])).rows[0].count,2);
    const measured=await missionPlans.metricsSummary(database,ctx.workspaceId);
    assert.deepEqual({missions:measured.missions,completed:measured.completed,automatic:measured.automatic_steps,
      interactions:measured.humanInteractionsPerCompleted},{missions:1,completed:1,automatic:1,interactions:2});

    await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief').fill(
      'Allow StockChief to email suppliers automatically.');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    await Promise.all([page.waitForURL(/\/operating-instructions\/oin_/),
      page.getByRole('link',{name:'Review prepared change'}).click()]);
    assert.match(await page.locator('main').innerText(),/Authorize StockChief to email suppliers/i);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve standing rule'}).click()]);
    assert.equal(Number((await database.query(`SELECT granted FROM autopilot_capabilities
      WHERE workspace_id=$1 AND capability='supplier_emails'`,[ctx.workspaceId])).rows[0].granted),1);
    const authorityMemory=(await database.query(`SELECT * FROM stockchief_runtime.assistant_business_memory
      WHERE workspace_id=$1 AND memory_type='PREFERENCE' AND memory_key='authority:capability:supplier_emails'
        AND retired_at IS NULL`,[ctx.workspaceId])).rows[0];
    assert.equal(authorityMemory.confidence,'OWNER_STATED');
    const ruleMetrics=await missionPlans.metricsSummary(database,ctx.workspaceId);
    assert.deepEqual(ruleMetrics.breakdown.standingRules,{outcomes:1,completed:1});
    assert.equal(ruleMetrics.humanInteractionsPerCompleted,2);

    const connectorId=newId('con');const at=nowIso();
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,
       expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
      VALUES($1,$2,$3,'Mission Gmail','gmail',$4,'{}','connected',$5,$6,5,'CONNECTED',$7,'mission-mailbox',
        'mission@example.test',$8,$8)`,[connectorId,ctx.workspaceId,`gmail:${connectorId}`,JSON.stringify(['business mail']),
      JSON.stringify(['mail:read','mail:send']),`connection_credentials:${connectorId}`,ctx.actorId,at]);
    await database.transaction((client)=>credentials.put(client,ctx.workspaceId,connectorId,'provider',{accessToken:'mission-mail-token'}));

    await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief').fill(
      'Add Resume Supply as a supplier at resume@mission-supply.example and email them this exact message: This is the approved mission follow-through.');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    await page.getByRole('link',{name:'Review prepared change'}).click();
    await Promise.all([page.waitForURL(/\/ask#latest$/),
      page.getByRole('button',{name:'Approve the whole mission'}).click()]).catch(async error=>{
        throw new Error(`Mission approval failed: ${await page.locator('main').innerText()}`,{cause:error});});
    let waitingMission=(await database.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 AND source_message LIKE 'Add Resume Supply%' ORDER BY created_at DESC LIMIT 1`,
    [ctx.workspaceId])).rows[0];
    assert.equal(waitingMission.status,'WAITING_EVENT');assert.equal(waitingMission.metrics.externalWaits,1);
    // A new adaptive owner can persist through an external wait while the existing
    // mission and delivery engines retain all authority and retry semantics.
    const goalStore=require('../../src/assistant/postgres-goal-store');
    const goalResume=require('../../src/assistant/postgres-goal-resume');
    process.env.STOCKCHIEF_ADAPTIVE_ASK='1';process.env.STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES=ctx.workspaceId;
    const linkedGoal=await goalStore.create(database,ctx,waitingMission.source_message);
    const claimedGoal=await goalStore.claim(database,ctx,linkedGoal.id);
    claimedGoal.status='WAITING_EVENT';claimedGoal.checkpoint.waiting={missionId:waitingMission.id,proposalIds:[]};
    await goalStore.save(database,ctx,claimedGoal,'external_wait');
    await database.query('UPDATE stockchief_runtime.assistant_capability_plans SET goal_id=$1 WHERE id=$2',[linkedGoal.id,waitingMission.id]);
    const holdsBefore=(await database.query('SELECT count(*)::int AS n FROM commercial_model_cost_holds')).rows[0].n;
    assert.equal((await goalResume.refresh(database,ctx,linkedGoal.id)).status,'WAITING_EVENT');
    assert.equal((await database.query('SELECT count(*)::int AS n FROM commercial_model_cost_holds')).rows[0].n,holdsBefore);
    await jobs.processOne(database,runtimeHandlers.create(providers),{owner:'mission-external-effect-worker'});
    const sweep=await database.transaction((client)=>runtimeHandlers.runtimeSweep({payload:{now:Date.now()}},client));
    assert.equal(sweep.scheduledMissionResumes,1);
    const resumed=await jobs.processOne(database,runtimeHandlers.create(providers),
      {owner:'mission-resume-worker',now:Date.now()+1});
    assert.equal(resumed.kind,'assistant.resume-mission');assert.equal(resumed.status,'COMPLETED');
    waitingMission=(await database.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,waitingMission.id])).rows[0];
    assert.equal(waitingMission.status,'DONE');assert.equal(waitingMission.verification_status,'VERIFIED');
    assert.equal(waitingMission.metrics.resumptions,1);
    assert.ok(delivered.some((message)=>message.recipient==='resume@mission-supply.example'));
    const readyGoal=await goalResume.refresh(database,ctx,linkedGoal.id);
    assert.equal(readyGoal.status,'READY');assert.equal(readyGoal.checkpoint.observations.length,2);
    assert.ok(readyGoal.checkpoint.observations.every(o=>o.result.externalStatus==='DONE'));
    await goalStore.cancel(database,ctx,linkedGoal.id);process.env.STOCKCHIEF_ADAPTIVE_ASK='0';

    const supplier=await commerce.createSupplier(database,ctx,{name:'Mission Supply',email:'orders@mission-supply.example'});
    await database.query('UPDATE suppliers SET watched_connector_id=$3 WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,supplier.id,connectorId]);
    const purchaseItem=await catalog.createItem(database,ctx,{name:'Follow Through Part',baseCode:'FOLLOW-PART',trackingMode:'quantity'});
    await database.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,supplier_sku,purchase_unit,
      units_per_purchase_unit,last_unit_cost,lead_time_days,minimum_order_quantity,order_multiple,is_preferred,is_active,created_at,updated_at)
      VALUES($1,$2,$3,$4,'FOLLOW-CASE','case',6,2.50,5,1,1,1,1,$5,$5)`,
    [newId('supi'),ctx.workspaceId,supplier.id,purchaseItem.skuIds[0],at]);
    const missionPurchaseItem=await catalog.createItem(database,ctx,
      {name:'Follow Through Mission Part',baseCode:'FOLLOW-MISSION',trackingMode:'quantity'});
    await database.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,supplier_sku,purchase_unit,
      units_per_purchase_unit,last_unit_cost,lead_time_days,minimum_order_quantity,order_multiple,is_preferred,is_active,created_at,updated_at)
      VALUES($1,$2,$3,$4,'FOLLOW-MISSION','each',1,2.50,5,1,1,1,1,$5,$5)`,
    [newId('supi'),ctx.workspaceId,supplier.id,missionPurchaseItem.skuIds[0],at]);
    await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief').fill(
      'Order two Follow Through Parts from Mission Supply, approve the order, email it, and mark it ordered only after Mission Supply accepts the purchase order by replying.');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    assert.equal(await page.getByRole('link',{name:'Review prepared change'}).count(),1,
      await page.locator('main').innerText());
    await page.getByRole('link',{name:'Review prepared change'}).click();
    assert.match(await page.locator('main').innerText(),/purchase order create[\s\S]*purchase order approve[\s\S]*communication send email[\s\S]*purchase order place/i);
    await Promise.all([page.waitForURL(/\/ask#latest$/),
      page.getByRole('button',{name:'Approve the whole mission'}).click()]);
    let purchaseMission=(await database.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 AND source_message LIKE 'Order two Follow Through Parts%' ORDER BY created_at DESC LIMIT 1`,
    [ctx.workspaceId])).rows[0];
    assert.equal(purchaseMission.status,'WAITING_EVENT');
    const missionPo=(await database.query(`SELECT id,status FROM purchase_orders
      WHERE workspace_id=$1 AND source<>'foundry_recommendation' ORDER BY created_at DESC LIMIT 1`,
    [ctx.workspaceId])).rows[0];
    assert.equal(missionPo.status,'APPROVED');
    await jobs.processOne(database,runtimeHandlers.create(providers),{owner:'mission-purchase-mail-worker'});
    const purchaseSweep=await database.transaction((client)=>runtimeHandlers.runtimeSweep({payload:{now:Date.now()}},client));
    assert.equal(purchaseSweep.scheduledMissionResumes,1);
    const deliveryResumed=await jobs.processOne(database,runtimeHandlers.create(providers,{aiProvider}),
      {owner:'mission-purchase-resume-worker',now:Date.now()+1});
    assert.equal(deliveryResumed.kind,'assistant.resume-mission');assert.equal(deliveryResumed.status,'COMPLETED');
    purchaseMission=(await database.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,purchaseMission.id])).rows[0];
    assert.equal(purchaseMission.status,'WAITING_EVENT');
    assert.equal(purchaseMission.waiting_condition.kind,'supplier_acceptance');
    await page.goto(`${base}/actions/${purchaseMission.steps[0].proposalId}`);
    assert.match(await page.locator('main').innerText(),/Waiting for the supplier’s acceptance/i);
    assert.equal((await database.query(`SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,missionPo.id])).rows[0].status,'APPROVED');
    const sent=(await database.query(`SELECT * FROM supplier_communications WHERE workspace_id=$1
      AND supplier_id=$2 ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId,supplier.id])).rows[0];
    const connector=(await database.query(`SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,connectorId])).rows[0];
    const untrusted=await mail.capture(database,connector,{externalMessageId:'supplier-spoof-reply-1',
      externalThreadId:sent.external_thread_id,sender:'unrecognized@example.test',
      subject:`Re: ${sent.subject}`,bodyText:'We accept this purchase order.',receivedAt:nowIso()});
    assert.equal(untrusted.setAside,true);
    const wrongThread=await mail.capture(database,connector,{externalMessageId:'supplier-wrong-thread-1',
      externalThreadId:'unrelated-supplier-thread',sender:'orders@mission-supply.example',
      subject:`Re: ${sent.subject}`,bodyText:'We accept this purchase order.',receivedAt:nowIso()});
    assert.equal(wrongThread.accepted,true);
    assert.equal((await database.query(`SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,missionPo.id])).rows[0].status,'APPROVED');
    supplierAssessment='UNCLEAR';
    const unclear=await mail.capture(database,connector,{externalMessageId:'supplier-unclear-reply-1',
      externalThreadId:sent.external_thread_id,sender:'orders@mission-supply.example',
      subject:`Re: ${sent.subject}`,bodyText:'We are checking availability.',receivedAt:nowIso()});
    assert.equal(unclear.accepted,true);
    const unclearResume=await jobs.processOne(database,runtimeHandlers.create(providers,{aiProvider}),
      {owner:'mission-purchase-unclear-worker'});
    assert.equal(unclearResume.kind,'assistant.resume-mission');
    assert.equal((await database.query(`SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,missionPo.id])).rows[0].status,'APPROVED');
    supplierAssessment='ACCEPTED';
    const inbound=await mail.capture(database,connector,{externalMessageId:'supplier-acceptance-reply-1',
      externalThreadId:sent.external_thread_id,sender:'orders@mission-supply.example',
      subject:`Re: ${sent.subject}`,bodyText:`We accept this purchase order ${missionPo.id} without changes.`,
      receivedAt:nowIso()});
    assert.equal(inbound.accepted,true);
    const placed=await jobs.processOne(database,runtimeHandlers.create(providers,{aiProvider}),
      {owner:'mission-purchase-acceptance-worker'});
    assert.equal(placed.kind,'assistant.resume-mission');assert.equal(placed.status,'COMPLETED');
    purchaseMission=(await database.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,purchaseMission.id])).rows[0];
    assert.equal(purchaseMission.status,'DONE');assert.equal(purchaseMission.verification_status,'VERIFIED');
    assert.equal(purchaseMission.steps[2].acceptanceEvidence.replyMessageId,inbound.messageId);
    assert.deepEqual({approvals:purchaseMission.metrics.approvalInteractions,
      waits:purchaseMission.metrics.externalWaits,resumptions:purchaseMission.metrics.resumptions,
      interventions:purchaseMission.metrics.userInterventions},
    {approvals:1,waits:1,resumptions:1,interventions:0});
    await page.reload();
    assert.match(await page.locator('main').innerText(),/Mission completed and verified/i);
    assert.equal((await database.query(`SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,missionPo.id])).rows[0].status,'ORDERED');
    assert.equal(delivered.filter((message)=>message.recipient==='orders@mission-supply.example').length,1);
    await jobs.enqueue(database,{workspaceId:ctx.workspaceId,kind:'assistant.resume-mission',
      idempotencyKey:`certification:resume-replay:${purchaseMission.id}`,
      payload:{missionId:purchaseMission.id,actorId:ctx.actorId}});
    const duplicateResume=await jobs.processOne(database,
      {'assistant.resume-mission':runtimeHandlers.create(providers)['assistant.resume-mission']},
      {owner:'mission-purchase-duplicate-resume-worker'});
    assert.equal(duplicateResume.status,'COMPLETED');
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM purchase_order_events
      WHERE workspace_id=$1 AND purchase_order_id=$2 AND event='ordered'`,
    [ctx.workspaceId,missionPo.id])).rows[0].count,1);
    assert.equal(delivered.filter((message)=>message.recipient==='orders@mission-supply.example').length,1);
    await database.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,
      safety_stock,preferred_supplier_id,lead_time_days,source,created_at,updated_at)
      VALUES($1,$2,$3,$4,2,12,1,$5,5,'manual',$6,$6)`,
    [newId('rpol'),ctx.workspaceId,purchaseItem.skuIds[0],warehouse.id,supplier.id,at]);
    const actor=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,ctx.actorId])).rows[0];
    const priorSupplierDeliveries=delivered.filter((message)=>message.recipient==='orders@mission-supply.example').length;
    await autonomy.configureRoutine(database,ctx,actor,{purchaseEnabled:true,transferEnabled:false,
      supplierIds:[supplier.id],maximumValue:'100',weeklyValue:'500'});
    const autonomous=await autonomy.run(database,ctx);assert.equal(autonomous.executed,0);
    let work=(await database.query(`SELECT * FROM work_items WHERE workspace_id=$1 AND category='replenishment_plan'
      ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
    assert.equal(work.execution_status,'EXECUTING');assert.equal(JSON.parse(work.outcome).phase,'SUPPLIER_DELIVERY_PENDING');
    let order=(await database.query(`SELECT * FROM purchase_orders WHERE workspace_id=$1 AND source='foundry_recommendation'
      ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId])).rows[0];assert.equal(order.status,'APPROVED');
    await jobs.processOne(database,runtimeHandlers.create(providers),{owner:'mission-mail-worker'});
    work=(await database.query('SELECT * FROM work_items WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,work.id])).rows[0];
    order=(await database.query('SELECT * FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,order.id])).rows[0];
    assert.equal(work.execution_status,'COMPLETED');assert.equal(work.verification_status,'VERIFIED');
    const supplierDeliveries=()=>delivered.filter((message)=>message.recipient==='orders@mission-supply.example').length;
    assert.equal(order.status,'ORDERED');assert.equal(supplierDeliveries(),priorSupplierDeliveries+1);
    const purchaseMetrics=await missionPlans.metricsSummary(database,ctx.workspaceId);
    assert.deepEqual(purchaseMetrics.breakdown.autonomousPurchases,{outcomes:1,completed:1});
    await jobs.processOne(database,runtimeHandlers.create(providers),{owner:'mission-mail-replay-worker'});
    assert.equal(supplierDeliveries(),priorSupplierDeliveries+1,'provider-confirmed supplier delivery is never sent twice');

    const uncertainSupplier=await commerce.createSupplier(database,ctx,
      {name:'Uncertain Supply',email:'uncertain@mission-supply.example'});
    ambiguousRecipient='uncertain@mission-supply.example';
    await database.query('UPDATE suppliers SET watched_connector_id=$3 WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,uncertainSupplier.id,connectorId]);
    const uncertainItem=await catalog.createItem(database,ctx,{name:'Uncertain Part',baseCode:'UNCERTAIN-PART',trackingMode:'quantity'});
    await database.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,supplier_sku,purchase_unit,
      units_per_purchase_unit,last_unit_cost,lead_time_days,minimum_order_quantity,order_multiple,is_preferred,is_active,created_at,updated_at)
      VALUES($1,$2,$3,$4,'UNCERTAIN-CASE','case',4,3.00,5,1,1,1,1,$5,$5)`,
    [newId('supi'),ctx.workspaceId,uncertainSupplier.id,uncertainItem.skuIds[0],at]);
    await database.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,
      safety_stock,preferred_supplier_id,lead_time_days,source,created_at,updated_at)
      VALUES($1,$2,$3,$4,2,8,1,$5,5,'manual',$6,$6)`,
    [newId('rpol'),ctx.workspaceId,uncertainItem.skuIds[0],warehouse.id,uncertainSupplier.id,at]);
    await autonomy.configureRoutine(database,ctx,actor,{purchaseEnabled:true,transferEnabled:false,
      supplierIds:[supplier.id,uncertainSupplier.id],maximumValue:'100',weeklyValue:'500'});
    await autonomy.run(database,ctx);
    const uncertainWork=(await database.query(`SELECT * FROM work_items WHERE workspace_id=$1
      AND affected_entities LIKE $2 ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId,`%${uncertainItem.skuIds[0]}%`])).rows[0];
    assert.equal(uncertainWork.execution_status,'EXECUTING');
    await jobs.processOne(database,runtimeHandlers.create(providers),{owner:'mission-ambiguous-mail-worker'});
    await autonomy.reconcileSupplierFollowThrough(database,ctx.workspaceId,{actorId:ctx.actorId});
    const failedWork=(await database.query('SELECT * FROM work_items WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,uncertainWork.id])).rows[0];
    const failedOrder=(await database.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,failedWork.purchase_order_id])).rows[0];
    assert.equal(failedWork.execution_status,'FAILED');assert.equal(failedWork.verification_status,'FAILED');
    assert.equal(failedOrder.status,'APPROVED','uncertain delivery never marks the supplier order as placed');
    const ambiguousEffect=(await database.query(`SELECT status FROM stockchief_runtime.provider_effects
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,JSON.parse(failedWork.outcome).effectId])).rows[0];
    assert.equal(ambiguousEffect.status,'AMBIGUOUS');
    const sentAttempts=delivered.length;
    await jobs.processOne(database,runtimeHandlers.create(providers),{owner:'mission-ambiguous-replay-worker'});
    assert.equal(delivered.length,sentAttempts,'an ambiguous provider outcome is never automatically resent');

    const healthy=await reconciliation.run(database,ctx.workspaceId);assert.equal(healthy.status,'VERIFIED');
    const missionSku=(await database.query(`SELECT s.id FROM skus s JOIN items i ON i.id=s.item_id
      WHERE s.workspace_id=$1 AND i.name='Mission Widget'`,[ctx.workspaceId])).rows[0].id;
    await database.query(`UPDATE balances SET on_hand=on_hand+1 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,missionSku,warehouse.id]);
    const broken=await reconciliation.run(database,ctx.workspaceId);assert.equal(broken.status,'FAILED');
    assert.ok(broken.checks.some((check)=>check.key==='inventory.balance_equals_movements'&&check.status==='FAIL'));
    assert.equal((await autonomy.getState(database,ctx.workspaceId)).suspended,true);
    await database.query(`UPDATE balances SET on_hand=on_hand-1 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,missionSku,warehouse.id]);
    const restored=await reconciliation.run(database,ctx.workspaceId);assert.equal(restored.status,'VERIFIED');
    assert.equal((await autonomy.getState(database,ctx.workspaceId)).suspended,false);

    const reconcileHandler=runtimeHandlers.create(providers)['system.reconcile-business'];
    const processReconciliation=async(jobId,owner)=>{
      for(let attempt=0;attempt<10;attempt++){
        const processed=await jobs.processOne(database,{'system.reconcile-business':reconcileHandler},{owner});
        if(!processed)break;
        if(processed.id===jobId)return processed;
      }
      return jobs.get(database,jobId,ctx.workspaceId);
    };
    const scheduled=await jobs.enqueue(database,{workspaceId:ctx.workspaceId,kind:'system.reconcile-business',
      idempotencyKey:`certification:reconcile:${newId('run')}`});
    const processed=await processReconciliation(scheduled.job.id,'mission-reconcile-worker');
    assert.equal(processed.id,scheduled.job.id);assert.equal(processed.status,'COMPLETED');
    assert.equal(processed.result.status,'VERIFIED');
    assert.equal((await database.query(`SELECT status FROM stockchief_runtime.workspace_reconciliation_state
      WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0].status,'VERIFIED');

    await database.query(`UPDATE balances SET on_hand=on_hand+1 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,missionSku,warehouse.id]);
    const mismatch=await jobs.enqueue(database,{workspaceId:ctx.workspaceId,kind:'system.reconcile-business',
      idempotencyKey:`certification:reconcile:${newId('run')}`});
    const stopped=await processReconciliation(mismatch.job.id,'mission-reconcile-stop-worker');
    assert.equal(stopped.id,mismatch.job.id);assert.equal(stopped.status,'COMPLETED');
    assert.equal(stopped.result.status,'FAILED');
    assert.equal((await autonomy.getState(database,ctx.workspaceId)).suspended,true);
    await database.query(`UPDATE balances SET on_hand=on_hand-1 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,missionSku,warehouse.id]);
    const retry=await jobs.enqueue(database,{workspaceId:ctx.workspaceId,kind:'system.reconcile-business',
      idempotencyKey:`certification:reconcile:${newId('run')}`});
    const recovered=await processReconciliation(retry.job.id,'mission-reconcile-recovery-worker');
    assert.equal(recovered.id,retry.job.id);assert.equal(recovered.result.status,'VERIFIED');
    assert.equal((await autonomy.getState(database,ctx.workspaceId)).suspended,false);
    const beforeReply=await missionPlans.metricsSummary(database,ctx.workspaceId);
    await database.query(`INSERT INTO stockchief_runtime.assistant_interactions
      (id,workspace_id,actor_user_id,message,intent,answer,evidence,status)
      VALUES($1,$2,$3,'The missing quantity is two',$4::jsonb,'How many units?','[]'::jsonb,'CLARIFY')`,
    [newId('pgask'),ctx.workspaceId,ctx.actorId,JSON.stringify({controlPlane:{continuesPending:true,
      originalMessage:'Please record the delivered stock'}})]);
    const afterReply=await missionPlans.metricsSummary(database,ctx.workspaceId);
    assert.equal(afterReply.clarifications,beforeReply.clarifications+1);
    assert.equal(afterReply.humanInteractions,beforeReply.humanInteractions+1,
      'an actual owner follow-up counts; StockChief asking the question does not');

    await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief').fill(
      'Order two Follow Through Parts from Mission Supply, approve the order, email it, and mark it ordered only after Mission Supply accepts the purchase order by replying.');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    await page.getByRole('link',{name:'Review prepared change'}).click();
    await Promise.all([page.waitForURL(/\/ask#latest$/),
      page.getByRole('button',{name:'Approve the whole mission'}).click()]);
    const revokedMission=(await database.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 AND source_message LIKE 'Order two Follow Through Parts%'
      ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
    const revokedPo=(await database.query(`SELECT id,status FROM purchase_orders WHERE workspace_id=$1
      AND source<>'foundry_recommendation' ORDER BY created_at DESC,id DESC LIMIT 1`,
    [ctx.workspaceId])).rows[0];
    assert.equal(revokedPo.status,'APPROVED');
    await jobs.processOne(database,runtimeHandlers.create(providers),{owner:'mission-revoked-mail-worker'});
    await database.transaction((client)=>runtimeHandlers.runtimeSweep({payload:{now:Date.now()}},client));
    await jobs.processOne(database,runtimeHandlers.create(providers,{aiProvider}),
      {owner:'mission-revoked-delivery-worker'});
    const revokedWaiting=(await database.query(`SELECT status,waiting_condition FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,revokedMission.id])).rows[0];
    assert.equal(revokedWaiting.waiting_condition.kind,'supplier_acceptance');
    await database.query(`UPDATE stockchief_runtime.assistant_capability_plans SET approval_status='REVOKED'
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,revokedMission.id]);
    const revokedSent=(await database.query(`SELECT * FROM supplier_communications WHERE workspace_id=$1
      AND supplier_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId,supplier.id])).rows[0];
    await mail.capture(database,connector,{externalMessageId:'supplier-revoked-reply-1',
      externalThreadId:revokedSent.external_thread_id,sender:'orders@mission-supply.example',
      subject:`Re: ${revokedSent.subject}`,bodyText:'We accept this purchase order without changes.',
      receivedAt:nowIso()});
    const revokedWake=await jobs.processOne(database,runtimeHandlers.create(providers,{aiProvider}),
      {owner:'mission-revoked-acceptance-worker'});
    assert.equal(revokedWake.kind,'assistant.resume-mission');
    assert.equal((await database.query(`SELECT status FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,revokedMission.id])).rows[0].status,'BLOCKED');
    assert.equal((await database.query(`SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,revokedPo.id])).rows[0].status,'APPROVED');
  });
