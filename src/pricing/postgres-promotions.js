'use strict';
const {createHash}=require('node:crypto'),{newId}=require('../lib/util'),{ValidationError,NotFoundError}=require('../domain/errors');
const access=require('../actions/permissions'),calculator=require('./calculator'),prices=require('./postgres-service');
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
const hash=value=>createHash('sha256').update(canonical(JSON.parse(JSON.stringify(value)))).digest('hex');
function quoteHash(value){
 const frozen=JSON.parse(JSON.stringify({...value,at:null}));
 // Preserve existing approval fingerprints only when the new contract adds
 // zero economic scope. Recorded provider prices and actual charges always
 // retain their complete new fingerprint.
 if(frozen.version===2&&!frozen.recordedAmounts&&!frozen.chargesMinor&&!frozen.chargeTaxMinor&&!frozen.charges?.length&&frozen.lines.every(l=>!l.externalLineId&&!l.chargesMinor&&!l.chargeTaxMinor)){
  frozen.version=1;for(const key of ['recordedAmounts','chargesMinor','chargeTaxMinor','charges'])delete frozen[key];
  for(const line of frozen.lines)for(const key of ['allocationVersion','externalLineId','chargesMinor','chargeTaxMinor','goodsTaxMinor'])delete line[key];
 }
 return hash(frozen);
}
async function authorize(db,ctx,permission,capability='sales_orders.core'){const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];if(!actor)throw new NotFoundError('This account is not in this business.');access.assertCan(actor,permission,'manage pricing');await require('../commercial/enforcement').workspace(db,ctx.workspaceId,capability);return actor;}
async function rules(db,ctx,{lock=false}={}){
  if(lock)await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['pricing:'+ctx.workspaceId]);
  const rows=(await db.query(`SELECT r.id,r.revision,v.definition,v.created_at,
   ((SELECT count(*)::integer FROM stockchief_runtime.pricing_redemptions d WHERE d.workspace_id=r.workspace_id AND d.rule_id=r.id AND d.released_at IS NULL)+(SELECT count(*)::integer FROM stockchief_runtime.pricing_invoice_redemptions d WHERE d.workspace_id=r.workspace_id AND d.rule_id=r.id)) AS redemptions
   FROM stockchief_runtime.pricing_rules r JOIN stockchief_runtime.pricing_rule_versions v
   ON v.workspace_id=r.workspace_id AND v.rule_id=r.id AND v.revision=r.revision
   WHERE r.workspace_id=$1 ORDER BY r.id`,[ctx.workspaceId])).rows;
  return rows.map(r=>({...r.definition,id:r.id,version:r.revision,redemptions:r.redemptions,createdAt:r.created_at}));
}
async function list(db,ctx){await authorize(db,ctx,access.VIEW_SALES);const rows=await rules(db,ctx);return rows;}
async function inspect(db,ctx,{search=null}={}){
 return db.transaction(client=>inspectSnapshot(client,ctx,{search}),{isolation:'REPEATABLE READ',readOnly:true,retrySafe:true});
}
async function inspectSnapshot(db,ctx,{search}){
 await authorize(db,ctx,access.VIEW_SALES);
 const all=await rules(db,ctx),at=Date.now(),matches=r=>!search||[r.id,r.name,r.code].some(v=>String(v||'').toLowerCase().includes(search.toLowerCase()));
 const rows=all.filter(matches).map(rule=>({...rule,lifecycle:calculator.lifecycle(rule,at)}));
 const pending=(await db.query(`SELECT id,rule_id,expected_revision,definition,created_at,'pricing' AS source
  FROM stockchief_runtime.pricing_proposals WHERE workspace_id=$1 AND status='PENDING'
  UNION ALL
  SELECT id,payload->>'ruleId' AS rule_id,(payload->>'expectedRevision')::integer AS expected_revision,
   payload->'definition' AS definition,created_at,'assistant' AS source
  FROM stockchief_runtime.assistant_action_proposals
  WHERE workspace_id=$1 AND action_type='pricing.rule.configure' AND status='PENDING'
  ORDER BY created_at,id`,[ctx.workspaceId])).rows.filter(r=>matches({...r.definition,id:r.id})).map(r=>({
   id:r.id,ruleId:r.rule_id,expectedRevision:r.expected_revision,status:'PENDING',definition:r.definition,
   createdAt:r.created_at,source:r.source,href:r.source==='assistant'?'/actions/'+r.id:'/sales/pricing/rules/proposals/'+r.id}));
 return {rows,pending,asOf:new Date(at).toISOString(),coverage:{approvedRulesComplete:true,pendingProposalsComplete:true,
  scope:search?'Rules and pending proposals matching the literal ID, name or code filter':'All pricing rules and pending pricing-policy proposals in this business'},
  authority:{activationRequiresApproval:true,pendingProposalsAffectPricing:false,
   applicability:'ACTIVE means enabled within its schedule. Customer/product scope, currency, quantity, codes, exclusions and guard checks are applied by the canonical quote engine.'}};
}
async function identities(db,ctx,definition){
  const groups={skuIds:new Set([...(definition.scope?.skuIds||[]),...(definition.entries||[]).map(e=>e.skuId),...(definition.discount?.items||[]).map(e=>e.skuId)]),customerIds:new Set(definition.scope?.customerIds||[]),categoryIds:new Set(definition.scope?.categoryIds||[])};
  const specs={skuIds:['skus','id'],customerIds:['customers','id'],categoryIds:['catalogue_item_facts','category']};
  for(const[field,ids]of Object.entries(groups)){if(!ids.size)continue;const[table,column]=specs[field];const found=(await db.query(`SELECT DISTINCT ${column} AS id FROM ${table} WHERE workspace_id=$1 AND ${column}=ANY($2::text[])`,[ctx.workspaceId,[...ids]])).rows;if(found.length!==ids.size)throw new ValidationError('Every scoped product, category and customer must belong to this business.');}
  if(definition.excludes?.length){const ids=[...new Set(definition.excludes)],found=(await db.query('SELECT id FROM stockchief_runtime.pricing_rules WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,ids])).rows;if(found.length!==ids.length)throw new ValidationError('Excluded promotions must belong to this business.');}
}
async function propose(db,ctx,definition,{ruleId=null,expectedRevision=0}={}){
  await authorize(db,ctx,access.ADMIN);const checked=calculator.validateRule(definition);await identities(db,ctx,checked);
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw new ValidationError('Use the current pricing revision.');
  const id=newId('priceproposal'),rule=ruleId||newId('pricerule');
  const current=(await db.query('SELECT revision FROM stockchief_runtime.pricing_rules WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,rule])).rows[0];
  if(ruleId&&!current)throw new NotFoundError('That pricing rule is not in this business.');
  if((current?.revision||0)!==expectedRevision)throw new ValidationError('This pricing rule changed. Review the current revision.');
  const integrityHash=hash({workspaceId:ctx.workspaceId,ruleId:rule,expectedRevision,definition:checked});
  await db.query(`INSERT INTO stockchief_runtime.pricing_proposals(id,workspace_id,rule_id,expected_revision,definition,integrity_hash,created_by)
   VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,[id,ctx.workspaceId,rule,expectedRevision,JSON.stringify(checked),integrityHash,ctx.actorId]);
  return getProposal(db,ctx,id);
}
async function getProposal(db,ctx,id){await authorize(db,ctx,access.VIEW_SALES);const row=(await db.query('SELECT * FROM stockchief_runtime.pricing_proposals WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('That pricing proposal was not found.');return row;}
async function configuration(db,ctx,definition,{ruleId=null,expectedRevision=0}={}){
 await authorize(db,ctx,access.ADMIN);const checked=calculator.validateRule(definition);await identities(db,ctx,checked);
 const current=ruleId?(await db.query('SELECT revision FROM stockchief_runtime.pricing_rules WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ruleId])).rows[0]:null;
 if(ruleId&&!current)throw new NotFoundError('That pricing rule is not in this business.');if((current?.revision||0)!==expectedRevision)throw new ValidationError('The pricing revision changed. Review it again.');
 const products=(await db.query(`SELECT s.id,s.code,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1`,[ctx.workspaceId])).rows,customers=(await db.query('SELECT id,name FROM customers WHERE workspace_id=$1',[ctx.workspaceId])).rows;
 const target=ruleId||(ctx.planStepKey?'pricerule_'+hash({workspaceId:ctx.workspaceId,actorId:ctx.actorId,step:ctx.planStepKey}).slice(0,32):newId('pricerule'));
 return {payload:{ruleId:target,expectedRevision,definition:checked},summary:(ruleId?'Revise pricing rule '+ruleId+' from reviewed revision '+expectedRevision+':\n':'Create a new pricing rule:\n')+require('./presentation').describe(checked,{products,customers}).map(([label,value])=>`• ${label}: ${value}`).join('\n')};
}
async function activateInTransaction(c,ctx,input){
 await authorize(c,ctx,access.ADMIN);await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['pricing:'+ctx.workspaceId]);
 const definition=calculator.validateRule(input.definition);await identities(c,ctx,definition);
 await c.query('INSERT INTO stockchief_runtime.pricing_rules(id,workspace_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[input.ruleId,ctx.workspaceId]);
 const current=(await c.query('SELECT revision FROM stockchief_runtime.pricing_rules WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,input.ruleId])).rows[0];
 if(!current||current.revision!==input.expectedRevision)throw new ValidationError('The current pricing rule changed after review.');
 const versionId=newId('priceversion');await c.query(`INSERT INTO stockchief_runtime.pricing_rule_versions(id,workspace_id,rule_id,revision,definition,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[versionId,ctx.workspaceId,input.ruleId,current.revision+1,JSON.stringify(definition),ctx.actorId]);
 await c.query('UPDATE stockchief_runtime.pricing_rules SET revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,input.ruleId]);
 return {ruleId:input.ruleId,revision:current.revision+1,versionId};
}
async function decide(db,ctx,id,expectedHash,approved){
  return db.transaction(async c=>{
    await authorize(c,ctx,access.ADMIN);await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['pricing:'+ctx.workspaceId]);
    const row=await getProposal(c,ctx,id);await c.query('SELECT id FROM stockchief_runtime.pricing_proposals WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id]);
    if(row.integrity_hash!==expectedHash)throw new ValidationError('The pricing proposal changed. Review it again.');
    if(row.status!=='PENDING'){if(row.status===(approved?'APPROVED':'REJECTED'))return {...row,replayed:true};throw new ValidationError('That pricing proposal was already decided.');}
    if(hash({workspaceId:ctx.workspaceId,ruleId:row.rule_id,expectedRevision:row.expected_revision,definition:row.definition})!==row.integrity_hash)throw new ValidationError('The pricing proposal failed integrity verification.');
    if(approved)await activateInTransaction(c,ctx,{ruleId:row.rule_id,expectedRevision:row.expected_revision,definition:row.definition});
    return (await c.query(`UPDATE stockchief_runtime.pricing_proposals SET status=$3,approved_by=$4,decided_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *`,[ctx.workspaceId,id,approved?'APPROVED':'REJECTED',ctx.actorId])).rows[0];
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function prepareQuote(c,ctx,input,{lock=false,frozenRules=null,orderId=null,invoice=false}={}){
  await authorize(c,ctx,invoice?access.MANAGE_ACCOUNTING:access.OPERATE,invoice?'accounting.core':'sales_orders.core');if(lock)await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['pricing:'+ctx.workspaceId]);
  let configured=frozenRules||await rules(c,ctx);const currency=prices.normaliseCurrency(input.currency),lines=[];
  let recorded=false;
  if(ctx.acceptedSalesEvent){
    const receipt=(await c.query(`SELECT normalized_payload::jsonb AS evidence FROM connector_feed_events WHERE workspace_id=$1 AND connector_id=$2 AND external_event_id=$3 AND status='PROCESSING' AND event_type IN ('sales_order.created','sales_order.snapshot')`,[ctx.workspaceId,ctx.acceptedSalesEvent.connectorId,ctx.acceptedSalesEvent.eventId])).rows[0];
    if(!receipt)throw new ValidationError('An accepted channel price needs its authenticated event receipt.');
    const evidence=receipt.evidence?.data;
    recorded=evidence?.recordedAmounts===true;
    if(recorded){
      if(input.recordedAmounts!==true||!input.sourceFinancials||currency!==evidence.currency||hash(input.sourceFinancials)!==hash(evidence.sourceFinancials)||hash(input.orderCharges||[])!==hash(evidence.orderCharges||[]))throw new ValidationError('Recorded channel pricing must match its authenticated monetary evidence.');
      if(input.lines.length!==evidence.lines.length||input.lines.some((line,i)=>['externalLineId','quantity','unitPriceMinor','grossMinor','discountMinor','taxMinor'].some(k=>line[k]!==evidence.lines[i][k])))throw new ValidationError('Recorded channel lines must preserve the exact authenticated amounts and quantities.');
    }
    configured=configured.filter(r=>r.kind==='guard');
  }
  if(ctx.cutoverPricing){recorded=await require('../onboarding/postgres-cutover-pricing').verify(c,ctx,input);configured=configured.filter(r=>r.kind==='guard');}
  if(input.recordedAmounts===true&&!recorded)throw new ValidationError('Recorded channel amounts require their authenticated provider receipt.');
  const customer=(await c.query("SELECT id,tax_exempt,tax_exempt_reference FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'",[ctx.workspaceId,input.customerId])).rows[0];if(!customer)throw new ValidationError('Choose an active customer in this business.');
  const source=input.pricingInputLines||input.lines;if(!Array.isArray(source)||!source.length||source.length>500||source.some(l=>!l||typeof l!=='object'))throw new ValidationError('Choose between one and 500 valid lines.');
  const skuIds=[...new Set(source.map(l=>l.skuId).filter(Boolean))];
  const catalogue=(await c.query(`WITH costs AS (SELECT sku_id,sum(quantity_units) AS quantity,sum(secondary_quantity_units) AS secondary_quantity,sum(total_cost_minor) AS amount FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) GROUP BY sku_id), physical AS (SELECT sku_id,sum(on_hand) AS quantity FROM balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) GROUP BY sku_id)
    SELECT s.id,i.unit_label,i.quantity_precision,i.quantity_increment,i.secondary_unit_label,i.secondary_precision,i.secondary_increment,f.category,p.amount_minor,p.currency,CASE WHEN i.secondary_unit_label IS NOT NULL THEN costs.secondary_quantity ELSE costs.quantity END AS cost_quantity,costs.amount AS cost_amount,coalesce(physical.quantity,0) AS physical_quantity
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id LEFT JOIN catalogue_item_facts f ON f.workspace_id=i.workspace_id AND f.item_id=i.id
    LEFT JOIN LATERAL(SELECT amount_minor,currency FROM sku_prices WHERE workspace_id=s.workspace_id AND sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)p ON true
    LEFT JOIN costs ON costs.sku_id=s.id LEFT JOIN physical ON physical.sku_id=s.id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1`,[ctx.workspaceId,skuIds])).rows;
  const base=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency,bySku=new Map(catalogue.map(s=>[s.id,s]));
  for(const [lineIndex,line] of source.entries()){
    const lineLabel='Line '+(lineIndex+1)+': ';if(!Number.isFinite(Number(line.quantity))||Number(line.quantity)<=0)throw new ValidationError(lineLabel+'enter a positive quantity.');
    if(invoice&&!line.skuId){if(!String(line.description||'').trim())throw new ValidationError('An invoice line needs a product or description.');lines.push({...line,skuId:null,quantity:Number(line.quantity),unitPriceMinor:Number(line.unitPriceMinor),costUnitMinor:null});continue;}
    const sku=bySku.get(line.skuId);if(!sku)throw new ValidationError(lineLabel+'choose an active product from this business.');
    if(!invoice)require('../domain/stock-quantity').validate(sku,line.quantity,{label:lineLabel+'quantity'});
    const priceSet=sku.amount_minor!==null&&sku.amount_minor!==undefined;
    if(line.unitPriceMinor==null&&(!priceSet||sku.currency!==currency))throw new ValidationError(lineLabel+'this product needs a selling price in the order currency.');
    const measuredQuantity=invoice?null:require('../domain/stock-quantity').secondary(sku,line.secondaryQuantity);
    lines.push({...line,pricingQuantity:measuredQuantity??undefined,quantity:Number(line.quantity),unitPriceMinor:Number(line.unitPriceMinor??sku.amount_minor),referenceUnitPriceMinor:priceSet&&sku.currency===currency?Number(sku.amount_minor):Number(line.unitPriceMinor),categoryId:sku.category,costUnitMinor:base===currency&&Number(sku.cost_quantity)>0&&Number(sku.cost_quantity)>=Number(sku.physical_quantity)?Math.ceil(Number(sku.cost_amount)/Number(sku.cost_quantity)):null});
  }
  const usage=(await c.query(`SELECT rule_id,count(*)::integer AS total,count(*) FILTER(WHERE customer_id=$2)::integer AS customer FROM (SELECT rule_id,customer_id FROM stockchief_runtime.pricing_redemptions WHERE workspace_id=$1 AND released_at IS NULL AND ($3::text IS NULL OR sales_order_id<>$3) UNION ALL SELECT rule_id,customer_id FROM stockchief_runtime.pricing_invoice_redemptions WHERE workspace_id=$1) uses GROUP BY rule_id`,[ctx.workspaceId,input.customerId,orderId])).rows;
  for(const rule of configured){const count=usage.find(u=>u.rule_id===rule.id);rule.redemptions=count?.total||0;rule.customerRedemptions=count?.customer||0;}
  let taxRate=null;
  const taxExempt=Boolean(Number(customer.tax_exempt))&&!recorded;
  if(input.taxRateId&&recorded)throw new ValidationError('Recorded channel tax cannot be replaced.');
  if(input.taxRateId&&!taxExempt){
    const rate=(await c.query("SELECT * FROM accounting_tax_rates WHERE workspace_id=$1 AND id=$2 AND active=1 AND applies_to IN ('SALES','BOTH')",[ctx.workspaceId,input.taxRateId])).rows[0],date=input.orderDate||new Date().toISOString().slice(0,10);
    if(!rate||date<rate.effective_from||(rate.effective_to&&date>rate.effective_to))throw new ValidationError('Choose a sales tax rate effective on the order date.');
    taxRate={id:rate.id,name:rate.name,rateMillionths:Number(rate.rate_millionths)};
  }
  const result=calculator.quote({...input,taxMinor:taxExempt?0:input.taxMinor,taxRate:taxRate||undefined,recordedAmounts:recorded,allowFractionalQuantities:true,discountMinor:input.pricingInputDiscountMinor??input.discountMinor,currency,lines,rules:configured,at:input.at||new Date().toISOString()});
  if(taxExempt)result.customerTaxExemption={customerId:customer.id,reference:customer.tax_exempt_reference||null};
  if(recorded&&result.totalMinor!==input.sourceFinancials.totalMinor)throw new ValidationError('Canonical pricing does not reconcile with the recorded provider total.');
  return result;
}
async function revisionQuote(c,ctx,orderId,changes,{lock=false}={}){
 const order=(await c.query('SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,orderId])).rows[0];if(!order||order.status!=='DRAFT')throw new ValidationError('Only an unfulfilled draft can be repriced.');
 const rows=(await c.query('SELECT * FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2 ORDER BY created_at,id',[ctx.workspaceId,orderId])).rows,original=order.pricing_quote_id?(await c.query('SELECT quote FROM stockchief_runtime.pricing_order_snapshots WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,order.pricing_quote_id])).rows[0]?.quote:null;
 const frozen=[];for(const policy of original?.policyVersions||[]){const row=(await c.query('SELECT definition FROM stockchief_runtime.pricing_rule_versions WHERE workspace_id=$1 AND rule_id=$2 AND revision=$3',[ctx.workspaceId,policy.id,policy.version])).rows[0];if(!row)throw new ValidationError('The historical pricing policy is unavailable.');if(row.definition.kind!=='guard')frozen.push({...row.definition,id:policy.id,version:policy.version});}
 frozen.push(...(await rules(c,ctx)).filter(r=>r.kind==='guard'));
 const quote=await prepareQuote(c,ctx,{guardAt:new Date().toISOString(),customerId:order.customer_id,currency:order.currency,at:original?.at||new Date(order.created_at).toISOString(),codes:original?.codes||[],priceListId:original?.priceListId,discountMinor:original?.manualDiscountMinor??Number(order.discount_minor),taxMinor:Number(order.tax_minor),lines:rows.map((r,i)=>({skuId:r.sku_id,quantity:r.sku_id===changes.skuId?changes.quantity:Number(r.quantity_ordered),priceOverride:r.sku_id===changes.skuId?(changes.priceOverride??r.pricing_snapshot?.priceOverride??(changes.unitPriceMinor!==undefined)):r.pricing_snapshot?.priceOverride===true,unitPriceMinor:r.sku_id===changes.skuId&&(changes.priceOverride??r.pricing_snapshot?.priceOverride??(changes.unitPriceMinor!==undefined))?(changes.unitPriceMinor??Number(r.unit_price_minor)):r.pricing_snapshot?.baseUnitPriceMinor??Number(r.unit_price_minor)}))},{frozenRules:frozen,lock,orderId});
 return {quote,lineIds:rows.map(r=>r.id)};
}
async function saveQuote(c,ctx,orderId,quote,lineIds){
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['pricing:'+ctx.workspaceId]);
  if(lineIds.length!==quote.lines.length||new Set(lineIds).size!==lineIds.length||lineIds.some(id=>!id))throw new ValidationError('Every priced line needs one exact order line.');
  if(quote.violations.length)throw new ValidationError('Pricing requires review: '+[...new Set(quote.violations.map(v=>v.kind.replaceAll('_',' ')))].join(', ')+'. No order was changed.');
  const id=newId('pricequote');await c.query(`INSERT INTO stockchief_runtime.pricing_order_snapshots(id,workspace_id,sales_order_id,quote,integrity_hash) VALUES($1,$2,$3,$4::jsonb,$5)`,[id,ctx.workspaceId,orderId,JSON.stringify(quote),hash(quote)]);
  for(const [index,line]of quote.lines.entries()){await c.query('UPDATE sales_order_lines SET secondary_quantity_ordered=$4 WHERE workspace_id=$1 AND sales_order_id=$2 AND id=$3',[ctx.workspaceId,orderId,lineIds[index],line.pricingQuantity??null]);await c.query('UPDATE sales_order_lines SET pricing_snapshot=$4::jsonb,unit_price_minor=$5 WHERE workspace_id=$1 AND sales_order_id=$2 AND id=$3',[ctx.workspaceId,orderId,lineIds[index],JSON.stringify(line),line.unitPriceMinor]);}
  await c.query('UPDATE sales_orders SET pricing_quote_id=$3,discount_minor=$4,tax_minor=$5,charges_minor=$6,priced_subtotal_minor=$7,pricing_total_minor=$8 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,orderId,id,quote.discountMinor,quote.taxMinor,quote.chargesMinor||0,quote.subtotalMinor,quote.totalMinor]);
  if(!(await c.query('SELECT 1 FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2 AND quantity_fulfilled>0 LIMIT 1',[ctx.workspaceId,orderId])).rows.length)await c.query('UPDATE stockchief_runtime.pricing_redemptions SET released_at=now() WHERE workspace_id=$1 AND sales_order_id=$2 AND released_at IS NULL AND NOT(rule_id=ANY($3::text[]))',[ctx.workspaceId,orderId,quote.applied.map(p=>p.id)]);
  for(const applied of quote.applied)await c.query(`INSERT INTO stockchief_runtime.pricing_redemptions(workspace_id,rule_id,sales_order_id,customer_id) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,rule_id,sales_order_id) DO UPDATE SET released_at=NULL,customer_id=EXCLUDED.customer_id`,[ctx.workspaceId,applied.id,orderId,quote.customerId]);
  return id;
}
async function history(db,ctx,id){await authorize(db,ctx,access.VIEW_SALES);return(await db.query('SELECT revision,definition,created_at FROM stockchief_runtime.pricing_rule_versions WHERE workspace_id=$1 AND rule_id=$2 ORDER BY revision DESC',[ctx.workspaceId,id])).rows;}
module.exports={list,inspect,propose,getProposal,decide,prepareQuote,saveQuote,history,hash,quoteHash,configuration,activateInTransaction,revisionQuote};
