'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');

function change(domain,values={}){return {domain,operation:'set',sku:'',supplier:'',location:'',sourceLocation:'',
  reorderPoint:-1,targetStock:-1,safetyStock:-1,leadTimeDays:-1,unitsPerPurchaseUnit:-1,
  minimumOrderQuantity:-1,orderMultiple:-1,maximumQuantity:-1,maximumValue:-1,weeklyValue:-1,daysOfStock:-1,
  preferTransferBeforePurchasing:false,guardMode:'',guardComparator:'',guardThreshold:-1,
  guardReleaseCondition:'',notificationThreshold:-1,
  notificationMetric:'on_hand',notificationComparator:'at_or_below',...values};}
function json(value){return typeof value==='string'?JSON.parse(value):value;}

const provider={async complete(input){
  if(input.schemaName==='postgres_operating_instruction_effect_fit')return {data:{equivalent:true,difference:''},
    usage:{provider:'fixture-ai',model:'fixture-model',inputTokens:20,outputTokens:10}};
  if(input.schemaName==='stockchief_postgres_request')return {data:{intent:'instruction',view:null,action:null,
    search:null,sku:null,location:null,fromLocation:null,toLocation:null,quantity:null,countedQuantity:null,reason:null,reference:null},
    usage:{provider:'fixture-ai',model:'fixture-model',inputTokens:20,outputTokens:10}};
  if(input.schemaName==='postgres_operating_instruction'&&JSON.parse(input.prompt).instruction?.includes('Change that')){
    const prompt=JSON.parse(input.prompt);
    assert.equal(prompt.priorApprovedRule.changes[0].skuCode,'RULE-1');
    return {data:{understood:true,summary:'Change the approved Rule Widget reorder point to six',
      clarifyingQuestion:'',unsupportedReason:'',changes:[change('replenishment',
        {sku:prompt.priorApprovedRule.changes[0].skuCode,reorderPoint:6})]},
    usage:{provider:'fixture-ai',model:'fixture-model',inputTokens:40,outputTokens:20}};
  }
  if(input.schemaName==='postgres_operating_instruction'&&JSON.parse(input.prompt).instruction?.includes('this product')){
    const prompt=JSON.parse(input.prompt);
    assert.equal(prompt.currentRecord.sku,'RULE-1');
    return {data:{understood:true,summary:'Set the current product reorder point to four',
      clarifyingQuestion:'',unsupportedReason:'',changes:[change('replenishment',
        {sku:prompt.currentRecord.sku,reorderPoint:4})]},
    usage:{provider:'fixture-ai',model:'fixture-model',inputTokens:40,outputTokens:20}};
  }
  if(input.schemaName==='postgres_operating_instruction'&&JSON.parse(input.prompt).instruction?.includes('warehouse-specific')){
    return {data:{understood:true,summary:'Main Warehouse reorder point',clarifyingQuestion:'',unsupportedReason:'',
      changes:[change('replenishment',{sku:'RULE-1',location:'Main Warehouse',reorderPoint:4,targetStock:15})]},
    usage:{provider:'fixture-ai',model:'fixture-model',inputTokens:40,outputTokens:20}};
  }
  if(input.schemaName==='postgres_operating_instruction')return {data:{understood:true,
    summary:'Keep Rule Widget replenished under approved supplier, transfer and stock limits',clarifyingQuestion:'',unsupportedReason:'',changes:[
      change('replenishment',{sku:'RULE-1',reorderPoint:8,targetStock:20,safetyStock:3}),
      change('supplier_terms',{sku:'RULE-1',supplier:'Acme Supply',leadTimeDays:12,minimumOrderQuantity:4}),
      change('transfer_authority',{sourceLocation:'Main Warehouse',location:'Overflow Warehouse',maximumQuantity:5}),
      change('purchase_authority',{supplier:'Acme Supply',maximumValue:500,weeklyValue:1500}),
      change('operating_preference',{preferTransferBeforePurchasing:true}),
      change('stock_protection',{sku:'RULE-1',guardMode:'block',guardComparator:'below',
        guardThreshold:2,guardReleaseCondition:'stock_recovered'}),
    ]},usage:{provider:'fixture-ai',model:'fixture-model',inputTokens:40,outputTokens:20}};
  throw new Error(`Unexpected model schema ${input.schemaName}`);
}};

