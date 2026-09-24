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
    const filters={q:String(req.query.q || ''),trackingMode:req.query.tracking || '',locationId:req.query.location || '',
      sort:req.query.sort || 'name',includeArchived:req.query.archived==='1' || req.query.archived==='only',
      archivedOnly:req.query.archived==='only',group:req.query.group || ''};
    const result=await catalog.listItems(database,req.ctx.workspaceId,{...filters,page:req.query.page});
    const state=await onboarding.ensure(database,req.ctx.workspaceId);
    return res.page('inventory/list',{title:'Inventory',nav:'inventory',items:result.items,page:result.page,
      hasMore:result.hasMore,filters,locations:await locations.listHierarchy(database,req.ctx.workspaceId),
      returnTo:null,returnLabel:null,fromConnection:null,fromMessage:null,sourceDocument:null,sourceLabel:null,
      stockGroups:[],activeGroup:filters.group||null,query:{...req.query},postgresNative:true,
      layoutOnboardingEntry:{...res.locals.globalOnboardingEntry,state}});
  };
  router.get('/inventory',asyncRoute(async(req,res)=>{
    const hasFilters=['q','location','tracking','archived','sort','page','sourceDocument','fromConnection','fromMessage','group']
      .some((key)=>req.query[key]!==undefined&&req.query[key]!=='');
    if(hasFilters)return renderList(req,res);
    return res.page('inventory/position',{title:'Inventory',nav:'inventory',room:true,
      ...(await presenters.inventoryPosition(database,req.ctx.workspaceId))});
  }));
  router.get('/inventory/table',asyncRoute(renderList));
  router.get('/inventory/new',(req,res)=>res.page('inventory/new',{title:'Add an item',nav:'inventory',
    form:req.query.name?{name:String(req.query.name).slice(0,240)}:{},resumeInstructionId:null,
    fromConfiguration:false}));
  router.post('/inventory',asyncRoute(async(req,res)=>{
    const hasVariants=req.body.hasVariants==='1' || req.body.hasVariants==='on';
    try {
      const created=await catalog.createItem(database,req.ctx,{name:req.body.name,baseCode:req.body.baseCode,
        description:req.body.description,unitLabel:req.body.unitLabel,trackingMode:req.body.trackingMode,
        hasVariants,options:hasVariants?normaliseOptionInput(req.body.options):[]});
      req.flash('success','Item created. Receive some stock to get started.');
      return res.redirect(303,`/inventory/${created.itemId}`);
    } catch(error) {
      if(!(error instanceof ValidationError))throw error;
      return res.status(400).page('inventory/new',{title:'Add an item',nav:'inventory',form:req.body,
        resumeInstructionId:null,fromConfiguration:false,error:error.message});
    }
  }));
  router.get('/inventory/:id',asyncRoute(async(req,res)=>{
    const detail=await catalog.getItem(database,req.ctx.workspaceId,req.params.id,{page:req.query.page});
    const priceState=await pricing.listForSkus(database,req.ctx.workspaceId,detail.skus.map((sku)=>sku.id));
    detail.skus=detail.skus.map((sku)=>({...sku,...priceState.get(sku.id)}));
    return res.page('inventory/postgres-item',{title:detail.item.name,nav:'inventory',...detail});
  }));
  router.post('/inventory/:id/details',requirePermission(permissions.OPERATE,'edit products'),asyncRoute(async(req,res)=>{
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
    const result=await inventory.receive(database,req.ctx,input);
    await onboarding.reconcileWithInventoryTruth(database,req.ctx.workspaceId);
    req.flash('success',`Received ${result.quantity} units.`);
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
    req.flash('success',`Issued ${result.quantity} units.`);
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
  return router;
}

module.exports = { createPostgresInventoryRouter };
