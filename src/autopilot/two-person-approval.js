'use strict';
// Job 205: two people approve anything over the amount the owner sets.
//
// Purchase orders keep their own signatures (purchasing/dual-approval.js).
// This covers every other approval that moves money or changes stock value:
// refunds and credits, stock adjustments and write-offs, and landed-cost
// postings. The amount is the owner's one threshold; anything in another
// currency, or whose amount StockChief cannot work out, also needs two people.
//
// Each approval is bound to its exact content: a changed amount, payload or
// threshold needs two fresh approvals. Two different accounts must approve;
// the same person approving twice counts once. Each approver must still be
// allowed to approve it (its permission, the whole inventory, and their limit
// for that kind). Where the service itself needs the owner, a second person
// can approve it and the owner's approval posts it.
const {createHash}=require('node:crypto');
const {AuthorizationError,NotFoundError,ValidationError}=require('../domain/errors');
const permissions=require('../actions/permissions');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const {has}=require('../db/schema-installed');
const audit=require('../operations/postgres-security-audit');
const desk=require('./approval-desk');
const dual=require('../purchasing/dual-approval');

const JOB=205,SIGNATURES='stockchief_runtime.agent_approval_signatures',KINDS=new Set(['adjustment','refund','landed_cost']);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function over(rule,request){
  return rule.amount_minor!=null&&KINDS.has(request.kind)&&!(request.amountMinor!=null&&request.currency===rule.currency&&request.amountMinor<=Number(rule.amount_minor));
}
// What two people approve, and its exact content. A landed-cost posting is the
// same approval whichever page or prepared change posts it.
function subject(request,proposal){
  const p=proposal.payload||{};
  return request.actionType==='landed_cost.apply'?{key:'landed_cost:'+p.recordId,parts:['landed_cost',p.recordId,p.fingerprint]}:
    {key:request.key,parts:[proposal.action_type,p]};
}
async function requirement(c,workspaceId,request,proposal,rule=null){
  if(!request||!KINDS.has(request.kind))return null;
  rule=rule||await dual.setting(c,workspaceId);
  if(!over(rule,request))return null;
  const s=subject(request,proposal);
  return {rule,key:s.key,digest:hash([rule.revision,rule.currency,rule.amount_minor,...s.parts,request.amountMinor,request.currency])};
}
function canSign(person,request,limits){
  if(!permissions.can(person,request.permission)||!permissions.can(person,request.readPermission))return false;
  return person.role==='owner'||person.warehouse_location_ids===null&&desk.covers(person,request,limits);
}
async function signers(c,workspaceId,request,need){
  if(!await has(c,SIGNATURES))return [];
  const rows=(await c.query(`SELECT s.account_id,s.signed_at,u.id,u.name,u.role,u.permissions,u.po_approval_limit_minor,u.po_approval_currency,u.warehouse_location_ids
    FROM ${SIGNATURES} s JOIN users u ON u.workspace_id=s.workspace_id AND u.id=s.actor_id AND u.account_id=s.account_id
    LEFT JOIN platform_account_access a ON a.account_id=u.account_id
    WHERE s.workspace_id=$1 AND s.request_key=$2 AND s.digest=$3 AND a.disabled_at IS NULL ORDER BY s.signed_at,s.actor_id`,[workspaceId,need.key,need.digest])).rows;
  const {limits}=await desk.settings(c,workspaceId);
  return rows.filter(p=>canSign(p,request,limits));
}
const amountText=need=>money.format(Number(need.rule.amount_minor),need.rule.currency);
function refusal(need){return 'Two people must approve this: it is over your '+amountText(need)+' two-person amount, or in another currency. Approve it from its review page; a second person approves it from Needs you.';}

// Every path that would post one of these checks this first, including the
// owner's own routines. A downgrade below Pro refuses with the plan lock.
async function assertProposal(c,ctx,proposal,request){
  if(!request||request.actionType==='landed_cost.apply')return; // checked where landed costs post
  const need=await requirement(c,ctx.workspaceId,request,proposal);
  if(!need)return;
  await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
  if((await signers(c,ctx.workspaceId,request,need)).length<2)throw new AuthorizationError(refusal(need));
}
function landedRequest(p){
  const training=p.training||{};
  return {key:'landed_cost:'+p.recordId,kind:'landed_cost',actionType:'landed_cost.apply',permission:permissions.ALLOCATE_LANDED_COST,readPermission:permissions.VIEW_ACCOUNTING,
    ownerOnly:true,...(Number.isSafeInteger(Number(training.amountMinor))&&/^[A-Z]{3}$/.test(String(training.currency||''))?{amountMinor:Number(training.amountMinor),currency:training.currency}:{amountMinor:null,currency:null})};
}
// Landed costs post from a prepared change, the delivery-cost bill page and the
// bill routine. The reason it must wait, or null when it may post.
async function landedCostWaiting(c,ctx,p){
  const request=landedRequest(p),need=await requirement(c,ctx.workspaceId,request,{action_type:'landed_cost.apply',payload:p});
  if(!need)return null;
  if(!policy.permits((await policy.accountState(c,ctx.workspaceId)).plan,JOB,'automatic'))return refusal(need);
  return (await signers(c,ctx.workspaceId,request,need)).length<2?refusal(need):null;
}
async function assertLandedCost(c,ctx,p){
  const request=landedRequest(p),need=await requirement(c,ctx.workspaceId,request,{action_type:'landed_cost.apply',payload:p});
  if(!need)return;
  await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
  if((await signers(c,ctx.workspaceId,request,need)).length<2)throw new AuthorizationError(refusal(need));
}

