'use strict';

const express=require('express');
const waves=require('../../operations/postgres-fulfillment-waves');
const permissions=require('../../actions/permissions');
const {requireAuth,requirePermission,asyncRoute}=require('../middleware');
const {newId}=require('../../lib/util');

function createPostgresWarehouseRouter(database){
  const router=express.Router();
  router.use('/warehouse',requireAuth);
  router.get('/warehouse/batches',requirePermission(permissions.VIEW,'review batch stock'),asyncRoute(async(req,res)=>{const pagination=require('../presentation/pagination'),size=pagination.pageSize(req),found=await require('../../domain/postgres-batch-expiry').page(database,req.ctx.workspaceId,{...req.query,pageSize:size});return res.page('warehouse/batch-expiry',{title:'Batch expiry',nav:'inventory',...found,pager:pagination.pager(req,{page:found.page,size,total:found.total,shown:found.rows.length}),locations:await require('../../operations/postgres-commerce').locations(database,req.ctx.workspaceId)});}));
  router.get('/warehouse/labels/sku/:id',asyncRoute(async(req,res)=>{
    const sku=await require('../../pricing/postgres-service').requireSku(database,req.ctx.workspaceId,req.params.id);
    const labels=require('../../warehouse/labels'),label={kind:'sku',id:sku.id,title:sku.display_name,
      subtitle:`SKU ${sku.code}`,barcode:sku.barcode||sku.code};
    return res.page('warehouse/label',{title:`Print ${label.title}`,nav:'warehouse',room:true,
      label,barcodeSvg:labels.code128Svg(label.barcode),verified:labels.verifyRoundTrip(label)});
  }));
  router.get('/warehouse/counts/new',requirePermission(permissions.VIEW,'see stock'),asyncRoute(async(req,res)=>{
    const q=String(req.query.q||'').trim().slice(0,120),category=String(req.query.category||'').trim().slice(0,120),locationId=String(req.query.locationId||'').slice(0,160);
    const rows=(await database.query(`SELECT i.id,i.name,i.tracking_mode,i.secondary_unit_label,i.quantity_increment,s.id AS sku_id,s.code,s.variant_label,coalesce(b.on_hand,0) AS on_hand FROM items i JOIN skus s ON s.workspace_id=i.workspace_id AND s.item_id=i.id LEFT JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id AND b.location_id=$4 WHERE i.workspace_id=$1 AND i.is_active=1 AND s.is_active=1 AND ($2='' OR i.name ILIKE '%'||$2||'%' OR s.code ILIKE '%'||$2||'%' OR s.variant_label ILIKE '%'||$2||'%') AND ($3='' OR EXISTS(SELECT 1 FROM catalogue_item_facts f WHERE f.workspace_id=i.workspace_id AND f.item_id=i.id AND f.category ILIKE '%'||$3||'%')) ORDER BY lower(i.name),s.code LIMIT 51`,[req.ctx.workspaceId,q,category,locationId])).rows;
    const countWorksheets=(await database.query('SELECT id,title,status FROM warehouse_count_campaigns WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 30',[req.ctx.workspaceId])).rows,pendingCounts=req.user.role==='owner'?(await database.query("SELECT id,payload->'location'->>'name' location_name FROM physical_count_reviews WHERE workspace_id=$1 AND status='PENDING' ORDER BY created_at DESC LIMIT 30",[req.ctx.workspaceId])).rows:[];
    return res.page('warehouse/count-picker',{title:'Record a physical count',nav:'inventory',countWorksheets,pendingCounts,rows:rows.slice(0,50),hasMore:rows.length>50,q,category,locationId,locations:await require('../../domain/postgres-location-service').listHierarchy(database,req.ctx.workspaceId,{includeStock:false})});
  }));
  const campaigns=require('../../operations/postgres-count-campaigns');
  router.post('/warehouse/counts/campaigns',requirePermission(permissions.ADJUST,'record counts'),asyncRoute(async(req,res)=>{const created=await campaigns.create(database,req.ctx,req.body);return res.redirect(303,'/warehouse/counts/campaigns/'+created.id);}));
  router.get('/warehouse/counts/campaigns/:id',requirePermission(permissions.ADJUST,'record counts'),asyncRoute(async(req,res)=>res.page('warehouse/count-campaign',{title:'Warehouse count worksheet',nav:'inventory',...await campaigns.page(database,req.ctx,req.params.id,req.query)})));
  router.post('/warehouse/counts/campaigns/:id/save',requirePermission(permissions.ADJUST,'record counts'),asyncRoute(async(req,res)=>{const result=await campaigns.save(database,req.ctx,req.params.id,req.body);if(req.is('application/json'))return res.json(result);return res.redirect(303,'/warehouse/counts/campaigns/'+req.params.id);}));
  router.get('/warehouse/counts/campaigns/:id/export',requirePermission(permissions.ADJUST,'record counts'),asyncRoute(async(req,res)=>{
   await campaigns.page(database,req.ctx,req.params.id);res.type('text/csv').attachment('stock-count-worksheet.csv');const csv=value=>{let text=String(value??'');if(/^[\s\u0000-\u001f]*[=+\-@]/u.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
   res.write('SKU,Location,Recorded quantity,Counted quantity,Unit cost,Stock position reference\r\n');let afterLocation='',afterSku='';
   while(!res.destroyed){const page=await campaigns.page(database,req.ctx,req.params.id,{afterLocation,afterSku,limit:1000,includeTotals:false});for(const l of page.rows){if(!res.write([l.code,l.location_name,l.before_quantity,l.counted_quantity,l.unit_cost_minor==null?'':require('../../domain/currency').fromMinor(Number(l.unit_cost_minor),page.currency),l.location_id+':'+l.sku_id].map(csv).join(',')+'\r\n'))await new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});}if(!page.next)break;afterLocation=page.next.location_id;afterSku=page.next.sku_id;}res.end();
  }));
  router.post('/warehouse/counts/campaigns/:id/approve',requirePermission(permissions.ADJUST,'approve counts'),asyncRoute(async(req,res)=>{await campaigns.approve(database,req.ctx,req.params.id,req.body.revision);return res.redirect(303,'/warehouse/counts/campaigns/'+req.params.id);}));
  router.post('/warehouse/counts/reviews',requirePermission(permissions.ADJUST,'record counts'),asyncRoute(async(req,res)=>{const review=await require('../../operations/postgres-count-reviews').prepare(database,req.ctx,req.body);return res.redirect(303,'/warehouse/counts/reviews/'+review.id);}));
  router.get('/warehouse/counts/reviews/:id',requirePermission(permissions.ADJUST,'review counts'),asyncRoute(async(req,res)=>res.page('warehouse/count-review',{title:'Review physical count',nav:'inventory',review:await require('../../operations/postgres-count-reviews').get(database,req.ctx,req.params.id)})));
  router.post('/warehouse/counts/reviews/:id/approve',requirePermission(permissions.ADJUST,'approve counts'),asyncRoute(async(req,res)=>{await require('../../operations/postgres-count-reviews').approve(database,req.ctx,req.params.id,req.body.integrityHash);req.flash('success','All reviewed count variances are complete.');return res.redirect(303,'/warehouse/counts/reviews/'+req.params.id);}));
  router.get('/warehouse',(req,res)=>res.redirect(302,'/warehouse/operations'));
  router.get('/warehouse/operations',asyncRoute(async(req,res)=>res.page('warehouse/postgres-operations',{
    title:'Warehouse operations',nav:'warehouse',room:true,
    waves:await waves.list(database,req.ctx.workspaceId,{afterId:req.query.afterWaveId}),
    readyOrders:await waves.readyOrders(database,req.ctx.workspaceId,{afterId:req.query.afterOrderId}),
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
    wave:await waves.get(database,req.ctx.workspaceId,req.params.id,{afterLineId:req.query.afterLineId,afterShipmentId:req.query.afterShipmentId}),
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
