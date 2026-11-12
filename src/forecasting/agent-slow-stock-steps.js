'use strict';

// Job 9: finds dead and slow stock and suggests a discount, a return or a move.
//
// Each finding becomes a concrete next step through StockChief's own records:
//  - Move: a Requested transfer to another location where the item sells and
//    has room under its target. The transfer holds the stock; approving,
//    picking, dispatch and receipt stay with people.
//  - Return: a Requested supplier return to the supplier whose posted receipt
//    brought the stock in. Nothing leaves and no credit is assumed; the
//    supplier's agreement and credit are recorded by a person.
//  - Discount: a job 86 clearance plan. Changing a selling price or accepting
//    a supplier's terms always needs a person (plan spec, page 13), so even
//    on its own StockChief only prepares the plan; a person approves the price.
//
// Starter only suggests. Growth prepares each step as a draft for a person.
// Pro drafts until the owner approved a step of that kind themselves and saved
// a limit; Custom needs no teaching. On their own, steps stay inside the owner's
// limit (units per move, recorded cost per return) and the days without a sale
// the owner chose, and respect shadow, pause, watch mode, Watch only and Ask me
// first. Every step is audited, replay safe and can be undone while untouched.

const {ValidationError,AuthorizationError,NotFoundError,DomainError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');
const {hash}=require('../pricing/postgres-promotions');
const excess=require('./agent-excess-stock');

const JOB=9,ACTION='inventory.slow_stock_step',kind='agent.slow-stock.v1',path='/autopilot/slow-stock';
const KINDS=['MOVE','RETURN','DISCOUNT'];
const rules='stockchief_runtime.agent_slow_stock_rules',steps='stockchief_runtime.agent_slow_stock_steps';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const expected=error=>error instanceof DomainError&&[400,402,403,404,409].includes(error.status);
const percent=points=>(Number(points)/100).toLocaleString('en-US',{maximumFractionDigits:2})+'%';
const qty=value=>exact.canonical(String(value));

async function owner(db,ctx,{lock=false}={}){
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  const allowed=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!allowed)throw new AuthorizationError('Only the current inventory owner can act on slow stock.');
}

async function access(db,ctx,{lock=false,stop=false}={}){
  await owner(db,ctx,{lock});
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  if(stop){
    if(lock)await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
    const reason=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
    if(reason)throw new ValidationError(reason);
  }
  return state;
}

