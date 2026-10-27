'use strict';

const express = require('express');
const catalog = require('../../domain/postgres-catalog-service');
const inventory = require('../../domain/postgres-inventory-engine');
const transfers = require('../../transfers/postgres-transfer-service');
const locations = require('../../domain/postgres-location-service');
const onboarding = require('../../onboarding/postgres-paths');
const pricing = require('../../pricing/postgres-service');
const presenters = require('../postgres-presenters');
const { ValidationError } = require('../../domain/errors');
const permissions = require('../../actions/permissions');
const { requireAuth, requireOwner, requirePermission, asyncRoute } = require('../middleware');
const { newId, trimOrNull } = require('../../lib/util');

function normaliseOptionInput(raw) {
  if(!raw)return [];
  const rows=Array.isArray(raw)?raw:Object.keys(raw).sort().map((key)=>raw[key]);
  return rows.filter(Boolean).map((row)=>({name:row.name,values:row.values}));
}

function operationKey(req,kind) {
  return trimOrNull(req.body.idempotencyKey) || `${kind}:${newId('form')}`;
}

function values(raw){return raw===undefined?[]:(Array.isArray(raw)?raw:[raw]).map(String).filter(Boolean);}

async function serialSelection(database,workspaceId,ids){
  if(!ids.length)return null;
  const rows=(await database.query(`SELECT id,sku_id,location_id FROM serial_units
    WHERE workspace_id=$1 AND status='in_stock' AND id=ANY($2::text[])`,[workspaceId,ids])).rows;
  if(rows.length!==ids.length)throw new ValidationError('One or more selected serial units are no longer available.');
  const skuIds=new Set(rows.map((row)=>row.sku_id));const locationIds=new Set(rows.map((row)=>row.location_id));
  if(skuIds.size!==1 || locationIds.size!==1)throw new ValidationError('Choose serial units for one product and one location at a time.');
  return {skuId:rows[0].sku_id,locationId:rows[0].location_id};
}

