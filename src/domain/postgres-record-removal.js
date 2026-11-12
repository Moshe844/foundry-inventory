'use strict';
// One way to delete any record. A record nothing else refers to is erased.
// A record with history (orders, invoices, stock movements, an import that
// created it) cannot be erased without rewriting the books, so it is archived:
// hidden from lists, search and new choices, with its history intact. A
// product's remaining stock is written off first so the books stay true.
// What counts as history is read from the schema's protecting foreign keys,
// so a new kind of business record is covered without changing this file.
const crypto=require('node:crypto'),{ValidationError,NotFoundError,AuthorizationError}=require('./errors');
const {nowIso,newId}=require('../lib/util'),permissions=require('../actions/permissions'),writeoff=require('../accounting/postgres-stock-writeoff');

// Products with more stock positions than this are written off in the background.
const settings={backgroundPositions:1000};
const OPEN_SALES="('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')",OPEN_PURCHASES="('APPROVED','ORDERED','PARTIALLY_RECEIVED')";
const KINDS={
 customer:{table:'customers',noun:'customer',permission:permissions.OPERATE,archived:"record_state='ARCHIVED'",archive:"record_state='ARCHIVED'",href:id=>'/sales/customers/'+id,list:'/sales/customers'},
 supplier:{table:'suppliers',noun:'supplier',permission:permissions.MANAGE_SUPPLIERS,archived:"status='inactive'",archive:"status='inactive'",href:id=>'/suppliers/'+id,list:'/suppliers'},
 product:{table:'items',noun:'product',owner:true,archived:'is_active=0',archive:'is_active=0',children:{table:'skus',column:'item_id'},stock:true,href:id=>'/inventory/'+id,list:'/inventory'},
 import:{table:'import_plans',noun:'import',owner:true,href:id=>'/imports/'+id,list:'/imports'},
};
// Plain names for the records people recognise. Anything else is named from its table.
const LABELS={sales_orders:'sales orders',sales_quotations:'quotes',accounting_customer_invoices:'invoices',accounting_payments:'payments',
 accounting_supplier_bills:'supplier bills',accounting_supplier_credits:'supplier credits',purchase_orders:'purchase orders',purchase_order_lines:'purchase orders',
 purchase_order_receipt_lines:'purchase receipts',sales_order_lines:'sales orders',sales_shipment_lines:'shipments',supplier_communications:'messages',
 supplier_returns:'supplier returns',supplier_return_lines:'supplier returns',customer_return_lines:'customer returns',custody_agreements:'rental or consignment agreements',
 movements:'stock history',accounting_inventory_cost_movements:'stock history',accounting_inventory_cost_balances:'stock history',
 accounting_inventory_openings:'opening stock',import_catalogue_bindings:'an import',catalog_source_facts:'an import',inventory_transfer_lines:'transfers',
 inventory_count_lines:'stock counts',manufacturing_boms:'production recipes',manufacturing_material_uses:'production jobs',kit_components:'kits'};
const label=table=>LABELS[table.replace(/^.*\./,'')]||table.replace(/^.*\./,'').replace(/^accounting_|^stockchief_/,'').replace(/_/g,' ');