// The supplier whose latest posted receipt brought this item into this location.
async function returnSource(db,workspaceId,skuId,locationId){
  return (await db.query(`SELECT po.supplier_id,v.name AS supplier,po.id AS purchase_order_id,po.po_number,b.id AS bill_id
    FROM purchase_order_receipt_lines l JOIN purchase_order_receipts r ON r.workspace_id=l.workspace_id AND r.id=l.receipt_id
    JOIN purchase_orders po ON po.workspace_id=r.workspace_id AND po.id=r.purchase_order_id AND po.delivery_kind<>'CUSTOMER_DIRECT'
    JOIN suppliers v ON v.workspace_id=po.workspace_id AND v.id=po.supplier_id AND v.status='active'
    LEFT JOIN LATERAL(SELECT id FROM accounting_supplier_bills b WHERE b.workspace_id=po.workspace_id AND b.purchase_order_id=po.id
      AND b.supplier_id=po.supplier_id AND b.status IN ('OPEN','PARTIALLY_PAID') ORDER BY b.created_at DESC,b.id LIMIT 1) b ON true
    WHERE l.workspace_id=$1 AND l.sku_id=$2 AND l.location_id=$3 ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
  [workspaceId,skuId,locationId])).rows[0]||null;
}

// The exact steps one finding allows now, each with the facts it rests on.
async function options(db,ctx,row){
  const p=row.position,h=row.h,out=[];
  const base={skuId:p.sku_id,locationId:p.location_id,itemId:p.item_id,code:p.code,location:p.location_name,unit:p.unit_label,
    finding:row.kind.label,since:row.since,daysWithStock:h.held_days,daysSinceSale:h.days_since_sale};
  const facts={onHand:qty(p.onHand),available:qty(p.available),clearable:qty(row.clearable),sold:h.sold?new Date(h.sold).toISOString():null,
    stocked:h.stocked?new Date(h.stocked).toISOString():null};
  const exactUnits=p.tracking_mode==='quantity'&&!h.secondary_unit_label;
  const add=(type,quantity,details,hold=null)=>out.push({kind:type,quantity:qty(quantity),details:{...base,...details},hold,
    fingerprint:hash([type,qty(quantity),base.skuId,base.locationId,details,facts])});
  if(row.move){
    const d=row.move.destination;
    add('MOVE',row.move.quantity,{destinationId:d.location_id,destination:d.location_name,destinationSold90:qty(d.issued??0)},
      row.move.exact?null:'Choose the exact batches, serials or weights to move yourself.');
  }
  // An open clearance plan already covers the item's remaining units.
  const planned=row.rest>0&&(await db.query(`SELECT 1 FROM stockchief_runtime.agent_clearance_plans WHERE workspace_id=$1 AND sku_id=$2
    AND status IN ('DRAFT','ACTIVE')`,[ctx.workspaceId,p.sku_id])).rowCount>0;
  if(row.rest>0&&!planned){
    const supplier=await returnSource(db,ctx.workspaceId,p.sku_id,p.location_id);
    if(supplier){
      const cost=(await db.query(`SELECT c.quantity_units::text AS quantity,c.total_cost_minor::text AS total,a.base_currency
        FROM accounting_inventory_cost_balances c JOIN accounting_settings a ON a.workspace_id=c.workspace_id AND a.enabled=1
        WHERE c.workspace_id=$1 AND c.sku_id=$2 AND c.location_id=$3`,[ctx.workspaceId,p.sku_id,p.location_id])).rows[0];
      const costed=cost&&Number(cost.quantity)===Number(p.onHand)&&Number(cost.quantity)>0;
      add('RETURN',row.rest,{supplierId:supplier.supplier_id,supplier:supplier.supplier,billId:supplier.bill_id,purchaseOrder:supplier.po_number,
        purchaseOrderId:supplier.purchase_order_id,currency:costed?cost.base_currency:null,
        valueMinor:costed?exact.ratioMinor(money.integer(cost.total,'Recorded stock cost'),qty(row.rest),cost.quantity):null},
      exactUnits?null:'Choose the exact batches, serials or weights to send back yourself.');
    }
    if(h.amount_minor!=null&&!h.secondary_unit_label)add('DISCOUNT',row.rest,{price:Number(h.amount_minor),currency:h.currency});
  }
  return out;
}

const describe={
  MOVE:s=>'Move '+s.quantity+' to '+s.details.destination+', where it sells.',
  RETURN:s=>'Send '+s.quantity+' back to '+s.details.supplier+(s.details.purchaseOrder?' (bought on '+s.details.purchaseOrder+')':'')+'.',
  DISCOUNT:s=>'Discount '+s.quantity+' with a clearance plan.'
};

// The review's one-line next step for each finding.
async function nextStep(db,ctx,row){
  if(!(row.clearable>0))return 'Keep stock for existing commitments or the saved target.';
  const found=await options(db,ctx,row);
  if(!found.length)return 'Set a selling price, or check the supplier, before choosing a step.';
  const move=found.find(o=>o.kind==='MOVE'),clear=found.filter(o=>o.kind!=='MOVE');
  return [move?describe.MOVE(move):null,clear.length?clear.map(o=>describe[o.kind](o).replace(/\.$/,'')).join(', or ')+'.':null].filter(Boolean).join(' ');
}

async function loadRule(db,workspaceId,type,{lock=false}={}){
  return (await db.query(`SELECT r.*,r.maximum_quantity::text AS maximum_quantity,
      EXISTS(SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
        WHERE u.id=r.authorized_by AND w.id=r.workspace_id AND u.role='owner') AS current
    FROM ${rules} r WHERE r.workspace_id=$1 AND r.kind=$2${lock?' FOR SHARE OF r':''}`,[workspaceId,type])).rows[0]||null;
}

// A completed manual example: a step of this kind the owner approved
// themselves whose transfer, return or plan was not cancelled or undone.
async function example(db,ctx,type,actorId=ctx.actorId){
  return (await db.query(`SELECT s.id FROM ${steps} s
    LEFT JOIN inventory_transfers t ON t.workspace_id=s.workspace_id AND t.id=s.transfer_id
    LEFT JOIN supplier_returns r ON r.workspace_id=s.workspace_id AND r.id=s.supplier_return_id
    LEFT JOIN stockchief_runtime.agent_clearance_plans p ON p.workspace_id=s.workspace_id AND p.id=s.clearance_plan_id
    WHERE s.workspace_id=$1 AND s.kind=$2 AND s.status='DONE' AND NOT s.automatic AND s.decided_by=$3
      AND coalesce(t.status,r.status,p.status) IS NOT NULL AND coalesce(t.status,r.status,p.status)<>'CANCELLED'
    ORDER BY s.decided_at DESC,s.id LIMIT 1`,[ctx.workspaceId,type,actorId])).rows[0]||null;
}

// Whether this step may happen without a person right now, and if not, why.
async function authority(c,gate,option){
  const rule=await loadRule(c,gate.workspaceId,option.kind,{lock:true});
  const trainedPlan=policy.permits(gate.account.plan,JOB,'automatic',{trained:true});
  if(!trainedPlan)return {reason:'A person approves each step on this plan.'};
  if(!rule||!rule.enabled)return {reason:'Save a limit for this kind of step to let StockChief take it on its own.'};
  if(!rule.current)return {reason:'The limit was saved by someone who is no longer the owner. Save it again.'};
  const taught=rule.example_step_id?Boolean(await example(c,{workspaceId:gate.workspaceId},option.kind,rule.authorized_by)):false;
  if(!policy.permits(gate.account.plan,JOB,'automatic',{trained:taught}))return {reason:'Approve one step of this kind yourself, then save its limit again.'};
  if(option.hold)return {reason:option.hold};
  if(Number(option.details.since)<rule.minimum_days)return {reason:'Your limit acts after '+rule.minimum_days+' days without a sale.'};
  if(option.kind==='MOVE'&&exact.safeNumber(exact.subtract(option.quantity,rule.maximum_quantity),{signed:true})>0)
    return {reason:'This is over your limit of '+qty(rule.maximum_quantity)+' units per move.'};
  if(option.kind==='RETURN'){
    if(option.details.valueMinor==null)return {reason:'The recorded stock cost is incomplete, so your limit cannot be checked.'};
    if(option.details.currency!==rule.currency||option.details.valueMinor>Number(rule.maximum_minor))
      return {reason:'This is over your limit of '+money.format(Number(rule.maximum_minor),rule.currency)+' recorded cost per return.'};
  }
  const undone=(await c.query(`SELECT 1 FROM ${steps} WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 AND kind=$4 AND status='UNDONE'
    AND fingerprint=$5 LIMIT 1`,[gate.workspaceId,option.details.skuId,option.details.locationId,option.kind,option.fingerprint])).rowCount;
  if(undone)return {reason:'You undid this step before. It waits for you now.'};
  return {rule};
}

// The record behind each step goes through the ordinary services.
async function act(c,ctx,step,option,{automatic,rule=null,discount=null}){
  const d=option.details,key='slow-stock:'+step.id;
  let record={};
  if(option.kind==='MOVE'){
    const saved=await require('../transfers/postgres-transfer-service').requestInTransaction(c,ctx,{fromLocationId:d.locationId,toLocationId:d.destinationId,
      idempotencyKey:key,reason:'Move slow stock to where it sells',
      notes:d.code+' has had no sale at '+d.location+(d.daysSinceSale==null?' since it arrived':' for '+d.daysSinceSale+' days')+'. '+d.destination+' sold '+d.destinationSold90+' in the last 90 days.',
      decisionDetail:{kind:'agent_slow_stock_move',stepId:step.id,fingerprint:option.fingerprint,automatic},lines:[{skuId:d.skuId,quantity:option.quantity}]});
    record={transfer_id:saved.id,reference:saved.transfer_number};
  }else if(option.kind==='RETURN'){
    const saved=await require('../operations/postgres-returns').requestSupplierReturn(scoped(c),ctx,{supplierId:d.supplierId,supplierBillId:d.billId||null,
      expectedCreditMinor:null,reason:'Slow stock: '+d.finding.toLowerCase()+' at '+d.location+'. Confirm the supplier takes it back and on what terms.',
      lines:[{skuId:d.skuId,locationId:d.locationId,quantity:option.quantity}],idempotencyKey:key});
    record={supplier_return_id:saved.supplierReturnId,reference:saved.returnNumber};
  }else{
    const terms=discount||{markdown:rule&&String(rule.markdown_points/100),stepDays:rule&&String(rule.step_days)};
    const plan=await require('../pricing/agent-clearance-plans').prepareIn(c,ctx,{requestKey:key,sku:d.skuId,markdown:terms.markdown,stepDays:terms.stepDays},{automatic});
    record={clearance_plan_id:plan.id,reference:plan.id};
  }
  await c.query(`UPDATE ${steps} SET status='DONE',automatic=$3,decided_by=$4,decided_at=clock_timestamp(),rule_revision=$5,reason=NULL,would_apply=false,
      transfer_id=$6,supplier_return_id=$7,clearance_plan_id=$8 WHERE workspace_id=$1 AND id=$2`,
  [ctx.workspaceId,step.id,automatic,ctx.actorId,rule?.revision??null,record.transfer_id||null,record.supplier_return_id||null,record.clearance_plan_id||null]);
  if(option.kind!=='MOVE')await c.query(`UPDATE ${steps} SET status='DISMISSED',reason='Another step was chosen for this stock.',decided_at=clock_timestamp()
    WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 AND kind IN ('RETURN','DISCOUNT') AND kind<>$4 AND status IN ('DRAFT','HELD')`,
  [ctx.workspaceId,d.skuId,d.locationId,option.kind]);
  await audit.record(c,ctx,{action:automatic?'Slow stock step taken on its own':'Slow stock step approved',reference:step.id,
    after:{kind:option.kind,sku:d.code,location:d.location,quantity:option.quantity,record:record.reference,
      limit:automatic&&rule?{minimumDays:rule.minimum_days,units:rule.maximum_quantity,value:rule.maximum_minor,markdown:rule.markdown_points}:null}});
  return {kind:option.kind,...record};
}

// Keeps one open step per finding and kind, refreshed to the latest facts.
async function record(c,workspaceId,option,{status='DRAFT',reason=null,wouldApply=false}={}){
  const d=option.details;
  return (await c.query(`INSERT INTO ${steps} AS s(id,workspace_id,sku_id,location_id,kind,status,quantity,details,fingerprint,reason,would_apply)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
    ON CONFLICT(workspace_id,sku_id,location_id,kind) WHERE status IN ('DRAFT','HELD') DO UPDATE SET status=excluded.status,quantity=excluded.quantity,
      details=excluded.details,fingerprint=excluded.fingerprint,reason=excluded.reason,would_apply=excluded.would_apply,checked_at=clock_timestamp()
    RETURNING *`,
  [require('../lib/util').newId('slow-stock-step'),workspaceId,d.skuId,d.locationId,option.kind,option.hold?'HELD':status,option.quantity,JSON.stringify(d),
    option.fingerprint,option.hold||reason,wouldApply])).rows[0];
}

async function gates(c,workspaceId){
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {draft:false,account};
  const person=(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0];
  if(!person)return {draft:false,account};
  await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[workspaceId]);
  let blocked=await policy.stopped(c,workspaceId,account,ACTION,true);
  if(!blocked&&!(await require('../autopilot/postgres-service').getState(c,workspaceId)).canAutomate)blocked='Handle routine work is off for this inventory.';
  return {draft:true,account,owner:person.id,blocked,workspaceId};
}

// One option: act within the owner's limits, or leave a draft with the reason.
async function decide(c,gate,option){
  const ctx={workspaceId:gate.workspaceId,actorId:gate.owner};
  if(option.hold)return {state:(await record(c,gate.workspaceId,option)).status};
  const allowed=await authority(c,gate,option);
  if(allowed.reason||gate.blocked){
    await record(c,gate.workspaceId,option,{reason:allowed.reason||gate.blocked,wouldApply:!allowed.reason});
    return {state:'DRAFT'};
  }
  const step=await record(c,gate.workspaceId,option);
  await c.query('SAVEPOINT slow_stock_step');
  try{
    await act(c,ctx,step,option,{automatic:true,rule:allowed.rule});
    await c.query('RELEASE SAVEPOINT slow_stock_step');
    return {state:'DONE'};
  }catch(error){
    if(!expected(error))throw error;
    await c.query('ROLLBACK TO SAVEPOINT slow_stock_step');
    await record(c,gate.workspaceId,option,{reason:error.message});
    return {state:'DRAFT'};
  }
}

// Worker: checks every finding page by page and prepares or takes each step.
async function run(job,database){
  const workspaceId=job.workspaceId,started=new Date().toISOString(),seen=new Set(),totals={done:0,draft:0,held:0};
  for(let page=1;page<=200;page++){
    const batch=await tx(database,async c=>{
      const gate=await gates(c,workspaceId);
      if(!gate.draft)return null;
      const today=await require('../lib/business-time').today(c,workspaceId);
      const found=await excess.findings(c,{workspaceId,actorId:gate.owner},{page,today});
      const keys=[];
      for(const row of found.rows){
        const all=await options(c,{workspaceId},row),move=all.filter(o=>o.kind==='MOVE'),clear=all.filter(o=>o.kind!=='MOVE');
        for(const option of move){keys.push(option);totals[(await decide(c,gate,option)).state.toLowerCase()]++;}
        // A return and a discount clear the same units. Once one is taken the
        // other is not needed; otherwise both wait as alternatives.
        for(const option of clear){
          keys.push(option);
          const outcome=await decide(c,gate,option);totals[outcome.state.toLowerCase()]++;
          if(outcome.state==='DONE')break;
        }
      }
      return {keys,more:found.more};
    });
    if(!batch)return {skipped:true,...totals};
    for(const o of batch.keys)seen.add(JSON.stringify([o.details.skuId,o.details.locationId,o.kind]));
    if(!batch.more){
      // Steps whose finding is gone are no longer needed.
      await tx(database,async c=>{
        const open=(await c.query(`SELECT id,sku_id,location_id,kind FROM ${steps} WHERE workspace_id=$1 AND status IN ('DRAFT','HELD') AND checked_at<$2`,
          [workspaceId,started])).rows.filter(s=>!seen.has(JSON.stringify([s.sku_id,s.location_id,s.kind])));
        if(open.length)await c.query(`UPDATE ${steps} SET status='DISMISSED',reason='The stock no longer needs this step.',decided_at=clock_timestamp()
          WHERE workspace_id=$1 AND id=ANY($2::text[]) AND status IN ('DRAFT','HELD')`,[workspaceId,open.map(s=>s.id)]);
      });
      return totals;
    }
  }
  return totals;
}

// Slow stock changes slowly: the routine checks it once a business day, and
// again whenever the owner saves a limit or asks to check now.
async function schedule(c,workspaceId,cycleId){
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {queued:false};
  const today=await require('../lib/business-time').today(c,workspaceId);
  return {queued:(await jobs.enqueue(scoped(c),{workspaceId,kind,idempotencyKey:'slow-stock:day:'+today,payload:{cycleId},priority:70,maxAttempts:3})).created};
}
async function check(db,ctx){
  return tx(db,async c=>{
    await access(c,ctx,{lock:true});
    return {queued:(await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,idempotencyKey:'slow-stock:check:'+Math.floor(Date.now()/60000),
      payload:{requestedBy:ctx.actorId},priority:55,maxAttempts:3})).created};
  });
}

async function load(db,ctx,id,{lock=false}={}){
  const row=(await db.query(`SELECT * FROM ${steps} WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[ctx.workspaceId,String(id||'')])).rows[0];
  if(!row)throw new NotFoundError('That slow stock step is not in this inventory.');
  return row;
}

