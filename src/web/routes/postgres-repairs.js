'use strict';

const express=require('express');
const permissions=require('../../actions/permissions');
const repairs=require('../../repairs/postgres-service');
const {requireAuth,requirePermission,asyncRoute}=require('../middleware');

function createPostgresRepairsRouter(database){
  const router=express.Router();router.use('/repairs',requireAuth);
  router.get('/repairs',requirePermission(permissions.VIEW,'view repair cases'),asyncRoute(async(req,res)=>
    res.page('repairs/index',{title:'Repair cases',nav:'attention',repairCases:await repairs.list(database,req.ctx.workspaceId,{limit:100})})));
  router.get('/repairs/report',requirePermission(permissions.ADMIN,'report an incorrect external match'),asyncRoute(async(req,res)=>{
    const connectorId=String(req.query.connectorId||'')||null;
    const [mappings,skus]=await Promise.all([repairs.reportableMappings(database,req.ctx.workspaceId,connectorId),
      repairs.selectableSkus(database,req.ctx.workspaceId)]);
    return res.page('repairs/report',{title:'Report something wrong',nav:'attention',mappings,skus});
  }));
  router.post('/repairs/report/wrong-mapping',requirePermission(permissions.ADMIN,'report an incorrect external match'),
    asyncRoute(async(req,res)=>{
      const result=await repairs.openWrongMapping(database,req.ctx,req.body);
      req.flash('success',result.created
        ?'StockChief diagnosed the reported mismatch and added one decision to Needs You. Nothing has changed yet.'
        :'That mismatch is already being handled. StockChief did not create a duplicate case.');
      return res.redirect(303,`/repairs/${result.repairCase.id}`);
    }));
  router.get('/repairs/:id',requirePermission(permissions.VIEW,'view repair cases'),asyncRoute(async(req,res)=>{
    const [repairCase,eventRows]=await Promise.all([repairs.get(database,req.ctx.workspaceId,req.params.id),
      repairs.events(database,req.ctx.workspaceId,req.params.id)]);
    return res.page('repairs/detail',{title:'Repair case',nav:'attention',repairCase,events:eventRows});
  }));
  router.post('/repairs/:id/approve',requirePermission(permissions.ADMIN,'approve repairs'),asyncRoute(async(req,res)=>{
    const result=await repairs.approve(database,req.ctx,req.params.id);
    req.flash('success',result.replayed?'That repair was already approved.':'Repair approved. No connected record has changed yet.');
    return res.redirect(303,`/repairs/${req.params.id}`);
  }));
  router.post('/repairs/:id/execute',requirePermission(permissions.ADMIN,'execute repairs'),asyncRoute(async(req,res)=>{
    const result=await repairs.execute(database,req.ctx,req.params.id);
    req.flash('success',result.replayed?'The corrected mapping was already verified.':'The mapping was corrected and independently verified.');
    return res.redirect(303,`/repairs/${req.params.id}`);
  }));
  router.post('/repairs/:id/verify',requirePermission(permissions.ADMIN,'verify repairs'),asyncRoute(async(req,res)=>{
    const repairCase=await repairs.verify(database,req.ctx,req.params.id);
    req.flash(repairCase.status==='RESOLVED'?'success':'error',repairCase.status==='RESOLVED'
      ?'The corrected mapping is verified.':'The affected records still do not agree. No additional change was made.');
    return res.redirect(303,`/repairs/${req.params.id}`);
  }));
  return router;
}

module.exports={createPostgresRepairsRouter};
