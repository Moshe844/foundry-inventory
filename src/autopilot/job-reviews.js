'use strict';

const policy=require('../commercial/agent-plan');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const money=require('../domain/currency');
const cash=require('../accounting/agent-cash-planning');
const definitions=[
  {id:15,key:'monthly-product-classes',label:'Review monthly ABC product classes',filterLabel:'Product code, name or class',readPage:require('../forecasting/monthly-product-classes').review},
  {id:21,key:'reorder-settings',label:'Review reorder settings from local sales',filterLabel:'SKU',readPage:require('../forecasting/location-reorder-rules').review},
  require('../connections/agent-mail-triage').definition,
  require('../reports/manager-presentation').definition,
  require('../purchasing/dual-approval').definition,
  ...require('../purchasing/approval-routing').definitions,
  require('./vacation-deputy').definition,
  ...require('../operations/agent-count-tasks').definitions,
  ...require('../accounting/agent-report-packs').definitions,
  ...require('./activity-watches').definitions,
  ...require('./daily-briefs').definitions,
  {id:163,key:'service-levels',label:'Forecast accuracy, fill rate and on-time delivery',filterLabel:'Customer or supplier name',readPage:require('../forecasting/agent-service-levels').report},
  {id:167,key:'brand-watches',label:'Watch stock levels by brand',sql:require('./brand-watches').matching,
    summary:'Compares the physical quantity of each active SKU across locations against the saved watch for its product brand.'},
  {id:124,key:'transfer-arrivals',label:'Check transfer arrivals and outstanding units',usesDate:true,sql:require('./operational-notices').transfers,
    summary:'Compare dispatch, physical receipt, recorded damage or loss and units still in transit. Overdue transfers get an in-app follow-up in Needs you.'},
  {id:162,key:'stock-health',label:'Review stock turns, margin return and days of supply',readPage:require('../forecasting/agent-stock-health').report},
  {id:131,key:'product-categories',label:'Suggest categories and tags for new products',readPage:require('./product-classification').review},
  {id:129,key:'supplier-specifications',label:'Fill missing product specifications from a supplier file',filterLabel:'Approved supplier file name or import ID',readPage:require('../domain/agent-supplier-specs').review},
  {id:200,key:'catalog-health',label:'Check your catalog health score',readPage:require('./catalog-health').health},
  {id:126,key:'catalog-fixes',label:'Find duplicates and missing product data',readPage:async(db,ctx,options)=>({
    ...await require('./catalog-health').findings(db,ctx,options),summary:'Review the flagged fields against the product or supplier record.'})},
  {id:17,key:'stock-age',label:'Review stock by age for a possible write-down',readPage:require('../forecasting/agent-stock-age').review},
  {id:9,key:'slow-stock',label:'Find dead and slow stock',readPage:require('../forecasting/agent-excess-stock').slowStock},
  {id:86,key:'clearance-plan',label:'Estimate proceeds from clearance stock',readPage:require('../forecasting/agent-excess-stock').clearance,
    requiresChange:true,changeLabel:'Proposed markdown (%)',minChange:0,maxChange:100},
  {id:58,key:'timely-shipping-rates',label:'Find the least expensive service meeting the delivery date',readPage:require('../shipping/agent-delivery-rates').review},
  ...require('../sales/agent-credit-pricing'),
  ...require('../sales/agent-order-checks').definitions,
  ...require('./exception-reviews'),
  ...require('./inventory-reviews'),...require('./planning-reviews'),...require('../accounting/agent-month-end'),...require('./commercial-reviews'),...require('./traceability-reviews'),
  {id:104,key:'payment-run',label:'Prepare this week’s supplier payment run',read:cash.payments},
  {id:108,key:'early-discounts',label:'Find early-payment discounts',read:(db,ctx,options)=>cash.payments(db,ctx,{...options,discountsOnly:true})},
  {id:109,key:'cash-forecast',label:'Forecast thirteen weeks of cash flow',read:cash.forecast}
].sort((a,b)=>a.id-b.id);
const keys=new Map(definitions.map(d=>[d.key,d]));