function createPostgresInventoryRouter(database) {
  const router=express.Router();
  router.use('/inventory',requireAuth);
  const renderList=async(req,res)=>{
    const activeGroup=presenters.STOCK_GROUPS.find((group)=>group.key===req.query.group)||null;
    const filters={q:String(req.query.q || ''),trackingMode:req.query.tracking || '',locationId:req.query.location || '',
      sort:req.query.sort || 'name',includeArchived:req.query.archived==='1' || req.query.archived==='only',
      archivedOnly:req.query.archived==='only',group:activeGroup?.key||''};
    const result=await catalog.listItems(database,req.ctx.workspaceId,{...filters,page:req.query.page});
    if(result.items.length){const missing=(await database.query(`SELECT s.item_id,SUM(GREATEST(0,b.on_hand-COALESCE(c.quantity_units,0))) AS missing_units
      FROM skus s JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id
      LEFT JOIN accounting_inventory_cost_balances c ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id
      WHERE s.workspace_id=$1 AND s.item_id=ANY($2::text[]) AND b.on_hand>0 GROUP BY s.item_id`,[req.ctx.workspaceId,result.items.map(i=>i.id)])).rows;
      const lowSource=require('../../reports/postgres-registry').get('low_stock').source;
      const low=(await database.query(`SELECT DISTINCT record_id FROM (${lowSource}) source WHERE record_id=ANY($2::text[])`,[req.ctx.workspaceId,result.items.map(i=>i.id)])).rows;
      const lowIds=new Set(low.map(r=>r.record_id));
      result.items=result.items.map(item=>({...item,atOrBelowReorderPoint:lowIds.has(item.id),missingStockCostUnits:Number(missing.find(r=>r.item_id===item.id)?.missing_units||0)}));}
    // Rendering must work with a read-only business connection. Authorized
    // onboarding choices initialize state; browsing never creates it.
    const state=await onboarding.get(database,req.ctx.workspaceId);
    return res.page('inventory/list',{title:'Inventory',nav:'inventory',items:result.items,page:result.page,
      hasMore:result.hasMore,filters,locations:await locations.listHierarchy(database,req.ctx.workspaceId),
      returnTo:null,returnLabel:null,fromConnection:null,fromMessage:null,sourceDocument:null,sourceLabel:null,
      stockGroups:presenters.STOCK_GROUPS,activeGroup,query:{...req.query},postgresNative:true,
      layoutOnboardingEntry:{...res.locals.globalOnboardingEntry,state}});
  };
  router.get('/inventory',asyncRoute(renderList));
  router.get('/inventory/overview',asyncRoute(async(req,res)=>res.page('inventory/position',{title:'Stock overview',nav:'inventory',room:true,postgresNative:true,
    ...(await presenters.inventoryPosition(database,req.ctx.workspaceId))})));
  router.get('/inventory/table',asyncRoute(renderList));
  router.post('/inventory/bulk',requireOwner,asyncRoute(async(req,res)=>{
    const bulk=require('../../domain/postgres-catalog-bulk'),items=await bulk.selected(database,req.ctx,values(req.body.itemIds));
    if(req.body.kind==='export'){
      return require('../../operations/postgres-export-stream').download(database,req.ctx.workspaceId,res,{itemIds:items.map(i=>i.id)});
    }
    if(req.body.kind==='price')return res.page('inventory/bulk-price',{title:'Change selected selling prices',nav:'inventory',items});
    if(req.body.kind==='move')return res.redirect(303,'/transfers/new?'+new URLSearchParams(items.map(i=>['itemIds',i.id])));
    const review=await bulk.prepare(database,req.ctx,{itemIds:items.map(i=>i.id),kind:req.body.kind});return res.redirect(303,'/inventory/bulk/reviews/'+review.id);
  }));
  router.post('/inventory/bulk/prices',requireOwner,asyncRoute(async(req,res)=>{
    const review=await require('../../domain/postgres-catalog-bulk').prepare(database,req.ctx,{itemIds:values(req.body.itemIds),kind:'price',amount:req.body.amount,currency:req.body.currency});return res.redirect(303,'/inventory/bulk/reviews/'+review.id);
  }));
  router.get('/inventory/bulk/reviews/:reviewId',requireOwner,asyncRoute(async(req,res)=>res.page('inventory/bulk-review',{title:'Review selected product changes',nav:'inventory',review:await require('../../domain/postgres-catalog-bulk').get(database,req.ctx,req.params.reviewId)})));
  router.post('/inventory/bulk/reviews/:reviewId/approve',requireOwner,asyncRoute(async(req,res)=>{
    await require('../../domain/postgres-catalog-bulk').approve(database,req.ctx,req.params.reviewId,req.body.integrityHash);req.flash('success','The reviewed product changes are complete.');return res.redirect(303,'/inventory/bulk/reviews/'+req.params.reviewId);
  }));
  router.post('/inventory/bulk/reviews/:reviewId/cancel',requireOwner,asyncRoute(async(req,res)=>{
    await require('../../domain/postgres-catalog-bulk').cancel(database,req.ctx,req.params.reviewId);req.flash('success','The bulk changes were cancelled.');return res.redirect(303,'/inventory/table');
  }));
  router.get('/inventory/new',asyncRoute(async(req,res)=>res.page('inventory/new',{title:'Add an item',nav:'inventory',
    form:req.query.name?{name:String(req.query.name).slice(0,240)}:{},resumeInstructionId:null,
    fromConfiguration:false,currency:(await database.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[req.ctx.workspaceId])).rows[0]?.base_currency||'USD'})));
  router.get('/inventory/:id/duplicate',requireOwner,asyncRoute(async(req,res)=>res.page('inventory/duplicate',{title:'Duplicate product',nav:'inventory',idempotencyKey:newId('copy'),source:await require('../../domain/postgres-catalog-copy').describe(database,req.ctx,req.params.id)})));
  router.post('/inventory/:id/duplicate',requireOwner,asyncRoute(async(req,res)=>{
    const created=await require('../../domain/postgres-catalog-copy').copy(database,req.ctx,req.params.id,req.body);req.flash('success','Product duplicated with zero stock. No inventory value or history was copied.');return res.redirect(303,'/inventory/'+created.itemId);
  }));
  router.post('/inventory',asyncRoute(async(req,res)=>{
    const hasVariants=req.body.hasVariants==='1' || req.body.hasVariants==='on';
    try {
      const created=await catalog.createItem(database,req.ctx,{name:req.body.name,baseCode:req.body.baseCode,
        description:req.body.description,unitLabel:req.body.unitLabel,trackingMode:req.body.trackingMode,
        hasVariants,options:hasVariants?normaliseOptionInput(req.body.options):[],sellingPrice:req.body.sellingPrice,purchaseCost:req.body.purchaseCost,weightGrams:req.body.weightGrams,lengthMm:req.body.lengthMm,widthMm:req.body.widthMm,heightMm:req.body.heightMm,currency:(await database.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[req.ctx.workspaceId])).rows[0]?.base_currency||'USD'});
      req.flash('success','Item created. Receive some stock to get started.');
      return res.redirect(303,`/inventory/${created.itemId}`);
    } catch(error) {
      if(!(error instanceof ValidationError))throw error;
      return res.status(400).page('inventory/new',{title:'Add an item',nav:'inventory',form:req.body,
        resumeInstructionId:null,fromConfiguration:false,error:error.message,currency:(await database.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[req.ctx.workspaceId])).rows[0]?.base_currency||'USD'});
    }
  }));
  router.get('/inventory/:id',asyncRoute(async(req,res)=>{
    const detail=await catalog.getItem(database,req.ctx.workspaceId,req.params.id,{page:req.query.page});
    const importedDetails=await require('../../domain/postgres-catalog-facts').listForSkus(database,req.ctx.workspaceId,detail.skus.map(s=>s.id));
    const priceState=await pricing.listForSkus(database,req.ctx.workspaceId,detail.skus.map((sku)=>sku.id));
    detail.skus=detail.skus.map((sku)=>({...sku,...priceState.get(sku.id)}));
    const costRows=detail.skus.length?(await database.query(`SELECT b.sku_id,b.on_hand,COALESCE(c.quantity_units,0) AS costed_units,COALESCE(c.total_cost_minor,0) AS total_cost_minor,
      COALESCE((SELECT base_currency FROM accounting_settings a WHERE a.workspace_id=b.workspace_id),'USD') AS currency
      FROM balances b LEFT JOIN accounting_inventory_cost_balances c ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id
      WHERE b.workspace_id=$1 AND b.sku_id=ANY($2::text[]) AND b.on_hand>0`,[req.ctx.workspaceId,detail.skus.map(s=>s.id)])).rows:[];
    detail.skus=detail.skus.map(sku=>{const rows=costRows.filter(r=>r.sku_id===sku.id);return {...sku,stockCost:{
      costedUnits:rows.reduce((n,r)=>n+Number(r.costed_units),0),missingUnits:rows.reduce((n,r)=>n+Math.max(0,Number(r.on_hand)-Number(r.costed_units)),0),
      totalCostMinor:rows.reduce((n,r)=>n+Number(r.total_cost_minor),0),currency:rows[0]?.currency||'USD'}};});
    const purchasingRows=detail.skus.length?(await database.query(`SELECT sku.id AS sku_id,policy.location_id,
      location.name AS location_name,policy.reorder_point,policy.target_stock,policy.safety_stock,
      policy.preferred_supplier_id,supplier.name AS supplier_name
      FROM skus sku LEFT JOIN reorder_policies policy ON policy.workspace_id=sku.workspace_id AND policy.sku_id=sku.id
      LEFT JOIN locations location ON location.id=policy.location_id AND location.workspace_id=policy.workspace_id
      LEFT JOIN suppliers supplier ON supplier.id=policy.preferred_supplier_id
      WHERE sku.workspace_id=$1 AND sku.id=ANY($2::text[])`,[req.ctx.workspaceId,detail.skus.map((sku)=>sku.id)])).rows:[];
    const supplierRows=detail.skus.length?(await database.query(`SELECT si.sku_id,s.name AS supplier_name
      FROM supplier_items si JOIN suppliers s ON s.id=si.supplier_id AND s.workspace_id=si.workspace_id
      WHERE si.workspace_id=$1 AND si.sku_id=ANY($2::text[]) AND si.is_active=1 AND s.status='active'
      ORDER BY si.is_preferred DESC,s.name`,[req.ctx.workspaceId,detail.skus.map((sku)=>sku.id)])).rows:[];
    const purchasingLines=detail.skus.map((sku)=>{const policies=purchasingRows.filter((row)=>
      row.sku_id===sku.id&&row.reorder_point!==null).map((row)=>({isSet:true,
      locationName:row.location_name||'All locations',reorderPoint:Number(row.reorder_point),
      targetStock:row.target_stock==null?null:Number(row.target_stock),
      safetyStock:row.safety_stock==null?null:Number(row.safety_stock),
      preferredSupplierId:row.preferred_supplier_id,supplierName:row.supplier_name}));
      return {skuId:sku.id,label:sku.variant_label||detail.item.name,total:sku.total,
        policy:policies[0]||null,policies,suppliers:supplierRows.filter((row)=>row.sku_id===sku.id)
          .map((row)=>({supplierName:row.supplier_name}))};});
    return res.page('inventory/item',{title:detail.item.name,nav:'inventory',room:true,...detail,attention:[],findingTotal:0,
      purchasingLines,commitments:[],outlook:[],canOperate:permissions.can(req.user,permissions.OPERATE),
      canEstablishCost:['owner','accountant'].includes(req.user.role)&&permissions.can(req.user,permissions.MANAGE_ACCOUNTING),
      importedDetails,detailsVersion:require('../../domain/catalog-identity').detailsVersion(detail.item),
      stockOpKeys:Object.fromEntries(['receive','issue','transfer','adjust'].map(kind=>[kind,newId('stockform')])),
      kitDefinitions:Object.fromEntries(detail.skus.map((sku)=>[sku.id,{isKit:false,components:[]}]))});
  }));
  router.post('/inventory/:id/details',requirePermission(permissions.OPERATE,'edit products'),asyncRoute(async(req,res)=>{
    if(!req.body.expectedDetailsVersion)throw new (require('../../domain/errors').ValidationError)('Reload this product before saving its latest details. Nothing was overwritten.');
    await catalog.updateItem(database,req.ctx,req.params.id,req.body);
    req.flash('success','Product details saved.');
    return res.redirect(303,`/inventory/${req.params.id}`);
  }));
  router.post('/inventory/:id/variants',requirePermission(permissions.OPERATE,'add product variants'),asyncRoute(async(req,res)=>{
    const created=await catalog.addVariant(database,req.ctx,req.params.id,req.body);
    req.flash('success',`${created.label} was added as ${created.code}.`);
    return res.redirect(303,`/inventory/${req.params.id}`);
  }));
  router.post('/inventory/:id/receive',asyncRoute(async(req,res)=>{
    const detail=await catalog.getItem(database,req.ctx.workspaceId,req.params.id);
    const input={skuId:req.body.skuId,locationId:req.body.locationId,quantity:req.body.quantity,
      notes:trimOrNull(req.body.notes),reference:trimOrNull(req.body.reference),
      idempotencyKey:operationKey(req,'receive')};
    if(detail.item.tracking_mode==='lot')Object.assign(input,{lotCode:req.body.lotCode,
      expiresAt:trimOrNull(req.body.expiresAt),lotReceivedAt:trimOrNull(req.body.lotReceivedAt)});
    if(detail.item.tracking_mode==='serial'){
      input.serials=String(req.body.serials || '').split(/[\r\n,]+/).map((v)=>v.trim()).filter(Boolean);
      input.quantity=input.serials.length;
    }
    if(input.reference&&(await database.query(`SELECT 1 FROM movements WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 AND operation='receive' AND reference=$4 LIMIT 1`,[req.ctx.workspaceId,input.skuId,input.locationId,input.reference])).rows.length)
      throw new ValidationError(`Receipt reference ${input.reference} was already recorded for this product and location. Review Activity before receiving it again.`);
    const result=await inventory.receive(database,req.ctx,input);
    await onboarding.reconcileWithInventoryTruth(database,req.ctx.workspaceId);
    req.flash(result.replayed?'warning':'success',result.replayed?'This receipt was already recorded. No stock was added again.':`Received ${result.quantity} ${result.quantity===1?'unit':'units'}.`);
    return res.redirect(303,`/inventory/${req.params.id}`);
  }));
  router.post('/inventory/:id/issue',asyncRoute(async(req,res)=>{
    const serialUnitIds=values(req.body.serialUnitIds);
    const selected=await serialSelection(database,req.ctx.workspaceId,serialUnitIds);
    const result=await inventory.issue(database,req.ctx,{skuId:selected?.skuId || req.body.skuId,
      locationId:selected?.locationId || req.body.locationId,
      quantity:serialUnitIds.length || req.body.quantity,lotId:trimOrNull(req.body.lotId),serialUnitIds,
      occurredAt:trimOrNull(req.body.occurredAt),reasonCode:req.body.reasonCode,notes:trimOrNull(req.body.notes),
      reference:trimOrNull(req.body.reference),idempotencyKey:operationKey(req,'issue')});
    req.flash('success',`Issued ${result.quantity} ${result.quantity===1?'unit':'units'}.`);
    return res.redirect(303,`/inventory/${req.params.id}`);
  }));
  router.post('/inventory/:id/transfer',asyncRoute(async(req,res)=>{
    const serialUnitIds=values(req.body.serialUnitIds);
    const selected=await serialSelection(database,req.ctx.workspaceId,serialUnitIds);
    const transfer=await transfers.request(database,req.ctx,{
      fromLocationId:selected?.locationId || req.body.fromLocationId,toLocationId:req.body.toLocationId,
      notes:trimOrNull(req.body.notes),reference:trimOrNull(req.body.reference),
      idempotencyKey:operationKey(req,'transfer-request'),
      lines:[{skuId:selected?.skuId || req.body.skuId,quantity:serialUnitIds.length || req.body.quantity,
        lotId:trimOrNull(req.body.lotId),serialUnitIds}],
    });
    req.flash('success',`${transfer.transfer_number} was requested. No stock moved yet.`);
    return res.redirect(303,`/transfers/${transfer.id}`);
  }));
  router.post('/inventory/:id/adjust',asyncRoute(async(req,res)=>{
    const result=await inventory.adjust(database,req.ctx,{skuId:req.body.skuId,locationId:req.body.locationId,
      countedQuantity:req.body.countedQty,reasonCode:req.body.reasonCode,notes:trimOrNull(req.body.notes),
      reference:trimOrNull(req.body.reference),idempotencyKey:operationKey(req,'adjust')});
    req.flash('success',result.unchanged?'The count already matched.':`Count corrected to ${result.balanceAfter}.`);
    return res.redirect(303,`/inventory/${req.params.id}`);
  }));
  router.post('/inventory/:id/archive',requireOwner,asyncRoute(async(req,res)=>{
    const restore=req.body.restore==='1';
    await catalog.setItemActive(database,req.ctx,req.params.id,restore);
    req.flash('success',restore?'Product restored.':'Product archived.');
    return res.redirect(303,restore?`/inventory/${req.params.id}`:'/inventory');
  }));
  router.get('/inventory/:id/costs',requirePermission(permissions.MANAGE_ACCOUNTING,'establish inventory cost'),asyncRoute(async(req,res)=>{
    const detail=await catalog.getItem(database,req.ctx.workspaceId,req.params.id);
    const positions=(await database.query(`SELECT s.id AS sku_id,s.code,s.variant_label,l.id AS location_id,l.name AS location_name,b.on_hand,
      COALESCE(c.quantity_units,0) AS costed_units FROM skus s JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id
      JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id AND l.is_active=1
      LEFT JOIN accounting_inventory_cost_balances c ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id
      WHERE s.workspace_id=$1 AND s.item_id=$2 AND s.is_active=1 AND b.on_hand>0 ORDER BY s.position,s.code,l.name`,[req.ctx.workspaceId,req.params.id])).rows;
    const settings=(await database.query('SELECT enabled,base_currency FROM accounting_settings WHERE workspace_id=$1',[req.ctx.workspaceId])).rows[0];
    return res.page('inventory/postgres-stock-cost',{title:'Record cost of existing stock',nav:'inventory',item:detail.item,positions,
      settings:settings||null,today:await require('../../lib/business-time').today(database,req.ctx.workspaceId)});
  }));
  router.post('/inventory/:id/costs/proposals',requirePermission(permissions.MANAGE_ACCOUNTING,'establish inventory cost'),asyncRoute(async(req,res)=>{
    const detail=await catalog.getItem(database,req.ctx.workspaceId,req.params.id);
    const [skuId,locationId]=String(req.body.position||'').split(':');
    if(!(await database.query('SELECT 1 FROM skus WHERE workspace_id=$1 AND item_id=$2 AND id=$3 AND is_active=1',
      [req.ctx.workspaceId,req.params.id,skuId])).rows.length)throw new ValidationError('Choose a variant from this product.');
    const prepared=await require('../../accounting/postgres-inventory-costs').prepare(database,req.ctx,{skuId,locationId,quantity:req.body.quantity,
      unitCost:req.body.unitCost,currency:req.body.currency,basis:req.body.basis,evidenceReference:req.body.evidenceReference,postingDate:req.body.postingDate},
      `Record the evidenced cost of existing ${detail.item.name} stock; do not change physical quantities.`);
    return res.redirect(303,`/actions/${prepared.proposal.id}`);
  }));
  return router;
}

module.exports = { createPostgresInventoryRouter };
