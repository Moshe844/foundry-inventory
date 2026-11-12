'use strict';

// Job 135: read supplier price lists and update costs, asking over 5%.
//
// The owner uploads a supplier's price list on the supplier price-list page
// (job 91 reads every supported format and keeps the original). Each row is then
// checked here against that supplier's saved terms for the product. A cost only
// changes when the supplier, the product and the pricing unit all match exactly
// and the price converts to an exact cost per stock unit; anything else is held
// for a person. A change over 5%, or over the owner's lower limit for that
// supplier, always waits for an individual approval.
//
// Pro drafts until taught: the owner approves one change from a supplier and
// saves a limit for it. Custom needs no teaching. Either way the update runs only
// in routine mode, outside shadow, pause, Watch only and Ask me first.
// The change goes through the supplier-product and purchase-cost services, is
// kept in the security audit and can be undone while nothing changed after it.

const {ValidationError,AuthorizationError,NotFoundError,DomainError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');
const {hash}=require('./postgres-promotions');
const {comparable}=require('../purchasing/supplier-price-list-source');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');

const JOB=135,ACTION='catalog.supplier_price_list',CEILING=500;
const kind='agent.supplier-price-update.v1',path='/autopilot/supplier-price-updates';
const lists='stockchief_runtime.agent_supplier_price_lists',findings='stockchief_runtime.agent_supplier_price_list_findings';
const rules='stockchief_runtime.agent_supplier_cost_rules',updates='stockchief_runtime.agent_supplier_cost_updates';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const expected=error=>error instanceof DomainError&&[400,402,403,404,409].includes(error.status);
const percent=points=>(Number(points)/100).toLocaleString('en-US',{maximumFractionDigits:2})+'%';
const change=(previous,amount)=>previous>0&&amount!=null&&amount!==previous?(amount>previous?'+':'−')+
  (Math.abs(amount-previous)*100/previous).toLocaleString('en-US',{maximumFractionDigits:1})+'%':null;
const fits=(value,points)=>points>0&&value.previous>0&&BigInt(value.difference)*10000n<=BigInt(value.previous)*BigInt(points);

async function owner(db,ctx,{lock=false}={}){
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  const allowed=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!allowed)throw new AuthorizationError('Only the current inventory owner can change supplier costs from price lists.');
}

// A person's own step. Pause and the 14-day shadow period follow the same rule
// as every other agent approval; keeping a cost or undoing one stays open.
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

// What the worker may do on its own right now, for the whole inventory.
async function gates(c,workspaceId,{lock=true}={}){
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {draft:false,account};
  const person=(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0];
  if(!person)return {draft:false,account};
  if(lock)await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[workspaceId]);
  let blocked=await policy.stopped(c,workspaceId,account,ACTION,true);
  if(!blocked&&!(await require('../autopilot/postgres-service').getState(c,workspaceId)).canAutomate)
    blocked='Handle routine work is off for this inventory.';
  return {draft:true,account,owner:person.id,blocked};
}

// The saved limit for one supplier, and whether it was taught by the current owner.
async function supplierRule(db,workspaceId,supplierId,{lock=false}={}){
  return (await db.query(`SELECT r.*,EXISTS(SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
      WHERE u.id=r.authorized_by AND w.id=r.workspace_id AND u.role='owner') AS current,
    EXISTS(SELECT 1 FROM ${updates} e JOIN ${lists} p ON p.workspace_id=e.workspace_id AND p.id=e.source_id AND p.supplier_id=r.supplier_id
      WHERE e.workspace_id=r.workspace_id AND e.source_id=r.example_source_id AND e.ordinal=r.example_ordinal
        AND NOT e.automatic AND e.decided_by=r.authorized_by AND e.status IN('APPLIED','UNDONE')) AS taught
    FROM ${rules} r WHERE r.workspace_id=$1 AND r.supplier_id=$2 ${lock?'FOR SHARE OF r':''}`,[workspaceId,supplierId])).rows[0]||null;
}

function routine(account,rule){
  if(rule&&!rule.enabled)return {points:0,reason:'You asked to approve every cost change from this supplier.'};
  if(rule&&!rule.current)return {points:0,reason:'The limit for this supplier was saved by someone who is no longer the owner. Save it again.'};
  if(!policy.permits(account.plan,JOB,'automatic',{trained:Boolean(rule?.taught)}))
    return {points:0,reason:'Approve one change from this supplier yourself, then save a limit, to let StockChief handle small changes.'};
  return {points:Math.min(CEILING,rule?Number(rule.maximum_basis_points):CEILING),rule};
}