async function ownerState(db,ctx){
  const member=await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId]);
  if(!member.rowCount) throw new AuthorizationError('Only the business owner can run this review across the inventory.');
  return policy.accountState(db,ctx.workspaceId);
}

function offers(state){
  const tiers=[['starter','Starter'],['growth','Growth'],['pro','Pro'],['enterprise','Custom']];
  return definitions.map(d=>({key:d.key,label:d.label,mode:policy.usesAgentTerms(state)?policy.allowance(state.plan,d.id):'excluded',
    minimum:tiers.find(([plan])=>policy.permits(plan,d.id,'suggest'))?.[1]}));
}

const suggestions={
  162:r=>r['Days of supply']==null?'Check the sales and valuation records for '+r.SKU+'.':'Review '+r.SKU+' with '+r['Days of supply']+' days of stock at its recorded sales rate.',
  126:r=>'Review '+r.Product+'. '+r['What to fix']+'.',
  17:r=>r.SKU+' at '+r.Location+' · '+r.Review+'.',
  9:r=>r.SKU+' at '+r.Location+' · '+r.Finding+'. '+r['Suggested next step'],
  86:r=>'Review '+r['Clearance units']+' units of '+r.SKU+' at '+r.Location+' for clearance.',
  58:r=>r.Service?'Consider '+r.Service+' at '+r.Price+' for '+r.Shipment+'. Carrier arrival '+r['Carrier arrival']+'.':r.Shipment+' · '+r.Status+'.',
  54:r=>'Check order '+r.Order+' for '+r.Customer+'. '+r['Unreserved units']+' unreserved units and '+r['Overdue invoices']+' overdue invoices.',
  55:r=>'Review a credit hold for '+r.Order+'. The customer has '+r['Overdue invoices']+' overdue invoices.',
  3:r=>'Check '+r.SKU+' at '+r.Location+'. '+r.Problem+'.',
  64:r=>'Review '+r.Order+' for '+r.Customer+'. '+r['Waiting units']+' units of '+r.SKU+' are still waiting for stock.',
  116:r=>'Review returns for '+r.Name+'. '+r['Returned units']+' of '+r['Fulfilled units']+' fulfilled units were returned.',
  110:r=>'Review the '+r.Month+' purchase budget for '+r.Category+' in '+r.Currency+'.',
  144:r=>r['Next 7 days']==null?'Record more customer orders for '+r.SKU+' before forecasting.':'Plan for about '+r['Next 7 days']+' units of '+r.SKU+' over the next week.',
  146:r=>r['Estimated units in 30 days']==null?'No comparable sales history for '+r.SKU+' yet.':'Consider about '+r['Estimated units in 30 days']+' units for '+r.SKU+' over its first 30 days.',
  4:r=>'Count '+r.SKU+' at '+r.Shelf+' first. '+r.Reason+'.',
  21:r=>'Consider a reorder point of '+r['Reorder point']+' units for '+r.SKU+' based on '+r['Sold in 90 days']+' units sold in 90 days.',
  22:r=>'Check the saved price and delivery terms with '+r.Supplier+' for '+r.SKU+'.',
  23:r=>'Review the minimum order and freight terms with '+r.Supplier+' before placing the purchase order.',
  32:r=>'Contact '+r.Supplier+' about overdue order '+r.Order+'.',
  44:r=>'Review '+r.Order+' against its delivery record for '+r.SKU+'.',
  79:r=>'Consider '+r.Product+' for this quote. It appeared in '+r['Shared orders']+' shared orders.',
  80:r=>'Review the credit limit for '+r.Customer+' before confirming '+r.Order+'. '+r.Result+'.',
  77:r=>'Consider a selling price of '+r['Suggested selling price']+' for '+r.SKU+' after its cost rose to '+r['Current cost']+'.',
  88:r=>'Review the ordering history for '+r.Customer+'. '+r.Health+'.',
  90:r=>'Review '+r.Supplier+' using its '+r['Placed orders']+' recorded purchase orders.',
  91:r=>'Check the higher supplier price on '+r.Order+' for '+r.SKU+'.',
  99:r=>'Review supplier invoice '+r.Invoice+' with '+r.Supplier+'. '+r.Problem,
  105:r=>'Check '+r['Credit or return']+' with '+r.Supplier+'. '+r.Status+'.',
  108:r=>'Review bill '+r.Bill+' before '+r['Discount deadline']+' for an early-payment discount.',
  109:r=>r['Week beginning']+' · '+r.Currency+'. '+r.Review,
  148:r=>'Review replenishment for '+r.SKU+' because its shipped units rose in the last week.'
};