// The same step as it would be prepared now, or null when the finding changed.
async function live(c,ctx,step){
  const today=await require('../lib/business-time').today(c,ctx.workspaceId);
  const found=await excess.findings(c,ctx,{skuIds:[step.sku_id],today});
  const row=found.rows.find(r=>r.position.location_id===step.location_id);
  return row?(await options(c,ctx,row)).find(o=>o.kind===step.kind)||null:null;
}

// A person approves one exact step.
async function approve(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true,stop:true});
    const step=await load(c,ctx,id,{lock:true});
    if(step.status==='DONE'&&input.fingerprint===step.fingerprint)return {replayed:true};
    if(!['DRAFT','HELD'].includes(step.status))throw new ValidationError('This step is no longer waiting for you.');
    if(input.confirmed!=='yes'||input.fingerprint!==step.fingerprint)throw new ValidationError('Review the current step and confirm it.');
    await c.query('SELECT id FROM skus WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,step.sku_id]);
    const option=await live(c,ctx,step);
    if(!option||option.fingerprint!==step.fingerprint)throw new ValidationError('The stock changed since this step was prepared. Check again for a fresh step.');
    if(option.hold)throw new ValidationError(option.hold);
    let discount=null;
    if(step.kind==='DISCOUNT'){
      const rule=await loadRule(c,ctx.workspaceId,'DISCOUNT');
      discount={markdown:String(input.markdown??'').trim()||(rule?.enabled?String(rule.markdown_points/100):''),
        stepDays:String(input.stepDays??'').trim()||(rule?.enabled?String(rule.step_days):'')};
    }
    return act(c,ctx,step,option,{automatic:false,discount});
  });
}