const rowSql=`SELECT f.workspace_id,f.source_id,f.ordinal,f.sku_id,f.sku_code,f.sheet,f.row_number,f.quote,f.currency,
    f.amount_minor::text AS quoted_minor,f.pricing_quantity::text AS pricing_quantity,f.prior,f.result,f.reason AS source_reason,
    p.supplier_id,p.filename,p.status AS list_status,i.name AS item_name,coalesce(i.secondary_unit_label,i.unit_label) AS item_unit,
    u.status,u.supplier_item_id,u.previous_minor::text AS previous_minor,u.amount_minor::text AS new_minor,u.reason,u.would_apply,
    u.automatic,u.decided_by,u.review_hash,u.cost_id,u.written_at,u.decided_at,u.currency AS update_currency
  FROM ${findings} f JOIN ${lists} p ON p.workspace_id=f.workspace_id AND p.id=f.source_id
  LEFT JOIN skus s ON s.workspace_id=f.workspace_id AND s.id=f.sku_id
  LEFT JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  LEFT JOIN ${updates} u ON u.workspace_id=f.workspace_id AND u.source_id=f.source_id AND u.ordinal=f.ordinal`;

// The supplier's current terms for the linked products, optionally locked.
async function links(db,workspaceId,ids,{lock=false}={}){
  ids=[...new Set(ids.filter(Boolean))];
  if(!ids.length)return new Map();
  if(lock)await db.query(`SELECT s.id FROM supplier_items si JOIN skus s ON s.workspace_id=si.workspace_id AND s.id=si.sku_id
    WHERE si.workspace_id=$1 AND si.id=ANY($2::text[]) ORDER BY s.id FOR UPDATE OF s`,[workspaceId,ids]);
  const {rows}=await db.query(`SELECT si.id,si.supplier_id,si.sku_id,si.supplier_sku,si.purchase_unit,
      trim_scale(si.units_per_purchase_unit::numeric)::text AS pack,si.last_unit_cost::text AS cost,si.updated_at,
      v.currency,i.unit_label,i.secondary_unit_label
    FROM supplier_items si JOIN suppliers v ON v.workspace_id=si.workspace_id AND v.id=si.supplier_id
    JOIN skus s ON s.workspace_id=si.workspace_id AND s.id=si.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE si.workspace_id=$1 AND si.id=ANY($2::text[]) AND si.is_active=1 AND v.status='active' AND s.is_active=1 AND i.is_active=1
    ${lock?'FOR UPDATE OF si':''}`,[workspaceId,ids]);
  return new Map(rows.map(row=>[row.id,row]));
}
const termsId=row=>row.prior?.supplierTerms?.id||null;

// Exactly one answer per row: REVIEW (an exact change), UNCHANGED, or HELD with
// the reason a person has to look. Nothing here guesses a unit, a pack or a cost.
function evaluate(row,link){
  if(row.list_status!=='READY')return {state:'HELD',reason:'Finish reading this price list first.'};
  if(row.result==='HELD')return {state:'HELD',reason:row.source_reason||'This row could not be read exactly.'};
  const terms=row.prior?.supplierTerms;
  if(!terms)return {state:'HELD',reason:'This supplier has no saved cost for this exact product to update. Set it on the supplier product first.'};
  if(!link||link.id!==terms.id||link.supplier_id!==row.supplier_id||link.sku_id!==row.sku_id)
    return {state:'HELD',reason:'This supplier product is no longer active.'};
  const unit=link.secondary_unit_label||link.unit_label;
  if(terms.updatedAt!==link.updated_at||terms.cost!==link.cost||terms.currency!==link.currency||terms.pack!==link.pack||
    terms.purchaseUnit!==link.purchase_unit||terms.unit!==unit||terms.measured!==Boolean(link.secondary_unit_label)||
    (terms.supplierSku||null)!==(link.supplier_sku||null))
    return {state:'HELD',reason:'The supplier’s saved cost or pack changed after this list was read. Upload a current list to compare again.'};
  if(row.currency!==link.currency)return {state:'HELD',reason:'The list currency differs from the supplier’s currency.'};
  try{
    const value=comparable({...row.quote,currency:row.currency},{...link,units_per_purchase_unit:link.pack});
    const quoted=money.integer(row.quoted_minor),quantity=BigInt(exact.atoms(row.pricing_quantity,6));
    if(value.amountMinor!==quoted||BigInt(exact.atoms(value.pricingQuantity,6))!==quantity)
      throw new ValidationError('This row no longer matches how the list was read.');
    const numerator=BigInt(quoted)*1000000n;
    if(quantity<=0n||numerator%quantity!==0n)
      throw new ValidationError('This price does not divide into an exact cost per '+unit+'. Check it and set the cost yourself.');
    const amount=Number(numerator/quantity),previous=money.toMinor(link.cost,link.currency,{label:'The supplier’s saved cost'});
    if(!Number.isSafeInteger(amount))throw new ValidationError('This price is outside the supported range.');
    const difference=Math.abs(amount-previous);
    const base={currency:row.currency,unit,amount,previous,difference,linkId:link.id};
    if(amount===previous)return {...base,state:'UNCHANGED'};
    return {...base,state:'REVIEW',over:previous===0||BigInt(difference)*100n>BigInt(previous)*5n,
      reviewHash:hash([row.source_id,row.ordinal,row.quote,link.id,link.updated_at,link.cost,amount,row.currency])};
  }catch(error){
    if(error.code!=='validation_error')throw error;
    return {state:'HELD',reason:error.message};
  }
}