// One person's approval of a prepared change. Under the amount nothing is
// recorded here and the change posts as before.
async function sign(db,ctx,id){
  return db.transaction(async c=>{
    const proposal=(await c.query('SELECT * FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
    if(!proposal)throw new NotFoundError('That prepared change could not be found.');
    if(proposal.status!=='PENDING')return {required:false};
    const request=await desk.proposalRequest(c,ctx.workspaceId,proposal),need=await requirement(c,ctx.workspaceId,request,proposal);
    if(!need)return {required:false};
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    const team=await desk.people(c,ctx.workspaceId),{limits}=await desk.settings(c,ctx.workspaceId),me=team.find(p=>p.id===ctx.actorId);
    if(!me||!canSign(me,request,limits)){
      if(me)await desk.assertLimit(c,ctx,request);
      throw new AuthorizationError('You cannot approve this. It needs someone who can approve '+desk.KINDS[request.kind].noun+' across the whole inventory.');
    }
    const added=await c.query(`INSERT INTO ${SIGNATURES}(workspace_id,request_key,digest,account_id,actor_id,amount_minor,currency)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING 1`,[ctx.workspaceId,need.key,need.digest,me.account_id,me.id,request.amountMinor,request.currency]);
    const people=await signers(c,ctx.workspaceId,request,need);
    if(added.rowCount)await audit.record(c,ctx,{action:people.length<2?'Approved: waiting for a second person':'Approved as the second person',reference:proposal.summary.slice(0,200),
      after:{kind:desk.KINDS[request.kind].label,amount:request.amountMinor==null?'Unknown':money.format(request.amountMinor,request.currency),approvedBy:people.map(p=>p.name),threshold:amountText(need)}});
    if(people.length<2)return {required:true,status:'WAITING_FOR_SECOND_PERSON',people:people.map(p=>p.name)};
    return {required:true,status:!request.ownerOnly||me.role==='owner'?'READY':'WAITING_FOR_OWNER',people:people.map(p=>p.name)};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
// Approve: record this person's approval, then post once two people approved.
async function approve(db,ctx,id,options={}){
  const signed=await sign(db,ctx,id);
  if(signed.required&&signed.status!=='READY')return signed;
  return {...await require('../assistant/postgres-service').executeProposal(db,ctx,id,options),twoPeople:signed.required};
}
// What the review page shows.
async function view(db,ctx,proposal){
  if(proposal.status!=='PENDING')return null;
  const request=await desk.proposalRequest(db,ctx.workspaceId,proposal),need=await requirement(db,ctx.workspaceId,request,proposal);
  if(!need)return null;
  const state=await policy.accountState(db,ctx.workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return {locked:true,threshold:amountText(need)};
  const people=await signers(db,ctx.workspaceId,request,need);
  return {threshold:amountText(need),amount:request.amountMinor==null?null:money.format(request.amountMinor,request.currency),people:people.map(p=>p.name),
    signed:people.some(p=>p.id===ctx.actorId),complete:people.length>=2};
}
// A delivery-cost bill over the amount becomes one prepared change, so two
// people can approve the same posting.
async function landedCostChange(db,ctx,documentId){
  const waiting=(await db.query(`SELECT id FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND action_type='landed_cost.apply'
    AND status='PENDING' AND payload->>'recordId'=$2 ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId,documentId])).rows[0];
  if(waiting)return waiting.id;
  const doc=(await db.query('SELECT document_number FROM landed_cost_documents WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,documentId])).rows[0];
  if(!doc)throw new NotFoundError('That cost allocation is not in this inventory.');
  const prepared=await require('../assistant/postgres-service').prepareAction(db,ctx,'Add these delivery costs to stock',{action:'landed_cost.apply',recordReference:doc.document_number});
  if(prepared.status!=='PREPARED')throw new ValidationError(prepared.message||prepared.answer||'StockChief could not prepare this posting for two people.');
  return prepared.proposal.id;
}
// For routing: who already approved each waiting approval.
async function approvals(db,workspaceId,rows){
  const rule=await dual.setting(db,workspaceId);
  if(rule.amount_minor==null||!await has(db,SIGNATURES))return new Map();
  const out=new Map();
  for(const r of rows.filter(r=>r.source==='proposal'&&over(rule,r))){
    const need=await requirement(db,workspaceId,r,{action_type:r.actionType,payload:r.facts.payload},rule);
    out.set(r.key,{need,people:await signers(db,workspaceId,r,need)});
  }
  return out;
}
module.exports={KINDS,requirement,canSign,signers,assertProposal,assertLandedCost,landedCostWaiting,landedCostChange,sign,approve,view,approvals,over};
