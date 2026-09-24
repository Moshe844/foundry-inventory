'use strict';

const express = require('express');
const locations = require('../../domain/postgres-location-service');
const { requireAuth, requireOwner, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

function input(body) {
  return {name:body.name,kind:body.kind,note:body.note,address:body.address,phone:body.phone,
    parentLocationId:body.parentLocationId,barcode:body.barcode,pickSequence:body.pickSequence};
}

function createPostgresLocationsRouter(database) {
  const router=express.Router();
  router.use('/locations',requireAuth);
  router.get('/locations',asyncRoute(async(req,res)=>res.page('locations/list',{title:'Locations',nav:'locations',
    locations:await locations.listHierarchy(database,req.ctx.workspaceId,{includeInactive:true}),
    editId:req.query.edit || null,renameTo:req.query.edit && req.query.name?String(req.query.name).slice(0,120):null,
    resumeInstruction:trimOrNull(req.query.resume) || null})));
  router.post('/locations',requireOwner,asyncRoute(async(req,res)=>{
    const created=await locations.createLocation(database,req.ctx,input(req.body));
    req.flash('success',`${created.name} is ready to hold stock.`);
    return res.redirect(303,'/locations');
  }));
  router.post('/locations/:id',requireOwner,asyncRoute(async(req,res)=>{
    await locations.updateLocation(database,req.ctx,req.params.id,input(req.body));
    req.flash('success','Location updated.');
    return res.redirect(303,'/locations');
  }));
  router.post('/locations/:id/archive',requireOwner,asyncRoute(async(req,res)=>{
    const restore=req.body.restore==='1';
    const changed=await locations.setLocationActive(database,req.ctx,req.params.id,restore);
    req.flash('success',restore?`${changed.name} restored.`:`${changed.name} archived.`);
    return res.redirect(303,'/locations');
  }));
  return router;
}

module.exports = { createPostgresLocationsRouter };
