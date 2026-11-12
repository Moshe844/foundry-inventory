'use strict';
// Job 16: the owner's yearly stocktake rule and the stocktake StockChief runs inside it.
// It plans ahead, freezes the chosen locations on the count date, sends each area's blind
// list to its counter, asks a second counter to recount big differences, posts an area
// whose differences fall under the owner's count limit (job 6), reopens each posted area
// and closes the stocktake when nothing needed the owner. Big differences always wait for
// the owner's sign-off (page 13: "big count differences" need a person). Growth, Ask me
// first and owner-made plans are prepared for the owner, who runs each step.
const {ValidationError,DomainError}=require('../domain/errors');
const policy=require('../commercial/agent-plan'),annual=require('./agent-annual-stocktakes');
const time=require('../lib/business-time'),exact=require('../domain/exact-quantity'),money=require('../domain/currency');
const audit=require('./postgres-security-audit'),{hash}=require('../pricing/postgres-promotions'),{addDays}=require('../accounting/customer-money');
const scoped=c=>({query:c.query.bind(c),transaction:fn=>fn(c)}),jobKind='agent.annual-stocktake.routine.v1';
const T='stockchief_runtime.agent_annual_stocktakes',R='stockchief_runtime.agent_annual_stocktake_rules',TEAMS='stockchief_runtime.agent_annual_count_teams';
// Facts that stop one step and leave it for the owner, never a guess.
const stops=e=>e instanceof DomainError||e?.constraint==='annual_stocktake_freeze';

async function books(c,workspaceId){return (await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[workspaceId])).rows[0]?.base_currency||null;}
async function rule(db,workspaceId,lock=false){return (await db.query(`SELECT r.*,r.count_date::text count_day FROM ${R} r WHERE r.workspace_id=$1${lock?' FOR UPDATE':''}`,[workspaceId])).rows[0]||null;}
function view(r){return r?{title:r.title,countDate:r.count_day,countDays:r.count_days,noticeDays:r.notice_days,locations:r.root_location_ids,counters:r.counter_ids,recountUnits:r.recount_units,recountMinor:r.recount_minor==null?null:Number(r.recount_minor),currency:r.currency}:{};}
function whole(value,min,max,message){const n=Number(String(value??'').trim()===''?NaN:value);if(!Number.isInteger(n)||n<min||n>max)throw new ValidationError(message);return n;}
function nextYear(day){const [y,m,d]=day.split('-').map(Number),last=new Date(Date.UTC(y+1,m,0)).getUTCDate();return (y+1)+'-'+String(m).padStart(2,'0')+'-'+String(Math.min(d,last)).padStart(2,'0');}

