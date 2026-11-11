
'use strict';

const {ValidationError}=require('../domain/errors');
const pricing=require('../pricing/postgres-promotions'),money=require('../domain/currency');
const exact=require('../domain/exact-quantity'),quantity=require('../domain/stock-quantity');
const availability=require('../domain/postgres-stock-availability');
const quotes=require('./postgres-quotes');

const qualification=(ok,message)=>{if(!ok)throw new ValidationError(message);};

async function sources(db,ctx,{anchors,exclude=anchors,candidates=null,locationId=null,currency=null,limit=100,offset=0,skuCode=''}){
  const {salesFrom}=await require('../commercial/agent-history').access(db,ctx.workspaceId);
  return (await db.query(`WITH wanted AS (
    SELECT s.id FROM skus s WHERE s.workspace_id=$1 AND (s.id=ANY($2::text[]) OR ($8<>'' AND lower(s.code)=lower($8)))
  ), anchors AS (
    SELECT DISTINCT l.sales_order_id FROM sales_order_lines l JOIN wanted w ON w.id=l.sku_id
    JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
    WHERE l.workspace_id=$1 AND l.quantity_fulfilled>0 AND o.status IN('FULFILLED','PARTIALLY_FULFILLED')
      AND ($5::text IS NULL OR o.currency=$5) AND ($6::text IS NULL OR o.order_date>=$6)
      AND (SELECT coalesce(sum(sl.quantity),0) FROM sales_shipment_lines sl
        JOIN sales_shipments h ON h.workspace_id=sl.workspace_id AND h.id=sl.shipment_id
        WHERE sl.workspace_id=l.workspace_id AND sl.sales_order_line_id=l.id AND h.sales_order_id=o.id
          AND h.status IN('SHIPPED','DELIVERED') AND h.customer_return_id IS NULL AND h.shipped_at IS NOT NULL
          AND ($4::text IS NULL OR sl.location_id=$4)) >
        (SELECT coalesce(sum(r.quantity_received),0) FROM customer_return_lines r
          WHERE r.workspace_id=l.workspace_id AND r.sales_order_line_id=l.id)
  ), matched AS (
    SELECT DISTINCT l.sku_id,l.sales_order_id FROM anchors a
    JOIN sales_order_lines l ON l.workspace_id=$1 AND l.sales_order_id=a.sales_order_id AND l.quantity_fulfilled>0
    WHERE l.sku_id<>ALL($3::text[]) AND NOT EXISTS(SELECT 1 FROM wanted w WHERE w.id=l.sku_id)
      AND ($7::text[] IS NULL OR l.sku_id=ANY($7))
      AND (SELECT coalesce(sum(sl.quantity),0) FROM sales_shipment_lines sl
        JOIN sales_shipments h ON h.workspace_id=sl.workspace_id AND h.id=sl.shipment_id
        WHERE sl.workspace_id=l.workspace_id AND sl.sales_order_line_id=l.id AND h.sales_order_id=l.sales_order_id
          AND h.status IN('SHIPPED','DELIVERED') AND h.customer_return_id IS NULL AND h.shipped_at IS NOT NULL
          AND ($4::text IS NULL OR sl.location_id=$4)) >
        (SELECT coalesce(sum(r.quantity_received),0) FROM customer_return_lines r
          WHERE r.workspace_id=l.workspace_id AND r.sales_order_line_id=l.id)
  )
  SELECT s.id sku_id,s.code,s.variant_label,i.name,i.unit_label,i.quantity_increment::text,
    i.quantity_precision,i.tracking_mode,i.secondary_unit_label,i.secondary_precision,i.secondary_increment::text,
    count(*)::int shared_orders,md5(string_agg(m.sales_order_id,',' ORDER BY m.sales_order_id)) source
  FROM matched m JOIN skus s ON s.workspace_id=$1 AND s.id=m.sku_id AND s.is_active=1
  JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
  GROUP BY s.id,i.id ORDER BY shared_orders DESC,s.code,s.id LIMIT $9 OFFSET $10`,
  [ctx.workspaceId,anchors,exclude,locationId,currency,salesFrom,candidates,skuCode,limit,offset])).rows;
}

async function readReport(db,ctx,{filter,page,adviceOnly}){
  const rows=await sources(db,ctx,{anchors:[],skuCode:filter,limit:adviceOnly?1:101,offset:adviceOnly?0:(page-1)*100});
  return {more:rows.length>100,summary:'Companion products come from confirmed shipments of both products on the same order. Open a saved quote to review eligible additions for its customer and warehouse.',
    rows:rows.slice(0,100).map(row=>({SKU:row.code,Product:row.name+(row.variant_label?' / '+row.variant_label:''),'Shared orders':row.shared_orders}))};
}

