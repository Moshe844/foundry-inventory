'use strict';
// Job 202: vacation mode. Excluded on Starter; alone on Growth, Pro and Custom.
//
// The owner names a deputy and the dates they are away. While away, every
// approval that would wait for the owner goes to the deputy instead, when the
// deputy may approve it themselves: purchase orders, transfers, stock
// adjustments and write-offs, refunds and credits, landed costs, supplier
// price changes and returns (the approval desk, job 176), the second signature
// of a two-person approval (job 205) and similar approvals in one tap (Needs
// you groups, job 174). "May approve it" is the deputy's own current
// permission, whole-inventory access and amount limits, checked again by each
// approval's own service when they decide. The deputy is never both of the
// two signatures: once they signed, the second goes to someone else or back
// to the owner. Owner-only approvals, private Ask decisions and owner-only
// controls stay with the owner.
//
// Delegating is StockChief acting on its own, so in the first 14 days, Watch
// only, pause and while saved rules exceed the plan everything stays with the
// owner. Each approval sent to the deputy is recorded and audited by the
// routine check. When the owner is back (the last day passed, or they ended
// it early) everything still waiting is the owner's again, and Needs you
// hands back what the deputy decided and what is back with the owner.
const permissions=require('../actions/permissions'),policy=require('../commercial/agent-plan');
const {AuthorizationError,ValidationError}=require('../domain/errors');
const time=require('../lib/business-time');
const money=require('../domain/currency');
const {has}=require('../db/schema-installed');
const audit=require('../operations/postgres-security-audit');

const JOB=202,key='vacation-deputy',path='/autopilot/reviews/'+key;
const DEPUTIES='stockchief_runtime.vacation_deputies',COVERAGES='stockchief_runtime.vacation_coverages',DELEGATIONS='stockchief_runtime.vacation_delegations';
const desk=()=>require('./approval-desk');

// Someone who can approve at least one kind of approval across the inventory.
function canCover(member){return member.warehouse_location_ids==null&&Object.keys(desk().KINDS).some(kind=>desk().canApproveKind(member,kind));}
const members=`SELECT u.id,u.account_id,u.name,u.role,u.permissions,u.po_approval_limit_minor,u.po_approval_currency,u.warehouse_location_ids
  FROM users u JOIN workspaces w ON w.id=u.workspace_id
  LEFT JOIN platform_account_access a ON a.account_id=u.account_id
  WHERE u.workspace_id=$1 AND u.account_id IS NOT NULL AND u.account_id<>w.owner_account_id AND u.warehouse_location_ids IS NULL AND a.disabled_at IS NULL`;

async function setting(db,workspaceId){
  if(!await has(db,DEPUTIES))return {revision:0};
  return (await db.query(`SELECT d.deputy_id,d.starts_on::text,d.ends_on::text,d.revision,u.name
    FROM ${DEPUTIES} d LEFT JOIN users u ON u.workspace_id=d.workspace_id AND u.id=d.deputy_id
    WHERE d.workspace_id=$1`,[workspaceId])).rows[0]||{revision:0};
}