async function record(c,row,value,{reason=null,wouldApply=false}={}){
  await c.query(`INSERT INTO ${updates} AS u(workspace_id,source_id,ordinal,status,supplier_item_id,currency,previous_minor,amount_minor,reason,would_apply,review_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT(workspace_id,source_id,ordinal) DO UPDATE SET status=excluded.status,supplier_item_id=excluded.supplier_item_id,
      currency=excluded.currency,previous_minor=excluded.previous_minor,amount_minor=excluded.amount_minor,reason=excluded.reason,
      would_apply=excluded.would_apply,review_hash=excluded.review_hash,checked_at=clock_timestamp()
    WHERE u.status='REVIEW'`,
  [row.workspace_id,row.source_id,row.ordinal,value.state,value.linkId||null,value.currency||null,value.previous??null,value.amount??null,
    reason||value.reason||null,wouldApply,value.reviewHash||null]);
  return value.state;
}

// The cost changes through StockChief's own services. When the item's own
// purchase cost follows this supplier, it moves with it and keeps its history;
// otherwise only this supplier's price for future orders changes.
async function write(c,ctx,row,link,value,{automatic,rule=null}){
  const prices=require('./postgres-service');
  const itemCost=await prices.purchaseCost(c,ctx.workspaceId,link.sku_id);
  const follows=Boolean(itemCost?.id)&&itemCost.supplier_item_id===link.id&&itemCost.currency===value.currency&&Number(itemCost.amount_minor)===value.previous;
  let costId=null;
  if(follows){
    costId=(await prices.setPurchaseCostInTransaction(c,ctx,{skuId:link.sku_id,amountMinor:value.amount,currency:value.currency,
      supplierItemId:link.id,expectedCurrentId:itemCost.id,source:'agent_supplier_price_list',
      sourceDetail:{sourceId:row.source_id,ordinal:row.ordinal,sourceName:row.filename}})).id;
  }else{
    await require('../operations/postgres-commerce').linkSupplierItemInTransaction(c,ctx,{supplierId:link.supplier_id,skuId:link.sku_id,
      lastUnitCost:money.fromMinor(value.amount,value.currency),expectedUpdatedAt:link.updated_at});
  }
  const after=(await c.query('SELECT updated_at,last_unit_cost::text AS cost FROM supplier_items WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,link.id])).rows[0];
  if(!after||money.toMinor(after.cost,value.currency)!==value.amount||after.updated_at===link.updated_at)
    throw new ValidationError('The supplier’s saved cost did not change as reviewed. Check the supplier product.');
  await c.query(`INSERT INTO ${updates} AS u(workspace_id,source_id,ordinal,status,supplier_item_id,currency,previous_minor,amount_minor,
      automatic,decided_by,rule_revision,review_hash,cost_id,written_at,decided_at,reason,would_apply)
    VALUES($1,$2,$3,'APPLIED',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp(),NULL,false)
    ON CONFLICT(workspace_id,source_id,ordinal) DO UPDATE SET status='APPLIED',supplier_item_id=excluded.supplier_item_id,currency=excluded.currency,
      previous_minor=excluded.previous_minor,amount_minor=excluded.amount_minor,automatic=excluded.automatic,decided_by=excluded.decided_by,
      rule_revision=excluded.rule_revision,review_hash=excluded.review_hash,cost_id=excluded.cost_id,written_at=excluded.written_at,
      decided_at=excluded.decided_at,reason=NULL,would_apply=false,checked_at=clock_timestamp()`,
  [row.workspace_id,row.source_id,row.ordinal,link.id,value.currency,value.previous,value.amount,automatic,ctx.actorId,
    rule?.revision??null,value.reviewHash,costId,after.updated_at]);
  await audit.record(c,ctx,{action:automatic?'Supplier cost updated on its own from a price list':'Supplier cost updated from a price list',
    reference:row.source_id,before:{unitCost:money.format(value.previous,value.currency)},
    after:{unitCost:money.format(value.amount,value.currency),supplierItemId:link.id,sku:row.sku_code,ordinal:row.ordinal,automatic,
      itemCost:Boolean(costId),limit:automatic?percent(rule?Number(rule.maximum_basis_points):CEILING):null}});
  return 'applied';
}

async function decide(c,gate,row,rulesBySupplier){
  const link=(await links(c,row.workspace_id,[termsId(row)],{lock:true})).get(termsId(row));
  const value=evaluate(row,link);
  if(value.state!=='REVIEW')return record(c,row,value);
  if(!rulesBySupplier.has(row.supplier_id))rulesBySupplier.set(row.supplier_id,await supplierRule(c,row.workspace_id,row.supplier_id,{lock:true}));
  const allowed=routine(gate.account,rulesBySupplier.get(row.supplier_id));
  const within=!value.over&&fits(value,allowed.points);
  if(within&&!gate.blocked)return write(c,{workspaceId:row.workspace_id,actorId:gate.owner},row,link,value,{automatic:true,rule:allowed.rule});
  const reason=value.over?'This change is over 5%, so a person approves it.':
    allowed.points&&!within?'This change is over your '+percent(allowed.points)+' limit for this supplier.':allowed.reason||gate.blocked;
  return record(c,row,value,{reason,wouldApply:within});
}

// Worker: check every unchecked row of one list, then any row still waiting.
async function run(job,database){
  const workspaceId=job.workspaceId,sourceId=job.payload?.sourceId||null;
  const account=await policy.accountState(database,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {skipped:true};
  const sources=sourceId?[sourceId]:(await database.query(`SELECT p.id FROM ${lists} p WHERE p.workspace_id=$1 AND p.status='READY'
    AND EXISTS(SELECT 1 FROM ${updates} u WHERE u.workspace_id=p.workspace_id AND u.source_id=p.id AND u.status='REVIEW'
      AND u.previous_minor>0 AND abs(u.amount_minor-u.previous_minor)*100<=u.previous_minor*5)
    ORDER BY p.created_at DESC,p.id DESC LIMIT 50`,[workspaceId])).rows.map(r=>r.id);
  const totals={applied:0,review:0,held:0,unchanged:0};
  for(const id of sources){
    let after=0;
    for(;;){
      const batch=await tx(database,async c=>{
        const gate=await gates(c,workspaceId);
        if(!gate.draft)return null;
        const rows=(await c.query(rowSql+` WHERE f.workspace_id=$1 AND f.source_id=$2 AND p.status='READY' AND f.ordinal>$3
          AND (u.status IS NULL OR u.status='REVIEW') ORDER BY f.ordinal LIMIT 100`,[workspaceId,id,after])).rows;
        const counts={applied:0,review:0,held:0,unchanged:0},cache=new Map();
        for(const row of rows){
          await c.query('SAVEPOINT supplier_cost_row');
          try{
            counts[(await decide(c,gate,row,cache)).toLowerCase()]++;
            await c.query('RELEASE SAVEPOINT supplier_cost_row');
          }catch(error){
            if(!expected(error))throw error;
            await c.query('ROLLBACK TO SAVEPOINT supplier_cost_row');
            await record(c,row,{state:'HELD',reason:error.message});
            counts.held++;
          }
        }
        return {counts,last:rows.at(-1)?.ordinal,more:rows.length===100};
      });
      if(!batch)return {skipped:true,...totals};
      for(const key of Object.keys(totals))totals[key]+=batch.counts[key];
      if(!batch.more)break;
      after=batch.last;
    }
  }
  return totals;
}

// Called when a price list finishes reading, inside the same transaction.
async function queue(db,workspaceId,sourceId,{key='supplier-cost-update:'+sourceId}={}){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {queued:false};
  return {queued:(await jobs.enqueue(scoped(db),{workspaceId,kind,idempotencyKey:key,payload:{sourceId},priority:55,maxAttempts:5})).created};
}

// Each routine cycle retries small changes that were waiting only for authority,
// once nothing stops automatic work and a saved or default limit covers one.
async function schedule(c,workspaceId,cycleId){
  const gate=await gates(c,workspaceId,{lock:false});
  if(!gate.draft||gate.blocked||!policy.permits(gate.account.plan,JOB,'automatic',{trained:true}))return {queued:false};
  const untaught=policy.permits(gate.account.plan,JOB,'automatic');
  const waiting=(await c.query(`SELECT 1 FROM ${updates} u JOIN ${lists} p ON p.workspace_id=u.workspace_id AND p.id=u.source_id
    LEFT JOIN ${rules} r ON r.workspace_id=p.workspace_id AND r.supplier_id=p.supplier_id
    WHERE u.workspace_id=$1 AND u.status='REVIEW' AND u.previous_minor>0
      AND abs(u.amount_minor-u.previous_minor)*10000<=u.previous_minor*CASE WHEN r.supplier_id IS NULL THEN $2::int
        WHEN r.enabled THEN least(r.maximum_basis_points,$3::int) ELSE 0 END LIMIT 1`,[workspaceId,untaught?CEILING:0,CEILING])).rowCount;
  if(!waiting)return {queued:false};
  await jobs.enqueue(scoped(c),{workspaceId,kind,idempotencyKey:'supplier-cost-update:cycle:'+cycleId,payload:{cycleId},priority:55,maxAttempts:5});
  return {queued:true};
}

async function load(c,ctx,sourceId,ordinal,{lock=false}={}){
  const number=Number(ordinal);
  if(!Number.isSafeInteger(number)||number<1)throw new ValidationError('Choose a row from this price list.');
  if(lock)await c.query(`SELECT 1 FROM ${updates} WHERE workspace_id=$1 AND source_id=$2 AND ordinal=$3 FOR UPDATE`,[ctx.workspaceId,sourceId,number]);
  const row=(await c.query(rowSql+' WHERE f.workspace_id=$1 AND f.source_id=$2 AND f.ordinal=$3',[ctx.workspaceId,sourceId,number])).rows[0];
  if(!row)throw new NotFoundError('That price-list row is not in this inventory.');
  return row;
}

// The owner approves one exact change. Over 5% this is the only way it happens.
async function approve(db,ctx,sourceId,ordinal,input={}){
  return tx(db,async c=>{
    await access(c,ctx,{lock:true,stop:true});
    const row=await load(c,ctx,sourceId,ordinal,{lock:true});
    if(row.status==='APPLIED'&&row.review_hash===input.reviewHash)return {replayed:true};
    if(row.status&&row.status!=='REVIEW')throw new ValidationError('This row is no longer waiting for approval.');
    const link=(await links(c,ctx.workspaceId,[termsId(row)],{lock:true})).get(termsId(row));
    const value=evaluate(row,link);
    if(value.state!=='REVIEW')throw new ValidationError(value.reason||'This cost is already current.');
    if(input.confirmed!=='yes'||input.reviewHash!==value.reviewHash)
      throw new ValidationError('Review the current supplier cost and confirm this exact change.');
    await write(c,ctx,row,link,value,{automatic:false});
    return {applied:true};
  });
}

// The owner leaves the current cost as it is, for one row or all that are waiting.
async function keep(db,ctx,sourceId,ordinal,input={}){
  return tx(db,async c=>{
    await access(c,ctx,{lock:true});
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that the current costs stay as they are.');
    const list=(await c.query(`SELECT id FROM ${lists} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,sourceId])).rows[0];
    if(!list)throw new NotFoundError('That supplier price list is not in this inventory.');
    const kept=await c.query(`UPDATE ${updates} SET status='KEPT',decided_by=$4,decided_at=clock_timestamp(),would_apply=false
      WHERE workspace_id=$1 AND source_id=$2 AND ($3::int IS NULL OR ordinal=$3) AND status IN('REVIEW','HELD') RETURNING ordinal`,
    [ctx.workspaceId,sourceId,ordinal==null?null:Number(ordinal),ctx.actorId]);
    if(kept.rowCount)await audit.record(c,ctx,{action:'Supplier costs kept after a price list',reference:sourceId,after:{rows:kept.rows.map(r=>r.ordinal)}});
    return {kept:kept.rowCount};
  });
}

// Undo restores the previous cost while nothing else changed it since.
async function undo(db,ctx,sourceId,ordinal,input={}){
  return tx(db,async c=>{
    await access(c,ctx,{lock:true});
    const row=await load(c,ctx,sourceId,ordinal,{lock:true});
    if(row.status==='UNDONE')return {replayed:true};
    if(row.status!=='APPLIED')throw new ValidationError('Only an applied cost change can be undone.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that the previous cost comes back.');
    const link=(await links(c,ctx.workspaceId,[row.supplier_item_id],{lock:true})).get(row.supplier_item_id);
    const currency=row.update_currency,amount=Number(row.new_minor),previous=Number(row.previous_minor);
    const changed='The supplier’s cost changed after this update. Change it on the supplier product instead.';
    if(!link||link.updated_at!==row.written_at||link.currency!==currency||money.toMinor(link.cost,currency)!==amount)throw new ValidationError(changed);
    const prices=require('./postgres-service');
    if(row.cost_id){
      if((await prices.purchaseCost(c,ctx.workspaceId,link.sku_id))?.id!==row.cost_id)throw new ValidationError(changed);
      await prices.setPurchaseCostInTransaction(c,ctx,{skuId:link.sku_id,amountMinor:previous,currency,supplierItemId:link.id,
        expectedCurrentId:row.cost_id,source:'owner_undo_agent',sourceDetail:{sourceId,ordinal:row.ordinal}});
    }else{
      await require('../operations/postgres-commerce').linkSupplierItemInTransaction(c,ctx,{supplierId:link.supplier_id,skuId:link.sku_id,
        lastUnitCost:money.fromMinor(previous,currency),expectedUpdatedAt:link.updated_at});
    }
    await c.query(`UPDATE ${updates} SET status='UNDONE',decided_at=clock_timestamp() WHERE workspace_id=$1 AND source_id=$2 AND ordinal=$3`,
      [ctx.workspaceId,sourceId,row.ordinal]);
    await audit.record(c,ctx,{action:'Supplier cost update undone',reference:sourceId,
      before:{unitCost:money.format(amount,currency)},after:{unitCost:money.format(previous,currency),supplierItemId:link.id,ordinal:row.ordinal}});
    return {undone:true};
  });
}

// The owner's limit for one supplier: at most 5%. On Pro it is the taught rule
// and needs one change from that supplier the owner approved themselves.
async function configure(db,ctx,sourceId,input={}){
  const result=await tx(db,async c=>{
    await owner(c,ctx,{lock:true});
    const state=await policy.accountState(c,ctx.workspaceId);
    policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,JOB,'automatic',{trained:true});
    const list=(await c.query(`SELECT p.id,p.supplier_id FROM ${lists} p JOIN suppliers v ON v.workspace_id=p.workspace_id AND v.id=p.supplier_id
      WHERE p.workspace_id=$1 AND p.id=$2 AND v.status='active'`,[ctx.workspaceId,sourceId])).rows[0];
    if(!list)throw new ValidationError('Choose a price list from an active supplier.');
    const prior=(await c.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND supplier_id=$2 FOR UPDATE`,[ctx.workspaceId,list.supplier_id])).rows[0];
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the page to see this supplier’s current limit.');
    // Stopping keeps a disabled row: on Custom it means every change from this
    // supplier waits for a person, not the 5% default.
    if(input.stop==='yes'){
      if(!prior||prior.enabled){
        await c.query(`INSERT INTO ${rules} AS r(workspace_id,supplier_id,enabled,maximum_basis_points,authorized_by) VALUES($1,$2,false,$3,$4)
          ON CONFLICT(workspace_id,supplier_id) DO UPDATE SET enabled=false,authorized_by=excluded.authorized_by,revision=r.revision+1,updated_at=clock_timestamp()`,
        [ctx.workspaceId,list.supplier_id,prior?.maximum_basis_points||CEILING,ctx.actorId]);
        await audit.record(c,ctx,{action:'Supplier cost limit stopped',reference:list.supplier_id,before:prior?{limit:percent(prior.maximum_basis_points)}:{}});
      }
      return {stopped:true};
    }
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the limit for this supplier.');
    let points;
    try{points=exact.atoms(String(input.maximumPercent??'').trim().replace(/%$/,''),2,{label:'Limit'});}
    catch(error){if(error.code!=='validation_error')throw error;points=NaN;}
    if(!Number.isSafeInteger(points)||points<1||points>CEILING)throw new ValidationError('Set a limit from 0.01% to 5%.');
    const example=policy.allowance(state.plan,JOB)==='trained'?(await c.query(`SELECT e.source_id,e.ordinal FROM ${updates} e
      JOIN ${lists} p ON p.workspace_id=e.workspace_id AND p.id=e.source_id AND p.supplier_id=$2
      WHERE e.workspace_id=$1 AND e.status='APPLIED' AND NOT e.automatic AND e.decided_by=$3 ORDER BY e.decided_at DESC LIMIT 1`,
    [ctx.workspaceId,list.supplier_id,ctx.actorId])).rows[0]:null;
    if(policy.allowance(state.plan,JOB)==='trained'&&!example)throw new ValidationError('Approve one cost change from this supplier yourself first.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'supplier-cost-rule:'+list.supplier_id+':'+((prior?.revision||0)+1),4096,{finished:true});
    await c.query(`INSERT INTO ${rules} AS r(workspace_id,supplier_id,maximum_basis_points,authorized_by,example_source_id,example_ordinal)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,supplier_id) DO UPDATE SET enabled=true,maximum_basis_points=excluded.maximum_basis_points,
      authorized_by=excluded.authorized_by,example_source_id=excluded.example_source_id,example_ordinal=excluded.example_ordinal,
      revision=r.revision+1,updated_at=clock_timestamp()`,
    [ctx.workspaceId,list.supplier_id,points,ctx.actorId,example?.source_id||null,example?.ordinal||null]);
    await audit.record(c,ctx,{action:'Supplier cost limit saved',reference:list.supplier_id,
      before:prior?{limit:percent(prior.maximum_basis_points),enabled:prior.enabled}:{},after:{limit:percent(points),example:example?example.source_id+':'+example.ordinal:null}});
    const revision=(prior?.revision||0)+1;
    await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,idempotencyKey:'supplier-cost-update:rule:'+list.supplier_id+':'+revision,payload:{},priority:55,maxAttempts:5});
    return {saved:true,points};
  });
  return result;
}

// The owner can ask for a list read before this job was on the plan to be checked.
async function check(db,ctx,sourceId){
  return tx(db,async c=>{
    await access(c,ctx,{lock:true});
    const list=(await c.query(`SELECT id FROM ${lists} WHERE workspace_id=$1 AND id=$2 AND status='READY'`,[ctx.workspaceId,sourceId])).rows[0];
    if(!list)throw new ValidationError('Choose a price list that has finished reading.');
    return queue(c,ctx.workspaceId,sourceId,{key:'supplier-cost-update:'+sourceId+':check:'+Math.floor(Date.now()/60000)});
  });
}

const labels={REVIEW:'Waiting for you',HELD:'Needs your check',UNCHANGED:'Already current',KEPT:'Current cost kept',UNDONE:'Undone'};

async function page(db,ctx,{id=null,page:number=1}={}){
  const state=await access(db,ctx);
  number=Number(number);
  if(!Number.isSafeInteger(number)||number<1||number>1000000)throw new ValidationError('Choose a valid page.');
  const counts=`count(*) FILTER(WHERE u.status='APPLIED')::int AS applied,count(*) FILTER(WHERE u.status='REVIEW')::int AS waiting,
    count(*) FILTER(WHERE u.status='HELD')::int AS held,count(*) FILTER(WHERE u.status IS NULL)::int AS unchecked`;
  if(!id){
    const rows=(await db.query(`SELECT p.id,p.filename,p.status,p.created_at,v.name AS supplier,${counts}
      FROM ${lists} p LEFT JOIN suppliers v ON v.workspace_id=p.workspace_id AND v.id=p.supplier_id
      LEFT JOIN ${findings} f ON f.workspace_id=p.workspace_id AND f.source_id=p.id
      LEFT JOIN ${updates} u ON u.workspace_id=f.workspace_id AND u.source_id=f.source_id AND u.ordinal=f.ordinal
      WHERE p.workspace_id=$1 GROUP BY p.id,p.filename,p.status,p.created_at,v.name ORDER BY p.created_at DESC,p.id LIMIT 51 OFFSET $2`,
    [ctx.workspaceId,(number-1)*50])).rows;
    return {list:null,lists:rows.slice(0,50),more:rows.length>50,page:number,plan:state.plan};
  }
  const list=(await db.query(`SELECT p.id,p.filename,p.status,p.supplier_id,p.created_at,v.name AS supplier,v.status AS supplier_status,${counts},
      count(f.ordinal)::int AS total
    FROM ${lists} p LEFT JOIN suppliers v ON v.workspace_id=p.workspace_id AND v.id=p.supplier_id
    LEFT JOIN ${findings} f ON f.workspace_id=p.workspace_id AND f.source_id=p.id
    LEFT JOIN ${updates} u ON u.workspace_id=f.workspace_id AND u.source_id=f.source_id AND u.ordinal=f.ordinal
    WHERE p.workspace_id=$1 AND p.id=$2 GROUP BY p.id,p.filename,p.status,p.supplier_id,p.created_at,v.name,v.status`,[ctx.workspaceId,id])).rows[0];
  if(!list)throw new NotFoundError('That supplier price list is not in this inventory.');
  const found=(await db.query(rowSql+` WHERE f.workspace_id=$1 AND f.source_id=$2
    ORDER BY CASE u.status WHEN 'REVIEW' THEN 0 WHEN 'HELD' THEN 1 WHEN 'APPLIED' THEN 2 ELSE 3 END,f.ordinal LIMIT 101 OFFSET $3`,
  [ctx.workspaceId,id,(number-1)*100])).rows;
  const current=await links(db,ctx.workspaceId,[...found.map(termsId),...found.map(row=>row.supplier_item_id)]);
  const rows=found.slice(0,100).map(row=>{
    const base={ordinal:row.ordinal,code:row.sku_code,name:row.item_name,unit:row.item_unit,where:row.sheet+', row '+row.row_number,status:row.status,
      reason:row.reason,wouldApply:row.would_apply,automatic:row.automatic,currency:row.update_currency||row.currency,
      previous:row.previous_minor==null?null:Number(row.previous_minor),amount:row.new_minor==null?null:Number(row.new_minor)};
    if(row.status==='APPLIED')return {...base,label:row.automatic?'Updated on its own':'Updated after your approval',
      undoable:current.get(row.supplier_item_id)?.updated_at===row.written_at};
    if(row.status==='UNDONE'||row.status==='KEPT'||row.status==='UNCHANGED'||row.status==='HELD')return {...base,label:labels[row.status]};
    if(!row.status)return {...base,label:'Checking'};
    const live=evaluate(row,current.get(termsId(row)));
    if(live.state!=='REVIEW')return {...base,label:labels.HELD,reason:live.reason||'This cost is already current.',stale:true};
    return {...base,label:labels.REVIEW,unit:live.unit,previous:live.previous,amount:live.amount,currency:live.currency,
      over:live.over,reviewHash:live.reviewHash};
  }).map(row=>({...row,change:change(row.previous,row.amount)}));
  const rule=list.supplier_id?await supplierRule(db,ctx.workspaceId,list.supplier_id):null;
  const trained=policy.allowance(state.plan,JOB)==='trained';
  const example=trained&&list.supplier_id?(await db.query(`SELECT 1 FROM ${updates} e JOIN ${lists} p ON p.workspace_id=e.workspace_id AND p.id=e.source_id
    WHERE e.workspace_id=$1 AND p.supplier_id=$2 AND e.status='APPLIED' AND NOT e.automatic AND e.decided_by=$3 LIMIT 1`,
  [ctx.workspaceId,list.supplier_id,ctx.actorId])).rowCount>0:false;
  const routineFor=rule||!trained?routine(state,rule):{points:0};
  return {list,rows,more:found.length>100,page:number,plan:state.plan,trained,
    rule:rule&&{enabled:rule.enabled,revision:rule.revision,percent:percent(rule.maximum_basis_points),value:Number(rule.maximum_basis_points)/100,current:rule.current},
    limit:routineFor.points?percent(routineFor.points):null,canTeach:!trained||example,active:list.supplier_status==='active'};
}

async function inbox(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const rows=(await db.query(`SELECT p.id,p.filename,v.name AS supplier,count(*) FILTER(WHERE u.status='REVIEW')::int AS waiting,
      count(*) FILTER(WHERE u.status='HELD')::int AS held,min(u.checked_at) AS at
    FROM ${updates} u JOIN ${lists} p ON p.workspace_id=u.workspace_id AND p.id=u.source_id
    LEFT JOIN suppliers v ON v.workspace_id=p.workspace_id AND v.id=p.supplier_id
    WHERE u.workspace_id=$1 AND u.status IN('REVIEW','HELD') GROUP BY p.id,p.filename,v.name ORDER BY min(u.checked_at),p.id LIMIT 20`,[workspaceId])).rows;
  return rows.map(r=>({kind:'purchasing',importance:'Needs You',priority:70,grouped:true,
    title:'Supplier cost changes from '+(r.supplier||'a supplier')+' need you',
    happened:[r.waiting?r.waiting+(r.waiting===1?' change waits':' changes wait')+' for your approval.':null,
      r.held?r.held+(r.held===1?' row does not':' rows do not')+' match exactly.':null].filter(Boolean).join(' '),
    why:'Changes over 5%, over your limit, or that do not match the supplier, product and unit exactly always wait for a person.',
    recommendation:'Open '+r.filename+' and approve, keep or check each row.',
    href:path+'/'+encodeURIComponent(r.id),actionLabel:'Review cost changes',sourceId:'supplier-cost-update:'+r.id,at:r.at,createdAt:r.at}));
}

async function readPage(db,ctx,{page:number=1}={}){
  const result=await page(db,ctx,{page:number});
  return {summary:'Supplier price lists update the exact supplier’s future costs. Changes over 5% and anything unclear wait for you.',more:result.more,
    rows:result.lists.map(row=>({'Price list':row.filename,Supplier:row.supplier||'Archived supplier',Updated:String(row.applied),
      'Waiting for you':String(row.waiting+row.held),link:path+'/'+encodeURIComponent(row.id)}))};
}

module.exports={kind,path,queue,schedule,run,approve,keep,undo,configure,check,page,inbox,readPage};