async function original(db,ctx,id,{lock=false}={}){
  if(lock)await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['quotation:'+ctx.workspaceId]);
  const q=await quotes.get(db,ctx.workspaceId,id,{lock}),today=await require('../lib/business-time').today(db,ctx.workspaceId);
  qualification(q.status==='OPEN'&&!q.sales_order_id&&q.valid_until>=today,'Use a current open quotation.');
  qualification(Array.isArray(q.input.lines)&&q.input.lines.length>0,'The quotation has no exact product lines.');
  const history=(await db.query(`SELECT
    (SELECT id FROM sales_quotations WHERE workspace_id=$1 AND supersedes_id=$2 LIMIT 1) revision_id,
    EXISTS(SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND idempotency_key='quotation-email:'||$2) emailed,
    EXISTS(SELECT 1 FROM stockchief_runtime.agent_quote_followups WHERE workspace_id=$1 AND quote_id=$2) presented,
    EXISTS(SELECT 1 FROM stockchief_runtime.quote_buyer_links WHERE workspace_id=$1 AND quote_id=$2 AND enabled) shared`,
  [ctx.workspaceId,id])).rows[0];
  qualification(!history.revision_id,'A newer revision already exists. Use the current quotation.');
  qualification(!history.emailed&&!history.presented&&!history.shared,'This quotation has delivery evidence or a queued email. Use the native manual revision for customer-facing changes.');
  qualification(pricing.quoteHash(q.pricing)===q.pricing_hash,'The saved quotation integrity record needs review.');
  qualification(!q.input.pricingInputLines&&!q.input.recordedAmounts,'These imported pricing terms require the native manual revision.');
  qualification(!(Number(q.input.taxMinor)>0&&!q.input.taxRateId&&!q.pricing.customerTaxExemption),
    'This quotation uses a fixed tax amount. Review its taxes on a manual revision.');
  const described=await quotes.describeLines(db,ctx.workspaceId,q.input.lines);
  qualification(pricing.hash(described.labels)===pricing.hash(q.line_labels)&&pricing.hash(described.units)===pricing.hash(q.line_units),
    'Product descriptions or units changed. Review a manual quotation revision.');
  const base=await pricing.prepareQuote(db,ctx,q.input,{lock});
  qualification(pricing.quoteHash(base)===q.pricing_hash,'Current pricing or customer terms changed. Review a manual quotation revision.');
  const currency=money.code(q.pricing.currency);
  const customer=(await db.query(`SELECT id,name,tax_exempt,tax_exempt_reference,shipping_address
    FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'`,[ctx.workspaceId,q.customer_id])).rows[0];
  qualification(Boolean(customer),'Choose an active customer.');
  return {q,today,currency,customer};
}

async function site(db,ctx,q,locationId){
  const id=q.input.fulfillmentLocationId||locationId;
  qualification(Boolean(id),'Choose the exact warehouse for the companion stock.');
  qualification(!locationId||locationId===id,'Use the quotation’s recorded fulfillment warehouse.');
  await require('../operations/postgres-warehouse-access').assertLocations(db,ctx,[id]);
  const location=(await db.query("SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL",
    [ctx.workspaceId,id])).rows[0];
  qualification(Boolean(location),'Choose an active owned warehouse for the companion stock.');
  return location;
}

async function measured(db,ctx,profile,location,units,stock,physical,today,requested){
  if(!profile.secondary_unit_label)return null;
  qualification(stock.available===stock.onHand,'Review the exact weight of the available pieces before quoting.');
  const options=[];
  if(Number(physical.on_hand)===units&&Number(physical.secondary_on_hand)>0)options.push(Number(physical.secondary_on_hand));
  if(profile.tracking_mode==='lot'){
    const rows=(await db.query(`SELECT DISTINCT b.secondary_quantity::text weight FROM lot_balances b JOIN lots l ON l.workspace_id=b.workspace_id AND l.id=b.lot_id
      WHERE b.workspace_id=$1 AND b.location_id=$2 AND l.sku_id=$3 AND b.quantity=$4 AND b.secondary_quantity>0
      AND l.recalled_at IS NULL AND (l.expires_at IS NULL OR l.expires_at::date>=$5::date)`,
    [ctx.workspaceId,location.id,profile.sku_id,units,today])).rows;
    options.push(...rows.map(r=>Number(r.weight)));
  }
  if(profile.tracking_mode==='serial'&&units===1){
    const rows=(await db.query(`SELECT DISTINCT u.secondary_quantity::text weight FROM serial_units u
      LEFT JOIN lots l ON l.workspace_id=u.workspace_id AND l.id=u.lot_id
      WHERE u.workspace_id=$1 AND u.location_id=$2 AND u.sku_id=$3 AND u.status='in_stock' AND u.condition='good'
        AND u.secondary_quantity>0 AND l.recalled_at IS NULL AND (l.expires_at IS NULL OR l.expires_at::date>=$4::date)`,
    [ctx.workspaceId,location.id,profile.sku_id,today])).rows;
    options.push(...rows.map(r=>Number(r.weight)));
  }
  const weights=[...new Set(options)],weight=requested==null||requested===''?(weights.length===1?weights[0]:null):quantity.secondary(profile,requested);
  qualification(weight!==null&&weights.includes(weight),'Use a uniquely recorded weight or choose the actual weight of the quoted lot or serial.');
  return quantity.secondary(profile,weight);
}

