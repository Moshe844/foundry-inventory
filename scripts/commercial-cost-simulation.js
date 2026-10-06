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
const askPrompts=[
 'How much inventory is available across locations?',
 'Show open purchase orders and unpaid supplier bills.',
 'Which sales orders still need fulfillment?',
 'What products need replenishment soon and why?',
 'Which committed orders could be delayed by low stock?',
 'Compare available stock with open customer demand for the next week.',
 'Summarize current stock risk, open purchasing, and warehouse commitments.',
 'Explain the most important inventory exceptions an owner should review today.',
];
const instructionPrompts=[
 'For WIDGET-1 set reorder point to 8, target stock to 30 and safety stock to 4.',
 'Reliable Supply takes 7 days to supply WIDGET-2. Its minimum order is 12 units and order multiple is 6.',
 'For WIDGET-3 set reorder point to 12 and target stock to 48.',
 'For WIDGET-4 set safety stock to 5 and reorder point to 14.',
 'Reliable Supply takes 11 days to supply WIDGET-5. Its minimum order is 20 units.',
 'For WIDGET-6 set target stock to 80 and safety stock to 10.',
 'For WIDGET-7 set reorder point to 18, target stock to 60 and safety stock to 9.',
];
const importTexts=Array.from({length:7},(_,index)=>`SKU,Product name,Field X,Field Y\nNEW-${index}-1,Canvas Bag,24,Heavy duty canvas\nNEW-${index}-2,Tool Pouch,12,Waxed cotton\nNEW-${index}-3,Storage Bin,8,Stackable bin`);
function distribution(values){if(!values.length)return {count:0,medianUsd:null,p90Usd:null,p95Usd:null,maxUsd:null};
 const sorted=[...values].sort((a,b)=>a-b);const percentile=p=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)];
 return {count:sorted.length,medianUsd:percentile(.5),p90Usd:sorted.length>=10?percentile(.9):null,
  p95Usd:sorted.length>=20?percentile(.95):null,maxUsd:sorted.at(-1)};}
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
    costPerUnitMinor:rates[i]*100/1e6,effectiveFrom:new Date().toISOString(),source:`Verified public global API price: ${SOURCE}`,
    pricingBasis:'VERIFIED_PUBLIC',confidence:'HIGH'});
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
    ...askPrompts.map((prompt,index)=>({operation:'ask',key:`sample-ask-${index+1}`,
      call:()=>assistant.ask(db,ctx,prompt,{provider:fast(),usageKey:`sample-ask-${index+1}`})})),
    ...instructionPrompts.map((prompt,index)=>({operation:'instruction',key:`sample-instruction-${index+1}`,
      call:()=>instructions.interpret(db,ctx,prompt,{provider:standard(),instructionUsageKey:`sample-instruction-${index+1}`})})),
    ...importTexts.map((value,index)=>({operation:'import_mapping',key:`sample-import-${index+1}`,
      call:()=>imports.analyse(db,ctx,{filename:`ambiguous-catalog-${index+1}.csv`,usageKey:`sample-import-${index+1}`,
       provider:fast(),text:value})})),
   ];
   for(const {operation,key,call} of calls){const start=Date.now();let outcome='SUCCESS';let errorCode=null;
    let result;try{result=await call();}catch(error){outcome='FAILED';errorCode=error.code||'unclassified_error';}
    if(operation==='import_mapping'&&result?.transformations?.aiUsed!==true){outcome='DETERMINISTIC_ONLY';
      errorCode='MODEL_SAMPLE_NOT_INVOKED';}
    samples.push({operation,key,outcome,errorCode,latencyMs:Date.now()-start});
    console.log(`  ${operation}: ${outcome}, ${Date.now()-start} ms`);}
   if(process.argv.includes('--stress-prompts')&&profile.plan==='pro'){
    // Exercise the real 500-SKU instruction context limit with unusually long
    // catalogue labels. This is a bounded synthetic tail probe, not an actual
    // customer-demand percentile or a change to any production inventory.
    await db.query(`UPDATE items SET name=left(name||repeat(' extended industrial specification',5),160)
      WHERE workspace_id=$1`,[ctx.workspaceId]);
    for(let index=0;index<3;index++){
     const key=`sample-instruction-stress-${index+1}`;const start=Date.now();let outcome='SUCCESS';let errorCode=null;
     try{await instructions.interpret(db,ctx,instructionPrompts[index],
       {provider:standard(),instructionUsageKey:key});}
     catch(error){outcome='FAILED';errorCode=error.code||'unclassified_error';}
     samples.push({operation:'instruction',key,outcome,errorCode,latencyMs:Date.now()-start,
       syntheticLongCatalogue:true});
     console.log(`  instruction long-catalogue stress: ${outcome}, ${Date.now()-start} ms`);
    }
   }
   if(process.argv.includes('--policy-tail')&&profile.plan==='pro'){
    // Deliberately skew toward the expensive, failure-prone production
    // interpretation path. This is a tail probe, not a customer percentile.
    await db.query(`UPDATE items SET name=left(name||repeat(' extended industrial specification',2),90)
      WHERE workspace_id=$1`,[ctx.workspaceId]);
    const varied=Array.from({length:24},(_,index)=>{
      const sku=index%40+1;const point=8+index%17;const target=point*3;
      return index<18
        ?`For WIDGET-${sku}, set reorder point to ${point}, target stock to ${target}, and safety stock to ${Math.max(2,Math.floor(point/3))}. Reliable Supply takes ${5+index%12} days to supply it and its minimum order is ${6+index%8} units.`
        :`For WIDGET-${sku}, automatically understand every future supplier contract, negotiate new prices with Reliable Supply and send legally binding acceptance without owner review.`;
    });
    for(const [index,prompt] of varied.entries()){
      const key=`sample-policy-tail-${index+1}`;const start=Date.now();let outcome='SUCCESS';let errorCode=null;
      try{await instructions.interpret(db,ctx,prompt,{provider:standard(),instructionUsageKey:key});}
      catch(error){outcome='FAILED';errorCode=error.code||'unclassified_error';}
      samples.push({operation:'instruction',key,outcome,errorCode,latencyMs:Date.now()-start,
        syntheticLongCatalogue:true,tailProbe:true});
      console.log(`  policy tail ${index+1}: ${outcome}, ${Date.now()-start} ms`);
    }
    for(let index=0;index<4;index++){
      const key=`sample-ask-large-${index+1}`;const start=Date.now();let outcome='SUCCESS';let errorCode=null;
      const prompt=`Which inventory items need attention this week? Context ${'stock movement and supplier lead time; '.repeat(250+index*150)}`;
      try{await assistant.ask(db,ctx,prompt,{provider:fast(),usageKey:key});}
      catch(error){outcome='FAILED';errorCode=error.code||'unclassified_error';}
      samples.push({operation:'ask',key,outcome,errorCode,latencyMs:Date.now()-start,
        syntheticLargeContext:true,tailProbe:true});
      console.log(`  Ask large context ${index+1}: ${outcome}, ${Date.now()-start} ms`);
    }
    for(let index=0;index<4;index++){
      const key=`sample-import-wide-${index+1}`;const start=Date.now();let outcome='SUCCESS';let errorCode=null;
      const columns=['Product code',...Array.from({length:35+index*15},(_,column)=>`Field ${column+1}`)];
      const row=['WIDE-1',...columns.slice(1).map((_,column)=>String(column+index))];
      let result;try{result=await imports.analyse(db,ctx,{filename:`wide-${index}.csv`,usageKey:key,
        provider:fast(),text:`${columns.join(',')}\n${row.join(',')}`});}
      catch(error){outcome='FAILED';errorCode=error.code||'unclassified_error';}
      if(result?.transformations?.aiUsed!==true){outcome='DETERMINISTIC_ONLY';errorCode='MODEL_SAMPLE_NOT_INVOKED';}
      samples.push({operation:'import_mapping',key,outcome,errorCode,latencyMs:Date.now()-start,
        syntheticWideImport:true,tailProbe:true});
      console.log(`  import wide ${index+1}: ${outcome}, ${Date.now()-start} ms`);
    }
   }
   const costRows=(await db.query(`SELECT provider,model,provider_version,operation,unit,quantity,amount_minor,currency,idempotency_key,
     detail,occurred_at FROM commercial_cost_events WHERE account_id=$1 ORDER BY occurred_at`,[business.accountId])).rows;
   const usageRows=(await db.query(`SELECT meter,units,status,detail,occurred_at FROM commercial_usage_events
     WHERE account_id=$1 ORDER BY occurred_at`,[business.accountId])).rows;
   const measured={};
   for(const operation of Object.keys(profile.monthly)){
    const rows=costRows.filter(row=>row.detail.operation===operation);
    const credits=usageRows.filter(row=>row.detail.operation===operation&&row.status==='COMMITTED').reduce((sum,row)=>sum+Number(row.units),0);
    const operationSamples=samples.filter(sample=>sample.operation===operation);
    const sampleCount=operationSamples.length;
    const missing=rows.filter(row=>row.amount_minor===null).length;
    const costUsd=missing||!rows.length?null:rows.reduce((sum,row)=>sum+Number(row.amount_minor),0)/100;
    const sampleCosts=operationSamples.map(sample=>{const entries=rows.filter(row=>row.idempotency_key.startsWith(`${ctx.workspaceId}:${sample.key}:`));
      const missingRate=entries.some(row=>row.amount_minor===null);return {...sample,
       modelBacked:entries.length>0,costUsd:missingRate?null:entries.reduce((sum,row)=>sum+Number(row.amount_minor),0)/100,
       missingRate};});
    const backed=sampleCosts.filter(sample=>sample.modelBacked&&sample.costUsd!==null);
    measured[operation]={sampleCount,modelBackedSampleCount:backed.length,committedCredits:credits,missingCostRates:missing,
      realModelCostUsd:costUsd,costUsdPerAttempt:costUsd===null?null:costUsd/sampleCount,
      costUsdPerCommittedCredit:costUsd===null||!credits?null:costUsd/credits,
      modelBackedDistribution:distribution(backed.map(sample=>sample.costUsd)),sampleCosts};
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
