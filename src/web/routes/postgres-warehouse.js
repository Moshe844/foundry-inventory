'use strict';

const express=require('express');
const waves=require('../../operations/postgres-fulfillment-waves');
const permissions=require('../../actions/permissions');
const {requireAuth,requireOwner,requirePermission,asyncRoute}=require('../middleware');
const {newId}=require('../../lib/util');

function createPostgresWarehouseRouter(database){
  const router=express.Router();
  router.use('/warehouse',requireAuth);
  const corrections=require('../../warehouse/agent-bin-corrections');
  router.get('/warehouse/bin-corrections',requirePermission(permissions.REQUEST_TRANSFER,'correct stock bins'),asyncRoute(async(req,res)=>{
    res.page('warehouse/bin-correction',{title:'Correct a stock bin',nav:'warehouse',...await corrections.page(database,req.ctx,null,req.query)});
  }));
  router.post('/warehouse/bin-corrections',requirePermission(permissions.REQUEST_TRANSFER,'correct stock bins'),asyncRoute(async(req,res)=>{
    const made=await corrections.open(database,req.ctx,req.body);res.redirect(303,'/warehouse/bin-corrections/'+made.id);
  }));
  router.post('/warehouse/bin-corrections/settings',requireOwner,asyncRoute(async(req,res)=>{
    await corrections.configure(database,req.ctx,req.body);res.redirect(303,'/warehouse/bin-corrections');
  }));
  router.get('/warehouse/bin-corrections/:id',requirePermission(permissions.REQUEST_TRANSFER,'review stock bin corrections'),asyncRoute(async(req,res)=>{
    res.page('warehouse/bin-correction',{title:'Review a stock bin correction',nav:'warehouse',...await corrections.page(database,req.ctx,req.params.id)});
  }));
  router.post('/warehouse/bin-corrections/:id/scan',requirePermission(permissions.OPERATE,'confirm a physical bin correction'),asyncRoute(async(req,res)=>{
    await corrections.scan(database,req.ctx,req.params.id,req.body);res.redirect(303,'/warehouse/bin-corrections/'+req.params.id);
  }));
  router.post('/warehouse/bin-corrections/:id/approve',requireOwner,asyncRoute(async(req,res)=>{
    await corrections.approve(database,req.ctx,req.params.id,req.body);res.redirect(303,'/warehouse/bin-corrections/'+req.params.id);
  }));
  router.post('/warehouse/bin-corrections/:id/cancel',requireOwner,asyncRoute(async(req,res)=>{
    await corrections.cancel(database,req.ctx,req.params.id,req.body);res.redirect(303,'/warehouse/bin-corrections/'+req.params.id);
  }));
  router.post('/warehouse/bin-corrections/:id/rule',requireOwner,asyncRoute(async(req,res)=>{
    await corrections.teach(database,req.ctx,req.params.id,req.body);res.redirect(303,'/warehouse/bin-corrections/'+req.params.id);
  }));
  router.get('/warehouse/batches',requirePermission(permissions.VIEW,'review batch stock'),asyncRoute(async(req,res)=>{const pagination=require('../presentation/pagination'),size=pagination.pageSize(req),found=await require('../../domain/postgres-batch-expiry').page(database,req.ctx.workspaceId,{...req.query,pageSize:size});return res.page('warehouse/batch-expiry',{title:'Batch expiry',nav:'inventory',...found,pager:pagination.pager(req,{page:found.page,size,total:found.total,shown:found.rows.length}),locations:await require('../../operations/postgres-commerce').locations(database,req.ctx.workspaceId)});}));
  router.get('/warehouse/putaway/:id',requirePermission(permissions.VIEW,'read put-away labels'),asyncRoute(async(req,res)=>{
    const instruction=await require('../../warehouse/agent-putaway').instruction(database,req.ctx,req.params.id),barcode=require('../../warehouse/labels');
    const labels=[{title:'Product',subtitle:instruction.source.product,barcode:instruction.source.barcode},
      {title:'Receiving location',subtitle:instruction.source.from.name,barcode:instruction.source.from.barcode},
      {title:'Destination bin',subtitle:instruction.source.to.name,barcode:instruction.source.to.barcode}].map(l=>({...l,svg:barcode.code128Svg(l.barcode)}));
    const state=await require('../../commercial/agent-plan').accountState(database,req.ctx.workspaceId);
    res.page('warehouse/putaway',{title:'Put-away instructions',nav:'warehouse',instruction,labels,canTeach:req.user.role==='owner'&&!instruction.automatic&&!state.shadow,
      putawayBack:req.user.role==='owner'?'/autopilot/reviews/putaway-labels':'/warehouse/stock'});
  }));
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
    const ruleSettings=await require('../../autopilot/count-rules').settings(database,req.ctx);
    const countRule=req.user.role==='owner'?ruleSettings:{enabled:false,automaticSubmission:ruleSettings.enabled&&ruleSettings.rule?.automatic};
    return res.page('warehouse/count-picker',{title:'Record a physical count',nav:'inventory',countRule,submissionKey:newId('count'),countWorksheets,pendingCounts,rows:rows.slice(0,50),hasMore:rows.length>50,q,category,locationId,locations:await require('../../domain/postgres-location-service').listHierarchy(database,req.ctx.workspaceId,{includeStock:false})});
  }));
  router.post('/warehouse/counts/rule',require('../middleware').requireOwner,asyncRoute(async(req,res)=>{
    await require('../../autopilot/count-rules').configure(database,req.ctx,req.body);
    res.redirect(303,'/warehouse/counts/new');
  }));
  router.post('/warehouse/counts/reviews/:id/recount',requirePermission(permissions.ADJUST,'record counts'),asyncRoute(async(req,res)=>{
    await require('../../operations/postgres-count-reviews').recount(database,req.ctx,req.params.id,req.body.quantities);
    res.redirect(303,'/warehouse/counts/reviews/'+req.params.id);
  }));
  const campaigns=require('../../operations/postgres-count-campaigns');
  const tasks=require('../../operations/agent-count-tasks');
  router.post('/warehouse/count-assignments',require('../middleware').requireOwner,asyncRoute(async(req,res)=>{
    await tasks.assign(database,req.ctx,req.body);res.redirect(303,'/autopilot/reviews/staff-count-progress');
  }));
  router.post('/warehouse/count-schedules',require('../middleware').requireOwner,asyncRoute(async(req,res)=>{
    await tasks.schedule(database,req.ctx,req.body);res.redirect(303,'/autopilot/reviews/staff-count-lists');
  }));
  router.post('/warehouse/counts/campaigns/:id/staff-quantities',require('../middleware').requireOwner,asyncRoute(async(req,res)=>{
    await tasks.importObserved(database,req.ctx,req.params.id,req.body.revision);res.redirect(303,'/warehouse/counts/campaigns/'+encodeURIComponent(req.params.id));
  }));
  router.post('/warehouse/counts/campaigns',requirePermission(permissions.ADJUST,'record counts'),asyncRoute(async(req,res)=>{const created=await campaigns.create(database,req.ctx,req.body);return res.redirect(303,'/warehouse/counts/campaigns/'+created.id);}));
  router.get('/warehouse/counts/campaigns/:id',requirePermission(permissions.ADJUST,'record counts'),asyncRoute(async(req,res)=>{
    const data=await campaigns.page(database,req.ctx,req.params.id,req.query);
    let observed=false;
    if(req.user.role==='owner'&&data.campaign.status==='DRAFT'&&(await database.query('SELECT 1 FROM stockchief_runtime.agent_count_tasks WHERE workspace_id=$1 AND campaign_id=$2 AND observed_at IS NOT NULL',[req.ctx.workspaceId,req.params.id])).rowCount){
      const policy=require('../../commercial/agent-plan'),state=await policy.accountState(database,req.ctx.workspaceId);
      observed=policy.usesAgentTerms(state)&&policy.permits(state.plan,177,'draft');
    }
    res.page('warehouse/count-campaign',{title:'Warehouse count worksheet',nav:'inventory',...data,observed});
  }));
  router.post('/warehouse/counts/campaigns/:id/save',requirePermission(permissions.ADJUST,'record counts'),asyncRoute(async(req,res)=>{const result=await campaigns.save(database,req.ctx,req.params.id,req.body);if(req.is('application/json'))return res.json(result);return res.redirect(303,'/warehouse/counts/campaigns/'+req.params.id);}));
  router.get('/warehouse/counts/campaigns/:id/export',requirePermission(permissions.ADJUST,'record counts'),asyncRoute(async(req,res)=>{
   await campaigns.page(database,req.ctx,req.params.id);res.type('text/csv').attachment('stock-count-worksheet.csv');const csv=value=>{let text=String(value??'');if(/^[\s\u0000-\u001f]*[=+\-@]/u.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
   res.write(String.fromCharCode(0xfeff)+'SKU,Location,Recorded quantity,Counted quantity,Unit cost,Stock position reference\r\n');let afterLocation='',afterSku='';
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