async function stockProof(db,ctx,profile,location,units,today,weight){
  const leaves=await require('../domain/postgres-kit-service').explode(db,ctx.workspaceId,profile.sku_id,{multiplier:units});
  const positions=leaves.map(leaf=>({skuId:leaf.skuId,locationId:location.id}));
  const usable=await availability.readMany(db,ctx.workspaceId,positions,{sellableOnly:true});
  const physical=(await db.query(`SELECT b.sku_id,b.on_hand,b.secondary_on_hand,c.quantity_units,c.secondary_quantity_units,c.total_cost_minor,
    c.updated_at,i.secondary_unit_label,a.base_currency
    FROM balances b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id
    JOIN items i ON i.workspace_id=b.workspace_id AND i.id=s.item_id
    JOIN accounting_inventory_cost_balances c ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id
    JOIN accounting_settings a ON a.workspace_id=b.workspace_id AND a.enabled=1
    WHERE b.workspace_id=$1 AND b.location_id=$2 AND b.sku_id=ANY($3::text[])`,
  [ctx.workspaceId,location.id,positions.map(p=>p.skuId)])).rows;
  const evidence=[];
  for(const part of leaves){
    const stock=usable.get(availability.key(part.skuId,location.id)),current=physical.find(r=>r.sku_id===part.skuId);
    qualification(stock&&Number(part.quantity)<=stock.available,'There is insufficient uncommitted sellable stock in this warehouse.');
    qualification(current&&Number(current.total_cost_minor)>0&&Number(current.quantity_units)===Number(current.on_hand)&&
      (current.secondary_on_hand===null&&current.secondary_quantity_units===null||Number(current.secondary_on_hand)===Number(current.secondary_quantity_units)),
      'This companion has incomplete or zero recorded stock cost.');
    if(part.skuId!==profile.sku_id)qualification(!current.secondary_unit_label,'A measured kit component needs a separate exact quote review.');
    const secondary=part.skuId===profile.sku_id?await measured(db,ctx,profile,location,units,stock,current,today,weight):null;
    const recordedCost=exact.ratioMinor(money.integer(current.total_cost_minor),secondary??part.quantity,
      secondary===null?current.quantity_units:current.secondary_quantity_units,{rounding:'floor'});
    qualification(recordedCost>0,'The exact added quantity has no positive recorded cost at this warehouse.');
    evidence.push({skuId:part.skuId,quantity:part.quantity,secondary,available:stock.available,physical:current.on_hand,
      costed:current.quantity_units,recordedCost,updatedAt:current.updated_at,baseCurrency:current.base_currency});
  }
  return {evidence,secondary:evidence.find(r=>r.skuId===profile.sku_id)?.secondary??null};
}

async function checkCombinedStock(db,ctx,existing,additions){
  const required=new Map();
  for(const line of additions){
    for(const part of line.stock){
      const prior=required.get(part.skuId)||{quantity:'0',available:part.available};
      required.set(part.skuId,{quantity:exact.add(prior.quantity,part.quantity),available:Math.min(prior.available,part.available)});
    }
  }
  const kitService=require('../domain/postgres-kit-service'),quoted=existing.map(l=>l.skuId);
  const kitIds=new Set((await db.query(`SELECT DISTINCT kit_sku_id FROM kit_components WHERE workspace_id=$1
    AND kit_sku_id=ANY($2::text[]) AND stock_basis='components'`,[ctx.workspaceId,quoted])).rows.map(r=>r.kit_sku_id));
  for(const line of existing){
    if(!required.has(line.skuId)&&!kitIds.has(line.skuId))continue;
    const parts=kitIds.has(line.skuId)?await kitService.explode(db,ctx.workspaceId,line.skuId,{multiplier:line.quantity}):[line];
    for(const part of parts){
      const prior=required.get(part.skuId);
      if(prior)prior.quantity=exact.add(prior.quantity,part.quantity);
    }
  }
  qualification([...required.values()].every(p=>Number(p.quantity)<=p.available),
    'The existing and added lines share stock that cannot cover their combined quantities at this warehouse.');
}

