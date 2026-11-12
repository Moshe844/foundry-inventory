'use strict';
// Job 176: each approval goes to the right person by role and amount.
//
// The desk is every approval StockChief knows is waiting: purchase orders,
// stock adjustments and write-offs, refunds and credits, landed costs,
// supplier price changes, transfers and returns. Each one goes to a single
// person:
//  1. the owner's routing rule ("refunds over $500 go to Sarah, not me"),
//     when that person can approve it;
//  2. otherwise the team member with the lowest amount authority that covers
//     it, so routine approvals do not wait for the owner;
//  3. otherwise the owner.
// "Can approve it" means the approval's own permission (and the owner, where
// the service itself needs the owner), access to the whole inventory, and a
// limit for that kind in that currency that covers the amount. A money
// approval whose amount cannot be worked out never goes to someone with a
// limit: it stops with the owner.
//
// Routing is StockChief acting on its own (Pro and Custom). During the first
// 14 days, Watch only, pause, Ask me first and an exceeded rule allowance it is
// held, and every approval stays with the owner. Each approval is still
// decided through its own service, which checks the person again.
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const permissions=require('../actions/permissions');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const {has}=require('../db/schema-installed');
const {newId}=require('../lib/util');
const audit=require('../operations/postgres-security-audit');

const JOB=176,path='/autopilot/approval-routing';
const ROUTES='stockchief_runtime.agent_approval_routes',LIMITS='stockchief_runtime.agent_approval_limits',ASSIGNED='stockchief_runtime.agent_approval_assignments';
const KINDS={
  purchase:{label:'Purchase orders',noun:'purchase orders',money:true},
  adjustment:{label:'Stock adjustments and write-offs',noun:'stock adjustments and write-offs',money:true},
  refund:{label:'Refunds and credits',noun:'refunds and credits',money:true},
  landed_cost:{label:'Landed costs',noun:'landed costs',money:true},
  supplier_price:{label:'Supplier price changes',noun:'supplier price changes',money:false},
  transfer:{label:'Transfers',noun:'transfers',money:false},
  return:{label:'Returns',noun:'returns',money:false},
};
// Purchase limits stay on the Team page; these kinds keep their own limit here.
const LIMIT_KINDS=['adjustment','refund','landed_cost'];
const amountOf=(minor,currency)=>{const n=Number(minor);return Number.isSafeInteger(n)&&n>=0&&/^[A-Z]{3}$/.test(String(currency||''))?{amountMinor:n,currency}:{amountMinor:null,currency:/^[A-Z]{3}$/.test(String(currency||''))?currency:null};};
// Prepared changes, by what they would do. Purchase orders, transfers and
// returns waiting as records are read directly.
const ACTIONS={
  'inventory.adjust':{kind:'adjustment'},
  'inventory.write_down_aged':{kind:'adjustment',amount:p=>amountOf(p.writeDownMinor,p.currency)},
  'customer_credit.prepare':{kind:'refund',amount:p=>amountOf(Math.max(Number(p.creditMinor)||0,Number(p.refundMinor)||0),p.currency)},
  'customer_return.refund':{kind:'refund',amount:p=>p.amountMinor==null?amountOf(null,p.currency):amountOf((Number(p.amountMinor)||0)+(Number(p.arMinor)||0),p.currency)},
  'customer_return.credit_receipt':{kind:'refund',amount:p=>amountOf(p.review?.totalMinor,p.review?.currency)},
  'landed_cost.apply':{kind:'landed_cost',amount:p=>amountOf(p.training?.amountMinor,p.training?.currency)},
  'catalog.set_purchase_cost':{kind:'supplier_price'},
  'catalog.supplier_price_list':{kind:'supplier_price'},
  'inventory.transfer':{kind:'transfer'},'transfer.approve':{kind:'transfer'},'transfer.prepare_balance':{kind:'transfer'},
  'customer_return.request':{kind:'return'},'customer_return.authorize':{kind:'return'},
  'supplier_return.request':{kind:'return'},'supplier_return.authorize':{kind:'return'},
};
const exponents=Object.fromEntries([...Intl.supportedValuesOf('currency'),'CLF','UYW'].map(code=>[code,money.exponent(code)]));
function readPermission(action){
  return permissions.ACCOUNTING.includes(action)?permissions.VIEW_ACCOUNTING:permissions.SALES.includes(action)?permissions.VIEW_SALES:
    permissions.PURCHASING.includes(action)?permissions.VIEW_PURCHASING:permissions.TRANSFERS.includes(action)?permissions.VIEW_TRANSFERS:permissions.VIEW;
}
const format=(r)=>r.amountMinor==null?null:money.format(r.amountMinor,r.currency);

