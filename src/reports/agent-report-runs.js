'use strict';
// Jobs 157, 158, 159, 161, 162 and 163: the monthly reports StockChief makes on its own.
//
// Each report it makes for a month is one run. The run key is a hash of the
// facts, so a replay of the same facts finds the same run and writes nothing.
// What the owner should look at is a flag in Needs you. A flag stays until a
// later run of the same month no longer raises it; a seen flag stays quiet.
//
// Pause holds scheduled runs. Watch only, Ask me first and the first 14 days
// keep the figures as a watched run and raise no flag.
const {ValidationError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');
const {hash}=require('../pricing/postgres-promotions');
const {newId}=require('../lib/util');

const tables={runs:'stockchief_runtime.agent_report_runs',flags:'stockchief_runtime.agent_report_flags'};
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(sql,args)=>c.query(sql,args),transaction:operation=>operation(c)});
const MONTH=/^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];

// ---- Calendar months ------------------------------------------------------

function addMonths(month,n){const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,7);}
function monthEnd(month){const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);}
function monthName(month){const [y,m]=month.split('-').map(Number);return MONTH_NAMES[m-1]+' '+y;}
function lastCompleted(today){return addMonths(today.slice(0,7),-1);}
// A completed calendar month: before the business's current month.
function completedMonth(today,value,label='month'){
  const month=String(value??'').trim()||lastCompleted(today);
  if(!MONTH.test(month)||month<'1900-01')throw new ValidationError('Choose the '+label+' as YYYY-MM, for example '+lastCompleted(today)+'.');
  if(month>=today.slice(0,7))throw new ValidationError('Choose a completed calendar month, for example '+lastCompleted(today)+'.');
  return month;
}
function span(month){return {month,start:month+'-01',end:monthEnd(month),name:monthName(month)};}

// ---- Who acts and whether it may ------------------------------------------

