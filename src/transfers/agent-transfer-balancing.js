'use strict';

const source = require('./agent-transfer-balance-source');
const policy = require('../commercial/agent-plan');
const units = require('../domain/stock-quantity');
const permissions = require('../actions/permissions');
const { ValidationError, AuthorizationError } = require('../domain/errors');
const transfer = require('./postgres-transfer-service');
const audit = require('../operations/postgres-security-audit');

const action = 'transfer.prepare_balance';
const jobKind = 'agent.transfer-balance.v1';
const executionPlan = (state,operation) => policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,118,operation);

async function owner(db,ctx,lock=false) {
  const row=(await db.query(`SELECT u.account_id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)${lock?' FOR SHARE OF u,w':''}`,
  [ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the current inventory owner can authorize balancing requests.');
  return row.account_id;
}

async function lockAccount(db,workspaceId) {
  await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[workspaceId]);
  await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[workspaceId]);
  await db.query('SELECT workspace_id FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=118 FOR SHARE',[workspaceId]);
}

async function rule(db,workspaceId,scope,lock=false) {
  return (await db.query(`SELECT r.*, r.maximum_quantity::text FROM stockchief_runtime.agent_transfer_balance_rules r
    WHERE r.workspace_id=$1 AND r.scope_key=$2${lock?' FOR SHARE OF r':''}`,[workspaceId,scope])).rows[0]||null;
}

function permittedRule(r,state,actorId,quantity) {
  return r?.authorized_by===actorId&&r.owner_account_id===state.accountId
    && (state.plan!=='growth'||Boolean(r.taught_proposal_id)) && source.cmp(r.maximum_quantity,quantity)>=0;
}

async function trained(db,workspaceId,payload) {
  if(!payload?.scope||!payload.quantity)return false;
  const state=await policy.accountState(db,workspaceId),r=await rule(db,workspaceId,payload.scope);
  if(!r?.taught_proposal_id||!await permittedOwner(db,workspaceId,r.authorized_by))return false;
  return permittedRule(r,state,r.authorized_by,payload.quantity) && (await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate;
}

async function permittedOwner(db,workspaceId,actorId) {
  if(!actorId)return false;
  try{await owner(db,{workspaceId,actorId});return true;}catch(error){if(error instanceof AuthorizationError)return false;throw error;}
}

async function access(db,ctx,payload,automatic) {
  await owner(db,ctx,true);
  await lockAccount(db,ctx.workspaceId);
  const state=await policy.accountState(db,ctx.workspaceId),r=automatic?await rule(db,ctx.workspaceId,payload.scope,true):null;
  const exactAuthority=automatic&&permittedRule(r,state,ctx.actorId,payload.quantity);
  policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,118,automatic?'automatic':'draft',{trained:exactAuthority});
  const stopped=await policy.stopped(db,ctx.workspaceId,state,action,automatic,payload);
  if(stopped)throw new ValidationError(stopped);
  if(automatic&&(!exactAuthority||!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)){
    throw new ValidationError('Enable current routine authority and save an exact route and stocking-unit limit before automatic balancing.');
  }
  return {state,rule:r};
}

function quantity(profile,value) {
  if(value==null||String(value).trim()==='')return null;
  return String(units.validate(profile,String(value),{label:'Maximum balancing quantity',total:true}));
}

async function route(db,ctx,args) {
  const profile=await source.product(db,ctx,args.sku);
  const {from,to}=await source.locations(db,ctx,args.fromLocation,args.toLocation);
  return {profile,from,to,scope:source.scopeKey(profile,from,to)};
}

function explanation(p) {
  const u=p.unit;
  return `Prepare a request for ${p.quantity} ${u} of ${p.code} from ${p.source.name} to ${p.destination.name}.\n`
    + `The source has ${p.source.free} ${u} usable after ${p.source.committed} committed and ${p.source.held} otherwise held. It retains ${p.afterSource} ${u} against its protected target of ${p.source.reserve}.\n`
    + `The destination has ${p.destination.free} ${u} after commitments, ${p.destination.datedIncoming} dated incoming and a target of ${p.destination.target}.`
    + (p.destination.draftUnits!=='0'?` Another ${p.destination.draftUnits} ${u} are already requested and still need approval.`:'')
    + ` If the open requests arrive, the destination would have ${p.afterDestination} ${u}.\n`
    + p.lines.map(l=>[l.quantity+' '+u,l.lot?'Lot '+l.lot:null,l.serials?'Serials '+l.serials.join(', '):null,
      l.secondaryQuantity!=null?l.secondaryQuantity+' '+p.secondaryUnit:null].filter(Boolean).join(' · ')).join('\n')
    + '\nThe request holds the proposed stock. Approval, physical picking, dispatch and receipt are separate.';
}

async function build(db,ctx,_row,args) {
  await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,118,'draft');
  const {profile,from,to}=await route(db,ctx,args),maximum=quantity(profile,args.maximumBalanceQuantity);
  const p=await source.exactRoute(db,ctx,profile,from,to,maximum);
  return {payload:{scope:p.scope,skuId:p.skuId,sourceId:from.id,destinationId:to.id,quantity:p.quantity,maximum,
    sourceFingerprint:p.fingerprint,balanceSummary:{title:p.code+' · '+from.name+' → '+to.name,text:explanation(p)},
    lines:p.lines.map(({skuId,quantity,lotId,secondaryQuantity,serialUnitIds})=>({skuId,quantity,lotId,secondaryQuantity,serialUnitIds}))},
  summary:explanation(p)};
}

