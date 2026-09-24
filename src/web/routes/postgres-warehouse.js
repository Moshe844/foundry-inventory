'use strict';

const express=require('express');
const waves=require('../../operations/postgres-fulfillment-waves');
const permissions=require('../../actions/permissions');
const {requireAuth,requirePermission,asyncRoute}=require('../middleware');
const {newId}=require('../../lib/util');

function createPostgresWarehouseRouter(database){
  const router=express.Router();
  router.use('/warehouse',requireAuth);
  router.get('/warehouse',(req,res)=>res.redirect(302,'/warehouse/operations'));
  router.get('/warehouse/operations',asyncRoute(async(req,res)=>res.page('warehouse/postgres-operations',{
    title:'Warehouse operations',nav:'warehouse',room:true,
    waves:await waves.list(database,req.ctx.workspaceId),
    readyOrders:await waves.readyOrders(database,req.ctx.workspaceId),
    releaseKey:newId('wave-form'),
  })));
  router.post('/warehouse/waves',requirePermission(permissions.MANAGE_FULFILLMENT_WAVES,'create fulfillment waves'),
    asyncRoute(async(req,res)=>{
      const created=await waves.create(database,req.ctx,{strategy:req.body.strategy,title:req.body.title,
        orderIds:Array.isArray(req.body.orderIds)?req.body.orderIds:[req.body.orderIds].filter(Boolean),
        idempotencyKey:req.body.idempotencyKey});
      req.flash('success',created.replayed?'That wave was already released.':'Wave released. Stock remains committed and on hand until physical handoff.');
      return res.redirect(303,`/warehouse/waves/${created.waveId}`);
    }));
  router.get('/warehouse/waves/:id',asyncRoute(async(req,res)=>res.page('warehouse/wave',{
    title:'Fulfillment wave',nav:'warehouse',room:true,
    wave:await waves.get(database,req.ctx.workspaceId,req.params.id),
    containers:await waves.containers(database,req.ctx.workspaceId),
  })));
  router.post('/warehouse/waves/:id/scans',
    requirePermission(permissions.MANAGE_FULFILLMENT_WAVES,'scan fulfillment waves'),asyncRoute(async(req,res)=>{
      const result=await waves.scan(database,req.ctx,req.params.id,req.body);
      req.flash(result.status==='ACCEPTED'?'success':'error',result.duplicate?`Already received that scan: ${result.message}`:result.message);
      return res.redirect(303,`/warehouse/waves/${req.params.id}`);
    }));
  router.post('/warehouse/waves/:id/shortage',
    requirePermission(permissions.MANAGE_FULFILLMENT_WAVES,'record wave shortages'),asyncRoute(async(req,res)=>{
      await waves.reportShortage(database,req.ctx,req.params.id,req.body.lineId,req.body.foundQuantity,req.body.note);
      req.flash('error','The wave is blocked. Recount or replenish before continuing.');
      return res.redirect(303,`/warehouse/waves/${req.params.id}`);
    }));
  router.post('/warehouse/waves/:id/pack',
    requirePermission(permissions.MANAGE_FULFILLMENT_WAVES,'pack fulfillment waves'),asyncRoute(async(req,res)=>{
      await waves.packShipment(database,req.ctx,req.params.id,req.body.shipmentId,req.body);
      req.flash('success','Carton packed. No stock moved; record physical handoff from the shipment when it actually leaves.');
      return res.redirect(303,`/warehouse/waves/${req.params.id}`);
    }));
  router.post('/warehouse/waves/:id/refresh',
    requirePermission(permissions.MANAGE_FULFILLMENT_WAVES,'complete fulfillment waves'),asyncRoute(async(req,res)=>{
      const result=await waves.refresh(database,req.ctx,req.params.id);
      req.flash('success',result.completed?'Every carton has shipped or been cancelled. The wave is complete.':'The wave still has cartons waiting for physical handoff.');
      return res.redirect(303,`/warehouse/waves/${req.params.id}`);
    }));
  return router;
}

module.exports={createPostgresWarehouseRouter};
