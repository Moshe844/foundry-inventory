'use strict';

const policy=require('../commercial/agent-plan');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const cash=require('../accounting/agent-cash-planning');
const definitions=[
  require('../purchasing/agent-direct-shipments').definition,
  require('../documents/agent-sop-sources').definition,
  require('../documents/agent-contract-reader').definition,
  require('../warehouse/agent-shelf-photos').definition,
  require('../imports/handwritten-table').definition,
  require('../documents/agent-voice-receiving').definition,
  require('../warehouse/agent-stock-rotation').definition,
  require('../transfers/agent-transfer-balancing').definition,
  require('../purchasing/agent-blanket-releases').definition,
  require('../purchasing/agent-backup-suppliers').definition,
  require('../catalog/agent-channel-copy').definition,
  require('../sales/agent-website-stock-chat').definition,
  require('../sales/agent-customer-order-pages').definition,
  require('../sales/agent-customer-order-pages').preorderDefinition,
  require('../operations/agent-return-disposition').definition,
  require('../reports/agent-net-contribution').definition,
  require('../purchasing/agent-purchase-fx').definition,
  require('../shipping/agent-export-papers').definition,
  require('../shipping/agent-carrier-claims').definition,
  require('../shipping/agent-freight-pickups').definition,
  require('../shipping/agent-van-routes').definition,
  require('../shipping/agent-return-instructions').definition,
  require('../warehouse/agent-partial-shipments').definition,
  require('../sales/agent-ship-from').definition,
  require('../operations/agent-annual-stocktakes').definition,
  require('../connections/agent-channel-buffers').definition,
  require('../connections/agent-channel-recovery').definition,
  require('../connections/agent-slack').definition,
  ...require('../sales/agent-order-reservations').definitions,
  require('../purchasing/agent-supplier-rfqs').definition,
  require('../purchasing/agent-supplier-claims').definition,
  require('../purchasing/agent-supplier-claims').photoDefinition,
  require('../operations/agent-quality-holds').definition,
  require('../purchasing/agent-supplier-shutdowns').definition,
  require('../purchasing/agent-promotion-stock').definition,
  require('../catalog/agent-product-retirements').definition,
  require('./team-procedures').definition,
  require('../purchasing/agent-container-plans').definition,
  require('../purchasing/agent-inbound-freight').definition,
  require('../purchasing/agent-po-delivery-dates').definition,
  require('../purchasing/agent-supplier-benefits').reviewDefinition,
  require('../purchasing/agent-supplier-email-terms').definition,
  require('../warehouse/agent-bin-corrections').definition,
  require('../sales/agent-customer-return-emails').definition,
  require('../purchasing/agent-supplier-forecasts').definition,
  require('../accounting/agent-customer-statements').definition,
  require('../onboarding/agent-migration-review').definition,
  require('../sales/agent-quote-followups').definition,
  require('../warehouse/agent-putaway').definition,
  require('../accounting/postgres-landed-costs').definition,
  require('../warehouse/agent-pick-release').definition,
  require('./third-party-stock').definition,
  require('../sales/agent-arrived-stock').definition,
  require('../sales/agent-stock-ready').definition,
  require('../purchasing/agent-supplier-invoice-intake').definition,
  require('../purchasing/agent-supplier-invoice-intake').errorDefinition,
  require('../purchasing/agent-invoice-disputes').definition,
  require('../purchasing/agent-supplier-credit-notes').definition,
  require('../accounting/agent-customer-invoices').definition,
  require('../accounting/agent-invoice-reminders').definition,
  require('../accounting/agent-customer-payment-matches').definition,
  require('../documents/agent-product-facts').definition,
  ...require('../documents/agent-filing').definitions,
  require('../imports/agent-count-source').definition,
  require('../imports/agent-exact-variant-import').definition,
  require('../purchasing/agent-receiving-documents').definition,
  require('../sales/agent-customer-pricing').definition,
  require('./agent-work-digest').definition,
  require('../pricing/channel-price-review').definition,
  require('./repeated-corrections').definition,
  require('../sales/recurring-orders').definition,
  require('../actions/financial-visibility').definition,
  ...require('./automation-opportunities').definitions,
  {id:13,key:'kit-capacity',label:'Kits you can build now',filterLabel:'Kit SKU',readPage:require('../purchasing/agent-kit-reorders').review},
  require('../forecasting/warehouse-slotting').definition,
  {id:15,key:'monthly-product-classes',label:'Review monthly ABC product classes',filterLabel:'Product code, name or class',readPage:require('../forecasting/monthly-product-classes').review},
  {id:21,key:'reorder-settings',label:'Review reorder settings from local sales',filterLabel:'SKU',readPage:require('../forecasting/location-reorder-rules').review},
  require('../forecasting/location-reorder-rules').definition,
  require('../connections/agent-mail-triage').definition,
  require('../reports/manager-presentation').definition,
  require('../purchasing/dual-approval').definition,
  ...require('../purchasing/approval-routing').definitions,
  require('./vacation-deputy').definition,
  require('./circuit-breaker').definition,
  ...require('./partner-habits').definitions,
  ...require('../operations/agent-count-tasks').definitions,
  ...require('../accounting/agent-report-packs').definitions,
  ...require('./activity-watches').definitions,
  ...require('./daily-briefs').definitions,
  {id:163,key:'service-levels',label:'Forecast accuracy, fill rate and on-time delivery',filterLabel:'Customer or supplier name',readPage:require('../forecasting/agent-service-levels').report},
  {id:167,key:'brand-watches',label:'Watch stock levels by brand',sql:require('./brand-watches').matching,
    summary:'Compares the physical quantity of each active SKU across locations against the saved watch for its product brand.'},
  {id:124,key:'transfer-arrivals',label:'Check transfer arrivals and outstanding units',usesDate:true,sql:require('./operational-notices').transfers,
    summary:'Compare dispatch with physical receipts, recorded loss or damage and stock still in transit. Receiving teams see scheduled follow-ups for their assigned warehouses. Open each transfer for its product quantities.'},
  {id:162,key:'stock-health',label:'Review stock turns, margin return and days of supply',readPage:require('../forecasting/agent-stock-health').report},
  {id:131,key:'product-categories',label:'Suggest categories and tags for new products',readPage:require('./product-classification').review},
  {id:129,key:'supplier-specifications',label:'Fill missing product specifications from a supplier file',filterLabel:'Approved supplier file name or import ID',readPage:require('../domain/agent-supplier-specs').review},
  {id:200,key:'catalog-health',label:'Check your data health score',readPage:require('./catalog-health').health},
  require('../catalog/agent-catalog-fixes').definition,
  {id:17,key:'stock-age',label:'Review stock by age for a possible write-down',readPage:require('../forecasting/agent-stock-age').review},
  {id:9,key:'slow-stock',label:'Find dead and slow stock',readPage:require('../forecasting/agent-excess-stock').slowStock},
  {id:106,key:'cash-in-stock',label:'Review cash tied up in stock',readPage:require('../forecasting/agent-excess-stock').cashInStock},
  {id:86,key:'clearance-plan',label:'Estimate proceeds from clearance stock',readPage:require('../forecasting/agent-excess-stock').clearance,
    requiresChange:true,changeLabel:'Proposed markdown (%)',minChange:0,maxChange:100},
  {id:58,key:'timely-shipping-rates',label:'Find the least expensive service meeting the delivery date',readPage:require('../shipping/agent-delivery-rates').review},
  ...require('../sales/agent-credit-pricing'),
  ...require('../sales/agent-order-checks').definitions,
  require('../purchasing/agent-supplier-delivery-chases').definition,
  require('../purchasing/agent-supplier-ship-promises').definition,
  require('../purchasing/agent-supplier-returns').definition,
  require('../sales/agent-stock-protections').definition,
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
  118:r=>r.Quantity?'Request '+r.Quantity+' '+r.Unit+' of '+r.SKU+' from '+r.From+' to '+r.To+' while protecting the source target.':r.SKU+' at '+r.To+' · '+r.Review,
  85:r=>'Order '+r.Order+' has '+r['Posted net sales']+' posted net sales and '+r['Net contribution']+' net contribution after checked costs. '+r.Review,
  40:r=>r.Review,
  13:r=>require('../purchasing/agent-kit-reorders').suggestion(r),
  162:r=>r['Days of supply']==null?'Check the sales and valuation records for '+r.SKU+'.':'Review '+r.SKU+' with '+r['Days of supply']+' days of stock at its recorded sales rate.',
  126:r=>'Review '+r.Product+'. '+r['What to fix']+'.',
  17:r=>r.SKU+' at '+r.Location+(r['Days since receipt']===null?' has unconfirmed age.':
    ' has '+r.Units+' recorded units received '+r['Days since receipt']+' days ago.')+' '+r.Review+'.',
  9:r=>r.SKU+' at '+r.Location+' · '+r.Finding+'. '+r['Suggested next step'],
  86:r=>'Review '+r['Clearance units']+' units of '+r.SKU+' at '+r.Location+' for clearance.',
  58:r=>r.Service?'Consider '+r.Service+' at '+r.Price+' for '+r.Shipment+'. Carrier arrival '+r['Carrier arrival']+'.':r.Shipment+' · '+r.Status+'.',
  54:r=>'Check order '+r.Order+' for '+r.Customer+'. '+r['Unreserved units']+' unreserved units and '+r['Overdue invoices']+' overdue invoices.'+
    (r['Problems found']?' Sample check: '+r['Problems found']+' Checking every order on its own needs Growth.':''),
  55:r=>'Review a credit hold for '+r.Order+'. The customer has '+r['Overdue invoices']+' overdue invoices.',
  3:r=>'Check '+r.SKU+' at '+r.Location+'. '+r.Problem+'.',
  64:r=>'Review '+r.Order+' for '+r.Customer+'. '+r['Waiting units']+' units of '+r.SKU+' are still waiting for stock.',
  116:r=>'Review returns for '+r.Name+'. '+r['Returned units']+' of '+r['Fulfilled units']+' fulfilled '+(r.Unit==='unit'?'units':r.Unit)+
    ' were returned. '+r.Finding+'.',
  110:r=>'Review the '+r.Month+' purchase budget for '+r.Category+' in '+r.Currency+'.',
  144:r=>r['Next 7 days']==null?'Record more customer orders for '+r.SKU+' before forecasting.':'Plan for about '+r['Next 7 days']+' units of '+r.SKU+' over the next week.',
  146:r=>r['Estimated units in 30 days']==null?'No comparable sales history for '+r.SKU+' yet.':'Consider about '+r['Estimated units in 30 days']+' units for '+r.SKU+' over its first 30 days.',
  4:r=>'Count '+r.Shelf+' at '+r.Warehouse+' first. Start with '+r.SKU+'. '+r.Reason+'.',
  21:r=>'Consider a reorder point of '+r['Reorder point']+' units for '+r.SKU+' based on '+r['Sold in 90 days']+' units sold in 90 days.',
  22:r=>'Consider '+r.Supplier+' for '+r['Compared quantity']+' '+r.Unit+' of '+r.SKU+'. Recorded goods total: '+(r['Goods total']||'unknown')+'; delivery days: '+(r['Lead days']??'unknown')+'. '+r.Status+'.',
  23:r=>'Review the minimum order and freight terms with '+r.Supplier+' before placing the purchase order.',
  32:r=>'Contact '+r.Supplier+' about '+r.Order+'. '+r.Reason+'.',
  44:r=>'Review '+r.Order+' against its delivery record for '+r.SKU+'.',
  79:r=>'Consider '+r.Product+' for this quote. It appeared in '+r['Shared orders']+' shared orders.',
  80:r=>'Review the credit limit for '+r.Customer+' before confirming '+r.Order+'. '+r.Result+'.',
  77:r=>'Consider '+r['Suggested selling price']+' '+r.Currency+' per '+r['Pricing unit']+' for '+r.SKU+
    ' after its cost rose from '+r['Previous cost']+' to '+r['Current cost']+' ('+r['Current cost evidence']+').',
  88:r=>'Review the ordering history for '+r.Customer+'. '+r.Health+'.',
  90:r=>'Review '+r.Supplier+' using its '+r['Placed orders']+' recorded purchase orders.',
  91:r=>'Review '+r.Document+' for '+r.SKU+'. It shows '+r['Supplier unit price']+' compared with '+r['Previous trusted price']+' from '+r.Basis+'.',
  99:r=>'Review supplier invoice '+r.Invoice+' with '+r.Supplier+'. '+r.Problem,
  105:r=>'Check '+r['Credit or return']+' with '+r.Supplier+(r.Amount?' for '+r.Amount:'')+(r.Bill?' against bill '+r.Bill:'')+'. '+r.Status+'.',
  108:r=>'Review bill '+r.Bill+' before '+r['Discount deadline']+' for an early-payment discount.',
  109:r=>r['Week beginning']+' · '+r.Currency+'. '+r.Review,
  148:r=>'Review replenishment for '+r.SKU+' because its shipped units rose in the last week.'
};