test('real Chromium approves one free-form PostgreSQL standing instruction without prompt-based authority',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString,
      {applicationName:'stockchief-postgres-standing-instructions'});await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-standing-instruction-secret',aiProvider:require('../helpers/postgres-model-fixture').fixture(provider)});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();context.after(async()=>{await browser.close();
      await new Promise((resolve)=>server.close(resolve));await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Rule Business');await page.getByLabel('Your name').fill('Rule Owner');
    await page.getByLabel('Work email').fill('rules@example.test');await page.getByLabel('Password').fill('rules-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id,a.id AS account_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='rules@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    await locations.createLocation(database,ctx,{name:'Main Warehouse',kind:'warehouse'});
    await locations.createLocation(database,ctx,{name:'Overflow Warehouse',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'Rule Widget',baseCode:'RULE-1',trackingMode:'quantity',unitLabel:'unit'});
    const at='2026-09-23T00:00:00.000Z';await database.query(`INSERT INTO suppliers
      (id,workspace_id,name,status,currency,created_at,updated_at) VALUES('rule-supplier',$1,'Acme Supply','active','USD',$2,$2)`,
    [ctx.workspaceId,at]);
    await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief').fill(
      'Keep Rule Widget replenished, remember Acme Supply’s 12-day lead time and four-unit minimum, transfer before buying, block issues below two on hand until stock recovers, and automatically handle only the exact limits I stated.');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue'}).click()]);
    assert.match(await page.locator('main').innerText(),/not in force yet/i);
    assert.ok(Number((await database.query(`SELECT COUNT(*) AS count FROM commercial_usage_events WHERE account_id=$1
      AND meter='ai_work_credits' AND status='COMMITTED'`,[identity.account_id])).rows[0].count)>=2);
    assert.ok(Number((await database.query(`SELECT COUNT(*) AS count FROM commercial_cost_events WHERE account_id=$1
      AND provider='anthropic'`,[identity.account_id])).rows[0].count)>=4);
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM reorder_policies WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].count,'0');
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM automation_policies WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].count,'0');
    assert.match(await page.getByRole('link',{name:'Review prepared change'}).getAttribute('href'),/\?from=ask$/);
    await Promise.all([page.waitForURL(/\/operating-instructions\/oin_/),page.getByRole('link',{name:'Review prepared change'}).click()]);
    const review=await page.locator('main').innerText();assert.match(review,/reorder at 8, target 20, safety stock 3/);
    assert.match(review,/automatic transfers up to 5 units/);assert.match(review,/\$500\.00 each and \$1500\.00 per rolling seven days/);
    assert.match(review,/Prefer transfers before purchasing/);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve standing rule'}).click()]);
    assert.match(await page.locator('main').innerText(),/In force/);
    const reorder=(await database.query(`SELECT * FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2`,
      [ctx.workspaceId,item.skuIds[0]])).rows[0];
    assert.equal(Number(reorder.reorder_point),8);assert.equal(Number(reorder.target_stock),20);assert.equal(Number(reorder.safety_stock),3);
    const scoped=await require('../../src/manager/postgres-operating-instructions').interpret(database,ctx,
      'Set a warehouse-specific reorder point for RULE-1 in Main Warehouse.',
      {provider:require('../helpers/postgres-model-fixture').fixture(provider),instructionUsageKey:'scoped-reorder-rule'});
    assert.match(scoped.summary,/at Main Warehouse/);
    await require('../../src/manager/postgres-operating-instructions').approve(database,ctx,scoped.id,scoped.integrityHash);
    const locationId=(await database.query(`SELECT id FROM locations WHERE workspace_id=$1 AND name='Main Warehouse'`,
      [ctx.workspaceId])).rows[0].id;
    const policies=(await database.query(`SELECT location_id,reorder_point,target_stock FROM reorder_policies
      WHERE workspace_id=$1 AND sku_id=$2 ORDER BY location_id NULLS FIRST`,
      [ctx.workspaceId,item.skuIds[0]])).rows;
    assert.deepEqual(policies.map((row)=>({location:row.location_id,reorder:Number(row.reorder_point),target:Number(row.target_stock)})),
      [{location:null,reorder:8,target:20},{location:locationId,reorder:4,target:15}]);
    let extractionAttempts=0;
    const recoveringProvider=require('../helpers/postgres-model-fixture').fixture({async complete(input){
      const usage={provider:'fixture-ai',model:'fixture-model',inputTokens:40,outputTokens:20};
      if(input.schemaName==='postgres_operating_instruction_effect_fit'){
        assert.equal(JSON.parse(input.prompt).proposalLifecycle,'PENDING_UNTIL_SEPARATE_OWNER_APPROVAL');
        assert.match(input.system,/NOT currently active settings/);
        return {data:{equivalent:true,difference:''},usage};
      }
      extractionAttempts++;
      if(extractionAttempts===1)return {data:{understood:false,summary:'',changes:[],
        clarifyingQuestion:'Should I return an empty changes array for approval?',unsupportedReason:''},usage};
      assert.match(JSON.parse(input.prompt).correction,/still requires the proposed typed change/);
      return {data:{understood:true,summary:'Prepare a Main Warehouse reorder point of eight',
        clarifyingQuestion:'',unsupportedReason:'',changes:[change('replenishment',
          {sku:'RULE-1',location:'Main Warehouse',reorderPoint:8})]},usage};
    }});
    const prepared=await require('../../src/manager/postgres-operating-instructions').interpret(database,ctx,
      'Prepare to change the reorder point for RULE-1 at Main Warehouse to 8; do not apply until I approve.',
      {provider:recoveringProvider,instructionUsageKey:'prepare-only-rule'});
    assert.equal(extractionAttempts,2);
    assert.equal(prepared.status,'PENDING');
    assert.equal(Number((await database.query(`SELECT reorder_point FROM reorder_policies
      WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
    [ctx.workspaceId,item.skuIds[0],locationId])).rows[0].reorder_point),4);
    await page.goto(`${base}/operating-instructions/${prepared.id}?from=ask`);
    await Promise.all([page.waitForURL(/\/ask(?:#latest)?$/),page.getByRole('button',{name:'Discard'}).click()]);
    assert.match(await page.locator('main').innerText(),/Ask StockChief/);
    assert.equal(Number((await database.query(`SELECT reorder_point FROM reorder_policies
      WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
    [ctx.workspaceId,item.skuIds[0],locationId])).rows[0].reorder_point),4);
    await page.goto(`${base}/inventory/${item.itemId}`);
    assert.match(await page.locator('main').innerText(),/Main Warehouse: reorder at 4, up to 15/);
    await page.getByRole('link',{name:'Reorder settings'}).click();
    assert.match(page.url(),/\/purchasing\/why\//);
    assert.match(await page.locator('main').innerText(),/Main Warehouse\s+4\s+15/);
    assert.match(await page.locator('main').innerText(),/All locations\s+8\s+20/);
    let interpretations=0;
    const mixedProvider=require('../helpers/postgres-model-fixture').fixture({async complete(request){
      if(request.schemaName==='postgres_operating_instruction'){
        interpretations++;
        return {data:{understood:true,summary:'Warn and replenish this warehouse',clarifyingQuestion:'',
          unsupportedReason:'',changes:[change('replenishment',
            {sku:'RULE-1',location:'Main Warehouse',reorderPoint:5,targetStock:18}),
          ...(interpretations>1?[change('stock_alert',{sku:'RULE-1',location:'Main Warehouse',
            notificationThreshold:5,notificationMetric:'on_hand',notificationComparator:'at_or_below'})]:[])]},
        usage:{provider:'fixture-ai',model:'fixture-model',inputTokens:40,outputTokens:20}};
      }
      const effects=JSON.parse(request.prompt).enforcedEffects;
      return {data:{equivalent:effects.length===2,
        difference:effects.length===2?'':'A Needs You warning is missing.'},
      usage:{provider:'fixture-ai',model:'fixture-model',inputTokens:20,outputTokens:10}};
    }});
    const mixed=await require('../../src/manager/postgres-operating-instructions').interpret(database,ctx,
      'Set a warehouse-specific reorder target and warn me in Needs You at five on hand.',
      {provider:mixedProvider,instructionUsageKey:'combined-scoped-rule'});
    assert.equal(interpretations,2);
    assert.deepEqual(mixed.resolvedChanges.map((entry)=>entry.domain),['replenishment','stock_alert']);
    const approvedMixed=await require('../../src/manager/postgres-operating-instructions').approve(database,ctx,mixed.id,mixed.integrityHash);
    assert.equal(Number((await database.query(`SELECT threshold FROM stockchief_runtime.stock_threshold_rules
      WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,item.skuIds[0],locationId])).rows[0].threshold),5);
    const correctionProvider=require('../helpers/postgres-model-fixture').fixture({async complete(request){
      if(request.schemaName==='postgres_operating_instruction')return {data:{understood:true,
        summary:'Change only the alert',clarifyingQuestion:'',unsupportedReason:'',changes:[
          change('replenishment',{sku:'RULE-1',location:'Main Warehouse',reorderPoint:5,targetStock:18}),
          change('stock_alert',{sku:'RULE-1',location:'Main Warehouse',notificationThreshold:2,
            notificationMetric:'on_hand',notificationComparator:'at_or_below'})]},
      usage:{provider:'fixture-ai',model:'fixture-model',inputTokens:40,outputTokens:20}};
      const effects=JSON.parse(request.prompt).enforcedEffects;
      assert.equal(effects.length,1);assert.match(effects[0],/at or below 2/);
      return {data:{equivalent:true,difference:''},
        usage:{provider:'fixture-ai',model:'fixture-model',inputTokens:20,outputTokens:10}};
    }});
    const onlyAlert=await require('../../src/manager/postgres-operating-instructions').interpret(database,ctx,
      'Change only that warning to two; keep the reorder point and target unchanged.',
      {provider:correctionProvider,priorInstruction:approvedMixed,instructionUsageKey:'alert-only-correction'});
    assert.deepEqual(onlyAlert.resolvedChanges.map((entry)=>entry.domain),['stock_alert']);
    await require('../../src/manager/postgres-operating-instructions').approve(database,ctx,onlyAlert.id,onlyAlert.integrityHash);
    assert.equal(Number((await database.query(`SELECT reorder_point FROM reorder_policies
      WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,item.skuIds[0],locationId])).rows[0].reorder_point),5);
    const currentPage=await require('../../src/assistant/postgres-page-context').load(database,ctx.workspaceId,
      `/inventory/${item.itemId}`);
    const contextual=await require('../../src/manager/postgres-operating-instructions').interpret(database,ctx,
      'Set the reorder point to 4 units for this product.',{provider:require('../helpers/postgres-model-fixture').fixture(provider),
        currentPage,instructionUsageKey:'contextual-reorder-rule'});
    assert.equal(contextual.resolvedChanges[0].skuCode,'RULE-1');
    assert.equal(Number(contextual.resolvedChanges[0].reorderPoint),4);
    const approved=await require('../../src/manager/postgres-operating-instructions').get(database,
      ctx.workspaceId,(await database.query(`SELECT id FROM operating_instruction_proposals
        WHERE workspace_id=$1 AND status='APPROVED' ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId])).rows[0].id);
    const correction=await require('../../src/manager/postgres-operating-instructions').interpret(database,ctx,
      'Change that reorder point to 6; keep the same product.',
      {provider:require('../helpers/postgres-model-fixture').fixture(provider),
        priorInstruction:approved,instructionUsageKey:'contextual-rule-correction'});
    assert.equal(correction.resolvedChanges[0].skuCode,'RULE-1');
    assert.equal(Number(correction.resolvedChanges[0].reorderPoint),6);
    const supplierTerms=(await database.query(`SELECT lead_time_days,minimum_order_quantity FROM supplier_items
      WHERE workspace_id=$1 AND sku_id=$2`,[ctx.workspaceId,item.skuIds[0]])).rows[0];
    assert.equal(Number(supplierTerms.lead_time_days),12);
    assert.equal(Number(supplierTerms.minimum_order_quantity),4);
    const stockGuard=(await database.query(`SELECT enforcement_mode,comparator,threshold,release_condition
      FROM operating_guards WHERE workspace_id=$1 AND sku_id=$2 AND is_active=1`,
    [ctx.workspaceId,item.skuIds[0]])).rows[0];
    assert.deepEqual({mode:stockGuard.enforcement_mode,comparator:stockGuard.comparator,
      threshold:Number(stockGuard.threshold),release:stockGuard.release_condition},
    {mode:'block',comparator:'below',threshold:2,release:'stock_recovered'});
    const automationPolicies=(await database.query(`SELECT allowed_action_types,maximum_quantity,maximum_value,thresholds
      FROM automation_policies WHERE workspace_id=$1 AND enabled=1 AND approved_at IS NOT NULL ORDER BY created_at`,[ctx.workspaceId])).rows;
    assert.equal(automationPolicies.length,2);assert.deepEqual(automationPolicies.map((row)=>json(row.allowed_action_types)),[['transfer'],['approve_purchase_order']]);
    assert.equal(Number(automationPolicies[0].maximum_quantity),5);assert.equal(Number(automationPolicies[1].maximum_value),500);
    assert.equal(Number(json(automationPolicies[1].thresholds).maxValuePerWeek),1500);
    assert.equal((await database.query(`SELECT mode FROM workspace_autopilot WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0].mode,
      'POLICY_AUTOMATED');
    assert.equal(JSON.parse((await database.query(`SELECT value FROM operational_preferences WHERE workspace_id=$1
      AND key='prefer_transfer_before_purchasing'`,[ctx.workspaceId])).rows[0].value),true);
    await page.goto(`${base}/what-you-told-me`);const transcript=await page.locator('main').innerText();
    assert.match(transcript,/Rule Widget.*reorder at 8/);
    assert.match(transcript,/2 standing rules/);
    await page.goto(`${base}/operating-instructions/${correction.id}?from=ask`);
    await Promise.all([page.waitForURL(/\/ask(?:\?.*)?(?:#latest)?$/),
      page.getByRole('button',{name:'Discard'}).click()]);
    assert.match(await page.locator('main').innerText(),/Ask StockChief/);
    assert.deepEqual(errors,[]);
  });
