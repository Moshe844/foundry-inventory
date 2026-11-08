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
  const requests=require('../../purchasing/agent-purchase-requests');
  // A locked destination remains a useful page. The underlying services still
  // enforce the plan on every read and mutation; only the HTML presentation changes.
  async function agentPage(req,res,view,locals,load){
    try{return res.page(view,{...locals,...(await load())});}
    catch(error){if(error.code!=='entitlement_required')throw error;
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
  router.get('/autopilot/reviews/:job',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await reviews.run(database,req.ctx,req.params.job,{filter:req.query.filter,page:req.query.page,change:req.query.change});
    res.page('autopilot/review-result',{title:result.label,nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'},result,filter:req.query.filter||''});
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
  router.get('/autopilot/history',requireAuth,asyncRoute(async(req,res)=>{const recent=(await autonomy.dashboard(database,req.ctx.workspaceId)).recent;
    const groups={automatic:[],prepared:[],needsYou:[],blocked:[]};
    for(const item of recent){item.executionStatus=item.execution_status;item.approvalRequirement=item.approval_requirement;
      item.errorMessage=item.error_message;item.createdAt=item.created_at;item.completedAt=item.completed_at;
      if(item.executionStatus==='COMPLETED')groups[item.approvalRequirement==='NONE'?'automatic':'prepared'].push(item);
      else if(['FAILED','CANCELLED','REFUSED'].includes(item.executionStatus))groups.blocked.push(item);else groups.needsYou.push(item);}
    const describe=(item)=>{const action=item.recommendedAction||{};const subject=action.displayName||action.itemName||item.category||'business work';
      return {headline:item.executionStatus==='COMPLETED'?`Completed ${subject}`:`Review ${subject}`,
        detail:item.policyEvaluation?.reason||item.errorMessage||'The evidence and exact limits are recorded on this work item.'};};
    return res.page('autopilot/history',{title:"StockChief's work",nav:'autopilot',groups,operations:[],evaluations:[],describe});
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
  router.get('/autopilot/work/:id',requireAuth,asyncRoute(async(req,res)=>{const item=await autonomy.getWork(database,req.ctx.workspaceId,req.params.id),access=require('../../actions/permissions'),required=item.recommendedAction.type==='customer_order'?access.VIEW_SALES:item.recommendedAction.type==='supplier_invoice'?access.VIEW_ACCOUNTING:item.recommendedAction.type==='transfer'?access.VIEW_TRANSFERS:access.VIEW_PURCHASING;access.assertCan(req.user,required,'review this business workflow');let approvalBlock=null;const action=item.recommendedAction;
    // Say what is in the way before the person presses Approve, not after.
    if(item.execution_status==='WAITING_FOR_APPROVAL'&&action.type!=='transfer'&&action.supplierId){const ready=await autonomy.supplierDeliveryReadiness(database,req.ctx.workspaceId,action.supplierId);
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