// Everything waiting for a person's approval, oldest first.
async function requests(db,workspaceId){
  const totals=require('../operations/postgres-team-access').purchaseTotalsSql('p.workspace_id','p.id',"power(10::numeric,($2::jsonb->>p.currency)::int)");
  const registry=require('../assistant/postgres-capability-registry').registry;
  const [orders,transfers,customerReturns,supplierReturns,prepared]=await Promise.all([
    db.query(`SELECT p.id,p.po_number,p.currency,p.created_at,p.supplier_id,s.name AS supplier,(billed.lines+billed.charges)::text AS amount
      FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
      JOIN LATERAL (${totals}) billed ON billed.priced
      WHERE p.workspace_id=$1 AND p.status IN ('DRAFT','AWAITING_APPROVAL')
      AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.purchase_approval_signatures g WHERE g.workspace_id=p.workspace_id AND g.purchase_order_id=p.id)
      ORDER BY p.created_at,p.id LIMIT 200`,[workspaceId,JSON.stringify(exponents)]),
    db.query(`SELECT t.id,t.transfer_number,t.created_at,t.source_location_id,t.destination_location_id,src.name AS source,dst.name AS destination
      FROM inventory_transfers t JOIN locations src ON src.workspace_id=t.workspace_id AND src.id=t.source_location_id
      JOIN locations dst ON dst.workspace_id=t.workspace_id AND dst.id=t.destination_location_id
      WHERE t.workspace_id=$1 AND t.status='REQUESTED' ORDER BY t.created_at,t.id LIMIT 200`,[workspaceId]),
    db.query(`SELECT r.id,r.return_number,r.created_at,r.resolution,c.id AS customer_id,c.name AS customer FROM customer_returns r
      JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
      WHERE r.workspace_id=$1 AND r.status='REQUESTED' ORDER BY r.created_at,r.id LIMIT 200`,[workspaceId]),
    db.query(`SELECT r.id,r.return_number,r.created_at,r.supplier_id,s.name AS supplier FROM supplier_returns r
      JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id
      WHERE r.workspace_id=$1 AND r.status='REQUESTED' ORDER BY r.created_at,r.id LIMIT 200`,[workspaceId]),
    // Changes inside an Ask conversation or an approved multi-step request stay
    // with the person who asked; that conversation continues from them.
    db.query(`SELECT p.id,p.action_type,p.payload,p.summary,p.created_at,p.actor_user_id FROM stockchief_runtime.assistant_action_proposals p
      WHERE p.workspace_id=$1 AND p.status='PENDING' AND p.action_type=ANY($2::text[])
      AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.assistant_goals g
        CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(g.checkpoint#>'{harness,approvalDeliveries}')='object' THEN g.checkpoint#>'{harness,approvalDeliveries}' ELSE '{}'::jsonb END) d
        WHERE g.workspace_id=p.workspace_id AND g.actor_user_id=p.actor_user_id AND d.value->>'proposalId'=p.id)
      AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.assistant_capability_plans m WHERE m.workspace_id=p.workspace_id
        AND m.steps @> jsonb_build_array(jsonb_build_object('proposalId',p.id)))
      ORDER BY p.created_at,p.id LIMIT 200`,[workspaceId,Object.keys(ACTIONS)]),
  ]);
  const adjustments=prepared.rows.filter(p=>p.action_type==='inventory.adjust').map(p=>p.id);
  const valued=adjustments.length?new Map((await db.query(`SELECT p.id,coalesce(b.on_hand,0)::text AS physical,coalesce(c.quantity_units,0)::text AS costed,
      coalesce(c.total_cost_minor,0)::text AS value,(SELECT base_currency FROM accounting_settings WHERE workspace_id=p.workspace_id AND enabled=1) AS currency
    FROM stockchief_runtime.assistant_action_proposals p
    LEFT JOIN balances b ON b.workspace_id=p.workspace_id AND b.sku_id=p.payload->>'skuId' AND b.location_id=p.payload->>'locationId'
    LEFT JOIN accounting_inventory_cost_balances c ON c.workspace_id=p.workspace_id AND c.sku_id=p.payload->>'skuId' AND c.location_id=p.payload->>'locationId'
    WHERE p.workspace_id=$1 AND p.id=ANY($2::text[])`,[workspaceId,adjustments])).rows.map(r=>[r.id,r])):new Map();
  const out=[];
  for(const o of orders.rows){const amount=amountOf(o.amount,o.currency);
    out.push({key:'purchase:'+o.id,source:'purchase',id:o.id,kind:'purchase',permission:permissions.APPROVE_PO,readPermission:permissions.VIEW_PURCHASING,ownerOnly:false,...amount,
      href:'/purchasing/orders/'+o.id,title:'Approve purchase '+o.po_number+' from '+o.supplier+(amount.amountMinor==null?'':' ('+money.format(amount.amountMinor,o.currency)+')'),
      at:o.created_at,facts:{supplierId:o.supplier_id,currency:o.currency,label:o.supplier}});}
  for(const t of transfers.rows)out.push({key:'transfer:'+t.id,source:'transfer',id:t.id,kind:'transfer',permission:permissions.APPROVE_TRANSFER,readPermission:permissions.VIEW_TRANSFERS,ownerOnly:false,
    amountMinor:null,currency:null,href:'/transfers/'+t.id,title:'Approve transfer '+t.transfer_number+' from '+t.source+' to '+t.destination,at:t.created_at,
    facts:{from:t.source_location_id,to:t.destination_location_id,label:t.source+' to '+t.destination}});
  for(const r of customerReturns.rows)out.push({key:'customer_return:'+r.id,source:'customer_return',id:r.id,kind:'return',permission:permissions.AUTHORIZE_CUSTOMER_RETURN,readPermission:permissions.VIEW_SALES,ownerOnly:false,
    amountMinor:null,currency:null,href:'/returns/'+r.id,title:'Authorize return '+r.return_number+' from '+r.customer,at:r.created_at,
    facts:{customerId:r.customer_id,resolution:r.resolution,label:r.customer}});
  for(const r of supplierReturns.rows)out.push({key:'supplier_return:'+r.id,source:'supplier_return',id:r.id,kind:'return',permission:permissions.AUTHORIZE_SUPPLIER_RETURN,readPermission:permissions.VIEW_PURCHASING,ownerOnly:false,
    amountMinor:null,currency:null,href:'/supplier-returns/'+r.id,title:'Authorize return '+r.return_number+' to '+r.supplier,at:r.created_at,
    facts:{supplierId:r.supplier_id,label:r.supplier}});
  for(const p of prepared.rows){
    const spec=ACTIONS[p.action_type],contract=registry.get(p.action_type);
    if(!contract?.permission)continue;
    const payload=p.payload||{};let amount={amountMinor:null,currency:null};
    if(spec.amount)amount=spec.amount(payload);
    else if(p.action_type==='inventory.adjust'){
      const v=valued.get(p.id),costed=Number(v?.costed),change=Math.abs(Number(payload.countedQuantity)-Number(v?.physical));
      amount=v&&costed>0&&Number.isFinite(change)?amountOf(Math.round(change*Number(v.value)/costed),v.currency):amountOf(null,v?.currency);
    }
    out.push({key:'proposal:'+p.id,source:'proposal',id:p.id,kind:spec.kind,actionType:p.action_type,permission:contract.permission,readPermission:readPermission(contract.permission),
      ownerOnly:Boolean(contract.ownerOnly),...amount,href:'/actions/'+p.id,title:require('../web/proposal-presentation').summary(p),at:p.created_at,
      preparedBy:p.actor_user_id,facts:{actionType:p.action_type,payload}});
  }
  return out;
}