// The owner's yearly rule: date, scope (locations, areas and bins), team and recount limits.
async function configure(db,ctx,input){return db.transaction(async c=>{
 await annual.owner(c,ctx);const saved=await rule(c,ctx.workspaceId,true),revision=Number(input.revision||0);
 if(!Number.isSafeInteger(revision)||revision!==(saved?.revision||0))throw new ValidationError('This yearly stocktake rule changed. Reload it before saving.');
 if(input.remove==='yes'){if(saved){await c.query(`DELETE FROM ${R} WHERE workspace_id=$1`,[ctx.workspaceId]);await audit.record(c,ctx,{action:'Yearly stocktake rule removed',reference:ctx.workspaceId,before:view(saved)});}return {removed:true};}
 await policy.requireWorkspaceJob(c,ctx.workspaceId,16,'draft');await require('../commercial/enforcement').workspace(c,ctx.workspaceId,'inventory.counts');
 if(input.confirmed!=='yes')throw new ValidationError('Confirm the yearly stocktake date, locations, team and recount limits.');
 const title=String(input.title||'').trim();if(!title||title.length>160)throw new ValidationError('Name the yearly stocktake in up to 160 characters.');
 const countDays=whole(input.countDays,1,31,'Choose between one and 31 counting days.'),noticeDays=whole(input.noticeDays,0,90,'Choose how many days ahead to plan, from 0 to 90.');
 const dates=await annual.schedule(c,ctx,{countDate:input.countDate,countDays,recountUnits:input.recountUnits,recountValue:input.recountValue});
 if(!dates.countDate)throw new ValidationError('Choose the count date.');if(dates.units===null&&dates.minor===null)throw new ValidationError('Set when a difference needs a recount: a number of units, a value, or both.');
 const scope=await annual.snapshot(c,ctx,{year:Number(dates.countDate.slice(0,4)),title,locationIds:input.ruleLocationIds??input.locationIds,counterIds:input.ruleCounterIds??input.counterIds});
 await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],saved?0:1);
 if(!saved)await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'annual-stocktake-rule:'+ctx.workspaceId,8192,{finished:true});
 await c.query(`INSERT INTO ${R}(workspace_id,authorized_by,enabled,title,count_date,count_days,notice_days,root_location_ids,counter_ids,recount_units,recount_minor,currency) VALUES($1,$2,true,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  ON CONFLICT(workspace_id) DO UPDATE SET authorized_by=EXCLUDED.authorized_by,enabled=true,title=EXCLUDED.title,count_date=EXCLUDED.count_date,count_days=EXCLUDED.count_days,notice_days=EXCLUDED.notice_days,
  root_location_ids=EXCLUDED.root_location_ids,counter_ids=EXCLUDED.counter_ids,recount_units=EXCLUDED.recount_units,recount_minor=EXCLUDED.recount_minor,currency=EXCLUDED.currency,
  revision=${R}.revision+1,last_issue=NULL,updated_at=clock_timestamp()`,[ctx.workspaceId,ctx.actorId,title,dates.countDate,countDays,noticeDays,JSON.stringify(scope.rootIds),JSON.stringify(scope.counterIds),dates.units,dates.minor,dates.currency]);
 await audit.record(c,ctx,{action:'Yearly stocktake rule saved',reference:ctx.workspaceId,before:view(saved),after:{title,countDate:dates.countDate,countDays,noticeDays,locations:scope.rootIds,counters:scope.counterIds,recountUnits:dates.units,recountMinor:dates.minor,currency:dates.currency,positions:scope.positions}});
 return {saved:true};
},{isolation:'SERIALIZABLE',retrySafe:true});}

// Prepare this year's plan from the rule once the planning window opens. Pro and Custom
// plan it to run on their own; Growth, Ask me first or routine work off get a draft for
// the owner. A finished year moves the rule to the same date next year.
async function plan(db,workspaceId,today){return db.transaction(async c=>{
 const r=await rule(c,workspaceId,true);if(!r?.enabled||!r.authorized_by)return null;
 const ctx={workspaceId,actorId:r.authorized_by},key='annual-rule:'+r.count_day;
 const prior=(await c.query(`SELECT id,status FROM ${T} WHERE workspace_id=$1 AND request_key=$2`,[workspaceId,key])).rows[0];
 if(prior){if(!['SIGNED_OFF','STOPPED'].includes(prior.status))return {id:prior.id,replayed:true};const next=nextYear(r.count_day);
  await c.query(`UPDATE ${R} SET count_date=$2,revision=revision+1,last_issue=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1`,[workspaceId,next]);
  await audit.record(c,ctx,{action:'Yearly stocktake moved to next year',reference:prior.id,after:{countDate:next}});return {advanced:next};}
 if(addDays(r.count_day,-r.notice_days)>today)return null;
 if(addDays(r.count_day,r.count_days-1)<today)throw new ValidationError('The planned counting days passed before this stocktake could be planned. Choose a new count date.');
 const input={year:Number(r.count_day.slice(0,4)),title:r.title,locationIds:r.root_location_ids,counterIds:r.counter_ids,requestKey:key,countDate:r.count_day,countDays:r.count_days,recountUnits:r.recount_units==null?'':String(r.recount_units),recountMinor:r.recount_minor,ruleRevision:r.revision};
 let made,alone=true;await c.query('SAVEPOINT annual_rule_plan');
 try{made=await annual.create(scoped(c),ctx,input,{automatic:true,run:true});await c.query('RELEASE SAVEPOINT annual_rule_plan');}
 catch(error){await c.query('ROLLBACK TO SAVEPOINT annual_rule_plan');await c.query('RELEASE SAVEPOINT annual_rule_plan');if(!stops(error))throw error;alone=false;made=await annual.create(scoped(c),ctx,input);}
 await c.query(`UPDATE ${R} SET last_issue=NULL WHERE workspace_id=$1`,[workspaceId]);return {id:made.id,created:true,alone};
},{isolation:'SERIALIZABLE',retrySafe:true});}

