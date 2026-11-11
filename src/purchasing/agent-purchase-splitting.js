'use strict';

const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const queue=require('../operations/postgres-job-queue');
const regroup=require('./agent-regroup-orders');

const table='stockchief_runtime.agent_purchase_split_rules';
const action='purchase_order.split_draft';
const kind='agent.split-purchase.v1';
const strategies=new Set(['warehouse','delivery-date','budget']);
const scoped=db=>({query:db.query.bind(db),transaction:work=>work(db)});

async function owner(db,ctx,lock=false){
  const member=await db.query(`SELECT 1 FROM workspaces w JOIN users u
    ON u.workspace_id=w.id AND u.account_id=w.owner_account_id AND u.role='owner'
    WHERE w.id=$1 AND u.id=$2 AND w.deletion_requested_at IS NULL AND NOT EXISTS(
      SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)`+
    (lock?' FOR SHARE OF w,u':''),[ctx.workspaceId,ctx.actorId]);
  if(!member.rowCount)throw new AuthorizationError('Only the current inventory owner can authorize draft purchase splits.');
}

async function evidence(db,ctx,id,supplier,currency,strategy){
  if(!id)return null;
  const {rows:[row]}=await db.query(`SELECT p.payload#>>'{training,amountMinor}' AS amount,
    p.payload#>>'{args,budgetAmount}' AS budget,
    (SELECT array_agg(DISTINCT l.destination_location_id) FROM purchase_order_lines l WHERE l.workspace_id=p.workspace_id
      AND l.purchase_order_id=o.id) AS sites
    FROM stockchief_runtime.assistant_action_proposals p JOIN purchase_orders o
      ON o.workspace_id=p.workspace_id AND o.id=p.result->'originals'->>0 AND o.status='CANCELLED'
    WHERE p.workspace_id=$1 AND p.id=$2 AND p.actor_user_id=$3 AND p.action_type=$4 AND p.status='EXECUTED'
      AND p.result->>'automatic' IS DISTINCT FROM 'true' AND p.result#>>'{executionAuthority,kind}' IS DISTINCT FROM 'standing_job_rule'
      AND o.supplier_id=$5 AND o.currency=$6 AND p.payload#>>'{args,splitStrategy}'=$7
      AND jsonb_array_length(p.result->'drafts')>=2`,[ctx.workspaceId,id,ctx.actorId,action,supplier,currency,strategy]);
  return row||null;
}

async function matchesExample(db,ctx,rule){
  const proof=await evidence(db,ctx,rule.training_proposal,rule.supplier_id,rule.currency,rule.strategy);
  return Boolean(proof&&money.integer(proof.amount)>=Number(rule.maximum_source_minor)&&
    rule.location_ids.every(id=>proof.sites?.includes(id))&&
    (rule.strategy!=='budget'||proof.budget&&money.userToMinor(proof.budget,rule.currency)===Number(rule.budget_minor)));
}

