'use strict';

const express=require('express');
const waves=require('../../operations/postgres-fulfillment-waves');
const permissions=require('../../actions/permissions');
const {requireAuth,requirePermission,asyncRoute}=require('../middleware');
const {newId}=require('../../lib/util');

function createPostgresWarehouseRouter(database){
  const router=express.Router();
  router.use('/warehouse',requireAuth);
  router.get('/warehouse/labels/sku/:id',asyncRoute(async(req,res)=>{
    const sku=await require('../../pricing/postgres-service').requireSku(database,req.ctx.workspaceId,req.params.id);
    const labels=require('../../warehouse/labels'),label={kind:'sku',id:sku.id,title:sku.display_name,
      subtitle:`SKU ${sku.code}`,barcode:sku.barcode||sku.code};
    return res.page('warehouse/label',{title:`Print ${label.title}`,nav:'warehouse',room:true,
      label,barcodeSvg:labels.code128Svg(label.barcode),verified:labels.verifyRoundTrip(label)});
  }));
  router.get('/warehouse/counts/new',requirePermission(permissions.VIEW,'see stock'),asyncRoute(async(req,res)=>{const q=String(req.query.q||'').trim().slice(0,120),rows=(await database.query("SELECT i.id,i.name,s.code FROM items i JOIN skus s ON s.workspace_id=i.workspace_id AND s.item_id=i.id WHERE i.workspace_id=$1 AND i.is_active=1 AND s.is_active=1 AND ($2='' OR i.name ILIKE '%'||$2||'%' OR s.code ILIKE '%'||$2||'%') ORDER BY lower(i.name),s.code LIMIT 50",[req.ctx.workspaceId,q])).rows;return res.page('warehouse/count-picker',{title:'Record a physical count',nav:'inventory',rows,q});}));
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