// Every automatic step rechecks the owner, plan, shadow, Watch, pause, Ask me first,
// routine mode, saved-rule allowance and that the owner's rule is still on.
async function runner(c,p){
 if(!p.automatic)throw new ValidationError('The owner runs this stocktake.');const ctx={workspaceId:p.workspace_id,actorId:p.owner_id};await annual.authority(c,ctx,true);
 const r=(await c.query(`SELECT enabled,authorized_by FROM ${R} WHERE workspace_id=$1 FOR SHARE`,[p.workspace_id])).rows[0];
 if(!r?.enabled||r.authorized_by!==p.owner_id)throw new ValidationError('The yearly stocktake rule was removed or changed. The owner continues this stocktake.');return ctx;
}
async function attempt(c,p,work){
 await c.query('SAVEPOINT annual_stocktake_step');
 try{const result=await work();await c.query('RELEASE SAVEPOINT annual_stocktake_step');return result;}
 catch(error){await c.query('ROLLBACK TO SAVEPOINT annual_stocktake_step');await c.query('RELEASE SAVEPOINT annual_stocktake_step');if(!stops(error))throw error;await c.query(`UPDATE ${T} SET problem=$3 WHERE workspace_id=$1 AND id=$2`,[p.workspace_id,p.id,error.message]);return null;}
}

// Start on the count date: refresh the plan to today's stock inside the rule's scope,
// freeze the locations and send the blind count lists.
async function start(db,workspaceId,id){return db.transaction(async c=>{
 const p=await annual.header(c,{workspaceId},id,true);if(p.status!=='DRAFT'||!p.automatic)return {status:p.status};const today=await time.today(c,workspaceId);
 if(!p.count_day||p.count_day>today)return {waiting:p.count_day};
 if(p.end_day&&p.end_day<today)throw new ValidationError('The planned counting days passed before the freeze could start. Stop this plan and choose a new count date.');
 const ctx=await runner(c,p),scope=await annual.snapshot(c,ctx,{year:p.scope.year,title:p.scope.title,locationIds:p.scope.rootIds,counterIds:p.scope.counterIds});let current=p;
 if(hash(scope)!==p.plan_hash){
  await c.query(`DELETE FROM ${TEAMS} WHERE workspace_id=$1 AND stocktake_id=$2`,[workspaceId,id]);
  for(const team of scope.teams)await c.query(`INSERT INTO ${TEAMS}(workspace_id,stocktake_id,location_id,counter_id,planned_positions) VALUES($1,$2,$3,$4,$5)`,[workspaceId,id,team.locationId,team.counterId,team.positions]);
  current={...p,...(await c.query(`UPDATE ${T} SET scope=$3,plan_hash=$4,revision=revision+1 WHERE workspace_id=$1 AND id=$2 RETURNING scope,plan_hash,revision`,[workspaceId,id,JSON.stringify(scope),hash(scope)])).rows[0]};
  await audit.record(c,ctx,{action:'Annual stocktake plan refreshed on the count date',reference:id,before:{positions:p.scope.positions,teams:p.scope.teams.length},after:{positions:scope.positions,teams:scope.teams.length}});
 }
 return annual.begin(c,ctx,current,scope,{automatic:true});
},{isolation:'READ COMMITTED',retrySafe:true});}