async function configure(database,ctx,input){
  return database.transaction(async db=>{
    await owner(db,ctx,true);
    if(input.remove==='yes'){
      const deleted=await db.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND id=$2 AND revision=$3`,
        [ctx.workspaceId,input.id,Number(input.revision)]);
      if(!deleted.rowCount)throw new ValidationError('Open the current split rule before removing it.');
      return;
    }
    const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,25,'automatic',{trained:true});
    if(input.confirmed!=='yes'||!strategies.has(input.strategy))throw new ValidationError('Confirm the exact split method, supplier and receiving sites.');
    const sites=[...new Set([].concat(input.locationIds||[]).filter(Boolean))];
    if(!sites.length)throw new ValidationError('Choose the receiving locations covered by this rule.');
    const vendor=await db.query("SELECT currency FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active' FOR SHARE",
      [ctx.workspaceId,input.supplierId]);
    const locations=await db.query(`SELECT id FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[]) AND is_active=1 AND custody_agreement_id IS NULL`,
      [ctx.workspaceId,sites]);
    if(!vendor.rowCount||locations.rowCount!==sites.length)throw new ValidationError('Choose an active supplier and receiving locations from this inventory.');
    const currency=vendor.rows[0].currency,maximum=money.userToMinor(input.maximum,currency);
    const budget=input.strategy==='budget'?money.userToMinor(input.budget,currency):null;
    if(maximum<=0||budget!==null&&(budget<=0||budget>=maximum))throw new ValidationError('Set a positive original goods limit and a smaller budget per replacement when splitting by value.');
    const rule={supplier_id:input.supplierId,currency,strategy:input.strategy,location_ids:sites,
      maximum_source_minor:maximum,budget_minor:budget,training_proposal:input.trainingProposal||null};
    if(state.plan==='pro'&&!await matchesExample(db,ctx,rule))
      throw new ValidationError('Pro needs a completed individually approved split with this supplier, method and sites within the same limits.');
    const prior=(await db.query(`SELECT id,revision FROM ${table} WHERE workspace_id=$1 AND supplier_id=$2 AND currency=$3
      AND strategy=$4 FOR UPDATE`,[ctx.workspaceId,rule.supplier_id,currency,rule.strategy])).rows[0];
    if((prior?.revision||0)!==Number(input.revision||0))throw new ValidationError('Open the current split rule before changing it.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(db,ctx,[],prior?0:1);
    await db.query(`INSERT INTO ${table} AS previous(id,workspace_id,supplier_id,owner_id,currency,strategy,location_ids,maximum_source_minor,budget_minor,training_proposal)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,supplier_id,currency,strategy) DO UPDATE
      SET owner_id=excluded.owner_id,location_ids=excluded.location_ids,maximum_source_minor=excluded.maximum_source_minor,
        budget_minor=excluded.budget_minor,training_proposal=excluded.training_proposal,revision=previous.revision+1,updated_at=now()`,
    [prior?.id||newId('posplit'),ctx.workspaceId,rule.supplier_id,ctx.actorId,currency,rule.strategy,sites,maximum,budget,rule.training_proposal]);
    await require('../operations/postgres-security-audit').record(db,ctx,{action:'Saved draft purchase splitting rule',reference:rule.supplier_id,after:rule});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function saveDates(database,ctx,{orderNumber,lineDates}){
  return database.transaction(async db=>{
    await owner(db,ctx,true);
    await policy.requireWorkspaceJob(db,ctx.workspaceId,25,'draft');
    const {rows:[order]}=await db.query("SELECT id FROM purchase_orders WHERE workspace_id=$1 AND po_number=$2 AND status='DRAFT' FOR UPDATE",
      [ctx.workspaceId,orderNumber]);
    if(!order)throw new ValidationError('Choose an unsent draft purchase order in this inventory.');
    const {rows:lines}=await db.query(`SELECT id,line_number FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2
      ORDER BY line_number FOR UPDATE`,[ctx.workspaceId,order.id]);
    const dates=regroup.dates(lineDates,lines);
    const today=await require('../lib/business-time').today(db,ctx.workspaceId);
    if([...dates.values()].some(date=>date<today))throw new ValidationError('Use delivery dates from today onward.');
    for(const line of lines)await db.query('UPDATE purchase_order_lines SET requested_delivery_date=$3 WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,line.id,dates.get(Number(line.line_number))]);
    await db.query('UPDATE purchase_orders SET updated_at=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,order.id,nowIso()]);
    await require('../operations/postgres-security-audit').record(db,ctx,{action:'Saved draft purchase line delivery dates',reference:orderNumber,after:Object.fromEntries(dates)});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function screen(db,ctx){
  const [rules,suppliers,locations,examples]=await Promise.all([
    db.query(`SELECT r.*,s.name supplier FROM ${table} r JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id
      WHERE r.workspace_id=$1 ORDER BY s.name,r.strategy,r.id`,[ctx.workspaceId]),
    db.query("SELECT id,name,currency FROM suppliers WHERE workspace_id=$1 AND status='active' ORDER BY name,id",[ctx.workspaceId]),
    require('../operations/postgres-warehouse-access').locations(db,ctx.workspaceId,null),
    db.query(`SELECT p.id,o.po_number,p.payload#>>'{args,splitStrategy}' AS strategy FROM stockchief_runtime.assistant_action_proposals p
      JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.result->'originals'->>0
      WHERE p.workspace_id=$1 AND p.actor_user_id=$2 AND p.action_type=$3 AND p.status='EXECUTED'
      AND p.result->>'automatic' IS DISTINCT FROM 'true' ORDER BY p.executed_at DESC,p.id LIMIT 25`,[ctx.workspaceId,ctx.actorId,action]),
  ]);
  return {rules:rules.rows,suppliers:suppliers.rows,locations,examples:examples.rows};
}

async function enqueue(db,workspaceId,cycleId){
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||state.shadow||!policy.permits(state.plan,25,'automatic',{trained:true}))return {skipped:true};
  if(!(await db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 LIMIT 1`,[workspaceId])).rowCount)return {skipped:true};
  return queue.enqueue(db,{workspaceId,kind,idempotencyKey:'purchase-split:'+cycleId,payload:{cycleId},priority:64,maxAttempts:3});
}