function firstSuggestion(def,rows){
  const describe=suggestions[def.id];
  if(!describe)return [];
  return rows.slice(0,1).map(row=>({Suggestion:describe(row)}));
}

async function run(db,ctx,key,options={}){
  const def=keys.get(key);
  if(!def) throw new NotFoundError();
  const state=await ownerState(db,ctx),tier=policy.usesAgentTerms(state)?state.plan:null;
  policy.requireJob(tier,def.id,options.scheduled?'automatic':'suggest',{trained:options.trained===true});
  const mode=policy.allowance(tier,def.id),filter=String(options.filter||'').trim();
  if(filter.length>150) throw new ValidationError('Use an item code, supplier, customer or record number up to 150 characters.');
  const page=mode==='suggest'?1:Number(options.page||1);
  if(!Number.isSafeInteger(page)||page<1||page>1000000) throw new ValidationError('Choose a valid results page.');
  if(def.requiresFilter && !filter) return {label:def.label,summary:'Enter the exact '+(def.prompt||(def.id===195?'serial number':'SKU'))+' to look up.',rows:[],mode,filterable:true};
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  let rows,summary=def.summary,more=false;
  if(def.readPage){
    const result=await def.readPage(db,ctx,{filter,page,today,change:options.change});
    const inputs={requiresChange:def.requiresChange,change:options.change,changeLabel:def.changeLabel,minChange:def.minChange,maxChange:def.maxChange,filterLabel:def.filterLabel};
    if(mode==='suggest')return {label:def.label,summary:result.summary,
      rows:firstSuggestion(def,result.rows),mode,more:false,page:1,filterable:true,...inputs};
    return {label:def.label,summary:result.summary,rows:result.rows,more:result.more,page,mode,filterable:true,
      ...inputs};
  }
  if(def.read){
    const result=await def.read(db,ctx,{today,adviceOnly:mode==='suggest'});
    rows=result.rows;summary=result.summary;
    more=rows.length>page*100;
    rows=rows.slice((page-1)*100,page*100);
  }else{
    const args=def.usesDate?[ctx.workspaceId,filter,today]:[ctx.workspaceId,filter];
    if(def.salesHistory)args.push((await require('../commercial/agent-history').access(db,ctx.workspaceId)).salesFrom);
    let sql=def.sql;
    if(def.priceIncrease){
      const exponents=Object.fromEntries([...Intl.supportedValuesOf('currency'),'CLF','UYW'].map(code=>[code,money.exponent(code)]));
      args.push(JSON.stringify(exponents));
      sql='SELECT * FROM ('+sql+') evidence WHERE price_minor > "PO unit price"::numeric * power(10::numeric,($'+args.length+'::jsonb->>"Currency")::int) ORDER BY "Supplier","SKU","Order","Source","Document"';
    }
    args.push((page-1)*100);
    rows=(await db.query(sql+' LIMIT 101 OFFSET $'+args.length,args)).rows;
    more=rows.length>100;rows=rows.slice(0,100);
    for(const row of rows) if(row.price_minor!=null){
      row['Supplier unit price']=money.format(row.price_minor,row.Currency);delete row.price_minor;
    }
  }
  if(def.id===99)for(const row of rows)row.Problem=require('../purchasing/postgres-invoice-review').differenceLabel(row.Problem);
  if(def.id===105)for(const row of rows){row.Amount=row.Amount!=null&&row.Currency?money.format(row.Amount,row.Currency):null;}
  if(def.id===196)for(const row of rows) row.link='/autopilot/lots?'+new URLSearchParams({sku:row.SKU,lot:row.Lot});
  if(mode==='suggest'){
    rows=firstSuggestion(def,rows);more=false;
  }
  return {label:def.label,summary,rows,more,page,mode,filterable:!def.read};
}

module.exports={definitions,ownerState,offers,run};
