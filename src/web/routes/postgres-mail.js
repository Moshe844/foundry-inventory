'use strict';

const express=require('express');
const mail=require('../../connections/postgres-mail');
const permissions=require('../../actions/permissions');
const {requireAuth,requirePermission,asyncRoute}=require('../middleware');
const {trimOrNull}=require('../../lib/util');

const DRAWERS=[{key:'needs-reply',state:'NEEDS_REPLY',label:'Needs a reply'},
  {key:'waiting',state:'WAITING',label:'Waiting on them'},{key:'handled',state:'HANDLED',label:'Handled'}];

function createPostgresMailRouter(database,options={}){
  const router=express.Router();router.use('/mail',requireAuth);
  router.get('/mail',requirePermission(permissions.VIEW,'read the mailbox'),asyncRoute(async(req,res)=>{
    const drawer=DRAWERS.find((entry)=>entry.key===trimOrNull(req.query.show))||DRAWERS[0];
    return res.page('mail/postgres-inbox',{title:'Mail',nav:'mail',drawers: DRAWERS,drawer,
      counts:await mail.counts(database,req.ctx.workspaceId),messages:await mail.list(database,req.ctx.workspaceId,drawer.state)});
  }));
  router.get('/mail/:id',requirePermission(permissions.VIEW,'read the mailbox'),asyncRoute(async(req,res)=>
    res.page('mail/postgres-message',{title:'Message',nav:'mail',message:await mail.get(database,req.ctx.workspaceId,req.params.id),
      drawers:DRAWERS})));
  router.post('/mail/:id/state',requirePermission(permissions.OPERATE,'sort the mailbox'),asyncRoute(async(req,res)=>{
    await mail.setState(database,req.ctx,req.params.id,req.body.state,req.body.reason);
    req.flash('success','Mailbox state updated.');return res.redirect(303,`/mail/${req.params.id}`);
  }));
  router.post('/mail/:id/draft',requirePermission(permissions.OPERATE,'write replies'),asyncRoute(async(req,res)=>{
    if(req.body.action==='send'){
      await mail.queueSend(database,req.ctx,req.params.id,{subject:req.body.subject,body:req.body.body},{providers:options.providers});
      req.flash('success','Reply queued securely. StockChief will show it as sent only after the mailbox provider confirms it.');
    }else{
      await mail.saveDraft(database,req.ctx,req.params.id,{subject:req.body.subject,body:req.body.body});
      req.flash('success','Draft saved exactly as written. Nothing was sent.');
    }
    return res.redirect(303,`/mail/${req.params.id}`);
  }));
  return router;
}

module.exports={createPostgresMailRouter,DRAWERS};
