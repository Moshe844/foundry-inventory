'use strict';
const policy=require('../commercial/agent-plan'),time=require('../lib/business-time'),dates=require('../accounting/customer-money');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const rights=require('../actions/permissions');
const pricing=require('../pricing/postgres-promotions');
const abc=require('./monthly-product-classes');
const exact=require('../domain/exact-quantity');
const monthOfDay="date_trunc('month',$3::date)::date";

async function authorize(c,ctx,operation){
  const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,150,operation);
  const member=(await c.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  rights.assertCan(member,rights.MANAGE_REPLENISHMENT,'manage safety stock');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(c,ctx);
  return {account,member};
}

async function estimate(c,ctx,{skuId,locationId,serviceLevel}){
  const goal=Number(serviceLevel);
  if(!Number.isInteger(goal)||goal<1||goal>100)throw new ValidationError('Choose the percentage of lead-time periods you want stock to cover, from 1 to 100.');
  const positions=await require('../purchasing/postgres-replenishment-state').rows(c,ctx.workspaceId,{onlySkuIds:[skuId]});
  const position=positions.find(r=>r.sku_id===skuId&&r.location_id===locationId&&!r.planning_suppressed);
  if(!position)throw new ValidationError('Choose an active SKU and location with its own planning position.');
  const stock=(await c.query('SELECT unit_label,quantity_precision,quantity_increment FROM items WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,position.item_id])).rows[0];
  const precision=Number(stock.quantity_precision);
  const atoms=value=>{
    const [whole,fraction='']=exact.canonical(value,{scale:precision}).split('.');
    return BigInt(whole+fraction.padEnd(precision,'0'));
  };
  const lead=Math.ceil(require('../purchasing/replenishment-decision').derive(position).lead);
  if(lead<1||lead>90)throw new ValidationError('Safety-stock estimates need a lead time between 1 and 90 days.');
  const {calendarDate:today,timeZone}=await time.forWorkspace(c,ctx.workspaceId),start=dates.addDays(today,-180);
  const bounds=[ctx.workspaceId,skuId,locationId,time.dayBoundary(start,timeZone),time.dayBoundary(today,timeZone),timeZone];
  // Rebuild by business event time. Posting-order balances can contain later
  // events when a user backdates a receipt. Exclude any day with a stockout.
  const {rows}=await c.query(`WITH opening AS (
    SELECT coalesce(sum(quantity_delta),0) AS quantity FROM movements WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 AND occurred_at::timestamptz<$4
  ), running AS (
    SELECT (occurred_at::timestamptz AT TIME ZONE $6)::date AS day,operation,reason_code,quantity_delta,
      (SELECT quantity FROM opening)+sum(quantity_delta) OVER(ORDER BY occurred_at::timestamptz,seq) AS balance
    FROM movements WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 AND occurred_at::timestamptz>=$4 AND occurred_at::timestamptz<$5
  ), daily AS (
    SELECT day,sum(quantity_delta) AS change,min(balance) AS low,coalesce(sum(-quantity_delta) FILTER(WHERE operation='issue' AND reason_code IN ('sale','sold')),0) AS sold
    FROM running GROUP BY day
  ), days AS (
    SELECT g::date AS day FROM generate_series(($4::timestamptz AT TIME ZONE $6)::date,(($5::timestamptz AT TIME ZONE $6)::date-1),interval '1 day') g
  ) SELECT coalesce(d.sold,0) AS sold,least(coalesce(d.low,'Infinity'::numeric),
    (SELECT quantity FROM opening)+coalesce(sum(d.change) OVER(ORDER BY days.day ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))>0 AS stocked
    FROM days LEFT JOIN daily d USING(day) ORDER BY days.day`,bounds);
  const support=[],sales=rows.map(r=>atoms(r.sold));let total=0n,unstocked=0;
  for(let i=0;i<rows.length;i++){
    total+=sales[i];if(!rows[i].stocked)unstocked++;
    if(i>=lead){total-=sales[i-lead];if(!rows[i-lead].stocked)unstocked--;}
    if(i>=lead-1&&!unstocked)support.push(total);
  }
  if(support.length<20||support.filter(n=>n>0n).length<2)throw new ValidationError('More stocked sales history is needed. This estimate needs 20 fully stocked lead-time periods and sales in at least two of them.');
  support.sort((a,b)=>a<b?-1:a>b?1:0);
  const sold=support.reduce((sum,n)=>sum+n,0n),rank=support[Math.ceil(support.length*goal/100)-1];
  const windows=BigInt(support.length),step=atoms(stock.quantity_increment);
  const difference=rank*windows-sold,divisor=step*windows;
  const amount=difference<=0n?0n:(difference+divisor-1n)/divisor*step;
  const units=Number(exact.fromAtoms(Number(amount),precision));
  const average=Number(sold)/10**precision/support.length;
  const percentile=Number(exact.fromAtoms(Number(rank),precision));
  const current=position.safety_stock==null?null:Number(position.safety_stock);
  const answer={skuId,locationId,code:position.code,location:position.location_name,serviceLevel:goal,lead,assumedLead:position.lead_time_assumed===true,
    windows:support.length,mean:Number(average.toFixed(4)),percentile,units,current,today,unit:stock.unit_label};
  return {...answer,digest:pricing.hash(answer)};
}

async function preview(db,ctx,input){await authorize(db,ctx,'draft');return estimate(db,ctx,input);}

async function classPlanning(db,ctx,itemId,input){
  const product=await abc.productForPlanning(db,ctx,itemId);
  const page=Number(input.page||1);
  if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid results page.');
  const {rows}=await db.query(`WITH variants AS MATERIALIZED (
    SELECT id,code FROM skus WHERE workspace_id=$1 AND item_id=$2 AND is_active=1
  ), positions AS (
    SELECT b.sku_id,b.location_id FROM balances b JOIN variants s ON s.id=b.sku_id WHERE b.workspace_id=$1
    UNION
    SELECT p.sku_id,p.location_id FROM reorder_policies p JOIN variants s ON s.id=p.sku_id WHERE p.workspace_id=$1 AND p.location_id IS NOT NULL
  ) SELECT s.id AS sku_id,s.code,l.id AS location_id,l.name AS location,p.safety_stock,
    r.service_level
    FROM positions x JOIN variants s ON s.id=x.sku_id
    JOIN locations l ON l.workspace_id=$1 AND l.id=x.location_id AND l.is_active=1 AND l.custody_agreement_id IS NULL
    LEFT JOIN reorder_policies p ON p.workspace_id=$1 AND p.sku_id=s.id AND p.location_id=l.id
    LEFT JOIN stockchief_runtime.class_service_levels r ON r.workspace_id=$1 AND r.class=$3 AND r.location_id=l.id AND r.authorized_by=$4
    ORDER BY lower(s.code),s.id,lower(l.name),l.id LIMIT 101 OFFSET $5`,[ctx.workspaceId,itemId,product.category,ctx.actorId,(page-1)*100]);
  const positions=rows.slice(0,100),model={product,positions,page,more:rows.length>100,selected:null,result:null,hold:null};
  if(!input.position)return model;
  const selected=positions.find(p=>JSON.stringify([p.sku_id,p.location_id])===input.position);
  if(!selected)throw new ValidationError('Choose a SKU and location from this product’s current page.');
  model.selected=selected;
  if(!['A','B','C'].includes(product.category)){
    model.hold='A verified current ABC class is needed for class-based safety planning.';
    return model;
  }
  const serviceLevel=input.serviceLevel||selected.service_level;
  if(!serviceLevel)return model;
  try{
    model.result=await estimate(db,ctx,{skuId:selected.sku_id,locationId:selected.location_id,serviceLevel});
  }catch(error){
    if(!(error instanceof ValidationError))throw error;
    model.hold=error.message;
  }
  return model;
}

async function apply(c,ctx,result){
  if(result.current===result.units)return;
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ctx.workspaceId,result.skuId,result.locationId])]);
  const prior=(await c.query('SELECT id,safety_stock FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE',[ctx.workspaceId,result.skuId,result.locationId])).rows[0];
  if((prior?.safety_stock==null?null:Number(prior.safety_stock))!==result.current)throw new ValidationError('Safety stock changed. Review the current estimate.');
  const at=nowIso(),note='Safety stock for '+result.serviceLevel+'% of observed lead-time periods';
  if(prior)await c.query("UPDATE reorder_policies SET safety_stock=$3,notes=$4,source='foundry',updated_at=$5 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,prior.id,result.units,note,at]);
  else await c.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,safety_stock,notes,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'foundry',$7,$7)`,[newId('rpol'),ctx.workspaceId,result.skuId,result.locationId,result.units,note,at]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Updated safety stock from service level',reference:result.skuId,before:{safetyStock:result.current},after:result});
}
async function approve(db,ctx,input){
  return db.transaction(async c=>{
    const {account}=await authorize(c,ctx,'draft'),stop=await policy.stopped(c,ctx.workspaceId,account,'planning.safety_stock',false);
    if(stop)throw new ValidationError(stop);
    const result=await estimate(c,ctx,input);
    if(result.digest!==input.digest){
      if(result.current===result.units&&(await c.query(`SELECT 1 FROM security_event_history WHERE workspace_id=$1 AND actor_id=$2
        AND action='Updated safety stock from service level' AND reference=$3 AND after_state->>'digest'=$4 AND after_state->>'locationId'=$5`,
        [ctx.workspaceId,ctx.actorId,input.skuId,input.digest,input.locationId])).rowCount)return result;
      throw new ValidationError('The sales history or safety-stock setting changed. Review the current estimate.');
    }
    await apply(c,ctx,result);return result;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function setClassRule(db,ctx,input){
  return db.transaction(async c=>{
    if(!await lockOwner(c,ctx))throw new AuthorizationError('Only the current owner can authorize automatic safety stock.');
    const args=[ctx.workspaceId,input.locationId,input.class];
    if(input.remove==='1'){
      const removed=await c.query('DELETE FROM stockchief_runtime.class_service_levels WHERE workspace_id=$1 AND location_id=$2 AND class=$3 RETURNING service_level',args);
      if(removed.rowCount)await require('../operations/postgres-security-audit').record(c,ctx,{action:'Removed class service level',reference:input.locationId,before:{class:input.class,serviceLevel:removed.rows[0].service_level}});
      return;
    }
    await authorize(c,ctx,'automatic');
    const goal=Number(input.serviceLevel);
    if(!['A','B','C'].includes(input.class)||!Number.isInteger(goal)||goal<1||goal>100)throw new ValidationError('Choose an ABC class and a service level from 1 to 100.');
    if(!(await c.query('SELECT 1 FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL FOR SHARE',args.slice(0,2))).rowCount)
      throw new ValidationError('Choose an active location from this inventory.');
    const present=await c.query('SELECT 1 FROM stockchief_runtime.class_service_levels WHERE workspace_id=$1 AND location_id=$2 AND class=$3',args);
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],present.rowCount?0:1);
    const saved=await c.query(`INSERT INTO stockchief_runtime.class_service_levels(workspace_id,location_id,class,service_level,revision,authorized_by)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,location_id,class) DO UPDATE SET service_level=$4,revision=$5,authorized_by=$6
      WHERE class_service_levels.service_level<>$4 OR class_service_levels.authorized_by<>$6`,[...args,goal,newId('service'),ctx.actorId]);
    if(saved.rowCount)await require('../operations/postgres-security-audit').record(c,ctx,{action:'Authorized class service level',reference:input.locationId,after:{class:input.class,serviceLevel:goal}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function lockOwner(c,ctx){
  const owner=(await c.query(`SELECT a.id FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id
    JOIN users u ON u.workspace_id=w.id AND u.account_id=a.id AND u.id=$2 AND u.role='owner'
    WHERE w.id=$1 AND w.deletion_requested_at IS NULL FOR SHARE OF w,a,u`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!owner)return false;
  await c.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE',[owner.id]);
  await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR NO KEY UPDATE',[ctx.workspaceId]);
  return true;
}

async function queuePage(db,workspaceId,skuIds){
  if(!skuIds.length)return;
  const enabled=await db.query('SELECT 1 FROM stockchief_runtime.class_service_levels WHERE workspace_id=$1 LIMIT 1',[workspaceId]);
  if(!enabled.rowCount)return;
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,150,'automatic')||
    await policy.stopped(db,workspaceId,account,'planning.safety_stock',true))return;
  const day=await time.today(db,workspaceId);
  const {rows}=await db.query(`SELECT r.revision,r.location_id,r.class,s.id FROM stockchief_runtime.class_service_levels r
    JOIN workspace_autopilot a ON a.workspace_id=r.workspace_id AND a.mode='POLICY_AUTOMATED' AND a.paused=0 AND a.suspended=0
    JOIN workspaces w ON w.id=r.workspace_id AND w.deletion_requested_at IS NULL
    JOIN users u ON u.workspace_id=w.id AND u.account_id=w.owner_account_id AND u.id=r.authorized_by AND u.role='owner'
    JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id AND l.is_active=1 AND l.custody_agreement_id IS NULL
    JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=ANY($2::text[]) AND s.is_active=1
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    ${abc.currentJoins('i.id',monthOfDay)}
    WHERE r.workspace_id=$1 AND ${abc.category}=r.class
      AND EXISTS(SELECT 1 FROM balances b WHERE b.workspace_id=$1 AND b.sku_id=s.id AND b.location_id=r.location_id)
    ORDER BY r.location_id,r.class,s.id`,[workspaceId,skuIds,day]);
  const groups=new Map();
  for(const row of rows){if(!groups.has(row.revision))groups.set(row.revision,[]);groups.get(row.revision).push(row.id);}
  for(const [revision,ids] of groups)for(let n=0;n<ids.length;n+=10){
    const part=ids.slice(n,n+10),key=pricing.hash([revision,day,part]);
    await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:'planning.class-safety-stock',idempotencyKey:'safety:'+key,payload:{revision,day,skuIds:part},priority:70,maxAttempts:3});
  }
}
async function processBatch(c,workspaceId,{revision,day,skuIds}){
  if(!Array.isArray(skuIds)||!skuIds.length||skuIds.length>10||day!==await time.today(c,workspaceId))return {skipped:'expired batch'};
  const args=[workspaceId,revision];
  const prior=(await c.query('SELECT authorized_by FROM stockchief_runtime.class_service_levels WHERE workspace_id=$1 AND revision=$2',args)).rows[0];
  const ctx={workspaceId,actorId:prior?.authorized_by};
  if(!prior||!await lockOwner(c,ctx))return {skipped:'authority changed'};
  const rule=(await c.query(`SELECT r.* FROM stockchief_runtime.class_service_levels r
    JOIN workspace_autopilot a ON a.workspace_id=r.workspace_id AND a.mode='POLICY_AUTOMATED' AND a.paused=0 AND a.suspended=0
    JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id AND l.is_active=1 AND l.custody_agreement_id IS NULL
    WHERE r.workspace_id=$1 AND r.revision=$2 FOR UPDATE OF r FOR SHARE OF l`,args)).rows[0];
  if(!rule)return {skipped:'authority changed'};
  const state=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,150,'automatic')||await policy.stopped(c,workspaceId,state,'planning.safety_stock',true))return {skipped:'authority unavailable'};
  await authorize(c,ctx,'automatic');
  await c.query('SELECT workspace_id FROM accounting_settings WHERE workspace_id=$1 FOR SHARE',[workspaceId]);
  const eligible=(await c.query(`SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    ${abc.currentJoins('i.id',monthOfDay)}
    WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND ${abc.category}=$4 AND s.is_active=1 ORDER BY s.id`,
    [workspaceId,skuIds,day,rule.class])).rows;
  if(!eligible.length)return {skipped:'no products in the current authorized class'};
  const held=[];let updated=0;
  for(const {id} of eligible){
    let result;
    try{result=await estimate(c,ctx,{skuId:id,locationId:rule.location_id,serviceLevel:rule.service_level});}
    catch(e){if(!(e instanceof ValidationError))throw e;held.push({skuId:id,reason:e.message});continue;}
    if(result.assumedLead){held.push({skuId:id,reason:'Record a supplier or location lead time before automatic safety-stock changes.'});continue;}
    if(result.current!==result.units){await apply(c,ctx,{...result,abcClass:rule.class,abcMonth:day.slice(0,7)+'-01',ruleRevision:rule.revision});updated++;}
  }
  return {updated,held};
}
module.exports={preview,classPlanning,approve,setClassRule,queuePage,processBatch};
