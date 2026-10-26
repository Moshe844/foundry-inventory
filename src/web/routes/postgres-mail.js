'use strict';

const express=require('express');
const mail=require('../../connections/postgres-mail');
const permissions=require('../../actions/permissions');
const {requireAuth,requireOwner,requirePermission,asyncRoute}=require('../middleware');
const {trimOrNull}=require('../../lib/util');
const entitlements=require('../../entitlements/postgres-service');
const {commercialScope}=require('../commercial-middleware');

const DRAWERS=[{key:'needs-reply',state:'NEEDS_REPLY',label:'Needs a reply'},
  {key:'sending',state:'SENDING',label:'Sending'},
  {key:'uncertain',state:'UNCERTAIN',label:'Delivery uncertain'},
  {key:'waiting',state:'WAITING',label:'Waiting on them'},{key:'handled',state:'HANDLED',label:'Handled'}];

const STATE_WORDS={NEEDS_REPLY:'Needs a reply',WAITING:'Waiting on them',HANDLED:'Handled'};

function inboxMessage(raw){const row=require('../../connections/mail-presentation').message(raw);return {...row,counterpartyName:row.supplier_name||row.sender,
  preview:String(row.body_text||'').replace(/\s+/g,' ').slice(0,180),attachment_count:Number(row.attachment_count||0),
  decidedByPerson:Boolean(row.reply_state_by_user_id)};}

function messageForView(raw){const row=require('../../connections/mail-presentation').message(raw);return {...row,connector_name:row.display_name,
  stateWords:['PENDING','SENDING'].includes(row.outbox_status)?'Sending reply':
    row.outbox_status==='AMBIGUOUS'?'Delivery uncertain':row.stateWords,
  decidedByPerson:Boolean(row.reply_state_by_user_id)};}

