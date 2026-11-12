'use strict';
// Job 42: blanket purchase orders. A reviewed supplier contract fixes the
// products, prices, total units (and optionally a total value), dates and a
// release schedule. Each release becomes a real PO on its date, adjusted to
// real demand within the agreed range, and never past the contract's totals
// or dates. Pro drafts until taught; taught Pro and Custom place the release
// and queue the supplier email within the purchasing limits.
const {newId}=require('../lib/util'),{hash}=require('../pricing/postgres-promotions');
const policy=require('../commercial/agent-plan'),money=require('../domain/currency');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {addDays}=require('../accounting/customer-money');
const contracts='stockchief_runtime.agent_blanket_contracts',releases='stockchief_runtime.agent_blanket_releases';
const kind='purchasing.blanket-release.v1',action='purchasing.prepare_blanket_release';
const PLACED=['APPROVED','ORDERED','PLACED','PARTIALLY_RECEIVED','RECEIVED'];
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
const held=e=>[400,402,403,404,409,422].includes(e?.status)||['validation_error','entitlement_required','forbidden','not_found'].includes(e?.code);
async function owner(c,ctx,accountLock=false){
 if(!(await c.query("SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) FOR SHARE OF u,w",[ctx.workspaceId,ctx.actorId])).rowCount)throw new AuthorizationError('Only the current inventory owner can authorize supplier contract releases.');
 await require('../operations/postgres-warehouse-access').assertInventoryWide(c,ctx);
 if(accountLock)await c.query('SELECT a.id FROM accounts a JOIN workspaces w ON w.owner_account_id=a.id WHERE w.id=$1 FOR UPDATE OF a',[ctx.workspaceId]);
}
// Preparing work for a person: the plan must include the job, and shadow,
// Watch only and a job set to Watch only refuse.
async function access(c,ctx){
 await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
 const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,42,'draft');
 await require('../commercial/enforcement').workspace(c,ctx.workspaceId,'inventory.core');
 await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
 const reason=await policy.stopped(c,ctx.workspaceId,state,action,false);
 if(reason)throw new ValidationError(reason);
 return state;
}
function integer(v,label,min=1,max=1000000000){
 const n=Number(v);
 if(!Number.isSafeInteger(n)||n<min||n>max)throw new ValidationError(label+' must be a whole number from '+min+' to '+max+'.');
 return n;
}
function date(v){
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T12:00:00Z'))||new Date(v+'T12:00:00Z').toISOString().slice(0,10)!==v)throw new ValidationError('Choose a real calendar date.');
 return v;
}
function reference(v){
 if(typeof v!=='string'||!v.trim()||v.trim().length>100||/[\u0000-\u001f\u007f<>]/.test(v))throw new ValidationError('Enter the supplier contract reference on one plain line, up to 100 characters.');
 return v.trim();
}
function sum(lines){
 const n=lines.reduce((v,l)=>v+BigInt(l.quantityUnits)*BigInt(l.unitCostMinor),0n);
 if(n>1000000000000n)throw new ValidationError('This contract exceeds the supported goods-value limit.');
 return Number(n);
}
async function get(c,ctx,id,lock=false){
 const p=(await c.query('SELECT * FROM '+contracts+' WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
 if(!p)throw new NotFoundError('That supplier contract is not in this inventory.');
 return p;
}
async function release(c,ctx,id,lock=false){
 const r=(await c.query('SELECT * FROM '+releases+' WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
 if(!r)throw new NotFoundError('That contract release is not in this inventory.');
 return r;
}
async function input(c,ctx,value){
 const currency=money.code(value.currency||'USD');
 let lines=value.lines;
 if(!lines){
  const text=String(value.linesText||'').replace(/^﻿/,'');
  if(text.length>100000)throw new ValidationError('Keep a supplier contract to 100 product rows.');
  const parser=require('../imports/parser'),rows=parser.parseDelimited(text,text.includes('\t')?'\t':',').filter(r=>r.some(v=>String(v).trim()));
  if(rows.length<2||rows.length>101||rows[0].map(v=>v.trim().toLowerCase()).join(',')!=='sku,total_units,release_units,unit_price')throw new ValidationError('Use the headers SKU,total_units,release_units,unit_price and one to 100 product rows.');
  lines=rows.slice(1).map(r=>{if(r.length!==4)throw new ValidationError('Each contract row needs exactly four columns.');return {sku:r[0].trim(),totalUnits:r[1].trim(),releaseUnits:r[2].trim(),unitPrice:r[3].trim()};});
 }
 if(!Array.isArray(lines)||!lines.length||lines.length>100)throw new ValidationError('Choose one to 100 distinct whole-unit products.');
 const codes=lines.map(l=>String(l.sku||'').trim());
 if(codes.some(v=>!v||v.length>240||/[\u0000-\u001f\u007f]/.test(v))||new Set(codes).size!==codes.length)throw new ValidationError('Use distinct exact SKU codes, up to 240 characters each.');
 const rows=(await c.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND code=ANY($2::text[])',[ctx.workspaceId,codes])).rows,byCode=new Map(rows.map(r=>[r.code,r.id]));
 if(rows.length!==codes.length)throw new ValidationError('Match every contract product to this inventory.');
 const first=date(value.firstRelease),last=date(value.lastRelease),today=await require('../lib/business-time').today(c,ctx.workspaceId);
 if(first<addDays(today,-366)||first>addDays(today,366)||last<first||last>addDays(first,366))throw new ValidationError('Use a contract schedule within one year, starting no more than one year before or after today.');
 const valueLimit=String(value.valueLimit??'').trim()?money.userToMinor(String(value.valueLimit),currency,{label:'Contract total value'}):null;
 if(valueLimit!==null&&!(valueLimit>0))throw new ValidationError('Enter a contract total value above zero, or leave it empty.');
 return {supplier_id:String(value.supplierId||''),destination_id:String(value.destinationId||''),reference:reference(value.reference),currency,first_release:first,last_release:last,
  interval_days:integer(value.intervalDays,'Days between releases',1,365),lead_days:integer(value.leadDays??0,'Expected delivery lead time',0,365),
  value_limit_minor:valueLimit,flex_percent:integer(String(value.flexPercent??'').trim()||0,'How much each release may move with demand (%)',0,100),
  line_terms:lines.map((l,i)=>({skuId:byCode.get(codes[i]),sku:codes[i],totalUnits:integer(l.totalUnits,'Contract units'),releaseUnits:integer(l.releaseUnits,'Units per release'),unitCostMinor:money.userToMinor(String(l.unitPrice),currency,{label:'Agreed unit price'})})).sort((a,b)=>a.skuId.localeCompare(b.skuId))};
}
async function facts(c,ctx,p){
 const supplier=(await c.query("SELECT id,name,status,currency,minimum_order_amount::text,default_lead_time_days FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,p.supplier_id])).rows[0];
 if(!supplier||supplier.currency!==p.currency)throw new ValidationError('Choose an active supplier in the agreed currency.');
 const place=(await c.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,p.destination_id])).rows[0];
 if(!place)throw new ValidationError('Choose an active internal receiving location.');
 const rows=(await c.query("SELECT s.id,s.code,i.name,i.unit_label,si.id AS supplier_item_id,si.is_active AS linked_active,si.units_per_purchase_unit,si.purchase_unit,si.minimum_order_quantity,si.order_multiple,si.last_unit_cost::text FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id LEFT JOIN supplier_items si ON si.workspace_id=s.workspace_id AND si.sku_id=s.id AND si.supplier_id=$3 WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 AND i.tracking_mode='quantity' AND i.quantity_precision=0 AND i.secondary_unit_label IS NULL AND NOT EXISTS(SELECT 1 FROM kit_components k WHERE k.workspace_id=s.workspace_id AND k.kit_sku_id=s.id) ORDER BY s.id",[ctx.workspaceId,p.line_terms.map(l=>l.skuId),p.supplier_id])).rows;
 if(rows.length!==p.line_terms.length)throw new ValidationError('Review missing products, kits or tracked/measured goods separately.');
 const currentPrices=await require('../pricing/postgres-service').listForSkus(c,ctx.workspaceId,p.line_terms.map(l=>l.skuId));
 const products=rows.map(r=>{
  const term=p.line_terms.find(l=>l.skuId===r.id),pack=integer(r.units_per_purchase_unit??1,'Recorded supplier pack size');
  if(r.linked_active===0)throw new ValidationError('This supplier product relationship is inactive.');
  let price;
  if(r.last_unit_cost!==null)price=money.userToMinor(r.last_unit_cost,p.currency,{label:'Current supplier unit price'});
  else{const cost=currentPrices.get(r.id)?.purchaseCost;if(cost?.amount_minor==null||cost.currency!==p.currency)throw new ValidationError('Confirm a current purchase price in the agreed currency for every product.');price=cost.amount_minor;}
  if(r.code!==term.sku)throw new ValidationError('The recorded code '+term.sku+' changed to '+r.code+'. Review the product before preparing a release.');
  if(price!==term.unitCostMinor)throw new ValidationError(r.code+' has a current purchase-price basis of '+money.format(price,p.currency)+', while this contract uses '+money.format(term.unitCostMinor,p.currency)+'. Review the agreement before preparing more releases.');
  if(term.totalUnits%pack||term.releaseUnits%pack)throw new ValidationError('Contract and release units must be exact recorded supplier packs.');
  return {skuId:r.id,sku:r.code,name:r.name,unit:r.unit_label,unitCostMinor:price,pack,purchaseUnit:r.purchase_unit||'unit',
   minimumPacks:integer(r.minimum_order_quantity??1,'Supplier minimum pack quantity'),multiplePacks:integer(r.order_multiple??1,'Supplier pack multiple')};
 });
 const minimum= supplier.minimum_order_amount==null?0:money.userToMinor(supplier.minimum_order_amount,p.currency,{label:'Supplier minimum order value'});
 const source={supplier,place,products,minimumOrderMinor:minimum};
 return {...source,signature:hash(source)};
}
function scheduleRows(p,f){
 const remaining=new Map(p.line_terms.map(l=>[l.skuId,l.totalUnits])),schedule=[];
 for(let day=p.first_release;day<=p.last_release&&[...remaining.values()].some(v=>v>0);day=addDays(day,p.interval_days)){
  if(schedule.length>=52)throw new ValidationError('Keep one contract to 52 releases. Increase units per release or split the reviewed schedule.');
  const lines=p.line_terms.map(l=>{const quantityUnits=Math.min(l.releaseUnits,remaining.get(l.skuId));remaining.set(l.skuId,remaining.get(l.skuId)-quantityUnits);return {...l,quantityUnits};}).filter(l=>l.quantityUnits>0);
  for(const l of lines){const product=f.products.find(x=>x.skuId===l.skuId),packs=l.quantityUnits/product.pack;if(packs<product.minimumPacks||packs%product.multiplePacks)throw new ValidationError('A scheduled release would break the recorded supplier pack minimum or multiple. Review the contract quantities.');}
  const value=sum(lines);
  if(value<f.minimumOrderMinor)throw new ValidationError('A scheduled release is below the supplier minimum order value. Adjust this contract; no extra products were added.');
  schedule.push({releaseDate:day,expectedDate:addDays(day,p.lead_days),lines,goodsValueMinor:value});
 }
 if([...remaining.values()].some(v=>v>0))throw new ValidationError('The selected dates do not release the full contract quantity. Review the end date or units per release.');
 return schedule;
}
async function preview(db,ctx,value){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,42,'draft');
 const p=await input(db,ctx,value),f=await facts(db,ctx,p),schedule=scheduleRows(p,f);
 return {scope:p,source:f,schedule,goodsValueMinor:sum(p.line_terms.map(l=>({...l,quantityUnits:l.totalUnits}))),sourceHash:hash({scope:p,source:f,schedule})};
}
async function save(db,ctx,value){
 return tx(db,async c=>{
  await owner(c,ctx,true);await access(c,ctx);
  const v=await preview(c,ctx,value);
  if(value.confirmed!=='yes'||value.sourceHash!==v.sourceHash)throw new ValidationError('Review and approve these exact supplier terms, product quantities and release dates before saving.');
  const prior=(await c.query('SELECT id,source_hash FROM '+contracts+' WHERE workspace_id=$1 AND supplier_id=$2 AND lower(reference)=lower($3)',[ctx.workspaceId,v.scope.supplier_id,v.scope.reference])).rows[0];
  if(prior){if(prior.source_hash===v.sourceHash)return {id:prior.id,replayed:true};throw new ValidationError('This supplier contract reference already exists. Review its saved releases rather than creating a duplicate.');}
  const id=newId('blanket-contract'),p=v.scope;
  await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'blanket-contract:'+id,Buffer.byteLength(JSON.stringify(v))*3+32768,{finished:true});
  await c.query('INSERT INTO '+contracts+'(id,workspace_id,supplier_id,destination_id,reference,currency,first_release,last_release,interval_days,lead_days,line_terms,goods_value_minor,source_snapshot,source_hash,authorized_by,value_limit_minor,flex_percent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15,$16,$17)',[id,ctx.workspaceId,p.supplier_id,p.destination_id,p.reference,p.currency,p.first_release,p.last_release,p.interval_days,p.lead_days,JSON.stringify(p.line_terms),v.goodsValueMinor,JSON.stringify(v.source),v.sourceHash,ctx.actorId,p.value_limit_minor,p.flex_percent]);
  for(const slot of v.schedule)await c.query('INSERT INTO '+releases+'(id,workspace_id,contract_id,release_date,expected_date,lines,scheduled_lines,goods_value_minor) VALUES($1,$2,$3,$4,$5,$6::jsonb,$6::jsonb,$7)',[newId('blanket-release'),ctx.workspaceId,id,slot.releaseDate,slot.expectedDate,JSON.stringify(slot.lines),slot.goodsValueMinor]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier contract and private release schedule reviewed',reference:id,after:{supplierId:p.supplier_id,contract:p.reference,releases:v.schedule.length,goodsValueMinor:v.goodsValueMinor,valueLimitMinor:p.value_limit_minor,flexPercent:p.flex_percent,currency:p.currency}});
  return {id,replayed:false};
 });
}
async function reconcile(c,ctx,p){
 const linked=(await c.query("SELECT r.id,r.lines,o.status,o.supplier_id,o.destination_location_id,o.currency,pol.sku_id,pol.quantity_units::text,pol.unit_cost::text,pol.units_per_purchase_unit::text,pol.destination_location_id AS line_destination FROM "+releases+" r LEFT JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id LEFT JOIN purchase_order_lines pol ON pol.workspace_id=o.workspace_id AND pol.purchase_order_id=o.id WHERE r.workspace_id=$1 AND r.contract_id=$2 AND r.status='DRAFTED' ORDER BY r.id,pol.sku_id",[ctx.workspaceId,p.id])).rows;
 const groups=new Map();
 for(const row of linked){if(!groups.has(row.id))groups.set(row.id,[]);groups.get(row.id).push(row);}
 for(const rows of groups.values()){
  const head=rows[0],expected=head.lines;
  if(!['DRAFT','AWAITING_APPROVAL',...PLACED].includes(head.status)||head.supplier_id!==p.supplier_id||head.destination_location_id!==p.destination_id||head.currency!==p.currency||rows.length!==expected.length)throw new ValidationError('A linked purchase order changed or was cancelled. Review the remaining contract before preparing another release.');
  for(const row of rows){const line=expected.find(l=>l.skuId===row.sku_id),product=p.source_snapshot.products.find(l=>l.skuId===row.sku_id);if(!line||Number(row.quantity_units)!==line.quantityUnits||row.unit_cost==null||money.userToMinor(row.unit_cost,p.currency)!==line.unitCostMinor||Number(row.units_per_purchase_unit)!==product.pack||row.line_destination!==p.destination_id)throw new ValidationError('A linked purchase order quantity, price, pack or location changed. Review the remaining contract before preparing another release.');}
 }
 return groups;
}
// What the contract has already called off in linked, not-cancelled POs.
async function drawn(c,ctx,p){
 const rows=(await c.query("SELECT pol.sku_id,pol.quantity_units::text,pol.unit_cost::text FROM "+releases+" r JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id JOIN purchase_order_lines pol ON pol.workspace_id=o.workspace_id AND pol.purchase_order_id=o.id WHERE r.workspace_id=$1 AND r.contract_id=$2 AND o.status<>'CANCELLED'",[ctx.workspaceId,p.id])).rows;
 const units=new Map();let valueMinor=0;
 for(const row of rows){const q=Number(row.quantity_units);units.set(row.sku_id,(units.get(row.sku_id)||0)+q);valueMinor+=q*money.userToMinor(row.unit_cost,p.currency);}
 return {units,valueMinor};
}
// Each release follows real demand within the agreed range, in whole supplier
// packs, and never past the contract's total units or value.
async function adjust(c,ctx,p,f,r){
 const scheduled=r.scheduled_lines||r.lines,flex=Number(p.flex_percent||0),used=await drawn(c,ctx,p);
 const positions=flex>0?await require('../forecasting/postgres-planning-service').position(c,ctx.workspaceId,{onlySkuIds:scheduled.map(l=>l.skuId)}):[];
 const notes=[],lines=[];
 for(const l of scheduled){
  const product=f.products.find(x=>x.skuId===l.skuId),term=p.line_terms.find(x=>x.skuId===l.skuId),step=product.multiplePacks;
  const base=l.quantityUnits/product.pack;let packs=base,why='Scheduled amount',need=null;
  if(flex>0){
   const pos=positions.find(x=>x.sku_id===l.skuId&&x.location_id===p.destination_id&&!x.planning_suppressed)||positions.find(x=>x.sku_id===l.skuId&&x.scope==='workspace');
   const goal=pos?(pos.target??pos.reorder):null;
   if(goal==null)why='No stock target for this product, so the scheduled amount is used';
   else{
    need=Math.max(0,Math.ceil(goal-Number(pos.projected)));
    const low=Math.ceil(base*(100-flex)/100),high=Math.floor(base*(100+flex)/100);
    let want=Math.min(high,Math.max(low,Math.ceil(need/product.pack)));
    if(want>0){want=Math.ceil(Math.max(want,product.minimumPacks)/step)*step;if(want>high)want=Math.floor(high/step)*step;if(want<product.minimumPacks)want=0;}
    why=want===base?'Matches demand':want>base?'More needed than scheduled':'Less needed than scheduled';packs=want;
   }
  }
  const left=Math.max(0,term.totalUnits-(used.units.get(l.skuId)||0)),cap=Math.floor(left/product.pack);
  if(packs>cap){packs=Math.floor(cap/step)*step;if(packs<product.minimumPacks)packs=0;why='Only what is left on the contract';}
  notes.push({skuId:l.skuId,sku:l.sku,scheduledUnits:l.quantityUnits,quantityUnits:packs*product.pack,needUnits:need,why});
  if(packs>0)lines.push({...l,quantityUnits:packs*product.pack});
 }
 let valueMinor=sum(lines);
 const valueLeft=p.value_limit_minor==null?null:Number(p.value_limit_minor)-used.valueMinor;
 if(valueLeft!==null&&valueMinor>valueLeft){
  // Trim whole order steps from the largest line until the release fits the value left.
  for(let guard=0;valueMinor>valueLeft&&lines.length&&guard<100000;guard++){
   const l=lines.reduce((a,b)=>a.quantityUnits*a.unitCostMinor>=b.quantityUnits*b.unitCostMinor?a:b),product=f.products.find(x=>x.skuId===l.skuId),less=l.quantityUnits-product.multiplePacks*product.pack;
   if(less/product.pack<product.minimumPacks)lines.splice(lines.indexOf(l),1);else l.quantityUnits=less;
   const note=notes.find(n=>n.skuId===l.skuId);note.quantityUnits=lines.includes(l)?l.quantityUnits:0;note.why='Only what is left of the contract value';
   valueMinor=sum(lines);
  }
 }
 if(lines.length&&valueMinor<f.minimumOrderMinor)throw new ValidationError('Adjusted to demand, this release is below the supplier’s minimum order value. Review it, or skip it to keep the units on the contract.');
 return {lines,valueMinor,adjustment:{flexPercent:flex,notes,valueLeftMinor:valueLeft,attempt:r.adjustment?.attempt||0}};
}
async function trained(c,ctx,p,f,rows=p.line_terms.map(l=>({...l,quantityUnits:l.releaseUnits}))){
 if(!p.trained_release_id||p.training_signature!==f.signature)return false;
 const example=await release(c,ctx,p.trained_release_id),native=(await c.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,example.purchase_order_id])).rows[0];
 return example.contract_id===p.id&&!example.sent_at&&example.status==='DRAFTED'&&Boolean(native&&PLACED.includes(native.status))&&rows.every(l=>example.lines.some(e=>e.skuId===l.skuId&&e.unitCostMinor===l.unitCostMinor&&e.quantityUnits>=l.quantityUnits));
}
// Null when the release may be placed without a person, or the reason it needs one.
async function authority(c,ctx,p,f,plan){
 const account=await policy.accountState(c,ctx.workspaceId),state=await require('../autopilot/postgres-service').getState(c,ctx.workspaceId);
 if(!state.canAutomate)return 'StockChief is set to ask before ordering. Approve this release.';
 const mode=await require('../autopilot/job-modes').restriction(c,ctx.workspaceId,42,true);if(mode)return mode;
 if(!policy.permits(account.plan,42,'automatic',{trained:await trained(c,ctx,p,f,plan.lines)}))
  return p.trained_release_id?'This release is bigger than, or priced differently from, the release you taught. Approve it.':'Approve one release from this contract yourself, then teach it. After that StockChief places releases on its own within your limits.';
 if(!p.enabled||p.authorized_by!==ctx.actorId)return 'Routine releases are not switched on for this contract.';
 const cap=policy.purchaseLimits(account);
 if(!cap)return 'Automatic ordering needs agreed purchase limits.';
 if(cap.currency!==p.currency||plan.valueMinor>money.toMinor(String(cap.perOrder),cap.currency))return 'This release needs approval under your plan’s per-order limit.';
 const delivery=await require('../autopilot/postgres-service').supplierDeliveryReadiness(scoped(c),ctx.workspaceId,p.supplier_id);
 if(!delivery.ready)return delivery.reason;
 const value=Number(money.fromMinor(plan.valueMinor,p.currency));
 for(const l of plan.lines){
  const product=f.products.find(x=>x.skuId===l.skuId);
  const reason=await policy.purchaseReview(c,ctx.workspaceId,{supplierId:p.supplier_id,skuId:l.skuId,currency:p.currency,value,unitCost:Number(money.fromMinor(l.unitCostMinor,p.currency)),unitsPerPurchaseUnit:product.pack,purchaseUnit:product.purchaseUnit,destinationLocationId:p.destination_id},{itemScope:plan.lines.map(x=>x.skuId)},account,null);
  if(reason)return reason;
 }
 return null;
}
const key=r=>'blanket-release:'+r.id+(r.adjustment?.attempt?':'+r.adjustment.attempt:'');
async function send(c,ctx,p,r,purchase,plan){
 await require('../operations/postgres-business-workflows').approvePurchaseOrder(scoped(c),ctx,purchase.purchaseOrderId,{idempotencyKey:key(r)+':approve'});
 const delivery=await require('../autopilot/postgres-service').supplierDeliveryReadiness(scoped(c),ctx.workspaceId,p.supplier_id);
 if(!delivery.ready)throw new ValidationError(delivery.reason);
 const body=[`Hello${delivery.supplier.contact_name?' '+delivery.supplier.contact_name:''},`,'',`Purchase order ${purchase.poNumber} is the ${r.release_date} release under our contract ${p.reference}:`,
  ...plan.lines.map(l=>`${l.quantityUnits} × ${l.sku} at ${money.format(l.unitCostMinor,p.currency)} each`),'',`Please deliver by ${r.expected_date} and confirm acceptance of ${purchase.poNumber}.`].join('\n');
 const queued=await require('../connections/postgres-outbound-mail').queueInTransaction(c,ctx,{recipientKind:'supplier',recipientId:p.supplier_id,recipientEmail:delivery.supplier.email,connectorId:delivery.mailbox.id,purchaseOrderId:purchase.purchaseOrderId,subject:'Purchase order '+purchase.poNumber,body},key(r)+':email');
 // Counts against the shared weekly automatic purchasing limit.
 await c.query(`INSERT INTO work_items(id,workspace_id,category,source,source_evidence,affected_entities,recommended_action,priority,confidence,approval_requirement,execution_status,verification_status,idempotency_key,purchase_order_id,outcome,created_at,completed_at)
  VALUES($1,$2,'blanket_release','postgres_autopilot',$3,$4,$5,30,'high','NONE','COMPLETED','VERIFIED',$6,$7,$8,$9,$9) ON CONFLICT DO NOTHING`,
  [newId('work'),ctx.workspaceId,JSON.stringify([{contractId:p.id,releaseId:r.id}]),JSON.stringify({supplierId:p.supplier_id}),JSON.stringify({kind:'blanket_release',supplierId:p.supplier_id}),key(r),purchase.purchaseOrderId,JSON.stringify({releaseId:r.id,purchaseOrderId:purchase.purchaseOrderId,approvedAutomatically:true}),new Date().toISOString()]);
 return queued;
}
async function createDraft(c,ctx,p,r,automatic){
 if(r.status==='DRAFTED')return {purchaseOrderId:r.purchase_order_id,releaseId:r.id,replayed:true};
 if(p.stopped||r.status!=='PLANNED')throw new ValidationError('This contract or release is stopped.');
 const f=await facts(c,ctx,p);
 if(f.signature!==p.source_snapshot.signature)throw new ValidationError('Supplier or product terms changed. Review this contract before creating more release drafts.');
 await reconcile(c,ctx,p);
 const today=await require('../lib/business-time').today(c,ctx.workspaceId);
 if(automatic){
  if(r.release_date!==today)throw new ValidationError(r.release_date<today?'A release date was missed. Review that release individually; it was not backdated automatically.':'This release date has not arrived.');
  if(r.undone_at)throw new ValidationError('You undid the '+r.release_date+' release. Prepare it again or skip it yourself.');
  if(!p.enabled)throw new ValidationError('Routine contract releases are stopped.');
 }else if(today>p.last_release)throw new ValidationError('This contract’s last release date was '+p.last_release+'. Releases after it need a new agreement.');
 const plan=await adjust(c,ctx,p,f,r);
 if(!plan.lines.length){
  if(!automatic)throw new ValidationError('Nothing is needed for this release right now. Skip it to keep its units on the contract.');
  const usedUp=plan.adjustment.notes.some(n=>/left/.test(n.why));
  await c.query("UPDATE "+releases+" SET status='SKIPPED',adjustment=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,r.id,{...plan.adjustment,skipped:usedUp?'The contract total is used up, so nothing more is ordered.':'Not needed: stock covers this release. Its units stay on the contract.'}]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Contract release not needed and skipped',reference:r.id,after:{contractId:p.id,adjustment:plan.adjustment}});
  return {releaseId:r.id,skipped:true};
 }
 const reason=automatic?await authority(c,ctx,p,f,plan):null;
 await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,key(r),plan.lines.length*8192+32768,{finished:true});
 const result=await require('../operations/postgres-business-workflows').createPurchaseOrderInTransaction(c,ctx,{
  supplierId:p.supplier_id,destinationLocationId:p.destination_id,currency:p.currency,expectedDate:r.expected_date,reference:p.reference+' / '+r.release_date,idempotencyKey:key(r),
  source:'instruction',sourceDetail:{contractId:p.id,releaseId:r.id,automatic},notes:'Release under supplier contract '+p.reference+'.',
  lines:plan.lines.map(l=>{const product=f.products.find(v=>v.skuId===l.skuId);return {skuId:l.skuId,quantityUnits:l.quantityUnits,quantityPurchaseUnits:l.quantityUnits/product.pack,unitsPerPurchaseUnit:product.pack,purchaseUnit:product.purchaseUnit,unitCost:money.fromMinor(l.unitCostMinor,p.currency),destinationLocationId:p.destination_id};})
 });
 await c.query("UPDATE "+releases+" SET status='DRAFTED',purchase_order_id=$3,automatic=$4,prepared_at=clock_timestamp(),lines=$5::jsonb,goods_value_minor=$6,adjustment=$7,needs_person=$8,undone_at=NULL WHERE workspace_id=$1 AND id=$2",
  [ctx.workspaceId,r.id,result.purchaseOrderId,automatic,JSON.stringify(plan.lines),plan.valueMinor,plan.adjustment,reason]);
 await reconcile(c,ctx,p);
 let sent=false,why=reason;
 if(automatic&&!reason){
  await c.query('SAVEPOINT blanket_release_send');
  try{
   const queued=await send(c,ctx,p,r,result,plan);
   await c.query("UPDATE "+releases+" SET sent_at=clock_timestamp(),communication_id=$3,effect_id=$4 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,r.id,queued.communicationId,queued.effectId]);
   await c.query('RELEASE SAVEPOINT blanket_release_send');sent=true;
  }catch(error){
   if(!held(error))throw error;
   await c.query('ROLLBACK TO SAVEPOINT blanket_release_send');await c.query('RELEASE SAVEPOINT blanket_release_send');why=error.message;
   await c.query("UPDATE "+releases+" SET needs_person=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,r.id,why]);
  }
 }
 await require('../operations/postgres-security-audit').record(c,ctx,{action:sent?'Supplier contract release placed and queued to the supplier':'Unapproved supplier contract release drafted',reference:r.id,after:{contractId:p.id,purchaseOrderId:result.purchaseOrderId,automatic,goodsValueMinor:plan.valueMinor,currency:p.currency,adjustment:plan.adjustment,needsPerson:why}});
 return {...result,releaseId:r.id,sent,reason:why,replayed:false};
}
async function manual(db,ctx,id,value){
 return tx(db,async c=>{await owner(c,ctx);await access(c,ctx);const initial=await release(c,ctx,id),p=await get(c,ctx,initial.contract_id,true),r=await release(c,ctx,id,true);
  if(value.confirmed!=='yes')throw new ValidationError('Confirm the exact reviewed release before preparing its unapproved purchase draft.');
  return createDraft(c,ctx,p,r,false);
 });
}
async function teach(db,ctx,id,value){
 return tx(db,async c=>{
  await owner(c,ctx,true);await access(c,ctx);const initial=await release(c,ctx,id),p=await get(c,ctx,initial.contract_id,true),r=await release(c,ctx,id,true);
  const native=(await c.query('SELECT status,approved_by_user_id FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,r.purchase_order_id])).rows[0],f=await facts(c,ctx,p);
  await reconcile(c,ctx,p);
  if(value.confirmed!=='yes'||p.stopped||r.sent_at||r.status!=='DRAFTED'||!native||!PLACED.includes(native.status)||native.approved_by_user_id!==ctx.actorId||f.signature!==p.source_snapshot.signature)throw new ValidationError('Choose a release whose purchase order you approved yourself. An unapproved release, or one StockChief placed on its own, cannot teach this rule.');
  await c.query('UPDATE '+contracts+' SET trained_release_id=$3,training_signature=$4,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.id,r.id,f.signature]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Pro contract release preparation taught from an approved individual example',reference:p.id,after:{releaseId:r.id,purchaseOrderId:r.purchase_order_id}});
  return {id:p.id};
 });
}
async function configure(db,ctx,id,value){
 return tx(db,async c=>{
  await owner(c,ctx,true);const p=await get(c,ctx,id,true);
  if(Number(value.revision)!==p.revision)throw new ValidationError('Reload the current contract before changing authority.');
  if(value.stop!=='yes'){
   // Pro may run the schedule before teaching: it then drafts each release for approval.
   const f=await facts(c,ctx,p);await access(c,ctx);
   if(value.confirmed!=='yes'||p.stopped||f.signature!==p.source_snapshot.signature)throw new ValidationError('Review these exact contract terms before authorizing routine drafts.');
   await reconcile(c,ctx,p);
   await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],p.enabled?0:1);
  }
  await c.query('UPDATE '+contracts+' SET enabled=$3,authorized_by=$4,revision=revision+1,next_check_at=NULL,last_issue=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,value.stop!=='yes',ctx.actorId]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:value.stop==='yes'?'Routine contract drafts stopped':'Routine contract drafts authorized',reference:id});
  return {id};
 });
}
async function skip(db,ctx,id,value){
 return tx(db,async c=>{
  await owner(c,ctx);const initial=await release(c,ctx,id),p=await get(c,ctx,initial.contract_id,true),r=await release(c,ctx,id,true);
  if(value.confirmed!=='yes'||r.status!=='PLANNED')throw new ValidationError('Only an unprepared release can be skipped after your confirmation. Existing purchase orders keep their separate cancellation workflow.');
  await c.query("UPDATE "+releases+" SET status='SKIPPED' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id]);
  await c.query('UPDATE '+contracts+' SET last_issue=NULL,next_check_at=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.id]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Unprepared contract release skipped by owner',reference:id,after:{contractId:p.id,unitsNotOrdered:r.lines}});
  return {id:p.id};
 });
}
// Before the supplier email goes out, the owner can take a release back: the
// PO and the queued email are cancelled and the units return to the contract.
async function undo(db,ctx,id,value){
 return tx(db,async c=>{
  await owner(c,ctx);const initial=await release(c,ctx,id),p=await get(c,ctx,initial.contract_id,true),r=await release(c,ctx,id,true);
  if(r.undone_at&&r.status==='PLANNED')return {id:p.id,replayed:true};
  if(value.confirmed!=='yes'||r.status!=='DRAFTED'||!r.purchase_order_id)throw new ValidationError('Choose a prepared release to undo.');
  const native=(await c.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,r.purchase_order_id])).rows[0];
  const mail=(await c.query(`SELECT e.id,e.status,m.id AS message_id,m.status AS message_status FROM supplier_communications m
   LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.kind='mail.outbound.send' AND e.aggregate_id=m.id
   WHERE m.workspace_id=$1 AND m.idempotency_key=$2 FOR UPDATE OF m`,[ctx.workspaceId,key(r)+':email'])).rows[0];
  if(mail&&(mail.message_status!=='QUEUED'||(mail.status&&mail.status!=='PENDING')))throw new ValidationError('The supplier email has already gone out or is being sent. Ask the supplier to cancel, then cancel the PO yourself.');
  if(!native||!['DRAFT','AWAITING_APPROVAL','APPROVED'].includes(native.status))throw new ValidationError('This PO has moved on. Open it to make a correction.');
  if(mail){
   if(mail.id)await c.query("UPDATE stockchief_runtime.provider_effects SET status='CANCELLED',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status='PENDING'",[ctx.workspaceId,mail.id]);
   await c.query("UPDATE supplier_communications SET status='CANCELLED',updated_at=clock_timestamp()::text WHERE workspace_id=$1 AND id=$2 AND status='QUEUED'",[ctx.workspaceId,mail.message_id]);
  }
  await require('../operations/postgres-business-workflows').cancelPurchaseOrderInTransaction(c,ctx,r.purchase_order_id,{idempotencyKey:key(r)+':undo',reason:'Owner undid this contract release before it was sent.'});
  const attempt=(r.adjustment?.attempt||0)+1;
  await c.query("UPDATE "+releases+" SET status='PLANNED',purchase_order_id=NULL,automatic=false,prepared_at=NULL,sent_at=NULL,communication_id=NULL,effect_id=NULL,needs_person=NULL,lines=scheduled_lines,goods_value_minor=$3,adjustment=$4,undone_at=clock_timestamp(),undone_by=$5 WHERE workspace_id=$1 AND id=$2",
   [ctx.workspaceId,r.id,sum(r.scheduled_lines),{...(r.adjustment||{}),attempt,undonePurchaseOrderId:r.purchase_order_id},ctx.actorId]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier contract release undone before sending',reference:r.id,before:{purchaseOrderId:r.purchase_order_id,sent:Boolean(r.sent_at)},after:{status:'PLANNED',emailCancelled:Boolean(mail)}});
  return {id:p.id,replayed:false};
 });
}
async function onContract(db,workspaceId,id){
 try{return await tx(db,async c=>{
  const initial=(await c.query('SELECT authorized_by FROM '+contracts+' WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
  if(!initial)return {removed:true};
  const ctx={workspaceId,actorId:initial.authorized_by};
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('account-purchase:'||owner_account_id,0)) FROM workspaces WHERE id=$1",[workspaceId]);
  await require('./postgres-purchase-exposure').lock(c,workspaceId);
  await owner(c,ctx);const account=await access(c,ctx);
  // Pause and an over-allowance rule count stop the routine; it does not even draft.
  if(!(await require('../autopilot/postgres-service').getState(c,workspaceId)).canAct)throw new ValidationError('Automatic work is paused. Review the inventory’s automation settings.');
  const quota=await require('../commercial/agent-rule-quota').restriction(c,account);if(quota)throw new ValidationError(quota);
  const p=await get(c,ctx,id,true);
  if(!p.enabled||p.stopped)throw new ValidationError('Routine contract drafts are stopped.');
  const r=(await c.query("SELECT * FROM "+releases+" WHERE workspace_id=$1 AND contract_id=$2 AND status='PLANNED' ORDER BY release_date,id LIMIT 1 FOR UPDATE",[workspaceId,id])).rows[0],today=await require('../lib/business-time').today(c,workspaceId);
  if(!r||r.release_date>today)return {notDue:true};
  const result=await createDraft(c,ctx,p,r,true);
  await c.query("UPDATE "+contracts+" SET next_check_at=clock_timestamp()+interval '15 minutes',last_issue=NULL WHERE workspace_id=$1 AND id=$2",[workspaceId,id]);return result;
 });}catch(e){if(!held(e))throw e;await db.query("UPDATE "+contracts+" SET next_check_at=clock_timestamp()+interval '15 minutes',last_issue=$3 WHERE workspace_id=$1 AND id=$2",[workspaceId,id,String(e.message).slice(0,500)]);return {held:true,reason:e.message};}
}
async function schedule(db,workspaceId){
 const today=await require('../lib/business-time').today(db,workspaceId),rows=(await db.query('SELECT p.id,p.revision FROM '+contracts+" p WHERE p.workspace_id=$1 AND p.enabled AND NOT p.stopped AND (p.next_check_at IS NULL OR p.next_check_at<=now()) AND EXISTS(SELECT 1 FROM "+releases+" r WHERE r.workspace_id=p.workspace_id AND r.contract_id=p.id AND r.status='PLANNED' AND r.release_date<=$2) ORDER BY p.next_check_at NULLS FIRST,p.id LIMIT 5",[workspaceId,today])).rows;
 for(const p of rows)await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind,idempotencyKey:'blanket-contract:'+p.id+':'+p.revision+':'+Math.floor(Date.now()/900000),payload:{contractId:p.id},priority:30,maxAttempts:3});
 return {queued:rows.length};
}
async function end(db,ctx,id,value){
 return tx(db,async c=>{
  await owner(c,ctx);const p=await get(c,ctx,id,true);
  if(Number(value.revision)!==p.revision||value.confirmed!=='yes')throw new ValidationError('Review and confirm ending this remaining schedule. Existing purchase orders are not cancelled.');
  await c.query('UPDATE '+contracts+' SET stopped=true,enabled=false,revision=revision+1,last_issue=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);
  const result=await c.query("UPDATE "+releases+" SET status='SKIPPED' WHERE workspace_id=$1 AND contract_id=$2 AND status='PLANNED' RETURNING id",[ctx.workspaceId,id]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Remaining private supplier release schedule ended',reference:id,after:{unpreparedSlotsStopped:result.rowCount,existingPurchaseOrdersPreserved:true}});
  return {id};
 });
}
async function screen(db,ctx,{id=null,page=1}={}){
 await owner(db,ctx);
 const state=await policy.accountState(db,ctx.workspaceId),allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,42,'draft');
 page=Number(page);if(!Number.isSafeInteger(page)||page<1||page>10000)throw new ValidationError('Choose a valid contract page.');
 const rows=(await db.query('SELECT p.id,p.reference,p.currency,p.goods_value_minor,p.enabled,p.stopped,s.name AS supplier_name FROM '+contracts+' p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id WHERE p.workspace_id=$1 ORDER BY p.created_at DESC,p.id LIMIT 101 OFFSET $2',[ctx.workspaceId,(page-1)*100])).rows;
 const selected=id?await get(db,ctx,id):null;
 const slots=selected?(await db.query('SELECT r.*,o.po_number,o.status AS order_status,o.expected_date AS order_expected_date,e.status AS effect_status FROM '+releases+' r LEFT JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=r.workspace_id AND e.id=r.effect_id WHERE r.workspace_id=$1 AND r.contract_id=$2 ORDER BY r.release_date,r.id LIMIT 53',[ctx.workspaceId,id])).rows:[];
 const used=selected?await drawn(db,ctx,selected):null;
 const drawdown=selected?selected.line_terms.map(l=>({...l,currentUnits:used.units.get(l.skuId)||0,
  remainingUnits:l.totalUnits-(used.units.get(l.skuId)||0),
  plannedUnits:slots.filter(r=>r.status==='PLANNED').reduce((n,r)=>n+(r.lines.find(x=>x.skuId===l.skuId)?.quantityUnits||0),0),
  skippedUnits:slots.filter(r=>r.status==='SKIPPED').reduce((n,r)=>n+(r.lines.find(x=>x.skuId===l.skuId)?.quantityUnits||0),0)})):[];
 const value=selected?{drawnMinor:used.valueMinor,limitMinor:selected.value_limit_minor==null?null:Number(selected.value_limit_minor),leftMinor:selected.value_limit_minor==null?null:Number(selected.value_limit_minor)-used.valueMinor}:null;
 let problem=selected?.last_issue||null,trainingReady=false;
 if(selected&&allowed)try{const f=await facts(db,ctx,selected);if(f.signature!==selected.source_snapshot.signature)throw new ValidationError('Current product or supplier terms differ from this saved agreement. Further drafts are held.');await reconcile(db,ctx,selected);trainingReady=await trained(db,ctx,selected,f);}catch(e){if(!held(e))throw e;problem=e.message;}
 const suppliers=allowed?(await db.query("SELECT id,name,currency FROM suppliers WHERE workspace_id=$1 AND status='active' ORDER BY name,id LIMIT 251",[ctx.workspaceId])).rows:[],places=allowed?(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL ORDER BY name,id LIMIT 251',[ctx.workspaceId])).rows:[];
 return {allowed,plan:state.plan,shadow:state.shadow,page,rows:rows.slice(0,100),more:rows.length>100,selected,slots,drawdown,value,problem,trainingReady,
  suppliers:suppliers.slice(0,250),places:places.slice(0,250),moreSuppliers:suppliers.length>250,morePlaces:places.length>250,today:await require('../lib/business-time').today(db,ctx.workspaceId)};
}
const definition={id:42,key:'blanket-releases',label:'Manage supplier contract releases',readPage:async()=>({summary:'Track reviewed supplier contracts: products, prices, total units or value, dates and a release schedule. Each release becomes a real purchase order on its date, adjusted to demand within the agreed range, and never past the contract’s totals or dates. Pro drafts until you teach it; taught Pro and Custom place releases and email the supplier within your purchasing limits. You can undo before the email goes out.',rows:[{Action:'Open supplier contracts',link:'/autopilot/blanket-releases'}],more:false})};
function notices(row){if(!row?.n)return [];return [{kind:'purchase',importance:'Needs You',priority:50,title:row.n===1?'Supplier contract '+row.reference+' needs review':row.n+' supplier contracts need review',happened:'A scheduled release is waiting for your approval, or the contract facts need review.',why:'Open the contract to see why. Approving the release PO sends nothing by itself; receiving and paying stay separate.',actionLabel:'Review supplier contract releases',href:'/autopilot/blanket-releases',sourceId:'blanket-contracts',at:row.created_at,createdAt:row.created_at}];}
module.exports={preview,save,manual,teach,configure,skip,end,undo,onContract,schedule,get,release,screen,notices,definition,kind,action,scheduleRows};