async function people(db,workspaceId){
  return (await db.query(`SELECT u.id,u.account_id,u.name,u.role,u.permissions,u.po_approval_limit_minor,u.po_approval_currency,u.warehouse_location_ids
    FROM users u LEFT JOIN platform_account_access a ON a.account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.account_id IS NOT NULL AND a.disabled_at IS NULL ORDER BY (u.role='owner') DESC,u.name,u.id`,[workspaceId])).rows;
}
async function settings(db,workspaceId){
  const installed=await has(db,ROUTES);
  if(!installed)return {rules:[],limits:[]};
  const [rules,limits]=await Promise.all([
    db.query(`SELECT r.id,r.kind,r.currency,r.above_minor,r.user_id,u.name FROM ${ROUTES} r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.user_id
      WHERE r.workspace_id=$1 AND r.enabled ORDER BY r.kind,r.above_minor NULLS FIRST,r.id`,[workspaceId]),
    db.query(`SELECT user_id,kind,currency,limit_minor FROM ${LIMITS} WHERE workspace_id=$1`,[workspaceId])]);
  return {rules:rules.rows,limits:limits.rows};
}
function authority(person,kind,limits){
  if(kind==='purchase')return person.po_approval_limit_minor==null?null:{amountMinor:Number(person.po_approval_limit_minor),currency:person.po_approval_currency};
  const row=limits.find(l=>l.user_id===person.id&&l.kind===kind);
  return row?{amountMinor:Number(row.limit_minor),currency:row.currency}:null;
}
// Whether a person's amount authority covers this approval.
function covers(person,request,limits){
  if(person.role==='owner'||!KINDS[request.kind].money)return true;
  const limit=authority(person,request.kind,limits);
  return !limit||request.amountMinor!=null&&request.currency===limit.currency&&request.amountMinor<=limit.amountMinor;
}
function eligible(person,request,limits){
  if(!permissions.can(person,request.permission)||!permissions.can(person,request.readPermission))return false;
  if(person.role==='owner')return true;
  if(request.ownerOnly||person.warehouse_location_ids!==null)return false;
  return covers(person,request,limits);
}
function describeRule(rule,name=rule.name){
  return KINDS[rule.kind].label+(rule.above_minor==null?'':' over '+money.format(Number(rule.above_minor),rule.currency))+' go to '+name;
}
// The most specific rule that applies: the highest amount it exceeds.
function ruleFor(request,rules){
  return rules.filter(r=>r.kind===request.kind&&(r.above_minor==null||request.amountMinor!=null&&request.currency===r.currency&&request.amountMinor>Number(r.above_minor)))
    .sort((a,b)=>(b.above_minor==null?-1:Number(b.above_minor))-(a.above_minor==null?-1:Number(a.above_minor)))[0]||null;
}
function why(person,request,limits){
  const limit=authority(person,request.kind,limits);
  return limit?person.name+' can approve '+KINDS[request.kind].noun+' up to '+money.format(limit.amountMinor,limit.currency)+'.':person.name+' can approve '+KINDS[request.kind].noun+'.';
}
// The lowest limit in this currency first, so the owner and senior people see
// only what others cannot approve. Anyone without a limit comes after.
function byAuthority(request,limits){
  return (a,b)=>{const x=authority(a,request.kind,limits),y=authority(b,request.kind,limits);
    return (x?0:1)-(y?0:1)||(x&&y?x.amountMinor-y.amountMinor:0)||String(a.name).localeCompare(String(b.name))||String(a.id).localeCompare(String(b.id));};
}
function route(request,{people:team,limits,rules,held}){
  const owner=team.find(p=>p.role==='owner');
  if(!held){
    const rule=ruleFor(request,rules),named=rule&&team.find(p=>p.id===rule.user_id);
    if(named&&eligible(named,request,limits))return {person:named,reason:'Your rule: '+describeRule(rule,named.name)+'.',rule:rule.id};
    const staff=team.filter(p=>p.role!=='owner'&&eligible(p,request,limits)).sort(byAuthority(request,limits));
    if(staff.length)return {person:staff[0],reason:why(staff[0],request,limits)+(rule?' '+named?.name+' cannot approve this one.':'')};
    if(owner)return {person:owner,reason:request.ownerOnly?'Only the owner can approve this.':KINDS[request.kind].money&&request.amountMinor==null?'StockChief could not work out its amount, so it stays with the owner.':'No one else on the team can approve this.'};
  }
  return owner?{person:owner,reason:held}:{person:null,reason:'No one can approve this yet.'};
}
// Why routing is held, or null when StockChief may route on its own.
async function holdReason(db,workspaceId,state){
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return 'Your plan sends every approval to the owner.';
  return policy.stopped(db,workspaceId,state,'approval.route',true);
}
async function desk(db,workspaceId,{state=null}={}){
  state=state||await policy.accountState(db,workspaceId);
  const [list,team,saved,held]=await Promise.all([requests(db,workspaceId),people(db,workspaceId),settings(db,workspaceId),holdReason(db,workspaceId,state)]);
  const context={people:team,limits:saved.limits,rules:saved.rules,held};
  return {state,held,people:team,...saved,rows:list.map(r=>({...r,...route(r,context)}))};
}

