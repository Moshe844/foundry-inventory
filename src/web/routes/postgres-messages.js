'use strict';

const express=require('express');
const messages=require('../../connections/postgres-outbound-mail');
const permissions=require('../../actions/permissions');
const {requireAuth,requirePermission,asyncRoute}=require('../middleware');

function createPostgresMessagesRouter(database){
  const router=express.Router();router.use('/messages',requireAuth);
  router.get('/messages/:kind/:id',requirePermission(permissions.VIEW,'read business messages'),asyncRoute(async(req,res)=>res.page('messages/postgres-detail',{
    title:'Business message',nav:'mail',message:await messages.get(database,req.ctx.workspaceId,req.params.kind,req.params.id),
  })));
  return router;
}

module.exports={createPostgresMessagesRouter};
