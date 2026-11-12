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
    const sorter=require('../../connections/agent-mail-triage'),plan=require('../../commercial/agent-plan');
    const [counts,messages,asideCount,sortEnabled]=await Promise.all([mail.counts(database,req.ctx.workspaceId),
      mail.list(database,req.ctx.workspaceId,drawer.state),
      req.user.role==='owner'?mail.setAsideCount(database,req.ctx.workspaceId):Promise.resolve(0),
      req.user.role==='owner'?plan.accountState(database,req.ctx.workspaceId).then(sorter.available):false]);
    return res.page('mail/inbox',{title:'Mail',nav:'mail',drawers:DRAWERS,drawer,
      counts,messages:messages.map(inboxMessage),asideCount,sortEnabled,canReviewAside:req.user.role==='owner',
      canWriteReply:permissions.can(req.user,permissions.OPERATE)});
  }));
  router.get('/mail/sorted',requireOwner,asyncRoute(async(req,res)=>{
    const plan=require('../../commercial/agent-plan'),sorter=require('../../connections/agent-mail-triage');
    const state=await plan.accountState(database,req.ctx.workspaceId);
    const included=plan.permits(state.plan,138,'automatic');
    if(!sorter.available(state)&&req.accepts('html')){
      return res.page('autopilot/agent-plan-locked',{title:'Sorted mail',nav:'mail',tier:'Growth',
        reviewTerms:included,backTo:{href:'/mail',label:'Mail'}});
    }
    plan.requireJob(plan.usesAgentTerms(state)?state.plan:null,138,'automatic');
    const page=Number(req.query.page||1),filter=String(req.query.filter||'').trim().slice(0,254);
    if(!Number.isSafeInteger(page)||page<1||page>1000000)
      throw new(require('../../domain/errors').ValidationError)('Choose a valid mailbox page.');
    const result=await sorter.readPage(database,req.ctx,{page,filter});
    return res.set('Cache-Control','private, no-store').page('mail/sorted',{
      title:'Sorted mail',nav:'mail',result,labels:sorter.labels,page,filter,backTo:{href:'/mail',label:'Mail'}});
  }));
  router.get('/mail/set-aside',requireOwner,asyncRoute(async(req,res)=>{
    const focus=trimOrNull(req.query.focus);
    const [messages,count]=await Promise.all([mail.listSetAside(database,req.ctx.workspaceId,focus),
      mail.setAsideCount(database,req.ctx.workspaceId)]);
    return res.page('mail/postgres-set-aside',{title:'Set-aside mail',nav:'mail',messages,count,focus,
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
    const agentDrafts=await require('../../connections/agent-mail-triage').draftAccess(database,req.ctx.workspaceId);
    const plan=await require('../../commercial/agent-plan').accountState(database,req.ctx.workspaceId);
    const returnSubject=require('../../sales/customer-return-email-source').isReturnSubject(message.subject);
    const customerOrderMail=!returnSubject&&require('../../commercial/agent-plan').usesAgentTerms(plan)&&message.classification==='customer'&&permissions.can(req.user,permissions.OPERATE);
    const canReviewOrder=customerOrderMail&&require('../../commercial/agent-plan').permits(plan.plan,52,'draft');
    const customerReturnMail=req.user?.role==='owner'&&message.classification==='customer'&&returnSubject;
    const canReviewReturn=customerReturnMail&&require('../../commercial/agent-plan').usesAgentTerms(plan)&&require('../../commercial/agent-plan').permits(plan.plan,111,'draft');
    const supplierDetailsMail=req.user?.role==='owner'&&message.classification==='supplier'&&require('../../purchasing/supplier-email-terms-source').isSubject(message.subject);
    const canReviewSupplierDetails=supplierDetailsMail&&require('../../commercial/agent-plan').usesAgentTerms(plan)&&require('../../commercial/agent-plan').permits(plan.plan,96,'draft');
    const supplierPurchaseMail=req.user?.role==='owner'&&message.classification==='supplier'&&
      Boolean(require('../../purchasing/po-amendment-email-parser').subject(message.subject));
    const canReviewSupplierPurchase=supplierPurchaseMail&&require('../../commercial/agent-plan').usesAgentTerms(plan)&&
      require('../../commercial/agent-plan').permits(plan.plan,31,'draft');
    const supplierAvailabilityMail=req.user?.role==='owner'&&message.classification==='supplier'&&Boolean(message.external_thread_id);
    const canReviewAvailability=supplierAvailabilityMail&&require('../../commercial/agent-plan').usesAgentTerms(plan)&&
      require('../../commercial/agent-plan').permits(plan.plan,32,'draft');
    const supplierShipDateMail=supplierAvailabilityMail&&require('../../purchasing/supplier-ship-date-mail-parser')
      .mayContainShipDate(message.subject,message.body_text);
    const canReviewShipDate=supplierShipDateMail&&require('../../commercial/agent-plan').usesAgentTerms(plan)&&
      require('../../commercial/agent-plan').permits(plan.plan,29,'draft');
    const supplierShipDateSource=canReviewShipDate?await require('../../purchasing/supplier-ship-date-mail')
      .savedSource(database,req.ctx.workspaceId,message.id):null;
    const canImproveDraft=agentDrafts&&(await entitlements.capabilityState(database,commercialScope(req),
      'communications.ai_drafts')).enabled&&Boolean(options.aiProvider||require('../../config').ai.configured||require('../../assistant/postgres-codex-pilot').configured(req.ctx))
      &&!['READY','RUNNING'].includes(message.preparation_goal_status)&&!['PENDING','RETRY','RUNNING'].includes(message.draft_job_status);
    return res.page('mail/message',{title:message.subject||'Message',nav:'mail',message,draft,productionMail:true,
      canImproveDraft,agentDrafts,customerOrderMail,canReviewOrder,customerReturnMail,canReviewReturn,supplierDetailsMail,canReviewSupplierDetails,
      supplierPurchaseMail,canReviewSupplierPurchase,supplierAvailabilityMail,canReviewAvailability,
      supplierShipDateMail,canReviewShipDate,supplierShipDateSource,canWriteReply:permissions.can(req.user,permissions.OPERATE),
      prepared:{order:orderRows.rows[0]||null,because:message.order_draft_reason||null},
      attachments:attachmentState.attachments,attachmentReading:attachmentState,drawers:DRAWERS});
  }));
  router.get('/mail/:id/supplier-availability',requireOwner,asyncRoute(async(req,res)=>{
    const review=await require('../../purchasing/supplier-unavailability-mail').review(database,req.ctx,req.params.id);
    if(review.replayed)return res.redirect(303,'/purchasing/orders/'+review.purchaseOrderId);
    return res.set('Cache-Control','private, no-store').page('mail/supplier-availability',{title:'Review original supplier availability',nav:'mail',
      review,messageId:req.params.id,backTo:{href:'/mail/'+req.params.id,label:'Original supplier email'}});
  }));
  router.post('/mail/:id/supplier-availability',requireOwner,asyncRoute(async(req,res)=>{
    const result=await require('../../purchasing/supplier-unavailability-mail').recordReviewed(database,req.ctx,req.params.id,req.body);
    req.flash('success','The original supplier statement is recorded on this purchase order.');
    res.redirect(303,'/purchasing/orders/'+result.purchaseOrderId);
  }));
  router.post('/mail/:id/purchase-changes',requireOwner,asyncRoute(async(req,res)=>{
    const result=await require('../../purchasing/po-amendment-email').intake(database,req.ctx.workspaceId,req.params.id);
    res.redirect(303,'/autopilot/po-delivery-dates/'+result.id);
  }));
  router.get('/mail/:id/supplier-details',requireOwner,asyncRoute(async(req,res)=>res.page('mail/supplier-details',{title:'Review supplier email updates',nav:'mail',...(await require('../../purchasing/agent-supplier-email-terms').page(database,req.ctx,req.params.id))})));
  router.post('/mail/:id/supplier-details',requireOwner,asyncRoute(async(req,res)=>{await require('../../purchasing/agent-supplier-email-terms').apply(database,req.ctx,req.params.id,req.body);res.redirect(303,'/mail/'+req.params.id+'/supplier-details');}));
  router.post('/mail/:id/supplier-details-settings',requireOwner,asyncRoute(async(req,res)=>{const message=await mail.get(database,req.ctx.workspaceId,req.params.id);await require('../../purchasing/agent-supplier-email-terms').configure(database,req.ctx,message.supplier_id,{...req.body,skuIds:[].concat(req.body.skuIds||[]),fields:[].concat(req.body.fields||[])});res.redirect(303,'/mail/'+req.params.id+'/supplier-details');}));
  router.post('/mail/:id/supplier-details-rule',requireOwner,asyncRoute(async(req,res)=>{await require('../../purchasing/agent-supplier-email-terms').teach(database,req.ctx,req.params.id,req.body);res.redirect(303,'/mail/'+req.params.id+'/supplier-details');}));
  router.get('/mail/:id/return',requireOwner,asyncRoute(async(req,res)=>res.page('mail/return-review',{title:'Review customer return email',nav:'mail',...(await require('../../sales/agent-customer-return-emails').page(database,req.ctx,req.params.id,req.query.locationId))})));
  router.post('/mail/:id/return',requireOwner,asyncRoute(async(req,res)=>{
    await require('../../sales/agent-customer-return-emails').create(database,req.ctx,req.params.id,req.body);res.redirect(303,'/mail/'+req.params.id+'/return');
  }));
  router.post('/mail/:id/return-settings',requireOwner,asyncRoute(async(req,res)=>{
    await require('../../sales/agent-customer-return-emails').configure(database,req.ctx,req.body);res.redirect(303,'/mail/'+req.params.id+'/return');
  }));
  router.post('/mail/:id/return-rule',requireOwner,asyncRoute(async(req,res)=>{
    await require('../../sales/agent-customer-return-emails').teach(database,req.ctx,req.params.id,req.body);res.redirect(303,'/mail/'+req.params.id+'/return');
  }));
  // A "same as last month" email is a repeat order (job 53); other order emails are read line by line (job 52).
  const repeatEmail=async req=>{
    const m=(await database.query('SELECT subject,body_text FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[req.ctx.workspaceId,req.params.id])).rows[0];
    if(!m||(await database.query('SELECT 1 FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2 LIMIT 1',[req.ctx.workspaceId,req.params.id])).rowCount)return false;
    return require('../../sales/agent-repeat-orders').isEmailRequest(m.subject,m.body_text);
  };
  router.get('/mail/:id/order',requirePermission(permissions.OPERATE,'prepare a customer order'),asyncRoute(async(req,res)=>{
    const review=await (await repeatEmail(req)?require('../../sales/agent-repeat-orders'):require('../../sales/postgres-email-order')).review(database,req.ctx,req.params.id);
    if(review.existing)return res.redirect(303,'/orders/'+encodeURIComponent(review.existing.id));
    return res.page('mail/order-review',{title:'Review customer order',nav:'mail',review,messageId:req.params.id,money:require('../../pricing/postgres-service').formatMinor});
  }));
  router.post('/mail/:id/order',requirePermission(permissions.OPERATE,'prepare a customer order'),asyncRoute(async(req,res)=>{
    const order=await (await repeatEmail(req)?require('../../sales/agent-repeat-orders'):require('../../sales/postgres-email-order')).create(database,req.ctx,req.params.id,req.body.digest);
    return res.redirect(303,'/orders/'+encodeURIComponent(order.salesOrderId));
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
    const filingEnabled=res.locals.currentUser?.role==='owner'&&require('../../documents/agent-document-discovery')
      .available(await require('../../commercial/agent-plan').accountState(database,req.ctx.workspaceId));
    return res.page('mail/attachment-text',{title:document.filename,nav:'mail',document,messageId:req.params.id,filingEnabled});
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
      if(!options.aiProvider&&require('../../assistant/postgres-codex-pilot').configured(req.ctx)){
        await require('../../connections/postgres-mail-preparation').request(database,req.ctx,req.params.id);
        req.flash('success','StockChief is preparing this reply. Your existing email and draft are saved.');
        return res.redirect(303,`/mail/${req.params.id}`);
      }
      await require('../../connections/postgres-reply-drafting').prepare(database,req.ctx,req.params.id,
        {provider:options.aiProvider});
      req.flash('success','StockChief prepared a reply from verified records. Check and edit it before sending.');
    }else{
      await mail.saveDraft(database,req.ctx,req.params.id,{subject:req.body.subject,body:req.body.body});
      req.flash('success','Draft saved exactly as written. Nothing was sent.');
    }
    return res.redirect(303,`/mail/${req.params.id}`);
  }));
  router.post('/mail/:id/discard',requirePermission(permissions.OPERATE,'discard an unsent reply'),asyncRoute(async(req,res)=>{
    await require('../../connections/postgres-mail-preparation').discard(database,req.ctx,req.params.id);
    req.flash('success','Reply discarded. The original email and saved draft remain in history.');
    return res.redirect(303,`/mail/${req.params.id}`);
  }));
  return router;
}

module.exports={createPostgresMailRouter,DRAWERS};