// Needs you: the approvals routed to this person.
async function inbox(db,workspaceId,actorId){
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return [];
  const {rows}=await desk(db,workspaceId,{state});
  return rows.filter(r=>r.person?.id===actorId).map(r=>item(r));
}
function item(r){
  const amount=format(r);
  return {kind:'approval',importance:'Needs You',priority:83,title:r.title,
    happened:(r.person?.role==='owner'?'':'Sent to you. ')+r.reason,
    why:KINDS[r.kind].label+(amount?' · '+amount:'')+'. Nothing changes until it is approved.',
    recommendation:'Open it, check the details, then approve or decline.',href:r.href,actionLabel:'Review',
    sourceId:'approval-'+r.key,createdAt:r.at,timeLabel:'Waiting since',at:r.at,
    ...(r.amountMinor==null?{}:{moneyValue:r.amountMinor,moneyCurrency:r.currency}),
    approvalRequest:{key:r.key,kind:r.kind,source:r.source,id:r.id}};
}

// The routine keeps a record of where each approval went, and audits changes.
async function run(db,workspaceId){
  if(!await has(db,ASSIGNED))return {skipped:'schema'};
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return {skipped:'plan'};
  const {rows,held,people:team}=await desk(db,workspaceId,{state});
  if(held)return {held};
  const current=new Map((await db.query(`SELECT request_key,user_id,reason FROM ${ASSIGNED} WHERE workspace_id=$1`,[workspaceId])).rows.map(r=>[r.request_key,r]));
  let routed=0;
  for(const r of rows){
    if(!r.person)continue;
    const prior=current.get(r.key);current.delete(r.key);
    if(prior?.user_id===r.person.id&&prior.reason===r.reason)continue;
    const changed=await db.query(`INSERT INTO ${ASSIGNED}(workspace_id,request_key,user_id,reason) VALUES($1,$2,$3,$4)
      ON CONFLICT(workspace_id,request_key) DO UPDATE SET user_id=EXCLUDED.user_id,reason=EXCLUDED.reason,assigned_at=clock_timestamp()
      WHERE ${ASSIGNED}.user_id IS DISTINCT FROM EXCLUDED.user_id OR ${ASSIGNED}.reason IS DISTINCT FROM EXCLUDED.reason RETURNING 1`,[workspaceId,r.key,r.person.id,r.reason]);
    if(!changed.rowCount)continue;
    routed++;
    await audit.record(db,{workspaceId,actorId:null},{action:'Approval sent to '+r.person.name,reference:r.title.slice(0,200),
      before:prior?{person:team.find(p=>p.id===prior.user_id)?.name||'A former member',why:prior.reason}:{},after:{person:r.person.name,why:r.reason,kind:KINDS[r.kind].label,amount:format(r)}});
  }
  if(current.size)await db.query(`DELETE FROM ${ASSIGNED} WHERE workspace_id=$1 AND request_key=ANY($2::text[])`,[workspaceId,[...current.keys()]]);
  return {routed,waiting:rows.length};
}

