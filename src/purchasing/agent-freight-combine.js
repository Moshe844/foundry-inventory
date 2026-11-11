'use strict';

const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const jobs=require('../operations/postgres-job-queue');
const regroup=require('./agent-regroup-orders');

const kind='agent.combine-freight.v1';
const action='purchase_order.combine_drafts';
const table='stockchief_runtime.agent_freight_combine_rules';
const context=client=>({query:client.query.bind(client),transaction:work=>work(client)});

async function owner(db,ctx,lock=false){
  const {rows:[user]}=await db.query(`SELECT u.id FROM workspaces w
    JOIN users u ON u.workspace_id=w.id AND u.account_id=w.owner_account_id AND u.role='owner'
    WHERE w.id=$1 AND u.id=$2 AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)`+
    (lock?' FOR SHARE OF w,u':''),[ctx.workspaceId,ctx.actorId]);
  if(!user)throw new AuthorizationError('Only the current inventory owner can authorize combining draft purchases.');
}

async function example(db,ctx,id,supplier,location,currency){
  if(!id)return null;
  const {rows:[row]}=await db.query(`SELECT p.payload#>>'{training,amountMinor}' AS maximum,p.result->'freight' AS freight
    FROM stockchief_runtime.assistant_action_proposals p
    JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.result->'drafts'->>0
    WHERE p.workspace_id=$1 AND p.id=$2 AND p.actor_user_id=$3 AND p.action_type=$4
      AND p.status='EXECUTED' AND p.result->>'automatic'='false'
      AND p.result#>>'{executionAuthority,kind}' IS DISTINCT FROM 'standing_job_rule'
      AND o.supplier_id=$5 AND o.destination_location_id=$6 AND o.currency=$7
      AND p.result#>>'{freight,site}'=$6 AND (p.result#>>'{freight,savedMinor}')::bigint>0`,
  [ctx.workspaceId,id,ctx.actorId,action,supplier,location,currency]);
  return row||null;
}

async function configure(database,ctx,input){
  return database.transaction(async db=>{
    await owner(db,ctx,true);
    if(input.remove==='yes'){
      const deleted=await db.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND id=$2 AND revision=$3`,
        [ctx.workspaceId,input.id,Number(input.revision)]);
      if(!deleted.rowCount)throw new ValidationError('Open the current rule before removing it.');
      return;
    }
    const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,24,'automatic',{trained:true});
    const {rows:[supplier]}=await db.query(`SELECT id,currency FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'
      AND freight_terms_currency=currency AND ordinary_freight_minor IS NOT NULL FOR SHARE`,[ctx.workspaceId,input.supplierId]);
    const location=await db.query(`SELECT 1 FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL`,
      [ctx.workspaceId,input.locationId]);
    if(!supplier||!location.rowCount)throw new ValidationError('Choose an active receiving location and a supplier with recorded freight in its currency.');
    const maximum=money.userToMinor(input.maximum,supplier.currency);
    if(maximum<=0)throw new ValidationError('Set a positive maximum goods value for the combined draft.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm this exact supplier, receiving location and combined-order limit.');
    let proof=null;
    if(input.trainingProposal)proof=await example(db,ctx,input.trainingProposal,supplier.id,input.locationId,supplier.currency);
    if(state.plan==='growth'&&(!proof||money.integer(proof.maximum)<maximum))
      throw new ValidationError('Growth needs an individually approved freight-saving example for this supplier and location within the saved limit.');
    const prior=(await db.query(`SELECT id,revision FROM ${table} WHERE workspace_id=$1 AND supplier_id=$2 AND location_id=$3
      AND currency=$4 FOR UPDATE`,[ctx.workspaceId,supplier.id,input.locationId,supplier.currency])).rows[0];
    if((prior?.revision||0)!==Number(input.revision||0))throw new ValidationError('Open the current rule before changing it.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(db,ctx,[],prior?0:1);
    await db.query(`INSERT INTO ${table} AS existing(id,workspace_id,supplier_id,location_id,owner_id,currency,maximum_minor,training_proposal)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,supplier_id,location_id,currency) DO UPDATE
      SET owner_id=excluded.owner_id,maximum_minor=excluded.maximum_minor,training_proposal=excluded.training_proposal,
        revision=existing.revision+1,updated_at=now()`,
    [prior?.id||newId('freightrule'),ctx.workspaceId,supplier.id,input.locationId,ctx.actorId,supplier.currency,maximum,
      proof?input.trainingProposal:null]);
    await require('../operations/postgres-security-audit').record(db,ctx,{action:'Saved freight-combining rule',reference:supplier.id,
      after:{locationId:input.locationId,currency:supplier.currency,maximumMinor:maximum,trainingProposal:proof?input.trainingProposal:null}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function screen(db,ctx){
  const [rules,suppliers,locations,examples]=await Promise.all([
    db.query(`SELECT r.*,s.name supplier,l.name location FROM ${table} r JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id
      JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id WHERE r.workspace_id=$1 ORDER BY s.name,l.name,r.id`,[ctx.workspaceId]),
    db.query(`SELECT id,name,currency FROM suppliers WHERE workspace_id=$1 AND status='active'
      AND freight_terms_currency=currency AND ordinary_freight_minor IS NOT NULL ORDER BY name,id`,[ctx.workspaceId]),
    require('../operations/postgres-warehouse-access').locations(db,ctx.workspaceId,null),
    db.query(`SELECT p.id,o.po_number,p.payload#>>'{training,currency}' currency,p.payload#>>'{training,amountMinor}' maximum
      FROM stockchief_runtime.assistant_action_proposals p JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.result->'drafts'->>0
      WHERE p.workspace_id=$1 AND p.actor_user_id=$2 AND p.action_type=$3 AND p.status='EXECUTED'
      AND p.result->>'automatic'='false' AND (p.result#>>'{freight,savedMinor}')::bigint>0 ORDER BY p.executed_at DESC,p.id LIMIT 25`,
    [ctx.workspaceId,ctx.actorId,action]),
  ]);
  return {rules:rules.rows,suppliers:suppliers.rows,locations,examples:examples.rows};
}

