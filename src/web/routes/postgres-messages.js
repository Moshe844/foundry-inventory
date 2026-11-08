'use strict';

const express=require('express');
const messages=require('../../connections/postgres-outbound-mail');
const permissions=require('../../actions/permissions');
const {requireAuth,requirePermission,asyncRoute}=require('../middleware');

function createPostgresMessagesRouter(database){
  const router=express.Router();router.use('/messages',requireAuth);
  router.get('/messages/:kind/:id',requirePermission(permissions.VIEW,'read business messages'),asyncRoute(async(req,res)=>{
    const message=await messages.get(database,req.ctx.workspaceId,req.params.kind,req.params.id);
    if(message.message_kind==='agent_negotiation'){
      await require('../../commercial/agent-plan').requireWorkspaceJob(database,req.ctx.workspaceId,94,'draft');
      permissions.assertCan(req.user,permissions.VIEW_PURCHASING,'read supplier negotiations');
      await require('../../operations/postgres-warehouse-access').assertInventoryWide(database,req.ctx);
    }
    return res.page('messages/postgres-detail',{title:'Business message',nav:'mail',message});
  }));
  return router;
}

module.exports={createPostgresMessagesRouter};