function economics(line){
  return Object.fromEntries(['skuId','quantity','pricingQuantity','unitPriceMinor','baseUnitPriceMinor','discountMinor',
    'grossMinor','netMinor','chargesMinor','chargeTaxMinor','priceSource','adjustments'].map(key=>[key,line[key]??null]));
}

async function calculate(db,ctx,source,location,selections,{lock=false,anchorSkuId=null}={}){
  const {q,today,currency,customer}=source;
  const existing=q.input.lines.map(l=>l.skuId),anchors=anchorSkuId?[anchorSkuId]:existing,ids=selections.map(l=>l.skuId);
  qualification(ids.length>0&&ids.length+existing.length<=500&&new Set(ids).size===ids.length&&ids.every(id=>!existing.includes(id)),
    'Choose distinct companions within the native quotation line limit.');
  qualification(anchors.every(id=>existing.includes(id)),'The quotation no longer has the approved anchor product.');
  const observed=await sources(db,ctx,{anchors,exclude:existing,candidates:ids,locationId:location.id,currency,limit:null});
  const additions=[];
  for(const selection of selections){
    const profile=observed.find(row=>row.sku_id===selection.skuId);
    qualification(Boolean(profile),'A selected companion has no qualifying fulfilled combination in this currency and warehouse.');
    const units=quantity.validate(profile,selection.quantity??profile.quantity_increment,{label:'Added quantity'});
    const stock=await stockProof(db,ctx,profile,location,units,today,selection.secondaryQuantity);
    qualification(stock.evidence.every(p=>p.baseCurrency===currency),'Verify stock costs in the quotation currency before adding this item.');
    additions.push({skuId:profile.sku_id,sku:profile.code,product:profile.name+(profile.variant_label?' / '+profile.variant_label:''),
      unit:profile.unit_label,secondaryUnit:profile.secondary_unit_label,quantity:units,secondaryQuantity:stock.secondary,
      sharedOrders:profile.shared_orders,orderEvidence:profile.source,stock:stock.evidence});
  }
  await checkCombinedStock(db,ctx,q.input.lines,additions);
  const lines=additions.map(l=>({skuId:l.skuId,quantity:l.quantity,...(l.secondaryQuantity!==null?{secondaryQuantity:l.secondaryQuantity}:{})}));
  const input={...q.input,lines:[...q.input.lines,...lines]};
  const priced=await pricing.prepareQuote(db,ctx,input,{lock});
  qualification(!priced.violations.length,'The added items would breach current native pricing safeguards.');
  qualification(q.pricing.lines.every((line,index)=>pricing.hash(economics(line))===pricing.hash(economics(priced.lines[index]))),
    'Adding these items would change the existing prices, discounts or charges. Review a manual revision.');
  qualification(pricing.hash(priced.taxRate||null)===pricing.hash(q.pricing.taxRate||null)&&
    pricing.hash(priced.customerTaxExemption||null)===pricing.hash(q.pricing.customerTaxExemption||null),
    'The original sales tax terms changed. Review a manual revision.');
  const newLines=priced.lines.slice(existing.length);
  qualification(newLines.every(l=>l.unitPriceMinor>0&&l.netMinor>0),'Choose a companion with an established positive selling price.');
  const increase=priced.totalMinor-q.pricing.totalMinor;
  qualification(increase>0,'The new quotation total needs an exact positive increase.');
  const result={recordId:q.id,quoteNumber:q.quote_number,customerId:customer.id,customerName:customer.name,location,
    currency,validUntil:q.valid_until,priorTotalMinor:q.pricing.totalMinor,totalMinor:priced.totalMinor,addedMinor:increase,
    reviewedHash:pricing.quoteHash(priced),input,additions:additions.map((l,i)=>({...l,price:newLines[i]})),anchorSkuId};
  return {...result,sourceFingerprint:pricing.hash({result,today,customer,quoteHash:q.pricing_hash,labels:q.line_labels,units:q.line_units})};
}

module.exports={readReport,sources,original,site,calculate,qualification};
