'use strict';

// The agent's purchasing preparation is deliberately separate from placing an
// order. These actions use the ordinary PO and reorder-policy records; neither
// approves, sends, receives, bills nor pays anything.
const {ValidationError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan'),exact=require('../domain/exact-quantity'),money=require('../domain/currency');
const {hash}=require('../pricing/postgres-promotions');
const stock=require('../domain/postgres-stock-availability'),quantities=require('../domain/stock-quantity');
const economic=require('./supplier-economic-cost'),comparisonTerms=require('./agent-supplier-comparison-terms');
const DRAFT='purchase_order.reorder_drafts',SELECT='purchasing.select_supplier';
const positive=v=>Number(v)>0;
async function owner(c,ctx,lock=false){
 if(!(await c.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
 WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)${lock?' FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rowCount)throw new AuthorizationError('Only the current inventory owner can prepare the agent’s purchasing work.');
 await require('../operations/postgres-warehouse-access').assertInventoryWide(c,ctx);
}
function input(args,selection){
 const codes=[...new Set(String(args.skuCodes||args.sku||'').split(/[,\r\n]+/).map(v=>v.trim()).filter(Boolean))].sort();
 if(codes.some(v=>v.length>150))throw new ValidationError('Use exact product codes, one per line.');
 const strategy=selection?String(args.strategy||'cheapest'):'saved';
 if(!['saved','cheapest','fastest'].includes(strategy))throw new ValidationError('Choose cheapest or fastest supplier.');
 if(selection&&!codes.length)throw new ValidationError('Choose the exact products whose buying supplier should change.');
 const comparisonBasis=selection?String(args.comparisonBasis||'economic'):'goods',goodsOnlyReason=String(args.goodsOnlyReason||'').trim(),comparisonCurrency=String(args.comparisonCurrency||'').trim();
 if(selection&&!['economic','goods'].includes(comparisonBasis))throw new ValidationError('Choose delivered economic cost or an explicitly requested goods-only comparison.');
 if(selection&&comparisonBasis==='goods'&&(!goodsOnlyReason||goodsOnlyReason.length>2000))throw new ValidationError('Record the owner’s explicit request to compare goods only and review delivery and tax separately.');
 const measures=String(args.secondaryQuantities||'').split(/\r?\n/).filter(v=>v.trim()).map(line=>{const parts=line.split('|').map(s=>s.trim());if(parts.length!==4||!parts[0]||!parts[1])throw new ValidationError('Use product code | receiving location | exact pieces | independent requested weight.');return {sku:parts[0],location:parts[1],quantity:exact.canonical(parts[2]),weight:exact.canonical(parts[3])};});
 if(new Set(measures.map(m=>m.sku+'|'+m.location)).size!==measures.length)throw new ValidationError('Supply one independent requested measure per product and receiving location.');
 return {skuCodes:codes.join('\n'),location:String(args.location||'').trim(),strategy,secondaryQuantities:measures.map(m=>[m.sku,m.location,m.quantity,m.weight].join(' | ')).sort().join('\n'),...(selection?{comparisonBasis,goodsOnlyReason,comparisonCurrency:comparisonCurrency?money.code(comparisonCurrency):''}:{}),...(args.quantity!=null&&String(args.quantity).trim()?{quantity:exact.canonical(args.quantity)}:{})};
}
async function positions(c,ctx,args){
 const codes=args.skuCodes?args.skuCodes.split('\n'):null;
 let onlySkuIds=null;
 if(codes){const found=(await c.query(`SELECT s.id,s.code FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 WHERE s.workspace_id=$1 AND s.code=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 ORDER BY s.id`,[ctx.workspaceId,codes])).rows;
 if(found.length!==codes.length)throw new ValidationError('Match every exact active product code in this inventory.');onlySkuIds=found.map(s=>s.id);}
 const rows=[];let afterSkuId=null;
 do{const page=await require('../forecasting/postgres-planning-service').position(c,ctx.workspaceId,{onlySkuIds,afterSkuId,limitSkus:250,recommendationsOnly:!onlySkuIds});rows.push(...page);if(!page.coverage.partial)break;afterSkuId=page.coverage.nextAfterSkuId;}while(afterSkuId);
 let selected=rows.filter(r=>!r.planning_suppressed);
 if(args.location){const locations=(await c.query('SELECT id FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL AND lower(name)=lower($2)',[ctx.workspaceId,args.location])).rows;if(locations.length!==1)throw new ValidationError('Choose one exact active receiving location.');selected=selected.filter(r=>r.location_id===locations[0].id);}
 if(codes&&codes.some(code=>!selected.some(r=>r.code===code)))throw new ValidationError('Set a stock position or reorder policy for every selected product and receiving location.');
 return selected;
}
// Round supplier purchase counts in decimal atoms. Stock quantities do not
// pass through floating-point division or get rounded to whole pieces.
function pack(offer,needed,profile){
 if(!offer.purchase_unit||offer.units_per_purchase_unit==null||offer.minimum_order_quantity==null||offer.order_multiple==null||offer.last_unit_cost==null||!offer.currency)throw new ValidationError('Record the supplier’s purchase unit, pack, minimum, multiple, currency and current cost before choosing '+profile.code+'.');
 const scale=6,units=BigInt(exact.atoms(offer.units_per_purchase_unit,scale,{positive:true})),multiple=BigInt(exact.atoms(offer.order_multiple,scale,{positive:true})),minimum=BigInt(exact.atoms(offer.minimum_order_quantity,scale)),need=BigInt(exact.atoms(needed,scale,{positive:true})),factor=1000000n;
 const ceil=(a,b)=>(a+b-1n)/b;
 let counts=ceil(need*factor,units*multiple)*multiple;const baseCounts=counts;
 if(counts<minimum)counts=ceil(minimum,multiple)*multiple;
 const purchaseUnits=exact.fromAtoms(Number(counts),scale),quantity=exact.convert(purchaseUnits,{numerator:String(offer.units_per_purchase_unit),precision:Number(profile.quantity_precision)});
 quantities.validate(profile,quantity,{positive:true});
 const unitCostMinor=money.toMinor(String(offer.last_unit_cost),offer.currency);
 if(unitCostMinor<0)throw new ValidationError('Review the supplier’s recorded unit cost.');
 // Catch-weight is priced by the independent measure. Never infer weight from
 // a count or a past average. The owner can supply an exact requested measure.
 return {quantity,purchaseUnits,unitCostMinor,packJob:units!==factor||multiple!==factor,minimumApplied:counts>baseCounts,totalMinor:profile.secondary_unit_label?null:exact.costMinor(quantity,unitCostMinor)};
}
async function facts(c,ctx,args,selection,{collect=false,throughDate=null}={}){
 let source=await positions(c,ctx,args);const requested=source;
 const held=[];
 function hold(position,error){
  if(!collect||!(error instanceof ValidationError))throw error;
  held.push({skuId:position.sku_id,code:position.code,locationId:position.location_id,location:position.location_name,reason:error.message});
 }
 const kitRows=(await c.query("SELECT DISTINCT kit_sku_id FROM kit_components WHERE workspace_id=$1 AND kit_sku_id=ANY($2::text[]) AND stock_basis='components'",[ctx.workspaceId,[...new Set(source.map(r=>r.sku_id))]])).rows;
 const kitIds=new Set(kitRows.map(k=>k.kit_sku_id)),recipes=[],requirements=new Map();
 if(kitIds.size){
  if(selection)throw new ValidationError('Select suppliers for the actual kit components; a component kit has no finished-goods supplier.');
  await policy.requireWorkspaceJob(c,ctx.workspaceId,13,'draft');
  const capacities=await require('../domain/postgres-kit-availability').read(c,ctx.workspaceId,[...kitIds]);
  for(const p of source.filter(p=>kitIds.has(p.sku_id))){
   try{
   if(!p.location_id)throw new ValidationError('Set a receiving location for each kit reorder.');
   const capacity=capacities.get(p.sku_id),buildable=capacity?.locations.find(l=>l.locationId===p.location_id)?.buildable||0;
   if(p.effectiveReorder===null||buildable>p.effectiveReorder)continue;
   const target=p.targetStock??p.effectiveReorder;
   const parts=await require('../domain/postgres-kit-service').explode(c,ctx.workspaceId,p.sku_id,{multiplier:String(target)});recipes.push({kit:p.sku_id,locationId:p.location_id,target,parts,capacity});
   for(const part of parts){const key=stock.key(part.skuId,p.location_id),old=requirements.get(key);requirements.set(key,{skuId:part.skuId,locationId:p.location_id,locationName:p.location_name,target:exact.add(old?.target||'0',part.quantity)});}
   }catch(error){hold(p,error);}
  }
  const partIds=[...new Set([...requirements.values()].map(r=>r.skuId))],partPositions=partIds.length?await require('../forecasting/postgres-planning-service').position(c,ctx.workspaceId,{onlySkuIds:partIds}):[];
  const rawStock=await stock.readMany(c,ctx.workspaceId,[...requirements.values()].map(r=>({skuId:r.skuId,locationId:r.locationId})));
  source=source.filter(p=>!kitIds.has(p.sku_id));
  for(const r of requirements.values()){
   const key=stock.key(r.skuId,r.locationId),existing=source.find(p=>p.sku_id===r.skuId&&p.location_id===r.locationId),position=partPositions.find(p=>p.sku_id===r.skuId&&p.location_id===r.locationId)||partPositions.find(p=>p.sku_id===r.skuId),physical=rawStock.get(key);
   if(!position){hold({sku_id:r.skuId,code:r.skuId,location_id:r.locationId,location_name:r.locationName},new ValidationError('Restore each active kit component before drafting its purchase.'));continue;}
   if(existing){existing.targetStock=exact.safeNumber(exact.add(String(existing.targetStock||0),r.target));existing.effectiveReorder=existing.targetStock;existing.kitDerived=true;}
   else source.push({...position,scope:'position',planning_suppressed:false,location_id:r.locationId,location_name:r.locationName,policy_id:position.location_id===r.locationId?position.policy_id:null,preferred_supplier_id:position.location_id===r.locationId?position.preferred_supplier_id:null,onHand:physical?.onHand||0,on_hand:String(physical?.onHand||0),committed:(physical?.committed||0)+(physical?.reserved||0),incoming:position.location_id===r.locationId?position.incoming:0,targetStock:Number(r.target),effectiveReorder:Number(r.target),kitDerived:true});
  }
 }
 const ids=[...new Set(source.map(r=>r.sku_id))];
 if(!ids.length){
  if(collect)return {rows:[],held,today:await require('../lib/business-time').today(c,ctx.workspaceId)};
  throw new ValidationError('No products currently need a reorder draft.');
 }
 const profiles=(await c.query(`SELECT i.*,s.id,s.code,s.item_id${collect?",lower(trim(coalesce(f.category,''))) budget_category":''}
 FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 ${collect?'LEFT JOIN catalogue_item_facts f ON f.workspace_id=i.workspace_id AND f.item_id=i.id':''}
 WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) ORDER BY s.id`,[ctx.workspaceId,ids])).rows;
 const byId=new Map(profiles.map(p=>[p.id,p])),today=await require('../lib/business-time').today(c,ctx.workspaceId);
 const offers=(await c.query(`SELECT si.*,v.name supplier_name,v.currency,v.minimum_order_amount,v.payment_terms,v.freight_terms_currency,v.free_freight_threshold_minor,v.ordinary_freight_minor,v.updated_at supplier_updated_at,
 v.default_lead_time_days,lead.effective_lead,lead.samples FROM supplier_items si JOIN suppliers v ON v.workspace_id=si.workspace_id AND v.id=si.supplier_id
 LEFT JOIN stockchief_runtime.supplier_planning_leads lead ON lead.workspace_id=si.workspace_id AND lead.supplier_item_id=si.id
 WHERE si.workspace_id=$1 AND si.sku_id=ANY($2::text[]) AND si.is_active=1 AND v.status='active' ORDER BY si.sku_id,si.supplier_id,si.id`,[ctx.workspaceId,ids])).rows;
 const currencies=[...new Set(offers.map(o=>o.currency))],costEvidence=selection?await comparisonTerms.load(c,ctx,offers.map(o=>o.id),{comparisonCurrency:args.comparisonCurrency||(currencies.length===1?currencies[0]:null),lock:ctx.comparisonFactsLock===true}):null;
 const knownOffers=(await c.query(`SELECT si.id FROM supplier_items si JOIN suppliers v ON v.workspace_id=si.workspace_id AND v.id=si.supplier_id
 JOIN LATERAL(SELECT o.currency,l.unit_cost,l.units_per_purchase_unit FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
 WHERE l.workspace_id=si.workspace_id AND l.sku_id=si.sku_id AND o.supplier_id=si.supplier_id
 AND o.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED') ORDER BY coalesce(o.approved_at,o.ordered_at,o.created_at)::timestamptz DESC,o.id DESC,l.line_number DESC LIMIT 1) prior ON true
 WHERE si.workspace_id=$1 AND si.sku_id=ANY($2::text[]) AND si.is_active=1 AND prior.currency=v.currency AND prior.unit_cost=si.last_unit_cost AND prior.units_per_purchase_unit=si.units_per_purchase_unit ORDER BY si.id`,[ctx.workspaceId,ids])).rows.map(o=>o.id);
 const open=(await c.query(`SELECT l.id,l.sku_id,coalesce(l.destination_location_id,o.destination_location_id) location_id,o.id order_id,o.po_number,o.status,o.expected_date,o.source,
 (l.quantity_units-l.quantity_received_units)::text remaining,to_jsonb(l)->>'supplier_supply_hold_id' AS supply_hold
 FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
 WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND l.quantity_units>l.quantity_received_units
 AND coalesce(to_jsonb(o)->>'delivery_kind','WAREHOUSE')='WAREHOUSE'
 AND o.status IN ('DRAFT','AWAITING_APPROVAL','APPROVED','ORDERED','PARTIALLY_RECEIVED') ORDER BY o.id,l.id`,[ctx.workspaceId,ids])).rows;
 const heldNotices=[...new Set(open.map(line=>line.supply_hold).filter(Boolean))];
 const reviewedBackups=heldNotices.length?(await c.query(`SELECT trigger_key,facts->'terms'->>'skuId' AS sku_id,
  facts->'terms'->>'locationId' AS location_id,facts->'terms'->>'backupSupplierId' AS supplier_id
  FROM stockchief_runtime.agent_backup_supplier_runs WHERE workspace_id=$1 AND trigger_key=ANY($2::text[])
  ORDER BY id`,[ctx.workspaceId,heldNotices.map(id=>'notice:'+id)])).rows:[];
 const transfers=(await c.query(`SELECT l.id,l.sku_id,t.destination_location_id location_id,t.id order_id,t.reference po_number,t.status,t.expected_arrival_date expected_date,
 (CASE t.status WHEN 'REQUESTED' THEN l.requested_quantity WHEN 'APPROVED' THEN l.approved_quantity WHEN 'PICKED' THEN l.picked_quantity ELSE l.shipped_quantity-l.received_quantity-l.lost_quantity-l.damaged_quantity END)::text remaining
 FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.workspace_id=l.workspace_id AND t.id=l.transfer_id WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[])
 AND t.status IN ('REQUESTED','APPROVED','PICKED','SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED') ORDER BY t.id,l.id`,[ctx.workspaceId,ids])).rows;
 const usable=await require('../domain/postgres-kit-availability').stock(c,ctx.workspaceId,ids);
 const valuation=(await c.query('SELECT sku_id,location_id,quantity_units::text,total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) ORDER BY sku_id,location_id',[ctx.workspaceId,ids])).rows;
 const components=(await c.query("SELECT DISTINCT kit_sku_id FROM kit_components WHERE workspace_id=$1 AND kit_sku_id=ANY($2::text[]) AND stock_basis='components'",[ctx.workspaceId,ids])).rows;
 const groupSku=records=>{
  const result=new Map();
  for(const row of records){
   if(!result.has(row.sku_id))result.set(row.sku_id,[]);
   result.get(row.sku_id).push(row);
  }
  return result;
 };
 const offersBySku=groupSku(offers),openBySku=groupSku(open),transfersBySku=groupSku(transfers),valueBySku=groupSku(valuation);
 const componentIds=new Set(components.map(row=>row.kit_sku_id));
 const measures=new Map(args.secondaryQuantities.split('\n').filter(Boolean).map(line=>{
  const [sku,location,quantity,weight]=line.split('|').map(s=>s.trim());
  return [JSON.stringify([sku,location]),{quantity,weight}];
 }));
 const rows=[];
 for(const p of source){
  try{
  const profile=byId.get(p.sku_id),scope=p.location_id?[p.location_id]:p.receivingOptions.map(l=>l.id);
  const pending=[...(openBySku.get(p.sku_id)||[]),...(transfersBySku.get(p.sku_id)||[])].filter(l=>scope.includes(l.location_id));
  const drafts=pending.filter(l=>['DRAFT','AWAITING_APPROVAL'].includes(l.status)),uncertain=pending.filter(l=>!['DRAFT','AWAITING_APPROVAL'].includes(l.status)&&(l.supply_hold||!l.expected_date||l.expected_date<today));
  const timely=pending.filter(l=>!l.supply_hold&&!['DRAFT','AWAITING_APPROVAL'].includes(l.status)&&l.expected_date&&l.expected_date>=today&&(!throughDate||l.expected_date<=throughDate));
  const incoming=timely.reduce((n,l)=>exact.add(n,l.remaining),'0');
  const datedIncoming=incoming;
  const rawAvailable=p.location_id?String(usable.get(stock.key(p.sku_id,p.location_id))||0):scope.reduce((n,l)=>exact.add(n,String(usable.get(stock.key(p.sku_id,l))||0)),'0');
  const projected=exact.add(rawAvailable,datedIncoming),shortage=p.effectiveReorder!==null&&Number(projected)<=p.effectiveReorder;
  const measure=measures.get(JSON.stringify([p.code,p.location_name]));
  const derived=shortage?exact.subtract(String(p.targetStock??p.effectiveReorder),projected):'0';
  const needed=collect?derived:measure?.quantity||args.quantity||derived;
  if(!positive(needed))continue;
  if(p.lead_time_assumed&&p.reorderPoint===null)throw new ValidationError('Record a supplier lead time before deriving the reorder target for '+p.code+'.');
  const candidates=[];
  for(const offer of offersBySku.get(p.sku_id)||[]){
   try{const rounded=pack(offer,needed,profile);if(profile.secondary_unit_label){if(!measure||exact.canonical(rounded.quantity)!==measure.quantity)throw new ValidationError('Supply exact requested pieces and their independent weight, matching the supplier pack for '+p.code+'.');rounded.secondaryQuantity=String(quantities.secondary(profile,measure.weight));rounded.totalMinor=exact.costMinor(rounded.secondaryQuantity,rounded.unitCostMinor);}candidates.push({...offer,...rounded,leadDays:offer.effective_lead==null?null:Number(offer.effective_lead)});}catch(error){if(!(error instanceof ValidationError))throw error;candidates.push({...offer,blocked:error.message});}
  }
  if(selection)for(const o of candidates.filter(o=>!o.blocked&&o.totalMinor!==null)){
   if(o.minimum_order_amount!=null&&o.totalMinor<money.toMinor(String(o.minimum_order_amount),o.currency)){o.ineligible='This standalone product request does not meet the supplier’s recorded minimum order value.';continue;}
   try{const target=costEvidence.target;if(!target)throw new ValidationError('Choose a comparison currency and record a current owner-approved exchange quote for different currencies.');const rate=comparisonTerms.rateFor(costEvidence,o.currency,target),context={today,ownerAccountId:costEvidence.ownerAccountId};
    o.comparison=args.comparisonBasis==='goods'?{currency:o.currency,recordedGoodsMinor:o.totalMinor,comparisonCurrency:target,comparisonMinor:economic.convert(o.totalMinor,o.currency,target,rate,context).minor,goodsOnly:true,rate:economic.convert(o.totalMinor,o.currency,target,rate,context).rate}:economic.calculate(o,o,costEvidence.terms.find(t=>t.supplier_item_id===o.id&&t.location_id===(p.location_id||scope[0])),target,rate,context);
   }catch(error){if(!(error instanceof ValidationError))throw error;o.comparisonProblem=error.message;}
  }
  const eligible=candidates.filter(o=>!o.blocked&&o.totalMinor!==null&&!o.ineligible);
  let chosen;
  if(selection){
   if(candidates.some(o=>o.blocked||o.totalMinor===null))throw new ValidationError('Resolve missing cost, pack or measured-price evidence before ranking '+p.code+'.');
   if(!eligible.length)throw new ValidationError('No eligible standalone supplier request meets the recorded minimums for '+p.code+'. Review a grouped purchase separately.');
   if(eligible.some(o=>o.comparisonProblem))throw new ValidationError('Supplier comparison for '+p.code+' needs review: '+eligible.filter(o=>o.comparisonProblem).map(o=>o.supplier_name+': '+o.comparisonProblem).join('; '));
   if(args.strategy==='fastest'&&eligible.some(o=>o.leadDays===null))throw new ValidationError('Record delivery lead times for every eligible supplier before choosing the fastest for '+p.code+'.');
   chosen=[...eligible].sort((a,b)=>args.strategy==='fastest'?(a.leadDays-b.leadDays||a.comparison.comparisonMinor-b.comparison.comparisonMinor||a.supplier_id.localeCompare(b.supplier_id)):(a.comparison.comparisonMinor-b.comparison.comparisonMinor||(a.leadDays??Infinity)-(b.leadDays??Infinity)||a.supplier_id.localeCompare(b.supplier_id)))[0];
  }else{
   const saved=candidates.filter(o=>p.preferred_supplier_id?o.supplier_id===p.preferred_supplier_id:Number(o.is_preferred)===1);
   chosen=saved.length===1?saved[0]:candidates.length===1?candidates[0]:null;
  }
  if(!chosen||chosen.blocked)throw new ValidationError(chosen?.blocked||'Choose one saved supplier for '+p.code+' or use the eligible supplier selection job first.');
  if(componentIds.has(p.sku_id))throw new ValidationError('Use the kit’s missing-parts reorder workflow for '+p.code+'; a component kit cannot be purchased as an ordinary finished-stock reorder.');
  if(drafts.length)throw new ValidationError('Review existing unsent purchase '+drafts.map(l=>l.po_number).join(', ')+' for '+p.code+' before creating another draft.');
  const unresolved=uncertain.filter(line=>!line.supply_hold||!reviewedBackups.some(run=>
   run.trigger_key==='notice:'+line.supply_hold&&run.sku_id===line.sku_id&&run.location_id===line.location_id&&run.supplier_id===chosen.supplier_id));
  if(unresolved.length)throw new ValidationError('Check supplier availability for '+unresolved.map(l=>l.po_number).join(', ')+' before making another purchase for '+p.code+'.');
  if(!p.location_id&&scope.length!==1)throw new ValidationError('Choose a receiving location for the inventory-wide reorder of '+p.code+'.');
  if(p.onHand<0)throw new ValidationError('Resolve negative stock before reordering '+p.code+'.');
  const uncosted=(valueBySku.get(p.sku_id)||[]).filter(v=>scope.includes(v.location_id));
  if(p.onHand>0&&(!uncosted.length||uncosted.reduce((n,v)=>n+Number(v.quantity_units),0)<p.onHand))throw new ValidationError('Complete the recorded stock cost for '+p.code+' before its reorder can run.');
  rows.push({position:p,profile,available:rawAvailable,incoming:datedIncoming,needed,candidates,chosen,knownTerms:knownOffers.includes(chosen.id),locationId:p.location_id||scope[0],
   ...(collect?{datedIncomingRecords:timely.map(({order_id,po_number,expected_date,remaining})=>({id:order_id,reference:po_number,date:expected_date,quantity:remaining}))}:{})});
  }catch(error){hold(p,error);}
 }
 if(!rows.length&&!collect)throw new ValidationError('Available and dated incoming stock already cover the selected reorder targets.');
 const sourceOrders=open.map(({supply_hold,...line})=>supply_hold?{...line,supply_hold}:line);
 return {rows,held,today,costEvidence,source:{today,requested,recipes,positions:source,profiles,offers,knownOffers,open:sourceOrders,...(reviewedBackups.length?{reviewedBackups}:{}),transfers,valuation,usable:[...usable],components,...(selection?{comparisonBasis:args.comparisonBasis,goodsOnlyReason:args.goodsOnlyReason,costEvidence}:{})}};
}
function lineSummary(l,rows,currency){
 const row=rows.find(r=>r.position.sku_id===l.skuId&&r.locationId===l.destinationLocationId),profile=row.profile;
 const measure=l.secondaryQuantity?'; '+l.secondaryQuantity+' '+profile.secondary_unit_label+' requested independently':'';
 return l.quantityUnits+' '+profile.unit_label+' × '+l.skuCode+measure+' → '+row.position.location_name+
  ' · '+l.quantityPurchaseUnits+' '+l.purchaseUnit+' of '+l.unitsPerPurchaseUnit+' '+profile.unit_label+
  ' · Minimum '+row.chosen.minimum_order_quantity+' purchase units; multiple '+row.chosen.order_multiple+
  ' · '+money.format(row.chosen.totalMinor,currency)+' goods'+(l.leadDays===null?' · Delivery time unknown':' · '+l.leadDays+' delivery days');
}
async function review(c,ctx,{filter='',page=1}){
 const products=(await c.query(`SELECT i.*,s.id,s.code,s.item_id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ($2='' OR lower(s.code)=lower($2) OR lower(i.name)=lower($2)) ORDER BY s.code,s.id LIMIT 26 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*25])).rows;
 const selected=products.slice(0,25),ids=selected.map(p=>p.id),positions=await require('../forecasting/postgres-planning-service').position(c,ctx.workspaceId,{onlySkuIds:ids});
 const offers=(await c.query(`SELECT si.*,v.name supplier_name,v.currency,v.minimum_order_amount,v.payment_terms,v.freight_terms_currency,v.free_freight_threshold_minor,v.ordinary_freight_minor,lead.effective_lead FROM supplier_items si JOIN suppliers v ON v.workspace_id=si.workspace_id AND v.id=si.supplier_id
 LEFT JOIN stockchief_runtime.supplier_planning_leads lead ON lead.workspace_id=si.workspace_id AND lead.supplier_item_id=si.id WHERE si.workspace_id=$1 AND si.sku_id=ANY($2::text[]) AND si.is_active=1 AND v.status='active' ORDER BY si.sku_id,si.id`,[ctx.workspaceId,ids])).rows;
 const evidence=await comparisonTerms.load(c,ctx,offers.map(o=>o.id)),today=await require('../lib/business-time').today(c,ctx.workspaceId),rows=[];
 for(const product of selected){const p=positions.filter(p=>p.sku_id===product.id&&!p.planning_suppressed);for(const position of p.length?p:[null]){
  const need=position?.shortage?require('./replenishment-decision').requiredUnits(position):0,quantity=positive(need)?String(need):'1';
  const productOffers=offers.filter(o=>o.sku_id===product.id),currencies=[...new Set(productOffers.map(o=>o.currency))],target=currencies.length===1?currencies[0]:evidence.target;
  const compared=productOffers.map(o=>{let q,error,delivered;try{q=pack(o,quantity,product);if(q.totalMinor===null)throw new ValidationError('Independent requested weight is required');if(o.minimum_order_amount!=null&&q.totalMinor<money.toMinor(String(o.minimum_order_amount),o.currency))throw new ValidationError('Standalone request is below the supplier minimum');if(!position?.location_id)throw new ValidationError('Choose an exact receiving site before comparing delivered costs');if(!target)throw new ValidationError('Confirm a comparison currency and current exchange quote');delivered=economic.calculate(o,q,evidence.terms.find(t=>t.supplier_item_id===o.id&&t.location_id===position.location_id),target,comparisonTerms.rateFor(evidence,o.currency,target),{today,ownerAccountId:evidence.ownerAccountId});}catch(e){if(!(e instanceof ValidationError))throw e;error=e.message;}return {o,q,error,delivered};});
  for(const {o,q,error,delivered} of compared){const valid=compared.filter(r=>!r.error),priced=compared.filter(r=>r.q?.totalMinor!=null&&r.o.currency===o.currency),unknown=compared.some(r=>r.error);
   rows.push({SKU:product.code,Supplier:o.supplier_name,Warehouse:position?.location_name||'No recorded stock',Currency:o.currency,'Unit price':o.last_unit_cost,'Lead days':o.effective_lead==null?null:String(o.effective_lead),
    'Compared quantity':quantity,Unit:product.unit_label,'Purchase quantity':q?.quantity??null,'Pack size':o.units_per_purchase_unit,'Minimum quantity':o.minimum_order_quantity,
    'Goods total':q?.totalMinor==null?null:money.format(q.totalMinor,o.currency),'Goods-only reference rank':q?.totalMinor==null?null:1+priced.filter(r=>r.q.totalMinor<q.totalMinor).length,'Delivered economic cost':delivered?money.format(delivered.comparisonMinor,delivered.comparisonCurrency):null,'Cost rank':error||unknown?null:1+valid.filter(r=>r.delivered.comparisonMinor<delivered.comparisonMinor).length,
    'Speed rank':o.effective_lead==null||error?null:1+valid.filter(r=>r.o.effective_lead!=null&&Number(r.o.effective_lead)<Number(o.effective_lead)).length,
    Status:error||(!need?'Reference quantity; no reorder quantity established':unknown?'Some competing supplier facts need review':'Current applicable delivery, tax and recovery evidence'),link:'/autopilot/supplier-costs?offer='+encodeURIComponent(o.id)+(position?.location_id?'&location='+encodeURIComponent(position.location_id):'')});
  }
 }}
 rows.sort((a,b)=>a.SKU.localeCompare(b.SKU)||a.Warehouse.localeCompare(b.Warehouse)||a.Currency.localeCompare(b.Currency)||(a['Cost rank']??Infinity)-(b['Cost rank']??Infinity)||(Number(a['Lead days']??Infinity)-Number(b['Lead days']??Infinity))||a.Supplier.localeCompare(b.Supplier));
 return {rows,more:products.length>25,supplierSelection:true,summary:'Compare standalone product/site requests using actual rounded packs and eligible minimums, applicable delivery charges and nonrecoverable costs after tax recovery. Checked current exchange quotes permit comparable currencies. Missing or stale facts withhold the delivered cost rank; goods-only figures are labelled reference prices and need an explicit owner choice before selection. Delivery ranks use recorded lead times. Reference quantities do not establish a reorder need. Buying and sending retain separate authority.'};
}
function comparisonProof(row,args,facts){return {basis:args.comparisonBasis,currency:facts.costEvidence.target,goodsOnlyReason:args.goodsOnlyReason,candidates:row.candidates.map(o=>{
 const t=facts.costEvidence.terms.find(t=>t.supplier_item_id===o.id&&t.location_id===row.locationId),rate=o.comparison?.rate;return [o.id,o.ineligible||null,args.comparisonBasis==='economic'&&t?[t.offer_fingerprint,t.minimum_quantity,t.maximum_quantity,t.minimum_secondary_quantity,t.maximum_secondary_quantity,t.goods_price_basis,t.goods_tax_percent,t.freight_mode,t.fixed_freight_minor,t.freight_threshold_basis,t.freight_price_basis,t.freight_tax_percent,t.goods_recoverable_tax_percent,t.freight_recoverable_tax_percent,t.other_charges_minor]:null,rate?[rate.foreign,rate.comparison,rate.comparisonPerForeign,rate.inverse]:null];})};}
function comparisonSummary(f,args){return (args.comparisonBasis==='goods'?'Owner explicitly requested goods-only comparison: '+args.goodsOnlyReason+'\n':'Delivered economic cost includes applicable shipping, nonrecoverable charges and taxes after recovery.\n')+'Each total quotes this product delivered on its own to the stated site. Recalculate a combined purchase before ordering.\n'+f.rows.map(r=>r.position.code+' → '+r.position.location_name+'\n'+r.candidates.map(o=>{
 if(o.ineligible)return o.supplier_name+' · Ineligible: '+o.ineligible;const q=o.comparison,c=o.currency,converted=c!==q.comparisonCurrency?' · '+money.format(q.comparisonMinor,q.comparisonCurrency)+' at checked '+q.rate.comparisonPerForeign+' '+q.rate.comparison+'/'+q.rate.foreign+(q.rate.inverse?' (inverse direction used)':'')+' · '+q.rate.source+' · valid '+q.rate.validFrom+' to '+q.rate.validUntil:'';
 return o.supplier_name+' · '+o.quantity+' '+r.profile.unit_label+' · Goods '+money.format(o.totalMinor,c)+(q.goodsOnly?' · Goods-only comparison '+money.format(q.comparisonMinor,q.comparisonCurrency):' · Delivery '+money.format(q.freightMinor,c)+' · Goods/freight tax '+money.format(money.sum([q.goodsTaxMinor,q.freightTaxMinor]),c)+' · Recoverable tax '+money.format(q.recoverableTaxMinor,c)+' · Other nonrecoverable charges '+money.format(q.otherChargesMinor,c)+' · Payable '+money.format(q.payableMinor,c)+' · Economic cost '+money.format(q.economicMinor,c)+' · '+q.source+' · valid '+q.validFrom+' to '+q.validUntil)+converted+(o.supplier_id===r.chosen.supplier_id?' · Selected':'');
 }).join('\n')).join('\n');}
async function build(c,ctx,_r,args,{selection=false}={}){
 await owner(c,ctx);const job=selection?22:19;await policy.requireWorkspaceJob(c,ctx.workspaceId,job,'draft');
 const request=input(args,selection),f=await facts(c,ctx,request,selection),groups=new Map();
 const packJob=!selection&&f.rows.some(r=>r.chosen.packJob),minimumJob=!selection&&f.rows.some(r=>r.chosen.minimumApplied);
 if(packJob)await policy.requireWorkspaceJob(c,ctx.workspaceId,27,'draft');if(minimumJob)await policy.requireWorkspaceJob(c,ctx.workspaceId,23,'draft');
 for(const r of f.rows){const o=r.chosen,key=o.supplier_id+'|'+o.currency;if(!groups.has(key))groups.set(key,{supplierId:o.supplier_id,supplierName:o.supplier_name,currency:o.currency,lines:[],totalMinor:0});const g=groups.get(key);
 g.lines.push({skuId:r.position.sku_id,skuCode:r.position.code,destinationLocationId:r.locationId,quantityUnits:o.quantity,quantityPurchaseUnits:o.purchaseUnits,unitsPerPurchaseUnit:o.units_per_purchase_unit,purchaseUnit:o.purchase_unit,unitCost:o.last_unit_cost,secondaryQuantity:o.secondaryQuantity,supplierSku:o.supplier_sku,policyId:r.position.policy_id,leadDays:o.leadDays,...(selection?{comparison:o.comparison}:{})});g.totalMinor=money.sum([g.totalMinor,o.totalMinor]);}
 const output=[...groups.values()],currencies=[...new Set(output.map(g=>g.currency))];
 const termFingerprints=[...new Set(f.rows.map(r=>{const o=r.chosen;return hash([o.supplier_id,r.position.sku_id,o.currency,String(o.last_unit_cost),String(o.units_per_purchase_unit),o.purchase_unit,String(o.minimum_order_quantity),String(o.order_multiple),o.minimum_order_amount,o.payment_terms,o.freight_terms_currency,o.free_freight_threshold_minor,o.ordinary_freight_minor,o.lead_time_days,o.default_lead_time_days,...(selection?[comparisonProof(r,request,f)]:[])]);}))].sort();
 const reviewed=new Set((await c.query(`SELECT DISTINCT jsonb_array_elements_text(p.payload->'termFingerprints') fingerprint FROM stockchief_runtime.assistant_action_proposals p
 JOIN users u ON u.workspace_id=p.workspace_id AND u.id=p.actor_user_id JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
 WHERE p.workspace_id=$1 AND p.action_type=ANY($2::text[]) AND p.status='EXECUTED' AND p.result->>'automatic'='false'
 AND p.payload->'termFingerprints' ?| $3::text[]`,[ctx.workspaceId,[DRAFT,SELECT],termFingerprints])).rows.map(r=>r.fingerprint));
 for(const g of output){const offer=f.rows.find(r=>r.chosen.supplier_id===g.supplierId).chosen;if(offer.minimum_order_amount!=null&&g.totalMinor<money.toMinor(String(offer.minimum_order_amount),g.currency))throw new ValidationError('The grouped '+g.supplierName+' draft is below its saved minimum order value. Review quantities before purchasing.');}
 // Currency totals stay separate. Multi-currency work is individually reviewed
 // rather than inventing a conversion for the trained monetary ceiling.
 const amount=selection?money.sum(f.rows.map(r=>r.chosen.comparison.comparisonMinor)):currencies.length===1?money.sum(output.map(g=>g.totalMinor)):0;
 const qualification=f.rows.map(r=>[r.position.sku_id,r.locationId,r.chosen.supplier_id,r.chosen.currency,String(r.chosen.last_unit_cost),String(r.chosen.units_per_purchase_unit),selection?request.strategy:'saved',r.chosen.secondaryQuantity??null,r.candidates.map(o=>[o.supplier_id,o.currency,o.last_unit_cost,o.units_per_purchase_unit,o.minimum_order_quantity,o.order_multiple])]);
 if(selection)qualification.push(f.rows.map(r=>comparisonProof(r,request,f)));
 const trainingCurrency=selection?f.costEvidence.target:currencies.length===1?currencies[0]:null;
 const training=trainingCurrency?require('../autopilot/draft-authority').scope('reorder',trainingCurrency,amount,qualification,selection?'Choose '+request.strategy+' suppliers for these exact standalone product/site requests by '+(request.comparisonBasis==='goods'?'explicitly requested goods-only cost':'delivered economic cost'):'Group these products and receiving locations into supplier drafts with their exact saved pack and minimum terms'):null;
 return {payload:{args:request,sourceFingerprint:hash(f.source),output,training,termFingerprints,packJob,minimumJob,kitDerived:f.rows.some(r=>r.position.kitDerived),needsPurchaseTermsConfirmation:(!selection&&currencies.length!==1)||termFingerprints.some(fp=>!reviewed.has(fp))||f.rows.some(r=>!r.knownTerms)},summary:(selection?'Select '+request.strategy+' saved eligible suppliers by '+(request.comparisonBasis==='goods'?'explicitly requested goods-only cost':'delivered economic cost'):'Create '+output.length+' unsent supplier draft'+(output.length===1?'':'s'))+'.\n'+output.map(g=>{const o=f.rows.find(r=>r.chosen.supplier_id===g.supplierId).chosen;return g.supplierName+' · '+g.currency+' '+money.format(g.totalMinor,g.currency)+' goods · Minimum order '+(o.minimum_order_amount==null?'not recorded':money.format(money.toMinor(String(o.minimum_order_amount),g.currency),g.currency))+' · Payment terms: '+(o.payment_terms||'not recorded')+' · Recorded shipping: '+(o.freight_terms_currency===g.currency&&o.ordinary_freight_minor!=null?money.format(o.ordinary_freight_minor,g.currency):'not recorded')+'; free from '+(o.freight_terms_currency===g.currency&&o.free_freight_threshold_minor!=null?money.format(o.free_freight_threshold_minor,g.currency):'not recorded')+'\n'+g.lines.map(l=>lineSummary(l,f.rows,g.currency)).join('\n');}).join('\n')+(selection?'\n'+comparisonSummary(f,request):'')+'\nNo order is sent, stock changed or money posted.'};
}
function spec(selection){return {name:selection?SELECT:DRAFT,agentJob:selection?22:19,ownerOnly:true,permission:require('../actions/permissions').CREATE_PO,capability:'purchasing.core',fields:selection?['skuCodes','sku','location','strategy','quantity','secondaryQuantities','comparisonBasis','comparisonCurrency','goodsOnlyReason']:['skuCodes','sku','location','secondaryQuantities'],description:selection?'Choose the cheapest or fastest eligible saved supplier for exact SKU codes and receiving locations. Default to comparable delivered economic cost: exact rounded goods, applicable freight, nonrecoverable charges and tax recovery. Current owner-checked exchange quotes permit cross-currency comparison. Unknown or stale evidence needs review. Goods-only requires an explicit owner request. Preserve unknown or overdue evidence for owner review. This changes the reorder supplier only; it creates and sends no PO.':'Prepare the current reorder list as native unsent purchase drafts grouped by the saved supplier and currency, preserving every receiving location, exact stock quantity, supplier pack and price. Omit skuCodes for all current reorders. Never approve, send, receive or pay.',
 build:(c,ctx,r,args)=>build(c,ctx,r,args,{selection}),execute:async(c,ctx,p)=>{
 await owner(c,ctx,true);await c.query("SELECT pg_advisory_xact_lock(hashtextextended('agent-reorder:'||$1,0))",[ctx.workspaceId]);
  await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
  const automatic=ctx.agentReorderAutomatic===true,name=selection?SELECT:DRAFT,account=await policy.requireWorkspaceJob(c,ctx.workspaceId,selection?22:19,automatic?'automatic':'draft',{trained:automatic&&await require('../autopilot/draft-authority').trained(c,ctx.workspaceId,name,p)});
  const stop=await policy.stopped(c,ctx.workspaceId,account,name,automatic,p);if(stop)throw new ValidationError(stop);
  if(p.kitDerived){await policy.requireWorkspaceJob(c,ctx.workspaceId,13,automatic?'automatic':'draft');const kitStop=await require('../autopilot/job-modes').restriction(c,ctx.workspaceId,13,automatic);if(kitStop)throw new ValidationError(kitStop);}
  for(const job of [...(p.packJob?[27]:[]),...(p.minimumJob?[23]:[])]){await policy.requireWorkspaceJob(c,ctx.workspaceId,job,automatic?'automatic':'draft',{trained:automatic&&await require('../autopilot/draft-authority').trained(c,ctx.workspaceId,name,p)});const extraStop=await require('../autopilot/job-modes').restriction(c,ctx.workspaceId,job,automatic);if(extraStop)throw new ValidationError(extraStop);}
  if(automatic&&(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate||policy.needsPerson(name,p,account)))throw new ValidationError('Enable current owner authority and individually confirm new supplier or price terms before automatic purchasing preparation.');
  const current=await build(c,{...ctx,comparisonFactsLock:true},null,p.args,{selection});if(current.payload.sourceFingerprint!==p.sourceFingerprint||hash(current.payload.output)!==hash(p.output))throw new ValidationError('Stock, reservations, incoming deliveries or supplier terms changed. Review the current reorder list again.');
  if(automatic&&policy.needsPerson(name,current.payload,account))throw new ValidationError('Individually confirm current supplier, price and comparison terms before routine purchasing preparation.');
  if(selection){const changes=[];for(const g of p.output)for(const l of g.lines){if(l.policyId){const r=await c.query('UPDATE reorder_policies SET preferred_supplier_id=$3,updated_at=now()::text WHERE workspace_id=$1 AND id=$2 RETURNING id',[ctx.workspaceId,l.policyId,g.supplierId]);if(!r.rowCount)throw new ValidationError('The saved reorder policy changed.');changes.push({policyId:l.policyId,supplierId:g.supplierId});}else{const id=require('../lib/util').newId('rp');await c.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,preferred_supplier_id,source,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'foundry',now()::text,now()::text)`,[id,ctx.workspaceId,l.skuId,l.destinationLocationId,g.supplierId]);changes.push({policyId:id,supplierId:g.supplierId});}}
   await require('../operations/postgres-security-audit').record(c,ctx,{action:'Selected eligible reorder suppliers',after:{strategy:p.args.strategy,changes,evidence:p.sourceFingerprint}});return {changes,automatic};}
  const drafts=[];for(const [index,g] of p.output.entries()){const dated=g.lines.filter(l=>l.leadDays!==null),expectedDate=dated.length===g.lines.length?require('../accounting/customer-money').addDays(await require('../lib/business-time').today(c,ctx.workspaceId),Math.max(...dated.map(l=>l.leadDays))):null;
   const created=await require('../operations/postgres-business-workflows').createPurchaseOrderInTransaction(c,ctx,{supplierId:g.supplierId,currency:g.currency,destinationLocationId:new Set(g.lines.map(l=>l.destinationLocationId)).size===1?g.lines[0].destinationLocationId:null,expectedDate,lines:g.lines,source:'foundry_recommendation',sourceDetail:{kind:'grouped_reorder',sourceFingerprint:p.sourceFingerprint},idempotencyKey:p.idempotencyKey+':'+index});drafts.push(created.purchaseOrderId);}
  return {drafts,automatic};
 },verify:(c,ctx,r,p)=>verify(c,ctx,r,p,selection)};}
