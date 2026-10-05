'use strict';
// Real model measurements in a disposable PostgreSQL cluster. Never connects
// to DATABASE_URL, creates Stripe prices, enables checkout or changes a customer.
const fs=require('node:fs');const path=require('node:path');
const config=require('../src/config');const {startCluster}=require('../tests/helpers/postgres-cluster');
const {openPostgres}=require('../src/db/postgres');const {migratePostgres}=require('../src/db/migrate-postgres');
const auth=require('../src/domain/postgres-auth-service');const catalog=require('../src/domain/postgres-catalog-service');
const locations=require('../src/domain/postgres-location-service');const commerce=require('../src/operations/postgres-commerce');
const assistant=require('../src/assistant/postgres-service');const instructions=require('../src/manager/postgres-operating-instructions');
const imports=require('../src/imports/postgres-service');const costs=require('../src/commercial/control-service');
const {createProviderUnobserved}=require('../src/ai/provider');const {newId}=require('../src/lib/util');
const SOURCE='https://platform.claude.com/docs/en/about-claude/pricing';
// Verified 2026-10-05, first-party global standard API rates, USD/million tokens.
// Unknown response model IDs fail coverage: no family-name or generic fallback.
const RATES={
 'claude-haiku-4-5-20251001':[1,5,1.25,2,.1],
 'claude-sonnet-5':[2,10,2.5,4,.2],
 'claude-opus-5':[5,25,6.25,10,.5],
};
const profiles=[
 {plan:'starter',skus:100,monthly:{ask:150,instruction:10,import_mapping:2},connectedOperations:1500,listMonthlyUsd:199},
 {plan:'growth',skus:500,monthly:{ask:800,instruction:60,import_mapping:10},connectedOperations:18000,listMonthlyUsd:499},
 {plan:'pro',skus:2000,monthly:{ask:2500,instruction:160,import_mapping:30},connectedOperations:90000,listMonthlyUsd:999},
 {plan:'enterprise',skus:5000,monthly:{ask:8000,instruction:500,import_mapping:100},connectedOperations:300000,listMonthlyUsd:2000},
];
const OPERATIONS=['model_input','model_output','cache_write_5m','cache_write_1h','cache_read'];
async function main(){
 if(!process.argv.includes('--real-model'))throw new Error('Pass --real-model to authorize bounded paid model samples in disposable PostgreSQL.');
 if(!config.ai.configured)throw new Error('The configured production model credential is unavailable.');
 process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE='false';
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString,{applicationName:'commercial-cost-simulation'});
 const report={generatedAt:new Date().toISOString(),evidence:'REAL_MODEL_USAGE_WITH_MODELED_MONTHLY_PROFILES',
   pricingSource:SOURCE,pricingVerifiedAt:'2026-10-05',providerVersion:'2023-06-01',
   checkoutEnabled:false,approvedAllowances:false,approvedPackPrices:false,
   limitations:['Small exploratory sample, not statistically representative production telemetry.',
    'Connected-provider, hosting/compute/storage and email contract costs are unknown, NOT zero.',
    'List subscription prices below are scenario inputs, NOT actual Stripe revenue or certified margins.',
    'No connected merchant provider was called. Real Stripe E2E remains separate.',
    'Enterprise is an illustrative contracted profile; actual contract volumes and price remain unspecified.'],profiles:[]};
 const selected=process.argv.find(argument=>argument.startsWith('--plan='))?.slice(7);
 if(selected&&!profiles.some(profile=>profile.plan===selected))throw new Error('Unknown cost-simulation plan.');
 if(process.argv.includes('--append')){const prior=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../data/commercial-real-cost-simulation.json'),'utf8'));
   if(prior.evidence!==report.evidence||prior.checkoutEnabled!==false)throw new Error('Prior cost evidence is incompatible.');
   report.priorMeasurementAt=prior.generatedAt;report.profiles=prior.profiles.filter(profile=>profile.plan!==selected);}
 try{
  await migratePostgres(db);
  for(const [model,rates] of Object.entries(RATES))for(let i=0;i<OPERATIONS.length;i++)await costs.saveCostRate(db,
   {provider:'anthropic',model,providerVersion:'2023-06-01',operation:OPERATIONS[i],unit:'token',
    costPerUnitMinor:rates[i]*100/1e6,effectiveFrom:new Date().toISOString(),source:`Verified public global API price: ${SOURCE}`});
  for(const profile of profiles.filter(profile=>!selected||profile.plan===selected)){
   console.log(`Measuring ${profile.plan}: ${profile.skus} SKUs; real Ask, instruction and import calls.`);
   const business=await auth.createBusiness(db,{name:'Cost Simulation Owner',businessName:`Simulation ${profile.plan}`,
    email:`cost-${profile.plan}@example.test`,password:'Disposable-simulation-password!'});
   const ctx={workspaceId:business.workspaceId,actorId:business.userId};
   await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,source)
    VALUES($1,$2,$3,'wallet-foundation:'||$3,'COMP','CUSTOM','SIMULATION')`,[newId('sub'),business.accountId,profile.plan]);
   if(profile.plan==='enterprise')await db.query(`INSERT INTO commercial_entitlement_overrides
     (id,account_id,meter,limit_units,reason) VALUES($1,$2,'ai_work_credits',100,'Disposable simulation sample budget, not a customer allowance')`,
     [newId('simulation-budget'),business.accountId]);
   await locations.createLocation(db,ctx,{name:'Main Warehouse',kind:'warehouse'});
   await commerce.createSupplier(db,ctx,{name:'Reliable Supply',email:'supplier@example.test'});
   // Generate the actual catalogue context consumed by production instructions.
   await db.transaction(async(client)=>{for(let i=1;i<=profile.skus;i++)await catalog.createItemInTransaction(client,ctx,
     {name:`Industrial Widget ${i}`,baseCode:`WIDGET-${i}`,trackingMode:'quantity',unitLabel:'unit'});},
    {isolation:'SERIALIZABLE',statementTimeoutMs:120000});
   const samples=[];
   const fast=()=>createProviderUnobserved(config.ai.provider,config.ai.tier('fast'));
   const standard=()=>createProviderUnobserved(config.ai.provider,config.ai.tier('standard'));
   const calls=[
    ['ask',()=>assistant.ask(db,ctx,'How much inventory is available across locations?',{provider:fast(),usageKey:'sample-ask-1'})],
    ['ask',()=>assistant.ask(db,ctx,'Show open purchase orders and unpaid supplier bills.',{provider:fast(),usageKey:'sample-ask-2'})],
    ['ask',()=>assistant.ask(db,ctx,'Which sales orders still need fulfillment?',{provider:fast(),usageKey:'sample-ask-3'})],
    ['instruction',()=>instructions.interpret(db,ctx,'For WIDGET-1 set reorder point to 8, target stock to 30 and safety stock to 4.',
      {provider:standard(),instructionUsageKey:'sample-instruction-1'})],
    ['instruction',()=>instructions.interpret(db,ctx,'Reliable Supply takes 7 days to supply WIDGET-2. Its minimum order is 12 units and order multiple is 6.',
      {provider:standard(),instructionUsageKey:'sample-instruction-2'})],
    ['import_mapping',()=>imports.analyse(db,ctx,{filename:'ambiguous-catalog.csv',usageKey:'sample-import-1',provider:fast(),
      text:'SKU,Product name,Field X,Field Y\nNEW-1,Canvas Bag,24,Heavy duty canvas\nNEW-2,Tool Pouch,12,Waxed cotton\nNEW-3,Storage Bin,8,Stackable bin'})],
   ];
   for(const [operation,call] of calls){const start=Date.now();let outcome='SUCCESS';let errorCode=null;
    let result;try{result=await call();}catch(error){outcome='FAILED';errorCode=error.code||'unclassified_error';}
    if(operation==='import_mapping'&&result?.transformations?.aiUsed!==true){outcome='DETERMINISTIC_ONLY';
      errorCode='MODEL_SAMPLE_NOT_INVOKED';}
    samples.push({operation,outcome,errorCode,latencyMs:Date.now()-start});
    console.log(`  ${operation}: ${outcome}, ${Date.now()-start} ms`);}
   const costRows=(await db.query(`SELECT provider,model,provider_version,operation,unit,quantity,amount_minor,currency,
     detail,occurred_at FROM commercial_cost_events WHERE account_id=$1 ORDER BY occurred_at`,[business.accountId])).rows;
   const usageRows=(await db.query(`SELECT meter,units,status,detail,occurred_at FROM commercial_usage_events
     WHERE account_id=$1 ORDER BY occurred_at`,[business.accountId])).rows;
   const measured={};
   for(const operation of Object.keys(profile.monthly)){
    const rows=costRows.filter(row=>row.detail.operation===operation);
    const credits=usageRows.filter(row=>row.detail.operation===operation&&row.status==='COMMITTED').reduce((sum,row)=>sum+Number(row.units),0);
    const sampleCount=samples.filter(sample=>sample.operation===operation).length;
    const missing=rows.filter(row=>row.amount_minor===null).length;
    const costUsd=missing||!rows.length?null:rows.reduce((sum,row)=>sum+Number(row.amount_minor),0)/100;
    measured[operation]={sampleCount,committedCredits:credits,missingCostRates:missing,
      realModelCostUsd:costUsd,costUsdPerAttempt:costUsd===null?null:costUsd/sampleCount,
      costUsdPerCommittedCredit:costUsd===null||!credits?null:costUsd/credits};
   }
   const modelMonthlyCost=Object.entries(profile.monthly).reduce((sum,[operation,count])=>{
    const rate=measured[operation].costUsdPerAttempt;return sum===null||rate===null?null:sum+rate*count;},0);
   report.profiles.push({...profile,samples,measured,costRows,usageRows,
    extrapolatedMonthlyModelCostUsd:modelMonthlyCost,connectedOperationCostUsd:null,infrastructureCostUsd:null,
    actualStripeRevenueUsd:null,certifiedMonthlyMarginPercent:null,
    scenarios:[.5,1,2].map(multiplier=>({loadMultiplier:multiplier,modelCostUsd:modelMonthlyCost===null?null:modelMonthlyCost*multiplier,
      connectedOperations:profile.connectedOperations*multiplier,totalCostUsd:null,marginPercent:null})),
    recommendedFinalAllowances:null,recommendedFinalPackPrices:null});
  }
 }finally{
  const destination=path.resolve(__dirname,'../data/commercial-real-cost-simulation.json');
  fs.writeFileSync(destination,JSON.stringify(report,null,2));
  console.log(`Measured evidence saved: ${destination}`);
  await db.close();cluster.stop();
 }
}
main().catch(error=>{console.error(error.code||error.name,error.message);process.exitCode=1;});
