
'use strict';

const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const money=require('../domain/currency'),exact=require('../domain/exact-quantity');
const policy=require('../commercial/agent-plan'),permissions=require('../actions/permissions');
const age=require('../forecasting/agent-stock-age'),ledger=require('./postgres-ledger');
const ACTION='inventory.write_down_aged';
const SOURCE='inventory_valuation_write_down';
const JOB=17;

async function authorize(db,ctx,{approve=false}={}){
  if(approve)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  const actor=(await db.query(`SELECT u.role,u.permissions FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)`+
    (approve?' FOR SHARE OF u,w':''),[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!actor)throw new AuthorizationError('Only the current inventory owner can review and approve a stock write-down.');
  permissions.assertCan(actor,permissions.MANAGE_ACCOUNTING,'approve stock write-downs');
  const account=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'accounting.core');
  await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'inventory.core');
  if(approve){
    const reason=await policy.stopped(db,ctx.workspaceId,account,ACTION,false);
    if(reason)throw new ValidationError(reason);
  }
}

function positionIds(reference){
  const match=/^([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(String(reference||''));
  if(!match)throw new ValidationError('Open one exact product and location from the stock-age review.');
  return {skuId:match[1],locationId:match[2]};
}

async function readPosition(db,ctx,reference,{lock=false}={}){
  const {skuId,locationId}=positionIds(reference),key=[ctx.workspaceId,skuId,locationId];
  await require('../operations/postgres-warehouse-access').assertLocations(db,ctx,[locationId]);
  if(lock){
    await db.query('SELECT sku_id FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE',key);
    await db.query('SELECT sku_id FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE',key);
  }
  const date=await require('../lib/business-time').today(db,ctx.workspaceId);
  const cohorts=await age.rows(db,ctx,{skuId,locationId,today:date});
  const first=cohorts[0];
  if(!first||!age.owned(first))throw new ValidationError('Choose current stock at an active owned location.');
  const aged=cohorts.filter(age.old);
  if(!aged.length)throw new ValidationError('This position has no old stock with a proven receipt age.');
  if(!age.completelyCosted(first))throw new ValidationError('Reconcile all physical quantities, measurements and recorded cost for this position first.');
  const total=money.integer(first.book_value,'Recorded inventory value');
  if(!total)throw new ValidationError('This position already has zero recorded value.');
  const quantity=exact.canonical(first.on_hand),weight=first.secondary_on_hand===null?null:exact.canonical(first.secondary_on_hand);
  const agedQuantity=aged.reduce((sum,r)=>exact.add(sum,r.units),'0');
  const unprovenQuantity=cohorts.filter(r=>!age.known(r)).reduce((sum,r)=>exact.add(sum,r.units),'0');
  const position={skuId,locationId,reference,sku:first.code,product:first.name,location:first.location_name,
    unit:first.unit_label,secondaryUnit:first.secondary_unit_label,quantity,weight,agedQuantity,unprovenQuantity,
    oldestDays:aged[0].days,currency:first.currency,bookValueMinor:total,date};
  return {position,cohorts,fingerprint:hash({position,cohorts})};
}

async function page(database,ctx,reference){
  return database.transaction(async c=>{
    await authorize(c,ctx);
    const {position,cohorts,fingerprint}=await readPosition(c,ctx,reference);
    return {position,fingerprint,cohorts:cohorts.map(r=>({identity:r.identity,quantity:r.units,weight:r.weight,
      days:age.known(r)?r.days:null,basis:age.known(r)?r.basis:'Receipt age unavailable'}))};
  },{isolation:'REPEATABLE READ',retrySafe:true});
}

async function build(database,ctx,_row,args){
  return database.transaction(async c=>{
    await authorize(c,ctx);
    const current=await readPosition(c,ctx,args.recordReference),p=current.position;
    if(!args.expectedStockFingerprint)throw new ValidationError('Open the stock-age write-down review and enter your checked valuation evidence there.');
    if(current.fingerprint!==args.expectedStockFingerprint){
      throw new ValidationError('The stock, receipt ages or recorded value changed. Open the current position and check its valuation evidence again.');
    }
    if(args.currency&&money.code(args.currency)!==p.currency)throw new ValidationError('Use the accounting base currency shown for this stock.');
    const reference=String(args.reference||'').trim();
    if(reference.length<3||reference.length>1200)throw new ValidationError('Provide a supporting valuation reference for this entire product and location.');
    const recoverable=money.userToMinor(args.amount,p.currency,{label:'Net recoverable value'});
    if(recoverable>=p.bookValueMinor)throw new ValidationError('The supported recoverable value must be below the current recorded carrying value for a write-down.');
    const amount=p.bookValueMinor-recoverable,format=n=>money.format(n,p.currency);
    return {payload:{...p,recordReference:p.reference,valuationReference:reference,recoverableMinor:recoverable,writeDownMinor:amount,
      sourceFingerprint:current.fingerprint},summary:`Write down ${p.sku} at ${p.location} by ${format(amount)} to ${format(recoverable)} for all ${p.quantity} ${p.unit}.`};
  },{isolation:'REPEATABLE READ',retrySafe:true});
}

function result(row,replayed){
  return {writeDownId:row.id,journalEntryId:row.journal_entry_id,amountMinor:Number(row.before_value_minor)-Number(row.after_value_minor),
    carryingValueMinor:Number(row.after_value_minor),currency:row.currency,physicalUnits:String(row.quantity_units),replayed};
}

async function execute(client,ctx,p){
  await authorize(client,ctx,{approve:true});
  if(!p.idempotencyKey)throw new ValidationError('Individual write-down approval needs a saved operation key.');
  const key=[ctx.workspaceId,p.idempotencyKey],digest=hash(p);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['aged-stock-write-down:'+key.join(':')]);
  const prior=(await client.query('SELECT * FROM accounting_inventory_write_downs WHERE workspace_id=$1 AND idempotency_key=$2',key)).rows[0];
  if(prior){
    if(prior.payload_hash!==digest)throw new ValidationError('That write-down approval belongs to different evidence.');
    return result(prior,true);
  }
  const current=await readPosition(client,ctx,p.recordReference,{lock:true}),position=current.position;
  if(current.fingerprint!==p.sourceFingerprint)throw new ValidationError('The stock, receipt ages or recorded value changed. Prepare a fresh write-down for review.');
  const recoverable=money.integer(p.recoverableMinor,'Net recoverable value'),amount=position.bookValueMinor-recoverable;
  if(amount<=0||amount!==p.writeDownMinor)throw new ValidationError('The approved write-down needs its exact recorded carrying value and supported recovery.');
  await ledger.validatePostingDateInTransaction(client,ctx,position.date);
  await ledger.ensureSystemAccountInTransaction(client,ctx,'INVENTORY_WRITE_DOWNS');
  const id=newId('write-down'),at=nowIso(),valueId=newId('stock-value');
  const snapshot={...position,sourceFingerprint:current.fingerprint,agedSources:current.cohorts.filter(age.old).map(r=>({
    sourceId:r.source_id,quantity:r.units,weight:r.weight,receivedAt:r.received_at,basis:r.basis}))};
  await require('../commercial/storage-capacity').reserve(client,ctx.workspaceId,'stock-write-down:'+id,
    Buffer.byteLength(JSON.stringify(snapshot))*2+8192,{finished:true});
  const {skuId,locationId,currency}=position;
  const journal=await ledger.postInTransaction(client,ctx,{postingDate:position.date,currency,
    sourceKey:'inventory-write-down:'+p.idempotencyKey,sourceType:SOURCE,sourceRecordType:'inventory_write_down',sourceRecordId:id,
    description:'Inventory write-down for '+position.sku+' at '+position.location,createdByType:'USER',
    metadata:{skuId,locationId,quantity:position.quantity,secondaryQuantity:position.weight,
      evidenceReference:p.valuationReference,beforeValueMinor:position.bookValueMinor,afterValueMinor:recoverable,
      sourceFingerprint:current.fingerprint},
    lines:[{accountKey:'INVENTORY_WRITE_DOWNS',debitMinor:amount,skuId,locationId},
      {accountKey:'INVENTORY_ASSET',creditMinor:amount,skuId,locationId}]});
  const journalId=journal.entry.id;
  const changed=await client.query(`UPDATE accounting_inventory_cost_balances SET total_cost_minor=$4,updated_at=$5
    WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 AND total_cost_minor=$6
    RETURNING quantity_units::text,secondary_quantity_units::text`,[ctx.workspaceId,skuId,locationId,recoverable,at,position.bookValueMinor]);
  if(changed.rowCount!==1||exact.canonical(changed.rows[0].quantity_units)!==position.quantity||
    (changed.rows[0].secondary_quantity_units===null?null:exact.canonical(changed.rows[0].secondary_quantity_units))!==position.weight){
    throw new ValidationError('The current cost pool could not be changed without affecting stock quantities.');
  }
  await client.query(`INSERT INTO accounting_inventory_value_adjustments
    (id,workspace_id,sku_id,location_id,amount_delta_minor,quantity_units,source_type,source_record_id,journal_entry_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[valueId,ctx.workspaceId,skuId,locationId,-amount,position.quantity,SOURCE,id,journalId,at]);
  const row=(await client.query(`INSERT INTO accounting_inventory_write_downs
    (id,workspace_id,sku_id,location_id,currency,posting_date,quantity_units,secondary_quantity,before_value_minor,after_value_minor,
     evidence_reference,snapshot,approved_by,journal_entry_id,idempotency_key,payload_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16) RETURNING *`,
  [id,ctx.workspaceId,skuId,locationId,currency,position.date,position.quantity,position.weight,position.bookValueMinor,recoverable,
    p.valuationReference,JSON.stringify(snapshot),ctx.actorId,journalId,p.idempotencyKey,digest])).rows[0];
  return result(row,false);
}

async function verify(client,ctx,r,p){
  const proof=(await client.query(`SELECT w.payload_hash,w.approved_by,w.before_value_minor-w.after_value_minor amount,w.after_value_minor,w.currency,
    v.amount_delta_minor,v.quantity_units,
    coalesce(sum(l.debit_minor-l.credit_minor) FILTER(WHERE a.system_key='INVENTORY_WRITE_DOWNS'),0) expense,
    coalesce(sum(l.credit_minor-l.debit_minor) FILTER(WHERE a.system_key='INVENTORY_ASSET'),0) inventory,
    sum(l.debit_minor-l.credit_minor) difference,count(*) lines
  FROM accounting_inventory_write_downs w
  JOIN accounting_inventory_value_adjustments v ON v.workspace_id=w.workspace_id AND v.source_record_id=w.id
    AND v.source_type=$4 AND v.journal_entry_id=w.journal_entry_id AND v.sku_id=w.sku_id AND v.location_id=w.location_id
  JOIN accounting_journal_entries j ON j.workspace_id=w.workspace_id AND j.id=w.journal_entry_id
    AND j.status='POSTED' AND j.source_type=$4 AND j.source_record_id=w.id
  JOIN accounting_journal_lines l ON l.workspace_id=j.workspace_id AND l.entry_id=j.id AND l.sku_id=w.sku_id
    AND l.location_id=w.location_id AND l.currency=w.currency
  JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
  WHERE w.workspace_id=$1 AND w.id=$2 AND j.id=$3 GROUP BY w.id,v.id`,
  [ctx.workspaceId,r.writeDownId,r.journalEntryId,SOURCE])).rows[0];
  return Boolean(proof&&proof.payload_hash===hash(p)&&proof.approved_by===ctx.actorId&&proof.currency===p.currency&&
    exact.canonical(proof.quantity_units)===p.quantity&&Number(proof.after_value_minor)===p.recoverableMinor&&
    Number(proof.amount)===p.writeDownMinor&&Number(proof.amount_delta_minor)===-p.writeDownMinor&&
    Number(proof.inventory)===p.writeDownMinor&&Number(proof.expense)===p.writeDownMinor&&Number(proof.difference)===0&&Number(proof.lines)===2);
}

module.exports={ACTION,JOB,SOURCE,page,build,execute,verify};