// The vacation covering approvals right now, or null.
async function coverage(db,workspaceId,state=null){
  if(!await has(db,DEPUTIES))return null;
  state=state||await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return null;
  const row=(await db.query(`SELECT d.deputy_id,d.ends_on::text,d.revision,owner.name AS owner_name FROM ${DEPUTIES} d
    JOIN users owner ON owner.id=d.owner_id AND owner.workspace_id=d.workspace_id AND owner.role='owner'
    JOIN workspaces w ON w.id=d.workspace_id JOIN accounts a ON a.id=w.owner_account_id
    WHERE d.workspace_id=$1 AND d.deputy_id IS NOT NULL
      AND (now() AT TIME ZONE coalesce(w.time_zone,a.time_zone,'UTC'))::date BETWEEN d.starts_on AND d.ends_on`,[workspaceId])).rows[0];
  if(!row)return null;
  if(await policy.stopped(db,workspaceId,state,'approval.vacation',true))return null;
  return {revision:row.revision,deputyId:row.deputy_id,ownerName:row.owner_name,through:row.ends_on};
}
const away=cover=>cover.ownerName+' is away until '+cover.through+'.';
// One routed approval: the owner's goes to the deputy when they may approve it.
function delegate(request,cover,{people,limits}){
  if(!cover||request.person?.role!=='owner'||request.ownerOnly)return request;
  const deputy=people.find(p=>p.id===cover.deputyId);
  if(!deputy||deputy.role==='owner'||deputy.warehouse_location_ids!==null)return request;
  if(request.signed?.length){
    // Never both signatures, and the owner posts what only the owner may post.
    if(request.signed.length>=2||request.signed.some(p=>p.account_id===deputy.account_id))return request;
    if(!require('./two-person-approval').canSign(deputy,request,limits))return request;
  }else if(!desk().eligible(deputy,request,limits))return request;
  return {...request,person:deputy,covering:cover.revision,
    reason:away(cover)+' You cover the approvals you are allowed to make'+(request.signed?.length?'; this one needs your approval as the second person.':'.')};
}

async function setup(db,ctx){
  const people=(await db.query(members+' ORDER BY u.name,u.id',[ctx.workspaceId])).rows.filter(canCover);
  return {people,rule:await setting(db,ctx.workspaceId),today:await time.today(db,ctx.workspaceId),handback:await handback(db,ctx.workspaceId)};
}