async function owner(db,ctx){
  if(!(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)`,
  [ctx.workspaceId,ctx.actorId])).rowCount)throw new AuthorizationError('Only the current inventory owner can do this.');
}
async function currentOwner(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.role='owner' ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}
const alone=(state,job)=>policy.usesAgentTerms(state)&&policy.permits(state.plan,job,'automatic');
async function paused(db,workspaceId){
  const pilot=(await db.query('SELECT paused,suspended FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];
  return Boolean(Number(pilot?.paused)||Number(pilot?.suspended));
}
// Why a scheduled run only watches right now, or null.
async function automaticStop(db,workspaceId,state,action){
  const stop=await policy.stopped(db,workspaceId,state,action,true);if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAct)return 'StockChief is watching only. Change its authority to get these flags in Needs you.';
  return null;
}
async function accounting(db,workspaceId){
  return (await db.query('SELECT enabled,accounting_start_date,base_currency FROM accounting_settings WHERE workspace_id=$1',[workspaceId])).rows[0]||null;
}

// ---- Runs and flags ------------------------------------------------------

// Keep one run for these facts and open, update or clear the month's flags.
// `flags` is the full set the run raises: [{key,currency,amount,detail}]. A run
// made only to keep a copy (syncFlags false) leaves the month's flags alone.
// A check that is kept current (supersede) also clears flags still open from
// its earlier months, so only the latest month's findings wait in Needs you.
async function record(c,ctx,{job,period,facts,result,flags=[],automatic,watch=null,problem=null,action,syncFlags=true,supersede=false}){
  const outcome=problem?'STOPPED':watch?'WATCHED':'PRODUCED';
  const runKey=hash({job,period,outcome,watch,problem,automatic,facts});
  await storage.reserve(scoped(c),ctx.workspaceId,'agent-report-run:'+runKey.slice(0,48),4096+Buffer.byteLength(JSON.stringify(result||{})),{finished:true});
  const runId=newId('reportrun');
  const inserted=(await c.query(`INSERT INTO ${tables.runs}(workspace_id,id,job_id,period,run_key,outcome,reason,authorization_kind,result,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,run_key) DO NOTHING RETURNING id`,
  [ctx.workspaceId,runId,job,period,runKey,outcome,problem||watch,automatic?'AUTOMATIC':'INDIVIDUAL',
    JSON.stringify({...result,wouldFlag:flags.map(f=>({key:f.key,title:f.detail.title}))}),automatic?null:ctx.actorId])).rows[0];
  if(!inserted){
    const prior=(await c.query(`SELECT id,result FROM ${tables.runs} WHERE workspace_id=$1 AND run_key=$2`,[ctx.workspaceId,runKey])).rows[0];
    return {replayed:true,runId:prior.id,outcome,opened:[],updated:[],cleared:[],result:prior.result};
  }
  const opened=[],updated=[],cleared=[];
  if(outcome==='PRODUCED'&&syncFlags){
    const current=(await c.query(`SELECT * FROM ${tables.flags} WHERE workspace_id=$1 AND job_id=$2 AND period=$3 AND status IN ('OPEN','DISMISSED') ORDER BY id FOR UPDATE`,
      [ctx.workspaceId,job,period])).rows;
    const byKey=new Map(current.map(f=>[f.flag_key,f])),raised=new Set(flags.map(f=>f.key));
    for(const f of flags){
      const existing=byKey.get(f.key);
      if(existing){
        await c.query(`UPDATE ${tables.flags} SET amount_minor=$3,detail=$4,last_run_id=$5,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
          [ctx.workspaceId,existing.id,f.amount??null,JSON.stringify(f.detail),runId]);
        updated.push(existing.id);continue;
      }
      const id=newId('reportflag');
      await c.query(`INSERT INTO ${tables.flags}(workspace_id,id,job_id,period,flag_key,currency,amount_minor,detail,status,opened_run_id,last_run_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'OPEN',$9,$9)`,[ctx.workspaceId,id,job,period,f.key,f.currency||null,f.amount??null,JSON.stringify(f.detail),runId]);
      opened.push(id);
    }
    for(const f of current){
      if(raised.has(f.flag_key))continue;
      await c.query(`UPDATE ${tables.flags} SET status='CLEARED',cleared_reason=$3,cleared_at=clock_timestamp(),last_run_id=$4,updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,f.id,'A later check of '+monthName(period)+' no longer finds it.',runId]);
      cleared.push(f.id);
    }
    if(supersede)for(const f of (await c.query(`UPDATE ${tables.flags} SET status='CLEARED',cleared_reason=$4,cleared_at=clock_timestamp(),last_run_id=$5,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND job_id=$2 AND period<$3 AND status IN ('OPEN','DISMISSED') RETURNING id`,
    [ctx.workspaceId,job,period,'Replaced by the check for '+monthName(period)+'.',runId])).rows)cleared.push(f.id);
  }
  await audit.record(c,ctx,{action,reference:monthName(period),before:{},after:{runId,outcome,reason:problem||watch||null,opened,cleared,
    flagged:flags.map(f=>f.detail.title)}});
  return {runId,outcome,reason:problem||watch||null,opened,updated,cleared,result};
}

async function dismiss(database,ctx,flagId){
  return tx(database,async c=>{
    await owner(c,ctx);
    const row=(await c.query(`UPDATE ${tables.flags} SET status='DISMISSED',dismissed_by=$3,dismissed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND id=$2 AND status='OPEN' RETURNING job_id,period,detail`,[ctx.workspaceId,String(flagId||''),ctx.actorId])).rows[0];
    if(!row)throw new ValidationError('This flag is no longer open.');
    await audit.record(c,ctx,{action:'Marked a monthly report flag as seen',reference:row.detail.title,after:{flagId,job:row.job_id,period:row.period}});
    return {dismissed:true,job:row.job_id,period:row.period};
  });
}
// Clear one flag because the owner did what it asked, such as downloading a pack.
async function settle(c,ctx,job,period,key,reason){
  const row=(await c.query(`UPDATE ${tables.flags} SET status='CLEARED',cleared_reason=$5,cleared_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND job_id=$2 AND period=$3 AND flag_key=$4 AND status IN ('OPEN','DISMISSED') RETURNING id`,[ctx.workspaceId,job,period,key,reason])).rows[0];
  return row?.id||null;
}

async function runs(db,workspaceId,job,{period=null,limit=6}={}){
  return (await db.query(`SELECT id,period,outcome,reason,authorization_kind,result,created_at FROM ${tables.runs}
    WHERE workspace_id=$1 AND job_id=$2 AND ($3::text IS NULL OR period=$3) ORDER BY created_at DESC,id DESC LIMIT $4`,[workspaceId,job,period,limit])).rows;
}
async function flagsFor(db,workspaceId,job,{period=null}={}){
  return (await db.query(`SELECT id,period,flag_key,currency,amount_minor,detail,status,cleared_reason,updated_at FROM ${tables.flags}
    WHERE workspace_id=$1 AND job_id=$2 AND ($3::text IS NULL OR period=$3) AND (status IN ('OPEN','DISMISSED') OR updated_at>now()-interval '45 days')
    ORDER BY status DESC,period DESC,id LIMIT 100`,[workspaceId,job,period])).rows;
}

// Needs you: open flags of jobs the plan runs alone, and a run that stopped.
async function inbox(db,workspaceId){
  const installed=require('../db/schema-installed');
  if(!(await installed.has(db,tables.flags))||!(await installed.has(db,tables.runs)))return [];
  const state=await policy.accountState(db,workspaceId);
  const jobs=[157,158,159,161,162,163].filter(job=>alone(state,job));if(!jobs.length)return [];
  const [flags,stopped]=await Promise.all([
    db.query(`SELECT id,job_id,period,currency,amount_minor,detail,updated_at FROM ${tables.flags}
      WHERE workspace_id=$1 AND status='OPEN' AND job_id=ANY($2::int[]) ORDER BY period DESC,id LIMIT 50`,[workspaceId,jobs]),
    db.query(`SELECT DISTINCT ON (job_id) id,job_id,period,outcome,reason,created_at FROM ${tables.runs}
      WHERE workspace_id=$1 AND job_id=ANY($2::int[]) AND authorization_kind='AUTOMATIC' ORDER BY job_id,created_at DESC,id DESC`,[workspaceId,jobs])]);
  const out=flags.rows.map(f=>({kind:f.detail.kind||'accounting',importance:'Needs You',priority:f.detail.priority||52,title:f.detail.title,
    happened:f.detail.happened,why:f.detail.why,recommendation:f.detail.recommendation,href:f.detail.href,actionLabel:f.detail.actionLabel||'Open the report',
    sourceId:'agent-report:'+f.id,createdAt:f.updated_at,at:f.updated_at,
    ...(f.currency&&f.amount_minor!=null?{moneyCurrency:f.currency,moneyValue:Math.abs(Number(f.amount_minor))}:{})}));
  const labels={157:'The monthly change check',158:'The month-end stock report',159:'The board pack',161:'The monthly ROI report',162:'The stock health check',163:'The forecast and delivery report'};
  const paths={157:'/autopilot/reviews/margin-change',158:'/autopilot/reviews/month-end-stock',159:'/autopilot/reviews/board-pack',161:'/autopilot/reviews/roi-report',
    162:'/autopilot/reviews/stock-health',163:'/autopilot/reviews/service-levels'};
  for(const run of stopped.rows.filter(r=>r.outcome==='STOPPED'))out.push({kind:'accounting',importance:'Needs You',priority:50,
    title:labels[run.job_id]+' for '+monthName(run.period)+' stopped',happened:String(run.reason||'It could not finish.'),
    why:'StockChief does not guess figures it cannot find in your records.',recommendation:'Review what is missing, then check again.',
    href:paths[run.job_id]+'?'+new URLSearchParams({month:run.period}),actionLabel:'Review the report',sourceId:'agent-report-run:'+run.id,createdAt:run.created_at,at:run.created_at});
  return out;
}

module.exports={tables,tx,scoped,MONTH,addMonths,monthEnd,monthName,lastCompleted,completedMonth,span,owner,currentOwner,alone,paused,automaticStop,accounting,
  record,dismiss,settle,runs,flagsFor,inbox};