async function selectDrafts(db,workspace,rule,today){
  const {rows}=await db.query(`WITH drafts AS (
    SELECT p.id,p.po_number,p.expected_date,sum(l.line_total)::text goods,count(*) lines
    FROM purchase_orders p JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
    WHERE p.workspace_id=$1 AND p.supplier_id=$2 AND p.status='DRAFT' AND p.currency=$3
      AND p.destination_location_id=$4 AND p.expected_date>=$5
      AND NOT EXISTS(SELECT 1 FROM purchase_order_charges c WHERE c.workspace_id=p.workspace_id
        AND c.purchase_order_id=p.id AND c.kind IN ('tax','deposit'))
    GROUP BY p.id,p.po_number,p.expected_date
    HAVING bool_and(l.destination_location_id=$4 AND l.unit_cost IS NOT NULL AND l.line_total IS NOT NULL)
      AND count(*)<=500
  ) SELECT * FROM drafts WHERE expected_date IN (SELECT expected_date FROM drafts GROUP BY expected_date HAVING count(*)>1)
  ORDER BY expected_date,goods::numeric,id LIMIT 101`,[workspace,rule.supplier_id,rule.currency,rule.location_id,today]);
  const dates=new Map();
  for(const row of rows){
    const amount=money.toMinor(row.goods,rule.currency);
    if(amount<=0||amount>Number(rule.maximum_minor))continue;
    const group=dates.get(row.expected_date)||{amount:0,lines:0,refs:[]};
    if(group.amount+amount>Number(rule.maximum_minor)||group.lines+Number(row.lines)>500||group.refs.length===20)continue;
    group.amount+=amount;group.lines+=Number(row.lines);group.refs.push(row.po_number);
    dates.set(row.expected_date,group);
  }
  return [...dates.values()].filter(group=>group.refs.length>=2);
}

async function enqueue(db,workspaceId,cycleId){
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||state.shadow||!policy.permits(state.plan,24,'automatic',{trained:true}))return {skipped:true};
  if(!(await db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 LIMIT 1`,[workspaceId])).rowCount)return {skipped:true};
  return jobs.enqueue(db,{workspaceId,kind,idempotencyKey:'freight-combine:'+cycleId,payload:{cycleId},priority:64,maxAttempts:3});
}

async function worker(db,workspaceId,{cycleId,after=''}){
  await db.query(`SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id
    WHERE w.id=$1 FOR SHARE OF s`,[workspaceId]);
  await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[workspaceId]);
  const state=await policy.requireWorkspaceJob(db,workspaceId,24,'automatic',{trained:true}).catch(error=>{
    if(error.code==='entitlement_required')return null;
    throw error;
  });
  if(!state||await policy.stopped(db,workspaceId,state,action,true)||
      !(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate||
      await require('../autopilot/job-modes').restriction(db,workspaceId,24,true)||
      await require('../commercial/agent-rule-quota').restriction(db,state))return {combined:0,held:true};
  const {rows}=await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id>$2 ORDER BY id LIMIT 11 FOR UPDATE`,
    [workspaceId,after]);
  const today=await require('../lib/business-time').today(db,workspaceId);
  let combined=0;
  for(const rule of rows.slice(0,10)){
    const ctx={workspaceId,actorId:rule.owner_id};
    try{
      await owner(db,ctx,true);
      if(state.plan==='growth'){
        const proof=await example(db,ctx,rule.training_proposal,rule.supplier_id,rule.location_id,rule.currency);
        if(!proof||money.integer(proof.maximum)<Number(rule.maximum_minor))throw new ValidationError('This freight scope needs a completed current Growth example.');
      }
    }catch(error){
      if(!(error instanceof ValidationError||error instanceof AuthorizationError))throw error;
      continue;
    }
    const groups=await selectDrafts(db,workspaceId,rule,today);
    for(const group of groups){
      await db.query('SAVEPOINT freight_group');
      try{
        const current=await regroup.build(db,ctx,{sourceOrders:group.refs.join(',')},24,true);
        const output=current.output[0];
        if(current.shipping?.site===rule.location_id&&output.supplierId===rule.supplier_id&&output.currency===rule.currency&&
          current.shipping.saving>0&&current.total<=Number(rule.maximum_minor)){
          await regroup.apply(db,ctx,current,'freight-group:'+hash([rule.id,current.ids]),{automatic:true});
          combined++;
        }
      }catch(error){
        if(!(error instanceof ValidationError||error instanceof AuthorizationError))throw error;
        await db.query('ROLLBACK TO SAVEPOINT freight_group');
      }
      await db.query('RELEASE SAVEPOINT freight_group');
    }
  }
  if(rows.length>10)await jobs.enqueue(context(db),{workspaceId,kind,idempotencyKey:'freight-combine:'+cycleId+':'+rows[9].id,
    payload:{cycleId,after:rows[9].id},priority:64,maxAttempts:3});
  return {combined};
}

module.exports={kind,configure,screen,enqueue,worker};
