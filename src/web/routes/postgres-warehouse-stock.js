'use strict';
const express=require('express'),access=require('../../operations/postgres-warehouse-access'),permissions=require('../../actions/permissions');
const {asyncRoute,requireAuth,requirePermission}=require('../middleware'),{newId}=require('../../lib/util');
function createRouter(db){
 const router=express.Router();router.use(requireAuth);
 const tasks=require('../../operations/agent-count-tasks');
 router.get('/guide',asyncRoute(async(req,res)=>res.render('warehouse/guide',await require('../../assistant/staff-guide').read(db,req.ctx,req.query.q))));
 router.get('/warehouse/my-counts/:id',requirePermission(permissions.COUNT_STOCK,'perform stock counts'),asyncRoute(async(req,res)=>{
  res.render('warehouse/my-count',{...await tasks.page(db,req.ctx,req.params.id),restricted:await access.scope(db,req.ctx)!==null});
 }));
 router.post('/warehouse/my-counts/:id',requirePermission(permissions.COUNT_STOCK,'perform stock counts'),asyncRoute(async(req,res)=>{
  try{
   await tasks.record(db,req.ctx,req.params.id,req.body);
   return res.redirect(303,'/warehouse/my-counts/'+encodeURIComponent(req.params.id));
  }catch(error){
   if(error.code!=='validation_error'||!req.accepts('html'))throw error;
   return res.status(400).render('warehouse/my-count',{...await tasks.page(db,req.ctx,req.params.id),
    restricted:await access.scope(db,req.ctx)!==null,countError:error.message});
  }
 }));
 router.get('/warehouse/stock',asyncRoute(async(req,res)=>{
  await require('../../commercial/enforcement').workspace(db,req.ctx.workspaceId,'inventory.core');
  const roots=await access.scope(db,req.ctx),locations=await access.locations(db,req.ctx.workspaceId,roots);
  const locationId=String(req.query.locationId||locations[0]?.id||''),q=String(req.query.q||'').trim().slice(0,120),after=String(req.query.after||'').slice(0,160);
  if(locationId)await access.assertLocations(db,req.ctx,[locationId]);
  const rows=locationId?(await db.query(`SELECT s.id,s.code,s.variant_label,i.name,i.tracking_mode,i.secondary_unit_label,coalesce(b.on_hand,0)::text quantity
   FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id LEFT JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id AND b.location_id=$2
   WHERE s.workspace_id=$1 AND (b.sku_id IS NOT NULL OR $4<>'') AND s.id>$3 AND s.is_active=1 AND i.is_active=1
   AND ($4='' OR s.code ILIKE '%'||$4||'%' OR s.barcode=$4 OR i.name ILIKE '%'||$4||'%' OR s.variant_label ILIKE '%'||$4||'%') ORDER BY s.id LIMIT 101`,[req.ctx.workspaceId,locationId,after,q])).rows:[];
  res.locals.flash=req.session.flash||[];req.session.flash=[];
  res.locals.countTasks=permissions.can(req.user,permissions.COUNT_STOCK)?await tasks.inbox(db,req.ctx.workspaceId,req.ctx.actorId):[];
  const putawayPolicy=require('../../commercial/agent-plan'),putawayState=await putawayPolicy.accountState(db,req.ctx.workspaceId);
  const arrivals=require('../../transfers/agent-transfer-arrivals');
  res.locals.transferArrivals=roots!==null&&permissions.can(req.user,permissions.VIEW_TRANSFERS)&&permissions.can(req.user,permissions.RECEIVE_TRANSFER)
    ? await arrivals.inbox(db,req.ctx.workspaceId,{owner:false,locations:locations.map(l=>l.id)},putawayState) : [];
  res.locals.canCorrectBins=permissions.can(req.user,permissions.REQUEST_TRANSFER);
  res.locals.binCorrectionAllowed=putawayPolicy.usesAgentTerms(putawayState)&&putawayPolicy.permits(putawayState.plan,11,'draft');
  res.locals.staffRequestsAllowed=putawayPolicy.usesAgentTerms(putawayState)&&putawayPolicy.permits(putawayState.plan,41,'draft');
  res.locals.putawayInstructions=[];
  if(locationId&&putawayPolicy.usesAgentTerms(putawayState)&&putawayPolicy.permits(putawayState.plan,47,'draft')){
    const prepared=(await db.query(`SELECT p.id,p.source FROM stockchief_runtime.agent_putaway_instructions p
      WHERE p.workspace_id=$1 AND p.source#>>'{from,id}'=$2 AND p.status='READY' ORDER BY p.created_at DESC,p.id DESC LIMIT 20`,[req.ctx.workspaceId,locationId])).rows;
    const permitted=new Set(locations.map(l=>l.id));res.locals.putawayInstructions=prepared.filter(p=>permitted.has(p.source.to.id));
  }
  return res.render('warehouse/stock-access',{title:'Warehouse stock',locations,locationId,q,rows:rows.slice(0,100),next:rows.length>100?rows[99].id:null,operationKey:newId('warehouse-receipt'),canReceive:permissions.can(req.user,permissions.OPERATE),canCount:permissions.can(req.user,permissions.ADJUST),message:String(req.query.saved||'')==='1'?'Stock received with its purchase cost.':String(req.query.saved||'')==='count'?'Count saved for an owner to review.':null,restricted:roots!==null});
 }));
 router.get('/purchasing/requests',asyncRoute(async(req,res)=>{
  const notices=req.session.flash||[];req.session.flash=[];
  try{
   const model=await require('../../purchasing/agent-purchase-requests').page(db,req.ctx);
   return res.render('warehouse/purchase-requests',{...model,requestKey:newId('req'),notices,lockedMessage:null});
  }catch(error){
   if(error.code!=='entitlement_required')throw error;
   return res.render('warehouse/purchase-requests',{notices,lockedMessage:error.message});
  }
 }));
 router.post('/purchasing/requests',asyncRoute(async(req,res)=>{
  await require('../../purchasing/agent-purchase-requests').submit(db,req.ctx,req.body);
  return res.redirect(303,'/purchasing/requests');
 }));
 router.post('/warehouse/stock/receive',requirePermission(permissions.OPERATE,'receive stock'),asyncRoute(async(req,res)=>{
  await access.assertLocations(db,req.ctx,[req.body.locationId]);
  const serials=String(req.body.serials||'').split(/[\r\n,]+/).map(v=>v.trim()).filter(Boolean);
  await require('../../accounting/postgres-stock-receipt').receive(db,req.ctx,{skuId:req.body.skuId,locationId:req.body.locationId,quantity:serials.length||req.body.quantity,unitCost:req.body.unitCost,lotCode:req.body.lotCode,expiresAt:req.body.expiresAt||null,serials:serials.length?serials:undefined,idempotencyKey:req.body.operationKey});
  return res.redirect(303,'/warehouse/stock?saved=1&locationId='+encodeURIComponent(req.body.locationId));
 }));
 router.post('/warehouse/stock/count',requirePermission(permissions.ADJUST,'record counts'),asyncRoute(async(req,res)=>{
  await access.assertLocations(db,req.ctx,[req.body.locationId]);
  const review=await require('../../operations/postgres-count-reviews').prepare(db,req.ctx,{locationId:req.body.locationId,reference:req.body.reference,lines:[{skuId:req.body.skuId,quantity:req.body.quantity,unitCost:req.body.unitCost}]});
  return res.redirect(303,'/warehouse/stock?saved=count&locationId='+encodeURIComponent(req.body.locationId));
 }));return router;
}
function protection(db){const router=createRouter(db);return async(req,res,next)=>{
 try{
  const countPath=/^\/warehouse\/my-counts\/[A-Za-z0-9_-]+$/.test(req.path)&&['GET','POST'].includes(req.method);
  if(countPath||req.method==='GET'&&req.path==='/guide')return router(req,res,next);
  if(!req.ctx||await access.scope(db,req.ctx)===null)return req.path.startsWith('/warehouse/stock')?router(req,res,next):next();
  if(req.path==='/logout')return next();
  if(req.path==='/purchasing/requests'&&['GET','POST'].includes(req.method))return router(req,res,next);
  const transferDetail=/^\/transfers\/tr_[A-Za-z0-9_-]+$/;
  const transferReceipt=/^\/transfers\/tr_[A-Za-z0-9_-]+\/receive$/;
  const transferCheck=/^\/transfers\/arrival-follow-up\/tr_[A-Za-z0-9_-]+\/check$/;
  if(req.method==='GET'&&(req.path==='/transfers/arrival-follow-up'||transferDetail.test(req.path)) ||
     req.method==='POST'&&(transferReceipt.test(req.path)||transferCheck.test(req.path)))return next();
  if(['GET','POST'].includes(req.method)&&/^\/warehouse\/bin-corrections(?:\/[A-Za-z0-9_-]+(?:\/scan)?)?$/.test(req.path))return next();
  if(req.method==='GET'&&/^\/warehouse\/putaway\/[A-Za-z0-9_-]+$/.test(req.path)||req.method==='POST'&&/^\/warehouse\/putaway\/[A-Za-z0-9_-]+\/confirm$/.test(req.path))return next();
  if(req.path==='/warehouse/stock'||req.path==='/warehouse/stock/receive'||req.path==='/warehouse/stock/count')return router(req,res,next);
  if(req.method==='GET'&&!req.path.startsWith('/api/'))return res.redirect(302,'/warehouse/stock');
  return res.status(403).json({error:'warehouse_access_required',message:'Your access is limited to assigned warehouses. Use Warehouse stock or ask your inventory owner to update your access.'});
 }catch(error){next(error);}
};}
module.exports={createRouter,protection};