// Ends the coverage being replaced or stopped. One not started yet leaves nothing to hand back.
async function endCurrent(c,workspaceId,today){
  if(!await has(c,COVERAGES))return;
  await record(c,workspaceId);
  await c.query(`DELETE FROM ${COVERAGES} WHERE workspace_id=$1 AND ended_on IS NULL AND handed_back_at IS NULL AND starts_on>$2::date`,[workspaceId,today]);
  await c.query(`UPDATE ${COVERAGES} SET ended_on=$2::date WHERE workspace_id=$1 AND ended_on IS NULL AND starts_on<=$2::date AND ends_on>=$2::date`,[workspaceId,today]);
}
async function save(db,ctx,input){
  return db.transaction(async c=>{
    const owner=await c.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner' FOR SHARE",[ctx.workspaceId,ctx.actorId]);
    if(!owner.rowCount)throw new AuthorizationError('Only the inventory owner can choose a vacation deputy.');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['vacation:'+ctx.workspaceId]);
    const prior=await setting(c,ctx.workspaceId);
    if(input.revision==null||prior.revision!==Number(input.revision))throw new ValidationError('The vacation dates or deputy changed. Review the current setting.');
    const {timeZone,calendarDate}=await time.forWorkspace(c,ctx.workspaceId);
    if(input.remove==='1'){
      await endCurrent(c,ctx.workspaceId,calendarDate);
      await c.query(`UPDATE ${DEPUTIES} SET deputy_id=NULL,revision=revision+1 WHERE workspace_id=$1 AND deputy_id IS NOT NULL`,[ctx.workspaceId]);
      if(prior.deputy_id)await audit.record(c,ctx,{action:'Ended vacation coverage',before:{deputy:prior.name,from:prior.starts_on,through:prior.ends_on}});
      return;
    }
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    const selected=(await c.query(members+' AND u.id=$2',[ctx.workspaceId,input.deputyId])).rows[0];
    if(!selected||!canCover(selected))throw new ValidationError('Choose a current team member who can approve purchases, transfers, returns, stock changes, refunds or landed costs across this inventory.');
    time.dayBoundary(input.start,timeZone);time.dayBoundary(input.end,timeZone);
    if(input.end<input.start||input.end<calendarDate)throw new ValidationError('Choose a vacation end date on or after the start date and today.');
    if(prior.deputy_id)await endCurrent(c,ctx.workspaceId,calendarDate);
    const saved=(await c.query(`INSERT INTO ${DEPUTIES}(workspace_id,owner_id,deputy_id,starts_on,ends_on,revision)
      VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(workspace_id) DO UPDATE SET owner_id=$2,deputy_id=$3,starts_on=$4,ends_on=$5,
      revision=vacation_deputies.revision+1 RETURNING revision`,[ctx.workspaceId,ctx.actorId,selected.id,input.start,input.end])).rows[0];
    if(await has(c,COVERAGES))await c.query(`INSERT INTO ${COVERAGES}(workspace_id,revision,deputy_id,deputy_name,starts_on,ends_on) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT DO NOTHING`,[ctx.workspaceId,saved.revision,selected.id,String(selected.name).slice(0,200),input.start,input.end]);
    await audit.record(c,ctx,{action:'Scheduled vacation coverage',after:{deputy:selected.name,from:input.start,through:input.end}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Routine check: records and audits each approval sent to the deputy, once.
async function record(db,workspaceId){
  if(!await has(db,DELEGATIONS))return {skipped:'schema'};
  const state=await policy.accountState(db,workspaceId),cover=await coverage(db,workspaceId,state);
  if(!cover)return {recorded:0};
  const [{rows},signatures]=await Promise.all([desk().desk(db,workspaceId,{state}),require('../purchasing/approval-routing').assignments(db,workspaceId)]);
  const covered=rows.filter(r=>r.covering).map(r=>({key:r.key,kind:desk().KINDS[r.kind].label,title:r.title,href:r.href,person:r.person.name,amount:r.amountMinor==null?null:money.format(r.amountMinor,r.currency)}))
    .concat(signatures.filter(s=>s.covering).map(s=>({key:'purchase-signature:'+s.id,kind:desk().KINDS.purchase.label,title:'Second approval for purchase '+s.order,href:'/purchasing/orders/'+s.id,person:s.reviewer,amount:null})));
  if(!covered.length)return {recorded:0};
  const deputy=covered[0].person;
  await db.query(`INSERT INTO ${COVERAGES}(workspace_id,revision,deputy_id,deputy_name,starts_on,ends_on)
    SELECT d.workspace_id,d.revision,d.deputy_id,u.name,d.starts_on,d.ends_on FROM ${DEPUTIES} d JOIN users u ON u.workspace_id=d.workspace_id AND u.id=d.deputy_id
    WHERE d.workspace_id=$1 AND d.revision=$2 ON CONFLICT DO NOTHING`,[workspaceId,cover.revision]);
  let recorded=0;
  for(const r of covered){
    const added=await db.query(`INSERT INTO ${DELEGATIONS}(workspace_id,revision,request_key,kind,title,href) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT DO NOTHING RETURNING 1`,[workspaceId,cover.revision,r.key,r.kind,r.title.slice(0,300),r.href]);
    if(!added.rowCount)continue;
    recorded++;
    await audit.record(db,{workspaceId,actorId:null},{action:'Approval sent to vacation deputy',reference:r.title.slice(0,200),
      after:{person:deputy,kind:r.kind,...(r.amount?{amount:r.amount}:{}),ownerAwayUntil:cover.through}});
  }
  return {recorded};
}

// The finished vacation the owner has not reviewed yet, with what happened.
async function handback(db,workspaceId){
  if(!await has(db,COVERAGES))return null;
  const today=await time.today(db,workspaceId);
  const coverageRow=(await db.query(`SELECT revision,deputy_name,starts_on::text,ends_on::text,ended_on::text FROM ${COVERAGES}
    WHERE workspace_id=$1 AND handed_back_at IS NULL AND starts_on<=coalesce(ended_on,$2::date) AND (ended_on IS NOT NULL OR ends_on<$2::date)
    ORDER BY revision DESC LIMIT 1`,[workspaceId,today])).rows[0];
  if(!coverageRow)return null;
  const delegated=(await db.query(`SELECT request_key,kind,title,href FROM ${DELEGATIONS} WHERE workspace_id=$1 AND revision=$2 ORDER BY delegated_at,request_key LIMIT 500`,
    [workspaceId,coverageRow.revision])).rows;
  const [requests,signatures]=await Promise.all([desk().requests(db,workspaceId),require('../purchasing/approval-routing').assignments(db,workspaceId)]);
  const waiting=new Set(requests.map(r=>r.key).concat(signatures.map(s=>'purchase-signature:'+s.id)));
  const rows=delegated.map(d=>({title:d.title,href:d.href,kind:d.kind,waiting:waiting.has(d.request_key)}));
  return {revision:coverageRow.revision,deputy:coverageRow.deputy_name,from:coverageRow.starts_on,through:coverageRow.ended_on||coverageRow.ends_on,rows,
    decided:rows.filter(r=>!r.waiting).length,back:rows.filter(r=>r.waiting).length};
}
async function handBack(db,ctx,input={}){
  return db.transaction(async c=>{
    const owner=await c.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner' FOR SHARE",[ctx.workspaceId,ctx.actorId]);
    if(!owner.rowCount)throw new AuthorizationError('Only the inventory owner can take approvals back.');
    const current=await handback(c,ctx.workspaceId);
    if(!current||String(current.revision)!==String(input.revision??''))return {unchanged:true};
    const done=await c.query(`UPDATE ${COVERAGES} SET handed_back_at=clock_timestamp(),handed_back_by=$3 WHERE workspace_id=$1 AND revision=$2 AND handed_back_at IS NULL RETURNING 1`,
      [ctx.workspaceId,current.revision,ctx.actorId]);
    if(done.rowCount)await audit.record(c,ctx,{action:'Took approvals back after vacation',
      after:{deputy:current.deputy,from:current.from,through:current.through,decidedByDeputy:current.decided,backWithOwner:current.back}});
    return {handedBack:Boolean(done.rowCount)};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Needs you: the owner's hand-back once they are back. The deputy's approvals
// themselves come from the approval desk, marked as covered for the owner.
async function inbox(db,workspaceId,actorId){
  const member=(await db.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[workspaceId,actorId])).rows[0];
  if(member?.role!=='owner')return [];
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return [];
  const back=await handback(db,workspaceId);
  if(!back)return [];
  return [{kind:'approval',importance:'Important',priority:81,title:'Welcome back: your approvals are yours again',
    happened:back.deputy+' covered your approvals from '+back.from+' to '+back.through+'. '+
      (back.rows.length?back.decided+' were decided and '+back.back+' '+(back.back===1?'is':'are')+' back with you.':'Nothing waited for them.'),
    why:'Everything still waiting is in your own list again.',recommendation:'Check what was decided while you were away.',
    href:path,actionLabel:'Review the hand-back',sourceId:'vacation-handback-'+back.revision,at:back.through,createdAt:back.through}];
}

const definition={id:JOB,key,label:'Assign a vacation deputy',read:async(db,ctx)=>{
  const rule=await setting(db,ctx.workspaceId),cover=await coverage(db,ctx.workspaceId);
  const rows=[];
  if(cover){
    const {rows:routed}=await desk().desk(db,ctx.workspaceId);
    for(const r of routed.filter(r=>r.covering))rows.push({Approval:r.title,Kind:desk().KINDS[r.kind].label,Amount:r.amountMinor==null?'':money.format(r.amountMinor,r.currency),'With':r.person.name,link:r.href});
  }
  return {summary:'While you are away, approvals that would wait for you go to your deputy when they may approve them: purchases, transfers, returns, stock changes and write-offs, refunds and credits, '+
    'landed costs and supplier prices, including a second approval and approving similar ones in one tap. Their own permissions and limits apply. '+
    'Owner-only approvals and your private Ask decisions wait for you. When you are back, everything still waiting is yours again.'+
    (rule.deputy_id?' '+rule.name+' covers from '+rule.starts_on+' to '+rule.ends_on+'.':''),rows};
}};
module.exports={JOB,key,path,definition,setup,save,coverage,delegate,record,handback,handBack,inbox,canCover};