function firstSuggestion(def,rows){
  if(def.id===97)return rows.slice(0,1).map(row=>({Suggestion:row.Suggestion}));
  // Build counts are answers, so Starter sees every kit and warehouse on the page.
  if(def.id===13)return rows.slice(0,100).map(row=>({Suggestion:suggestions[13](row)}));
  const describe=suggestions[def.id];
  if(!describe)return [];
  return rows.slice(0,1).map(row=>({Suggestion:describe(row)}));
}

async function run(db,ctx,key,options={}){
  const def=keys.get(key);
  if(!def) throw new NotFoundError();
  const state=await ownerState(db,ctx),tier=policy.usesAgentTerms(state)?state.plan:null;
  policy.requireJob(tier,def.id,options.scheduled?'automatic':'suggest',{trained:options.trained===true});
  if(def.id===122&&options.scheduled){
    const authority=await require('./postgres-service').getState(db,ctx.workspaceId);
    const reason=await require('./job-modes').restriction(db,ctx.workspaceId,def.id,true);
    if(!authority.canAutomate||reason)throw new ValidationError(reason||'Enable routine work before scheduling warehouse move lists.');
  }
  const mode=policy.allowance(tier,def.id),filter=String(options.filter||'').trim();
  if(filter.length>150) throw new ValidationError('Use an item code, supplier, customer or record number up to 150 characters.');
  const page=mode==='suggest'?1:Number(options.page||1);
  if(!Number.isSafeInteger(page)||page<1||page>1000000) throw new ValidationError('Choose a valid results page.');
  if(def.requiresFilter && !filter) return {label:def.label,summary:'Enter the exact '+(def.prompt||(def.id===195?'serial number':'SKU'))+' to look up.',rows:[],mode,filterable:true};
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  let rows,summary=def.summary,more=false,paymentRun;
  if(def.readPage){
    const result=await def.readPage(db,ctx,{filter,page,today,change:options.change,adviceOnly:mode==='suggest'});
    const inputs={requiresChange:def.requiresChange,change:options.change,changeLabel:def.changeLabel,minChange:def.minChange,maxChange:def.maxChange,filterLabel:def.filterLabel,
      ...(def.id===91?{supplierPriceListLink:true}:{})};
    if(mode==='suggest')return {label:def.label,summary:result.summary,...(def.id===97?{supplierBenefitLink:true}:{}),
      rows:firstSuggestion(def,result.rows),mode,more:false,page:1,filterable:true,...inputs};
    return {label:def.label,summary:result.summary,rows:result.rows,more:result.more,page,mode,filterable:true,
      ...(result.cyclePlan?{cyclePlan:true}:{}),
      ...(result.partnerStockForm?{partnerStockForm:result.partnerStockForm}:{}),
      ...(result.pickReleaseForm?{pickReleaseForm:result.pickReleaseForm}:{}),
      ...(result.putawayForm?{putawayForm:result.putawayForm}:{}),
      ...(result.landedCostForm?{landedCostForm:result.landedCostForm}:{}),
      ...(result.negotiationForm?{negotiationForm:result.negotiationForm}:{}),
      ...(result.recurringForm?{recurringForm:result.recurringForm}:{}),
      ...(result.mapForm?{mapForm:result.mapForm}:{}),
      ...(result.undoForm?{undoForm:result.undoForm}:{}),
      ...(result.bankMatchForm?{bankMatchForm:result.bankMatchForm}:{}),
      ...(result.reminderForm?{reminderForm:result.reminderForm}:{}),
      ...(result.arrivedStockForm?{arrivedStockForm:result.arrivedStockForm}:{}),
      ...(result.stockReadyForm?{stockReadyForm:result.stockReadyForm}:{}),
      ...(def.id===65?{stockSharingLink:true}:{}),
      ...(def.id===121?{warehouseRoutingLink:true}:{}),
      ...(result.invoiceDisputeForm?{invoiceDisputeForm:result.invoiceDisputeForm}:{}),
      ...(result.returnLabelForm?{returnLabelForm:result.returnLabelForm}:{}),
      ...(result.customerStatementForm?{customerStatementForm:result.customerStatementForm}:{}),
      ...(def.id===78?{customerCheckinLink:true}:{}),
      ...(def.id===105?{supplierCreditLink:true}:{}),
      ...(result.reorderForm?{reorderForm:true}:{}),
      ...(result.supplierSelection?{supplierSelection:true}:{}),
      ...(result.rotationForm?{rotationForm:true}:{}),
      ...(def.id===196?{lotCertificateLink:true}:{}),
      ...(def.id===137?{shippingDocumentLink:true}:{}),
      ...(result.balanceForm?{balanceForm:true}:{}),
      ...(def.id===142?{documentDiscoveryLink:true}:{}),
      ...(def.id===130?{variantImportLink:true}:{}),
      ...inputs};
  }
  if(def.read){
    const result=await def.read(db,ctx,{today,adviceOnly:mode==='suggest'});
    rows=result.rows;summary=result.summary;paymentRun=result.paymentRun;
    more=rows.length>page*100;
    rows=rows.slice((page-1)*100,page*100);
  }else{
    const args=def.usesDate?[ctx.workspaceId,filter,today]:[ctx.workspaceId,filter];
    if(def.salesHistory)args.push((await require('../commercial/agent-history').access(db,ctx.workspaceId)).salesFrom);
    const sql=await require('../purchasing/direct-shipment-trace').extend(db,ctx,def);
    args.push((page-1)*100);
    rows=(await db.query(sql+' LIMIT 101 OFFSET $'+args.length,args)).rows;
    more=rows.length>100;rows=rows.slice(0,100);
  }
  if(def.id===99)for(const row of rows)row.Problem=require('../purchasing/postgres-invoice-review').differenceLabel(row.Problem);
  if(mode==='suggest'){
    rows=firstSuggestion(def,rows);more=false;
  }
  return {label:def.label,summary,rows,more,page,mode,filterable:!def.read,
    ...(paymentRun?{paymentRun}:{}),...(def.id===22&&mode!=='suggest'?{supplierSelection:true}:{}),
    ...(def.id===124?{transferArrivalLink:true}:{}),...(def.id===64?{backorderLink:true}:{}),...(def.id===32?{staleIncomingLink:true}:{})};
}

module.exports={definitions,ownerState,offers,run};