// Count positions with their difference valued at cost: the posted value once imported,
// otherwise the recorded average cost for a shortfall and the saved purchase cost for extra.
async function positions(c,workspaceId,{stocktakeId=null,campaignId=null,differencesOnly=false}={}){
 return (await c.query(`SELECT t.stocktake_id,l.campaign_id,l.location_id,l.sku_id,loc.name location_name,s.code,i.name product,
  l.before_quantity::text before_quantity,l.before_costed::text before_costed,l.before_value::text before_value,l.counter_quantity::text counter_quantity,
  l.counted_quantity::text counted_quantity,l.cost_delta_minor::text cost_delta_minor,l.applied_at,l.counter_recorded_by,coalesce(l.counter_recorded_name,u.name) counter_name,
  r.first_quantity::text first_quantity,r.first_counter_id,r.first_counter_name,pc.amount_minor::text saved_cost,pc.currency saved_currency
  FROM ${TEAMS} t JOIN warehouse_count_campaign_lines l ON l.workspace_id=t.workspace_id AND l.campaign_id=t.campaign_id
  JOIN locations loc ON loc.workspace_id=l.workspace_id AND loc.id=l.location_id JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  LEFT JOIN users u ON u.workspace_id=l.workspace_id AND u.id=l.counter_recorded_by
  LEFT JOIN stockchief_runtime.agent_annual_recounts r ON r.campaign_id=l.campaign_id AND r.location_id=l.location_id AND r.sku_id=l.sku_id
  LEFT JOIN LATERAL(SELECT p.amount_minor,p.currency FROM sku_purchase_costs p WHERE coalesce(l.counted_quantity,l.counter_quantity)>l.before_quantity AND p.workspace_id=l.workspace_id AND p.sku_id=l.sku_id ORDER BY p.created_at DESC,p.id DESC LIMIT 1)pc ON true
  WHERE t.workspace_id=$1 AND ($2::text IS NULL OR t.stocktake_id=$2) AND ($3::text IS NULL OR t.campaign_id=$3)
   AND (NOT $4 OR r.sku_id IS NOT NULL OR coalesce(l.counted_quantity,l.counter_quantity)<>l.before_quantity)
  ORDER BY loc.name,l.location_id,s.code,l.sku_id`,[workspaceId,stocktakeId,campaignId,differencesOnly])).rows;
}
// "Off by more than N units or $X": a position over either recount limit is big.
function big(p,line,currency){
 if(!line.delta)return false;if(p.recount_units!=null&&Math.abs(line.delta)>Number(p.recount_units))return true;
 return p.recount_minor!=null&&(line.valueMinor==null||p.recount_currency!==currency||Math.abs(line.valueMinor)>Number(p.recount_minor));
}
function enrich(p,row,currency){
 const quantity=row.counted_quantity??row.counter_quantity,out={...row,quantity,recounted:row.first_quantity!=null,delta:null,valueMinor:null};if(quantity==null)return out;
 out.delta=exact.safeNumber(exact.subtract(quantity,row.before_quantity),{signed:true});
 if(row.counted_quantity!=null&&row.cost_delta_minor!=null)out.valueMinor=Number(row.cost_delta_minor);
 else if(out.delta<0)out.valueMinor=exact.canonical(row.before_costed)===exact.canonical(row.before_quantity)?-exact.ratioMinor(Number(row.before_value),-out.delta,row.before_costed):null;
 else if(out.delta>0)out.valueMinor=row.saved_cost!=null&&row.saved_currency===currency?exact.costMinor(out.delta,Number(row.saved_cost)):null;
 else out.valueMinor=0;
 out.big=big(p,out,currency);return out;
}
function status(row){if(row.applied_at)return 'Posted';if(row.quantity==null)return row.recounted?'Being recounted':'Not counted yet';return row.big?'Needs your sign-off':'Ready to post';}
async function differences(db,ctx,p,{limit=null}={}){
 const currency=await books(db,ctx.workspaceId),rows=(await positions(db,ctx.workspaceId,{stocktakeId:p.id,differencesOnly:true})).map(r=>({...enrich(p,r,currency)})).map(r=>({...r,status:status(r)}));
 const waiting=rows.filter(r=>!r.applied_at&&r.quantity!=null),sum=list=>list.reduce((n,r)=>n+(r.valueMinor||0),0);
 const totals={differences:rows.filter(r=>r.delta).length,recounting:rows.filter(r=>r.quantity==null).length,recounted:rows.filter(r=>r.recounted).length,posted:rows.filter(r=>r.applied_at&&r.delta).length,
  needsYou:waiting.filter(r=>r.big).length,unknownValue:rows.filter(r=>r.delta&&r.valueMinor==null).length,postedMinor:sum(rows.filter(r=>r.applied_at)),waitingMinor:sum(waiting),gainMinor:sum(rows.filter(r=>r.valueMinor>0)),lossMinor:sum(rows.filter(r=>r.valueMinor<0))};
 return {rows:limit?rows.slice(0,limit):rows,more:limit?Math.max(0,rows.length-limit):0,totals,currency,hash:hash(waiting.map(r=>[r.location_id,r.sku_id,r.quantity,r.valueMinor]))};
}

