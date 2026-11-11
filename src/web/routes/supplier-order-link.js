'use strict';
const express=require('express');
const link=require('../../purchasing/supplier-order-link');
const backup=require('../../purchasing/agent-backup-suppliers');
const amendments=require('../../purchasing/po-amendment-link');
const {asyncRoute,rateLimit}=require('../middleware');

function router(db){
  const router=express.Router();
  router.use('/supplier/order',rateLimit({windowMs:60000,max:60,maxBuckets:10000}),(req,res,next)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'});
    next();
  });
  router.get('/supplier/order/:token',asyncRoute(async(req,res)=>{
    const order=await link.lookup(db,req.params.token,false,{includeReceived:true});
    if(order.delivery_kind==='CUSTOMER_DIRECT')return res.redirect(303,'/supplier/order/'+req.params.token+'/direct-shipment'+(req.query.saved==='1'?'?saved=1':''));
    const lines=(await db.query(`SELECT l.quantity_units,s.code,i.name FROM purchase_order_lines l
      JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
      JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 ORDER BY l.line_number`,[order.workspace_id,order.id])).rows;
    const backupLines=await backup.linkLines(db,order);
    const canAmend=['ORDERED','PARTIALLY_RECEIVED'].includes(order.status)&&await amendments.canAccept(db,order.workspace_id);
    return res.render('public/supplier-order-link',{order,lines,backupLines,canAmend,received:req.query.saved==='1'});
  }));
  router.get('/supplier/order/:token/amendment',asyncRoute(async(req,res)=>{
    const proposal=await amendments.page(db,req.params.token);
    res.render('public/supplier-po-amendment',{...proposal,supplierOrderUrl:'/supplier/order/'+req.params.token});
  }));
  router.post('/supplier/order/:token/amendment',asyncRoute(async(req,res)=>{
    await amendments.submit(db,req.params.token,req.body);
    res.redirect(303,'/supplier/order/'+req.params.token+'?saved=1');
  }));
  router.get('/supplier/order/:token/direct-shipment',asyncRoute(async(req,res)=>{
    const direct=await require('../../purchasing/agent-direct-shipments').supplierPage(db,req.params.token);
    if(!direct)throw new (require('../../domain/errors').NotFoundError)();
    return res.render('public/supplier-direct-dispatch',{...direct,token:req.params.token,received:req.query.saved==='1'});
  }));
  router.post('/supplier/order/:token/direct-shipment',asyncRoute(async(req,res)=>{
    await require('../../purchasing/agent-direct-shipments').supplierSubmit(db,req.params.token,req.body);
    res.redirect(303,'/supplier/order/'+req.params.token+'/direct-shipment?saved=1');
  }));
  router.post('/supplier/order/:token/respond',asyncRoute(async(req,res)=>{
    await link.submit(db,req.params.token,req.body.kind,req.body.date,{shipDate:req.body.shipDate||null});
    res.redirect(303,'/supplier/order/'+req.params.token+'?saved=1');
  }));
  router.post('/supplier/order/:token/unavailable',asyncRoute(async(req,res)=>{
    await backup.supplierReply(db,req.params.token,req.body);
    res.redirect(303,'/supplier/order/'+req.params.token+'?saved=1');
  }));
  router.post('/supplier/order/:token/file/:kind',express.raw({type:'application/pdf',limit:'4mb'}),asyncRoute(async(req,res)=>{
    await link.submit(db,req.params.token,req.params.kind,req.body);
    res.json({saved:true});
  }));
  return router;
}
module.exports={router};
