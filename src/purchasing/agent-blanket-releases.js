'use strict';
const {newId}=require('../lib/util'),{hash}=require('../pricing/postgres-promotions');
const policy=require('../commercial/agent-plan'),money=require('../domain/currency');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {addDays}=require('../accounting/customer-money');
const contracts='stockchief_runtime.agent_blanket_contracts',releases='stockchief_runtime.agent_blanket_releases';
const kind='purchasing.blanket-release.v1',action='purchasing.prepare_blanket_release';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
async function owner(c,ctx,accountLock=false){
 if(!(await c.query("SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) FOR SHARE OF u,w",[ctx.workspaceId,ctx.actorId])).rowCount)throw new AuthorizationError('Only the current inventory owner can authorize supplier contract releases.');
 await require('../operations/postgres-warehouse-access').assertInventoryWide(c,ctx);
 if(accountLock)await c.query('SELECT a.id FROM accounts a JOIN workspaces w ON w.owner_account_id=a.id WHERE w.id=$1 FOR UPDATE OF a',[ctx.workspaceId]);
}
async function access(c,ctx,automatic=false,{trained=false}={}){
 await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
 const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,42,automatic?'automatic':'draft',{trained});
 await require('../commercial/enforcement').workspace(c,ctx.workspaceId,'inventory.core');
 await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
 const reason=await policy.stopped(c,ctx.workspaceId,state,action,automatic);
 if(reason)throw new ValidationError(reason);
 if(automatic&&!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Routine supplier releases are paused.');
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
  const text=String(value.linesText||'').replace(/^\uFEFF/,'');
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
 return {supplier_id:String(value.supplierId||''),destination_id:String(value.destinationId||''),reference:reference(value.reference),currency,first_release:first,last_release:last,
  interval_days:integer(value.intervalDays,'Days between releases',1,365),lead_days:integer(value.leadDays??0,'Expected delivery lead time',0,365),
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
  await c.query('INSERT INTO '+contracts+'(id,workspace_id,supplier_id,destination_id,reference,currency,first_release,last_release,interval_days,lead_days,line_terms,goods_value_minor,source_snapshot,source_hash,authorized_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15)',[id,ctx.workspaceId,p.supplier_id,p.destination_id,p.reference,p.currency,p.first_release,p.last_release,p.interval_days,p.lead_days,JSON.stringify(p.line_terms),v.goodsValueMinor,JSON.stringify(v.source),v.sourceHash,ctx.actorId]);
  for(const slot of v.schedule)await c.query('INSERT INTO '+releases+'(id,workspace_id,contract_id,release_date,expected_date,lines,goods_value_minor) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[newId('blanket-release'),ctx.workspaceId,id,slot.releaseDate,slot.expectedDate,JSON.stringify(slot.lines),slot.goodsValueMinor]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier contract and private release schedule reviewed',reference:id,after:{supplierId:p.supplier_id,contract:p.reference,releases:v.schedule.length,goodsValueMinor:v.goodsValueMinor,currency:p.currency}});
  return {id,replayed:false};
 });
}
async function reconcile(c,ctx,p){
 const linked=(await c.query("SELECT r.id,r.lines,o.status,o.supplier_id,o.destination_location_id,o.currency,pol.sku_id,pol.quantity_units::text,pol.unit_cost::text,pol.units_per_purchase_unit::text,pol.destination_location_id AS line_destination FROM "+releases+" r LEFT JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id LEFT JOIN purchase_order_lines pol ON pol.workspace_id=o.workspace_id AND pol.purchase_order_id=o.id WHERE r.workspace_id=$1 AND r.contract_id=$2 AND r.status='DRAFTED' ORDER BY r.id,pol.sku_id",[ctx.workspaceId,p.id])).rows;
 const groups=new Map();
 for(const row of linked){if(!groups.has(row.id))groups.set(row.id,[]);groups.get(row.id).push(row);}
 for(const rows of groups.values()){
  const head=rows[0],expected=head.lines;
  if(!['DRAFT','AWAITING_APPROVAL','APPROVED','ORDERED','PLACED','PARTIALLY_RECEIVED','RECEIVED'].includes(head.status)||head.supplier_id!==p.supplier_id||head.destination_location_id!==p.destination_id||head.currency!==p.currency||rows.length!==expected.length)throw new ValidationError('A linked purchase order changed or was cancelled. Review the remaining contract before preparing another release.');
  for(const row of rows){const line=expected.find(l=>l.skuId===row.sku_id),product=p.source_snapshot.products.find(l=>l.skuId===row.sku_id);if(!line||Number(row.quantity_units)!==line.quantityUnits||row.unit_cost==null||money.userToMinor(row.unit_cost,p.currency)!==line.unitCostMinor||Number(row.units_per_purchase_unit)!==product.pack||row.line_destination!==p.destination_id)throw new ValidationError('A linked purchase order quantity, price, pack or location changed. Review the remaining contract before preparing another release.');}
 }
 return groups;
}
async function trained(c,ctx,p,f,rows=p.line_terms.map(l=>({...l,quantityUnits:l.releaseUnits}))){
 if(!p.trained_release_id||p.training_signature!==f.signature)return false;
 const example=await release(c,ctx,p.trained_release_id),native=(await c.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,example.purchase_order_id])).rows[0];
 return example.contract_id===p.id&&!example.automatic&&example.status==='DRAFTED'&&Boolean(native&&['APPROVED','ORDERED','PLACED','PARTIALLY_RECEIVED','RECEIVED'].includes(native.status))&&rows.every(l=>example.lines.some(e=>e.skuId===l.skuId&&e.unitCostMinor===l.unitCostMinor&&e.quantityUnits>=l.quantityUnits));
}
async function createDraft(c,ctx,p,r,automatic){
 if(r.status==='DRAFTED')return {purchaseOrderId:r.purchase_order_id,replayed:true};
 if(p.stopped||r.status!=='PLANNED')throw new ValidationError('This contract or release is stopped.');
 const f=await facts(c,ctx,p);
 if(f.signature!==p.source_snapshot.signature)throw new ValidationError('Supplier or product terms changed. Review this contract before creating more release drafts.');
 await reconcile(c,ctx,p);
 const rows=r.lines;
 if(automatic){
  const today=await require('../lib/business-time').today(c,ctx.workspaceId);
  if(r.release_date!==today)throw new ValidationError(r.release_date<today?'A release date was missed. Review that release individually; it was not backdated automatically.':'This release date has not arrived.');
  const state=await access(c,ctx,true,{trained:await trained(c,ctx,p,f,rows)});
  if(!p.enabled)throw new ValidationError('Routine contract releases are stopped.');
  if(state.plan==='pro'){
   if(!p.trained_release_id||p.training_signature!==f.signature)throw new ValidationError('Pro needs an individually reviewed and approved matching release example.');
   const example=await release(c,ctx,p.trained_release_id),native=(await c.query("SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,example.purchase_order_id])).rows[0];
   if(example.contract_id!==p.id||example.automatic||!native||!['APPROVED','ORDERED','PLACED','PARTIALLY_RECEIVED','RECEIVED'].includes(native.status)||rows.some(l=>!example.lines.some(e=>e.skuId===l.skuId&&e.unitCostMinor===l.unitCostMinor&&e.quantityUnits>=l.quantityUnits)))throw new ValidationError('This release exceeds the completed manual example, or the example is no longer approved.');
  }
 }
 const key='blanket-release:'+r.id;
 await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,key,rows.length*8192+32768,{finished:true});
 const result=await require('../operations/postgres-business-workflows').createPurchaseOrderInTransaction(c,ctx,{
  supplierId:p.supplier_id,destinationLocationId:p.destination_id,currency:p.currency,expectedDate:r.expected_date,reference:p.reference+' / '+r.release_date,idempotencyKey:key,
  source:'instruction',sourceDetail:{contractId:p.id,releaseId:r.id,automatic},notes:'Reviewed supplier contract '+p.reference+'. Goods only; approval, sending, freight, tax and payments remain separate.',
  lines:rows.map(l=>{const product=f.products.find(v=>v.skuId===l.skuId);return {skuId:l.skuId,quantityUnits:l.quantityUnits,quantityPurchaseUnits:l.quantityUnits/product.pack,unitsPerPurchaseUnit:product.pack,purchaseUnit:product.purchaseUnit,unitCost:money.fromMinor(l.unitCostMinor,p.currency),destinationLocationId:p.destination_id};})
 });
 await c.query("UPDATE "+releases+" SET status='DRAFTED',purchase_order_id=$3,automatic=$4,prepared_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,r.id,result.purchaseOrderId,automatic]);
 await reconcile(c,ctx,p);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Unapproved supplier contract release drafted',reference:r.id,after:{contractId:p.id,purchaseOrderId:result.purchaseOrderId,automatic,goodsValueMinor:Number(r.goods_value_minor),currency:p.currency}});
 return {...result,releaseId:r.id,replayed:false};
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
  const native=(await c.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,r.purchase_order_id])).rows[0],f=await facts(c,ctx,p);
  await reconcile(c,ctx,p);
  if(value.confirmed!=='yes'||p.stopped||r.automatic||r.status!=='DRAFTED'||!native||!['APPROVED','ORDERED','PLACED','PARTIALLY_RECEIVED','RECEIVED'].includes(native.status)||f.signature!==p.source_snapshot.signature)throw new ValidationError('Choose a matching individually reviewed release whose native purchase order was approved. An unapproved or automatic draft cannot teach this rule.');
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
   const f=await facts(c,ctx,p),state=await access(c,ctx,true,{trained:await trained(c,ctx,p,f)});
   if(value.confirmed!=='yes'||p.stopped||f.signature!==p.source_snapshot.signature)throw new ValidationError('Review these exact contract terms before authorizing routine drafts.');
   if(state.plan==='pro'&&(!p.trained_release_id||p.training_signature!==f.signature))throw new ValidationError('Pro needs a completed individually reviewed and approved release example first.');
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
async function onContract(db,workspaceId,id){
 try{return await tx(db,async c=>{
  const initial=(await c.query('SELECT authorized_by FROM '+contracts+' WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
  if(!initial)return {removed:true};
  const ctx={workspaceId,actorId:initial.authorized_by};await owner(c,ctx);await access(c,ctx);const p=await get(c,ctx,id,true);
  if(!p.enabled||p.stopped)throw new ValidationError('Routine contract drafts are stopped.');
  const r=(await c.query("SELECT * FROM "+releases+" WHERE workspace_id=$1 AND contract_id=$2 AND status='PLANNED' ORDER BY release_date,id LIMIT 1 FOR UPDATE",[workspaceId,id])).rows[0],today=await require('../lib/business-time').today(c,workspaceId);
  if(!r||r.release_date>today)return {notDue:true};
  const result=await createDraft(c,ctx,p,r,true);
  await c.query("UPDATE "+contracts+" SET next_check_at=clock_timestamp()+interval '15 minutes',last_issue=NULL WHERE workspace_id=$1 AND id=$2",[workspaceId,id]);return result;
 });}catch(e){if(![400,402,403,404,422].includes(e.status))throw e;await db.query("UPDATE "+contracts+" SET next_check_at=clock_timestamp()+interval '15 minutes',last_issue=$3 WHERE workspace_id=$1 AND id=$2",[workspaceId,id,String(e.message).slice(0,500)]);return {held:true,reason:e.message};}
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
 const slots=selected?(await db.query('SELECT r.*,o.po_number,o.status AS order_status,o.expected_date AS order_expected_date FROM '+releases+' r LEFT JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id WHERE r.workspace_id=$1 AND r.contract_id=$2 ORDER BY r.release_date,r.id LIMIT 53',[ctx.workspaceId,id])).rows:[];
 const native=selected?(await db.query("SELECT pol.sku_id,sum(CASE WHEN o.status='CANCELLED' THEN 0 ELSE pol.quantity_units END)::text AS current_units FROM "+releases+" r JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id JOIN purchase_order_lines pol ON pol.workspace_id=o.workspace_id AND pol.purchase_order_id=o.id WHERE r.workspace_id=$1 AND r.contract_id=$2 GROUP BY pol.sku_id",[ctx.workspaceId,id])).rows:[];
 const drawdown=selected?selected.line_terms.map(l=>({...l,currentUnits:Number(native.find(n=>n.sku_id===l.skuId)?.current_units||0),
  remainingUnits:l.totalUnits-Number(native.find(n=>n.sku_id===l.skuId)?.current_units||0),
  plannedUnits:slots.filter(r=>r.status==='PLANNED').reduce((n,r)=>n+(r.lines.find(x=>x.skuId===l.skuId)?.quantityUnits||0),0),
  skippedUnits:slots.filter(r=>r.status==='SKIPPED').reduce((n,r)=>n+(r.lines.find(x=>x.skuId===l.skuId)?.quantityUnits||0),0)})):[];
 let problem=selected?.last_issue||null,trainingReady=false;
 if(selected&&allowed)try{const f=await facts(db,ctx,selected);if(f.signature!==selected.source_snapshot.signature)throw new ValidationError('Current product or supplier terms differ from this saved agreement. Further drafts are held.');await reconcile(db,ctx,selected);trainingReady=await trained(db,ctx,selected,f);}catch(e){if(![400,402,403,404,422].includes(e.status))throw e;problem=e.message;}
 const suppliers=allowed?(await db.query("SELECT id,name,currency FROM suppliers WHERE workspace_id=$1 AND status='active' ORDER BY name,id LIMIT 251",[ctx.workspaceId])).rows:[],places=allowed?(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL ORDER BY name,id LIMIT 251',[ctx.workspaceId])).rows:[];
 return {allowed,plan:state.plan,shadow:state.shadow,page,rows:rows.slice(0,100),more:rows.length>100,selected,slots,drawdown,problem,trainingReady,
  suppliers:suppliers.slice(0,250),places:places.slice(0,250),moreSuppliers:suppliers.length>250,morePlaces:places.length>250,today:await require('../lib/business-time').today(db,ctx.workspaceId)};
}
const definition={id:42,key:'blanket-releases',label:'Manage supplier contract release drafts',readPage:async()=>({summary:'Track exact reviewed supplier contracts and prepare scheduled unapproved native purchase releases. Pro needs a completed individually reviewed and approved example; Custom can work without training within explicit agreement limits. Current prices, packs, existing drawdowns, dates and authority are rechecked. Approval, sending, payments, freight and tax stay separate.',rows:[{Action:'Open supplier contracts',link:'/autopilot/blanket-releases'}],more:false})};
function notices(row){if(!row?.n)return [];return [{kind:'purchase',importance:'Needs You',priority:50,title:row.n===1?'Supplier contract '+row.reference+' needs review':row.n+' supplier contracts need review',happened:'A scheduled release draft needs approval, or current contract facts need review.',why:'Review the actual linked orders and remaining quantities. Purchase approval, sending, physical receipt and payments remain separate.',actionLabel:'Review supplier contract releases',href:'/autopilot/blanket-releases',sourceId:'blanket-contracts',at:row.created_at,createdAt:row.created_at}];}
module.exports={preview,save,manual,teach,configure,skip,end,onContract,schedule,get,release,screen,notices,definition,kind,action,scheduleRows};