async function worker(db,workspaceId,{cycleId,after=''}){
  await db.query(`SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id
    WHERE w.id=$1 FOR SHARE OF s`,[workspaceId]);
  await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[workspaceId]);
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,25,'automatic',{trained:true})||
    await policy.stopped(db,workspaceId,state,action,true)||!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate||
    await require('../autopilot/job-modes').restriction(db,workspaceId,25,true)||
    await require('../commercial/agent-rule-quota').restriction(db,state))return {split:0,held:true};
  const {rows}=await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id>$2 ORDER BY id LIMIT 11 FOR UPDATE`,[workspaceId,after]);
  const today=rows.some(rule=>rule.strategy==='delivery-date')?await require('../lib/business-time').today(db,workspaceId):null;
  let split=0;
  for(const rule of rows.slice(0,10)){
    const ctx={workspaceId,actorId:rule.owner_id};
    try{await owner(db,ctx,true);}catch(error){if(error instanceof AuthorizationError)continue;throw error;}
    if(state.plan==='pro'&&!await matchesExample(db,ctx,rule))continue;
    const {rows:orders}=await db.query(`SELECT p.po_number FROM purchase_orders p
      JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
      WHERE p.workspace_id=$1 AND p.supplier_id=$2 AND p.currency=$3 AND p.status='DRAFT'
      AND NOT EXISTS(SELECT 1 FROM purchase_order_charges c WHERE c.workspace_id=p.workspace_id AND c.purchase_order_id=p.id)
      GROUP BY p.id,p.po_number HAVING bool_and(l.destination_location_id=ANY($4::text[])) AND sum(l.line_total)<=$7::numeric
      AND CASE $5 WHEN 'warehouse' THEN count(DISTINCT l.destination_location_id)>1
      WHEN 'delivery-date' THEN count(DISTINCT l.requested_delivery_date)>1 AND count(l.requested_delivery_date)=count(*)
        AND min(l.requested_delivery_date)>=$8::date
      ELSE sum(l.line_total)>$6::numeric END
      ORDER BY p.id LIMIT 20`,[workspaceId,rule.supplier_id,rule.currency,rule.location_ids,rule.strategy,
      rule.budget_minor==null?null:money.fromMinor(rule.budget_minor,rule.currency),money.fromMinor(rule.maximum_source_minor,rule.currency),today]);
    for(const order of orders){
      await db.query('SAVEPOINT purchase_split');
      try{
        const current=await regroup.build(db,ctx,{sourceOrders:order.po_number,splitStrategy:rule.strategy,
          ...(rule.budget_minor==null?{}:{budgetAmount:money.fromMinor(rule.budget_minor,rule.currency)})},25,true,{useSavedDates:true});
        if(current.total<=Number(rule.maximum_source_minor)&&current.output.every(po=>po.supplierId===rule.supplier_id&&
          (rule.strategy!=='delivery-date'||po.expectedDate>=today)&&
          po.currency===rule.currency&&po.lines.every(line=>rule.location_ids.includes(line.destinationLocationId)))){
          await regroup.apply(db,ctx,current,'purchase-split:'+hash([rule.id,current.ids]),{automatic:true});
          split++;
        }
      }catch(error){
        if(!(error instanceof ValidationError||error instanceof AuthorizationError))throw error;
        await db.query('ROLLBACK TO SAVEPOINT purchase_split');
      }
      await db.query('RELEASE SAVEPOINT purchase_split');
    }
  }
  if(rows.length>10)await queue.enqueue(scoped(db),{workspaceId,kind,idempotencyKey:'purchase-split:'+cycleId+':'+rows[9].id,
    payload:{cycleId,after:rows[9].id},priority:64,maxAttempts:3});
  return {split};
}

module.exports={kind,configure,saveDates,screen,enqueue,worker};
