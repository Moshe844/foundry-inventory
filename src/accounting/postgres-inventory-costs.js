'use strict';
const {createHash}=require('node:crypto');
const exact=require('../domain/exact-quantity'),stockQuantity=require('../domain/stock-quantity');
const {newId,nowIso}=require('../lib/util'),{ValidationError,AuthorizationError}=require('../domain/errors');
const pricing=require('../pricing/postgres-service'),ledger=require('./postgres-ledger'),permissions=require('../actions/permissions');
const BASES=Object.freeze({opening_inventory:{label:'Stock owned before accounting setup',account:'OPENING_BALANCE_EQUITY'},
 previously_expensed:{label:'Purchase cost previously recorded as an expense',account:'INVENTORY_ADJUSTMENTS'}});
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
async function authorize(client,ctx){
 const actor=(await client.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!actor||!['owner','accountant'].includes(actor.role))throw new AuthorizationError('Only an owner or accountant can establish inventory cost.');
 permissions.assertCan(actor,permissions.MANAGE_ACCOUNTING,'establish inventory cost');
 await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'accounting.core');
 await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'inventory.core');
 const settings=(await client.query('SELECT * FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
 if(!settings)throw new ValidationError('Configure accounting before recording the cost of existing stock.');
 return settings;
}
async function position(client,ctx,input,{lock=false}={}){
 const identity=(await client.query(`SELECT i.*,s.id,s.item_id,s.code,l.name AS location_name FROM skus s
  JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
  JOIN locations l ON l.workspace_id=s.workspace_id AND l.id=$3 AND l.is_active=1
  WHERE s.workspace_id=$1 AND s.id=$2 AND s.is_active=1 AND i.is_active=1`,[ctx.workspaceId,input.skuId,input.locationId])).rows[0];
 if(!identity)throw new ValidationError('That product and location are not active in this business.');
 const physical=(await client.query(`SELECT on_hand,secondary_on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3${lock?' FOR UPDATE':''}`,
  [ctx.workspaceId,input.skuId,input.locationId])).rows[0];
 if(!physical||Number(physical.on_hand)<=0)throw new ValidationError('There is no existing stock at this location to cost.');
 const cost=(await client.query(`SELECT quantity_units,secondary_quantity_units,total_cost_minor,updated_at FROM accounting_inventory_cost_balances
  WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3${lock?' FOR UPDATE':''}`,[ctx.workspaceId,input.skuId,input.locationId])).rows[0];
 const physicalVersion=(await client.query('SELECT COALESCE(max(seq),0)::text AS version FROM movements WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
  [ctx.workspaceId,input.skuId,input.locationId])).rows[0].version;
 const snapshot={secondaryPhysicalUnits:physical.secondary_on_hand==null?null:Number(physical.secondary_on_hand),secondaryCostedUnits:cost?.secondary_quantity_units==null?null:Number(cost.secondary_quantity_units),physicalUnits:Number(physical.on_hand),costedUnits:Number(cost?.quantity_units||0),costMinor:Number(cost?.total_cost_minor||0),physicalVersion,costUpdatedAt:cost?.updated_at||null};
 if(snapshot.costedUnits>snapshot.physicalUnits)throw new ValidationError('Recorded costed units exceed physical stock. Reconcile this position before changing cost.');
 return {...identity,locationId:input.locationId,...snapshot,missingUnits:exact.safeNumber(exact.subtract(snapshot.physicalUnits,snapshot.costedUnits)),snapshotHash:hash(snapshot)};
}
async function previewInTransaction(client,ctx,input){
 const settings=await authorize(client,ctx),current=await position(client,ctx,input);
 if(!BASES[input.basis])throw new ValidationError('Choose opening stock or a purchase previously expensed. An unpaid or unrecorded supplier bill must use the supplier-invoice workflow.');
 const reference=String(input.evidenceReference||'').trim();
 if(reference.length<3||reference.length>1200)throw new ValidationError('Provide the purchase document, opening valuation or owner-confirmed evidence supporting this actual cost.');
 const currency=pricing.normaliseCurrency(input.currency,settings.base_currency);
 if(currency!==settings.base_currency)throw new ValidationError('Existing-stock cost must use the accounting base currency; no exchange rate will be guessed.');
 const symbols=String(input.unitCost??'').match(/[$£€¥]/g)||[],symbol=new Intl.NumberFormat('en-US',{style:'currency',currency}).formatToParts(1).find(p=>p.type==='currency')?.value||currency;
 if(symbols.some(s=>!symbol.includes(s)))throw new ValidationError('The unit-cost currency symbol does not match the accounting currency. Supply the evidenced amount in the displayed base currency.');
 const amount=input.unitCostMinor===undefined?pricing.toMinor(input.unitCost,'Actual unit cost'):Number(input.unitCostMinor);
 if(current.missingUnits<=0)throw new ValidationError('No existing units are missing cost. Already-costed units cannot be costed again.');
 const quantity=stockQuantity.validate(current,input.quantity===undefined||input.quantity===null||input.quantity===''?current.missingUnits:input.quantity);const secondaryQuantity=stockQuantity.secondary(current,input.secondaryQuantity);if(secondaryQuantity!==null){const missing=exact.safeNumber(exact.subtract(current.secondaryPhysicalUnits,current.secondaryCostedUnits??0));if(secondaryQuantity>missing||(quantity===current.missingUnits)!==(secondaryQuantity===missing))throw new ValidationError('The pieces and their actual uncosted weight must agree.');}
 if(quantity<=0||quantity>current.missingUnits)throw new ValidationError(`Only ${current.missingUnits} existing units at this location are missing cost. Already-costed units cannot be costed again.`);
 if(!Number.isSafeInteger(amount)||amount<0)throw new ValidationError('Actual unit cost must be an exact non-negative amount.');
 const total=exact.costMinor(secondaryQuantity??quantity,amount);if(!Number.isSafeInteger(total))throw new ValidationError('The total stock cost is outside the supported range.');
 const today=await require('../lib/business-time').today(client,ctx.workspaceId),date=String(input.postingDate||today);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw new ValidationError('Use a valid posting date.');
 if(date<settings.accounting_start_date||date>today)throw new ValidationError('Use an open posting date from the accounting start date through today.');
 const closed=(await client.query("SELECT id FROM accounting_periods WHERE workspace_id=$1 AND starts_on<=$2 AND ends_on>=$2 AND status<>'OPEN'",[ctx.workspaceId,date])).rows.length;
 if(closed)throw new ValidationError('The accounting period for this date is closed.');
 return {current,payload:{skuId:input.skuId,locationId:input.locationId,quantity,secondaryQuantity,unitCostMinor:amount,totalCostMinor:total,currency,basis:input.basis,evidenceReference:reference,
  postingDate:date,expectedSnapshot:current.snapshotHash,physicalUnits:current.physicalUnits,costedUnitsBefore:current.costedUnits,costMinorBefore:current.costMinor,
  productName:current.name,skuCode:current.code,locationName:current.location_name},summary:`Record ${pricing.formatMinor(amount,currency)} actual cost per unit for ${quantity} existing ${current.name} units at ${current.location_name} (${pricing.formatMinor(total,currency)} total). Quantity stays ${current.physicalUnits}.`};
}
async function preview(database,ctx,input){return database.transaction(client=>previewInTransaction(client,ctx,input),{isolation:'REPEATABLE READ',retrySafe:true});}
async function prepare(database,ctx,input,message){
 const review=await preview(database,ctx,input);
 const impact=input.basis==='opening_inventory'?'This records the value of stock you already owned when you started.':'This moves a previously expensed purchase into inventory and increases profit in the posting period.';
 return require('../assistant/postgres-service').createProposal(database,ctx,message||review.summary,'inventory.establish_cost',review.payload,
  `${review.summary} ${impact} Evidence: ${review.payload.evidenceReference}. Posting date: ${review.payload.postingDate}. No payment or supplier debt is created.`);
}
async function prepareFromArgs(database,ctx,args,message){
 const sku=(await database.query('SELECT id FROM skus WHERE workspace_id=$1 AND code=$2',[ctx.workspaceId,args.sku])).rows;
 const location=(await database.query('SELECT id FROM locations WHERE workspace_id=$1 AND name=$2 AND is_active=1',[ctx.workspaceId,args.location])).rows;
 if(sku.length!==1||location.length!==1)throw new ValidationError('Choose an exact active product and location.');
 return prepare(database,ctx,{skuId:sku[0].id,locationId:location[0].id,quantity:args.quantity,unitCost:args.amount,currency:args.currency,
  basis:args.costBasis,evidenceReference:args.reference,postingDate:args.postingDate},message);
}
async function establishInTransaction(client,ctx,payload){
 await authorize(client,ctx);
 if(!payload.idempotencyKey)throw new ValidationError('A durable approved operation key is required.');
 const payloadHash=hash(payload);
 await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`existing-stock-cost:${ctx.workspaceId}:${payload.idempotencyKey}`]);
 const prior=(await client.query('SELECT * FROM accounting_inventory_cost_establishments WHERE workspace_id=$1 AND idempotency_key=$2',[ctx.workspaceId,payload.idempotencyKey])).rows[0];
 if(prior){if(prior.payload_hash!==payloadHash)throw new ValidationError('That operation key belongs to different approved cost evidence.');return result(prior,true);}
 const before=await position(client,ctx,payload,{lock:true});
 if(before.snapshotHash!==payload.expectedSnapshot)throw new ValidationError('Stock or its recorded cost changed after this approval was prepared. Review the latest position and prepare a new proposal.');
 const review=await previewInTransaction(client,ctx,payload);
 if(review.payload.totalCostMinor!==payload.totalCostMinor)throw new ValidationError('The prepared cost total does not match the approved units and actual unit cost.');
 const after={quantity:exact.safeNumber(exact.add(before.costedUnits,payload.quantity)),cost:before.costMinor+payload.totalCostMinor},id=newId('costest'),at=nowIso();
 let journal=null;
 if(payload.totalCostMinor>0)journal=await ledger.postInTransaction(client,ctx,{postingDate:payload.postingDate,currency:payload.currency,
  sourceType:'inventory_cost_establishment',sourceRecordType:'inventory_cost_establishment',sourceRecordId:id,sourceKey:`existing-stock-cost:${payload.idempotencyKey}`,
  description:review.summary,createdByType:'USER',metadata:{evidenceReference:payload.evidenceReference,basis:payload.basis,physicalUnitsUnchanged:true},
  lines:[{accountKey:'INVENTORY_ASSET',debitMinor:payload.totalCostMinor,skuId:payload.skuId,locationId:payload.locationId},
   {accountKey:BASES[payload.basis].account,creditMinor:payload.totalCostMinor,skuId:payload.skuId,locationId:payload.locationId}]});
 await client.query(`INSERT INTO accounting_inventory_cost_balances(workspace_id,sku_id,location_id,quantity_units,total_cost_minor,updated_at,secondary_quantity_units)
  VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,sku_id,location_id) DO UPDATE SET quantity_units=EXCLUDED.quantity_units,total_cost_minor=EXCLUDED.total_cost_minor,secondary_quantity_units=EXCLUDED.secondary_quantity_units,updated_at=EXCLUDED.updated_at`,
  [ctx.workspaceId,payload.skuId,payload.locationId,after.quantity,after.cost,at,payload.secondaryQuantity==null?null:exact.safeNumber(exact.add(before.secondaryCostedUnits??0,payload.secondaryQuantity))]);
 const row=(await client.query(`INSERT INTO accounting_inventory_cost_establishments(id,workspace_id,sku_id,location_id,quantity_units,unit_cost_minor,total_cost_minor,currency,basis,evidence_reference,
  posting_date,physical_units,costed_units_before,costed_units_after,cost_minor_before,cost_minor_after,journal_entry_id,idempotency_key,payload_hash,created_by_user_id,created_at,secondary_quantity)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
  [id,ctx.workspaceId,payload.skuId,payload.locationId,payload.quantity,payload.unitCostMinor,payload.totalCostMinor,payload.currency,payload.basis,payload.evidenceReference,
   payload.postingDate,before.physicalUnits,before.costedUnits,after.quantity,before.costMinor,after.cost,journal?.entry.id||null,payload.idempotencyKey,payloadHash,ctx.actorId,at,payload.secondaryQuantity??null])).rows[0];
 const persisted=await position(client,ctx,payload);
 if(persisted.physicalUnits!==before.physicalUnits||persisted.physicalVersion!==before.physicalVersion||persisted.costedUnits!==after.quantity||persisted.costMinor!==after.cost)
  throw new ValidationError('Inventory cost could not be verified without changing physical stock. Nothing was committed.');
 return result(row,false);
}
function result(row,replayed){return {costEstablishmentId:row.id,skuId:row.sku_id,locationId:row.location_id,quantityCosted:Number(row.quantity_units),physicalUnits:Number(row.physical_units),
 costedUnits:Number(row.costed_units_after),totalCostMinor:Number(row.cost_minor_after),journalEntryId:row.journal_entry_id,replayed};}
async function verify(client,ctx,outcome,payload){
 const row=(await client.query('SELECT * FROM accounting_inventory_cost_establishments WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,outcome?.costEstablishmentId])).rows[0];
 if(!row||row.payload_hash!==hash(payload)||row.sku_id!==payload.skuId||row.location_id!==payload.locationId)return false;
 // Verify the immutable effect, not that stock remains forever at its prior
 // value. A later legitimate sale/transfer must not invalidate this receipt.
 // Live position equality is separately checked inside the write transaction.
 if(Number(row.quantity_units)!==payload.quantity||Number(row.total_cost_minor)!==payload.totalCostMinor||row.currency!==payload.currency||row.basis!==payload.basis
  ||outcome.physicalUnits!==Number(row.physical_units)||outcome.costedUnits!==Number(row.costed_units_after)||outcome.totalCostMinor!==Number(row.cost_minor_after))return false;
 if(Number(row.total_cost_minor)===0)return row.journal_entry_id===null;
 const journal=(await client.query(`SELECT COALESCE(sum(jl.debit_minor-jl.credit_minor) FILTER(WHERE a.system_key='INVENTORY_ASSET'),0) AS inventory,
  COALESCE(sum(jl.credit_minor-jl.debit_minor) FILTER(WHERE a.system_key=$3),0) AS offset,
  sum(jl.debit_minor)-sum(jl.credit_minor) AS difference FROM accounting_journal_lines jl
  JOIN accounting_accounts a ON a.workspace_id=jl.workspace_id AND a.id=jl.account_id
  JOIN accounting_journal_entries je ON je.workspace_id=jl.workspace_id AND je.id=jl.entry_id AND je.status='POSTED'
  WHERE jl.workspace_id=$1 AND jl.entry_id=$2`,[ctx.workspaceId,row.journal_entry_id,BASES[row.basis].account])).rows[0];
 return Number(journal.inventory)===Number(row.total_cost_minor)&&Number(journal.offset)===Number(row.total_cost_minor)&&Number(journal.difference)===0;
}
module.exports={BASES,preview,prepare,prepareFromArgs,establishInTransaction,verify};