async function lockedRoute(db,ctx,p) {
  // Serialize these drafts with native requests, which lock both locations in
  // the same order before checking availability.
  await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',
    [ctx.workspaceId,[p.sourceId,p.destinationId]]);
  await db.query('SELECT location_id FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=ANY($3::text[]) ORDER BY location_id FOR UPDATE',
    [ctx.workspaceId,p.skuId,[p.sourceId,p.destinationId]]);
  return route(db,ctx,{sku:p.skuId,fromLocation:p.sourceId,toLocation:p.destinationId});
}

async function createDraft(db,ctx,plan,key,automatic) {
  const saved=await transfer.requestInTransaction(db,ctx,{fromLocationId:plan.source.id,toLocationId:plan.destination.id,
    idempotencyKey:key,reason:'Balance stock between locations',notes:explanation(plan),
    decisionDetail:{kind:'agent_balance_request',scope:plan.scope,sourceFingerprint:plan.fingerprint,automatic},
    lines:plan.lines});
  await audit.record(db,ctx,{action:'Prepared a stock balancing transfer request',reference:saved.transfer_number,
    after:{id:saved.id,skuId:plan.skuId,from:plan.source.id,to:plan.destination.id,quantity:plan.quantity,unit:plan.unit,
      sourceReserve:plan.source.reserve,destinationTarget:plan.destination.target,automatic}});
  return {transferId:saved.id,transferNumber:saved.transfer_number,quantity:plan.quantity,automatic,replayed:saved.replayed};
}

async function execute(db,ctx,p) {
  const automatic=ctx.agentReorderAutomatic===true;
  await access(db,ctx,p,automatic);
  const {profile,from,to}=await lockedRoute(db,ctx,p);
  const current=await source.exactRoute(db,ctx,profile,from,to,p.maximum);
  if(current.scope!==p.scope||current.fingerprint!==p.sourceFingerprint)throw new ValidationError('Stock, holds, tracking or targets changed. Review the current balancing request.');
  return createDraft(db,ctx,current,p.idempotencyKey,automatic);
}

async function verify(db,ctx,result,p) {
  const saved=await transfer.get(db,ctx.workspaceId,result.transferId);
  return saved.status==='REQUESTED'&&saved.source_location_id===p.sourceId&&saved.destination_location_id===p.destinationId
    &&saved.decision_detail?.scope===p.scope&&saved.decision_detail?.sourceFingerprint===p.sourceFingerprint
    && saved.lines.length===p.lines.length&&p.lines.every(line=>saved.lines.some(r=>r.sku_id===line.skuId
      &&r.lot_id===(line.lotId||null)&&source.cmp(r.requested_quantity,line.quantity)===0
      &&source.cmp(r.requested_secondary_quantity,line.secondaryQuantity)===0
      &&JSON.stringify(r.serials.map(s=>s.serial_unit_id).sort())===JSON.stringify([...(line.serialUnitIds||[])].sort())));
}