function createPostgresMailRouter(database,options={}){
  const router=express.Router();router.use('/mail',requireAuth);
  router.get('/mail',requirePermission(permissions.VIEW,'read the mailbox'),asyncRoute(async(req,res)=>{
    const drawer=DRAWERS.find((entry)=>entry.key===trimOrNull(req.query.show))||DRAWERS[0];
    const [counts,messages,asideCount]=await Promise.all([mail.counts(database,req.ctx.workspaceId),
      mail.list(database,req.ctx.workspaceId,drawer.state),
      req.user.role==='owner'?mail.setAsideCount(database,req.ctx.workspaceId):Promise.resolve(0)]);
    return res.page('mail/inbox',{title:'Mail',nav:'mail',drawers:DRAWERS,drawer,
      counts,messages:messages.map(inboxMessage),asideCount,canReviewAside:req.user.role==='owner',
      canWriteReply:permissions.can(req.user,permissions.OPERATE)});
  }));
  router.get('/mail/set-aside',requireOwner,asyncRoute(async(req,res)=>{
    const [messages,count]=await Promise.all([mail.listSetAside(database,req.ctx.workspaceId),
      mail.setAsideCount(database,req.ctx.workspaceId)]);
    return res.page('mail/postgres-set-aside',{title:'Set-aside mail',nav:'mail',messages,count,
      backTo:{href:'/mail',label:'Mail'}});
  }));
  router.post('/mail/set-aside/:id/bring-in',requireOwner,asyncRoute(async(req,res)=>{
    const result=await mail.adoptSetAside(database,req.ctx,req.params.id,
      {kind:req.body.kind,name:req.body.name},{providers:options.providers});
    req.flash('success',result.replayed?'This email was already brought in.':
      `Added the sender as a ${result.kind}. StockChief brought in this one email; nothing was sent.`);
    return res.redirect(303,`/mail/${result.messageId}`);
  }));
  router.get('/mail/:id',requirePermission(permissions.VIEW,'read the mailbox'),asyncRoute(async(req,res)=>{
    const raw=await mail.get(database,req.ctx.workspaceId,req.params.id);const message=messageForView(raw);
    const [attachmentState,orderRows]=await Promise.all([
      require('../../connections/postgres-attachments').readingStatus(database,req.ctx.workspaceId,message.id),
      database.query(`SELECT so.id,so.order_number,so.status,c.name AS customer_name FROM sales_orders so
        JOIN customers c ON c.id=so.customer_id AND c.workspace_id=so.workspace_id
        WHERE so.workspace_id=$1 AND so.source_email_message_id=$2 ORDER BY so.created_at DESC LIMIT 1`,
      [req.ctx.workspaceId,message.id]),
    ]);
    const draft=message.draft_subject&&message.draft_body?{subject:message.draft_subject,body:message.draft_body,
      source:message.draft_source==='owner'?'person':message.draft_source,rejected:message.draft_rejected_because,
      sentAt:message.reply_sent_at}:null;
    const canImproveDraft=(await entitlements.capabilityState(database,commercialScope(req),
      'communications.ai_drafts')).enabled&&Boolean(options.aiProvider||require('../../config').ai.configured);
    return res.page('mail/message',{title:message.subject||'Message',nav:'mail',message,draft,productionMail:true,
      canImproveDraft,canWriteReply:permissions.can(req.user,permissions.OPERATE),
      prepared:{order:orderRows.rows[0]||null,because:message.order_draft_reason||null},
      attachments:attachmentState.attachments,attachmentReading:attachmentState,drawers:DRAWERS});
  }));
  router.get('/mail/:id/attachments/status',requirePermission(permissions.VIEW,'read the mailbox'),asyncRoute(async(req,res)=>{
    res.set('Cache-Control','no-store');return res.json(await require('../../connections/postgres-attachments').readingStatus(database,req.ctx.workspaceId,req.params.id));
  }));
  router.post('/mail/:id/attachments/recheck',requirePermission(permissions.OPERATE,'read saved attachments again'),asyncRoute(async(req,res)=>{
    await require('../../connections/postgres-attachments').requestRecheck(database,req.ctx,req.params.id);
    if(req.accepts(['html','json'])==='json')return res.status(202).json(await require('../../connections/postgres-attachments').readingStatus(database,req.ctx.workspaceId,req.params.id));
    req.flash('success','StockChief is reading the saved attachments again.');return res.redirect(303,'/mail/'+encodeURIComponent(req.params.id)+'#attachments');
  }));
  router.get('/mail/:id/attachments/:attachmentId/text',requirePermission(permissions.VIEW,'read the mailbox'),asyncRoute(async(req,res)=>{
    const document=await require('../../connections/postgres-attachments').textPage(database,req.ctx.workspaceId,req.params.id,req.params.attachmentId,Number(req.query.offset||0));
    return res.page('mail/attachment-text',{title:document.filename,nav:'mail',document,messageId:req.params.id});
  }));
  router.post('/mail/:id/state',requirePermission(permissions.OPERATE,'sort the mailbox'),asyncRoute(async(req,res)=>{
    const state=req.body.state==='RETHINK'?'NEEDS_REPLY':req.body.state;
    const reason=req.body.state==='RETHINK'?'Marked as needing another reply review.':req.body.reason;
    await mail.setState(database,req.ctx,req.params.id,state,reason);
    req.flash('success',req.body.state==='RETHINK'?'Marked as needing a reply.':'Mailbox state updated.');
    return res.redirect(303,trimOrNull(req.body.returnTo)||`/mail/${req.params.id}`);
  }));
  router.post('/mail/:id/draft',requirePermission(permissions.OPERATE,'write replies'),asyncRoute(async(req,res)=>{
    if(req.body.action==='send'){
      await entitlements.assertCapability(database,commercialScope(req),'connection.email');
      await mail.queueSend(database,req.ctx,req.params.id,{subject:req.body.subject,body:req.body.body},{providers:options.providers});
      req.flash('success','Reply queued securely. StockChief will show it as sent only after the mailbox provider confirms it.');
    }else if(req.body.action==='improve'){
      await require('../../connections/postgres-reply-drafting').prepare(database,req.ctx,req.params.id,
        {provider:options.aiProvider});
      req.flash('success','StockChief prepared a reply from verified records. Check and edit it before sending.');
    }else{
      await mail.saveDraft(database,req.ctx,req.params.id,{subject:req.body.subject,body:req.body.body});
      req.flash('success','Draft saved exactly as written. Nothing was sent.');
    }
    return res.redirect(303,`/mail/${req.params.id}`);
  }));
  return router;
}

module.exports={createPostgresMailRouter,DRAWERS};
