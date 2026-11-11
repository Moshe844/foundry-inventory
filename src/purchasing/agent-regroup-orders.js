'use strict';
const {ValidationError}=require('../domain/errors');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');
const policy=require('../commercial/agent-plan');
const workflows=require('../operations/postgres-business-workflows');
const {hash}=require('../pricing/postgres-promotions');
const freight=require('./regroup-freight');
const {newId,nowIso}=require('../lib/util');

async function sources(db,ctx,refs,lock){
  const result=await db.query(`SELECT * FROM purchase_orders WHERE workspace_id=$1 AND po_number=ANY($2::text[]) ORDER BY id `+(lock?'FOR UPDATE':''),
    [ctx.workspaceId,refs]);
  if(result.rowCount!==refs.length||result.rows.some(o=>o.status!=='DRAFT'))throw new ValidationError('Choose only current, unsent draft purchase orders in this inventory.');
  const orders=result.rows,ids=orders.map(o=>o.id);
  const {rows:lines}=await db.query(`SELECT l.*,s.code AS sku_code,d.name AS destination_name,si.order_multiple,si.minimum_order_quantity FROM purchase_order_lines l
    LEFT JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id LEFT JOIN locations d ON d.workspace_id=l.workspace_id AND d.id=l.destination_location_id
    LEFT JOIN supplier_items si ON si.workspace_id=l.workspace_id AND si.id=l.supplier_item_id
    WHERE l.workspace_id=$1 AND l.purchase_order_id=ANY($2::text[])
    ORDER BY l.purchase_order_id,l.line_number LIMIT 501 `+(lock?'FOR UPDATE OF l':''),[ctx.workspaceId,ids]);
  if(lines.length>500||orders.some(o=>!lines.some(l=>l.purchase_order_id===o.id)))throw new ValidationError('Choose draft orders with 1 to 500 lines in total.');
  if(lines.some(l=>l.unit_cost==null||l.line_total==null||Number(l.quantity_received_units)!==0))throw new ValidationError('Price each line and choose drafts without receipts.');
  if(lines.some(l=>!l.sku_code||!l.destination_name))throw new ValidationError('Resolve the product and receiving location on each draft line first.');
  if(orders.some(o=>o.supplier_id!==orders[0].supplier_id||o.currency!==orders[0].currency))throw new ValidationError('Choose orders for the same supplier and currency.');
  const {rows:charges}=await db.query(`SELECT * FROM purchase_order_charges
    WHERE workspace_id=$1 AND purchase_order_id=ANY($2::text[]) ORDER BY purchase_order_id,id `+(lock?'FOR UPDATE':''),
  [ctx.workspaceId,ids]);
  if(charges.some(c=>c.kind==='deposit'))throw new ValidationError('Review recorded deposits before replacing these purchase orders.');
  return {orders,lines,charges};
}
function lineInput(l){
  return {skuId:l.sku_id,supplierSku:l.supplier_sku,description:l.description,purchaseUnit:l.purchase_unit,unitsPerPurchaseUnit:l.units_per_purchase_unit,
    quantityPurchaseUnits:l.quantity_purchase_units,quantityUnits:l.quantity_units,unitCost:l.unit_cost,secondaryQuantity:l.secondary_quantity_ordered,
    destinationLocationId:l.destination_location_id,skuCode:l.sku_code,destinationName:l.destination_name,notes:l.notes,
    orderMultiple:Number(l.order_multiple||1),supplierMinimum:Number(l.minimum_order_quantity||0)};
}
function cost(line,currency){
  return exact.costMinor(line.secondaryQuantity??line.quantityUnits,money.toMinor(String(line.unitCost),currency));
}
function splitBudget(items,currency,amount){
  const cap=money.userToMinor(amount,currency);
  if(cap<=0)throw new ValidationError('Choose a positive maximum goods value for each PO.');
  const groups=[];let batch=[],balance=cap;
  function close(){
    if(batch.length)groups.push(batch);
    if(groups.length>=50)throw new ValidationError('This limit would create too many orders. Choose a larger amount or fewer lines.');
    batch=[];balance=cap;
  }
  for(const line of items){
    const value=cost(line,currency);
    if(value<=balance){batch.push(line);balance-=value;continue;}
    if(value<=cap){close();batch.push(line);balance-=value;continue;}
    const multiple=line.orderMultiple,perPack=exact.costMinor(line.unitsPerPurchaseUnit,money.toMinor(String(line.unitCost),currency));
    if(line.secondaryQuantity!=null||!Number.isSafeInteger(Number(line.quantityPurchaseUnits))||!Number.isSafeInteger(Number(line.unitsPerPurchaseUnit))||
        !Number.isSafeInteger(multiple)||multiple<=0||Number(line.quantityPurchaseUnits)%multiple||perPack<=0||perPack*multiple>cap)
      throw new ValidationError('A whole supplier pack or indivisible measured line exceeds the limit. Review the line or raise the maximum.');
    let remaining=Number(line.quantityPurchaseUnits);
    while(remaining){
      if(balance<perPack*multiple)close();
      const packs=Math.min(remaining,Math.floor(balance/(perPack*multiple))*multiple);
      batch.push({...line,quantityPurchaseUnits:packs,quantityUnits:exact.convert(packs,{numerator:line.unitsPerPurchaseUnit})});
      remaining-=packs;balance-=packs*perPack;
    }
  }
  if(batch.length)groups.push(batch);
  return groups.map(lines=>({lines}));
}
function grouped(items,key){
  const groups=new Map();
  for(const i of items){const k=key(i);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(i);}
  return [...groups].map(([value,lines])=>({value,lines}));
}
function dates(input,lines){
  let rules;try{rules=JSON.parse(input||'');}catch{throw new ValidationError('Assign one delivery date to each original line number.');}
  if(!Array.isArray(rules)||rules.length!==lines.length)throw new ValidationError('Assign each original line exactly once.');
  const assigned=new Map();
  for(const r of rules){
    if(!Number.isInteger(r?.line)||assigned.has(r.line)||!lines.some(l=>Number(l.line_number)===r.line))throw new ValidationError('Use each existing line number exactly once.');
    const date=String(r.date||'');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)
      throw new ValidationError('Enter a valid calendar date for each line.');
    assigned.set(r.line,date);
  }
  return assigned;
}
async function build(db,ctx,args,job,lock=false){
  const state=await policy.accountState(db,ctx.workspaceId);
  policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,job,'draft');
  const refs=String(args.sourceOrders||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(new Set(refs).size!==refs.length||refs.some(s=>s.length>160)||refs.length>20||(job===24?refs.length<2:refs.length!==1))
    throw new ValidationError(job===24?'Select two to twenty distinct draft PO numbers.':'Select one draft PO number to split.');
  const {orders,lines,charges}=await sources(db,ctx,refs,lock),o=orders[0],items=lines.map(lineInput);
  if(job===25&&charges.length)throw new ValidationError('Review how the saved charges apply to each new purchase before splitting this draft.');
  let groups;
  if(job===24){
    if(orders.some(x=>x.expected_date!==o.expected_date))throw new ValidationError('The orders have different expected delivery dates. Keep their separate supplier promises.');
    groups=[{lines:items}];
  }else if(args.splitStrategy==='warehouse'){
    groups=grouped(items,l=>l.destinationLocationId).map(g=>({lines:g.lines,location:g.value}));
  }else if(args.splitStrategy==='budget'){
    groups=splitBudget(items,o.currency,args.budgetAmount);
  }else if(args.splitStrategy==='delivery-date'){
    const assignments=dates(args.lineDates,lines);
    groups=grouped(lines,l=>assignments.get(Number(l.line_number))).map(g=>({lines:g.lines.map(lineInput),date:g.value}));
  }else throw new ValidationError('Choose a split by warehouse, delivery date or budget.');
  if(job===25&&(groups.length<2||groups.length>50))throw new ValidationError('Choose a split that produces two to fifty distinct purchase orders.');
  const total=money.sum(lines.map(l=>money.toMinor(String(l.line_total),o.currency)));
  const totals=groups.map(g=>money.sum(g.lines.map(l=>cost(l,o.currency))));
  if(money.sum(totals)!==total)throw new ValidationError('Currency rounding would change the total. Review the purchase lines.');
  const {rows:[vendor]}=await db.query(`SELECT name,currency,minimum_order_amount,freight_terms_currency,ordinary_freight_minor,free_freight_threshold_minor
    FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'`+(lock?' FOR SHARE':''),[ctx.workspaceId,o.supplier_id]);
  if(!vendor)throw new ValidationError('Choose drafts for an active supplier.');
  if(vendor?.minimum_order_amount>0&&(vendor.currency!==o.currency||totals.some(v=>v<money.toMinor(String(vendor.minimum_order_amount),o.currency))))
    throw new ValidationError('Review the supplier minimum order value before splitting or combining these orders.');
  for(const g of groups){
    for(const group of grouped(g.lines,l=>JSON.stringify([l.skuId,l.unitsPerPurchaseUnit]))){
      const count=group.lines.reduce((packs,l)=>exact.add(packs,l.quantityPurchaseUnits),'0');
      const terms=group.lines[0];
      if(Number(count)<terms.supplierMinimum||(terms.orderMultiple>1&&Number(count)%terms.orderMultiple!==0))
        throw new ValidationError('A proposed order would break the saved supplier minimum or pack multiple.');
    }
  }
  const shipping=job===24?freight.assess(orders,lines,charges,vendor):null;
  const output=groups.map(g=>({supplierId:o.supplier_id,currency:o.currency,expectedDate:g.date||o.expected_date,
    destinationLocationId:g.location||(new Set(g.lines.map(l=>l.destinationLocationId)).size===1?g.lines[0].destinationLocationId:null),
    reference:orders.length===1?o.reference:null,
    notes:orders.map(x=>[x.po_number,x.reference,x.notes].filter(Boolean).join(' · ')).join('\n'),lines:g.lines}));
  const original={orders:orders.map(x=>[x.id,x.updated_at,x.reference,x.notes,x.expected_date]),output};
  const key=hash({...original,charges,shipping:shipping?{...shipping,terms:vendor}:null});
  const legacyKey=!charges.length&&shipping?.before==null?hash(original):null;
  const request={sourceOrders:refs.join(','),...(job===25?{splitStrategy:args.splitStrategy}:{}),
    ...(args.splitStrategy==='budget'?{budgetAmount:args.budgetAmount}:{}),...(args.splitStrategy==='delivery-date'?{lineDates:args.lineDates}:{})};
  const training=require('../autopilot/draft-authority').scope(o.supplier_id,o.currency,total,
    [job,args.splitStrategy||null],vendor.name+' · '+(job===24?'combine draft orders':'split draft orders by '+args.splitStrategy));
  const shippingSummary=shipping?.saving>0?' Expected freight falls from '+money.format(shipping.before,o.currency)+' to '+
    money.format(shipping.after,o.currency)+' under the saved terms.':shipping?' Review freight before sending the replacement.':'';
  const retained=shipping?.charges.filter(charge=>charge.kind!=='freight'||!(shipping.saving>0))||[];
  const retainedSummary=retained.length?' Retained charges: '+retained.map(charge=>charge.label+' '+money.format(charge.amountMinor,o.currency)).join(', ')+'.':'';
  return {ids:orders.map(x=>x.id),output,shipping,total,legacyKey,payload:{args:request,reviewedHash:key,training},
    summary:'Replace '+refs.join(', ')+' with '+groups.length+' unsent draft purchase '+(groups.length===1?'order':'orders')+
      ' for '+money.format(total,o.currency)+' in goods.'+shippingSummary+retainedSummary+' '+groups.map((g,i)=>'Draft '+(i+1)+' · '+money.format(totals[i],o.currency)+
        ((g.date||o.expected_date)?' due '+(g.date||o.expected_date):'')+'\n'+g.lines.map(l=>l.quantityUnits+' × '+l.skuCode+' to '+l.destinationName+' ('+money.format(cost(l,o.currency),o.currency)+')').join('\n')).join('\n')};
}
async function apply(client,ctx,current,key,{automatic=false}={}){
  const {shipping}=current;
  const savedFreight=shipping?.saving>0?{site:shipping.site,supplierId:current.output[0].supplierId,
    currency:current.output[0].currency,beforeMinor:shipping.before,afterMinor:shipping.after,savedMinor:shipping.saving}:null;
  const drafts=[];
  for(const [index,input] of current.output.entries()){
    const created=await workflows.createPurchaseOrderInTransaction(client,ctx,{...input,source:'foundry_recommendation',
      sourceDetail:{sourcePurchaseOrderIds:current.ids,...(savedFreight?{freightConsolidation:savedFreight}:{})},
      idempotencyKey:key+':draft:'+index});
    for(const charge of shipping?.charges||[]){
      await client.query(`INSERT INTO purchase_order_charges(id,workspace_id,purchase_order_id,label,kind,amount_minor,source,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[newId('poch'),ctx.workspaceId,created.purchaseOrderId,
      charge.label,charge.kind,charge.amountMinor,charge.source,nowIso()]);
    }
    drafts.push(created.purchaseOrderId);
  }
  for(const id of current.ids)await workflows.cancelPurchaseOrderInTransaction(client,ctx,id,{reason:'Replaced by regrouped draft orders',
    idempotencyKey:key+':source:'+id});
  return {drafts,originals:current.ids,automatic,...(savedFreight?{freight:savedFreight}:{})};
}

function spec(job){
  return {name:job===24?'purchase_order.combine_drafts':'purchase_order.split_draft',description:job===24?
    'Combine two or more exact unsent draft PO numbers for the same supplier, currency and delivery date into one draft, preserving each product line. Supply comma-separated sourceOrders.':
    'Split one unsent draft purchase order by receiving warehouse, exact delivery dates for its line numbers, or a maximum goods value per PO. Preserve the quantity, packs and total price. Supply sourceOrders and splitStrategy.',
    fields:job===24?['sourceOrders']:['sourceOrders','splitStrategy','budgetAmount','lineDates'],permission:require('../actions/permissions').APPROVE_PO,
    capability:'purchasing.core',resultingRecords:['purchase_order'],build:async(db,ctx,_r,args)=>build(db,ctx,args,job),
    execute:async(client,ctx,p)=>{
      const current=await build(client,ctx,p.args,job,true);
      if((current.payload.reviewedHash!==p.reviewedHash&&(!current.legacyKey||current.legacyKey!==p.reviewedHash))||
          p.training&&hash(current.payload.training)!==hash(p.training))
        throw new ValidationError('The source drafts changed. Review their current lines, freight and totals again.');
      return apply(client,ctx,current,p.idempotencyKey);
    },verify:async(db,ctx,r)=>{
      const status=await db.query(`SELECT id,status,source_detail::jsonb->'freightConsolidation' AS freight FROM purchase_orders
        WHERE workspace_id=$1 AND id=ANY($2::text[])`,[ctx.workspaceId,[...r.drafts,...r.originals]]);
      return status.rowCount===r.drafts.length+r.originals.length&&status.rows.every(o=>{
        if(!r.drafts.includes(o.id))return o.status==='CANCELLED';
        return o.status==='DRAFT'&&(!r.freight||hash(o.freight)===hash(r.freight));
      });
    }};
}
module.exports={spec,build,apply};