async function dismiss(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true});
    const step=await load(c,ctx,id,{lock:true});
    if(step.status==='DISMISSED')return {replayed:true};
    if(!['DRAFT','HELD'].includes(step.status))throw new ValidationError('This step is no longer waiting for you.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that the stock stays as it is.');
    await c.query(`UPDATE ${steps} SET status='DISMISSED',reason='You kept the stock as it is.',decided_by=$3,decided_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Slow stock step dismissed',reference:id,after:{kind:step.kind}});
    return {dismissed:true};
  });
}

// What can still be undone: nothing was approved, picked or sent after the step.
async function undoable(db,ctx,step){
  if(step.status!=='DONE')return false;
  if(step.transfer_id)return (await db.query("SELECT 1 FROM inventory_transfers WHERE workspace_id=$1 AND id=$2 AND status='REQUESTED'",[ctx.workspaceId,step.transfer_id])).rowCount>0;
  if(step.supplier_return_id)return (await db.query("SELECT 1 FROM supplier_returns WHERE workspace_id=$1 AND id=$2 AND status='REQUESTED'",[ctx.workspaceId,step.supplier_return_id])).rowCount>0;
  if(step.clearance_plan_id)return (await db.query("SELECT 1 FROM stockchief_runtime.agent_clearance_plans WHERE workspace_id=$1 AND id=$2 AND status='DRAFT'",[ctx.workspaceId,step.clearance_plan_id])).rowCount>0;
  return false;
}
async function undo(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true});
    const step=await load(c,ctx,id,{lock:true});
    if(step.status==='UNDONE')return {replayed:true};
    if(step.status!=='DONE')throw new ValidationError('Only a step that was taken can be undone.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that this step is undone.');
    if(step.transfer_id){
      const t=await require('../transfers/postgres-transfer-service').get(c,ctx.workspaceId,step.transfer_id,{lock:true});
      if(t.status!=='REQUESTED')throw new ValidationError('The transfer was already approved or moved. Change it on the transfer.');
      await require('../transfers/postgres-transfer-service').cancelInTransaction(c,ctx,step.transfer_id,{idempotencyKey:'slow-stock-undo:'+step.id,reason:'Undone from slow stock'});
    }else if(step.supplier_return_id){
      const changed=await c.query("UPDATE supplier_returns SET status='CANCELLED' WHERE workspace_id=$1 AND id=$2 AND status='REQUESTED'",[ctx.workspaceId,step.supplier_return_id]);
      if(!changed.rowCount)throw new ValidationError('The supplier return was already approved or sent. Change it on the return.');
    }else if(step.clearance_plan_id){
      await require('../pricing/agent-clearance-plans').cancelDraft(c,ctx,step.clearance_plan_id);
    }
    await c.query(`UPDATE ${steps} SET status='UNDONE',decided_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
    await audit.record(c,ctx,{action:'Slow stock step undone',reference:id,after:{kind:step.kind,automatic:step.automatic}});
    return {undone:true};
  });
}

