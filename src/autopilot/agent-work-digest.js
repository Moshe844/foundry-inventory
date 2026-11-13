'use strict';

// Job 204: the daily "what I did" digest, with one-tap undo. Alone on Growth,
// Pro and Custom; excluded on Starter.
//
// The page shows one business day of the activity log (job 181,
// agent-activity.js): every action StockChief completed, why, what allowed
// it, and a one-tap undo where it is truly safe or the correction path where
// it is not. Once a business day ends, the worker writes that day's digest
// once and audits it. The latest digest with any work opens as an agent
// notice (the page and Needs you), and reaches email from the mailbox the
// owner chose through the shared alert delivery (agent-alerts.js), one line
// per action with its undo or correction link. The email waits during the
// first 14 days, pause, Watch only and Ask me first, where the owner can send
// it from the page. A replay writes nothing new.

const policy=require('../commercial/agent-plan'),time=require('../lib/business-time');
const activity=require('./agent-activity'),installed=require('../db/schema-installed');
const audit=require('../operations/postgres-security-audit');
const {addDays}=require('../accounting/customer-money');
const {ValidationError}=require('../domain/errors');

const JOB=204,key='daily-work',path='/autopilot/reviews/'+key,table='stockchief_runtime.agent_work_digests',MAX=200;

// One business day of the log, oldest first.
async function day(db,ctx,date,timeZone,{page=1}={}){
 return activity.entries(db,ctx,{from:time.dayBoundary(date,timeZone),to:time.dayBoundary(date,timeZone,{nextDay:true}),page,order:'ASC',timeZone});
}

async function report(db,ctx,{filter='',page=1}={}){
 await require('./job-reviews').ownerState(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'suggest');
 page=Number(page);if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid work-history page.');
 const {calendarDate,timeZone}=await time.forWorkspace(db,ctx.workspaceId),date=filter||calendarDate;
 time.dayBoundary(date,timeZone);
 const result=await day(db,ctx,date,timeZone,{page});
 const rows=result.entries.map(e=>({Action:e.what,When:e.when,Why:e.why,'Allowed by':e.allowedBy,Status:e.status,'Undo or correction':e.undo?e.undo.what:e.correction,link:e.link}));
 return {rows,more:result.more,
  undoForm:{day:date,entries:result.entries.filter(e=>e.undo).map(e=>({id:e.id,origin:e.origin,summary:e.what,what:e.undo.what}))},
  activity:{entries:result.entries,day:date,undoAction:'/autopilot/undo',returnTo:path+'?'+new URLSearchParams({filter:date})},
  summary:'What StockChief did on '+date+' ('+timeZone+'). Undo is one tap where nothing changed since. What cannot be taken back shows how to correct it.'};
}

// One-tap undo from the daily record.
function undo(db,ctx,id,{origin='action'}={}){return activity.undo(db,ctx,{origin,id},{job:JOB});}

const origin=()=>String(require('../config').connections.publicOrigin||'').replace(/\/$/,'');

// The worker writes yesterday's digest once, before the notices are
// refreshed, so it opens and emails in the same check. Starter and accounts
// on older terms get none.
async function deliver(db,workspaceId,{now=new Date()}={}){
 if(!await installed.has(db,table))return {skipped:'not_installed'};
 const account=await policy.accountState(db,workspaceId);
 if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic'))return {skipped:'plan'};
 const clock=await time.forWorkspace(db,workspaceId,now),date=addDays(clock.calendarDate,-1);
 if((await db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND report_date=$2`,[workspaceId,date])).rowCount)return {replayed:true,day:date};
 const owner=(await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
  WHERE w.id=$1 AND u.role='owner' ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0];
 if(!owner)return {skipped:'owner'};
 const ctx={workspaceId,actorId:owner.id},found=[];let more=false;
 for(let page=1;page<=MAX/100;page++){const r=await day(db,ctx,date,clock.timeZone,{page});found.push(...r.entries);more=r.more;if(!r.more)break;}
 const actions=found.slice(0,MAX).map(e=>({key:e.key,anchor:e.anchor,what:e.what,when:e.when,status:e.status,undo:e.undo?e.undo.what:null,correction:e.correction,link:e.link}));
 const summary={format:'work-digest',day:date,deliveredOn:clock.calendarDate,asOf:new Date().toISOString(),count:found.length+(more?1:0),more,
  undoable:actions.filter(a=>a.undo).length,actions};
 const saved=await db.query(`INSERT INTO ${table}(workspace_id,report_date,summary) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING report_date`,[workspaceId,date,summary]);
 if(!saved.rowCount)return {replayed:true,day:date};
 await audit.record(db,ctx,{action:'Daily work digest prepared',reference:date,after:{actions:summary.count,undoable:summary.undoable,more}});
 return {day:date,actions:summary.count};
}

// The email: one line per action with its undo or correction link.
async function lines(db,workspaceId,keys){
 const out=[],base=origin();
 for(const k of keys){
  const s=(await db.query(`SELECT summary FROM ${table} WHERE workspace_id=$1 AND report_date=$2`,[workspaceId,k.reference])).rows[0]?.summary;
  if(!s){out.push('What StockChief did on '+k.reference+'.');continue;}
  out.push('What StockChief did on '+s.day+': '+s.count+(s.count===1?' action.':' actions.'));
  for(const a of s.actions){
   out.push(a.what+' ('+a.when+'). '+(a.status==='Undone'?'Already undone.':a.undo?'Undo it in one tap: '+base+path+'?filter='+s.day+'#'+a.anchor
    :(a.correction||'Open it to correct it.')+' '+base+a.link));
  }
  if(s.more)out.push('More actions are on the daily record: '+base+path+'?filter='+s.day);
 }
 return out;
}

const definition={id:JOB,key,label:'Daily record of StockChief work',filterLabel:'Business date (YYYY-MM-DD)',readPage:report};
module.exports={JOB,key,path,table,report,undo,deliver,lines,definition};
