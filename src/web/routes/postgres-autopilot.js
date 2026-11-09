'use strict';
const {ValidationError}=require('../../domain/errors');

const express=require('express');
const autonomy=require('../../autopilot/postgres-service');
const assistant=require('../../assistant/postgres-service');
const monitoring=require('../../operations/postgres-monitoring');
const { requireAuth,asyncRoute }=require('../middleware');
const {requireCapability}=require('../commercial-middleware');
const entitlements=require('../../entitlements/postgres-service');
const {commercialScope}=require('../commercial-middleware');
const {newId}=require('../../lib/util');

function createPostgresAutopilotRouter(database){
  const router=express.Router();
  const playbooks=require('../../autopilot/playbooks');
  const owner=require('../middleware').requireOwner;
  const reviews=require('../../autopilot/job-reviews');
  const policy=require('../../commercial/agent-plan');
  router.post('/autopilot/supplier-disputes/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await assistant.prepareAction(database,req.ctx,'Ask the supplier to review this invoice difference',{action:'supplier_invoice.dispute',recordReference:req.body.billNumber,mailbox:req.body.connectorId});
    if(!prepared.proposal?.id)throw new ValidationError(prepared.answer||'Choose the exact disputed supplier bill and sending mailbox.');res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/stock-ready/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await assistant.prepareAction(database,req.ctx,'Prepare a stock-ready update for this waiting customer',{action:'sales_order.notify_stock_ready',recordReference:req.body.orderNumber,mailbox:req.body.connectorId});
    if(!prepared.proposal?.id)throw new ValidationError(prepared.answer||'Choose an exact previously backordered order that is now fully reserved.');
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/stock-ready/settings',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../sales/agent-stock-ready').configure(database,req.ctx,req.body);res.redirect(303,'/autopilot/reviews/stock-ready-updates');
  }));
  router.post('/autopilot/arrived-stock/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await assistant.prepareAction(database,req.ctx,'Reserve arrived stock for the selected confirmed backorder',{action:'sales_order.reserve_arrived',recordReference:req.body.orderNumber});
    if(!prepared.proposal?.id)throw new ValidationError(prepared.answer||'Choose the exact current backorder before preparing its reservation.');
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/invoice-reminders/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await assistant.prepareAction(database,req.ctx,'Prepare the selected customer invoice reminder',{action:'customer_invoice.remind',recordReference:req.body.invoiceNumber,mailbox:req.body.connectorId});
    if(!prepared.proposal?.id)throw new ValidationError(prepared.answer||'Choose the exact current invoice before preparing its reminder.');
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/invoice-reminders/schedule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../accounting/agent-invoice-reminders').configure(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/reviews/invoice-reminders');
  }));
  router.post('/autopilot/customer-payments/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await assistant.prepareAction(database,req.ctx,'Match the selected recorded bank credit to its issued invoice',{action:'customer_payment.match_bank_line',recordReference:req.body.invoiceNumber,bankTransaction:req.body.bankTransaction});
    if(!prepared.proposal?.id)throw new ValidationError(prepared.answer||'Review the current bank credit and invoice before preparing a match.');
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.get('/autopilot/documents',requireAuth,owner,asyncRoute(async(req,res)=>{
    const filing=require('../../documents/agent-filing'),scoped=Boolean(req.query.kind||req.query.record);
    const documents=await (scoped?filing.forRecord(database,req.ctx,req.query.kind,req.query.record,req.query.after):filing.directory(database,req.ctx,req.query.after));
    res.page('autopilot/record-documents',{title:'Documents · '+documents.reference,nav:'autopilot',documents,documentQuery:scoped?new URLSearchParams({kind:req.query.kind,record:req.query.record}).toString():'',backTo:{href:documents.targetHref,label:scoped?documents.reference:'Inventory'}});
  }));
  router.get('/autopilot/documents/:id/download',requireAuth,owner,asyncRoute(async(req,res)=>{
    const document=await require('../../documents/agent-filing').load(database,req.ctx,req.params.id);
    res.type('application/octet-stream').attachment(document.filename).send(document.content);
  }));
  router.get('/autopilot/documents/:id',requireAuth,owner,asyncRoute(async(req,res)=>{
    const document=await require('../../documents/agent-filing').load(database,req.ctx,req.params.id);
    res.page('autopilot/filed-document',{title:'Filed document',nav:'autopilot',document,documentFactLabels:require('../../documents/agent-product-facts').labels,backTo:{href:document.targetHref,label:document.target_reference}});
  }));
  const jobModes=require('../../autopilot/job-modes');
  router.get('/autopilot/job-modes',requireAuth,owner,asyncRoute(async(req,res)=>{
    res.page('autopilot/job-modes',{title:'Authority by job',nav:'autopilot',jobs:await jobModes.page(database,req.ctx),modes:jobModes.modes});
  }));
  router.post('/autopilot/job-modes/:id',requireAuth,owner,asyncRoute(async(req,res)=>{
    await jobModes.save(database,req.ctx,req.params.id,req.body);
    res.redirect(303,'/autopilot/job-modes#job-'+Number(req.params.id));
  }));
  router.post('/autopilot/recurring-orders',requireAuth,owner,asyncRoute(async(req,res)=>{
    const recurring=require('../../sales/recurring-orders');
    if(req.body.pause==='1')await recurring.pause(database,req.ctx,req.body.id,req.body.revision);
    else{
      let source={};
      if(req.body.sourceOrderId){
        source=(await database.query('SELECT customer_id AS "customerId",order_number AS "sourceOrderNumber" FROM sales_orders WHERE workspace_id=$1 AND id=$2',[req.ctx.workspaceId,req.body.sourceOrderId])).rows[0];
        if(!source)throw new (require('../../domain/errors').ValidationError)('Choose a confirmed customer order from this inventory.');
      }
      await recurring.configure(database,req.ctx,{...req.body,...source});
    }
    res.redirect(303,'/autopilot/reviews/recurring-customer-orders');
  }));
  router.post('/autopilot/map-terms',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../pricing/channel-price-review').save(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/reviews/channel-prices');
  }));
  router.post('/autopilot/undo/:id',requireAuth,owner,asyncRoute(async(req,res)=>{
    const day=String(req.body.day||'');if(day)require('../../lib/business-time').dayBoundary(day,'UTC');
    await require('../../autopilot/agent-work-digest').undo(database,req.ctx,req.params.id);
    res.redirect(303,'/autopilot/reviews/daily-work'+(day?'?'+new URLSearchParams({filter:day}):''));
  }));
  const requests=require('../../purchasing/agent-purchase-requests');
  const budgets=require('../../purchasing/agent-budgets');
  router.post('/actions/:id/draft-rule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../autopilot/draft-authority').save(database,req.ctx,req.params.id,req.body);
    res.redirect(303,'/actions/'+encodeURIComponent(req.params.id));
  }));
  const buying=require('../../purchasing/agent-order-quantities');
  router.get('/purchasing/freight/:id',requireAuth,owner,asyncRoute(async(req,res)=>{
    return agentPage(req,res,'autopilot/freight-terms',{title:'Supplier freight terms',nav:'purchasing'},
      async()=>({supplier:await buying.freightSettings(database,req.ctx,req.params.id)}));
  }));
  router.post('/purchasing/freight/:id',requireAuth,owner,asyncRoute(async(req,res)=>{
    await buying.saveFreight(database,req.ctx,{...req.body,supplierId:req.params.id});
    res.redirect(303,'/autopilot/reviews/supplier-minimums');
  }));
  router.get('/purchasing/budgets',requireAuth,owner,asyncRoute(async(req,res)=>{
    return agentPage(req,res,'autopilot/purchase-budgets',{title:'Purchase budgets',nav:'purchasing'},
      ()=>budgets.settings(database,req.ctx,req.query.month));
  }));
  router.post('/purchasing/budgets',requireAuth,owner,asyncRoute(async(req,res)=>{
    await budgets.save(database,req.ctx,req.body);
    res.redirect(303,'/purchasing/budgets?'+new URLSearchParams({month:req.body.month}));
  }));
  // A locked destination remains a useful page. The underlying services still
  // enforce the plan on every read and mutation; only the HTML presentation changes.
  async function agentPage(req,res,view,locals,load,lockedStatus=200){
    try{return res.page(view,{...locals,...(await load())});}
    catch(error){if(error.code!=='entitlement_required')throw error;
      res.status(lockedStatus);
      return res.page('autopilot/locked',{...locals,message:error.message});}
  }
  const lots=require('../../autopilot/lot-controls');
  const edi=require('../../connections/postgres-orderful-test');
  router.get('/autopilot/orderful',requireAuth,owner,asyncRoute(async(req,res)=>{
    res.page('autopilot/orderful',{title:'Orderful retail test',nav:'autopilot',...(await edi.dashboard(database,req.ctx))});
  }));
  router.post('/autopilot/orderful/connect',requireAuth,owner,asyncRoute(async(req,res)=>{
    await edi.connect(database,req.ctx,req.body);res.redirect(303,'/autopilot/orderful');
  }));
  router.post('/autopilot/orderful/disconnect',requireAuth,owner,asyncRoute(async(req,res)=>{
    await edi.disconnect(database,req.ctx);res.redirect(303,'/autopilot/orderful');
  }));
  router.post('/autopilot/orderful/rule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await edi.configure(database,req.ctx,req.body.action);res.redirect(303,'/autopilot/orderful');
  }));
  router.post('/autopilot/orderful/receive',requireAuth,owner,asyncRoute(async(req,res)=>{
    await edi.receive(database,req.ctx,req.body.transactionId);res.redirect(303,'/autopilot/orderful');
  }));
  router.post('/autopilot/orderful/:source/:kind/:record/send',requireAuth,owner,asyncRoute(async(req,res)=>{
    await edi.send(database,req.ctx,req.params.source,req.params.kind,req.params.record);res.redirect(303,'/autopilot/orderful');
  }));
  router.post('/autopilot/orderful/:source/:kind/:record/reconcile',requireAuth,owner,asyncRoute(async(req,res)=>{
    await edi.reconcile(database,req.ctx,req.params.source,req.params.kind,req.params.record,req.body.providerUuid);res.redirect(303,'/autopilot/orderful');
  }));
  const shipbob=require('../../connections/postgres-shipbob-sandbox');
  router.get('/autopilot/shipbob',requireAuth,owner,asyncRoute(async(req,res)=>{
    const data=await shipbob.dashboard(database,req.ctx);
    const review=req.query.order?await shipbob.draft(database,req.ctx,req.query.order):null;
    res.page('autopilot/shipbob-sandbox',{title:'ShipBob sandbox',nav:'autopilot',...data,review});
  }));
  router.post('/autopilot/shipbob/connect',requireAuth,owner,asyncRoute(async(req,res)=>{
    await shipbob.connect(database,req.ctx,req.body);res.redirect(303,'/autopilot/shipbob');
  }));
  router.post('/autopilot/shipbob/disconnect',requireAuth,owner,asyncRoute(async(req,res)=>{
    await shipbob.disconnect(database,req.ctx);res.redirect(303,'/autopilot/shipbob');
  }));
  router.post('/autopilot/shipbob/rule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await shipbob.configureRule(database,req.ctx,req.body);res.redirect(303,'/autopilot/shipbob');
  }));
  router.post('/autopilot/shipbob/stock',requireAuth,owner,asyncRoute(async(req,res)=>{
    await shipbob.stock(database,req.ctx,req.body);res.redirect(303,'/autopilot/shipbob');
  }));
  router.post('/autopilot/shipbob/:order/send',requireAuth,owner,asyncRoute(async(req,res)=>{
    await shipbob.send(database,req.ctx,req.params.order,req.body.reviewHash);res.redirect(303,'/autopilot/shipbob');
  }));
  router.post('/autopilot/shipbob/:order/refresh',requireAuth,owner,asyncRoute(async(req,res)=>{
    await shipbob.refresh(database,req.ctx,req.params.order);res.redirect(303,'/autopilot/shipbob');
  }));
  router.get('/autopilot/lots',requireAuth,owner,asyncRoute(async(req,res)=>{
    const detail=req.query.lot||req.query.sku?await lots.details(database,req.ctx,req.query):null;
    res.page('autopilot/lot-controls',{title:'Lot controls',nav:'autopilot',detail});
  }));
  for(const [path,action] of [['recall',lots.recall],['certificates',lots.certificate]]){
    router.post('/autopilot/lots/'+path,requireAuth,owner,asyncRoute(async(req,res)=>{
      await action(database,req.ctx,req.body);
      res.redirect(303,'/autopilot/lots?'+new URLSearchParams({sku:req.body.sku,lot:req.body.lot}));
    }));
  }
  router.get('/autopilot/reviews',requireAuth,owner,asyncRoute(async(req,res)=>{
    const state=await reviews.ownerState(database,req.ctx);
    let ediEnabled=true;
    try{await edi.access(database,req.ctx);}catch(error){if(error.code!=='entitlement_required')throw error;ediEnabled=false;}
    res.page('autopilot/reviews',{ediEnabled,title:'Agent reviews',nav:'autopilot',offers:reviews.offers(state),shipbobEnabled:policy.usesAgentTerms(state)&&policy.permits(state.plan,186,'draft')});
  }));
  router.post('/autopilot/pick-release/recheck',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../warehouse/agent-pick-release').recheck(database,req.ctx);res.redirect(303,'/autopilot/reviews/pick-release');
  }));
  router.post('/autopilot/pick-release/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await require('../../assistant/postgres-service').prepareAction(database,req.ctx,'Release the next ready orders at this warehouse',{action:'warehouse.release_orders',recordReference:req.body.order,quantity:req.body.quantity,strategy:req.body.strategy});
    if(prepared.status!=='PREPARED')throw new (require('../../domain/errors').ValidationError)(prepared.message||'Choose the first ready order at this warehouse.');
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/partner-stock-readings',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../connections/agent-partner-stock-reads').configure(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/reviews/third-party-stock');
  }));
  router.get('/autopilot/reviews/:job',requireAuth,owner,asyncRoute(async(req,res)=>{
    return agentPage(req,res,'autopilot/review-result',{title:'Agent review',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'}},async()=>{
      const result=await reviews.run(database,req.ctx,req.params.job,{filter:req.query.filter,page:req.query.page,change:req.query.change});
      const packs=require('../../accounting/agent-report-packs');
      if(Object.hasOwn(packs.downloads,req.params.job)&&(req.params.job!=='quarterly-supplier-pack'||result.rows.length)){
        result.download='/autopilot/reviews/'+req.params.job+'/download?'+new URLSearchParams({filter:req.query.filter||''});
        result.downloadLabel=packs.downloads[req.params.job].label;
      }
      if(req.params.job==='margin-prices'&&result.mode==='draft')result.reviewPrices=true;
      if(req.params.job==='supplier-specifications')result.specForm=true;
      if(req.params.job==='warehouse-slotting')result.binDistanceForm=true;
      if(req.params.job==='brand-watches')result.watches=await require('../../autopilot/brand-watches').list(database,req.ctx.workspaceId);
      if(req.params.job==='staff-count-lists')result.countAssignments={...await require('../../operations/agent-count-tasks').setup(database,req.ctx),requestKey:newId('count-assignment'),selectedLocationId:req.query.locationId};
      if(req.params.job==='vacation-deputy')result.vacation=await require('../../autopilot/vacation-deputy').setup(database,req.ctx);
      if(req.params.job==='purchase-approval-threshold'){
        const rule=await require('../../purchasing/dual-approval').setting(database,req.ctx.workspaceId);
        result.purchaseThreshold={...rule,amount:rule.amount_minor==null?'':require('../../domain/currency').fromMinor(rule.amount_minor,rule.currency)};
      }
      const watch=require('../../autopilot/activity-watches'),job=watch.definitions.find(d=>d.key===req.params.job);
      if(job&&[170,171].includes(job.id))result.watchSettings={job:job.id,...await watch.settings(database,req.ctx.workspaceId,job.id)};
      if(['combine-draft-orders','split-draft-orders'].includes(req.params.job))result.purchaseGrouping=req.params.job;
      if(req.params.job==='overdue-customer-orders')result.overdueRule=await require('../../sales/agent-order-checks').rule(database,req.ctx.workspaceId);
      return {title:result.label,result,filter:req.query.filter||''};
    },402);
  }));
  router.post('/autopilot/alert-settings/:id',requireAuth,owner,asyncRoute(async(req,res)=>{
    const watch=require('../../autopilot/activity-watches'),id=Number(req.params.id);
    await watch.save(database,req.ctx,id,req.body);
    res.redirect(303,'/autopilot/reviews/'+watch.spec[id].key);
  }));
  router.post('/autopilot/vacation-deputy',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../autopilot/vacation-deputy').save(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/reviews/vacation-deputy');
  }));
  router.post('/autopilot/negotiation-draft',requireAuth,owner,asyncRoute(async(req,res)=>{
    const id=await require('../../purchasing/negotiation-drafts').prepare(database,req.ctx,req.body);
    res.redirect(303,'/messages/supplier/'+id);
  }));
  router.post('/autopilot/negotiation-rule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../purchasing/negotiation-drafts').configure(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/reviews/supplier-negotiation?'+new URLSearchParams({filter:req.body.supplier}));
  }));
  router.post('/autopilot/reviews/warehouse-slotting/distances',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../forecasting/warehouse-slotting').saveDistance(database,req.ctx,req.body);
    req.flash('success','Walking distance saved.');res.redirect(303,'/autopilot/reviews/warehouse-slotting');
  }));
  router.post('/autopilot/purchase-approval-threshold',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../purchasing/dual-approval').configure(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/reviews/purchase-approval-threshold');
  }));
  router.post('/autopilot/reviews/brand-watches/rules',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../autopilot/brand-watches').save(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/reviews/brand-watches');
  }));
  router.get('/autopilot/reviews/:job/download',requireAuth,owner,asyncRoute(async(req,res)=>{
    const packs=require('../../accounting/agent-report-packs');
    const definition=packs.definitions.find(d=>d.key===req.params.job);
    if(!definition)throw new (require('../../domain/errors').NotFoundError)();
    await policy.requireWorkspaceJob(database,req.ctx.workspaceId,definition.id,'suggest');
    const report=await database.transaction(async c=>definition.readPage(c,req.ctx,{download:true,filter:req.query.filter,today:await require('../../lib/business-time').today(c,req.ctx.workspaceId)}),{isolation:'REPEATABLE READ'});
    const format=packs.downloads[definition.key],file=await format.render(report);
    res.set('Cache-Control','private, no-store').attachment(definition.key+'-'+report.span.closing+'.'+format.extension).send(file);
  }));
  router.post('/autopilot/reviews/overdue-customer-orders/rule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../sales/agent-order-checks').configure(database,req.ctx,req.body.mode);
    res.redirect(303,'/autopilot/reviews/overdue-customer-orders');
  }));
  router.post('/autopilot/reviews/margin-prices/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await assistant.prepareAction(database,req.ctx,'Review the selling price after the cost increase',
      {action:'catalog.restore_margin',sku:req.body.sku});
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/reviews/:job/regroup',requireAuth,owner,asyncRoute(async(req,res)=>{
    const actions={'combine-draft-orders':'purchase_order.combine_drafts','split-draft-orders':'purchase_order.split_draft'};
    if(!Object.hasOwn(actions,req.params.job))throw new ValidationError('Choose a purchase-order grouping.');
    const args={action:actions[req.params.job],sourceOrders:req.body.sourceOrders,splitStrategy:req.body.splitStrategy,budgetAmount:req.body.budgetAmount};
    if(args.splitStrategy==='delivery-date')args.lineDates=JSON.stringify(String(req.body.lineDates||'').trim().split(/\r?\n/).map(line=>{
      const match=/^\s*(\d+)\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(line);
      if(!match)throw new ValidationError('Enter one line number and date per row, for example 1 2027-02-14.');
      return {line:Number(match[1]),date:match[2]};
    }));
    const prepared=await assistant.prepareAction(database,req.ctx,'Review replacement purchase orders',args);
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/reviews/supplier-specifications/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    await policy.requireWorkspaceJob(database,req.ctx.workspaceId,129,'draft');
    const prepared=await require('../../assistant/postgres-service').prepareAction(database,req.ctx,'Review the supplier file product specifications',
      {action:'catalog.fill_supplier_specs',sourceImport:req.body.sourceImport,sourcePage:Number(req.body.sourcePage||1),sku:req.body.sku||undefined});
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.get('/purchasing/requests',requireAuth,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/purchase-requests',{
    title:'Staff purchase requests',nav:'purchasing',requestKey:newId('req')},()=>requests.page(database,req.ctx))));
  router.post('/purchasing/requests',requireAuth,asyncRoute(async(req,res)=>{
    await requests.submit(database,req.ctx,req.body);res.redirect(303,'/purchasing/requests');
  }));
  router.post('/purchasing/requests/:id/decision',requireAuth,owner,asyncRoute(async(req,res)=>{
    const po=await requests.decide(database,req.ctx,req.params.id,req.body);
    res.redirect(303,po?'/purchasing/orders/'+encodeURIComponent(po):'/purchasing/requests');
  }));
  const timeSaved=require('../../autopilot/time-saved');
  router.get('/autopilot/time-saved',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/time-saved',{
    title:'Time saved',nav:'autopilot',backTo:{href:'/autopilot',label:'StockChief AI'},requestKey:newId('timing'),
    },()=>timeSaved.report(database,req.ctx,req.query.period))));
  router.post('/autopilot/time-saved',requireAuth,owner,asyncRoute(async(req,res)=>{
    await timeSaved.sample(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/time-saved'+(req.body.period==='month'?'?period=month':''));
  }));
  router.get('/autopilot/playbooks',requireAuth,owner,asyncRoute(async(req,res)=>res.page('autopilot/playbooks',{
    title:'Playbooks',nav:'autopilot',backTo:{href:'/autopilot',label:'StockChief AI'},requestKey:newId('run'),
    ...(await playbooks.list(database,req.ctx))})));
  router.post('/autopilot/playbooks',requireAuth,owner,asyncRoute(async(req,res)=>{
    await playbooks.create(database,req.ctx,req.body);res.redirect(303,'/autopilot/playbooks');
  }));
  router.post('/autopilot/playbooks/:id/run',requireAuth,owner,asyncRoute(async(req,res)=>{
    await playbooks.run(database,req.ctx,req.params.id,req.body.requestKey);res.redirect(303,'/autopilot/playbooks');
  }));
  router.post('/autopilot/playbooks/:id/delete',requireAuth,owner,asyncRoute(async(req,res)=>{
    await playbooks.remove(database,req.ctx,req.params.id);res.redirect(303,'/autopilot/playbooks');
  }));
  router.get('/autopilot/progress',requireAuth,asyncRoute(async(req,res)=>res.json(
    await require('../../operations/postgres-maintenance-progress').read(database,req.ctx.workspaceId))));
  router.get('/autopilot',requireAuth,asyncRoute(async(req,res)=>res.page('autopilot/postgres-settings',{
    title:'What StockChief does',nav:'autopilot',backTo:{href:'/settings',label:'Settings'},
    ...(await autonomy.dashboard(database,req.ctx.workspaceId))})));
  router.get('/autopilot/daily',requireAuth,(req,res)=>res.redirect(302,'/needs-you'));
  router.get('/autopilot/history',requireAuth,asyncRoute(async(req,res)=>{const {recent,activityAfter,next}=await autonomy.workHistory(database,req.ctx.workspaceId,req.query.after);
    const groups={automatic:[],prepared:[],needsYou:[],blocked:[]};
    for(const item of recent){item.executionStatus=item.execution_status;item.approvalRequirement=item.approval_requirement;
      item.errorMessage=item.error_message;item.createdAt=item.created_at;item.completedAt=item.completed_at;
      if(item.executionStatus==='COMPLETED')groups[item.approvalRequirement==='NONE'?'automatic':'prepared'].push(item);
      else if(['FAILED','CANCELLED','REFUSED'].includes(item.executionStatus))groups.blocked.push(item);else groups.needsYou.push(item);}
    const describe=(item)=>{const action=item.recommendedAction||{};const subject=action.displayName||action.itemName||item.category||'business work';
      return {headline:item.executionStatus==='COMPLETED'?`Completed ${subject}`:`Review ${subject}`,
        detail:item.policyEvaluation?.reason||item.errorMessage||'The evidence and exact limits are recorded on this work item.'};};
    return res.page('autopilot/history',{title:"StockChief's work",nav:'autopilot',groups,operations:[],evaluations:[],describe,activityAfter,next});
  }));
  router.get('/autopilot/misses',requireAuth,asyncRoute(async(req,res)=>res.page('autopilot/postgres-misses',{
    title:'Report an Ask problem',nav:'ask',room:true,selectedInteraction:typeof req.query.interaction==='string'?req.query.interaction:null,interactions:await assistant.listInteractions(database,req.ctx.workspaceId,30)})));
  router.post('/autopilot/misses',requireAuth,asyncRoute(async(req,res)=>{
    const interactions=await assistant.listInteractions(database,req.ctx.workspaceId,100);
    const turn=interactions.find((entry)=>entry.id===req.body.interactionId);
    if(!turn)throw new Error('Choose a recent Ask StockChief response from this inventory.');
    await monitoring.raise(database,{workspaceId:req.ctx.workspaceId,severity:'WARNING',kind:'assistant.reported_miss',
      title:'Ask StockChief response reported by owner',detail:`Question: ${turn.message}\nAnswer: ${turn.answer}\nOwner note: ${String(req.body.note||'').trim()||'No note supplied.'}`,
      fingerprint:`assistant.reported_miss:${turn.id}`});
    req.flash('success','Problem recorded with the exact question and answer. StockChief did not learn a new rule silently.');
    return res.redirect(303,'/autopilot/misses');
  }));
  router.post('/autopilot/mode',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.setMode(database,req.ctx,req.user,req.body.mode);req.flash('success','StockChief authority was updated.');
    return res.redirect(303,'/autopilot');
  }));
  router.post('/autopilot/capability',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.setCapability(database,req.ctx,req.user,String(req.body.capability||''),req.body.granted==='1');
    req.flash('success',req.body.granted==='1'
      ?'That one job is authorised. No other authority changed.'
      :'That authority was removed immediately. No other authority changed.');
    return res.redirect(303,'/autopilot#jobs');
  }));
  router.post('/autopilot/routine-authority',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.configureRoutine(database,req.ctx,req.user,req.body);
    req.flash('success','Saved versioned routine-work authority. Anything outside these exact limits still asks first.');
    return res.redirect(303,'/autopilot');
  }));
  router.post('/autopilot/pause',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.pause(database,req.ctx,req.user,req.body.reason);req.flash('success','Automatic work is paused.');
    return res.redirect(303,req.body.returnToHome==='1'?'/':'/autopilot');
  }));
  router.post('/autopilot/resume',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.resume(database,req.ctx,req.user);req.flash('success','StockChief is watching again. Old work will not be replayed.');
    return res.redirect(303,req.body.returnToHome==='1'?'/':'/autopilot');
  }));
  router.post('/autopilot/run',requireAuth,requireCapability(database,'forecasting.basic'),asyncRoute(async(req,res)=>{
    await require('../../operations/postgres-maintenance-progress').request(database,req.ctx);
    req.flash('success','Business review queued. You can leave this page; completed batches are saved automatically.');
    return res.redirect(303,req.body.returnToHome==='1'?'/':'/autopilot');
  }));
  router.get('/autopilot/approval-email/:workspaceId/:workId',require('../middleware').requireAccount,asyncRoute(async(req,res)=>{
    const {workspaceId,workId}=req.params;
    const workspace=res.locals.workspaces.find(w=>w.workspaceId===workspaceId&&w.isOwner&&w.role==='owner');
    if(!workspace)throw new (require('../../domain/errors').NotFoundError)();
    await policy.requireWorkspaceJob(database,workspaceId,175,'draft');
    const destination=workId==='inbox'?'/needs-you':'/autopilot/work/'+encodeURIComponent(workId);
    if(req.ctx?.workspaceId===workspaceId)return res.redirect(destination);
    return res.page('autopilot/approval-inventory',{title:'Open purchase approvals',workspace,workspaceId,destination});
  }));
  router.get('/autopilot/work/:id',requireAuth,asyncRoute(async(req,res)=>{const item=await autonomy.getWork(database,req.ctx.workspaceId,req.params.id),access=require('../../actions/permissions'),required=item.recommendedAction.type==='customer_order'?access.VIEW_SALES:item.recommendedAction.type==='supplier_invoice'?access.VIEW_ACCOUNTING:item.recommendedAction.type==='transfer'?access.VIEW_TRANSFERS:access.VIEW_PURCHASING;access.assertCan(req.user,required,'review this business workflow');let approvalBlock=null;const action=item.recommendedAction;
    // Say what is in the way before the person presses Approve, not after.
    if(item.execution_status==='WAITING_FOR_APPROVAL'&&action.type==='purchase'&&action.supplierId&&(action.unitCost==null||action.value==null)){
      approvalBlock={reason:'Record the supplier’s unit price before sending this purchase order.',href:'/suppliers/'+encodeURIComponent(action.supplierId),label:'Review supplier prices'};
    }else if(item.execution_status==='WAITING_FOR_APPROVAL'&&item.evidenceQuality?.level==='low'){
      approvalBlock={reason:item.evidenceQuality.reason,href:'/autopilot',label:'Review inventory and purchasing'};
    }else if(item.execution_status==='WAITING_FOR_APPROVAL'&&action.type!=='transfer'&&action.supplierId){const ready=await autonomy.supplierDeliveryReadiness(database,req.ctx.workspaceId,action.supplierId);
      if(!ready.ready)approvalBlock=/email address/.test(ready.reason||'')?{reason:(action.supplierName||'This supplier')+' has no order email address yet, so the order can’t be sent.',href:'/suppliers/'+encodeURIComponent(action.supplierId)+'?edit=1',label:'Add the supplier’s email'}:{reason:ready.reason,href:'/settings/connections',label:'Fix the connection'};}
    return res.page('autopilot/postgres-work',{
    title:'Review StockChief’s decision',nav:'autopilot',backTo:{href:'/needs-you',label:'Needs you'},
    item,approvalBlock});}));
  router.post('/autopilot/work/:id/approve',requireAuth,asyncRoute(async(req,res)=>{
    try{await autonomy.approve(database,req.ctx,req.user,req.params.id,{destinationLocationId:req.body.destinationLocationId||null});}
    catch(error){if(!(error instanceof ValidationError))throw error;req.flash('error',error.message);return res.redirect(303,`/autopilot/work/${req.params.id}`);}
    req.flash('success','The approved preparation was recorded. StockChief will keep following the linked order or transfer through its remaining work.');
    return res.redirect(303,`/autopilot/work/${req.params.id}`);
  }));
  router.post('/autopilot/work/:id/cancel',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.cancel(database,req.ctx,req.user,req.params.id);req.flash('success','Discarded. Nothing was executed.');
    return res.redirect(303,'/needs-you');
  }));
  return router;
}

module.exports={createPostgresAutopilotRouter};
