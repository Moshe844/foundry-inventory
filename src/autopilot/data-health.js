'use strict';

// Job 200: gives a data health score on day one, with a fix list.
//
// The score runs from 0 to 100: the share of nine checks the active products
// pass (a usable SKU, a unique barcode, a purchase cost, a weight, not a
// duplicate, a supplier, a reorder point, no stock below zero, and a stock
// count in the last year). The worker works it out after each import and
// once a business day, and the owner can ask for a fresh score at any time.
// It shows on its own in Needs you and on its page, with a fix list ordered
// by what matters most. Each fix links to where it is made, most of them to
// job 126's bulk fixes. Working out the score changes no business record, so
// it runs on every plan, during the first 14 days of watching and while
// automatic work is paused.

const policy=require('../commercial/agent-plan');
const jobs=require('../operations/postgres-job-queue');
const health=require('./catalog-health');
const {newId}=require('../lib/util');
const {AuthorizationError}=require('../domain/errors');

const JOB=200,kind='agent.data-health.v1',path='/autopilot/data-health',table='stockchief_runtime.agent_data_health_scores',KEEP=100;
const tx=(db,fn)=>db.transaction(fn,{isolation:'REPEATABLE READ',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});

async function allowed(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  return policy.usesAgentTerms(account)&&policy.permits(account.plan,JOB,'automatic')?account:null;
}

async function owner(db,ctx){
  const found=(await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!found)throw new AuthorizationError('Only the business owner can see the data health score.');
  return policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'automatic');
}