async function example(db,ctx,id,scope) {
  if(!id)return null;
  const p=(await db.query(`SELECT p.id,p.payload,p.result,t.status
    FROM stockchief_runtime.assistant_action_proposals p JOIN inventory_transfers t
      ON t.workspace_id=p.workspace_id AND t.id=p.result->>'transferId'
    WHERE p.workspace_id=$1 AND p.id=$2 AND p.actor_user_id=$3 AND p.action_type=$4 AND p.status='EXECUTED'
      AND p.result->>'automatic'='false' AND t.status<>'CANCELLED' AND p.payload->>'scope'=$5
      AND t.decision_detail::jsonb->>'sourceFingerprint'=p.payload->>'sourceFingerprint'`,
  [ctx.workspaceId,id,ctx.actorId,action,scope])).rows[0];
  return p;
}

async function configure(db,ctx,input) {
  return db.transaction(async c=>{
    const ownerId=await owner(c,ctx,true),revision=Number(input.revision);
    if(!Number.isSafeInteger(revision)||revision<0)throw new ValidationError('Reload the current balancing rule before saving it.');
    await lockAccount(c,ctx.workspaceId);
    if(input.mode==='remove'){
      const removed=await c.query('DELETE FROM stockchief_runtime.agent_transfer_balance_rules WHERE workspace_id=$1 AND scope_key=$2 AND revision=$3',
      [ctx.workspaceId,input.scope,revision]);
      if(!removed.rowCount)throw new ValidationError('The balancing rule changed. Reload before stopping it.');
      await audit.record(c,ctx,{action:'Stopped the saved stock balancing rule',reference:input.scope});
      return {removed:true};
    }
    const state=await policy.accountState(c,ctx.workspaceId);executionPlan(state,'draft');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the exact product, source, destination and stocking-unit limit.');
    const {profile,from,to,scope}=await route(c,ctx,input),cap=quantity(profile,input.maximumBalanceQuantity);
    if(!cap)throw new ValidationError('Set a positive stocking-unit limit for this route.');
    const prior=await rule(c,ctx.workspaceId,scope,true);
    if((prior?.revision||0)!==revision)throw new ValidationError('The balancing rule changed. Reload before saving.');
    let taught=prior?.owner_account_id===ownerId&&prior?.authorized_by===ctx.actorId?prior.taught_proposal_id:null;
    if(state.plan==='growth'||input.exampleId){
      const learned=await example(c,ctx,input.exampleId||taught,scope);
      if(!learned||source.cmp(cap,learned.payload.quantity)>0)throw new ValidationError('Complete an individually approved matching transfer request at or above this limit before teaching the route.');
      taught=learned.id;
    }else if(taught&&source.cmp(cap,prior.maximum_quantity)>0)taught=null;
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?0:1);
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'transfer-balance-rule:'+scope,8192,{finished:true});
    await c.query(`INSERT INTO stockchief_runtime.agent_transfer_balance_rules
      (workspace_id,scope_key,sku_id,source_location_id,destination_location_id,maximum_quantity,authorized_by,owner_account_id,taught_proposal_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(workspace_id,scope_key) DO UPDATE SET maximum_quantity=EXCLUDED.maximum_quantity,authorized_by=EXCLUDED.authorized_by,
        owner_account_id=EXCLUDED.owner_account_id,taught_proposal_id=EXCLUDED.taught_proposal_id,
        revision=agent_transfer_balance_rules.revision+1,updated_at=clock_timestamp()`,
    [ctx.workspaceId,scope,profile.sku_id,from.id,to.id,cap,ctx.actorId,ownerId,taught]);
    await audit.record(c,ctx,{action:'Authorized a bounded stock balancing rule',reference:profile.code,
      after:{scope,source:from.name,destination:to.name,maximum:cap,unit:profile.unit_label,taught:Boolean(taught)}});
    return {scope};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function savedRules(db,ctx,{after='',limit=50}={}) {
  await owner(db,ctx);
  return (await db.query(`SELECT r.*,s.code,src.name AS source,dst.name AS destination,i.unit_label
    FROM stockchief_runtime.agent_transfer_balance_rules r
    JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    JOIN locations src ON src.workspace_id=r.workspace_id AND src.id=r.source_location_id
    JOIN locations dst ON dst.workspace_id=r.workspace_id AND dst.id=r.destination_location_id
    WHERE r.workspace_id=$1 AND r.scope_key>$2 ORDER BY r.scope_key LIMIT $3`,
  [ctx.workspaceId,after,limit])).rows;
}

async function settings(db,ctx,{after='',exampleId='',scope=''}={}) {
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId),rules=await savedRules(db,ctx,{after,limit:51});
  const examples=(await db.query(`SELECT p.id,p.payload->>'quantity' quantity,t.transfer_number,s.code,src.name AS source,dst.name AS destination,
    t.source_location_id,t.destination_location_id
    FROM stockchief_runtime.assistant_action_proposals p JOIN inventory_transfers t ON t.workspace_id=p.workspace_id AND t.id=p.result->>'transferId'
    JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.payload->>'skuId'
    JOIN locations src ON src.workspace_id=t.workspace_id AND src.id=t.source_location_id
    JOIN locations dst ON dst.workspace_id=t.workspace_id AND dst.id=t.destination_location_id
    WHERE p.workspace_id=$1 AND p.actor_user_id=$2 AND p.action_type=$3 AND p.status='EXECUTED'
      AND p.result->>'automatic'='false' AND t.status<>'CANCELLED'
    ORDER BY (p.id=$4) DESC,p.executed_at DESC,p.id LIMIT 25`,
  [ctx.workspaceId,ctx.actorId,action,exampleId])).rows;
  const selectedExample=examples.find(p=>p.id===exampleId)||null;
  const selectedRule=scope?(await db.query(`SELECT r.*,s.code,src.name AS source,dst.name AS destination,i.unit_label
    FROM stockchief_runtime.agent_transfer_balance_rules r JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    JOIN locations src ON src.workspace_id=r.workspace_id AND src.id=r.source_location_id
    JOIN locations dst ON dst.workspace_id=r.workspace_id AND dst.id=r.destination_location_id
    WHERE r.workspace_id=$1 AND r.scope_key=$2`,[ctx.workspaceId,scope])).rows[0]:null;
  return {mode:policy.usesAgentTerms(state)?policy.allowance(state.plan,118):'excluded',rules:rules.slice(0,50),
    more:rules.length>50,nextAfter:rules[49]?.scope_key,examples,selectedExample,selectedRule};
}

