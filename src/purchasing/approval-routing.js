'use strict';
const dual=require('./dual-approval');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const permissions=require('../actions/permissions');

async function assignments(db,workspaceId){
  const rule=await dual.setting(db,workspaceId);
  if(rule.amount_minor==null)return [];
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,176,'automatic'))return [];
  const orders=(await db.query(`SELECT p.id,p.po_number,p.currency,${dual.recordFields},s.signatures,now() AS as_of
    FROM purchase_orders p JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('account',account_id,'actor',actor_id,'digest',digest,'amount',amount_minor::text,'at',signed_at)
        ORDER BY signed_at,account_id) signatures FROM stockchief_runtime.purchase_approval_signatures
        WHERE workspace_id=p.workspace_id AND purchase_order_id=p.id
    ) s ON s.signatures IS NOT NULL WHERE p.workspace_id=$1 AND p.status IN ('DRAFT','AWAITING_APPROVAL','APPROVED')
    ORDER BY p.po_number,p.id`,[workspaceId])).rows;
  if(!orders.length)return [];
  const people=(await db.query(`SELECT u.id,u.account_id,u.name,u.role,u.permissions,u.po_approval_limit_minor,u.po_approval_currency,u.warehouse_location_ids
    FROM users u LEFT JOIN platform_account_access a ON a.account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.account_id IS NOT NULL AND a.disabled_at IS NULL
    ORDER BY (u.role='owner'),u.po_approval_limit_minor NULLS LAST,u.id`,[workspaceId])).rows;
  const rows=[];
  // Passing to the next reviewer (job 172) waits in the first 14 days, pause,
  // Watch only and Ask me first; the request then stays with the first reviewer.
  const held=policy.permits(state.plan,172,'automatic')?await policy.stopped(db,workspaceId,state,'alert.escalation',true):'plan';
  for(const o of orders){
    const digest=dual.digestFor(rule,o),signed=o.signatures.filter(s=>s.digest===digest);
    const current=signed.filter(s=>people.some(p=>p.id===s.actor&&p.account_id===s.account&&dual.eligible(p,o.currency,Number(s.amount))));
    if(current.length>=2)continue;
    const first=current[0],owner=people.find(p=>p.role==='owner');
    let next=owner,reason='The purchase or its approval rule changed. Review the current terms.';
    if(first){
      const candidates=people.filter(p=>p.account_id!==first.account&&permissions.can(p,permissions.VIEW_PURCHASING)&&dual.eligible(p,o.currency,Number(first.amount)));
      if(candidates.length){
        const elapsed=Math.max(0,new Date(o.as_of)-new Date(first.at));
        const turns=held?0:Math.floor(elapsed/(rule.escalation_hours*3600000));
        const index=Math.min(turns,candidates.length-1);
        next=candidates[index];
        reason=(index?'The previous reviewer’s response window passed. ':'')+'The '+money.format(first.amount,o.currency)+' order needs a second signature.';
      }else reason='A second eligible person is needed. Review team purchase permissions and approval limits.';
    }
    if(next)rows.push({actor:next.id,reviewer:next.name,order:o.po_number,id:o.id,reason,at:first?.at||o.signatures.at(-1).at});
  }
  return rows;
}
async function inbox(db,workspaceId,actorId){
  const rows=await assignments(db,workspaceId);
  return rows.filter(r=>r.actor===actorId).map(r=>({kind:'approval',importance:'Important',priority:82,
    title:'Review purchase '+r.order,happened:r.reason,actionLabel:'Review purchase',href:'/purchasing/orders/'+r.id,
    sourceId:'po-signature-'+r.id,createdAt:r.at,at:r.at}));
}
const rows=async(db,ctx)=>({summary:'These purchase orders have entered two-person review. Eligible buyers are ordered by their spending limit, with the owner as fallback.',
  rows:(await assignments(db,ctx.workspaceId)).map(r=>({Order:r.order,Reviewer:r.reviewer,Reason:r.reason,link:'/purchasing/orders/'+r.id}))});
const definitions=[
  {id:176,key:'purchase-review-routing',label:'Route purchase approvals by role and amount',read:rows},
  {id:172,key:'purchase-review-escalation',label:'Pass unanswered purchase approvals to the next reviewer',read:rows}
];
module.exports={assignments,inbox,definitions};
