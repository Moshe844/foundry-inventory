'use strict';
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const {hash}=require('../pricing/postgres-promotions');
const {ValidationError}=require('../domain/errors');
const jobs=new Map([['customer_return.send_label',112],['warehouse.release_partial_order',61],['sales_order.reserve_all',12],['sales_order.allocation_priority',65],['sales_quote.followup',74],['customer.statement',81],['landed_cost.apply',49],['warehouse.wave.create',57],['warehouse.release_orders',56],['supplier_invoice.dispute',100],['sales_order.reserve_arrived',48],['customer_payment.match_bank_line',103],['sales_order.create',null],['catalog.supplier_price_list',135],['manufacturing.create_work_order',14],['sales_quote.create',73],['sales_order.repeat',53],['purchase_order.combine_drafts',24],['purchase_order.split_draft',25]]);
jobs.set('purchase_order.reorder_drafts',19);jobs.set('purchasing.select_supplier',22);
function eligible(plan,action){
 return action==='sales_order.create'?['growth','pro','enterprise'].includes(plan):policy.permits(plan,jobs.get(action),'automatic',{trained:true});
}

function scope(partyId,currency,amountMinor,qualification,label){
  return {key:hash([partyId,currency,qualification]),label,currency,amountMinor:money.integer(amountMinor)};
}
async function history(db,ctx,action,bound,amount){
  const {rows:[row]}=await db.query(`SELECT count(*) total,count(*) FILTER(WHERE (payload#>>'{training,amountMinor}')::numeric<=$5) covered
    FROM stockchief_runtime.assistant_action_proposals p WHERE workspace_id=$1 AND action_type=$2 AND status='EXECUTED'
      AND payload#>>'{training,key}'=$3 AND payload#>>'{training,currency}'=$4 AND result->>'replayed' IS DISTINCT FROM 'true'
      AND result#>>'{executionAuthority,kind}' IS DISTINCT FROM 'standing_job_rule'
      AND ($2 NOT IN('sales_order.reserve_all','sales_order.allocation_priority') OR result->>'automatic'='false')
      AND ($2<>'sales_order.reserve_all' OR jsonb_array_length(coalesce(result->'allocations','[]'::jsonb))>0)
      AND ($2<>'sales_quote.followup' OR (result->>'automatic' IS DISTINCT FROM 'true' AND EXISTS(
        SELECT 1 FROM customer_communications m JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
        WHERE m.workspace_id=p.workspace_id AND m.id=p.result->>'communicationId' AND m.customer_id=p.payload->>'customerId' AND m.status='SENT' AND m.external_message_id IS NOT NULL
        AND e.payload->'standingAuthority'->>'kind'='quote_followup' AND e.payload->'standingAuthority'->>'automatic'='false' AND e.payload->'standingAuthority'->>'sourceFingerprint'=p.payload->>'sourceFingerprint')))
      AND ($2<>'customer.statement' OR (result->>'automatic' IS DISTINCT FROM 'true' AND EXISTS(
        SELECT 1 FROM customer_communications m JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
        WHERE m.workspace_id=p.workspace_id AND m.id=p.result->>'communicationId' AND m.customer_id=p.payload->>'recordId'
        AND m.status='SENT' AND m.external_message_id IS NOT NULL AND e.payload->'standingAuthority'->>'kind'='customer_statement'
        AND e.payload->'standingAuthority'->>'automatic'='false' AND e.payload->'standingAuthority'->>'sourceFingerprint'=p.payload->>'sourceFingerprint')))
      AND ($2<>'customer_return.send_label' OR (result->>'automatic'='false' AND EXISTS(SELECT 1 FROM customer_communications m JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED' WHERE m.workspace_id=p.workspace_id AND m.id=p.result->>'communicationId' AND m.customer_id=p.payload->>'customerId' AND m.status='SENT' AND m.external_message_id IS NOT NULL AND e.payload->'standingAuthority'->>'kind'='return_label' AND e.payload->'standingAuthority'->>'automatic'='false' AND e.payload->'standingAuthority'->>'sourceFingerprint'=p.payload->>'sourceFingerprint')))
      AND ($2<>'warehouse.release_partial_order' OR (result->>'automatic'='false' AND ${require('../warehouse/partial-shipment-evidence').completionSql('p')}))
      AND ($2<>'landed_cost.apply' OR (result->>'automatic' IS DISTINCT FROM 'true' AND payload->>'needsLandedCostConfirmation'='false'))
      AND ($2<>'supplier_invoice.dispute' OR (payload->>'needsDisputeConfirmation'='false' AND EXISTS(
        SELECT 1 FROM supplier_communications m JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
        WHERE m.workspace_id=p.workspace_id AND m.id=p.result->>'communicationId' AND m.invoice_dispute_bill_id=p.payload->>'recordId'
         AND m.status='SENT' AND m.external_message_id IS NOT NULL AND e.payload->'standingAuthority'->>'kind'='invoice_dispute'
         AND e.payload->'standingAuthority'->>'automatic'='false' AND e.payload->'standingAuthority'->>'sourceFingerprint'=p.payload->>'sourceFingerprint')))` ,[ctx.workspaceId,action,bound.key,bound.currency,amount]);
  return {total:Number(row.total),covered:Number(row.covered)};
}
async function settings(db,ctx,id,maximum){
  const state=await require('./job-reviews').ownerState(db,ctx);
  const {rows:[p]}=await db.query('SELECT id,action_type,payload,status,result,idempotency_key FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);
  const bound=p?.payload?.training;
  if(!jobs.has(p?.action_type)||!bound?.key||!policy.usesAgentTerms(state))return null;
  const rule=(await db.query('SELECT * FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3',
    [ctx.workspaceId,p.action_type,bound.key])).rows[0];
  const allowed=eligible(state.plan,p.action_type);
  if(!allowed&&!rule)return null;
  const amount=maximum?money.userToMinor(maximum,bound.currency):null;
  return {action:p.action_type,bound,eligible:allowed,needsReturnLabelReceipt:p.action_type==='customer_return.send_label'&&state.plan==='growth'&&!await require('../shipping/agent-return-instructions').confirmedExample(db,ctx.workspaceId,p),needsPhysicalShipment:p.action_type==='warehouse.release_partial_order'&&state.plan==='pro'&&!await require('../warehouse/agent-partial-shipments').completedExample(db,ctx,p),exampleAmount:money.fromMinor(bound.amountMinor,bound.currency),
    preview:amount>0?{...(await history(db,ctx,p.action_type,bound,amount)),maximum:money.fromMinor(amount,bound.currency)}:null,
    rule:rule?{revision:rule.revision,amount:money.fromMinor(rule.maximum_minor,bound.currency)}:null,
    canTeach:allowed&&(!['purchase_order.reorder_drafts','purchasing.select_supplier'].includes(p.action_type)||p.result?.automatic!==true)&&p.status==='EXECUTED'&&!state.shadow&&p.result?.replayed!==true&&p.result?.executionAuthority?.kind!=='standing_job_rule'&&
      (!['sales_order.reserve_all','sales_order.allocation_priority'].includes(p.action_type)||await require('../sales/agent-order-reservations').completedExample(db,ctx,p))&&
      (p.action_type!=='warehouse.release_partial_order'||await require('../warehouse/agent-partial-shipments').completedExample(db,ctx,p))&&
      (p.action_type!=='landed_cost.apply'||(p.result?.automatic!==true&&p.payload.needsLandedCostConfirmation===false))&&
      (p.action_type!=='sales_quote.followup'||await require('../sales/agent-quote-followups').confirmedExample(db,ctx.workspaceId,p))&&
      (p.action_type!=='customer_return.send_label'||await require('../shipping/agent-return-instructions').confirmedExample(db,ctx.workspaceId,p))&&
      (p.action_type!=='customer.statement'||await require('../accounting/agent-customer-statements').confirmedExample(db,ctx.workspaceId,p))&&
      (p.action_type!=='supplier_invoice.dispute'||await require('../purchasing/agent-invoice-disputes').confirmedExample(db,ctx.workspaceId,p))};
}
async function save(db,ctx,id,input){
  return db.transaction(async c=>{
    const data=await settings(c,ctx,id,input.mode==='save'?input.maximum:null);
    if(!data)throw new ValidationError('This plan or example cannot train that routine.');
    const {bound,action}=data,revision=Number(input.revision);
    if(!Number.isSafeInteger(revision)||revision<0)throw new ValidationError('Reload the routine before editing it.');
    let changed;
    const args=[ctx.workspaceId,action,bound.key];
    if(input.mode==='remove')changed=await c.query('DELETE FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3 AND revision=$4',[...args,revision]);
    else{
      if(input.mode!=='save'||!data.canTeach)throw new ValidationError(action==='supplier_invoice.dispute'?'Wait for the mailbox to confirm an individually approved dispute from a fully matched original before teaching this supplier scope.':'Complete a reviewed example outside shadow mode before teaching this routine.');
      const amount=money.userToMinor(input.maximum,bound.currency);
      if(amount<=0)throw new ValidationError(action==='customer.statement'?'Set a positive maximum account value.':action==='customer_payment.match_bank_line'?'Set a positive maximum receipt amount.':'Set a positive maximum goods value.');
      await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],revision===0?1:0);
      const values=[...args,bound.label,bound.currency,amount,ctx.actorId];
      changed=revision===0?await c.query(`INSERT INTO stockchief_runtime.agent_draft_rules(workspace_id,action_type,scope_key,scope_label,currency,maximum_minor,authorized_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,values):
        await c.query(`UPDATE stockchief_runtime.agent_draft_rules SET scope_label=$4,currency=$5,maximum_minor=$6,authorized_by=$7,revision=revision+1
          WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3 AND revision=$8`,[...values,revision]);
    }
    if(!changed.rowCount)throw new ValidationError('The routine changed. Reload before saving.');
    await require('../operations/postgres-security-audit').record(c,ctx,{action:action==='sales_quote.followup'?'Quotation follow-up routine changed':action==='customer.statement'?'Customer statement routine changed':action==='customer_payment.match_bank_line'?'Customer receipt routine changed':'Draft order routine changed',reference:id,after:{mode:input.mode,scope:bound.label,maximum:input.maximum,history:data.preview}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function trained(db,workspaceId,name,payload,proposalId){
  if(name==='transfer.prepare_balance')return require('../transfers/agent-transfer-balancing').trained(db,workspaceId,payload);
  if(name==='warehouse.prepare_putaway')return require('../warehouse/agent-putaway').trained(db,workspaceId,payload);
  if(!jobs.has(name))return false;
  if(!payload&&proposalId)payload=(await db.query('SELECT payload FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2 AND action_type=$3',[workspaceId,proposalId,name])).rows[0]?.payload;
  const bound=payload?.training;
  if(!bound?.key||!Number.isSafeInteger(bound.amountMinor)||bound.amountMinor<=0)return false;
  const state=await require('./postgres-service').getState(db,workspaceId);
  if(!state.canAutomate)return false;
  return Boolean((await db.query(`SELECT 1 FROM stockchief_runtime.agent_draft_rules r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.role='owner'
    WHERE r.workspace_id=$1 AND r.action_type=$2 AND r.scope_key=$3 AND r.currency=$4 AND r.maximum_minor>=$5`,[workspaceId,name,bound.key,bound.currency,bound.amountMinor])).rowCount);
}
module.exports={scope,settings,save,trained,jobs,eligible};
