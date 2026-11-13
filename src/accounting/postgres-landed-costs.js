'use strict';
const P=require('../actions/permissions'),policy=require('../commercial/agent-plan'),money=require('../domain/currency');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors'),{newId,nowIso}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions'),calculator=require('../pricing/calculator');
const methods=new Set(['quantity','value','weight']),categories=new Set(['freight','duty','insurance','handling','other']);
const formIntents=new WeakMap();
async function actor(db,ctx,{write=false}={}){
 const u=(await db.query(`SELECT u.role,u.permissions FROM users u JOIN workspaces w ON w.id=u.workspace_id
  WHERE u.workspace_id=$1 AND u.id=$2 AND w.deletion_requested_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) FOR SHARE OF u`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(u?.role!=='owner')throw new AuthorizationError('Only the inventory owner can approve these stock-cost allocations.');
 P.assertCan(u,P.ALLOCATE_LANDED_COST,'allocate freight, duty and fees');P.assertCan(u,P.MANAGE_ACCOUNTING,'change recorded stock cost');
 if(write)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
 await policy.requireWorkspaceJob(db,ctx.workspaceId,49,'draft');
 const settings=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
 if(!settings)throw new ValidationError('Set up the accounting currency before allocating received-goods costs.');
 return settings.base_currency;
}
function amount(value,label){const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw new ValidationError(label+' must be a positive exact amount.');return n;}
function total(values){const n=values.reduce((sum,value)=>sum+BigInt(value),0n);if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<0n)throw new ValidationError('The allocation total exceeds the exact accounting range.');return Number(n);}
async function receiptFacts(db,ctx,receiptIds,purchaseOrderId,{lock=false}={}){
 if(!Array.isArray(receiptIds)||receiptIds.some(id=>typeof id!=='string'||!id||id.length>160))throw new ValidationError('Choose recorded deliveries from this inventory.');
 const ids=[...new Set(receiptIds)];if(!ids.length||ids.length>20)throw new ValidationError('Choose one to 20 recorded deliveries on the same purchase order.');
 const expected=Number((await db.query('SELECT count(*) n FROM purchase_order_receipt_lines WHERE workspace_id=$1 AND receipt_id=ANY($2::text[])',[ctx.workspaceId,ids])).rows[0].n);
 const rows=(await db.query(`SELECT l.id,l.receipt_id,l.sku_id,l.location_id,l.quantity_units::text quantity,r.received_at,r.purchase_order_id,
  s.code,s.item_id,i.name,i.tracking_mode,i.quantity_precision,i.secondary_unit_label,loc.name location_name,
  u.unit_weight_grams,
  cost.quantity::text costed_quantity,cost.amount::text original_cost,cost.first_seq::text first_seq,cost.proven_cost
  FROM purchase_order_receipt_lines l JOIN purchase_order_receipts r ON r.workspace_id=l.workspace_id AND r.id=l.receipt_id
  JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id AND s.is_active=1
  JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
  JOIN locations loc ON loc.workspace_id=l.workspace_id AND loc.id=l.location_id AND loc.is_active=1 AND loc.custody_agreement_id IS NULL
  JOIN accounting_settings settings ON settings.workspace_id=l.workspace_id AND settings.enabled=1
  LEFT JOIN sku_uom_profiles u ON u.workspace_id=s.workspace_id AND u.sku_id=s.id
  LEFT JOIN LATERAL(SELECT sum(c.quantity_delta) quantity,sum(c.cost_delta_minor) amount,min(m.seq) first_seq,
   bool_and(c.cost_delta_minor=0 OR coalesce(e.status='POSTED'
    AND EXISTS(SELECT 1 FROM accounting_journal_lines asset JOIN accounting_accounts a ON a.workspace_id=asset.workspace_id AND a.id=asset.account_id AND a.system_key='INVENTORY_ASSET'
      WHERE asset.workspace_id=c.workspace_id AND asset.entry_id=e.id AND asset.sku_id=c.sku_id AND asset.location_id=c.location_id AND asset.debit_minor=c.cost_delta_minor AND asset.credit_minor=0 AND asset.currency=settings.base_currency)
    AND NOT EXISTS(SELECT 1 FROM accounting_journal_lines foreign_line WHERE foreign_line.workspace_id=e.workspace_id AND foreign_line.entry_id=e.id AND foreign_line.currency<>settings.base_currency)
    AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries reversed WHERE reversed.workspace_id=e.workspace_id AND reversed.reversal_of_entry_id=e.id AND reversed.status='POSTED'),false)) proven_cost
   FROM jsonb_array_elements_text(l.movement_ids::jsonb) a(id)
   JOIN movements m ON m.workspace_id=l.workspace_id AND m.id=a.id AND m.sku_id=l.sku_id AND m.location_id=l.location_id AND m.quantity_delta>0 AND m.operation='receive'
   JOIN accounting_inventory_cost_movements c ON c.workspace_id=m.workspace_id AND c.inventory_movement_id=m.id
    AND c.cost_source_type='purchase_order_receipt' AND c.cost_source_record_id=r.id
   LEFT JOIN accounting_journal_entries e ON e.workspace_id=c.workspace_id AND e.id=c.journal_entry_id)cost ON true
  WHERE l.workspace_id=$1 AND l.receipt_id=ANY($2::text[]) ORDER BY l.id LIMIT 101`,[ctx.workspaceId,ids])).rows;
 if(!rows.length||rows.length!==expected||rows.length>100||new Set(rows.map(r=>r.receipt_id)).size!==ids.length||rows.some(r=>r.purchase_order_id!==purchaseOrderId))throw new ValidationError('Choose up to 100 received product lines from the selected purchase order. Every selected delivery must have its stock and cost evidence.');
 for(const r of rows){
  r.quantity=amount(r.quantity,'Received units');
  if(r.tracking_mode!=='quantity'||Number(r.quantity_precision)!==0||r.secondary_unit_label||r.proven_cost!==true||Number(r.costed_quantity)!==r.quantity||r.first_seq==null||!Number.isSafeInteger(Number(r.original_cost))||Number(r.original_cost)<0)throw new ValidationError('Review lots, serials, measured goods and deliveries without complete recorded purchase cost individually.');
  r.original_cost=Number(r.original_cost);
 }
 const positions=[...new Map(rows.map(r=>[JSON.stringify([r.sku_id,r.location_id]),{sku_id:r.sku_id,location_id:r.location_id}])).values()];
 const found=(await db.query(`SELECT b.sku_id,b.location_id,b.on_hand::text physical,c.quantity_units::text costed,c.total_cost_minor::text value
  FROM balances b JOIN jsonb_to_recordset($2::jsonb) p(sku_id text,location_id text) ON p.sku_id=b.sku_id AND p.location_id=b.location_id
  JOIN accounting_inventory_cost_balances c ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id
  WHERE b.workspace_id=$1 ORDER BY b.sku_id,b.location_id ${lock?'FOR UPDATE OF b,c':''}`,[ctx.workspaceId,JSON.stringify(positions)])).rows;
 const byPosition=new Map(found.map(r=>[JSON.stringify([r.sku_id,r.location_id]),r]));
 for(const r of rows){
  const b=byPosition.get(JSON.stringify([r.sku_id,r.location_id])),required=rows.filter(l=>l.sku_id===r.sku_id&&l.location_id===r.location_id).reduce((n,l)=>n+l.quantity,0);
  if(!b||!Number.isSafeInteger(Number(b.physical))||!Number.isSafeInteger(Number(b.value))||Number(b.value)<0||Number(b.physical)!==Number(b.costed)||Number(b.physical)<required)throw new ValidationError('The received goods no longer have complete stock and purchase cost at their original location. Review the accounting adjustment individually.');
 }
 const moved=(await db.query(`SELECT 1 FROM movements m JOIN jsonb_to_recordset($2::jsonb) s(sku_id text,location_id text,first_seq bigint)
   ON s.sku_id=m.sku_id AND s.location_id=m.location_id AND m.seq>s.first_seq
   WHERE m.workspace_id=$1 AND m.quantity_delta<0 LIMIT 1`,[ctx.workspaceId,JSON.stringify(rows.map(r=>({sku_id:r.sku_id,location_id:r.location_id,first_seq:r.first_seq})))])).rowCount;
 if(moved)throw new ValidationError('Goods were sold, moved or reduced after this delivery. Review the stock and past cost-of-sales allocation with your accountant before applying these charges.');
 return {lines:rows.map(r=>({receiptLineId:r.id,receiptId:r.receipt_id,skuId:r.sku_id,itemId:r.item_id,sku:r.code,product:r.name,locationId:r.location_id,location:r.location_name,quantity:r.quantity,originalCostMinor:r.original_cost,weightGrams:r.unit_weight_grams==null?null:Number(r.unit_weight_grams),firstSequence:r.first_seq})),positions:found};
}
async function chargeFacts(db,ctx,charges,currency,documentId=null,{lock=false}={}){
 if(!Array.isArray(charges)||!charges.length||charges.length>20||charges.some(c=>!c||typeof c!=='object'||typeof c.sourceBillLineId!=='string'||!c.sourceBillLineId||c.sourceBillLineId.length>160)||new Set(charges.map(c=>c.sourceBillLineId)).size!==charges.length)throw new ValidationError('Choose one to 20 different posted freight, duty or fee bill lines.');
 const out=[];
 for(const raw of [...charges].sort((a,b)=>a.sourceBillLineId<b.sourceBillLineId?-1:1)){
  const n=amount(raw.amountMinor,'Additional stock cost');if(!categories.has(raw.category))throw new ValidationError('Choose freight, duty, insurance, handling or an individually reviewed other cost.');
  const b=(await db.query(`SELECT l.*,b.bill_number,b.supplier_id,b.currency,b.status bill_status,b.journal_entry_id,
    a.account_type,a.name account_name,j.id source_journal_line_id,j.debit_minor,j.credit_minor,e.status entry_status,j.currency journal_currency
    FROM accounting_supplier_bill_lines l JOIN accounting_supplier_bills b ON b.workspace_id=l.workspace_id AND b.id=l.bill_id
    JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.debit_account_id AND a.active=1
    JOIN accounting_journal_entries e ON e.workspace_id=b.workspace_id AND e.id=b.journal_entry_id
    JOIN accounting_journal_lines j ON j.workspace_id=e.workspace_id AND j.entry_id=e.id AND j.line_number=l.line_number
      AND j.account_id=l.debit_account_id AND j.debit_minor=l.line_total_minor AND j.credit_minor=0
    WHERE l.workspace_id=$1 AND l.id=$2 AND NOT EXISTS(SELECT 1 FROM accounting_journal_lines foreign_line WHERE foreign_line.workspace_id=e.workspace_id AND foreign_line.entry_id=e.id AND foreign_line.currency<>b.currency) ${lock?'FOR UPDATE OF j':''}`,[ctx.workspaceId,raw.sourceBillLineId])).rows[0];
  if(!b||!['OPEN','PARTIALLY_PAID','PAID'].includes(b.bill_status)||b.entry_status!=='POSTED'||b.account_type!=='EXPENSE'||b.currency!==currency||b.journal_currency!==currency||n>Number(b.line_total_minor))throw new ValidationError('Choose an exact posted expense line in the accounting currency. Already-capitalized stock lines, recoverable tax, unpaid drafts and mismatched journal evidence cannot fund another stock cost.');
  if((await db.query("SELECT 1 FROM accounting_journal_entries WHERE workspace_id=$1 AND reversal_of_entry_id=$2 AND status='POSTED'",[ctx.workspaceId,b.journal_entry_id])).rowCount)throw new ValidationError('The source expense has been reversed. Choose current posted cost evidence.');
  const used=(await db.query(`SELECT (SELECT coalesce(sum(abs(c.amount_minor)),0) FROM landed_cost_charges c JOIN landed_cost_documents d ON d.workspace_id=c.workspace_id AND d.id=c.document_id
    WHERE c.workspace_id=$1 AND (c.source_bill_line_id=$2 OR c.source_journal_line_id=$3) AND d.status NOT IN ('VOID','REVERSED') AND ($4::text IS NULL OR d.id<>$4))
    +(SELECT coalesce(sum(amount_minor),0) FROM manufacturing_added_costs WHERE workspace_id=$1 AND source_journal_line_id=$3 AND reversed_by_event_id IS NULL) amount`,[ctx.workspaceId,b.id,b.source_journal_line_id,documentId])).rows[0];
  if(Number(used.amount)+n>Number(b.debit_minor))throw new ValidationError('This expense is already assigned to stock, another cost draft or production. Choose only its unallocated amount.');
  out.push({sourceBillLineId:b.id,sourceJournalLineId:b.source_journal_line_id,billId:b.bill_id,billNumber:b.bill_number,supplierId:b.supplier_id,accountId:b.debit_account_id,accountName:b.account_name,description:b.description,category:raw.category,amountMinor:n,sourceAmountMinor:Number(b.line_total_minor),journalEntryId:b.journal_entry_id});
 }
 return out;
}
function allocation(lines,charges,method){
 if(!methods.has(method))throw new ValidationError('Choose allocation by received units, original recorded value or recorded unit weight.');
 const weights=lines.map(l=>method==='quantity'?l.quantity:method==='value'?l.originalCostMinor:(()=>{if(!Number.isSafeInteger(l.weightGrams)||l.weightGrams<1)throw new ValidationError('Record the actual unit weight for '+l.sku+' before allocating by weight.');const w=BigInt(l.quantity)*BigInt(l.weightGrams);if(w>BigInt(Number.MAX_SAFE_INTEGER))throw new ValidationError('The recorded allocation weight exceeds the exact range.');return Number(w);})());
 return charges.flatMap((charge,index)=>calculator.allocate(charge.amountMinor,weights).map((amountMinor,i)=>({...lines[i],chargeIndex:index,basis:weights[i],amountMinor})));
}
async function document(db,ctx,id){
 await actor(db,ctx);const doc=(await db.query('SELECT d.*,po.po_number FROM landed_cost_documents d LEFT JOIN purchase_orders po ON po.workspace_id=d.workspace_id AND po.id=d.purchase_order_id WHERE d.workspace_id=$1 AND d.id=$2',[ctx.workspaceId,id])).rows[0];if(!doc)throw new NotFoundError('That received-goods cost allocation is not in this inventory.');
 const receipts=(await db.query('SELECT r.id FROM landed_cost_document_receipts x JOIN purchase_order_receipts r ON r.id=x.receipt_id AND r.workspace_id=$1 WHERE x.document_id=$2 ORDER BY r.id',[ctx.workspaceId,id])).rows.map(r=>r.id),charges=(await db.query(`SELECT c.*,b.id bill_id,b.bill_number FROM landed_cost_charges c LEFT JOIN accounting_supplier_bill_lines l ON l.workspace_id=c.workspace_id AND l.id=c.source_bill_line_id LEFT JOIN accounting_supplier_bills b ON b.workspace_id=l.workspace_id AND b.id=l.bill_id WHERE c.workspace_id=$1 AND c.document_id=$2 ORDER BY c.source_bill_line_id`,[ctx.workspaceId,id])).rows;
 return {...doc,receiptIds:receipts,charges};
}
async function preview(db,ctx,id,{lock=false}={}){
 const doc=await document(db,ctx,id);if(!['DRAFT','APPROVED'].includes(doc.status))throw new ValidationError('Choose a current draft cost allocation.');
 const stock=await receiptFacts(db,ctx,doc.receiptIds,doc.purchase_order_id,{lock}),charges=await chargeFacts(db,ctx,doc.charges.map(c=>({sourceBillLineId:c.source_bill_line_id,amountMinor:Number(c.amount_minor),category:c.category})),doc.currency,id,{lock}),allocations=allocation(stock.lines,charges,doc.allocation_method),totalMinor=total(charges.map(c=>c.amountMinor));
 const source={documentId:id,purchaseOrderId:doc.purchase_order_id,currency:doc.currency,method:doc.allocation_method,...stock,charges,allocations,totalMinor};
 return {document:doc,source,fingerprint:hash(source)};
}
async function createDraft(db,ctx,input){return db.transaction(async c=>{
 const currency=await actor(c,ctx,{write:true}),key=String(input.requestKey||'');if(!key||key.length>160)throw new ValidationError('Open a fresh allocation form before preparing these costs.');
 const requestHash=formIntents.get(input)||hash({purchaseOrderId:input.purchaseOrderId,receiptIds:[...new Set(input.receiptIds||[])].sort(),charges:input.charges,method:input.method});
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['landed-cost-request:'+ctx.workspaceId+':'+key]);
 const prior=(await c.query('SELECT id,request_hash FROM landed_cost_documents WHERE workspace_id=$1 AND request_key=$2',[ctx.workspaceId,key])).rows[0];if(prior){if(prior.request_hash!==requestHash)throw new ValidationError('That form already prepared different receipt or charge evidence. Open a new form.');return {id:prior.id,replayed:true};}
 const stock=await receiptFacts(c,ctx,input.receiptIds,input.purchaseOrderId),charges=await chargeFacts(c,ctx,input.charges,currency,null,{lock:true});allocation(stock.lines,charges,input.method);
 const id=newId('landed-cost'),at=nowIso(),number=await require('../operations/postgres-business-numbers').next(c,ctx.workspaceId,'landed_cost_documents','LC');
 await c.query(`INSERT INTO landed_cost_documents(id,workspace_id,document_number,purchase_order_id,allocation_method,status,currency,created_by_user_id,created_at,updated_at,request_key,request_hash)
  VALUES($1,$2,$3,$4,$5,'DRAFT',$6,$7,$8,$8,$9,$10)`,[id,ctx.workspaceId,number,input.purchaseOrderId,input.method,currency,ctx.actorId,at,key,requestHash]);
 for(const receipt of [...new Set(stock.lines.map(l=>l.receiptId))])await c.query('INSERT INTO landed_cost_document_receipts(document_id,receipt_id) VALUES($1,$2)',[id,receipt]);
 for(const charge of charges)await c.query(`INSERT INTO landed_cost_charges(id,workspace_id,document_id,category,description,amount_minor,source_bill_line_id,source_journal_line_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[newId('landed-charge'),ctx.workspaceId,id,charge.category,charge.description,charge.amountMinor,charge.sourceBillLineId,charge.sourceJournalLineId,at]);
 return {id,replayed:false};
},{isolation:'SERIALIZABLE',retrySafe:true});}
function training(source){
 const qualification=[source.method,...source.lines.map(l=>[l.skuId,l.locationId]).sort(),...source.charges.map(c=>[c.supplierId,c.accountId,c.category,c.description]).sort()];
 return require('../autopilot/draft-authority').scope('landed-costs',source.currency,source.totalMinor,qualification,'Received-goods costs · '+source.method+' allocation · '+[...new Set(source.lines.map(l=>l.sku))].join(', '));
}
async function build(db,ctx,row){
 const p=await preview(db,ctx,row.id);
 return {payload:{recordId:row.id,source:p.source,fingerprint:p.fingerprint,training:training(p.source),needsLandedCostConfirmation:p.source.charges.some(c=>c.category==='other')},
  summary:'Add '+money.format(p.source.totalMinor,p.source.currency)+' of recorded freight, duty or fees to the stock cost on '+p.document.document_number+' using '+p.source.method+' allocation. Move the existing fee from expenses into stock cost. Quantities, supplier balances and payments stay the same.'};
}
async function adjustValues(db,ctx,documentId,allocations,journalId,{reverse=false}={}){
 const positions=new Map();for(const a of allocations){const key=JSON.stringify([a.skuId,a.locationId]),p=positions.get(key)||{skuId:a.skuId,locationId:a.locationId,amount:0};p.amount+=(reverse?-a.amountMinor:a.amountMinor);if(!Number.isSafeInteger(p.amount))throw new ValidationError('The stock-cost adjustment exceeds the exact range.');positions.set(key,p);}
 for(const p of [...positions.values()].sort((a,b)=>JSON.stringify([a.skuId,a.locationId])<JSON.stringify([b.skuId,b.locationId])?-1:1)){
  if(!p.amount)continue;
  const before=(await db.query('SELECT * FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE',[ctx.workspaceId,p.skuId,p.locationId])).rows[0];
  const after=before&&money.integer(Number(before.total_cost_minor)+p.amount);if(!before||Number(before.quantity_units)<=0||after<0)throw new ValidationError('The remaining recorded stock cost cannot cover this adjustment. Review it individually.');
  await db.query('UPDATE accounting_inventory_cost_balances SET total_cost_minor=$4,updated_at=$5 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,p.skuId,p.locationId,after,nowIso()]);
  await db.query(`INSERT INTO accounting_inventory_value_adjustments(id,workspace_id,sku_id,location_id,amount_delta_minor,quantity_units,source_type,source_record_id,journal_entry_id,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[newId('landed-value'),ctx.workspaceId,p.skuId,p.locationId,p.amount,before.quantity_units,reverse?'landed_cost_reversal':'landed_cost_document',documentId,journalId,nowIso()]);
 }
}
// routine: the job 49 bill routine (agent-landed-cost-bills.js) has already checked
// its own taught supplier and cost-type limit inside this transaction. Every other
// plan, mode, pause, shadow and evidence check below still applies to it.
async function applyInTransaction(db,ctx,p,{routine=null}={}){
 await actor(db,ctx,{write:true});
 const doc=(await db.query('SELECT * FROM landed_cost_documents WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,p.recordId])).rows[0];if(!doc)throw new NotFoundError('That cost allocation is not in this inventory.');
 if(doc.status==='APPLIED'){if(doc.approval_hash!==p.fingerprint)throw new ValidationError('This allocation was applied from different approved evidence.');return {documentId:doc.id,documentNumber:doc.document_number,currency:doc.currency,journalEntryId:doc.applied_journal_entry_id,replayed:true};}
 const automatic=Boolean(routine)||ctx.agentLandedCostScope==='automatic',state=await policy.accountState(db,ctx.workspaceId);
 const taught=routine?routine.trained===true:automatic&&await require('../autopilot/draft-authority').trained(db,ctx.workspaceId,'landed_cost.apply',p);
 policy.requireJob(state.plan,49,automatic?'automatic':'draft',{trained:taught});
 const stop=await policy.stopped(db,ctx.workspaceId,state,'landed_cost.apply',automatic,p);if(stop)throw new ValidationError(stop);
 if(automatic){
  await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
  if(!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate||p.needsLandedCostConfirmation)throw new ValidationError('Approve this cost allocation individually or enable its qualified routine authority.');
 }
 if(automatic&&!routine){
  const rule=(await db.query('SELECT maximum_minor,authorized_by FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3 AND currency=$4 FOR SHARE',[ctx.workspaceId,'landed_cost.apply',p.training.key,p.training.currency])).rows[0];
  if(state.plan==='pro'&&(!rule||!(await db.query("SELECT 1 FROM users u WHERE workspace_id=$1 AND id=$2 AND role='owner' AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) FOR SHARE OF u",[ctx.workspaceId,rule.authorized_by])).rowCount))throw new ValidationError('The taught owner scope is no longer authorized. Approve this allocation individually.');
  if(rule&&Number(rule.maximum_minor)<p.training.amountMinor)throw new ValidationError('This additional cost exceeds the saved owner limit. Approve it individually.');
 }
 const fresh=await preview(db,ctx,p.recordId,{lock:true});if(fresh.fingerprint!==p.fingerprint)throw new ValidationError('The receipt cost, available goods, source expense or allocation changed. Review a fresh stock-cost approval.');
 if(hash(training(fresh.source))!==hash(p.training))throw new ValidationError('The additional-cost amount or taught scope differs from its recorded source. Review a fresh approval.');
 // Job 205: over the owner's amount, two people approve the posting, whichever path posts it.
 await require('../autopilot/two-person-approval').assertLandedCost(db,ctx,p);
 for(const [index,charge] of fresh.source.charges.entries())await db.query('UPDATE landed_cost_charges SET source_journal_line_id=$3 WHERE workspace_id=$1 AND id=$2 AND source_journal_line_id IS NULL',[ctx.workspaceId,fresh.document.charges[index].id,charge.sourceJournalLineId]);
 const ledger=require('./postgres-ledger'),lines=[];
 for(const a of fresh.source.allocations)if(a.amountMinor)lines.push({accountKey:'INVENTORY_ASSET',debitMinor:a.amountMinor,itemId:a.itemId,skuId:a.skuId,locationId:a.locationId,memo:'Received-goods cost '+doc.document_number});
 for(const charge of fresh.source.charges)lines.push({accountId:charge.accountId,creditMinor:charge.amountMinor,supplierId:charge.supplierId,memo:'Reclassify '+charge.billNumber+' · '+charge.description});
 const posted=await ledger.postInTransaction(db,ctx,{sourceKey:'landed-cost:'+doc.id,sourceType:'landed_cost_document',sourceRecordType:'landed_cost_document',sourceRecordId:doc.id,currency:doc.currency,description:'Received-goods cost '+doc.document_number,lines});
 if(posted.replayed)throw new ValidationError('The allocation has a posting without its completed stock-cost record. Review that history before proceeding.');
 for(const a of fresh.source.allocations)if(a.amountMinor)await db.query(`INSERT INTO landed_cost_allocations(id,workspace_id,document_id,charge_id,receipt_line_id,sku_id,location_id,basis_value,amount_minor,accounting_journal_entry_id,created_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[newId('landed-allocation'),ctx.workspaceId,doc.id,fresh.document.charges[a.chargeIndex].id,a.receiptLineId,a.skuId,a.locationId,a.basis,a.amountMinor,posted.entry.id,nowIso()]);
 await adjustValues(db,ctx,doc.id,fresh.source.allocations,posted.entry.id);
 for(const before of fresh.source.positions){
  const after=(await db.query('SELECT b.on_hand::text physical,c.quantity_units::text costed,c.total_cost_minor::text value FROM balances b JOIN accounting_inventory_cost_balances c ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id WHERE b.workspace_id=$1 AND b.sku_id=$2 AND b.location_id=$3',[ctx.workspaceId,before.sku_id,before.location_id])).rows[0],added=total(fresh.source.allocations.filter(a=>a.skuId===before.sku_id&&a.locationId===before.location_id).map(a=>a.amountMinor));
  if(!after||Number(after.physical)!==Number(before.physical)||Number(after.costed)!==Number(before.costed)||Number(after.value)!==money.integer(Number(before.value)+added))throw new ValidationError('The stock-cost change did not preserve its physical quantities and exact recorded value. Nothing was committed.');
 }
 await db.query("UPDATE landed_cost_documents SET status='APPLIED',approved_by_user_id=$3,approved_at=$4,applied_at=$4,updated_at=$4,approval_hash=$5,applied_journal_entry_id=$6,applied_automatically=$7 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,doc.id,ctx.actorId,nowIso(),p.fingerprint,posted.entry.id,automatic]);
 await require('../operations/postgres-security-audit').record(db,ctx,{action:'Received-goods costs applied',reference:doc.document_number,after:{currency:doc.currency,additionalCostMinor:fresh.source.totalMinor,quantityUnchanged:true,supplierBalanceUnchanged:true}});
 return {documentId:doc.id,documentNumber:doc.document_number,currency:doc.currency,journalEntryId:posted.entry.id,additionalCostMinor:fresh.source.totalMinor,automatic,replayed:false};
}
async function apply(db,ctx,p){return db.transaction(c=>applyInTransaction(c,ctx,p),{isolation:'SERIALIZABLE',retrySafe:true});}
async function reverse(db,ctx,id,input){return db.transaction(async c=>{
 await actor(c,ctx,{write:true});if(input.confirmed!=='yes')throw new ValidationError('Confirm reversal of this exact stock-cost allocation.');
 const doc=(await c.query('SELECT * FROM landed_cost_documents WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];if(!doc)throw new NotFoundError('That cost allocation is not in this inventory.');if(doc.status==='REVERSED')return {documentId:id,journalEntryId:doc.reversal_journal_entry_id,replayed:true};if(doc.status!=='APPLIED'||!doc.applied_journal_entry_id)throw new ValidationError('Choose an applied cost allocation with its recorded posting evidence.');
 const saved=await document(c,ctx,id);await receiptFacts(c,ctx,saved.receiptIds,doc.purchase_order_id,{lock:true});
 const allocations=(await c.query('SELECT sku_id AS "skuId",location_id AS "locationId",amount_minor AS "amountMinor" FROM landed_cost_allocations WHERE workspace_id=$1 AND document_id=$2 ORDER BY id',[ctx.workspaceId,id])).rows.map(r=>({...r,amountMinor:Number(r.amountMinor)}));
 const lines=(await c.query('SELECT * FROM accounting_journal_lines WHERE workspace_id=$1 AND entry_id=$2 ORDER BY line_number FOR UPDATE',[ctx.workspaceId,doc.applied_journal_entry_id])).rows;
 const posted=await require('./postgres-ledger').postInTransaction(c,ctx,require('./landed-cost-ownership').reversal({sourceKey:'landed-cost-reversal:'+id,sourceType:'landed_cost_reversal',sourceRecordType:'landed_cost_document',sourceRecordId:id,currency:doc.currency,reversalOfEntryId:doc.applied_journal_entry_id,description:'Reverse received-goods cost '+doc.document_number,lines:lines.map(l=>({accountId:l.account_id,debitMinor:Number(l.credit_minor),creditMinor:Number(l.debit_minor),itemId:l.item_id,skuId:l.sku_id,locationId:l.location_id,supplierId:l.supplier_id,memo:'Reverse '+doc.document_number}))}));
 await adjustValues(c,ctx,id,allocations,posted.entry.id,{reverse:true});await c.query("UPDATE landed_cost_documents SET status='REVERSED',reversed_at=$3,updated_at=$3,reversal_journal_entry_id=$4 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,nowIso(),posted.entry.id]);
 return {documentId:id,journalEntryId:posted.entry.id,replayed:false};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function verify(db,ctx,r,p){
 const d=(await db.query("SELECT * FROM landed_cost_documents WHERE workspace_id=$1 AND id=$2 AND status='APPLIED' AND approval_hash=$3 AND applied_journal_entry_id=$4",[ctx.workspaceId,p.recordId,p.fingerprint,r.journalEntryId])).rows[0];if(!d||r.documentId!==d.id)return false;
 const saved=(await db.query(`SELECT (SELECT coalesce(sum(amount_minor),0) FROM landed_cost_allocations WHERE workspace_id=$1 AND document_id=$2 AND accounting_journal_entry_id=$3) allocated,
  (SELECT coalesce(sum(amount_delta_minor),0) FROM accounting_inventory_value_adjustments WHERE workspace_id=$1 AND source_type='landed_cost_document' AND source_record_id=$2 AND journal_entry_id=$3) value,
  (SELECT coalesce(sum(l.debit_minor-l.credit_minor),0) FROM accounting_journal_lines l JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id WHERE l.workspace_id=$1 AND l.entry_id=$3 AND a.system_key='INVENTORY_ASSET') asset`,[ctx.workspaceId,d.id,r.journalEntryId])).rows[0];
 return [saved.allocated,saved.value,saved.asset].every(n=>Number(n)===p.source.totalMinor);
}
async function voidDraft(db,ctx,id){return db.transaction(async c=>{await actor(c,ctx,{write:true});const d=(await c.query('SELECT status FROM landed_cost_documents WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];if(!d)throw new NotFoundError('That cost allocation is not in this inventory.');if(d.status==='VOID')return {replayed:true};if(!['DRAFT','APPROVED'].includes(d.status))throw new ValidationError('Only a draft cost allocation can be discarded. An applied allocation needs its recorded reversal.');await c.query("UPDATE landed_cost_documents SET status='VOID',updated_at=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,nowIso()]);return {replayed:false};},{isolation:'SERIALIZABLE',retrySafe:true});}
async function sources(db,ctx,{receiptSearch='',expenseSearch=''}={}){
 const currency=await actor(db,ctx);receiptSearch=String(receiptSearch).trim();expenseSearch=String(expenseSearch).trim();if(receiptSearch.length>120||expenseSearch.length>120)throw new ValidationError('Search with a PO, delivery reference, fee bill number or expense description up to 120 characters.');
 const receipts=(await db.query(`SELECT r.id,r.received_at,r.reference,po.po_number FROM purchase_order_receipts r JOIN purchase_orders po ON po.workspace_id=r.workspace_id AND po.id=r.purchase_order_id
  WHERE r.workspace_id=$1 AND po.currency=$2 AND ($3='' OR po.po_number ILIKE '%'||$3||'%' OR r.reference ILIKE '%'||$3||'%') ORDER BY r.received_at DESC,r.id DESC LIMIT 51`,[ctx.workspaceId,currency,receiptSearch])).rows;
 const expenses=(await db.query(`WITH candidates AS MATERIALIZED (
  SELECT l.id,l.description,l.line_total_minor,b.bill_number,j.id journal_line_id FROM accounting_supplier_bill_lines l
  JOIN accounting_supplier_bills b ON b.workspace_id=l.workspace_id AND b.id=l.bill_id AND b.status IN ('OPEN','PARTIALLY_PAID','PAID') AND b.currency=$2
  JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.debit_account_id AND a.account_type='EXPENSE' AND a.active=1
  JOIN accounting_journal_entries e ON e.workspace_id=b.workspace_id AND e.id=b.journal_entry_id AND e.status='POSTED'
  JOIN accounting_journal_lines j ON j.workspace_id=e.workspace_id AND j.entry_id=e.id AND j.line_number=l.line_number AND j.account_id=l.debit_account_id AND j.debit_minor=l.line_total_minor AND j.credit_minor=0
  WHERE l.workspace_id=$1 AND ($3='' OR b.bill_number ILIKE '%'||$3||'%' OR l.description ILIKE '%'||$3||'%')
   AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries x WHERE x.workspace_id=e.workspace_id AND x.reversal_of_entry_id=e.id AND x.status='POSTED')
  ORDER BY b.created_at DESC,l.id DESC LIMIT 51)
  SELECT x.*,(x.line_total_minor-(SELECT coalesce(sum(abs(c.amount_minor)),0) FROM landed_cost_charges c JOIN landed_cost_documents d ON d.workspace_id=c.workspace_id AND d.id=c.document_id
   WHERE c.workspace_id=$1 AND (c.source_bill_line_id=x.id OR c.source_journal_line_id=x.journal_line_id) AND d.status NOT IN ('VOID','REVERSED'))
   -(SELECT coalesce(sum(amount_minor),0) FROM manufacturing_added_costs m WHERE m.workspace_id=$1 AND m.source_journal_line_id=x.journal_line_id AND m.reversed_by_event_id IS NULL))::text available_minor FROM candidates x`,[ctx.workspaceId,currency,expenseSearch])).rows;
 const {timeZone}=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId),clock=new Intl.DateTimeFormat('en-US',{timeZone,dateStyle:'medium',timeStyle:'short'});
 return {currency,receipts:receipts.slice(0,50).map(r=>({...r,receivedLabel:clock.format(new Date(r.received_at))})),expenses:expenses.slice(0,50).filter(e=>Number(e.available_minor)>0),receiptMore:receipts.length>50,expenseMore:expenses.length>50,receiptSearch,expenseSearch,requestKey:newId('landed-form')};
}
async function prepareForm(db,ctx,input){
 const currency=await actor(db,ctx),receipts=Array.isArray(input.receipts)?input.receipts:[input.receipts].filter(Boolean),key=String(input.requestKey||'');if(!key||key.length>160)throw new ValidationError('Open a fresh allocation form before preparing these costs.');
 const explicit=String(input.amount??'').trim()?money.userToMinor(input.amount,currency):null,intent=hash({receiptIds:[...new Set(receipts)].sort(),expense:input.expense,amount:explicit,category:input.category,method:input.method}),prior=(await db.query('SELECT id,request_hash FROM landed_cost_documents WHERE workspace_id=$1 AND request_key=$2',[ctx.workspaceId,key])).rows[0];
 if(prior){if(prior.request_hash!==intent)throw new ValidationError('This form already prepared different source records, amount or allocation choices. Open a new form.');return {id:prior.id,replayed:true};}
 const first=receipts.length?(await db.query('SELECT purchase_order_id FROM purchase_order_receipts WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,receipts[0]])).rows[0]:null;
 if(!first)throw new ValidationError('Choose at least one recorded delivery from this inventory.');
 const expense=(await db.query(`SELECT l.line_total_minor,j.id journal_line_id FROM accounting_supplier_bill_lines l JOIN accounting_supplier_bills b ON b.workspace_id=l.workspace_id AND b.id=l.bill_id
  JOIN accounting_journal_lines j ON j.workspace_id=b.workspace_id AND j.entry_id=b.journal_entry_id AND j.line_number=l.line_number AND j.account_id=l.debit_account_id AND j.debit_minor=l.line_total_minor AND j.credit_minor=0
  WHERE l.workspace_id=$1 AND l.id=$2`,[ctx.workspaceId,input.expense])).rows[0];if(!expense)throw new ValidationError('Choose an exact posted fee bill line.');
 let n;if(explicit!==null)n=explicit;else{
  const used=(await db.query(`SELECT (SELECT coalesce(sum(abs(c.amount_minor)),0) FROM landed_cost_charges c JOIN landed_cost_documents d ON d.workspace_id=c.workspace_id AND d.id=c.document_id WHERE c.workspace_id=$1 AND (c.source_bill_line_id=$2 OR c.source_journal_line_id=$3) AND d.status NOT IN ('VOID','REVERSED'))
   +(SELECT coalesce(sum(amount_minor),0) FROM manufacturing_added_costs m WHERE m.workspace_id=$1 AND m.source_journal_line_id=$3 AND m.reversed_by_event_id IS NULL) amount`,[ctx.workspaceId,input.expense,expense.journal_line_id])).rows[0];n=Number(expense.line_total_minor)-Number(used.amount);
 }
 const draft={purchaseOrderId:first.purchase_order_id,receiptIds:receipts,charges:[{sourceBillLineId:input.expense,amountMinor:n,category:input.category}],method:input.method,requestKey:key};formIntents.set(draft,intent);return createDraft(db,ctx,draft);
}
async function review(db,ctx,{page=1,filter=''}){
 await actor(db,ctx);const rows=(await db.query(`SELECT d.id,d.document_number,d.status,d.currency,d.allocation_method,po.po_number,(SELECT coalesce(sum(amount_minor),0)::text FROM landed_cost_charges c WHERE c.workspace_id=d.workspace_id AND c.document_id=d.id) additional
  FROM landed_cost_documents d LEFT JOIN purchase_orders po ON po.workspace_id=d.workspace_id AND po.id=d.purchase_order_id WHERE d.workspace_id=$1 AND ($2='' OR d.document_number ILIKE '%'||$2||'%' OR po.po_number ILIKE '%'||$2||'%')
  ORDER BY d.created_at DESC,d.id DESC LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 return {summary:'Allocate posted freight, duty and fees to received stock using exact quantities, original recorded cost or recorded weight. A bill posted for a delivery is split on its own within your limit for that supplier and cost type. Goods sold or moved since receipt need individual accounting review. No stock quantities, payables or payments change.',
  rows:rows.slice(0,100).map(r=>({Allocation:r.document_number,'Purchase order':r.po_number||'Recorded deliveries',Status:r.status,Method:r.allocation_method,'Additional cost':money.format(Number(r.additional),r.currency),link:'/autopilot/landed-costs/'+r.id})),more:rows.length>100,landedCostForm:{}};
}
async function page(db,ctx,id){
 const doc=await document(db,ctx,id);let ready=null,problem=null,reverseReason=null;
 if(['DRAFT','APPROVED'].includes(doc.status)){try{ready=await preview(db,ctx,id);}catch(error){if(error.code!=='validation_error')throw error;problem=error.message;}}
 if(doc.status==='APPLIED'){if(!doc.applied_journal_entry_id)reverseReason='This older cost allocation needs an accounting review before another change.';else try{await receiptFacts(db,ctx,doc.receiptIds,doc.purchase_order_id);}catch(error){if(error.code!=='validation_error')throw error;reverseReason=error.message;}}
 const allocations=(await db.query(`SELECT a.amount_minor,s.code,i.name,l.name location_name FROM landed_cost_allocations a JOIN skus s ON s.workspace_id=a.workspace_id AND s.id=a.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id JOIN locations l ON l.workspace_id=a.workspace_id AND l.id=a.location_id WHERE a.workspace_id=$1 AND a.document_id=$2 ORDER BY s.code,a.id`,[ctx.workspaceId,id])).rows;
 const state=await policy.accountState(db,ctx.workspaceId),stopped=await policy.stopped(db,ctx.workspaceId,state,'landed_cost.apply',false,{});
 const historical=doc.charges.reduce((sum,c)=>sum+BigInt(c.amount_minor),0n);if(historical>BigInt(Number.MAX_SAFE_INTEGER)||historical<BigInt(Number.MIN_SAFE_INTEGER))throw new ValidationError('Review the recorded cost amount range.');
 return {document:doc,ready,problem,reverseReason,allocations,stopped,totalMinor:Number(historical)};
}
async function reservedExpenseForProduction(db,workspaceId,source){
 const row=(await db.query(`SELECT
  (SELECT coalesce(sum(amount_minor),0) FROM manufacturing_added_costs WHERE workspace_id=$1 AND source_journal_line_id=$2 AND reversed_by_event_id IS NULL)
  +(SELECT coalesce(sum(abs(c.amount_minor)),0) FROM landed_cost_charges c JOIN landed_cost_documents d ON d.workspace_id=c.workspace_id AND d.id=c.document_id WHERE c.workspace_id=$1 AND c.source_journal_line_id=$2 AND d.status NOT IN ('VOID','REVERSED'))
  +CASE WHEN EXISTS(SELECT 1 FROM landed_cost_charges c JOIN landed_cost_documents d ON d.workspace_id=c.workspace_id AND d.id=c.document_id
    JOIN accounting_supplier_bill_lines l ON l.workspace_id=c.workspace_id AND l.id=c.source_bill_line_id JOIN accounting_supplier_bills b ON b.workspace_id=l.workspace_id AND b.id=l.bill_id
    WHERE c.workspace_id=$1 AND c.source_journal_line_id IS NULL AND d.status NOT IN ('VOID','REVERSED') AND b.journal_entry_id=$3 AND l.debit_account_id=$4) THEN $5::bigint ELSE 0 END amount`,[workspaceId,source.id,source.entry_id,source.account_id,source.debit_minor])).rows[0];
 return money.integer(row.amount,'Already assigned expense');
}
module.exports={createDraft,document,preview,allocation,build,apply,applyInTransaction,reverse,verify,voidDraft,sources,prepareForm,page,reservedExpenseForProduction,receiptFacts,
 definition:{id:49,key:'landed-costs',label:'Allocate freight, duty and fees to received stock',filterLabel:'Allocation number or PO',readPage:review},
 spec:{name:'landed_cost.apply',agentJob:49,record:'landed_cost_document',fields:['recordReference'],permission:P.ALLOCATE_LANDED_COST,ownerOnly:true,capability:'accounting.core',description:'Apply one existing reviewed draft freight, duty or fee allocation to wholly retained received quantity goods. Reclassifies exact posted expense evidence into inventory value without changing stock quantity, supplier balances or payments. Pro needs a taught exact source/product/location/method and additional-cost cap; Custom honors saved limits. Other costs need individual confirmation. Sold, moved, lot, serial, measured or missing-cost stock needs separate review.',build,execute:applyInTransaction,verify,
 resultReference:'documentId',resultDisplayReference:'documentNumber',resultRecordKind:'landed_cost_document',resultingRecords:['landed_cost_documents','landed_cost_allocations','accounting_inventory_value_adjustments','accounting_journal_entries']}};