const protecting=new Map();
// Foreign keys that refuse deletion (RESTRICT / NO ACTION) mark history.
async function protectingReferences(db,table){
 if(protecting.has(table))return protecting.get(table);
 // scoped: the table has workspace_id, so (workspace_id, column) indexes apply.
 // indexed: a lookup by this column can use an index instead of reading the table.
 const rows=(await db.query(`SELECT c.conrelid::regclass::text AS tbl,a.attname AS col,w.attnum IS NOT NULL AS scoped,
   EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND (i.indkey[0]=k.child OR i.indkey[0]=w.attnum AND i.indkey[1]=k.child)) AS indexed
  FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey,c.confkey) AS k(child,parent)
  JOIN pg_attribute p ON p.attrelid=c.confrelid AND p.attnum=k.parent AND p.attname='id'
  JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.child
  LEFT JOIN pg_attribute w ON w.attrelid=c.conrelid AND w.attname='workspace_id' AND NOT w.attisdropped
  WHERE c.contype='f' AND c.confrelid=$1::regclass AND c.confdeltype IN ('r','a') ORDER BY 1,2`,[table])).rows;
 protecting.set(table,rows);return rows;
}
// Everyday history (stock movements, then the records people recognise) is
// checked first, and a few findings are enough both to decide and to explain.
// Only a record with no history pays for checking every protecting table.
// Unindexed links are read only when nothing else was found, to confirm that
// the record can really be erased; a record with history never pays for them.
const rank=ref=>{const base=ref.tbl.replace(/^.*\./,'');return base==='movements'?0:!ref.indexed?3:Object.hasOwn(LABELS,base)?1:2;};
async function historyOf(db,workspaceId,sources,limit=3){
 const checks=[];
 for(const {table,ids,extra=[]} of sources)if(ids.length)for(const ref of [...extra,...await protectingReferences(db,table)])checks.push({...ref,ids});
 checks.sort((a,b)=>rank(a)-rank(b));
 const found=new Set();
 for(const ref of checks){
  if(found.size>=limit||found.size&&!ref.indexed)break;if(found.has(label(ref.tbl)))continue;
  const quoted=ref.tbl.split('.').map(part=>'"'+part.replace(/"/g,'""')+'"').join('.');
  if((await db.query(`SELECT 1 FROM ${quoted} WHERE ${ref.scoped?'workspace_id=$2 AND ':''}"${ref.col}"=ANY($1::text[]) LIMIT 1`,ref.scoped?[ref.ids,workspaceId]:[ref.ids])).rows.length)found.add(label(ref.tbl));
 }
 return [...found];
}
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function list(items){return items.length<2?items.join(''):items.slice(0,-1).join(', ')+' and '+items.at(-1);}

function assertAllowed(user,kind){
 const k=Object.hasOwn(KINDS,kind)?KINDS[kind]:null;if(!k)throw new NotFoundError('That kind of record cannot be deleted here.');
 if(k.owner?user?.role!=='owner':!permissions.can(user,k.permission))throw new AuthorizationError(`Only ${k.owner?'an owner':'someone allowed to manage '+k.noun+'s'} can delete this ${k.noun}.`);
 return k;
}
async function currentActor(client,ctx,kind){
 const user=(await client.query('SELECT * FROM users WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.workspaceId,ctx.actorId])).rows[0];
 assertAllowed(user,kind);return user;
}
async function reviewedInTransaction(client,ctx,kind,id,expectedHash){
 const user=await currentActor(client,ctx,kind),fresh=await review(client,ctx,user,kind,id);
 if(!expectedHash||fresh.hash!==expectedHash)throw new ValidationError(`This ${fresh.noun} changed after you opened the review. Check it again before deleting.`);
 if(fresh.blockers.length)throw new ValidationError(fresh.blockers[0]);return fresh;
}

async function record(db,ctx,kind,id){
 const k=KINDS[kind],row=(await db.query(`SELECT * FROM ${k.table} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id])).rows[0];
 if(!row)throw new NotFoundError(`That ${k.noun} is not in this inventory.`);return row;
}

async function review(db,ctx,user,kind,id){
 const k=assertAllowed(user,kind);
 if(kind==='import')return reviewImport(db,ctx,id);
 const row=await record(db,ctx,kind,id),name=row.name||row.display_name||id;
 const out={kind,id,noun:k.noun,name,href:k.href(id),list:k.list,history:[],blockers:[],stock:null};
 const archived=(await db.query(`SELECT ${k.archived} AS archived FROM ${k.table} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id])).rows[0].archived;
 if(k.children){
  const childIds=(await db.query(`SELECT id FROM ${k.children.table} WHERE workspace_id=$1 AND ${k.children.column}=$2`,[ctx.workspaceId,id])).rows.map(r=>r.id);
  out.history=await historyOf(db,ctx.workspaceId,[{table:k.table,ids:[id]},{table:k.children.table,ids:childIds,extra:[{tbl:'movements',col:'sku_id',scoped:true,indexed:true}]}]);
  out.variants=childIds.length;
  if(k.stock){
   out.stock=await writeoff.summarize(db,ctx,childIds);
   if(out.stock.problem)out.blockers.push(out.stock.problem);
   const open=await openWork(db,ctx,childIds);if(open)out.blockers.push(open);
  }
 }else out.history=await historyOf(db,ctx.workspaceId,[{table:k.table,ids:[id]}]);
 out.outcome=out.history.length?(archived?'archived':'archive'):'erase';
 if(kind==='product'){const live=await liveRemoval(db,ctx,id,'product');if(live?.status==='FAILED')out.lastFailure=live.error;else if(live&&(live.status==='RUNNING'||archived))out.removal=live;}
 out.hash=digest({kind,id,history:out.history,stock:out.stock&&{positions:out.stock.positions,units:out.stock.units,value:out.stock.valueMinor},outcome:out.outcome});
 return out;
}

async function openWork(db,ctx,skuIds){
 if(!skuIds.length)return null;
 const sales=(await db.query(`SELECT o.order_number FROM sales_order_lines l JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
  WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND o.status IN ${OPEN_SALES} LIMIT 1`,[ctx.workspaceId,skuIds])).rows[0];
 if(sales)return `Open sales order ${sales.order_number} still needs this stock. Ship or cancel it first; nothing was removed.`;
 const purchase=(await db.query(`SELECT o.po_number FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
  WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND o.status IN ${OPEN_PURCHASES} LIMIT 1`,[ctx.workspaceId,skuIds])).rows[0];
 if(purchase)return `Open purchase order ${purchase.po_number} is still expecting this product. Receive or cancel it first; nothing was removed.`;
 const transfer=(await db.query(`SELECT t.transfer_number FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.workspace_id=l.workspace_id AND t.id=l.transfer_id
  WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND t.status IN ('APPROVED','PICKED','SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED')
   AND l.requested_quantity>l.received_quantity+l.lost_quantity+l.damaged_quantity+l.cancelled_quantity LIMIT 1`,[ctx.workspaceId,skuIds])).rows[0];
 if(transfer)return `Open transfer ${transfer.transfer_number} still needs this product. Resolve the transfer first; nothing was removed.`;
 const custody=(await db.query(`SELECT a.agreement_number FROM custody_lines l JOIN custody_agreements a ON a.workspace_id=l.workspace_id AND a.id=l.agreement_id
  WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND a.status='OPEN' AND (l.external_quantity>0 OR l.inspection_quantity>0) LIMIT 1`,[ctx.workspaceId,skuIds])).rows[0];
 if(custody)return `Rental or consignment agreement ${custody.agreement_number} still has outstanding goods. Resolve the agreement first; nothing was removed.`;
 const booking=(await db.query(`SELECT a.agreement_number FROM custody_booking_lines l JOIN custody_bookings b ON b.workspace_id=l.workspace_id AND b.id=l.booking_id
  JOIN custody_agreements a ON a.workspace_id=b.workspace_id AND a.id=b.agreement_id
  WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND a.status='OPEN' AND b.status='CONFIRMED' AND b.ends_at+make_interval(mins=>b.buffer_minutes)>now() LIMIT 1`,[ctx.workspaceId,skuIds])).rows[0];
 if(booking)return `Rental booking on ${booking.agreement_number} still needs this product. Resolve the booking first; nothing was removed.`;
 const production=(await db.query(`SELECT w.order_number FROM manufacturing_work_orders w JOIN manufacturing_boms b ON b.workspace_id=w.workspace_id AND b.id=w.bom_id
  WHERE w.workspace_id=$1 AND w.status IN ('DRAFT','IN_PROGRESS','RECOVERING') AND (b.output_sku_id=ANY($2::text[]) OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(b.definition->'components') component WHERE component->>'skuId'=ANY($2::text[]))) LIMIT 1`,[ctx.workspaceId,skuIds])).rows[0];
 if(production)return `Production work order ${production.order_number} still needs this product. Resolve the work order first; nothing was removed.`;
 return null;
}

async function archiveProductsInTransaction(client,ctx,itemIds,{debitAccountKey,reason,reference,sourceType,sourceRecordType,sourceRecordId}){
 await currentActor(client,ctx,'product');
 const skuIds=(await client.query('SELECT id FROM skus WHERE workspace_id=$1 AND item_id=ANY($2::text[]) ORDER BY id',[ctx.workspaceId,itemIds])).rows.map(r=>r.id);
 const open=await openWork(client,ctx,skuIds);if(open)throw new ValidationError(open);
 const removed=await writeoff.writeOffInTransaction(client,ctx,skuIds,{reasonCode:'correction',notes:reason,reference,debitAccountKey,sourceType,sourceRecordType,sourceRecordId,description:reason});
 const at=nowIso();
 await client.query('UPDATE items SET is_active=0,updated_at=$3 WHERE workspace_id=$1 AND id=ANY($2::text[]) AND is_active<>0',[ctx.workspaceId,itemIds,at]);
 await client.query('UPDATE skus SET is_active=0 WHERE workspace_id=$1 AND item_id=ANY($2::text[]) AND is_active<>0',[ctx.workspaceId,itemIds]);
 await client.query(`UPDATE attention_items SET status='RESOLVED',resolution_reason=$3,resolved_at=$4 WHERE workspace_id=$1 AND status IN ('OPEN','ACKNOWLEDGED') AND item_id=ANY($2::text[])`,
  [ctx.workspaceId,itemIds,'The product was deleted.',at]);
 return removed;
}

async function remove(db,ctx,user,kind,id,{expectedHash}={}){
 const k=assertAllowed(user,kind);
 if(kind==='import')return removeImport(db,ctx,user,id,{expectedHash});
 const current=await review(db,ctx,user,kind,id);
 if(kind==='product'&&current.removal?.status==='RUNNING')return {...current,outcome:'running',removalId:current.removal.id};
 if(!expectedHash||expectedHash!==current.hash)throw new ValidationError(`This ${k.noun} changed after you opened the review. Check it again before deleting.`);
 if(current.blockers.length)throw new ValidationError(current.blockers[0]);
 if(current.outcome==='erase'){
  try{await db.transaction(async client=>{await reviewedInTransaction(client,ctx,kind,id,expectedHash);return client.query(`DELETE FROM ${k.table} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);},{isolation:'SERIALIZABLE'});return {...current,outcome:'erased'};}
  // A record referenced since the review, or through a deeper link, is kept and archived instead.
  catch(error){if(error.code!=='23503')throw error;}
 }
 // A large product leaves the lists at once; its stock is written off in the
 // background, a chunk per transaction, with progress on the review page.
 if(kind==='product'&&current.stock.positions>settings.backgroundPositions){
  const removalId=newId('rmv');
  await db.transaction(async client=>{
   await reviewedInTransaction(client,ctx,kind,id,expectedHash);
   const previouslyInactiveSkuIds=(await client.query('SELECT id FROM skus WHERE workspace_id=$1 AND item_id=$2 AND is_active=0 ORDER BY id',[ctx.workspaceId,id])).rows.map(r=>r.id);
   await client.query(`INSERT INTO record_removals(id,workspace_id,kind,record_id,status,summary,progress,created_by_user_id,created_at) VALUES($1,$2,'product',$3,'RUNNING',$4,$5,$6,$7)`,
    [removalId,ctx.workspaceId,id,{name:current.name,variants:current.variants,positions:current.stock.positions,units:current.stock.units,valueMinor:current.stock.valueMinor,variantStatesRecorded:true,previouslyInactiveSkuIds},{positions:0,units:'0',valueMinor:0},ctx.actorId,nowIso()]);
   await client.query('UPDATE items SET is_active=0,updated_at=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,nowIso()]);
   await client.query('UPDATE skus SET is_active=0 WHERE workspace_id=$1 AND item_id=$2 AND is_active<>0',[ctx.workspaceId,id]);
   await require('../operations/postgres-job-queue').enqueue({query:(statement,values=[])=>client.query(statement,values),transaction:operation=>operation(client)},
    {workspaceId:ctx.workspaceId,kind:'records.remove-product',idempotencyKey:'remove-product:'+removalId,payload:{removalId,itemId:id,actorId:ctx.actorId},maxAttempts:5});
  },{isolation:'SERIALIZABLE'});
  return {...current,outcome:'running',removalId};
 }
 const removed=await db.transaction(async client=>{
  await reviewedInTransaction(client,ctx,kind,id,expectedHash);
  let stock=null;
  if(kind==='product')stock=await archiveProductsInTransaction(client,ctx,[id],{debitAccountKey:'INVENTORY_ADJUSTMENTS',reason:`Deleted product ${current.name}`,reference:current.name,sourceType:'inventory_count',sourceRecordType:'adjustment',sourceRecordId:id});
  else await client.query(`UPDATE ${k.table} SET ${k.archive},updated_at=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,nowIso()]);
  return stock;
 },{isolation:'SERIALIZABLE'});
 return {...current,outcome:'archived',removed};
}

// ---- Imports ---------------------------------------------------------------
// A saved import is undone by deleting the products it created (their stock
// leaves as a reversal of the opening balance it brought in). Changes it made
// to products that already existed stay: later work may depend on them.
async function createdItems(db,ctx,importId){
 return (await db.query(`SELECT DISTINCT r.item_id FROM import_rows r JOIN items i ON i.workspace_id=r.workspace_id AND i.id=r.item_id
  WHERE r.workspace_id=$1 AND r.import_id=$2 AND r.status='IMPORTED' AND r.item_id IS NOT NULL AND r.parsed::jsonb->>'existingItemId' IS NULL AND i.is_active=1 ORDER BY r.item_id`,[ctx.workspaceId,importId])).rows.map(r=>r.item_id);
}
async function liveRemoval(db,ctx,recordId,kind='import'){
 return (await db.query(`SELECT * FROM record_removals WHERE workspace_id=$1 AND kind=$3 AND record_id=$2 AND ($3='product' OR status<>'FAILED') ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId,recordId,kind])).rows[0]||null;
}
// Background write-off of one large deleted product (already archived).
async function runProductRemoval(job,database){
 const {removalId,itemId,actorId}=job.payload||{},ctx={workspaceId:job.workspaceId,actorId};
 const removal=(await database.query('SELECT * FROM record_removals WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,removalId])).rows[0];
 if(!removal||removal.status!=='RUNNING')return {skipped:true};
 const name=removal.summary?.name||itemId,skuIds=(await database.query('SELECT id FROM skus WHERE workspace_id=$1 AND item_id=$2 ORDER BY id',[ctx.workspaceId,itemId])).rows.map(r=>r.id);
 try{
  for(let i=0;i<skuIds.length;i+=writeoff.CHUNK){const chunk=skuIds.slice(i,i+writeoff.CHUNK);
   await database.transaction(async client=>{
    await currentActor(client,ctx,'product');const open=await openWork(client,ctx,chunk);if(open)throw new ValidationError(open);
    const removed=await writeoff.writeOffInTransaction(client,ctx,chunk,{reasonCode:'correction',notes:`Deleted product ${name}`,reference:name,debitAccountKey:'INVENTORY_ADJUSTMENTS',sourceType:'inventory_count',sourceRecordType:'adjustment',sourceRecordId:itemId,description:`Deleted product ${name}`});
    await client.query(`UPDATE record_removals SET progress=jsonb_build_object('positions',(progress->>'positions')::int+$3::int,'units',((progress->>'units')::numeric+$4::numeric)::text,'valueMinor',(progress->>'valueMinor')::bigint+$5::bigint)
     WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,removalId,removed.positions,removed.units,removed.valueMinor]);
   },{isolation:'SERIALIZABLE',retrySafe:true});
  }
  await database.query(`UPDATE attention_items SET status='RESOLVED',resolution_reason='The product was deleted.',resolved_at=$3 WHERE workspace_id=$1 AND status IN ('OPEN','ACKNOWLEDGED') AND item_id=$2`,[ctx.workspaceId,itemId,nowIso()]);
  await database.query(`UPDATE record_removals SET status='COMPLETED',completed_at=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,removalId,nowIso()]);
  return {completed:true};
 }catch(error){
  if(error instanceof ValidationError||error instanceof AuthorizationError||job.attemptCount>=job.maxAttempts){
   // The product comes back with whatever stock is left, so nothing is hidden half-removed.
   const known=removal.summary?.variantStatesRecorded===true&&Array.isArray(removal.summary.previouslyInactiveSkuIds)&&removal.summary.previouslyInactiveSkuIds.every(id=>typeof id==='string');
   const message=String(error.message)+(known?'':' The older deletion record did not retain variant states. Review its archived variants before making them available again.');
   await database.transaction(async client=>{
    await client.query(`UPDATE record_removals SET status='FAILED',error=$3,completed_at=$4 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,removalId,message.slice(0,500),nowIso()]);
    await client.query('UPDATE items SET is_active=1,updated_at=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,itemId,nowIso()]);
    if(known)await client.query('UPDATE skus SET is_active=CASE WHEN id=ANY($3::text[]) THEN 0 ELSE 1 END WHERE workspace_id=$1 AND item_id=$2',[ctx.workspaceId,itemId,removal.summary.previouslyInactiveSkuIds]);
   });
   return {failed:message};
  }
  throw error;
 }
}
async function importOpeningProblem(db,ctx,importId,skuIds){
 if(!skuIds.length)return null;
 // Only the original, fully costed opening movements belong to this reversal.
 // A closed later PO is no longer "open work", but its goods are still real.
 const changed=(await db.query(`SELECT 1 WHERE EXISTS(
  SELECT 1 FROM movements m
  LEFT JOIN accounting_inventory_cost_movements c ON c.workspace_id=m.workspace_id AND c.inventory_movement_id=m.id
  LEFT JOIN import_rows r ON r.workspace_id=c.workspace_id AND r.id=c.cost_source_record_id AND r.import_id=$2 AND r.status='IMPORTED'
  WHERE m.workspace_id=$1 AND m.sku_id=ANY($3::text[]) AND
   (c.id IS NULL OR c.cost_source_type<>'opening_inventory' OR r.id IS NULL OR NOT r.movement_ids::jsonb @> jsonb_build_array(m.id))
 ) OR EXISTS(SELECT 1 FROM accounting_inventory_value_adjustments WHERE workspace_id=$1 AND sku_id=ANY($3::text[]))
 OR EXISTS(SELECT 1 FROM accounting_inventory_openings WHERE workspace_id=$1 AND sku_id=ANY($3::text[]))`,[ctx.workspaceId,importId,skuIds])).rowCount;
 return changed?'Later stock work or cost changes use products from this import. Review those products separately; only the original opening stock can be reversed automatically.':null;
}
async function importOpeningProblem(db,ctx,importId,skuIds){
 if(!skuIds.length)return null;
 // Only the original, fully costed opening movements belong to this reversal.
 // A closed later PO is no longer "open work", but its goods are still real.
 const changed=(await db.query(`SELECT 1 WHERE EXISTS(
  SELECT 1 FROM movements m
  LEFT JOIN accounting_inventory_cost_movements c ON c.workspace_id=m.workspace_id AND c.inventory_movement_id=m.id
  LEFT JOIN import_rows r ON r.workspace_id=c.workspace_id AND r.id=c.cost_source_record_id AND r.import_id=$2 AND r.status='IMPORTED'
  WHERE m.workspace_id=$1 AND m.sku_id=ANY($3::text[]) AND
   (c.id IS NULL OR c.cost_source_type<>'opening_inventory' OR r.id IS NULL OR NOT r.movement_ids::jsonb @> jsonb_build_array(m.id))
 ) OR EXISTS(SELECT 1 FROM accounting_inventory_value_adjustments WHERE workspace_id=$1 AND sku_id=ANY($3::text[]))
 OR EXISTS(SELECT 1 FROM accounting_inventory_openings WHERE workspace_id=$1 AND sku_id=ANY($3::text[]))`,[ctx.workspaceId,importId,skuIds])).rowCount;
 return changed?'Later stock work or cost changes use products from this import. Review those products separately; only the original opening stock can be reversed automatically.':null;
}
async function reviewImport(db,ctx,id){
 const plan=await record(db,ctx,'import',id),removal=await liveRemoval(db,ctx,id);
 const out={kind:'import',id,noun:'import',name:plan.source_name||'Import',href:'/imports/'+id,list:'/imports',blockers:[],removal,history:[]};
 const saved=(await db.query(`SELECT count(*) FILTER(WHERE status='IMPORTED')::int AS imported,count(*) FILTER(WHERE status='IMPORTED' AND parsed::jsonb->>'existingItemId' IS NOT NULL)::int AS existing
  FROM import_rows WHERE workspace_id=$1 AND import_id=$2`,[ctx.workspaceId,id])).rows[0];
 const running=plan.status==='EXECUTING'||(await db.query(`SELECT 1 FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='import.execute-approved' AND payload->>'planId'=$2 AND status IN ('PENDING','RETRY','RUNNING') LIMIT 1`,[ctx.workspaceId,id])).rows.length>0;
 if(running)out.blockers.push('This import is still saving. Wait for it to finish, then delete it.');
 out.existingRows=saved.existing;
 if(!saved.imported){out.outcome='erase';}
 else{
  const items=await createdItems(db,ctx,id),skuIds=items.length?(await db.query('SELECT id FROM skus WHERE workspace_id=$1 AND item_id=ANY($2::text[])',[ctx.workspaceId,items])).rows.map(r=>r.id):[];
  out.outcome='undo';out.products=items.length;out.variants=skuIds.length;out.stock=await writeoff.summarize(db,ctx,skuIds);
  if(out.stock.problem)out.blockers.push(out.stock.problem);
  const open=await openWork(db,ctx,skuIds);if(open)out.blockers.push(open);
  const changed=await importOpeningProblem(db,ctx,id,skuIds);if(changed)out.blockers.push(changed);
 }
 out.hash=digest({kind:'import',id,outcome:out.outcome,products:out.products,stock:out.stock&&{positions:out.stock.positions,units:out.stock.units,value:out.stock.valueMinor},existing:out.existingRows});
 return out;
}
async function removeImport(db,ctx,user,id,{expectedHash}){
 const current=await reviewImport(db,ctx,id);
 if(current.removal)return {...current,outcome:current.removal.status==='COMPLETED'?'removed':'running'};
 if(!expectedHash||expectedHash!==current.hash)throw new ValidationError('This import changed after you opened the review. Check it again before deleting.');
 if(current.blockers.length)throw new ValidationError(current.blockers[0]);
 if(current.outcome==='erase'){
  try{await db.transaction(async client=>{await reviewedInTransaction(client,ctx,'import',id,expectedHash);return client.query('DELETE FROM import_plans WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);},{isolation:'SERIALIZABLE'});return {...current,outcome:'erased'};}
  catch(error){if(error.code!=='23503')throw error;}
  await db.transaction(async client=>{await reviewedInTransaction(client,ctx,'import',id,expectedHash);await client.query(`INSERT INTO record_removals(id,workspace_id,kind,record_id,status,summary,created_by_user_id,created_at,completed_at) VALUES($1,$2,'import',$3,'COMPLETED',$4,$5,$6,$6)`,
   [newId('rmv'),ctx.workspaceId,id,{hidden:true},ctx.actorId,nowIso()]);},{isolation:'SERIALIZABLE'});
  return {...current,outcome:'removed'};
 }
 const removalId=newId('rmv'),at=nowIso();
 await db.transaction(async client=>{
  await reviewedInTransaction(client,ctx,'import',id,expectedHash);
  await client.query(`INSERT INTO record_removals(id,workspace_id,kind,record_id,status,summary,progress,created_by_user_id,created_at) VALUES($1,$2,'import',$3,'RUNNING',$4,$5,$6,$7)`,
   [removalId,ctx.workspaceId,id,{products:current.products,variants:current.variants,units:current.stock.units,valueMinor:current.stock.valueMinor,existingRows:current.existingRows},{products:0,units:'0',valueMinor:0,skipped:[]},ctx.actorId,at]);
  // The job commits with its removal record or not at all.
  await require('../operations/postgres-job-queue').enqueue({query:(statement,values=[])=>client.query(statement,values),transaction:operation=>operation(client)},
   {workspaceId:ctx.workspaceId,kind:'records.remove-import',idempotencyKey:'remove-import:'+removalId,payload:{removalId,importId:id,actorId:ctx.actorId},maxAttempts:5});
 },{isolation:'SERIALIZABLE'});
 return {...current,outcome:'running',removalId};
}

// Background: one transaction per group of products, so progress is durable
// and a restart continues with the products still active.
async function runImportRemoval(job,database){
 const {removalId,importId,actorId}=job.payload||{},ctx={workspaceId:job.workspaceId,actorId};
 const removal=(await database.query('SELECT * FROM record_removals WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,removalId])).rows[0];
 if(!removal||removal.status!=='RUNNING')return {skipped:true};
 const plan=await record(database,ctx,'import',importId),items=await createdItems(database,ctx,importId);
 const sizes=new Map((await database.query('SELECT item_id,count(*)::int n FROM skus WHERE workspace_id=$1 AND item_id=ANY($2::text[]) GROUP BY item_id',[ctx.workspaceId,items])).rows.map(r=>[r.item_id,r.n]));
 const groups=[];let group=[],size=0;
 for(const item of items){const n=sizes.get(item)||1;if(group.length&&size+n>writeoff.CHUNK){groups.push(group);group=[];size=0;}group.push(item);size+=n;}
 if(group.length)groups.push(group);
 const reason=`Removed products created by import ${plan.source_name||importId}`;
 try{
  for(const itemIds of groups){
   await database.transaction(async client=>{
    const skuIds=(await client.query('SELECT id FROM skus WHERE workspace_id=$1 AND item_id=ANY($2::text[])',[ctx.workspaceId,itemIds])).rows.map(r=>r.id);
    const changed=await importOpeningProblem(client,ctx,importId,skuIds);if(changed)throw new ValidationError(changed);
    const open=await openWork(client,ctx,skuIds);let removed={positions:0,units:'0',valueMinor:0},done=itemIds,skipped=[];
    if(open){done=[];skipped=itemIds;}
    else removed=await archiveProductsInTransaction(client,ctx,itemIds,{debitAccountKey:'OPENING_BALANCE_EQUITY',reason,reference:plan.source_name,sourceType:'inventory_count',sourceRecordType:'adjustment',sourceRecordId:importId});
    await client.query(`UPDATE record_removals SET progress=jsonb_build_object('products',(progress->>'products')::int+$3::int,
      'units',((progress->>'units')::numeric+$4::numeric)::text,'valueMinor',(progress->>'valueMinor')::bigint+$5::bigint,'skipped',(progress->'skipped')||$6::jsonb)
     WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,removalId,done.length,removed.units,removed.valueMinor,JSON.stringify(skipped.slice(0,50))]);
   },{isolation:'SERIALIZABLE',retrySafe:true});
  }
  await database.query(`UPDATE record_removals SET status='COMPLETED',completed_at=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,removalId,nowIso()]);
  return {completed:true};
 }catch(error){
  if(error instanceof ValidationError||error instanceof AuthorizationError||job.attemptCount>=job.maxAttempts){
   await database.query(`UPDATE record_removals SET status='FAILED',error=$3,completed_at=$4 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,removalId,String(error.message).slice(0,500),nowIso()]);
   return {failed:error.message};
  }
  throw error;
 }
}
async function importRemoval(db,ctx,importId){return liveRemoval(db,ctx,importId);}

module.exports={KINDS,settings,review,remove,runImportRemoval,runProductRemoval,importRemoval,protectingReferences,label,openWork};