async function enqueue(db,workspaceId,cycleId,after='') {
  if(!(await db.query('SELECT 1 FROM stockchief_runtime.agent_transfer_balance_rules WHERE workspace_id=$1 AND scope_key>$2 LIMIT 1',[workspaceId,after])).rowCount)return;
  await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:jobKind,
    idempotencyKey:'balance-transfer:'+cycleId+':'+after,payload:{cycleId,after},priority:60,maxAttempts:3});
}

async function work(db,workspaceId,{cycleId,after=''}) {
  const currentOwner=(await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0];
  if(!currentOwner)return {held:true};
  const ctx={workspaceId,actorId:currentOwner.id},state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,118,'automatic',{trained:true}))return {held:true};
  let rules;
  try{rules=await savedRules(db,ctx,{after,limit:11});}
  catch(error){if(error instanceof AuthorizationError)return {held:true};throw error;}
  const outcome={prepared:0,held:0};
  for(const r of rules.slice(0,10)){
    try{await db.transaction(async c=>{
      const p={scope:r.scope_key,quantity:r.maximum_quantity,skuId:r.sku_id,sourceId:r.source_location_id,destinationId:r.destination_location_id};
      const approved=await access(c,ctx,p,true),currentRule=approved.rule;
      if(currentRule.revision!==r.revision)throw new ValidationError('The current balancing rule changed.');
      const {profile,from,to}=await lockedRoute(c,ctx,p);
      const plan=await source.exactRoute(c,ctx,profile,from,to,currentRule.maximum_quantity);
      if(plan.scope!==currentRule.scope_key)throw new ValidationError('The product or stocking unit changed.');
      await createDraft(c,ctx,plan,'agent-balance:'+r.scope_key+':'+plan.fingerprint,true);
    },{isolation:'SERIALIZABLE',retrySafe:true});outcome.prepared++;}
    catch(error){if(!['validation_error','entitlement_required','forbidden','not_found'].includes(error.code))throw error;outcome.held++;}
  }
  if(rules.length>10)await enqueue(db,workspaceId,cycleId,rules[9].scope_key);
  return outcome;
}