// The owner's limit for one kind of step. Pro needs a completed manual example.
async function configure(database,ctx,type,input={}){
  if(!KINDS.includes(type))throw new ValidationError('Choose a move, return or discount limit.');
  return tx(database,async c=>{
    await owner(c,ctx,{lock:true});
    const state=await policy.accountState(c,ctx.workspaceId);
    policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,JOB,'automatic',{trained:true});
    const prior=(await c.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND kind=$2 FOR UPDATE`,[ctx.workspaceId,type])).rows[0];
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the page to see the current limit.');
    if(input.stop==='yes'){
      if(prior?.enabled){
        await c.query(`UPDATE ${rules} SET enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND kind=$2`,[ctx.workspaceId,type]);
        await audit.record(c,ctx,{action:'Slow stock limit stopped',reference:type});
      }
      return {stopped:true};
    }
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the limit before saving it.');
    const days=Number(String(input.minimumDays??'').trim());
    if(!Number.isSafeInteger(days)||days<1||days>3650)throw new ValidationError('Enter how many days without a sale, from 1 to 3,650.');
    const values={maximum_quantity:null,maximum_minor:null,currency:null,markdown_points:null,step_days:null};
    if(type==='MOVE'){
      let units;try{units=exact.safeNumber(String(input.maximumQuantity??'').trim(),{positive:true,label:'Units per move'});}
      catch(error){if(error.code!=='validation_error')throw error;}
      if(!(units>0))throw new ValidationError('Enter the most units one move can hold.');
      values.maximum_quantity=String(units);
    }else if(type==='RETURN'){
      const book=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
      if(!book)throw new ValidationError('Set up the inventory books so returns can be checked against their recorded cost.');
      const amount=money.userToMinor(input.maximum,book.base_currency,{label:'Recorded cost per return'});
      if(!(amount>0))throw new ValidationError('Enter the most recorded cost one return can carry.');
      Object.assign(values,{maximum_minor:amount,currency:book.base_currency});
    }else{
      const plans=require('../pricing/agent-clearance-plans');
      Object.assign(values,{markdown_points:plans.markdownPoints(input.markdown),step_days:plans.stepLength(input.stepDays)});
    }
    const taught=policy.allowance(state.plan,JOB)==='trained'?await example(c,ctx,type):null;
    if(policy.allowance(state.plan,JOB)==='trained'&&!taught)throw new ValidationError('Approve one step of this kind yourself first.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'slow-stock-rule:'+type+':'+((prior?.revision||0)+1),4096,{finished:true});
    await c.query(`INSERT INTO ${rules} AS r(workspace_id,kind,minimum_days,maximum_quantity,maximum_minor,currency,markdown_points,step_days,authorized_by,example_step_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,kind) DO UPDATE SET enabled=true,minimum_days=excluded.minimum_days,
      maximum_quantity=excluded.maximum_quantity,maximum_minor=excluded.maximum_minor,currency=excluded.currency,markdown_points=excluded.markdown_points,
      step_days=excluded.step_days,authorized_by=excluded.authorized_by,example_step_id=excluded.example_step_id,revision=r.revision+1,updated_at=clock_timestamp()`,
    [ctx.workspaceId,type,days,values.maximum_quantity,values.maximum_minor,values.currency,values.markdown_points,values.step_days,ctx.actorId,taught?.id||null]);
    await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,idempotencyKey:'slow-stock:rule:'+type+':'+((prior?.revision||0)+1),payload:{},priority:55,maxAttempts:3});
    await audit.record(c,ctx,{action:'Slow stock limit saved',reference:type,before:prior?{enabled:prior.enabled,minimumDays:prior.minimum_days}:{},
      after:{minimumDays:days,units:values.maximum_quantity,value:values.maximum_minor,currency:values.currency,markdown:values.markdown_points,stepDays:values.step_days,example:taught?.id||null}});
    return {saved:true};
  });
}

const labels={DRAFT:'Waiting for you',HELD:'Needs your check',DONE:'Done',DISMISSED:'Kept as it is',UNDONE:'Undone'};
function summary(step){
  const s={kind:step.kind,quantity:qty(step.quantity),details:step.details};
  return describe[step.kind](s);
}

async function page(db,ctx,{page:number=1}={}){
  const state=await access(db,ctx);
  number=Number(number);
  if(!Number.isSafeInteger(number)||number<1||number>1000000)throw new ValidationError('Choose a valid page.');
  const waiting=(await db.query(`SELECT * FROM ${steps} WHERE workspace_id=$1 AND status IN ('DRAFT','HELD')
    ORDER BY (details->>'code'),(details->>'location'),array_position(ARRAY['MOVE','RETURN','DISCOUNT'],kind),id LIMIT 51 OFFSET $2`,[ctx.workspaceId,(number-1)*50])).rows;
  const recent=(await db.query(`SELECT s.*,t.transfer_number,r.return_number FROM ${steps} s
    LEFT JOIN inventory_transfers t ON t.workspace_id=s.workspace_id AND t.id=s.transfer_id
    LEFT JOIN supplier_returns r ON r.workspace_id=s.workspace_id AND r.id=s.supplier_return_id
    WHERE s.workspace_id=$1 AND s.status IN ('DONE','UNDONE') ORDER BY s.decided_at DESC,s.id LIMIT 25`,[ctx.workspaceId])).rows;
  const done=[];
  for(const s of recent)done.push({...s,text:summary(s),label:s.status==='UNDONE'?'Undone':s.automatic?'Taken on its own':'Approved by you',
    undoable:await undoable(db,ctx,s),
    link:s.transfer_id?'/transfers/'+encodeURIComponent(s.transfer_id):s.supplier_return_id?'/supplier-returns/'+encodeURIComponent(s.supplier_return_id):
      s.clearance_plan_id?'/autopilot/clearance-plans/'+encodeURIComponent(s.clearance_plan_id):null,
    linkLabel:s.transfer_number||s.return_number||(s.clearance_plan_id?'Clearance plan':null)});
  const mode=policy.allowance(state.plan,JOB);
  const limits=[];
  if(policy.permits(state.plan,JOB,'automatic',{trained:true}))for(const type of KINDS){
    const rule=await loadRule(db,ctx.workspaceId,type);
    limits.push({kind:type,rule,maximum:rule?.maximum_minor?money.fromMinor(Number(rule.maximum_minor),rule.currency):'',canTeach:mode!=='trained'||Boolean(await example(db,ctx,type)),
      taught:mode!=='trained'||Boolean(rule?.example_step_id&&await example(db,ctx,type,rule.authorized_by))});
  }
  const discountRule=await loadRule(db,ctx.workspaceId,'DISCOUNT');
  const stop=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
  return {mode,stop,page:number,more:waiting.length>50,percent,
    waiting:waiting.slice(0,50).map(s=>({...s,quantity:qty(s.quantity),text:summary(s),label:labels[s.status]})),done,limits,
    discountDefaults:discountRule?.enabled?{markdown:discountRule.markdown_points/100,stepDays:discountRule.step_days}:null};
}

async function inbox(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const row=(await db.query(`SELECT count(*) FILTER(WHERE status='DRAFT')::int AS waiting,count(*) FILTER(WHERE status='HELD')::int AS held,
    min(created_at) AS at FROM ${steps} WHERE workspace_id=$1 AND status IN ('DRAFT','HELD')`,[workspaceId])).rows[0];
  if(!row.waiting&&!row.held)return [];
  return [{kind:'inventory',importance:'Needs You',priority:50,grouped:true,
    title:'Slow stock steps need you',
    happened:[row.waiting?row.waiting+(row.waiting===1?' step waits':' steps wait')+' for your approval.':null,
      row.held?row.held+(row.held===1?' step needs':' steps need')+' you to pick exact units.':null].filter(Boolean).join(' '),
    why:'Dead and slow stock ties up cash. Moves, returns and discounts outside your limits wait for a person.',
    recommendation:'Approve, or keep the stock as it is.',href:path,actionLabel:'Review slow stock',sourceId:'slow-stock-steps',at:row.at,createdAt:row.at}];
}

module.exports={JOB,ACTION,kind,path,options,nextStep,returnSource,run,schedule,check,approve,dismiss,undo,configure,page,inbox,load};
