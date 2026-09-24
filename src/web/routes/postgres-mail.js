'use strict';

const express=require('express');
const mail=require('../../connections/postgres-mail');
const permissions=require('../../actions/permissions');
const {requireAuth,requirePermission,asyncRoute}=require('../middleware');
const {trimOrNull}=require('../../lib/util');

const DRAWERS=[{key:'needs-reply',state:'NEEDS_REPLY',label:'Needs a reply'},
  {key:'waiting',state:'WAITING',label:'Waiting on them'},{key:'handled',state:'HANDLED',label:'Handled'}];

const STATE_WORDS={NEEDS_REPLY:'Needs a reply',WAITING:'Waiting on them',HANDLED:'Handled'};

function inboxMessage(row){return {...row,counterpartyName:row.supplier_name||row.sender,
  preview:String(row.body_text||'').replace(/\s+/g,' ').slice(0,180),attachment_count:Number(row.attachment_count||0),
  decidedByPerson:Boolean(row.reply_state_by_user_id)};}

function messageForView(row){return {...row,connector_name:row.display_name,stateWords:STATE_WORDS[row.reply_state]||row.reply_state,
  decidedByPerson:Boolean(row.reply_state_by_user_id)};}

function createPostgresMailRouter(database,options={}){
  const router=express.Router();router.use('/mail',requireAuth);
  router.get('/mail',requirePermission(permissions.VIEW,'read the mailbox'),asyncRoute(async(req,res)=>{
    const drawer=DRAWERS.find((entry)=>entry.key===trimOrNull(req.query.show))||DRAWERS[0];
    return res.page('mail/inbox',{title:'Mail',nav:'mail',drawers:DRAWERS,drawer,
      counts:await mail.counts(database,req.ctx.workspaceId),
      messages:(await mail.list(database,req.ctx.workspaceId,drawer.state)).map(inboxMessage)});
  }));
  router.get('/mail/:id',requirePermission(permissions.VIEW,'read the mailbox'),asyncRoute(async(req,res)=>{
    const raw=await mail.get(database,req.ctx.workspaceId,req.params.id);const message=messageForView(raw);
    const [attachmentRows,orderRows]=await Promise.all([
      database.query(`SELECT * FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2 ORDER BY filename`,
        [req.ctx.workspaceId,message.id]),
      database.query(`SELECT so.id,so.order_number,so.status,c.name AS customer_name FROM sales_orders so
        JOIN customers c ON c.id=so.customer_id AND c.workspace_id=so.workspace_id
        WHERE so.workspace_id=$1 AND so.source_email_message_id=$2 ORDER BY so.created_at DESC LIMIT 1`,
      [req.ctx.workspaceId,message.id]),
    ]);
    const draft=message.draft_subject&&message.draft_body?{subject:message.draft_subject,body:message.draft_body,
      source:message.draft_source==='owner'?'person':message.draft_source,rejected:message.draft_rejected_because,
      sentAt:message.reply_sent_at}:null;
    return res.page('mail/message',{title:message.subject||'Message',nav:'mail',message,draft,
      prepared:{order:orderRows.rows[0]||null,because:message.order_draft_reason||null},
      attachments:attachmentRows.rows,drawers:DRAWERS});
  }));
  router.post('/mail/:id/state',requirePermission(permissions.OPERATE,'sort the mailbox'),asyncRoute(async(req,res)=>{
    const state=req.body.state==='RETHINK'?'NEEDS_REPLY':req.body.state;
    const reason=req.body.state==='RETHINK'?'Asked StockChief to review this conversation again.':req.body.reason;
    await mail.setState(database,req.ctx,req.params.id,state,reason);
    req.flash('success',req.body.state==='RETHINK'?'Marked for another review. No business action was invented.':'Mailbox state updated.');
    return res.redirect(303,trimOrNull(req.body.returnTo)||`/mail/${req.params.id}`);
  }));
  router.post('/mail/:id/draft',requirePermission(permissions.OPERATE,'write replies'),asyncRoute(async(req,res)=>{
    if(req.body.action==='send'){
      await mail.queueSend(database,req.ctx,req.params.id,{subject:req.body.subject,body:req.body.body},{providers:options.providers});
      req.flash('success','Reply queued securely. StockChief will show it as sent only after the mailbox provider confirms it.');
    }else if(req.body.action==='write'){
      const message=await mail.get(database,req.ctx.workspaceId,req.params.id);
      const name=message.supplier_name||String(message.sender||'').split('@')[0]||'there';
      await mail.saveDraft(database,req.ctx,req.params.id,{subject:`Re: ${message.subject||'Your message'}`,
        body:`Hi ${name},\n\nThank you for your message. We are reviewing it against our current records and will follow up with the confirmed details.\n\nBest,\n${req.workspace?.name||'The team'}`});
      req.flash('success','StockChief prepared a factual holding reply. Nothing was sent.');
    }else{
      await mail.saveDraft(database,req.ctx,req.params.id,{subject:req.body.subject,body:req.body.body});
      req.flash('success','Draft saved exactly as written. Nothing was sent.');
    }
    return res.redirect(303,`/mail/${req.params.id}`);
  }));
  return router;
}

module.exports={createPostgresMailRouter,DRAWERS};