async function review(db,ctx,{filter='',page=1,adviceOnly=false}) {
  await owner(db,ctx);
  const rows=(await db.query(`WITH candidates AS MATERIALIZED(
    SELECT sku_id FROM reorder_policies WHERE workspace_id=$1 AND location_id IS NOT NULL AND $2=''
    UNION SELECT sku_id FROM stockchief_runtime.replenishment_demand_events WHERE workspace_id=$1 AND $2=''
      AND occurred_at>=CURRENT_TIMESTAMP-interval '90 days' AND occurred_at<=CURRENT_TIMESTAMP GROUP BY sku_id,location_id HAVING count(*)>=2)
    SELECT i.*,s.id AS sku_id,s.code,s.variant_label FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND
      ($2<>'' AND lower(s.code)=lower($2) OR $2='' AND s.id IN(SELECT sku_id FROM candidates))
    ORDER BY s.id LIMIT 26 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*25])).rows;
  const profiles=rows.slice(0,25),f=await source.snapshot(db,ctx,profiles),result=[];
  for(const p of profiles){
    const positions=f.bySku.get(p.sku_id)||[];
    const spare=new Map(positions.map(row=>[row.id,row.spare]));
    const selected=new Map();
    const destinations=positions.filter(d=>d.target!==null&&source.cmp(d.target,d.openProjection)>0)
      .sort((a,b)=>(a.daysOfSupply??Infinity)-(b.daysOfSupply??Infinity)||a.id.localeCompare(b.id));
    for(const to of destinations){
      let need=source.sub(to.target,to.openProjection);
      if(to.uncertainty.length){
        result.push({SKU:p.code,To:to.name,Unit:p.unit_label,Review:'Check pending or held incoming: '+to.uncertainty.map(r=>r.reference).join(', ')});
        continue;
      }
      const donors=positions.filter(from=>from.id!==to.id&&source.cmp(spare.get(from.id),'0')>0)
        .filter(from=>!to.drafts.some(d=>d.source_location_id===from.id))
        .sort((a,b)=>source.cmp(spare.get(b.id),spare.get(a.id))||a.id.localeCompare(b.id));
      if(!donors.length)result.push({SKU:p.code,To:to.name,Unit:p.unit_label,Review:'No costed, usable stock is free above the other locations’ protected targets.'});
      for(const from of donors){
        if(source.cmp(need,'0')<=0)break;
        try{
          const prior=selected.get(from.id)||[];
          const plan=await source.exactRoute(db,ctx,p,from,to,source.min(need,spare.get(from.id)),f,prior);
          selected.set(from.id,prior.concat(plan.lines));
          spare.set(from.id,source.sub(spare.get(from.id),plan.quantity));need=source.sub(need,plan.quantity);
          result.push({SKU:p.code,From:from.name,To:to.name,Quantity:plan.quantity,Unit:p.unit_label,
            'Source free after other commitments':from.free,'Source protected target':from.reserve,
            'Destination stock target':to.target,'Dated incoming':to.datedIncoming,'Pending balancing requests':to.draftUnits,
            Review:plan.lines.map(l=>l.lot?'Lot '+l.lot:l.serials?'Serials '+l.serials.join(', '):null).filter(Boolean).join(' · ')||'Recorded available stock'});
        }catch(error){if(!(error instanceof ValidationError))throw error;result.push({SKU:p.code,From:from.name,To:to.name,Unit:p.unit_label,Review:error.message});}
      }
    }
  }
  const summary='Use costed, usable stock above the source’s protected target to cover the destination shortfall. Suggestions account for customer commitments, held stock, exact tracking and dated incoming. The transfer request holds proposed stock until separately approved and physically handled.';
  if(adviceOnly){
    const suggestion=result.find(r=>r.Quantity);
    if(suggestion)return {rows:[suggestion],summary};
    if(rows.length>25&&!filter){
      const next=await review(db,ctx,{filter,page:page+1,adviceOnly});
      if(next.rows.some(r=>r.Quantity))return next;
    }
    return {rows:result.slice(0,1),summary};
  }
  return {rows:result,more:rows.length>25,balanceForm:true,summary};
}

const spec={name:action,agentJob:118,ownerOnly:true,permission:permissions.REQUEST_TRANSFER,capability:'inventory.transfers',
  fields:['sku','fromLocation','toLocation','maximumBalanceQuantity'],
  resultingRecords:['inventory_transfers'],resultReference:'transferId',resultDisplayReference:'transferNumber',resultRecordKind:'transfer',
  description:'Prepare a native Requested balancing transfer for one exact product and owned route. Use current costed and unheld stock above the source target to cover the destination shortage. Include exact lots, serials and independently measured weight when recorded. Use an explicit maximum only when supplied; the saved rule always controls automation. Do not approve, pick, dispatch or receive.',
  build,execute,verify};
const definition={id:118,key:'balance-transfers',label:'Balance stock between locations',filterLabel:'Exact product or variant code',readPage:review};
module.exports={action,jobKind,spec,definition,trained,configure,settings,enqueue,work};