async function verify(c,ctx,r,p,selection){
 if(selection){const found=await c.query('SELECT id,preferred_supplier_id FROM reorder_policies WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,r.changes.map(x=>x.policyId)]);return found.rowCount===r.changes.length&&found.rows.every(v=>r.changes.some(x=>x.policyId===v.id&&x.supplierId===v.preferred_supplier_id));}
 if(r.drafts.length!==p.output.length)return false;
 const orders=(await c.query('SELECT id,status,supplier_id,currency FROM purchase_orders WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,r.drafts])).rows;
 const lines=(await c.query('SELECT * FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=ANY($2::text[]) ORDER BY purchase_order_id,line_number',[ctx.workspaceId,r.drafts])).rows;
 return p.output.every((g,index)=>{const id=r.drafts[index],o=orders.find(o=>o.id===id),saved=lines.filter(l=>l.purchase_order_id===id);return o?.status==='DRAFT'&&o.supplier_id===g.supplierId&&o.currency===g.currency&&saved.length===g.lines.length&&money.sum(saved.map(l=>money.toMinor(String(l.line_total),g.currency)))===g.totalMinor&&g.lines.every((l,i)=>{const v=saved[i];return v.sku_id===l.skuId&&v.destination_location_id===l.destinationLocationId&&exact.canonical(v.quantity_units)===exact.canonical(l.quantityUnits)&&exact.canonical(v.quantity_purchase_units)===exact.canonical(l.quantityPurchaseUnits)&&exact.canonical(v.units_per_purchase_unit)===exact.canonical(l.unitsPerPurchaseUnit)&&money.toMinor(String(v.unit_cost),g.currency)===money.toMinor(String(l.unitCost),g.currency)&&(l.secondaryQuantity==null?v.secondary_quantity_ordered==null:exact.canonical(v.secondary_quantity_ordered)===exact.canonical(l.secondaryQuantity));});});
}
module.exports={DRAFT,SELECT,input,pack,facts,build,review,spec,verify,specs:[spec(false),spec(true)]};