async function owner(c,ctx){
  const row=(await c.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner' FOR SHARE",[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the inventory owner can choose who approves what.');
}
const tx=(db,work)=>db.transaction(work,{isolation:'SERIALIZABLE',retrySafe:true});
// "Refunds over $500 go to Sarah, not me": one kind, an optional amount, one person.
async function saveRule(db,ctx,input={}){
  return tx(db,async c=>{
    await owner(c,ctx);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['approval-routes:'+ctx.workspaceId]);
    if(input.remove){
      const removed=(await c.query(`UPDATE ${ROUTES} r SET enabled=false FROM users u WHERE r.workspace_id=$1 AND r.id=$2 AND r.enabled
        AND u.workspace_id=r.workspace_id AND u.id=r.user_id RETURNING r.*,u.name`,[ctx.workspaceId,String(input.remove)])).rows[0];
      if(removed)await audit.record(c,ctx,{action:'Approval routing rule removed',reference:removed.id,before:{rule:describeRule(removed)}});
      return {removed:Boolean(removed)};
    }
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    const kind=String(input.kind||'');
    if(!KINDS[kind])throw new ValidationError('Choose which kind of approval this rule sends.');
    const amountText=String(input.amount??'').trim();
    const currency=amountText?money.code(input.currency):null,above=amountText?money.userToMinor(amountText,currency,{label:'Amount'}):null;
    if(above!=null&&!KINDS[kind].money)throw new ValidationError(KINDS[kind].label+' have no amount. Leave the amount empty.');
    const person=(await people(c,ctx.workspaceId)).find(p=>p.id===String(input.userId||''));
    if(!person||person.role==='owner')throw new ValidationError('Choose a current team member other than the owner.');
    if(!canApproveKind(person,kind))throw new ValidationError(person.name+' cannot approve '+KINDS[kind].noun+'. Give them that permission on the Team page first.');
    if(person.warehouse_location_ids!==null)throw new ValidationError(person.name+' only sees some warehouses. Approvals go to people who see the whole inventory.');
    const prior=(await c.query(`SELECT r.*,u.name FROM ${ROUTES} r JOIN users u ON u.id=r.user_id WHERE r.workspace_id=$1 AND r.kind=$2 AND coalesce(r.currency,'')=coalesce($3,'')
      AND coalesce(r.above_minor,-1)=coalesce($4::bigint,-1) AND r.enabled FOR UPDATE OF r`,[ctx.workspaceId,kind,currency,above])).rows[0];
    if(prior?.user_id===person.id)return {id:prior.id,unchanged:true};
    if(!prior)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    else await c.query(`UPDATE ${ROUTES} SET enabled=false WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,prior.id]);
    const id=newId('approvalroute'),rule={kind,currency,above_minor:above};
    await c.query(`INSERT INTO ${ROUTES}(id,workspace_id,kind,currency,above_minor,user_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,ctx.workspaceId,kind,currency,above,person.id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Approval routing rule saved',reference:id,before:prior?{rule:describeRule(prior)}:{},after:{rule:describeRule(rule,person.name)}});
    return {id,rule:describeRule(rule,person.name)};
  });
}
// The permission each kind needs from a person, whatever the record.
const KIND_PERMISSIONS={purchase:[permissions.APPROVE_PO],adjustment:[permissions.ADJUST,permissions.MANAGE_ACCOUNTING],
  refund:[permissions.REFUND_CUSTOMER_RETURN,permissions.MANAGE_ACCOUNTING],landed_cost:[permissions.ALLOCATE_LANDED_COST],
  supplier_price:[permissions.ADMIN],transfer:[permissions.APPROVE_TRANSFER],return:[permissions.AUTHORIZE_CUSTOMER_RETURN,permissions.AUTHORIZE_SUPPLIER_RETURN]};
function canApproveKind(person,kind){return KIND_PERMISSIONS[kind].some(p=>permissions.can(person,p));}

// A person's amount limit for one kind of money approval. Empty removes it.
async function saveLimit(db,ctx,input={}){
  return tx(db,async c=>{
    await owner(c,ctx);
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    const kind=String(input.kind||'');
    if(!LIMIT_KINDS.includes(kind))throw new ValidationError('Choose refunds and credits, stock adjustments and write-offs, or landed costs. Purchase limits are on the Team page.');
    const person=(await people(c,ctx.workspaceId)).find(p=>p.id===String(input.userId||''));
    if(!person||person.role==='owner')throw new ValidationError('Choose a current team member other than the owner. The owner has no limit.');
    const prior=(await c.query(`SELECT currency,limit_minor FROM ${LIMITS} WHERE workspace_id=$1 AND user_id=$2 AND kind=$3 FOR UPDATE`,[ctx.workspaceId,person.id,kind])).rows[0];
    const text=String(input.amount??'').trim(),show=row=>row?money.format(Number(row.limit_minor),row.currency):'No amount limit';
    if(!text){
      if(prior){await c.query(`DELETE FROM ${LIMITS} WHERE workspace_id=$1 AND user_id=$2 AND kind=$3`,[ctx.workspaceId,person.id,kind]);
        await audit.record(c,ctx,{action:'Approval limit removed',reference:person.name+' · '+KINDS[kind].label,before:{limit:show(prior)},after:{limit:show(null)}});}
      return {removed:Boolean(prior)};
    }
    const currency=money.code(input.currency),amount=money.userToMinor(text,currency,{label:'Limit'});
    if(prior&&prior.currency===currency&&Number(prior.limit_minor)===amount)return {unchanged:true};
    await c.query(`INSERT INTO ${LIMITS}(workspace_id,user_id,kind,currency,limit_minor,changed_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(workspace_id,user_id,kind) DO UPDATE SET currency=EXCLUDED.currency,limit_minor=EXCLUDED.limit_minor,changed_by=EXCLUDED.changed_by,changed_at=clock_timestamp()`,
    [ctx.workspaceId,person.id,kind,currency,amount,ctx.actorId]);
    await audit.record(c,ctx,{action:'Approval limit changed',reference:person.name+' · '+KINDS[kind].label,before:{limit:show(prior)},after:{limit:money.format(amount,currency)}});
    return {saved:true};
  });
}
// Enforced on every plan: a downgrade never removes a limit the owner set.
async function assertLimit(c,ctx,request){
  if(!KINDS[request.kind]?.money||request.kind==='purchase'||!await has(c,LIMITS))return;
  const actor=(await c.query('SELECT id,role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!actor||actor.role==='owner')return;
  const limit=(await c.query(`SELECT currency,limit_minor FROM ${LIMITS} WHERE workspace_id=$1 AND user_id=$2 AND kind=$3 FOR SHARE`,[ctx.workspaceId,actor.id,request.kind])).rows[0];
  if(!limit)return;
  if(request.amountMinor==null)throw new AuthorizationError('StockChief could not work out the amount of this approval. Ask the owner to approve it.');
  if(request.currency!==limit.currency)throw new AuthorizationError('This is in '+request.currency+', not the '+limit.currency+' of your approval limit. Ask the owner or someone with a limit in '+request.currency+'.');
  if(request.amountMinor>Number(limit.limit_minor))throw new AuthorizationError('This is '+money.format(request.amountMinor,request.currency)+', above your '+money.format(Number(limit.limit_minor),limit.currency)+' approval limit. Ask the owner or someone with a higher limit.');
}
// One prepared change as an approval request, read inside the approving transaction.
async function proposalRequest(c,workspaceId,proposal){
  const spec=ACTIONS[proposal.action_type];
  if(!spec)return null;
  const contract=require('../assistant/postgres-capability-registry').registry.get(proposal.action_type);
  const payload=proposal.payload||{};let amount={amountMinor:null,currency:null};
  if(spec.amount)amount=spec.amount(payload);
  else if(proposal.action_type==='inventory.adjust'){
    const v=(await c.query(`SELECT coalesce((SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3),0)::text AS physical,
      coalesce(sum(quantity_units),0)::text AS costed,coalesce(sum(total_cost_minor),0)::text AS value,
      (SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1) AS currency
      FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,[workspaceId,payload.skuId,payload.locationId])).rows[0];
    const costed=Number(v.costed),change=Math.abs(Number(payload.countedQuantity)-Number(v.physical));
    amount=costed>0&&Number.isFinite(change)?amountOf(Math.round(change*Number(v.value)/costed),v.currency):amountOf(null,v.currency);
  }
  return {key:'proposal:'+proposal.id,source:'proposal',id:proposal.id,kind:spec.kind,actionType:proposal.action_type,permission:contract?.permission,
    readPermission:readPermission(contract?.permission),ownerOnly:Boolean(contract?.ownerOnly),...amount};
}

// The owner's routing page.
async function screen(db,ctx){
  await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'automatic');
  const d=await desk(db,ctx.workspaceId);
  const team=d.people.filter(p=>p.role!=='owner');
  return {path,held:d.held,kinds:Object.entries(KINDS).map(([key,k])=>({key,label:k.label,money:k.money})),limitKinds:LIMIT_KINDS.map(key=>({key,label:KINDS[key].label})),
    people:team.map(p=>{const kinds=Object.keys(KINDS).filter(k=>canApproveKind(p,k)),whole=p.warehouse_location_ids===null;
      const limits=['purchase',...LIMIT_KINDS].filter(k=>kinds.includes(k)).map(k=>{const l=authority(p,k,d.limits);return KINDS[k].label+' '+(l?'up to '+money.format(l.amountMinor,l.currency):'any amount');});
      return {id:p.id,name:p.name,routable:whole&&kinds.length>0,
        approves:!kinds.length?'Nothing yet':!whole?'Nothing: sees only some warehouses':kinds.map(k=>KINDS[k].label).join(', '),
        limits:whole&&limits.length?limits.join(' · '):''};}),
    rules:d.rules.map(r=>({id:r.id,text:describeRule(r)})),
    rows:d.rows.map(r=>({title:r.title,href:r.href,kind:KINDS[r.kind].label,amount:format(r)||'',person:r.person?.name||'Nobody yet',reason:r.reason}))};
}
// Agent reviews: the same list as rows.
async function review(db,ctx){
  const d=await desk(db,ctx.workspaceId);
  return {summary:'Each waiting approval goes to one person who can approve it: your routing rules first, then the team member with the lowest approval limit that covers it, then you. Set rules and limits on the approval routing page.',
    rows:d.rows.map(r=>({Approval:r.title,Kind:KINDS[r.kind].label,Amount:format(r)||'',Reviewer:r.person?.name||'Nobody yet',Reason:r.reason,link:r.href}))};
}
module.exports={KINDS,ACTIONS,LIMIT_KINDS,path,requests,people,settings,eligible,covers,route,desk,inbox,item,run,saveRule,saveLimit,assertLimit,proposalRequest,screen,review,describeRule,canApproveKind,holdReason};