// Works out the score now and keeps it, with the last 100 scores for the trend.
async function refresh(c,workspaceId,reason){
  const s=await health.score(c,workspaceId);
  const row=(await c.query(`INSERT INTO ${table}(id,workspace_id,score,products,checks,reason) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
    [newId('health'),workspaceId,s.score,s.products,JSON.stringify(s.checks),reason])).rows[0];
  await c.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND id IN (SELECT id FROM ${table} WHERE workspace_id=$1
    ORDER BY computed_at DESC,id DESC OFFSET $2)`,[workspaceId,KEEP]);
  return row;
}

async function run(job,database){
  const reason=['IMPORT','DAILY','CHECK'].includes(job.payload?.reason)?job.payload.reason:'DAILY';
  return tx(database,async c=>{
    if(!await allowed(c,job.workspaceId))return {skipped:true};
    const row=await refresh(c,job.workspaceId,reason);
    return {score:row.score,products:row.products};
  });
}

async function enqueue(c,workspaceId,key,reason,priority){
  return {queued:(await jobs.enqueue(scoped(c),{workspaceId,kind,idempotencyKey:key,payload:{reason},priority,maxAttempts:3})).created};
}
// Once a business day through the worker.
async function schedule(c,workspaceId){
  if(!await allowed(c,workspaceId))return {queued:false};
  return enqueue(c,workspaceId,'data-health:day:'+await require('../lib/business-time').today(c,workspaceId),'DAILY',70);
}
// After each import, so the first import gives the day-one score.
async function afterImport(c,workspaceId,importId){
  if(!await allowed(c,workspaceId))return {queued:false};
  return enqueue(c,workspaceId,'data-health:import:'+importId,'IMPORT',55);
}
async function check(db,ctx){
  await owner(db,ctx);
  return db.transaction(c=>enqueue(c,ctx.workspaceId,'data-health:check:'+Math.floor(Date.now()/60000),'CHECK',40));
}

async function latest(db,workspaceId,limit=1){
  return (await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 ORDER BY computed_at DESC,id DESC LIMIT $2`,[workspaceId,limit])).rows;
}

// The fix list: what to fix first, how many products, and where to fix it.
const FIXES={
  stock_ok:{importance:'Urgent',text:n=>n+' '+(n===1?'product shows':'products show')+' stock below zero. Count them so orders and reorders are right.',href:()=>'/autopilot/reviews/stock-exceptions',action:'Find stock problems'},
  code_ok:{importance:'Important',text:n=>n+' '+(n===1?'SKU is':'SKUs are')+' blank, have spaces, use characters sales channels reject or repeat another SKU.',fix:'SKU',action:'Fix SKUs'},
  unique_ok:{importance:'Important',text:n=>n+' '+(n===1?'product looks':'products look')+' like a duplicate of another product.',fix:'MERGE',action:'Merge duplicates'},
  cost_ok:{importance:'Important',text:n=>n+' '+(n===1?'product has':'products have')+' no purchase cost, so margins and stock value are wrong.',fix:'COST',action:'Fill purchase costs'},
  barcode_ok:{importance:'Normal',text:n=>n+' '+(n===1?'product has':'products have')+' no barcode, or share one with another product.',href:()=>'/autopilot/reviews/catalog-health',action:'See these products'},
  weight_ok:{importance:'Normal',text:n=>n+' '+(n===1?'product has':'products have')+' no weight, so shipping costs are guesses.',fix:'WEIGHT',action:'Fill weights'},
  counted_ok:{importance:'Normal',text:n=>n+' '+(n===1?'product has':'products have')+' not been counted in the last year.',href:()=>'/autopilot/reviews/count-priorities',action:'Plan a count'},
  reorder_ok:{importance:'Normal',text:n=>n+' '+(n===1?'product has':'products have')+' no reorder point.',href:()=>'/autopilot/reviews/reorder-settings',action:'Set reorder points'},
  supplier_ok:{importance:'Normal',text:n=>n+' '+(n===1?'product has':'products have')+' no supplier.',href:()=>'/suppliers',action:'Open suppliers'}
};
const levels=['Urgent','Important','Normal'];
function fixList(snapshot,plan){
  // Job 126 prepares bulk fixes from Growth; Starter gets its suggestion.
  const bulk=policy.permits(plan,126,'draft');
  return (snapshot.checks||[]).filter(c=>c.failed>0).map(c=>{const f=FIXES[c.key];return {key:c.key,importance:f.importance,count:c.failed,text:f.text(c.failed),
    href:f.fix?(bulk?require('../catalog/agent-catalog-fixes').path+'?kind='+f.fix:'/autopilot/reviews/catalog-fixes'):f.href(),action:f.action};})
    .sort((a,b)=>levels.indexOf(a.importance)-levels.indexOf(b.importance)||b.count-a.count);
}

async function page(db,ctx){
  const state=await owner(db,ctx);
  let [now,before]=await latest(db,ctx.workspaceId,2);
  // The first visit before the worker has run works the score out at once.
  if(!now){now=await tx(db,c=>refresh(c,ctx.workspaceId,'FIRST'));before=null;}
  const checking=(await db.query(`SELECT 1 FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2 AND status IN ('PENDING','RETRY','RUNNING') LIMIT 1`,
    [ctx.workspaceId,kind])).rowCount>0;
  return {score:now.score,products:now.products,computedAt:now.computed_at,reason:now.reason,checking,
    change:before&&before.products&&now.products?now.score-before.score:null,
    checks:health.CHECKS.map(c=>{const found=now.checks.find(x=>x.key===c.key)||{passed:0,failed:0};
      return {key:c.key,label:c.label,passed:found.passed,failed:found.failed,percent:now.products?Math.round(found.passed*100/now.products):100};}),
    fixes:fixList(now,state.plan)};
}

async function inbox(db,workspaceId){
  if(!await require('../db/schema-installed').has(db,table))return [];
  const account=await allowed(db,workspaceId);
  if(!account)return [];
  const [now]=await latest(db,workspaceId);
  if(!now||!now.products)return [];
  const fixes=fixList(now,account.plan);
  if(!fixes.length)return [];
  return [{kind:'catalog',importance:fixes[0].importance==='Urgent'?'Important':'Needs You',priority:40,grouped:true,
    title:'Data health score: '+now.score+' of 100',
    happened:fixes.length+(fixes.length===1?' fix is':' fixes are')+' listed. First: '+fixes[0].text,
    why:'Complete, correct product data keeps orders, costs, reorders and listings right.',
    recommendation:'Work through the fix list from the top.',href:path,actionLabel:'See the fix list',sourceId:'data-health',at:now.computed_at,createdAt:now.computed_at}];
}

module.exports={JOB,kind,path,run,schedule,afterImport,check,refresh,latest,page,inbox,fixList};