async function team(c,workspaceId,campaignId){return (await c.query(`SELECT t.*,s.status sheet FROM ${TEAMS} t JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id WHERE t.workspace_id=$1 AND t.campaign_id=$2`,[workspaceId,campaignId])).rows[0]||null;}
// A second person from the stocktake team who can reach this area counts again; the
// same counter only when nobody else can.
async function recounter(c,p,locationId,firsts,current){
 const members=[...new Set([...(p.scope.counterIds||[]),current].filter(Boolean))].sort(),usable=[];
 for(const id of members){try{await annual.counter(c,{workspaceId:p.workspace_id},id,[locationId]);usable.push(id);}catch(error){if(!stops(error))throw error;}}
 const load=new Map((await c.query(`SELECT k.counter_id,count(*)::int n FROM stockchief_runtime.agent_count_tasks k JOIN ${TEAMS} t ON t.workspace_id=k.workspace_id AND t.campaign_id=k.campaign_id WHERE t.workspace_id=$1 AND t.stocktake_id=$2 AND k.observed_at IS NULL GROUP BY k.counter_id`,[p.workspace_id,p.id])).rows.map(r=>[r.counter_id,r.n]));
 const second=usable.filter(id=>!firsts.has(id)).sort((a,b)=>(load.get(a)||0)-(load.get(b)||0)||a.localeCompare(b));
 if(second.length)return second[0];if(usable.includes(current))return current;if(usable.length)return usable[0];
 throw new ValidationError('Nobody on this stocktake team can still count this area. Reassign the count before asking for a recount.');
}
// Send the chosen positions back for a second blind count. The first count and its
// counter are kept; the recount replaces it on the worksheet once recorded.
async function recount(c,actor,p,t,rows,{automatic}){
 const task=(await c.query('SELECT k.counter_id,k.observed_at,s.status FROM stockchief_runtime.agent_count_tasks k JOIN warehouse_count_campaigns s ON s.workspace_id=k.workspace_id AND s.id=k.campaign_id WHERE k.workspace_id=$1 AND k.campaign_id=$2 FOR UPDATE OF k,s',[p.workspace_id,t.campaign_id])).rows[0];
 if(task?.status!=='DRAFT'||!task.observed_at)throw new ValidationError('Only a finished count that has not been posted can be recounted.');
 const person=await recounter(c,p,t.location_id,new Set(rows.map(r=>r.counter_recorded_by).filter(Boolean)),task.counter_id);
 const list=rows.map(r=>({location_id:r.location_id,sku_id:r.sku_id,quantity:r.quantity,counter:r.counter_recorded_by,name:r.counter_name}));
 await c.query(`INSERT INTO stockchief_runtime.agent_annual_recounts(workspace_id,stocktake_id,campaign_id,location_id,sku_id,first_quantity,first_counter_id,first_counter_name,recounter_id,requested_by,automatic)
  SELECT $1,$2,$3,x.location_id,x.sku_id,x.quantity,x.counter,x.name,$4,$5,$6 FROM jsonb_to_recordset($7::jsonb)x(location_id text,sku_id text,quantity numeric,counter text,name text) ON CONFLICT DO NOTHING`,[p.workspace_id,p.id,t.campaign_id,person,actor.actorId,automatic,JSON.stringify(list)]);
 await c.query(`UPDATE warehouse_count_campaign_lines l SET counter_quantity=NULL,counter_recorded_by=NULL,counter_recorded_name=NULL,counter_recorded_at=NULL,counted_quantity=NULL,unit_cost_minor=NULL,cost_delta_minor=NULL
  FROM jsonb_to_recordset($3::jsonb)x(location_id text,sku_id text) WHERE l.workspace_id=$1 AND l.campaign_id=$2 AND l.location_id=x.location_id AND l.sku_id=x.sku_id AND l.applied_at IS NULL`,[p.workspace_id,t.campaign_id,JSON.stringify(list)]);
 await c.query('UPDATE stockchief_runtime.agent_count_tasks SET counter_id=$3,observed_at=NULL WHERE workspace_id=$1 AND campaign_id=$2',[p.workspace_id,t.campaign_id,person]);
 await c.query(`UPDATE ${TEAMS} SET counter_id=$3 WHERE workspace_id=$1 AND campaign_id=$2`,[p.workspace_id,t.campaign_id,person]);
 await c.query('UPDATE warehouse_count_campaigns SET revision=revision+1 WHERE workspace_id=$1 AND id=$2',[p.workspace_id,t.campaign_id]);
 await c.query(`UPDATE ${T} SET revision=revision+1,problem=NULL WHERE workspace_id=$1 AND id=$2`,[p.workspace_id,p.id]);
 await audit.record(c,actor,{action:automatic?'Annual stocktake recount requested on its own':'Annual stocktake recount requested',reference:p.id,after:{locationId:t.location_id,campaignId:t.campaign_id,positions:list.length,recounter:person,firstCounters:[...new Set(list.map(x=>x.counter).filter(Boolean))]}});
 return {recount:list.length,recounter:person};
}
// An area with no big difference left: it posts when it matches the records, or when its
// differences fall within the owner's count limit (job 6). Otherwise it waits for sign-off.
async function decide(c,owner,p,t,rows){
 if(rows.some(r=>r.big))return {waiting:'owner'};
 const tasks=require('./agent-count-tasks'),counts=require('./postgres-count-campaigns'),revision=async()=>(await c.query('SELECT revision FROM warehouse_count_campaigns WHERE workspace_id=$1 AND id=$2',[p.workspace_id,t.campaign_id])).rows[0].revision;let decision;
 if(!rows.some(r=>r.delta)){
  await tasks.importObserved(scoped(c),owner,t.campaign_id,await revision());await counts.approve(scoped(c),owner,t.campaign_id,await revision());decision={action:'confirmed',positions:rows.length};
  await audit.record(c,owner,{action:'Annual stocktake area matched the records',reference:p.id,after:{locationId:t.location_id,campaignId:t.campaign_id,positions:rows.length}});
 }else{const posted=await tasks.smallDifferences(c,owner,t.campaign_id);if(!posted)return {waiting:'owner'};decision={action:'posted',exposureMinor:posted.exposureMinor,limitMinor:posted.limitMinor,currency:posted.currency};}
 await c.query(`UPDATE ${TEAMS} SET agent_decision=$3 WHERE workspace_id=$1 AND campaign_id=$2`,[p.workspace_id,t.campaign_id,JSON.stringify(decision)]);return decision;
}
// Called in the counter's own transaction when an area's last position is counted.
// Returns false when the worksheet is not part of an annual stocktake.
async function counted(c,ctx,campaignId){
 const t=await team(c,ctx.workspaceId,campaignId);if(!t)return false;const p=await annual.header(c,ctx,t.stocktake_id,true);if(p.status!=='FROZEN'||t.sheet!=='DRAFT')return true;
 const currency=await books(c,ctx.workspaceId),rows=(await positions(c,ctx.workspaceId,{campaignId})).map(r=>enrich(p,r,currency));if(rows.some(r=>r.quantity==null))return true;
 if(!p.automatic){if(!rows.some(r=>r.big))await require('./agent-count-tasks').smallDifferences(c,ctx,campaignId);return true;}
 const pending=rows.filter(r=>r.big&&!r.recounted);
 await attempt(c,p,async()=>{const owner=await runner(c,p);return pending.length?recount(c,owner,p,t,pending,{automatic:true}):decide(c,owner,p,t,rows);});return true;
}
// The owner asks for a recount of an area's differences: those over the recount limits,
// or every difference when the plan has none.
async function requestRecount(db,ctx,id,input){return db.transaction(async c=>{
 await annual.authority(c,ctx);const p=await annual.header(c,ctx,id,true);
 if(p.status!=='FROZEN'||p.owner_id!==ctx.actorId||Number(input.revision)!==p.revision||input.confirmed!=='yes')throw new ValidationError('Review the current frozen stocktake before asking for a recount.');
 const t=(await c.query(`SELECT t.*,s.status sheet FROM ${TEAMS} t JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id WHERE t.workspace_id=$1 AND t.stocktake_id=$2 AND t.location_id=$3`,[ctx.workspaceId,id,input.locationId])).rows[0];
 if(!t)throw new ValidationError('Choose a counted area of this stocktake.');const currency=await books(c,ctx.workspaceId),rows=(await positions(c,ctx.workspaceId,{campaignId:t.campaign_id})).map(r=>enrich(p,r,currency));
 if(rows.some(r=>r.quantity==null))throw new ValidationError('Wait until this area is fully counted before asking for a recount.');
 const limited=p.recount_units!=null||p.recount_minor!=null,targets=rows.filter(r=>!r.recounted&&!r.applied_at&&(limited?r.big:r.delta!==0));
 if(!targets.length)throw new ValidationError('No difference in this area needs a recount.');return recount(c,ctx,p,t,targets,{automatic:false});
},{isolation:'SERIALIZABLE',retrySafe:true});}
// The owner's sign-off: approves every remaining difference, which posts through the
// count worksheets to the stock ledger and accounting; the freeze lifts once all post.
async function approve(db,ctx,id,input){return db.transaction(async c=>{
 await annual.authority(c,ctx);const p=await annual.header(c,ctx,id,true);if(p.status==='SIGNED_OFF'||p.signoff_approved_at)return {id,replayed:true};
 if(p.status!=='FROZEN'||p.owner_id!==ctx.actorId||Number(input.revision)!==p.revision||input.confirmed!=='yes')throw new ValidationError('Review the current stocktake differences before signing off.');
 const sheets=(await c.query(`SELECT t.location_id,t.campaign_id,l.name,s.status,k.observed_at FROM ${TEAMS} t JOIN locations l ON l.workspace_id=t.workspace_id AND l.id=t.location_id JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id
  JOIN stockchief_runtime.agent_count_tasks k ON k.workspace_id=t.workspace_id AND k.campaign_id=t.campaign_id WHERE t.workspace_id=$1 AND t.stocktake_id=$2 ORDER BY l.name,t.location_id FOR UPDATE OF s`,[ctx.workspaceId,id])).rows;
 for(const s of sheets){if(s.status==='REVIEW_REQUIRED')throw new ValidationError('Recheck '+s.name+' before sign-off.');if(s.status==='DRAFT'&&!s.observed_at)throw new ValidationError('Every area must finish counting before sign-off. '+s.name+' is still being counted.');}
 const review=await differences(c,ctx,p);if(input.reviewHash!==review.hash)throw new ValidationError('The differences changed. Review them again before signing off.');
 const tasks=require('./agent-count-tasks'),counts=require('./postgres-count-campaigns'),revision=async campaign=>(await c.query('SELECT revision FROM warehouse_count_campaigns WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,campaign])).rows[0].revision;
 for(const s of sheets.filter(s=>s.status==='DRAFT')){await tasks.importObserved(scoped(c),ctx,s.campaign_id,await revision(s.campaign_id));await counts.approve(scoped(c),ctx,s.campaign_id,await revision(s.campaign_id));}
 await c.query(`UPDATE ${T} SET signoff_approved_at=clock_timestamp(),signoff_approved_by=$3,problem=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId]);
 await audit.record(c,ctx,{action:'Annual stocktake differences approved for posting',reference:id,after:review.totals});
 if(sheets.every(s=>s.status==='COMPLETED'))await annual.close(c,ctx,{...p,revision:p.revision+1},{ownerId:ctx.actorId});return {id};
},{isolation:'SERIALIZABLE',retrySafe:true});}
// After an area's counts post: reopen that area when the agent runs the stocktake, and
// close the stocktake when every area posted under the owner's sign-off or limit.
async function settle(db,workspaceId,stocktakeId,campaignId=null){return db.transaction(async c=>{
 const id=stocktakeId||(await c.query(`SELECT stocktake_id FROM ${TEAMS} WHERE workspace_id=$1 AND campaign_id=$2`,[workspaceId,campaignId])).rows[0]?.stocktake_id;if(!id)return {status:null};
 const p=await annual.header(c,{workspaceId},id,true);if(p.status!=='FROZEN')return {status:p.status};
 const sheets=(await c.query(`SELECT t.location_id,t.agent_decision,s.status,l.annual_count_freeze_id FROM ${TEAMS} t JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id JOIN locations l ON l.workspace_id=t.workspace_id AND l.id=t.location_id WHERE t.workspace_id=$1 AND t.stocktake_id=$2 ORDER BY t.location_id`,[workspaceId,id])).rows,open=sheets.some(s=>s.status!=='COMPLETED');
 if(p.signoff_approved_at){if(open)return {status:'FROZEN'};await annual.close(c,{workspaceId,actorId:p.signoff_approved_by},p,{ownerId:p.signoff_approved_by});return {status:'SIGNED_OFF'};}
 if(!p.automatic)return {status:'FROZEN'};
 const done=await attempt(c,p,async()=>{
  const owner=await runner(c,p),reopen=sheets.filter(s=>s.status==='COMPLETED'&&s.annual_count_freeze_id===id).map(s=>s.location_id);
  if(reopen.length){await c.query('UPDATE locations SET annual_count_freeze_id=NULL WHERE workspace_id=$1 AND annual_count_freeze_id=$2 AND id=ANY($3::text[])',[workspaceId,id,reopen]);await audit.record(c,owner,{action:'Annual stocktake area reopened after its counts posted',reference:id,after:{locations:reopen}});}
  if(open||!sheets.every(s=>s.agent_decision))return 'FROZEN';await annual.close(c,owner,p,{agent:true,authorizedBy:owner.actorId});return 'SIGNED_OFF';
 });
 return {status:done||'FROZEN'};
},{isolation:'SERIALIZABLE',retrySafe:true});}

// The routine behind autopilot checks: plan from the rule, start on the count date, and
// pick up areas whose earlier automatic step was held (paused, Ask me first, shadow).
async function routine(db,workspaceId){
 const settings=await require('../autopilot/postgres-service').getState(db,workspaceId);if(settings.paused||settings.suspended)return {skipped:'paused'};
 const result={prepared:0,started:0,checked:0},today=await time.today(db,workspaceId);
 try{const r=await plan(db,workspaceId,today);if(r?.created)result.prepared=1;}catch(error){if(!stops(error))throw error;await db.query(`UPDATE ${R} SET last_issue=$2 WHERE workspace_id=$1`,[workspaceId,error.message]);}
 for(const p of (await db.query(`SELECT id,status FROM ${T} WHERE workspace_id=$1 AND automatic AND status IN('DRAFT','FROZEN') ORDER BY created_at,id`,[workspaceId])).rows){
  if(p.status==='DRAFT'){try{if((await start(db,workspaceId,p.id))?.id)result.started+=1;}catch(error){if(!stops(error))throw error;await db.query(`UPDATE ${T} SET problem=$3 WHERE workspace_id=$1 AND id=$2 AND status='DRAFT'`,[workspaceId,p.id,error.message]);}continue;}
  const sheets=(await db.query(`SELECT t.campaign_id FROM ${TEAMS} t JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id JOIN stockchief_runtime.agent_count_tasks k ON k.workspace_id=t.workspace_id AND k.campaign_id=t.campaign_id WHERE t.workspace_id=$1 AND t.stocktake_id=$2 AND s.status='DRAFT' AND k.observed_at IS NOT NULL ORDER BY t.location_id`,[workspaceId,p.id])).rows;
  for(const s of sheets){await db.transaction(c=>counted(c,{workspaceId,actorId:null},s.campaign_id),{isolation:'SERIALIZABLE',retrySafe:true});result.checked+=1;}
  await settle(db,workspaceId,p.id);
 }
 return result;
}
async function enqueue(db,workspaceId,cycleId){
 const state=await policy.accountState(db,workspaceId);if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,16,'draft'))return 0;
 const due=(await db.query(`SELECT EXISTS(SELECT 1 FROM ${R} WHERE workspace_id=$1 AND enabled) OR EXISTS(SELECT 1 FROM ${T} WHERE workspace_id=$1 AND automatic AND status IN('DRAFT','FROZEN')) due`,[workspaceId])).rows[0].due;if(!due)return 0;
 await require('./postgres-job-queue').enqueue(db,{workspaceId,kind:jobKind,idempotencyKey:'annual-stocktake:'+cycleId,payload:{cycleId},priority:60,maxAttempts:3});return 1;
}
function ruleForm(r){return r?{...view(r),revision:r.revision,lastIssue:r.last_issue,recountValue:r.recount_minor==null?'':money.fromMinor(Number(r.recount_minor),r.currency)}:null;}
module.exports={jobKind,configure,rule,ruleForm,plan,start,positions,differences,counted,requestRecount,approve,settle,routine,enqueue};
