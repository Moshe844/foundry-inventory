'use strict';
const {ValidationError}=require('../../domain/errors');

const express=require('express');
const autonomy=require('../../autopilot/postgres-service');
const assistant=require('../../assistant/postgres-service');
const monitoring=require('../../operations/postgres-monitoring');
const { requireAuth,asyncRoute }=require('../middleware');
const {requireCapability}=require('../commercial-middleware');
const entitlements=require('../../entitlements/postgres-service');
const {commercialScope}=require('../commercial-middleware');
const {newId}=require('../../lib/util');

function createPostgresAutopilotRouter(database,options={}){
  const router=express.Router();
  const playbooks=require('../../autopilot/playbooks');
  const owner=require('../middleware').requireOwner;
  const reviews=require('../../autopilot/job-reviews');
  const policy=require('../../commercial/agent-plan');
  const balancing=require('../../transfers/agent-transfer-balancing');
  router.get('/autopilot/transfer-balancing',requireAuth,owner,asyncRoute(async(req,res)=>{
    const settings=await balancing.settings(database,req.ctx,{after:String(req.query.after||''),exampleId:String(req.query.example||''),scope:String(req.query.scope||'')});
    return res.page('autopilot/transfer-balancing',{title:'Stock balancing rules',nav:'autopilot',settings});
  }));
  router.post('/autopilot/transfer-balancing/rule',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await balancing.configure(database,req.ctx,req.body);
    req.flash('success',result.removed?'Balancing rule stopped.':'The exact balancing route and unit limit were saved.');
    return res.redirect(303,'/autopilot/transfer-balancing');
  }));
  router.post('/autopilot/reviews/balance-transfers/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const p=await assistant.prepareAction(database,req.ctx,'Review this exact stock balancing request',{
      action:balancing.action,sku:req.body.sku,fromLocation:req.body.fromLocation,toLocation:req.body.toLocation,
      maximumBalanceQuantity:req.body.maximumBalanceQuantity,
    });
    if(!p.proposal?.id)throw new ValidationError(p.answer||'Choose the exact product and balancing route.');
    return res.redirect(303,'/actions/'+p.proposal.id);
  }));
  const chases=require('../../purchasing/agent-supplier-delivery-chases');
  const confirmations=require('../../purchasing/agent-supplier-ship-promises');
  const confirmationPage=async(req,res)=>res.set('Cache-Control','private, no-store').page('autopilot/supplier-confirmations',{
    title:'Supplier confirmations',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'},
    ...await confirmations.page(database,req.ctx,{...req.query,id:req.params.id})});
  router.get('/autopilot/reviews/supplier-confirmations',requireAuth,owner,(_req,res)=>res.redirect(303,confirmations.path));
  router.get(confirmations.path,requireAuth,owner,asyncRoute(confirmationPage));
  router.get(confirmations.path+'/rules/:id',requireAuth,owner,asyncRoute(confirmationPage));
  for(const route of [confirmations.path,confirmations.path+'/rules/:id'])router.post(route,requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await confirmations.configure(database,req.ctx,{...req.body,id:req.params.id});
    req.flash('success',result.stopped?'Future supplier confirmations are stopped.':'Supplier confirmation authority saved.');
    res.redirect(303,confirmations.path+'/rules/'+result.id);
  }));
  router.get(confirmations.path+'/source/:id',requireAuth,owner,asyncRoute(async(req,res)=>{
    const source=await confirmations.review(database,req.ctx,req.params.id);
    if(source.replayed)return res.redirect(303,'/purchasing/orders/'+source.purchase_order_id);
    res.set('Cache-Control','private, no-store').page('autopilot/supplier-ship-date',{title:'Review supplier ship date',nav:'purchasing',source,
      backTo:{href:'/purchasing/orders/'+source.purchase_order_id,label:'Purchase order'}});
  }));
  router.post(confirmations.path+'/source/:id',requireAuth,owner,asyncRoute(async(req,res)=>{
    if(req.body.confirmed!=='yes')throw new ValidationError('Confirm the exact supplier ship date before saving it.');
    const saved=await confirmations.record(database,req.ctx.workspaceId,req.params.id,{ctx:req.ctx,expectedFingerprint:req.body.fingerprint});
    req.flash('success','The supplier ship date is recorded.');
    res.redirect(303,'/purchasing/orders/'+saved.purchaseOrderId);
  }));
  const chasePage=async(req,res)=>res.set('Cache-Control','private, no-store').page('autopilot/supplier-delivery-chases',{
    title:'Late supplier delivery reminders',nav:'autopilot',backTo:req.params.id?{href:chases.path,label:'Supplier reminders'}:{href:'/autopilot/reviews',label:'Agent reviews'},
    ...await chases.page(database,req.ctx,{...req.query,id:req.params.id})});
  router.get('/autopilot/reviews/late-supplier-deliveries',requireAuth,owner,(_req,res)=>res.redirect(303,chases.path));
  router.get(chases.path,requireAuth,owner,asyncRoute(chasePage));
  router.get(chases.path+'/:id',requireAuth,owner,asyncRoute(chasePage));
  for(const route of [chases.path,chases.path+'/:id'])router.post(route,requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await chases.configure(database,req.ctx,{...req.body,id:req.params.id});
    req.flash('success',result.stopped?'Future late reminders are stopped.':'Late reminders are authorized for the selected supplier and mailbox.');
    res.redirect(303,chases.path+'/'+result.id);
  }));
  const shelfPhotos=require('../../warehouse/agent-shelf-photos');
  const shelfPath='/autopilot/shelf-photos';
  const shelfPage=async(req,res)=>res.page('autopilot/shelf-photos',{
    title:'Count boxes and read shelf labels',nav:'autopilot',
    backTo:req.params.id?{href:shelfPath,label:'Shelf photos'}:{href:'/autopilot/reviews',label:'Agent reviews'},
    ...await shelfPhotos.page(database,req.ctx,req.params.id,req.query.page||1)
  });
  router.get('/autopilot/reviews/shelf-photos',requireAuth,owner,(_req,res)=>res.redirect(303,shelfPath));
  router.get(shelfPath,requireAuth,owner,asyncRoute(shelfPage));
  router.get(shelfPath+'/:id',requireAuth,owner,asyncRoute(shelfPage));
  router.get(shelfPath+'/:id/status',requireAuth,owner,asyncRoute(async(req,res)=>{
    res.set('Cache-Control','private, no-store').json(await shelfPhotos.status(database,req.ctx,req.params.id));
  }));
  router.post(shelfPath,requireAuth,owner,asyncRoute(async(req,res)=>{
    const files=req.files||[];
    if(files.length!==1||files[0].field!=='shelfPhoto')throw new ValidationError('Choose one original shelf photo.');
    const photo=await shelfPhotos.enqueue(database,req.ctx,{buffer:files[0].buffer,filename:files[0].filename,
      requestKey:req.body.requestKey,locationId:req.body.locationId});
    res.redirect(303,shelfPath+'/'+photo.id);
  }));
  router.get(shelfPath+'/:id/original',requireAuth,owner,asyncRoute(async(req,res)=>{
    const photo=await shelfPhotos.load(database,req.ctx,req.params.id);
    res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"sandbox; default-src 'none'"}).type('application/octet-stream').attachment(photo.filename).send(photo.content);
  }));
  router.get(shelfPath+'/:id/preview',requireAuth,owner,asyncRoute(async(req,res)=>{
    const photo=await shelfPhotos.load(database,req.ctx,req.params.id);
    if(!photo.reading)throw new ValidationError('Wait until the original has been checked.');
    const image=await shelfPhotos.readPhoto(photo.content);
    res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).type(image.source.media_type).send(Buffer.from(image.source.data,'base64'));
  }));
  for(const [step,operation] of [['confirm',shelfPhotos.confirm],['retry',shelfPhotos.retry],['stop',shelfPhotos.stopRule]]){
    router.post(shelfPath+'/:id/'+step,requireAuth,owner,asyncRoute(async(req,res)=>{
      await operation(database,req.ctx,req.params.id,req.body);
      res.redirect(303,shelfPath+'/'+req.params.id);
    }));
  }
  const backupSuppliers=require('../../purchasing/agent-backup-suppliers');
  const backupPath='/autopilot/backup-suppliers';
  const backupPage=async(req,res)=>res.page('autopilot/backup-suppliers',{
    title:'Backup suppliers',nav:'autopilot',cash:require('../../domain/currency'),
    backTo:req.params.id?{href:backupPath,label:'Backup suppliers'}:{href:'/autopilot/reviews',label:'Agent reviews'},
    ...await backupSuppliers.page(database,req.ctx,req.params.id,req.query.page||1)
  });
  router.get('/autopilot/reviews/backup-suppliers',requireAuth,owner,(_req,res)=>res.redirect(303,backupPath));
  router.get(backupPath,requireAuth,owner,asyncRoute(backupPage));
  router.get(backupPath+'/:id',requireAuth,owner,asyncRoute(backupPage));
  router.post(backupPath,requireAuth,owner,asyncRoute(async(req,res)=>{
    const exact=await backupSuppliers.exactChoice(database,req.ctx,req.body);
    const result=await backupSuppliers.configure(database,req.ctx,{...req.body,...exact,id:null});
    res.redirect(303,backupPath+'/'+result.id);
  }));
  router.post(backupPath+'/:id/settings',requireAuth,owner,asyncRoute(async(req,res)=>{
    const exact=await backupSuppliers.exactChoice(database,req.ctx,req.body);
    const result=await backupSuppliers.configure(database,req.ctx,{...req.body,...exact,id:req.params.id});
    res.redirect(303,backupPath+'/'+result.id);
  }));
  router.post(backupPath+'/:id/stop',requireAuth,owner,asyncRoute(async(req,res)=>{
    await backupSuppliers.configure(database,req.ctx,{id:req.params.id,revision:req.body.revision,stop:'yes'});
    res.redirect(303,backupPath+'/'+req.params.id);
  }));
  for(const [step,apply] of [['execute',backupSuppliers.execute],['teach',backupSuppliers.teach],['unavailable',backupSuppliers.recordUnavailable]]){
    router.post(backupPath+'/:id/'+step,requireAuth,owner,asyncRoute(async(req,res)=>{
      await apply(database,req.ctx,req.params.id,req.body);
      res.redirect(303,backupPath+'/'+req.params.id);
    }));
  }
  router.post(backupPath+'/:id/withdraw',requireAuth,owner,asyncRoute(async(req,res)=>{
    await backupSuppliers.withdrawNotice(database,req.ctx,req.body.noticeId);
    res.redirect(303,backupPath+'/'+req.params.id);
  }));
  const sop=require('../../documents/agent-sop-sources');
  const sopPath='/autopilot/procedure-originals';
  const sopPage=async(req,res)=>{
    const state=await policy.accountState(database,req.ctx.workspaceId);
    const included=policy.permits(state.plan,212,'draft');
    const backTo={href:req.params.id?sopPath:'/autopilot/reviews',label:req.params.id?'Procedure originals':'Agent reviews'};
    if(!included||!policy.usesAgentTerms(state))return res.page('autopilot/agent-plan-locked',{
      title:'Procedure originals',nav:'autopilot',tier:'Pro',reviewTerms:included,backTo
    });
    return res.page('autopilot/procedure-originals',{title:'Procedure originals',nav:'autopilot',backTo,...await sop.page(database,req.ctx,req.params.id)});
  };
  router.get('/autopilot/reviews/procedure-originals',requireAuth,owner,(_req,res)=>res.redirect(303,sopPath));
  router.get([sopPath,sopPath+'/:id'],requireAuth,owner,asyncRoute(sopPage));
  router.get(sopPath+'/:id/original',requireAuth,owner,asyncRoute(async(req,res)=>{
    await sop.authorize(database,req.ctx);
    const record=await sop.load(database,req.ctx,req.params.id);
    res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"})
      .attachment(record.filename).type('application/octet-stream').send(record.content);
  }));
  router.post(sopPath,requireAuth,owner,asyncRoute(async(req,res)=>{
    if(req.files?.length!==1||req.files[0].field!=='procedure')throw new ValidationError('Choose one complete procedure original.');
    const {id}=await sop.enqueue(database,req.ctx,req.files[0]);
    res.redirect(303,sopPath+'/'+id);
  }));
  router.post(sopPath+'/:id/retry',requireAuth,owner,asyncRoute(async(req,res)=>{
    const {id}=await sop.retry(database,req.ctx,req.params.id);
    res.redirect(303,sopPath+'/'+id);
  }));
  router.post(sopPath+'/:id/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const proposal=await sop.prepare(database,req.ctx,{...req.body,sourceId:req.params.id},{provider:options.provider});
    res.redirect(303,'/operating-instructions/'+proposal.id);
  }));
  const voice=require('../../documents/agent-voice-receiving'),voicePath='/autopilot/receiving-voice-notes';
  const voiceAvailable=options.voiceAvailable??Boolean(process.env.OPENAI_API_KEY&&require('../../config').ai.configured);
  const voicePage=async(req,res)=>{
    const state=await policy.accountState(database,req.ctx.workspaceId);
    const included=policy.permits(state.plan,141,'draft');
    const backTo={href:req.params.id?voicePath:'/autopilot/reviews',label:req.params.id?'Receiving voice notes':'Agent reviews'};
    if(!included||!policy.usesAgentTerms(state))return res.page('autopilot/agent-plan-locked',{
      title:'Receiving voice notes',nav:'autopilot',tier:'Growth',reviewTerms:included,backTo
    });
    return res.page('autopilot/receiving-voice-notes',{title:'Receiving voice notes',nav:'autopilot',backTo,
      providerAvailable:voiceAvailable,
      ...await voice.page(database,req.ctx,req.params.id)});
  };
  router.get('/autopilot/reviews/receiving-voice-notes',requireAuth,owner,(_req,res)=>res.redirect(303,voicePath));
  router.get([voicePath,voicePath+'/:id'],requireAuth,owner,asyncRoute(voicePage));
  router.get(voicePath+'/:id/audio',requireAuth,owner,asyncRoute(async(req,res)=>{
    await voice.authorize(database,req.ctx);
    const note=await voice.load(database,req.ctx,req.params.id,{content:true});
    res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).type('audio/wav').send(note.content);
  }));
  router.post(voicePath,requireAuth,owner,asyncRoute(async(req,res)=>{
    await voice.authorize(database,req.ctx);
    if(!voiceAvailable)throw new ValidationError('Voice note reading is currently unavailable.');
    if(req.files?.length!==1||req.files[0].field!=='recording')throw new ValidationError('Choose one recording for this purchase order.');
    const orderId=await voice.resolveOrder(database,req.ctx,req.body.orderNumber);
    const {id}=await voice.enqueue(database,req.ctx,{...req.files[0],orderId,confirmed:req.body.confirmed});
    res.redirect(303,voicePath+'/'+id);
  }));
  router.post(voicePath+'/:id/confirm',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await voice.confirm(database,req.ctx,req.params.id,req.body);
    res.redirect(303,'/purchasing/orders/'+result.purchaseOrderId);
  }));
  function starterAgentPage(job,mode,title,render,tier='Starter'){
    return asyncRoute(async(req,res)=>{
      const state=await policy.accountState(database,req.ctx.workspaceId);
      const planIncludes=policy.permits(state.plan,job,mode);
      if(planIncludes&&policy.usesAgentTerms(state))return render(req,res,state);
      return res.page('autopilot/agent-plan-locked',{title,nav:'autopilot',tier,
        reviewTerms:planIncludes&&!policy.usesAgentTerms(state),backTo:{href:'/autopilot/reviews',label:'Agent reviews'}});
    });
  }
  const contractReader=require('../../documents/agent-contract-reader');
  const contractsPage=starterAgentPage(143,'suggest','Contract prices, terms and dates',async(req,res)=>res.page('autopilot/contracts',{title:'Contract prices, terms and dates',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'},contractLabels:contractReader.labels,screen:await contractReader.page(database,req.ctx,{id:req.params.id,page:req.query.page||1})}));
  router.get('/autopilot/reviews/contract-readings',requireAuth,owner,(req,res)=>res.redirect(303,'/autopilot/contracts'));
  router.get('/autopilot/contracts',requireAuth,owner,contractsPage);
  router.post('/autopilot/contracts/settings',requireAuth,owner,asyncRoute(async(req,res)=>{await contractReader.configure(database,req.ctx,req.body);await contractReader.schedule(database,req.ctx.workspaceId);res.redirect(303,'/autopilot/contracts');}));
  router.post('/autopilot/contracts',requireAuth,owner,asyncRoute(async(req,res)=>{if(req.files?.length!==1||req.files[0].field!=='contract')throw new ValidationError('Choose one complete contract file.');const r=await contractReader.enqueue(database,req.ctx,{buffer:req.files[0].buffer,filename:req.files[0].filename,requestKey:req.body.requestKey});res.redirect(303,'/autopilot/contracts/'+r.id);}));
  router.get('/autopilot/contracts/:id/status',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await contractReader.load(database,req.ctx,req.params.id);res.set('Cache-Control','no-store').json({status:r.status,jobStatus:r.job_status,problem:r.problem});}));
  router.get('/autopilot/contracts/:id/original',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await contractReader.load(database,req.ctx,req.params.id);res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"}).type('application/octet-stream').attachment(r.filename).send(r.content);}));
  router.get('/autopilot/contracts/:id',requireAuth,owner,contractsPage);
  router.post('/autopilot/contracts/:id/retry',requireAuth,owner,asyncRoute(async(req,res)=>{await contractReader.retry(database,req.ctx,req.params.id);res.redirect(303,'/autopilot/contracts/'+req.params.id);}));
  const supplierReturns=require('../../purchasing/agent-supplier-returns');
  const returnPath=supplierReturns.href;
  const supplierReturnPage=starterAgentPage(115,'draft','Tracked supplier returns',async(req,res)=>{
    const number=Number(req.query.page||1);
    if(!Number.isSafeInteger(number)||number<1||number>1000000)throw new ValidationError('Choose a valid results page.');
    res.set('Cache-Control','no-store');
    return res.page('autopilot/supplier-return-follow-through',{title:'Tracked supplier returns',nav:'autopilot',
      model:await supplierReturns.page(database,req.ctx,{id:req.params.id,billId:req.query.billId,holdId:req.query.holdId,number})});
  },'Pro');
  router.get(returnPath,requireAuth,owner,supplierReturnPage);
  router.get(returnPath+'/:id',requireAuth,owner,supplierReturnPage);
  router.post(returnPath,requireAuth,owner,asyncRoute(async(req,res)=>{
    const selected=[req.body.receiptLine].flat().filter(Boolean);
    const lines=selected.map(id=>({receiptLineId:id,quantity:req.body['quantity_'+id],secondaryQuantity:req.body['weight_'+id],
      serials:String(req.body['serials_'+id]||'').split(',').map(s=>s.trim()).filter(Boolean)}));
    const result=await supplierReturns.capture(database,req.ctx,{billId:req.body.billId,physicallyChecked:req.body.physicallyChecked,
      supplierApproved:req.body.supplierApproved,expected:req.body.expected,supplierReference:req.body.supplierReference,
      reason:req.body.reason,lines,requestKey:req.body.idempotencyKey});
    return res.redirect(303,returnPath+'/'+result.id);
  }));
  for(const [step,handler] of [['approve',supplierReturns.approve],['dispatch',supplierReturns.dispatch],['cancel',supplierReturns.cancel],['scope',supplierReturns.configure]]){
    router.post(returnPath+'/:id/'+step,requireAuth,owner,asyncRoute(async(req,res)=>{
      await handler(database,req.ctx,req.params.id,req.body);
      return res.redirect(303,returnPath+'/'+req.params.id);
    }));
  }
  const protectedStock=require('../../sales/agent-stock-protections');
  router.get('/autopilot/reviews/protected-stock',requireAuth,owner,(_req,res)=>res.redirect(303,protectedStock.href));
  router.get(protectedStock.href,requireAuth,owner,starterAgentPage(12,'draft','Protected stock',async(req,res)=>{
    res.set('Cache-Control','no-store');
    return res.page('autopilot/protected-stock',{title:'Protected stock',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'},
      model:await protectedStock.page(database,req.ctx),edit:typeof req.query.edit==='string'?req.query.edit:null});
  },'Pro'));
  router.post(protectedStock.href,requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await protectedStock.save(database,req.ctx,req.body);
    req.flash('success',result.replayed?'This change was already saved.':result.held?'Saved. '+result.held+' units are reserved now.':
      result.proposed?'Saved. Review the suggested reservation below.':'Saved.');
    return res.redirect(303,protectedStock.href);
  }));
  for(const [path,handler,done] of [['/protections/:id/stop',protectedStock.stop,'Stopped. Its reserved stock is free again.'],
    ['/reservations/:id/approve',protectedStock.approve,'Reserved.'],['/reservations/:id/release',protectedStock.release,'Released. The stock is free again.'],
    ['/changes/:id/undo',protectedStock.undo,'Undone.']]){
    router.post(protectedStock.href+path,requireAuth,owner,asyncRoute(async(req,res)=>{
      const result=await handler(database,req.ctx,req.params.id,req.body);
      req.flash('success',result.replayed?'This was already done.':done);
      return res.redirect(303,protectedStock.href);
    }));
  }
  const backorders=require('../../sales/agent-backorders');
  router.get(backorders.href,requireAuth,owner,starterAgentPage(64,'suggest','Backorders',async(req,res)=>{
    res.set('Cache-Control','no-store');
    return res.page('autopilot/backorders',{title:'Backorders',nav:'autopilot',backTo:{href:'/autopilot/reviews/waiting-orders',label:'Prioritize backorders'},
      model:await backorders.page(database,req.ctx,{locationId:String(req.query.location||'')||null})});
  }));
  const backorderPlace=(id,sharingPage)=>(sharingPage?stockSharing.href:backorders.href)+(id?'?location='+encodeURIComponent(id):'');
  router.post(backorders.href+'/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await backorders.prepare(database,req.ctx,{locationId:req.body.locationId});
    req.flash('success',result.created?'The plan is ready for your approval.':'This plan is already waiting for your approval.');
    return res.redirect(303,backorderPlace(req.body.locationId));
  }));
  router.post(backorders.href+'/settings',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await backorders.configure(database,req.ctx,req.body);
    req.flash('success',result.stopped?'StockChief will prepare backorder stock for your approval instead.':'StockChief will set stock aside on its own within your limit.');
    return res.redirect(303,backorders.href);
  }));
  for(const [step,handler] of [['approve',backorders.approve],['discard',backorders.discard],['undo',backorders.undo]]){
    router.post(backorders.href+'/runs/:id/'+step,requireAuth,owner,asyncRoute(async(req,res)=>{
      const result=await handler(database,req.ctx,req.params.id,req.body);
      if(result.stale)req.flash('error','Stock or orders changed since this plan was made. Review the updated plan.');
      else req.flash('success',step==='approve'?'Stock is set aside for these orders.':step==='discard'?'Plan dismissed.':'The work was undone.');
      return res.redirect(303,backorderPlace(req.body.locationId,req.body.returnTo==='sharing'));
    }));
  }
  const stockSharing=require('../../sales/agent-stock-sharing');
  router.get(stockSharing.href,requireAuth,owner,starterAgentPage(65,'draft','Share scarce stock',async(req,res)=>{
    res.set('Cache-Control','no-store');
    return res.page('autopilot/stock-sharing',{title:'Share scarce stock',nav:'autopilot',backTo:{href:backorders.href,label:'Backorders'},
      model:await stockSharing.page(database,req.ctx,{locationId:String(req.query.location||'')||null})});
  },'Pro'));
  router.post(stockSharing.href+'/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await stockSharing.prepare(database,req.ctx,{locationId:req.body.locationId});
    req.flash('success',result.created?'The split is ready for your approval.':'This split is already waiting for your approval.');
    return res.redirect(303,backorderPlace(req.body.locationId,true));
  }));
  router.post(stockSharing.href+'/rules',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await stockSharing.configure(database,req.ctx,req.body);
    req.flash('success',result.stopped?'Your sharing rules are updated.':result.unchanged?'These rules are already saved.':'Your sharing rules are saved.');
    return res.redirect(303,stockSharing.href);
  }));
  router.post(stockSharing.href+'/teach',requireAuth,owner,asyncRoute(async(req,res)=>{
    await stockSharing.teach(database,req.ctx,req.body);
    req.flash('success','StockChief will share scarce stock like this on its own, within your limit.');
    return res.redirect(303,stockSharing.href);
  }));
  router.post(stockSharing.href+'/tiers',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await stockSharing.setTier(database,req.ctx,req.body);
    req.flash('success',result.tier?result.customer+' is now tier '+result.tier+'.':result.customer+' has no tier.');
    return res.redirect(303,stockSharing.href);
  }));
  const supplierCredits = require('../../purchasing/agent-supplier-credit-notes');
  const supplierCreditPage = starterAgentPage(105,'suggest','Supplier credit notes',async (req,res) => res.page('autopilot/supplier-credits', {
    title:'Supplier credit notes', nav:'autopilot', backTo:{href:'/autopilot/reviews/supplier-credits',label:'Credit review'},
    ...await supplierCredits.page(database,req.ctx,{...req.query,id:req.params.id}),
  }),'Growth');
  router.get('/autopilot/supplier-credits', requireAuth, owner, supplierCreditPage);
  router.get('/autopilot/supplier-credits/:id', requireAuth, owner, supplierCreditPage);
  router.post('/autopilot/supplier-credits/:id/approve', requireAuth, owner, asyncRoute(async(req,res)=>{
    const result = await supplierCredits.approve(database,req.ctx,req.params.id,req.body);
    req.flash('success',result.replayed?'This exact credit application was already recorded.':'Supplier credit recorded against the reviewed bill.');
    return res.redirect(303,supplierCredits.detailHref(req.params.id)+(req.body.managedReturnId?'?'+new URLSearchParams({managedReturnId:req.body.managedReturnId}):''));
  }));
  const supplierInvoices=require('../../purchasing/agent-supplier-invoice-intake');
  const supplierInvoicePage=starterAgentPage(98,'draft','Supplier invoices',async(req,res,state)=>res.page('autopilot/supplier-invoices',{title:'Supplier invoices: originals, matches and exceptions',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'},...await supplierInvoices.page(database,req.ctx,{...req.query,id:req.params.id}),canTrackCredit:policy.permits(state.plan,105,'suggest'),invoiceCurrency:require('../../domain/currency'),differenceLabel:require('../../purchasing/postgres-invoice-review').differenceLabel}));
  router.get('/autopilot/supplier-invoices',requireAuth,owner,supplierInvoicePage);
  router.post('/autopilot/supplier-invoices/settings',requireAuth,owner,asyncRoute(async(req,res)=>{await supplierInvoices.configure(database,req.ctx,req.body);req.flash('success',req.body.stop==='yes'?'Mailbox invoice matching stopped. Originals are retained.':'Source mailboxes enabled. Clear matches still require the current plan and invoice job authority.');res.redirect(303,'/autopilot/supplier-invoices');}));
  router.post('/autopilot/supplier-invoices/upload',requireAuth,owner,require('../multipart').multipart({limit:21*1024*1024,maxFiles:1}),asyncRoute(async(req,res)=>{const files=(req.files||[]).filter(f=>f.field==='invoiceFile');if(files.length!==1)throw new ValidationError('Choose one complete supplier invoice original.');const orders=(await database.query("SELECT id FROM purchase_orders WHERE workspace_id=$1 AND (id=$2 OR lower(po_number)=lower($2)) ORDER BY id LIMIT 2",[req.ctx.workspaceId,String(req.body.purchaseOrderReference||'').trim()])).rows;if(orders.length!==1)throw new ValidationError('Choose the exact placed purchase order number.');await require('../../purchasing/supplier-invoice-uploads').enqueue(database,req.ctx,{buffer:files[0].buffer,filename:files[0].filename,purchaseOrderId:orders[0].id});req.flash('success','Original saved and queued for reading. Rechecks reuse its single document receipt.');res.redirect(303,'/autopilot/supplier-invoices');}));
  router.post('/autopilot/supplier-invoice-uploads/:id/retry',requireAuth,owner,asyncRoute(async(req,res)=>{await require('../../purchasing/supplier-invoice-uploads').retry(database,req.ctx,req.params.id);res.redirect(303,'/autopilot/supplier-invoices');}));
  router.post('/autopilot/supplier-invoice-uploads/:id/stop',requireAuth,owner,asyncRoute(async(req,res)=>{await require('../../purchasing/supplier-invoice-uploads').cancel(database,req.ctx,req.params.id);res.redirect(303,'/autopilot/supplier-invoices');}));
  router.get('/autopilot/supplier-invoice-uploads/:id/original',requireAuth,owner,asyncRoute(async(req,res)=>{
    await supplierInvoices.owner(database,req.ctx);
    const row=(await database.query(`SELECT u.filename,coalesce(u.content,r.contents) AS content FROM stockchief_runtime.agent_supplier_invoice_uploads u
      LEFT JOIN stockchief_runtime.supplier_link_submissions r ON r.workspace_id=u.workspace_id AND r.id=u.supplier_submission_id
      WHERE u.workspace_id=$1 AND u.id=$2`,[req.ctx.workspaceId,req.params.id])).rows[0];
    if(!row?.content)throw new ValidationError('That original is unavailable.');
    res.set({'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="'+row.filename.replace(/[^a-zA-Z0-9_.-]/g,'_')+'"','Cache-Control':'private, no-store'});
    res.send(row.content);
  }));
  router.get('/autopilot/supplier-invoices/:id',requireAuth,owner,supplierInvoicePage);
  const supplierPriceLists=require('../../purchasing/agent-supplier-price-lists');
  const supplierPriceUpdates=require('../../pricing/agent-supplier-price-updates');
  const priceListFormats=require('../../imports/source-formats');
  const supplierPriceListPage=starterAgentPage(91,'suggest','Supplier price lists',async(req,res,state)=>{
    const source=await supplierPriceLists.page(database,req.ctx,req.params.id,req.query);
    res.page('autopilot/supplier-price-lists',{title:'Supplier price lists',nav:'autopilot',
      backTo:{href:'/autopilot/reviews/supplier-price-increases',label:'Supplier price increases'},source,
      formatPrice:require('../../purchasing/agent-supplier-price-increases').format,accept:priceListFormats.accept,
      costUpdates:policy.usesAgentTerms(state)&&policy.permits(state.plan,135,'draft')});
  });
  router.get(supplierPriceLists.path,requireAuth,owner,supplierPriceListPage);
  router.get(supplierPriceLists.path+'/:id',requireAuth,owner,supplierPriceListPage);
  router.post(supplierPriceLists.path+'/upload',requireAuth,owner,require('../multipart').multipart({limit:priceListFormats.maxBytes+65536,maxFiles:1}),asyncRoute(async(req,res)=>{
    const files=(req.files||[]).filter(file=>file.field==='priceListFile');
    if(files.length!==1)throw new ValidationError('Choose one complete supplier price-list original.');
    const result=await supplierPriceLists.upload(database,req.ctx,{...files[0],supplierId:req.body.supplierId,currency:req.body.currency});
    res.redirect(303,supplierPriceLists.path+'/'+result.id);
  }));
  router.get(supplierPriceLists.path+'/:id/original',requireAuth,owner,asyncRoute(async(req,res)=>{
    const file=await supplierPriceLists.download(database,req.ctx,req.params.id);
    res.set({'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="'+file.filename.replace(/[^a-zA-Z0-9_.-]/g,'_')+'"','Cache-Control':'private, no-store'});
    res.send(file.original);
  }));
  router.post(supplierPriceLists.path+'/:id/reviewed',requireAuth,owner,asyncRoute(async(req,res)=>{
    await supplierPriceLists.acknowledge(database,req.ctx,req.params.id);
    res.redirect(303,supplierPriceLists.path+'/'+req.params.id);
  }));
  router.post(supplierPriceLists.path+'/:id/confirm',requireAuth,owner,asyncRoute(async(req,res)=>{
    await supplierPriceLists.confirm(database,req.ctx,req.params.id,req.body);
    res.redirect(303,supplierPriceLists.path+'/'+req.params.id);
  }));
  // Job 135: supplier price lists update the exact supplier's future costs.
  const supplierCostPage=starterAgentPage(135,'draft','Supplier cost updates',async(req,res)=>{
    res.set('Cache-Control','no-store');
    res.page('autopilot/supplier-price-updates',{title:'Supplier cost updates',nav:'autopilot',
      screen:await supplierPriceUpdates.page(database,req.ctx,{id:req.params.id||null,page:req.query.page||1}),
      backTo:{href:req.params.id?supplierPriceUpdates.path:'/autopilot/reviews',label:req.params.id?'Supplier cost updates':'Agent reviews'}});
  },'Pro');
  router.get(supplierPriceUpdates.path,requireAuth,owner,supplierCostPage);
  router.get(supplierPriceUpdates.path+'/:id',requireAuth,owner,supplierCostPage);
  const costDone={approve:'The supplier’s cost was updated.',keep:'The current cost stays as it is.',undo:'The previous cost is back.'};
  for(const step of Object.keys(costDone)){
    router.post(supplierPriceUpdates.path+'/:id/rows/:ordinal/'+step,requireAuth,owner,asyncRoute(async(req,res)=>{
      const ordinal=Number(req.params.ordinal);
      if(!Number.isSafeInteger(ordinal)||ordinal<1||ordinal>2147483647)throw new ValidationError('Choose a row from this price list.');
      const result=await supplierPriceUpdates[step](database,req.ctx,req.params.id,ordinal,req.body);
      req.flash('success',result.replayed?'This was already done.':costDone[step]);
      res.redirect(303,supplierPriceUpdates.path+'/'+encodeURIComponent(req.params.id));
    }));
  }
  router.post(supplierPriceUpdates.path+'/:id/keep',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await supplierPriceUpdates.keep(database,req.ctx,req.params.id,null,req.body);
    req.flash('success',result.kept?'The remaining costs stay as they are.':'Nothing was waiting on this list.');
    res.redirect(303,supplierPriceUpdates.path+'/'+encodeURIComponent(req.params.id));
  }));
  router.post(supplierPriceUpdates.path+'/:id/check',requireAuth,owner,asyncRoute(async(req,res)=>{
    await supplierPriceUpdates.check(database,req.ctx,req.params.id);
    req.flash('success','StockChief will check this list against the supplier’s saved costs.');
    res.redirect(303,supplierPriceUpdates.path+'/'+encodeURIComponent(req.params.id));
  }));
  router.post(supplierPriceUpdates.path+'/:id/limit',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await supplierPriceUpdates.configure(database,req.ctx,req.params.id,req.body);
    req.flash('success',result.stopped?'Every cost change from this supplier now waits for you.':'Limit saved. Smaller changes from this supplier now update on their own.');
    res.redirect(303,supplierPriceUpdates.path+'/'+encodeURIComponent(req.params.id));
  }));
  // Job 86: clearance plans. A person approves every price.
  const clearancePlans=require('../../pricing/agent-clearance-plans');
  const clearancePage=starterAgentPage(86,'draft','Clearance plans',async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(req.params.id==='new'){
      const query={sku:String(req.query.sku||''),markdown:String(req.query.markdown??''),stepDays:String(req.query.stepDays??'')};
      let built=null,problem=null;
      if(query.sku){try{built=await clearancePlans.preview(database,req.ctx,query);problem=built.problem;}
        catch(error){if(error.code!=='validation_error')throw error;problem=error.message;}}
      return res.page('autopilot/clearance-plans',{title:'Build a clearance plan',nav:'autopilot',builder:{query,built,problem,requestKey:newId('clearance-plan')},
        screen:null,backTo:{href:clearancePlans.path,label:'Clearance plans'}});
    }
    res.page('autopilot/clearance-plans',{title:'Clearance plans',nav:'autopilot',builder:null,
      screen:await clearancePlans.page(database,req.ctx,{id:req.params.id||null,page:req.query.page||1}),
      backTo:{href:req.params.id?clearancePlans.path:'/autopilot/reviews',label:req.params.id?'Clearance plans':'Agent reviews'}});
  },'Growth');
  router.get(clearancePlans.path,requireAuth,owner,clearancePage);
  router.get(clearancePlans.path+'/:id',requireAuth,owner,clearancePage);
  router.post(clearancePlans.path,requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await clearancePlans.prepare(database,req.ctx,req.body);
    req.flash('success',result.replayed?'This plan was already saved.':'Plan saved. No price changes until you approve it.');
    res.redirect(303,clearancePlans.path+'/'+encodeURIComponent(result.id));
  }));
  router.post(clearancePlans.path+'/:id/approve',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await clearancePlans.approve(database,req.ctx,req.params.id,req.body);
    req.flash('success',result.replayed?'This price was already approved.':'Price approved. The new selling price is live.');
    res.redirect(303,clearancePlans.path+'/'+encodeURIComponent(req.params.id));
  }));
  router.post(clearancePlans.path+'/:id/end',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await clearancePlans.end(database,req.ctx,req.params.id,req.body);
    req.flash('success',result.replayed?'This plan was already closed.':result.cancelled?'Plan cancelled. No price changed.':
      result.restored?'Plan ended. The original price is back.':'Plan ended. The current price stays.');
    res.redirect(303,clearancePlans.path+'/'+encodeURIComponent(req.params.id));
  }));
  // Job 9: next steps for dead and slow stock.
  const slowStock=require('../../forecasting/agent-slow-stock-steps');
  router.get(slowStock.path,requireAuth,owner,starterAgentPage(9,'draft','Slow stock next steps',async(req,res)=>{
    res.set('Cache-Control','no-store');
    res.page('autopilot/slow-stock',{title:'Slow stock next steps',nav:'autopilot',screen:await slowStock.page(database,req.ctx,{page:req.query.page||1}),
      backTo:{href:'/autopilot/reviews/slow-stock',label:'Dead and slow stock'}});
  },'Growth'));
  router.post(slowStock.path+'/check',requireAuth,owner,asyncRoute(async(req,res)=>{
    await slowStock.check(database,req.ctx);
    req.flash('success','StockChief is checking your stock for slow and dead items.');
    res.redirect(303,slowStock.path);
  }));
  const slowDone={approve:'',dismiss:'The stock stays as it is.',undo:'The step was undone.'};
  for(const step of Object.keys(slowDone))router.post(slowStock.path+'/steps/:id/'+step,requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await slowStock[step](database,req.ctx,req.params.id,req.body);
    const approved={MOVE:'Transfer requested. The stock is held until someone approves and moves it.',
      RETURN:'Supplier return requested. Nothing leaves until the supplier agrees and you send it.',DISCOUNT:'Clearance plan saved. No price changes until you approve it.'};
    req.flash('success',result.replayed?'This was already done.':step==='approve'?approved[result.kind]:slowDone[step]);
    res.redirect(303,step==='approve'&&result.kind==='DISCOUNT'?clearancePlans.path+'/'+encodeURIComponent(result.clearance_plan_id):slowStock.path);
  }));
  router.post(slowStock.path+'/limits/:kind',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await slowStock.configure(database,req.ctx,String(req.params.kind).toUpperCase(),req.body);
    req.flash('success',result.stopped?'Every step of this kind now waits for you.':'Limit saved.');
    res.redirect(303,slowStock.path);
  }));
  for(const step of ['approve','stop','replaceUnposted','clarify'])router.post('/autopilot/supplier-invoices/:id/'+step,requireAuth,owner,asyncRoute(async(req,res)=>{await supplierInvoices[step](database,req.ctx,req.params.id,req.body);if(step==='replaceUnposted')await supplierInvoices.requestRecheck(database,req.ctx,req.params.id);req.flash('success',step==='approve'?'The exact reviewed invoice was posted. Stock and payments are unchanged.':step==='clarify'?'Source fields confirmed. Review the fresh comparison before posting.':step==='stop'?'Source stopped; its original is retained.':'Unposted original retained and voided; corrected source queued for a fresh match.');res.redirect(303,'/autopilot/supplier-invoices/'+req.params.id);}));
  router.post('/autopilot/supplier-invoices/:id/recheck',requireAuth,owner,asyncRoute(async(req,res)=>{await supplierInvoices.requestRecheck(database,req.ctx,req.params.id);req.flash('success','Current receipts and earlier invoices will be checked again.');res.redirect(303,'/autopilot/supplier-invoices/'+req.params.id);}));
  const supplierCosts=require('../../purchasing/agent-supplier-comparison-terms');
  router.get('/autopilot/supplier-costs',requireAuth,owner,starterAgentPage(22,'suggest','Supplier delivered cost evidence',async(req,res)=>res.page('autopilot/supplier-costs',{title:'Supplier delivered cost evidence',nav:'autopilot',cash:require('../../domain/currency'),screen:await supplierCosts.screen(database,req.ctx,{supplierItemId:req.query.offer,locationId:req.query.location,filter:req.query.filter,page:req.query.page||1})})));
  router.post('/autopilot/supplier-costs/terms',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await supplierCosts.save(database,req.ctx,req.body);req.flash('success',r.cleared?'Comparison evidence withdrawn.':'Checked delivery and tax evidence saved. No supplier, price, purchase or accounting record was changed.');res.redirect(303,'/autopilot/supplier-costs?offer='+encodeURIComponent(r.supplierItemId)+'&location='+encodeURIComponent(r.locationId));}));
  router.post('/autopilot/supplier-costs/rates',requireAuth,owner,asyncRoute(async(req,res)=>{await supplierCosts.saveRate(database,req.ctx,req.body);req.flash('success','Checked comparison exchange quote saved. No money was posted or exchanged.');res.redirect(303,'/autopilot/supplier-costs');}));
  const customerInvoices=require('../../accounting/agent-customer-invoices');
  router.get('/autopilot/customer-invoices',requireAuth,owner,asyncRoute(async(req,res)=>res.page('autopilot/customer-invoices',{title:'Customer invoices after shipment',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'},...await customerInvoices.page(database,req.ctx,req.query)})));
  router.post('/autopilot/customer-invoices/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const p=await assistant.prepareAction(database,req.ctx,'Prepare this exact posted shipment invoice for printing',{action:'customer_invoice.prepare_document',recordReference:req.body.invoiceNumber});
    if(!p.proposal?.id)throw new ValidationError(p.answer||'Choose the exact posted shipment invoice.');res.redirect(303,'/actions/'+p.proposal.id);
  }));
  router.post('/autopilot/customer-invoices/settings',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await customerInvoices.configure(database,req.ctx,req.body);req.flash('success',r.stopped?'Customer invoice routine stopped.':'Customer invoice routine enabled. New confirmed dispatches queue private printable invoices.');res.redirect(303,'/autopilot/customer-invoices');}));
  router.get('/autopilot/customer-invoices/:id',requireAuth,owner,asyncRoute(async(req,res)=>{const d=await customerInvoices.document(database,req.ctx,req.params.id);res.set({'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.send(d.html);}));
  const blanket=require('../../purchasing/agent-blanket-releases');
  const blanketPage=async(req,res,draft=null)=>res.page('autopilot/blanket-releases',{title:'Supplier contracts and release drafts',nav:'autopilot',suppressBack:true,cash:require('../../domain/currency'),screen:await blanket.screen(database,req.ctx,{id:req.params.id||null,page:req.query.page||1}),draft});
  router.get('/autopilot/blanket-releases',requireAuth,owner,asyncRoute((req,res)=>blanketPage(req,res)));
  router.post('/autopilot/blanket-releases/preview',requireAuth,owner,asyncRoute(async(req,res)=>blanketPage(req,res,await blanket.preview(database,req.ctx,req.body))));
  router.post('/autopilot/blanket-releases',requireAuth,owner,asyncRoute(async(req,res)=>{const p=await blanket.save(database,req.ctx,req.body);res.redirect(303,'/autopilot/blanket-releases/'+p.id);}));
  router.get('/autopilot/blanket-releases/:id',requireAuth,owner,asyncRoute((req,res)=>blanketPage(req,res)));
  router.post('/autopilot/blanket-releases/:id/settings',requireAuth,owner,asyncRoute(async(req,res)=>{await blanket.configure(database,req.ctx,req.params.id,req.body);if(req.body.stop!=='yes')await blanket.schedule(database,req.ctx.workspaceId);res.redirect(303,'/autopilot/blanket-releases/'+req.params.id);}));
  router.post('/autopilot/blanket-releases/:id/end',requireAuth,owner,asyncRoute(async(req,res)=>{await blanket.end(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/blanket-releases/'+req.params.id);}));
  router.post('/autopilot/blanket-releases/releases/:releaseId/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{await blanket.manual(database,req.ctx,req.params.releaseId,req.body);const r=await blanket.release(database,req.ctx,req.params.releaseId);res.redirect(303,'/autopilot/blanket-releases/'+r.contract_id);}));
  router.post('/autopilot/blanket-releases/releases/:releaseId/teach',requireAuth,owner,asyncRoute(async(req,res)=>{const p=await blanket.teach(database,req.ctx,req.params.releaseId,req.body);res.redirect(303,'/autopilot/blanket-releases/'+p.id);}));
  router.post('/autopilot/blanket-releases/releases/:releaseId/skip',requireAuth,owner,asyncRoute(async(req,res)=>{const p=await blanket.skip(database,req.ctx,req.params.releaseId,req.body);await blanket.schedule(database,req.ctx.workspaceId);res.redirect(303,'/autopilot/blanket-releases/'+p.id);}));
  const channelCopy=require('../../catalog/agent-channel-copy');
  const copyPage=async(req,res,extra={})=>res.page('autopilot/channel-copy',{title:'Product copy for sales channels',nav:'autopilot',suppressBack:true,screen:await channelCopy.screen(database,req.ctx,{id:req.params.id||req.body?.id||null,page:req.query.page||1,versionId:req.query.versionId||null}),draft:null,...extra});
  router.get('/autopilot/channel-copy',requireAuth,owner,asyncRoute((req,res)=>copyPage(req,res)));
  router.post('/autopilot/channel-copy/preview',requireAuth,owner,asyncRoute(async(req,res)=>copyPage(req,res,{draft:await channelCopy.preview(database,req.ctx,req.body)})));
  router.post('/autopilot/channel-copy',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await channelCopy.save(database,req.ctx,req.body);res.redirect(303,'/autopilot/channel-copy/'+r.copyId);}));
  router.post('/autopilot/channel-copy/runs/:runId/approve',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await channelCopy.approve(database,req.ctx,req.params.runId,req.body);res.redirect(303,'/autopilot/channel-copy/'+r.copyId);}));
  router.get('/autopilot/channel-copy/versions/:versionId/copy.csv',requireAuth,owner,asyncRoute(async(req,res)=>{const csv=await channelCopy.download(database,req.ctx,req.params.versionId);res.set({'Cache-Control':'no-store','Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="prepared-channel-copy.csv"'});res.send(csv);}));
  router.get('/autopilot/channel-copy/:id',requireAuth,owner,asyncRoute((req,res)=>copyPage(req,res)));
  router.post('/autopilot/channel-copy/:id/settings',requireAuth,owner,asyncRoute(async(req,res)=>{await channelCopy.configure(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/channel-copy/'+req.params.id);}));
  router.post('/autopilot/channel-copy/:id/refresh',requireAuth,owner,asyncRoute(async(req,res)=>{await channelCopy.request(database,req.ctx,req.params.id);req.flash('success','Private copy refresh queued. Nothing will be published.');res.redirect(303,'/autopilot/channel-copy/'+req.params.id);}));
  const stockChat=require('../../sales/agent-website-stock-chat');
  router.get('/autopilot/website-stock-chat',requireAuth,owner,asyncRoute(async(req,res)=>res.page('autopilot/website-stock-chat',{title:'Website stock and delivery answers',nav:'autopilot',suppressBack:true,issuedUrl:null,screen:await stockChat.screen(database,req.ctx,req.query)})));
  router.post('/autopilot/website-stock-chat/publish',requireAuth,owner,asyncRoute(async(req,res)=>{const base=new URL(req.protocol+'://'+req.get('host'));if(!['https:','http:'].includes(base.protocol)||base.username||base.password)throw new ValidationError('Open the current StockChief website before publishing its assistant link.');const p=await stockChat.publish(database,req.ctx,req.body);res.page('autopilot/website-stock-chat',{title:'Website assistant ready',nav:'autopilot',suppressBack:true,issuedUrl:new URL('/stock-assistant/'+p.token,base.origin).href,screen:await stockChat.screen(database,req.ctx)});}));
  router.post('/autopilot/website-stock-chat/:id/stop',requireAuth,owner,asyncRoute(async(req,res)=>{await stockChat.stop(database,req.ctx,req.params.id,req.body);req.flash('success','Public stock answers stopped.');res.redirect(303,'/autopilot/website-stock-chat');}));
  const customerPages=require('../../sales/agent-customer-order-pages');
  router.get('/autopilot/reviews/preorders',requireAuth,owner,(_req,res)=>res.redirect(303,'/autopilot/customer-order-pages'));
  router.get('/autopilot/customer-order-pages',requireAuth,owner,asyncRoute(async(req,res)=>res.page('autopilot/customer-order-pages',{title:'Customer order pages',nav:'autopilot',suppressBack:true,issuedPath:null,screen:await customerPages.screen(database,req.ctx,req.query)})));
  router.post('/autopilot/customer-order-pages/publish',requireAuth,owner,asyncRoute(async(req,res)=>{const p=await customerPages.publish(database,req.ctx,req.body);res.page('autopilot/customer-order-pages',{title:'Customer link ready',nav:'autopilot',suppressBack:true,issuedPath:'/customer/order/'+p.token,screen:await customerPages.screen(database,req.ctx)});}));
  router.post('/autopilot/customer-order-pages/pages/:id/renew',requireAuth,owner,asyncRoute(async(req,res)=>{const p=await customerPages.renew(database,req.ctx,req.params.id,req.body);res.page('autopilot/customer-order-pages',{title:'Renewed customer link ready',nav:'autopilot',suppressBack:true,issuedPath:'/customer/order/'+p.token,screen:await customerPages.screen(database,req.ctx)});}));
  router.post('/autopilot/customer-order-pages/pages/:id/configure',requireAuth,owner,asyncRoute(async(req,res)=>{await customerPages.configure(database,req.ctx,req.params.id,req.body);req.flash('success',req.body.stop==='yes'?'Customer page stopped and its link revoked.':'Routine request drafting enabled within the page limits.');res.redirect(303,'/autopilot/customer-order-pages');}));
  router.post('/autopilot/customer-order-pages/requests/:id/draft',requireAuth,owner,asyncRoute(async(req,res)=>{await customerPages.createDraft(database,req.ctx,req.params.id,req.body);req.flash('success','Original customer request saved as one unconfirmed order draft.');res.redirect(303,'/autopilot/customer-order-pages?requestId='+req.params.id);}));
  router.post('/autopilot/customer-order-pages/requests/:id/teach',requireAuth,owner,asyncRoute(async(req,res)=>{await customerPages.teach(database,req.ctx,req.params.id,req.body);req.flash('success','Exact completed individual request taught for matching routine drafts.');res.redirect(303,'/autopilot/customer-order-pages?requestId='+req.params.id);}));
  router.post('/autopilot/customer-order-pages/requests/:id/stop',requireAuth,owner,asyncRoute(async(req,res)=>{await customerPages.stopRequest(database,req.ctx,req.params.id,req.body);req.flash('success','Unprocessed customer request stopped.');res.redirect(303,'/autopilot/customer-order-pages?requestId='+req.params.id);}));
  const disposition=require('../../operations/agent-return-disposition');
  router.get('/autopilot/return-disposition',requireAuth,owner,asyncRoute(async(req,res)=>res.page('autopilot/return-disposition',{title:'Return restock, repair or scrap',nav:'autopilot',suppressBack:true,screen:await disposition.screen(database,req.ctx,req.query)})));
  router.post('/autopilot/return-disposition/observe',requireAuth,owner,asyncRoute(async(req,res)=>{const p=await disposition.observe(database,req.ctx,req.body);res.redirect(303,'/autopilot/return-disposition?id='+p.id);}));
  router.post('/autopilot/return-disposition/repairs/:id/release',requireAuth,owner,asyncRoute(async(req,res)=>{await disposition.releaseRepair(database,req.ctx,req.params.id,req.body);req.flash('success','Physically repaired goods released after your reinspection.');res.redirect(303,'/autopilot/return-disposition');}));
  router.post('/autopilot/return-disposition/rules',requireAuth,owner,asyncRoute(async(req,res)=>{await disposition.saveRule(database,req.ctx,req.body);req.flash('success','Exact disposition rule saved for individual review.');res.redirect(303,'/autopilot/return-disposition');}));
  router.post('/autopilot/return-disposition/rules/:id/configure',requireAuth,owner,asyncRoute(async(req,res)=>{await disposition.configure(database,req.ctx,req.params.id,req.body);req.flash('success',req.body.stop==='yes'?'Disposition rule stopped.':'Routine decision preparation enabled.');res.redirect(303,'/autopilot/return-disposition');}));
  for(const step of ['prepare','apply','stop'])router.post('/autopilot/return-disposition/:id/'+step,requireAuth,owner,asyncRoute(async(req,res)=>{await disposition[step](database,req.ctx,req.params.id,req.body);req.flash('success',step==='apply'?'Approved physical disposition completed. Refunds remain separate.':step==='stop'?'Assessment stopped; stock stays in quarantine.':'Exact disposition prepared for separate physical approval.');res.redirect(303,'/autopilot/return-disposition?id='+req.params.id);}));
  const contribution=require('../../reports/agent-net-contribution');
  router.get('/autopilot/net-contribution',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/net-contribution',{title:'Sales after fees, shipping and returns',nav:'autopilot',suppressBack:true},()=>contribution.screen(database,req.ctx,req.query))));
  router.post('/autopilot/net-contribution/preview',requireAuth,owner,asyncRoute(async(req,res)=>{const p=await contribution.preview(database,req.ctx,req.body);res.redirect(303,'/autopilot/net-contribution/reviews/'+p.id);}));
  router.get('/autopilot/net-contribution/reviews/:id',requireAuth,owner,asyncRoute(async(req,res)=>{const state=await policy.accountState(database,req.ctx.workspaceId);res.page('autopilot/order-cost-review',{title:'Review actual order costs',nav:'autopilot',suppressBack:true,preview:await contribution.review(database,req.ctx,req.params.id),allowed:policy.usesAgentTerms(state)&&policy.permits(state.plan,85,'draft')});}));
  router.post('/autopilot/net-contribution/reviews/:id/apply',requireAuth,owner,asyncRoute(async(req,res)=>{await contribution.apply(database,req.ctx,req.params.id,req.body);req.flash('success','Actual cost facts confirmed for the contribution report.');res.redirect(303,'/autopilot/net-contribution/reviews/'+req.params.id);}));
  router.post('/autopilot/net-contribution/reviews/:id/stop',requireAuth,owner,asyncRoute(async(req,res)=>{await contribution.stop(database,req.ctx,req.params.id,req.body);req.flash('success','Unreviewed cost import stopped.');res.redirect(303,'/autopilot/net-contribution/reviews/'+req.params.id);}));
  const purchaseFx=require('../../purchasing/agent-purchase-fx');
  router.get('/autopilot/purchase-fx',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/purchase-fx',{title:'Foreign purchase currency exposure',nav:'autopilot',suppressBack:true},()=>purchaseFx.screen(database,req.ctx,req.query))));
  router.post('/autopilot/purchase-fx/baseline',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await purchaseFx.saveBaseline(database,req.ctx,req.body);req.flash('success','Original comparison rate saved.');res.redirect(303,'/autopilot/purchase-fx?'+new URLSearchParams({order:r.id}));}));
  const exportPapers=require('../../shipping/agent-export-papers');
  const exportPage=async(req,res,id=null)=>res.page('autopilot/export-papers',{title:'International paperwork',nav:'autopilot',suppressBack:true,backTo:{href:id?'/autopilot/export-papers':'/autopilot/reviews',label:id?'International paperwork':'Agent reviews'},...await exportPapers.screen(database,req.ctx,id,req.query)});
  router.get('/autopilot/export-papers',requireAuth,owner,asyncRoute((req,res)=>exportPage(req,res)));
  router.post('/autopilot/export-papers/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const p=await assistant.prepareAction(database,req.ctx,'Prepare this private export invoice draft and packing list',{action:'shipping.prepare_export_papers',recordReference:req.body.shipmentReference});
    if(!p.proposal?.id)throw new ValidationError(p.answer||'Choose the exact packed shipment.');res.redirect(303,'/actions/'+p.proposal.id);
  }));
  router.post('/autopilot/export-papers/profile',requireAuth,owner,asyncRoute(async(req,res)=>{await exportPapers.saveProfile(database,req.ctx,req.body);req.flash('success','Exporter facts confirmed.');res.redirect(303,'/autopilot/export-papers');}));
  router.post('/autopilot/export-papers/products',requireAuth,owner,asyncRoute(async(req,res)=>{await exportPapers.saveProducts(database,req.ctx,{...req.body,products:[{sku:req.body.sku,description:req.body.description,hsCode:req.body.hsCode,originCountry:req.body.originCountry,netWeightGrams:req.body.netWeightGrams,revision:req.body.revision}]});req.flash('success','Product trade facts confirmed.');res.redirect(303,'/autopilot/export-papers?'+new URLSearchParams({sku:req.body.sku})+'#trade-facts');}));
  router.post('/autopilot/export-papers/origin',requireAuth,owner,asyncRoute(async(req,res)=>{await exportPapers.saveOrigin(database,req.ctx,req.body);req.flash('success','Dispatch fields confirmed.');res.redirect(303,'/autopilot/export-papers?'+new URLSearchParams({origin:req.body.locationId})+'#dispatch');}));
  router.get('/autopilot/export-papers/:id/file',requireAuth,owner,asyncRoute(async(req,res)=>{const file=await exportPapers.download(database,req.ctx,req.params.id);res.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="'+file.filename+'"','Cache-Control':'private, no-store'});res.send(file.content);}));
  router.get('/autopilot/export-papers/:id',requireAuth,owner,asyncRoute((req,res)=>exportPage(req,res,req.params.id)));
  router.post('/autopilot/export-papers/:id/review',requireAuth,owner,asyncRoute(async(req,res)=>{await exportPapers.review(database,req.ctx,req.params.id,req.body);req.flash('success','Packet facts reviewed. No customs filing or shipment was made.');res.redirect(303,'/autopilot/export-papers/'+req.params.id);}));
  router.post('/autopilot/export-papers/:id/stop',requireAuth,owner,asyncRoute(async(req,res)=>{await exportPapers.stop(database,req.ctx,req.params.id,req.body);req.flash('success','Draft stopped. Its original saved copy is retained.');res.redirect(303,'/autopilot/export-papers/'+req.params.id);}));
  const inbound=require('../../purchasing/agent-inbound-freight');
  const inboundPath=inbound.path;
  const inboundPage=async(req,res,issuedLink=null)=>res.set('Cache-Control','private, no-store').page('autopilot/inbound-freight',{
    title:'Inbound ocean and air freight',nav:'autopilot',issuedLink,
    backTo:{href:req.params.id?inboundPath:'/autopilot/reviews',label:req.params.id?'Inbound freight':'Agent reviews'},
    ...await inbound.page(database,req.ctx,req.params.id)});
  router.get(inboundPath,requireAuth,owner,asyncRoute((req,res)=>inboundPage(req,res)));
  router.get(inboundPath+'/:id',requireAuth,owner,asyncRoute((req,res)=>inboundPage(req,res)));
  router.post(inboundPath,requireAuth,owner,asyncRoute(async(req,res)=>{
    const shipment=await inbound.create(database,req.ctx,req.body);
    res.redirect(303,inboundPath+'/'+shipment.id);
  }));
  router.post(inboundPath+'/:id/link',requireAuth,owner,asyncRoute(async(req,res)=>{
    const issued=await inbound.issueLink(database,req.ctx,req.params.id,req.body);
    return inboundPage(req,res,issued);
  }));
  for(const [step,method] of [['revoke','stopLink'],['routine','configure'],['review','reviewUpdate'],['deposit','saveDeposit']]){
    router.post(inboundPath+'/:id/'+step,requireAuth,owner,asyncRoute(async(req,res)=>{
      await inbound[method](database,req.ctx,req.params.id,req.body);
      res.redirect(303,inboundPath+'/'+req.params.id);
    }));
  }
  const carrierClaims=require('../../shipping/agent-carrier-claims');
  const claimPath=carrierClaims.path;
  const carrierClaimPage=async(req,res)=>res.set('Cache-Control','private, no-store').page('autopilot/carrier-claims',{
    title:'Carrier claims',nav:'autopilot',backTo:{href:req.params.id?claimPath:'/autopilot/reviews',label:req.params.id?'Carrier claims':'Agent reviews'},
    ...await carrierClaims.page(database,req.ctx,req.params.id,req.query.parcel)});
  router.get(claimPath,requireAuth,owner,asyncRoute(carrierClaimPage));
  router.get(claimPath+'/:id',requireAuth,owner,asyncRoute(carrierClaimPage));
  router.get(claimPath+'/:id/evidence/:field',requireAuth,owner,asyncRoute(async(req,res)=>{
    const file=await carrierClaims.original(database,req.ctx,req.params.id,req.params.field);
    res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Type':'application/octet-stream',
      'Content-Disposition':'attachment; filename="'+file.filename+'"'}).send(file.content);
  }));
  router.post(claimPath,requireAuth,owner,require('../multipart').multipart({limit:3*carrierClaims.limit+32768,maxFiles:3}),asyncRoute(async(req,res)=>{
    let selected;
    try{selected=JSON.parse(req.body.parcelKey);}catch{throw new ValidationError('Choose the exact shipment and tracking number.');}
    if(!Array.isArray(selected)||selected.length!==2||selected.some(value=>typeof value!=='string'))throw new ValidationError('Choose the exact shipment and tracking number.');
    const result=await carrierClaims.prepare(database,req.ctx,{...req.body,shipmentId:selected[0],trackingNumber:selected[1]},req.files);
    res.redirect(303,claimPath+'/'+result.id);
  }));
  for(const [step,method] of [['file','approve'],['rule','saveRule'],['check','verify']]){
    router.post(claimPath+'/:id/'+step,requireAuth,owner,asyncRoute(async(req,res)=>{
      if(method==='verify')await carrierClaims.verify(database,req.ctx,req.params.id);
      else await carrierClaims[method](database,req.ctx,req.params.id,req.body);
      res.redirect(303,claimPath+'/'+req.params.id);
    }));
  }
  const freightPickups=require('../../shipping/agent-freight-pickups');
  const freightPath=freightPickups.path;
  const freightPage=async(req,res)=>res.set('Cache-Control','private, no-store').page('autopilot/freight-pickups',{
    title:'Pallet freight pickups',nav:'autopilot',backTo:{href:req.params.id?freightPath:'/autopilot/reviews',label:req.params.id?'Freight pickups':'Agent reviews'},
    ...await freightPickups.page(database,req.ctx,{id:req.params.id,shipmentId:req.query.shipment,connectorId:req.query.connection})});
  router.get(freightPath,requireAuth,owner,asyncRoute(freightPage));
  router.get(freightPath+'/:id',requireAuth,owner,asyncRoute(freightPage));
  router.post(freightPath,requireAuth,owner,asyncRoute(async(req,res)=>{
    const quoted=await freightPickups.prepare(database,req.ctx,req.body);
    res.redirect(303,freightPath+'/'+quoted.id);
  }));
  for(const [step,method] of [['book','book'],['rule','saveRule'],['check','verify']]){
    router.post(freightPath+'/:id/'+step,requireAuth,owner,asyncRoute(async(req,res)=>{
      await freightPickups[method](database,req.ctx,req.params.id,req.body);
      res.redirect(303,freightPath+'/'+req.params.id);
    }));
  }
  const slack=require('../../connections/agent-slack');
  const direct=require('../../purchasing/agent-direct-shipments');
  const deliveryChecks=require('../../purchasing/agent-delivery-comparisons');
  const deliveryCheckPage=async(req,res)=>res.set('Cache-Control','private, no-store').page('autopilot/delivery-checks',{
    title:'Compare an actual supplier delivery',nav:'autopilot',backTo:{href:req.params.id?deliveryChecks.path:'/autopilot/reviews',
      label:req.params.id?'Delivery comparisons':'Agent reviews'},
    ...await deliveryChecks.page(database,req.ctx,{...req.query,id:req.params.id})});
  router.get('/autopilot/reviews/delivery-check',requireAuth,owner,(_req,res)=>res.redirect(303,deliveryChecks.path));
  router.get(deliveryChecks.path,requireAuth,owner,asyncRoute(deliveryCheckPage));
  router.get(deliveryChecks.path+'/:id',requireAuth,owner,asyncRoute(deliveryCheckPage));
  router.post(deliveryChecks.path,requireAuth,owner,asyncRoute(async(req,res)=>{
    const saved=await deliveryChecks.save(database,req.ctx,deliveryChecks.fromForm(req.body));
    res.redirect(303,deliveryChecks.path+'/'+saved.id);
  }));
  const directPage=async(req,res)=>res.set('Cache-Control','private, no-store').page('autopilot/direct-shipments',{
    title:'Supplier-direct deliveries',nav:'autopilot',backTo:{href:req.params.id?direct.path:'/autopilot/reviews',label:req.params.id?'Direct deliveries':'Agent reviews'},
    ...await direct.page(database,req.ctx,{...req.query,id:req.params.id})});
  router.get(direct.path,requireAuth,owner,asyncRoute(directPage));
  router.get(direct.path+'/:id',requireAuth,owner,asyncRoute(directPage));
  router.post(direct.path,requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await direct.prepare(database,req.ctx,direct.fromForm(req.body));
    res.redirect(303,direct.path+'/'+result.id);
  }));
  for(const step of ['approve','place','stop','capture'])router.post(direct.path+'/:id/'+step,requireAuth,owner,asyncRoute(async(req,res)=>{
    await direct[step](database,req.ctx,req.params.id,step==='capture'?direct.fromForm(req.body):req.body);
    res.redirect(303,direct.path+'/'+req.params.id);
  }));
  router.post(direct.path+'/:id/dispatch/:dispatch/approve',requireAuth,owner,asyncRoute(async(req,res)=>{
    const selected=await direct.page(database,req.ctx,{id:req.params.id});
    if(!selected.dispatches.some(dispatch=>dispatch.id===req.params.dispatch))throw new ValidationError('Choose a dispatch belonging to this direct purchase.');
    await direct.applyDispatch(database,req.ctx,req.params.dispatch,req.body);
    res.redirect(303,direct.path+'/'+req.params.id);
  }));
  router.post(direct.path+'/:id/send',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../purchasing/direct-shipment-mail').send(database,req.ctx,req.params.id,req.body);
    req.flash('success','The exact supplier purchase is queued. Its sent status follows the mailbox provider’s confirmation.');
    res.redirect(303,direct.path+'/'+req.params.id);
  }));
  router.post(direct.path+'/:id/routine',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../purchasing/direct-shipment-routines').configure(database,req.ctx,req.params.id,req.body);
    res.redirect(303,direct.path+'/'+req.params.id);
  }));
  const slackPage=async(req,res,issuedCode=null)=>{
    const data=await slack.page(database,req.ctx);
    const origin=require('../../config').connections.publicOrigin;
    const requestPath=data.owner&&data.connection?slack.publicPath+'/'+data.connection.endpoint_id:null;
    return res.set('Cache-Control','private, no-store').page('autopilot/slack',{title:'Ask StockChief in Slack',nav:'autopilot',issuedCode,
      requestUrl:origin&&requestPath?new URL(requestPath,origin).href:requestPath,...data});
  };
  router.get(slack.path,requireAuth,asyncRoute((req,res)=>slackPage(req,res)));
  router.post(slack.path+'/connection',requireAuth,owner,asyncRoute(async(req,res)=>{
    await slack.configure(database,req.ctx,req.body);
    res.redirect(303,slack.path);
  }));
  router.post(slack.path+'/code',requireAuth,asyncRoute(async(req,res)=>slackPage(req,res,await slack.code(database,req.ctx))));
  router.post(slack.path+'/unlink',requireAuth,asyncRoute(async(req,res)=>{
    await slack.unlink(database,req.ctx);
    res.redirect(303,slack.path);
  }));
  const vanRoutes=require('../../shipping/agent-van-routes');
  const vanPath=vanRoutes.path;
  const vansPage=async(req,res)=>res.set('Cache-Control','private, no-store').page('autopilot/van-routes',{
    title:'Own-van delivery routes',nav:'autopilot',backTo:{href:req.params.id?vanPath:'/autopilot/reviews',label:req.params.id?'Van routes':'Agent reviews'},
    ...await vanRoutes.page(database,req.ctx,{id:req.params.id,depotId:req.query.depot})});
  router.get(vanPath,requireAuth,owner,asyncRoute(vansPage));
  router.get(vanPath+'/:id',requireAuth,owner,asyncRoute(vansPage));
  router.post(vanPath,requireAuth,owner,asyncRoute(async(req,res)=>{
    const run=await vanRoutes.prepare(database,req.ctx,req.body);
    res.redirect(303,vanPath+'/'+run.id);
  }));
  for(const step of ['approve','configure','stop']){
    router.post(vanPath+'/:id/'+step,requireAuth,owner,asyncRoute(async(req,res)=>{
      await vanRoutes[step](database,req.ctx,req.params.id,req.body);
      res.redirect(303,vanPath+'/'+req.params.id);
    }));
  }
  const annual=require('../../operations/agent-annual-stocktakes');
  const annualPage=async(req,res,id=null)=>res.page('autopilot/annual-stocktakes',{title:'Annual stocktakes',nav:'autopilot',backTo:{href:id?'/autopilot/annual-stocktakes':'/autopilot/reviews',label:id?'Annual stocktakes':'Agent reviews'},...await annual.page(database,req.ctx,{...req.query,id})});
  const daily=require('../../operations/agent-daily-cycle-counts'),dailyPath='/autopilot/daily-cycle-counts';
  async function dailyPage(req,res,id=null){
    const view={title:'Daily cycle-count plans',nav:'autopilot',backTo:{href:'/autopilot/reviews/count-priorities',label:'Count priorities'}};
    try {
      const model=await daily.page(database,req.ctx,{warehouseId:req.query.warehouseId,id});
      return res.page('autopilot/daily-cycle-counts',{...view,model,stockValue:daily.displayValue});
    } catch(error) {
      if(error.code!=='entitlement_required'||!req.accepts('html'))throw error;
      const state=await policy.accountState(database,req.ctx.workspaceId);
      return res.page('autopilot/agent-plan-locked',{...view,tier:'Growth',
        reviewTerms:policy.permits(state.plan,4,'draft')&&!policy.usesAgentTerms(state),
        backTo:{href:'/autopilot/reviews',label:'Agent reviews'}});
    }
  }
  router.get(dailyPath,requireAuth,owner,asyncRoute((req,res)=>dailyPage(req,res)));
  router.get(dailyPath+'/:id',requireAuth,owner,asyncRoute((req,res)=>dailyPage(req,res,req.params.id)));
  router.post(dailyPath+'/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await daily.prepare(database,req.ctx,req.body);
    req.flash('success',result.replayed?'Opened the existing daily plan.':'Prepared the current daily count draft.');
    return res.redirect(303,dailyPath+'/'+result.id);
  }));
  router.post(dailyPath+'/:id/confirm',requireAuth,owner,asyncRoute(async(req,res)=>{
    await daily.confirm(database,req.ctx,req.params.id,req.body);
    req.flash('success','Daily count plan confirmed.');
    return res.redirect(303,dailyPath+'/'+req.params.id);
  }));
  router.post(dailyPath+'/rule',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await daily.configure(database,req.ctx,req.body);
    req.flash('success',result.removed?'Stopped automatic daily cycle-count planning.':'Saved the automatic daily plan limit.');
    return res.redirect(303,dailyPath+'?warehouseId='+encodeURIComponent(req.body.warehouseId));
  }));
  router.get('/autopilot/annual-stocktakes',requireAuth,owner,asyncRoute((req,res)=>annualPage(req,res)));
  router.get('/autopilot/annual-stocktakes/:id',requireAuth,owner,asyncRoute((req,res)=>annualPage(req,res,req.params.id)));
  router.post('/autopilot/annual-stocktakes',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await annual.create(database,req.ctx,req.body);req.flash('success','Count plan prepared. Review its exact scope and teams before freezing stock.');res.redirect(303,'/autopilot/annual-stocktakes/'+r.id);}));
  const annualRuns=require('../../operations/agent-annual-stocktake-runs');
  router.post('/autopilot/annual-stocktakes/rule',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await annualRuns.configure(database,req.ctx,req.body);req.flash('success',r.removed?'Yearly stocktake rule removed. Stocktakes already planned stay as they are.':'Yearly stocktake rule saved.');res.redirect(303,'/autopilot/annual-stocktakes');}));
  for(const [path,method,message]of [['recount','requestRecount','Recount sent. A second counter gets a blind list of these positions.'],['approve','approve','Differences approved. They post to stock and the books, then the freeze lifts.']])router.post('/autopilot/annual-stocktakes/:id/'+path,requireAuth,owner,asyncRoute(async(req,res)=>{await annualRuns[method](database,req.ctx,req.params.id,req.body);req.flash('success',message);res.redirect(303,'/autopilot/annual-stocktakes/'+req.params.id);}));
  for(const [path,method,message]of [['freeze','freeze','Stock locations frozen. The assigned blind count lists are ready.'],['recheck','recheck','The rechecked worksheet is ready for a new individual owner approval.'],['reassign','reassign','Remaining physical counts reassigned. Earlier counts keep their original counter.'],['signoff','signoff','Stocktake signed off. Its stock freeze has been released.'],['stop','stop','Stocktake stopped and freeze released. Completed adjustments remain posted.']])router.post('/autopilot/annual-stocktakes/:id/'+path,requireAuth,owner,asyncRoute(async(req,res)=>{await annual[method](database,req.ctx,req.params.id,req.body);req.flash('success',message);res.redirect(303,'/autopilot/annual-stocktakes/'+req.params.id);}));
  const buffers=require('../../connections/agent-channel-buffers');
  const bufferPage=async(req,res,input={})=>res.page('autopilot/channel-buffers',{title:'Channel stock buffers',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'},...await buffers.page(database,req.ctx,{...req.query,...input})});
  router.get('/autopilot/channel-buffers',requireAuth,owner,asyncRoute((req,res)=>bufferPage(req,res,{positionId:req.query.position})));
  router.get('/autopilot/channel-buffer-reviews/:id',requireAuth,owner,asyncRoute((req,res)=>bufferPage(req,res,{reviewId:req.params.id})));
  router.post('/autopilot/channel-buffers/batch',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await buffers.configureBatch(database,req.ctx,req.body);req.flash('success','Saved '+r.changed+' of '+r.count+' exact product buffers together. Identical settings share one saved-rule slot.');res.redirect(303,'/autopilot/channel-buffers');}));
  router.post('/autopilot/channel-buffers/:id/settings',requireAuth,owner,asyncRoute(async(req,res)=>{await buffers.configure(database,req.ctx,req.params.id,req.body);req.flash('success',req.body.stop==='yes'?'Buffer removed. Ordinary channel synchronization may publish more units.':'Channel buffer saved. Every provider update rechecks current stock, plan and authority.');res.redirect(303,'/autopilot/channel-buffers?'+new URLSearchParams({position:req.params.id}));}));
  router.post('/autopilot/channel-buffer-rules/:id/review',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await buffers.prepareReview(database,req.ctx,req.params.id);res.redirect(303,'/autopilot/channel-buffer-reviews/'+r.id);}));
  router.post('/autopilot/channel-buffer-reviews/:id/publish',requireAuth,owner,asyncRoute(async(req,res)=>{const result=await buffers.publish(database,req.ctx,req.params.id,req.body);req.flash('success',result.alreadyMatches?'The channel already reports this exact buffered quantity. No provider write was needed.':'The exact buffered sellable quantity is queued for verified channel delivery. Physical stock is unchanged.');res.redirect(303,'/autopilot/channel-buffer-reviews/'+req.params.id);}));
  const rfqs=require('../../purchasing/agent-supplier-rfqs');
  const rfqPage=async(req,res,id=null)=>res.page('autopilot/supplier-rfqs',{title:'Supplier quote requests',nav:'autopilot',backTo:{href:id?'/autopilot/supplier-rfqs':'/autopilot/reviews',label:id?'Supplier RFQs':'Agent reviews'},...await rfqs.page(database,req.ctx,{...req.query,id})});
  router.get('/autopilot/supplier-rfqs',requireAuth,owner,asyncRoute((req,res)=>rfqPage(req,res)));
  router.get('/autopilot/supplier-rfqs/:id',requireAuth,owner,asyncRoute((req,res)=>rfqPage(req,res,req.params.id)));
  router.post('/autopilot/supplier-rfqs/preview',requireAuth,owner,asyncRoute(async(req,res)=>{const p=await rfqs.preview(database,req.ctx,await rfqs.fromForm(database,req.ctx,req.body));res.redirect(303,'/autopilot/supplier-rfqs/'+p.id);}));
  router.post('/autopilot/supplier-rfqs/:id/send',requireAuth,owner,asyncRoute(async(req,res)=>{await rfqs.send(database,req.ctx,req.params.id,req.body);req.flash('success','The exact RFQ emails are queued separately. No purchase was placed.');res.redirect(303,'/autopilot/supplier-rfqs/'+req.params.id);}));
  router.post('/autopilot/supplier-rfqs/:id/authority',requireAuth,owner,asyncRoute(async(req,res)=>{await rfqs.configure(database,req.ctx,req.params.id,req.body);req.flash('success','Saved this exact bounded RFQ authority.');res.redirect(303,'/autopilot/supplier-rfqs/'+req.params.id);}));
  router.post('/autopilot/supplier-rfqs/:id/routine',requireAuth,owner,asyncRoute(async(req,res)=>{await rfqs.sendAutomatic(database,req.ctx,req.params.id,req.body.ruleId);req.flash('success','RFQs within the existing rule are queued. Each send rechecks current authority.');res.redirect(303,'/autopilot/supplier-rfqs/'+req.params.id);}));
  router.post('/autopilot/supplier-rfq-rules/:id/stop',requireAuth,owner,asyncRoute(async(req,res)=>{await rfqs.configure(database,req.ctx,null,{...req.body,stop:'yes',ruleId:req.params.id});res.redirect(303,'/autopilot/supplier-rfqs');}));
  const quality=require('../../operations/agent-quality-holds');
  const qualityPhotos=require('../../operations/quality-photos'),claims=require('../../purchasing/agent-supplier-claims');
  const claimPage=async(req,res,id=null)=>res.page('autopilot/supplier-claims',{title:'Supplier delivery claims',nav:'autopilot',backTo:{href:id?'/autopilot/supplier-claims':'/autopilot/reviews',label:id?'Supplier claims':'Agent reviews'},...await claims.page(database,req.ctx,{id})});
  router.get('/autopilot/supplier-claims',requireAuth,owner,asyncRoute((req,res)=>claimPage(req,res)));
  router.get('/autopilot/supplier-claims/:id',requireAuth,owner,asyncRoute((req,res)=>claimPage(req,res,req.params.id)));
  router.post('/autopilot/supplier-claims/preview',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await claims.preview(database,req.ctx,req.body);res.redirect(303,'/autopilot/supplier-claims/'+r.id);}));
  router.post('/autopilot/supplier-claims/:id/send',requireAuth,owner,asyncRoute(async(req,res)=>{await claims.send(database,req.ctx,req.params.id,req.body);req.flash('success','The reviewed supplier claim is queued for delivery. Check its mailbox status on this page.');res.redirect(303,'/autopilot/supplier-claims/'+req.params.id);}));
  router.post('/autopilot/supplier-claims/:id/authority',requireAuth,owner,asyncRoute(async(req,res)=>{await claims.configure(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/supplier-claims/'+req.params.id);}));
  router.post('/autopilot/supplier-claims/:id/routine',requireAuth,owner,asyncRoute(async(req,res)=>{await claims.sendAutomatic(database,req.ctx,req.params.id,req.body.ruleId);res.redirect(303,'/autopilot/supplier-claims/'+req.params.id);}));
  router.post('/autopilot/supplier-claim-rules/:id/stop',requireAuth,owner,asyncRoute(async(req,res)=>{await claims.configure(database,req.ctx,null,{...req.body,ruleId:req.params.id,stop:'yes'});res.redirect(303,'/autopilot/supplier-claims');}));
  router.post('/autopilot/delivery-quality/:id/photos',requireAuth,asyncRoute(async(req,res)=>{if(req.files?.length!==1||req.files[0].field!=='photo')throw new ValidationError('Choose one delivery photograph.');await qualityPhotos.upload(database,req.ctx,req.params.id,req.files[0],req.body);req.flash('success','Original photo preserved. A smaller copy is ready for a separately authorized claim.');res.redirect(303,'/autopilot/delivery-quality/'+req.params.id);}));
  router.get('/autopilot/quality-photos/:id',requireAuth,asyncRoute(async(req,res)=>{const p=await qualityPhotos.load(database,req.ctx,req.params.id,{email:req.query.copy==='email'});res.set('Cache-Control','private, no-store').set('X-Content-Type-Options','nosniff').attachment(p.downloadName).type(p.contentType).send(p.bytes);}));
  router.get('/autopilot/delivery-quality',requireAuth,asyncRoute(async(req,res)=>res.page('autopilot/delivery-quality',{title:'Delivery quality checks',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'},...await quality.page(database,req.ctx,req.query)})));
  router.get('/autopilot/delivery-quality/:id',requireAuth,asyncRoute(async(req,res)=>res.page('autopilot/delivery-quality',{title:'Inspect received goods',nav:'autopilot',backTo:{href:'/autopilot/delivery-quality',label:'Delivery quality'},...await quality.page(database,req.ctx,{id:req.params.id})})));
  router.post('/autopilot/delivery-quality-rules',requireAuth,owner,asyncRoute(async(req,res)=>{await quality.save(database,req.ctx,req.body);req.flash('success',req.body.mode==='automatic'?'QC rule saved. Matching deliveries are held on their own when StockChief may act.':'QC rule saved. StockChief suggests a hold for each matching delivery.');res.redirect(303,'/autopilot/delivery-quality');}));
  router.post('/autopilot/delivery-quality-rules/:id/settings',requireAuth,owner,asyncRoute(async(req,res)=>{await quality.configure(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/delivery-quality');}));
  router.post('/autopilot/delivery-quality/:id/inspect',requireAuth,asyncRoute(async(req,res)=>{const r=await quality.inspect(database,req.ctx,req.params.id,req.body);req.flash('success',r.released?(r.byRule?'Inspection passed. Your QC rule released these units.':'Inspection passed. You released these units.'):'Inspection failed. The goods stay held.');res.redirect(303,'/autopilot/delivery-quality/'+req.params.id);}));
  router.post('/autopilot/delivery-quality/:id/decide',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await quality.decide(database,req.ctx,req.params.id,req.body);req.flash('success',r.status==='HELD'?'These goods are now on QC hold.':'These goods were not held.');res.redirect(303,'/autopilot/delivery-quality/'+req.params.id);}));
  router.post('/autopilot/delivery-quality/:id/write-off',requireAuth,owner,asyncRoute(async(req,res)=>{await quality.writeOff(database,req.ctx,req.params.id,req.body);req.flash('success','Failed goods written off. Stock and its value were reduced.');res.redirect(303,'/autopilot/delivery-quality/'+req.params.id);}));
  router.post('/autopilot/delivery-quality/:id/release',requireAuth,asyncRoute(async(req,res)=>{await quality.release(database,req.ctx,req.params.id,req.body);req.flash('success','Released the inspected units once.');res.redirect(303,'/autopilot/delivery-quality/'+req.params.id);}));
  const promotionStock=require('../../purchasing/agent-promotion-stock');
  router.get('/autopilot/promotion-stock',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/promotion-stock-start',{title:'Promotion stock planning',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'}},async()=>({...await promotionStock.list(database,req.ctx,req.query),draft:null}))));
  router.post('/autopilot/promotion-stock/preview',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/promotion-stock-start',{title:'Review promotion stock plan',nav:'autopilot',backTo:{href:'/autopilot/promotion-stock',label:'Promotion plans'}},async()=>({...await promotionStock.list(database,req.ctx),draft:await promotionStock.preview(database,req.ctx,req.body)}))));
  router.post('/autopilot/promotion-stock',requireAuth,owner,asyncRoute(async(req,res)=>{const p=await promotionStock.save(database,req.ctx,req.body);res.redirect(303,'/autopilot/promotion-stock/'+p.promotionId);}));
  router.get('/autopilot/promotion-stock/:id',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/promotion-stock',{title:'Promotion stock plan',nav:'autopilot',backTo:{href:'/autopilot/promotion-stock',label:'Promotion plans'}},()=>promotionStock.page(database,req.ctx,req.params.id))));
  router.post('/autopilot/promotion-stock/:id/settings',requireAuth,owner,asyncRoute(async(req,res)=>{await promotionStock.configure(database,req.ctx,req.params.id,req.body);res.redirect(303,req.body.stop==='yes'?'/autopilot/promotion-stock':'/autopilot/promotion-stock/'+req.params.id);}));
  router.post('/autopilot/promotion-stock-plans/:id/purchase',requireAuth,owner,asyncRoute(async(req,res)=>{const po=await promotionStock.purchase(database,req.ctx,req.params.id,req.body);res.redirect(303,'/purchasing/orders/'+po.purchaseOrderId);}));
  const shutdowns=require('../../purchasing/agent-supplier-shutdowns');
  router.get('/autopilot/supplier-shutdowns',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/supplier-shutdown-start',{title:'Supplier shutdown planning',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'}},async()=>({...await shutdowns.list(database,req.ctx,req.query),draft:null}))));
  router.post('/autopilot/supplier-shutdowns/preview',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/supplier-shutdown-start',{title:'Review shutdown stock suggestion',nav:'autopilot',backTo:{href:'/autopilot/supplier-shutdowns',label:'Supplier shutdowns'}},async()=>({...await shutdowns.list(database,req.ctx),draft:await shutdowns.preview(database,req.ctx,req.body)}))));
  router.post('/autopilot/supplier-shutdowns',requireAuth,owner,asyncRoute(async(req,res)=>{const p=await shutdowns.save(database,req.ctx,req.body);res.redirect(303,'/autopilot/supplier-shutdowns/'+p.shutdownId);}));
  router.get('/autopilot/supplier-shutdowns/:id',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/supplier-shutdown',{title:'Supplier shutdown plan',nav:'autopilot',backTo:{href:'/autopilot/supplier-shutdowns',label:'Supplier shutdowns'}},()=>shutdowns.page(database,req.ctx,req.params.id))));
  router.post('/autopilot/supplier-shutdowns/:id/settings',requireAuth,owner,asyncRoute(async(req,res)=>{await shutdowns.configure(database,req.ctx,req.params.id,req.body);res.redirect(303,req.body.stop==='yes'?'/autopilot/supplier-shutdowns':'/autopilot/supplier-shutdowns/'+req.params.id);}));
  router.post('/autopilot/shutdown-plans/:id/purchase',requireAuth,owner,asyncRoute(async(req,res)=>{const po=await shutdowns.purchase(database,req.ctx,req.params.id,req.body);res.redirect(303,'/purchasing/orders/'+po.purchaseOrderId);}));
  const retirements=require('../../catalog/agent-product-retirements');
  router.get('/autopilot/discontinued-products',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/product-retirement-start',{title:'Discontinued products',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'}},async()=>({...await retirements.list(database,req.ctx,req.query),draft:null}))));
  router.post('/autopilot/discontinued-products/preview',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/product-retirement-start',{title:'Review discontinued products',nav:'autopilot',backTo:{href:'/autopilot/discontinued-products',label:'Discontinued products'}},async()=>({...await retirements.list(database,req.ctx,req.body),draft:await retirements.preview(database,req.ctx,req.body)}))));
  router.post('/autopilot/discontinued-products',requireAuth,owner,asyncRoute(async(req,res)=>{const n=await retirements.record(database,req.ctx,req.body);res.redirect(303,'/autopilot/discontinued-products/'+n.id);}));
  router.get('/autopilot/discontinued-products/:id',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/product-retirement',{title:'Review discontinued products',nav:'autopilot',backTo:{href:'/autopilot/discontinued-products',label:'Discontinued products'}},()=>retirements.page(database,req.ctx,req.params.id))));
  router.post('/autopilot/discontinued-products/:id/apply',requireAuth,owner,asyncRoute(async(req,res)=>{await retirements.apply(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/discontinued-products/'+req.params.id);}));
  router.post('/autopilot/discontinued-products/suppliers/:supplierId/settings',requireAuth,owner,asyncRoute(async(req,res)=>{await retirements.configure(database,req.ctx,req.params.supplierId,req.body);res.redirect(303,'/autopilot/discontinued-products');}));
  const procedures=require('../../autopilot/team-procedures');
  router.get('/autopilot/team-procedures',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/team-procedure-start',{title:'Team procedures',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'}},async()=>({...await procedures.list(database,req.ctx,{page:req.query.page||1}),draft:null}))));
  router.post('/autopilot/team-procedures/preview',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/team-procedure-start',{title:'Review procedure draft',nav:'autopilot',backTo:{href:'/autopilot/team-procedures',label:'Team procedures'}},async()=>({...await procedures.list(database,req.ctx),draft:await procedures.preview(database,req.ctx,req.body)}))));
  router.post('/autopilot/team-procedures',requireAuth,owner,asyncRoute(async(req,res)=>{const p=await procedures.save(database,req.ctx,req.body);res.redirect(303,'/autopilot/team-procedures/'+p.procedureId);}));
  router.get('/autopilot/team-procedures/:id',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/team-procedure',{title:'Team procedure',nav:'autopilot',backTo:{href:'/autopilot/team-procedures',label:'Team procedures'}},async()=>({...await procedures.page(database,req.ctx,req.params.id),requestKey:newId('procedure-publication-request')}))));
  router.post('/autopilot/team-procedures/:id/settings',requireAuth,owner,asyncRoute(async(req,res)=>{await procedures.configure(database,req.ctx,req.params.id,req.body);res.redirect(303,req.body.stop==='yes'?'/autopilot/team-procedures':'/autopilot/team-procedures/'+req.params.id);}));
  router.post('/autopilot/team-procedures/:id/publish',requireAuth,owner,asyncRoute(async(req,res)=>{await procedures.publish(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/team-procedures/'+req.params.id);}));
  router.post('/autopilot/team-procedures/:id/unpublish',requireAuth,owner,asyncRoute(async(req,res)=>{await procedures.unpublish(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/team-procedures');}));
  router.get('/team-procedures/:id',requireAuth,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/team-procedure-published',{title:'Approved team procedure',nav:'warehouse',backTo:{href:'/warehouse',label:'Warehouse'}},()=>procedures.published(database,req.ctx,req.params.id))));
  router.get('/team-procedures/:id/document.txt',requireAuth,asyncRoute(async(req,res)=>{const p=await procedures.published(database,req.ctx,req.params.id),doc=p.publication.approved_document;res.attachment('stockchief-team-procedure.txt').type('text/plain').send([doc.title,'Application procedure approved '+new Date(p.publication.approved_at).toISOString(),'',...doc.steps.map((step,i)=>(i+1)+'. '+step),'',doc.outcome,...doc.notes,...(doc.ownerNotes?['','Owner notes:',doc.ownerNotes]:[])].join('\n'));}));
  const containerPlans=require('../../purchasing/agent-container-plans');
  router.get('/autopilot/container-plans',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/container-plan-start',{title:'Container planning',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'}},async()=>({...await containerPlans.list(database,req.ctx,{page:req.query.page||1}),draft:null,requestKey:newId('container-request')}))));
  router.post('/autopilot/container-plans/prepare',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/container-plan-start',{title:'Confirm carton packing',nav:'autopilot',backTo:{href:'/autopilot/container-plans',label:'Container plans'}},async()=>({...await containerPlans.list(database,req.ctx),draft:await containerPlans.prepare(database,req.ctx,req.body),requestKey:req.body.requestKey||newId('container-request')}))));
  router.post('/autopilot/container-plans',requireAuth,owner,asyncRoute(async(req,res)=>{const p=await containerPlans.create(database,req.ctx,req.body);res.redirect(303,'/autopilot/container-plans/'+p.id);}));
  router.get('/autopilot/container-plans/:id',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/container-plan',{title:'Container load plan',nav:'autopilot',backTo:{href:'/autopilot/container-plans',label:'Container plans'}},()=>containerPlans.page(database,req.ctx,req.params.id))));
  router.post('/autopilot/container-plans/:id/recalculate',requireAuth,owner,asyncRoute(async(req,res)=>{await containerPlans.rebuild(database,req.ctx,req.params.id);res.redirect(303,'/autopilot/container-plans/'+req.params.id);}));
  router.post('/autopilot/container-plans/:id/settings',requireAuth,owner,asyncRoute(async(req,res)=>{await containerPlans.configure(database,req.ctx,req.params.id,req.body);res.redirect(303,req.body.stop==='yes'?'/autopilot/container-plans':'/autopilot/container-plans/'+req.params.id);}));
  router.post('/autopilot/container-plans/:id/teach',requireAuth,owner,asyncRoute(async(req,res)=>{await containerPlans.teach(database,req.ctx,req.params.id,req.body);res.redirect(303,req.body.remove==='yes'?'/autopilot/container-plans':'/autopilot/container-plans/'+req.params.id);}));
  router.post('/autopilot/container-runs/:id/review',requireAuth,owner,asyncRoute(async(req,res)=>{const result=await containerPlans.review(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/container-plans/'+result.projectId);}));
  router.get('/autopilot/container-runs/:id/manifest.csv',requireAuth,owner,asyncRoute(async(req,res)=>{const result=await containerPlans.manifest(database,req.ctx,req.params.id);res.attachment('stockchief-container-plan.csv').type('text/csv').send(String.fromCharCode(0xfeff)+result.csv);}));
  const containerOrders=require('../../purchasing/agent-container-orders');
  const containerOrderPage=async(req,res,id=null)=>res.page('autopilot/container-orders',{title:'Fill a container',nav:'autopilot',backTo:{href:'/autopilot/reviews/container-plans',label:'Container planning'},...await containerOrders.screen(database,req.ctx,{id})});
  router.get('/autopilot/container-orders',requireAuth,owner,asyncRoute((req,res)=>containerOrderPage(req,res)));
  router.get('/autopilot/container-orders/:id',requireAuth,owner,asyncRoute((req,res)=>containerOrderPage(req,res,req.params.id)));
  router.post('/autopilot/container-orders',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await containerOrders.save(database,req.ctx,req.body);req.flash('success',req.body.stop==='yes'?'Routine container ordering stopped.':'Container rule saved.');res.redirect(303,'/autopilot/container-orders/'+r.id);}));
  router.post('/autopilot/container-orders/:id/draft',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await containerOrders.prepare(database,req.ctx,req.params.id,req.body);req.flash('success','Container order '+(r.poNumber||'')+' drafted. Approve the PO to order it.');res.redirect(303,'/autopilot/container-orders/'+req.params.id);}));
  for(const [path,method,message] of [['teach','teach','Taught. StockChief now orders this container on its own within your limits.'],['undo','undo','Container order undone. The PO is cancelled and nothing was sent.']])router.post('/autopilot/container-orders/orders/:orderId/'+path,requireAuth,owner,asyncRoute(async(req,res)=>{const r=await containerOrders[method](database,req.ctx,req.params.orderId,req.body);req.flash('success',message);res.redirect(303,'/autopilot/container-orders/'+r.id);}));
  const poDates=require('../../purchasing/agent-po-delivery-dates');
  router.get('/autopilot/po-delivery-dates/:id',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/po-delivery-date',{title:'Review supplier delivery date',nav:'autopilot',backTo:{href:'/autopilot/reviews/po-delivery-dates',label:'Supplier delivery dates'}},()=>poDates.page(database,req.ctx,req.params.id,{settingsPage:req.query.settingsPage||1}))));
  router.post('/autopilot/po-delivery-dates/:id',requireAuth,owner,asyncRoute(async(req,res)=>{await poDates.apply(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/po-delivery-dates/'+req.params.id);}));
  router.post('/autopilot/po-delivery-dates/:id/settings',requireAuth,owner,asyncRoute(async(req,res)=>{await poDates.configure(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/po-delivery-dates/'+req.params.id);}));
  router.post('/autopilot/po-delivery-dates/:id/teach',requireAuth,owner,asyncRoute(async(req,res)=>{await poDates.teach(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/po-delivery-dates/'+req.params.id);}));
  router.post('/autopilot/po-delivery-date-settings/:id/stop',requireAuth,owner,asyncRoute(async(req,res)=>{await poDates.configure(database,req.ctx,null,{...req.body,settingId:req.params.id,stop:'yes'});res.redirect(303,'/autopilot/reviews/po-delivery-dates');}));
  router.post('/autopilot/po-delivery-date-rules/remove',requireAuth,owner,asyncRoute(async(req,res)=>{await poDates.teach(database,req.ctx,null,{...req.body,remove:'yes'});res.redirect(303,'/autopilot/reviews/po-delivery-dates');}));
  const supplierBenefits=require('../../purchasing/agent-supplier-benefits');
  router.get('/autopilot/supplier-benefits',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/supplier-benefits',{title:'Supplier rebates and volume discounts',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'}},()=>supplierBenefits.page(database,req.ctx,{q:req.query.q,after:req.query.after}))));
  router.post('/autopilot/supplier-benefits/estimate',requireAuth,owner,asyncRoute(async(req,res)=>{
    const input=await supplierBenefits.resolveCodes(database,req.ctx,req.body),result=await supplierBenefits.estimate(database,req.ctx,input);
    res.page('autopilot/supplier-benefits',{title:'Supplier benefit estimate',nav:'autopilot',backTo:{href:'/autopilot/supplier-benefits',label:'Supplier benefits'},...await supplierBenefits.page(database,req.ctx,{input: req.body,result})});
  }));
  router.post('/autopilot/supplier-benefits',requireAuth,owner,asyncRoute(async(req,res)=>{
    const input=await supplierBenefits.resolveCodes(database,req.ctx,req.body),saved=await supplierBenefits.configure(database,req.ctx,input);res.redirect(303,'/autopilot/supplier-benefits/'+saved.id);
  }));
  router.post('/autopilot/supplier-benefits/:id/stop',requireAuth,owner,asyncRoute(async(req,res)=>{
    await supplierBenefits.configure(database,req.ctx,{...req.body,id:req.params.id,stop:'yes'});res.redirect(303,'/autopilot/supplier-benefits');
  }));
  router.post('/autopilot/supplier-benefits/:id/resume',requireAuth,owner,asyncRoute(async(req,res)=>{
    await supplierBenefits.configure(database,req.ctx,{...req.body,id:req.params.id,resume:'yes'});res.redirect(303,'/autopilot/supplier-benefits/'+req.params.id);
  }));
  router.get('/autopilot/supplier-benefits/:id',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/supplier-benefits',{title:'Review supplier benefit agreement',nav:'autopilot',backTo:{href:'/autopilot/supplier-benefits',label:'Supplier benefits'}},()=>supplierBenefits.page(database,req.ctx,{id:req.params.id,evidencePage:req.query.evidencePage||1,edit:req.query.edit==='1'}))));
  router.post('/autopilot/supplier-benefits/:id/edit',requireAuth,owner,asyncRoute(async(req,res)=>{
    const input=await supplierBenefits.resolveCodes(database,req.ctx,req.body);await supplierBenefits.configure(database,req.ctx,{...input,id:req.params.id});res.redirect(303,'/autopilot/supplier-benefits/'+req.params.id);
  }));
  router.post('/autopilot/supplier-benefits/:id/scope',requireAuth,owner,asyncRoute(async(req,res)=>{
    await supplierBenefits.refreshScope(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/supplier-benefits/'+req.params.id);
  }));
  router.post('/autopilot/supplier-benefits/:id/claims',requireAuth,owner,asyncRoute(async(req,res)=>{
    await supplierBenefits.recordClaim(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/supplier-benefits/'+req.params.id);
  }));
  router.post('/autopilot/supplier-benefits/:id/claims/:claimId',requireAuth,owner,asyncRoute(async(req,res)=>{
    await supplierBenefits.updateClaim(database,req.ctx,req.params.id,req.params.claimId,req.body);res.redirect(303,'/autopilot/supplier-benefits/'+req.params.id);
  }));
  router.get('/autopilot/supplier-forecasts',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/supplier-forecast',{title:'Supplier stock forecast',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'}},()=>require('../../purchasing/agent-supplier-forecasts').page(database,req.ctx,{q:req.query.q}))));
  router.post('/autopilot/supplier-forecasts/preview',requireAuth,owner,asyncRoute(async(req,res)=>{
    const forecasts=require('../../purchasing/agent-supplier-forecasts'),skuIds=await forecasts.resolveCodes(database,req.ctx.workspaceId,req.body.codes);
    const saved=await forecasts.preview(database,req.ctx,{supplierId:req.body.supplierId,connectorId:req.body.connectorId,skuIds,requestKey:req.body.requestKey});res.redirect(303,'/autopilot/supplier-forecasts/'+saved.id);
  }));
  router.get('/autopilot/supplier-forecasts/:id',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/supplier-forecast',{title:'Review supplier forecast',nav:'autopilot',backTo:{href:'/autopilot/supplier-forecasts',label:'Supplier forecasts'}},()=>require('../../purchasing/agent-supplier-forecasts').page(database,req.ctx,{id:req.params.id}))));
  router.post('/autopilot/supplier-forecasts/:id/send',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../purchasing/agent-supplier-forecasts').send(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/supplier-forecasts/'+req.params.id);
  }));
  router.post('/autopilot/supplier-forecasts/:id/schedule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../purchasing/agent-supplier-forecasts').configure(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/supplier-forecasts/'+req.params.id);
  }));
  router.post('/autopilot/supplier-forecast-rules/:id/stop',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../purchasing/agent-supplier-forecasts').configure(database,req.ctx,null,{...req.body,ruleId:req.params.id,stop:'yes'});res.redirect(303,'/autopilot/supplier-forecasts');
  }));
  router.post('/autopilot/return-labels/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await assistant.prepareAction(database,req.ctx,'Send this purchased return label and its authorized instructions',{action:'customer_return.send_label',recordReference:req.body.returnReference,mailbox:req.body.connectorId});
    if(!prepared.proposal?.id)throw new ValidationError(prepared.answer||'Choose the exact authorized return and connected sending mailbox.');res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/customer-statements/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await assistant.prepareAction(database,req.ctx,'Prepare this requested customer account statement',{action:'customer.statement',recordReference:req.body.customerReference,mailbox:req.body.connectorId,currency:req.body.currency||undefined});
    if(!prepared.proposal?.id)throw new ValidationError(prepared.answer||'Choose the exact customer, currency and connected sending mailbox.');res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  const disputeFlow=require('../../purchasing/invoice-dispute-follow-through');
  router.get('/autopilot/supplier-disputes/:id',requireAuth,owner,asyncRoute(async(req,res)=>res.page('autopilot/supplier-dispute-detail',{
    title:'Supplier invoice dispute',nav:'autopilot',backTo:{href:'/autopilot/reviews/supplier-invoice-disputes',label:'Supplier invoice disputes'},
    ...await disputeFlow.page(database,req.ctx,req.params.id,req.query),money:require('../../domain/currency'),
  })));
  router.post('/autopilot/supplier-disputes/source/:id',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await disputeFlow.prepare(database,req.ctx,req.params.id,req.body);
    res.redirect(303,'/autopilot/supplier-disputes/'+encodeURIComponent(result.billId));
  }));
  router.post('/autopilot/supplier-disputes/:id/resolve',requireAuth,owner,asyncRoute(async(req,res)=>{
    await disputeFlow.resolve(database,req.ctx,req.params.id,req.body);
    req.flash('success','Corrected invoice posted. The disputed original is retained.');
    res.redirect(303,'/autopilot/supplier-disputes/'+encodeURIComponent(req.params.id));
  }));
  router.post('/autopilot/supplier-disputes/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await assistant.prepareAction(database,req.ctx,'Ask the supplier to review this invoice difference',{action:'supplier_invoice.dispute',recordReference:req.body.billNumber,mailbox:req.body.connectorId});
    if(!prepared.proposal?.id)throw new ValidationError(prepared.answer||'Choose the exact disputed supplier bill and sending mailbox.');res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/stock-ready/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await assistant.prepareAction(database,req.ctx,'Prepare a stock-ready update for this waiting customer',{action:'sales_order.notify_stock_ready',recordReference:req.body.orderNumber,mailbox:req.body.connectorId});
    if(!prepared.proposal?.id)throw new ValidationError(prepared.answer||'Choose an exact previously backordered order that is now fully reserved.');
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/stock-ready/settings',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../sales/agent-stock-ready').configure(database,req.ctx,req.body);res.redirect(303,'/autopilot/reviews/stock-ready-updates');
  }));
  router.post('/autopilot/arrived-stock/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await assistant.prepareAction(database,req.ctx,'Reserve arrived stock for the selected confirmed backorder',{action:'sales_order.reserve_arrived',recordReference:req.body.orderNumber});
    if(!prepared.proposal?.id)throw new ValidationError(prepared.answer||'Choose the exact current backorder before preparing its reservation.');
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/invoice-reminders/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await assistant.prepareAction(database,req.ctx,'Prepare the selected customer invoice reminder',{action:'customer_invoice.remind',recordReference:req.body.invoiceNumber,mailbox:req.body.connectorId});
    if(!prepared.proposal?.id)throw new ValidationError(prepared.answer||'Choose the exact current invoice before preparing its reminder.');
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/invoice-reminders/schedule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../accounting/agent-invoice-reminders').configure(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/reviews/invoice-reminders');
  }));
  router.post('/autopilot/customer-payments/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await assistant.prepareAction(database,req.ctx,'Match the selected recorded bank credit to its issued invoice',{action:'customer_payment.match_bank_line',recordReference:req.body.invoiceNumber,bankTransaction:req.body.bankTransaction});
    if(!prepared.proposal?.id)throw new ValidationError(prepared.answer||'Review the current bank credit and invoice before preparing a match.');
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  const discovery=require('../../documents/agent-document-discovery');
  const filingPath='/autopilot/document-filing';
  const discoveryPage=async(req,res)=>res.set('Cache-Control','no-store').page('autopilot/document-discovery',{
    title:'Discover and file originals',nav:'autopilot',screen:await discovery.screen(database,req.ctx,{...req.query,id:req.params.id||null})});
  router.get(filingPath,requireAuth,owner,asyncRoute(discoveryPage));
  router.post(filingPath,requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await discovery.enqueue(database,req.ctx,{...req.body,buffer:req.file?.buffer,filename:req.file?.filename});
    res.redirect(303,filingPath+'/'+result.id);
  }));
  router.post(filingPath+'/scope',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../documents/document-filing-scopes').configure(database,req.ctx,req.body);
    res.redirect(303,filingPath);
  }));
  router.get(filingPath+'/:id/original',requireAuth,owner,asyncRoute(async(req,res)=>{
    const source=await discovery.load(database,req.ctx,req.params.id);
    res.set('Cache-Control','no-store').type('application/octet-stream').attachment(source.filename).send(source.content);
  }));
  router.get(filingPath+'/:id',requireAuth,owner,asyncRoute(discoveryPage));
  for(const [operation,run] of [['approve',discovery.approve],['retry',discovery.retry],['dismiss',discovery.dismiss]]){
    router.post(filingPath+'/:id/'+operation,requireAuth,owner,asyncRoute(async(req,res)=>{
      await run(database,req.ctx,req.params.id,req.body);
      res.redirect(303,filingPath+'/'+req.params.id);
    }));
  }
  const shippingOriginals=require('../../documents/agent-shipping-document-reader');
  const shippingOriginalPage=async(req,res)=>res.page('autopilot/shipping-document-reading',{title:'Bills of lading and customs papers',nav:'autopilot',
    screen:await shippingOriginals.screen(database,req.ctx,{...req.query,id:req.params.id||null}),shippingProof:require('../../documents/shipping-document-proof')});
  router.get('/autopilot/shipping-documents',requireAuth,owner,asyncRoute(shippingOriginalPage));
  router.post('/autopilot/shipping-documents',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await shippingOriginals.enqueue(database,req.ctx,{...req.body,buffer:req.file?.buffer,filename:req.file?.filename});
    res.redirect(303,'/autopilot/shipping-documents/'+result.id);
  }));
  router.get('/autopilot/shipping-documents/:id/original',requireAuth,owner,asyncRoute(async(req,res)=>{
    const source=await shippingOriginals.load(database,req.ctx,req.params.id);
    res.set('Cache-Control','no-store').type('application/octet-stream').attachment(source.filename).send(source.content);
  }));
  router.get('/autopilot/shipping-documents/:id',requireAuth,owner,asyncRoute(shippingOriginalPage));
  for(const [operation,run] of [['approve',shippingOriginals.approve],['retry',shippingOriginals.retry],['dismiss',shippingOriginals.dismiss]]){
    router.post('/autopilot/shipping-documents/:id/'+operation,requireAuth,owner,asyncRoute(async(req,res)=>{
      await run(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/shipping-documents/'+req.params.id);
    }));
  }
  router.get('/autopilot/documents',requireAuth,owner,asyncRoute(async(req,res)=>{
    const filing=require('../../documents/agent-filing'),scoped=Boolean(req.query.kind||req.query.record);
    const documents=await (scoped?filing.forRecord(database,req.ctx,req.query.kind,req.query.record,req.query.after):filing.directory(database,req.ctx,req.query.after));
    const filingEnabled=discovery.available(await require('../../commercial/agent-plan').accountState(database,req.ctx.workspaceId));
    res.page('autopilot/record-documents',{title:'Documents · '+documents.reference,nav:'autopilot',documents,filingEnabled,documentQuery:scoped?new URLSearchParams({kind:req.query.kind,record:req.query.record}).toString():'',backTo:{href:documents.targetHref,label:scoped?documents.reference:'Inventory'}});
  }));
  router.get('/autopilot/documents/:id/download',requireAuth,owner,asyncRoute(async(req,res)=>{
    const document=await require('../../documents/agent-filing').load(database,req.ctx,req.params.id);
    res.type('application/octet-stream').attachment(document.filename).send(document.content);
  }));
  router.get('/autopilot/documents/:id',requireAuth,owner,asyncRoute(async(req,res)=>{
    const document=await require('../../documents/agent-filing').load(database,req.ctx,req.params.id);
    res.page('autopilot/filed-document',{title:'Filed document',nav:'autopilot',document,documentFactLabels:require('../../documents/agent-product-facts').labels,backTo:{href:document.targetHref,label:document.target_reference}});
  }));
  const productSources=require('../../documents/agent-product-source');
  router.get('/autopilot/product-facts',requireAuth,owner,asyncRoute(async(req,res)=>res.page('autopilot/product-source',{title:'Product source readings',nav:'autopilot',screen:await productSources.screen(database,req.ctx,{itemId:req.query.itemId||null,page:req.query.page||1}),initial:{productReference:req.query.product||'',filedDocument:req.query.filedDocument||''}})));
  router.post('/autopilot/product-facts',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await productSources.enqueue(database,req.ctx,{...req.body,buffer:req.file?.buffer,filename:req.file?.filename});res.redirect(303,'/autopilot/product-facts/'+r.id);}));
  router.get('/autopilot/product-facts/:id/original',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await productSources.load(database,req.ctx,req.params.id);res.set('Cache-Control','no-store').type('application/octet-stream').attachment(r.filename).send(r.content);}));
  router.get('/autopilot/product-facts/:id/facts.csv',requireAuth,owner,asyncRoute(async(req,res)=>{res.set({'Cache-Control':'no-store','Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="sourced-product-facts.csv"'}).send(await productSources.csv(database,req.ctx,req.params.id));}));
  router.get('/autopilot/product-facts/:id',requireAuth,owner,asyncRoute(async(req,res)=>res.page('autopilot/product-source',{title:'Product source facts',nav:'autopilot',screen:await productSources.screen(database,req.ctx,{id:req.params.id}),initial:{}})));
  router.post('/autopilot/product-facts/:id/approve',requireAuth,owner,asyncRoute(async(req,res)=>{await productSources.approve(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/product-facts/'+req.params.id);}));
  router.post('/autopilot/product-facts/:id/acknowledge',requireAuth,owner,asyncRoute(async(req,res)=>{await productSources.acknowledge(database,req.ctx,req.params.id);res.redirect(303,'/autopilot/product-facts/'+req.params.id);}));
  router.post('/autopilot/product-facts/:id/retry',requireAuth,owner,asyncRoute(async(req,res)=>{const r=await productSources.load(database,req.ctx,req.params.id);const next=await productSources.enqueue(database,req.ctx,{itemId:r.item_id,buffer:r.content,filename:r.filename,fileAttachment:r.source_attachment_id,filedDocument:r.source_filed_id,documentKind:r.document_kind,targetConfirmed:r.target_confirmed,automatic:r.automatic,enrich:r.enrich});res.redirect(303,'/autopilot/product-facts/'+next.id);}));
  const jobModes=require('../../autopilot/job-modes');
  router.get('/autopilot/job-modes',requireAuth,owner,asyncRoute(async(req,res)=>{
    res.page('autopilot/job-modes',{title:'Authority by job',nav:'autopilot',jobs:await jobModes.page(database,req.ctx),modes:jobModes.modes});
  }));
  router.post('/autopilot/job-modes/:id',requireAuth,owner,asyncRoute(async(req,res)=>{
    await jobModes.save(database,req.ctx,req.params.id,req.body);
    res.redirect(303,'/autopilot/job-modes#job-'+Number(req.params.id));
  }));
  router.post('/autopilot/recurring-orders',requireAuth,owner,asyncRoute(async(req,res)=>{
    const recurring=require('../../sales/recurring-orders');
    if(req.body.pause==='1')await recurring.pause(database,req.ctx,req.body.id,req.body.revision);
    else{
      let source={};
      if(req.body.sourceOrderId){
        source=(await database.query('SELECT customer_id AS "customerId",order_number AS "sourceOrderNumber" FROM sales_orders WHERE workspace_id=$1 AND id=$2',[req.ctx.workspaceId,req.body.sourceOrderId])).rows[0];
        if(!source)throw new (require('../../domain/errors').ValidationError)('Choose a confirmed customer order from this inventory.');
      }
      await recurring.configure(database,req.ctx,{...req.body,...source});
    }
    res.redirect(303,'/autopilot/reviews/recurring-customer-orders');
  }));
  router.post('/autopilot/map-terms',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../pricing/channel-price-review').save(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/reviews/channel-prices');
  }));
  router.post('/autopilot/undo/:id',requireAuth,owner,asyncRoute(async(req,res)=>{
    const day=String(req.body.day||'');if(day)require('../../lib/business-time').dayBoundary(day,'UTC');
    await require('../../autopilot/agent-work-digest').undo(database,req.ctx,req.params.id);
    res.redirect(303,'/autopilot/reviews/daily-work'+(day?'?'+new URLSearchParams({filter:day}):''));
  }));
  const requests=require('../../purchasing/agent-purchase-requests');
  const budgets=require('../../purchasing/agent-budgets');
  router.post('/actions/:id/draft-rule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../autopilot/draft-authority').save(database,req.ctx,req.params.id,req.body);
    res.redirect(303,'/actions/'+encodeURIComponent(req.params.id));
  }));
  const buying=require('../../purchasing/agent-order-quantities');
  router.get('/purchasing/freight/:id',requireAuth,owner,asyncRoute(async(req,res)=>{
    return agentPage(req,res,'autopilot/freight-terms',{title:'Supplier freight terms',nav:'purchasing'},
      async()=>({supplier:await buying.freightSettings(database,req.ctx,req.params.id)}));
  }));
  router.post('/purchasing/freight/:id',requireAuth,owner,asyncRoute(async(req,res)=>{
    await buying.saveFreight(database,req.ctx,{...req.body,supplierId:req.params.id});
    res.redirect(303,'/autopilot/reviews/supplier-minimums');
  }));
  router.get('/purchasing/budgets',requireAuth,owner,asyncRoute(async(req,res)=>{
    return agentPage(req,res,'autopilot/purchase-budgets',{title:'Purchase budgets',nav:'purchasing'},
      ()=>budgets.settings(database,req.ctx,req.query.month));
  }));
  router.post('/purchasing/budgets',requireAuth,owner,asyncRoute(async(req,res)=>{
    await budgets.save(database,req.ctx,req.body);
    res.redirect(303,'/purchasing/budgets?'+new URLSearchParams({month:req.body.month}));
  }));
  const monthlyBuying=require('../../purchasing/agent-open-to-buy');
  const buyingPage=async(req,res)=>agentPage(req,res,'autopilot/open-to-buy',{title:'Monthly open-to-buy',nav:'purchasing',
    backTo:{href:'/autopilot/reviews',label:'Agent reviews'}},async()=>({
    model:await monthlyBuying.page(database,req.ctx,{id:req.params.id,month:req.query.month,after:req.query.after}),
    backTo:{href:'/autopilot/reviews/open-to-buy',label:'Open-to-buy headroom'},
  }));
  router.get(monthlyBuying.path,requireAuth,owner,asyncRoute(buyingPage));
  router.post(monthlyBuying.path,requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await monthlyBuying.prepare(database,req.ctx,req.body);
    res.redirect(303,monthlyBuying.path+'/'+result.id);
  }));
  router.post(monthlyBuying.path+'/routine',requireAuth,owner,asyncRoute(async(req,res)=>{
    await monthlyBuying.configure(database,req.ctx,req.body);
    res.redirect(303,monthlyBuying.path);
  }));
  router.get(monthlyBuying.path+'/:id',requireAuth,owner,asyncRoute(buyingPage));
  router.post(monthlyBuying.path+'/:id/drafts',requireAuth,owner,asyncRoute(async(req,res)=>{
    await monthlyBuying.prepareDrafts(database,req.ctx,req.params.id,req.body);
    res.redirect(303,monthlyBuying.path+'/'+req.params.id);
  }));
  const slotting=require('../../forecasting/warehouse-slotting');
  const slottingPage=async(req,res)=>agentPage(req,res,'autopilot/warehouse-slotting',{title:'Warehouse move lists',nav:'autopilot',
    backTo:{href:'/autopilot/reviews/warehouse-slotting',label:'Warehouse bin moves'}},async()=>({
    model:await slotting.page(database,req.ctx,{id:req.params.id,warehouseId:req.query.warehouse,after:req.query.after}),
  }),402);
  const slotWarehouse=(res,id)=>res.redirect(303,slotting.path+'?'+new URLSearchParams({warehouse:id}));
  router.get(slotting.path,requireAuth,owner,asyncRoute(slottingPage));
  router.post(slotting.path,requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await slotting.prepare(database,req.ctx,req.body);
    res.redirect(303,slotting.path+'/'+result.id);
  }));
  router.get(slotting.path+'/routine',requireAuth,owner,asyncRoute(async(req,res)=>{
    const model=await slotting.schedulePage(database,req.ctx);
    res.page('autopilot/warehouse-slotting',{title:'Routine re-slots',nav:'autopilot',model:{...model,scheduleOnly:true}});
  }));
  router.post(slotting.path+'/routine',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await slotting.configure(database,req.ctx,req.body);
    req.flash('success',result.stopped?'Routine re-slots stopped.':'Routine re-slots saved.');
    if(result.stopped)return res.redirect(303,slotting.path+'/routine');
    return slotWarehouse(res,req.body.warehouseId);
  }));
  router.post(slotting.path+'/distance',requireAuth,owner,asyncRoute(async(req,res)=>{
    const bin=await slotting.saveDistance(database,req.ctx,req.body);
    req.flash('success','Walking distance saved.');
    return slotWarehouse(res,bin.warehouse_id);
  }));
  router.post(slotting.path+'/capacity',requireAuth,owner,asyncRoute(async(req,res)=>{
    const bin=await slotting.saveCapacity(database,req.ctx,req.body);
    req.flash('success',req.body.remove==='yes'?'Bin fit removed.':'Bin fit saved.');
    return slotWarehouse(res,bin.warehouse_id);
  }));
  router.get(slotting.path+'/:id',requireAuth,owner,asyncRoute(slottingPage));
  router.post(slotting.path+'/:id/approve',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await slotting.approve(database,req.ctx,req.params.id,req.body);
    req.flash(result.held?'error':'success',result.held
      ?result.approved+' approved. '+result.held+' need a fresh look; the reason is shown on each move.'
      :result.approved===1?'Move approved. Staff can pick it from Transfers.':result.approved+' moves approved. Staff can pick them from Transfers.');
    res.redirect(303,slotting.path+'/'+req.params.id);
  }));
  router.post(slotting.path+'/:id/undo',requireAuth,owner,asyncRoute(async(req,res)=>{
    await slotting.undo(database,req.ctx,req.params.id,req.body);
    req.flash('success','Move undone. The stock is free again.');
    res.redirect(303,slotting.path+'/'+req.params.id);
  }));
  // A locked destination remains a useful page. The underlying services still
  // enforce the plan on every read and mutation; only the HTML presentation changes.
  async function agentPage(req,res,view,locals,load,lockedStatus=200){
    try{return res.page(view,{...locals,...(await load())});}
    catch(error){if(error.code!=='entitlement_required'||req.accepts(['html','json'])==='json')throw error;
      res.status(lockedStatus);
      return res.page('autopilot/locked',{...locals,message:error.message});}
  }
  const lots=require('../../autopilot/lot-controls');
  const edi=require('../../connections/postgres-orderful-test');
  router.get('/autopilot/orderful',requireAuth,owner,asyncRoute(async(req,res)=>{
    res.page('autopilot/orderful',{title:'Orderful retail test',nav:'autopilot',...(await edi.dashboard(database,req.ctx))});
  }));
  router.post('/autopilot/orderful/connect',requireAuth,owner,asyncRoute(async(req,res)=>{
    await edi.connect(database,req.ctx,req.body);res.redirect(303,'/autopilot/orderful');
  }));
  router.post('/autopilot/orderful/disconnect',requireAuth,owner,asyncRoute(async(req,res)=>{
    await edi.disconnect(database,req.ctx);res.redirect(303,'/autopilot/orderful');
  }));
  router.post('/autopilot/orderful/rule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await edi.configure(database,req.ctx,req.body.action);res.redirect(303,'/autopilot/orderful');
  }));
  router.post('/autopilot/orderful/receive',requireAuth,owner,asyncRoute(async(req,res)=>{
    await edi.receive(database,req.ctx,req.body.transactionId);res.redirect(303,'/autopilot/orderful');
  }));
  router.post('/autopilot/orderful/:source/:kind/:record/send',requireAuth,owner,asyncRoute(async(req,res)=>{
    await edi.send(database,req.ctx,req.params.source,req.params.kind,req.params.record);res.redirect(303,'/autopilot/orderful');
  }));
  router.post('/autopilot/orderful/:source/:kind/:record/reconcile',requireAuth,owner,asyncRoute(async(req,res)=>{
    await edi.reconcile(database,req.ctx,req.params.source,req.params.kind,req.params.record,req.body.providerUuid);res.redirect(303,'/autopilot/orderful');
  }));
  const shipbob=require('../../connections/postgres-shipbob-sandbox');
  router.get('/autopilot/shipbob',requireAuth,owner,asyncRoute(async(req,res)=>{
    const data=await shipbob.dashboard(database,req.ctx);
    const review=req.query.order?await shipbob.draft(database,req.ctx,req.query.order):null;
    res.page('autopilot/shipbob-sandbox',{title:'ShipBob sandbox',nav:'autopilot',...data,review});
  }));
  router.post('/autopilot/shipbob/connect',requireAuth,owner,asyncRoute(async(req,res)=>{
    await shipbob.connect(database,req.ctx,req.body);res.redirect(303,'/autopilot/shipbob');
  }));
  router.post('/autopilot/shipbob/disconnect',requireAuth,owner,asyncRoute(async(req,res)=>{
    await shipbob.disconnect(database,req.ctx);res.redirect(303,'/autopilot/shipbob');
  }));
  router.post('/autopilot/shipbob/rule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await shipbob.configureRule(database,req.ctx,req.body);res.redirect(303,'/autopilot/shipbob');
  }));
  router.post('/autopilot/shipbob/stock',requireAuth,owner,asyncRoute(async(req,res)=>{
    await shipbob.stock(database,req.ctx,req.body);res.redirect(303,'/autopilot/shipbob');
  }));
  router.post('/autopilot/shipbob/:order/send',requireAuth,owner,asyncRoute(async(req,res)=>{
    await shipbob.send(database,req.ctx,req.params.order,req.body.reviewHash);res.redirect(303,'/autopilot/shipbob');
  }));
  router.post('/autopilot/shipbob/:order/refresh',requireAuth,owner,asyncRoute(async(req,res)=>{
    await shipbob.refresh(database,req.ctx,req.params.order);res.redirect(303,'/autopilot/shipbob');
  }));
  const lotCertificates=require('../../autopilot/lot-certificate-evidence');
  const certificateCoverage=require('../../autopilot/lot-certificate-coverage');
  const lotCertificatePage=async(req,res)=>res.page('autopilot/lot-certificates',{title:'Lot certificate evidence',nav:'autopilot',
    screen:await certificateCoverage.screen(database,req.ctx,{...req.query,id:req.params.id||null})});
  router.get('/autopilot/lot-certificates',requireAuth,owner,asyncRoute(lotCertificatePage));
  router.post('/autopilot/lot-certificates',requireAuth,owner,asyncRoute(async(req,res)=>{
    const result=await lotCertificates.prepare(database,req.ctx,{...req.body,buffer:req.file?.buffer,filename:req.file?.filename});
    res.redirect(303,'/autopilot/lot-certificates/'+result.id);
  }));
  router.get('/autopilot/lot-certificates/source/:sourceId',requireAuth,owner,asyncRoute(async(req,res)=>{
    const source=await lotCertificates.load(database,req.ctx,req.params.sourceId);
    res.set('Cache-Control','no-store').type('application/octet-stream').attachment(source.filename).send(source.content);
  }));
  router.post('/autopilot/lot-certificates/source/:sourceId/dismiss',requireAuth,owner,asyncRoute(async(req,res)=>{
    await lotCertificates.dismiss(database,req.ctx,req.params.sourceId);res.redirect(303,'/autopilot/lot-certificates');
  }));
  router.post('/autopilot/lot-certificates/requirement',requireAuth,owner,asyncRoute(async(req,res)=>{
    await lotCertificates.requirement(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/lots?'+new URLSearchParams({sku:req.body.sku,lot:req.body.lot}));
  }));
  router.post('/autopilot/lot-certificates/scope',requireAuth,owner,asyncRoute(async(req,res)=>{
    await lotCertificates.configure(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/lot-certificates'+(req.body.sku&&req.body.lot?'?'+new URLSearchParams({sku:req.body.sku,lot:req.body.lot}):''));
  }));
  router.get('/autopilot/lot-certificates/:id',requireAuth,owner,asyncRoute(lotCertificatePage));
  for(const [operation,run] of [['approve',lotCertificates.approve],['revoke',lotCertificates.revoke]]){
    router.post('/autopilot/lot-certificates/:id/'+operation,requireAuth,owner,asyncRoute(async(req,res)=>{
      await run(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/lot-certificates/'+req.params.id);
    }));
  }
  router.get('/autopilot/lots',requireAuth,owner,asyncRoute(async(req,res)=>{
    const detail=req.query.lot||req.query.sku?await lots.details(database,req.ctx,req.query):null;
    res.page('autopilot/lot-controls',{title:'Lot controls',nav:'autopilot',detail});
  }));
  for(const [path,action] of [['recall',lots.recall],['certificates',lots.certificate]]){
    router.post('/autopilot/lots/'+path,requireAuth,owner,asyncRoute(async(req,res)=>{
      await action(database,req.ctx,req.body);
      res.redirect(303,'/autopilot/lots?'+new URLSearchParams({sku:req.body.sku,lot:req.body.lot}));
    }));
  }
  router.get('/autopilot/reviews',requireAuth,owner,asyncRoute(async(req,res)=>{
    const state=await reviews.ownerState(database,req.ctx);
    let ediEnabled=true;
    try{await edi.access(database,req.ctx);}catch(error){if(error.code!=='entitlement_required')throw error;ediEnabled=false;}
    res.page('autopilot/reviews',{ediEnabled,title:'Agent reviews',nav:'autopilot',offers:reviews.offers(state),shipbobEnabled:policy.usesAgentTerms(state)&&policy.permits(state.plan,186,'draft')});
  }));
  const landedCosts=require('../../accounting/postgres-landed-costs');
  const customerCheckins=require('../../sales/agent-customer-checkins');
  const checkinPath=customerCheckins.path;
  router.get(checkinPath,requireAuth,owner,asyncRoute(async(req,res)=>{
    const page=Number(req.query.page||1);
    if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid results page.');
    return agentPage(req,res,'autopilot/customer-check-ins',{title:'Customer check-in drafts',nav:'autopilot'},
      ()=>customerCheckins.page(database,req.ctx,{customerId:req.query.customer,selectedId:req.query.draft,page}));
  }));
  router.post(checkinPath+'/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const p=await assistant.prepareAction(database,req.ctx,'Prepare this customer check-in.',{action:customerCheckins.ACTION,recordReference:req.body.customerId});
    if(!p.proposal?.id)throw new ValidationError(p.answer||'Review this exact customer and purchase evidence first.');
    return res.redirect(303,'/actions/'+p.proposal.id);
  }));
  router.post(checkinPath+'/routine',requireAuth,owner,asyncRoute(async(req,res)=>{
    await customerCheckins.configure(database,req.ctx,req.body);
    return res.redirect(303,checkinPath);
  }));
  const quoteFollowups=require('../../sales/agent-quote-followups');
  router.get('/autopilot/quote-followups/:id',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/quote-followup',{title:'Customer quote follow-up',nav:'autopilot'},()=>quoteFollowups.page(database,req.ctx,req.params.id),402)));
  router.post('/autopilot/quote-followups/:id/received',requireAuth,owner,asyncRoute(async(req,res)=>{await quoteFollowups.record(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/quote-followups/'+req.params.id);}));
  router.post('/autopilot/quote-followups/:id/schedule',requireAuth,owner,asyncRoute(async(req,res)=>{await quoteFollowups.configure(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/quote-followups/'+req.params.id);}));
  router.post('/autopilot/quote-followups/:id/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{const p=await assistant.prepareAction(database,req.ctx,'Follow up on this customer quotation',{action:'sales_quote.followup',recordReference:req.params.id,mailbox:req.body.connectorId});if(!p.proposal?.id)throw new ValidationError(p.answer||'Record that the customer received this quote and choose the sending mailbox.');res.redirect(303,'/actions/'+p.proposal.id);}));
  router.get('/autopilot/landed-costs/new',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/landed-cost-new',{title:'Allocate freight, duty and fees',nav:'autopilot'},()=>landedCosts.sources(database,req.ctx,req.query),402)));
  router.post('/autopilot/landed-costs',requireAuth,owner,asyncRoute(async(req,res)=>{const made=await landedCosts.prepareForm(database,req.ctx,req.body);res.redirect(303,'/autopilot/landed-costs/'+made.id);}));
  router.get('/autopilot/landed-costs/:id',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/landed-cost',{title:'Received-goods stock cost',nav:'autopilot'},()=>landedCosts.page(database,req.ctx,req.params.id),402)));
  router.post('/autopilot/landed-costs/:id/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{const p=await assistant.prepareAction(database,req.ctx,'Apply this received-goods cost allocation',{action:'landed_cost.apply',recordReference:req.params.id});if(p.status!=='PREPARED')throw new ValidationError('Review the current allocation document first.');res.redirect(303,'/actions/'+p.proposal.id);}));
  router.post('/autopilot/landed-costs/:id/discard',requireAuth,owner,asyncRoute(async(req,res)=>{await landedCosts.voidDraft(database,req.ctx,req.params.id);res.redirect(303,'/autopilot/reviews/landed-costs');}));
  router.post('/autopilot/landed-costs/:id/reverse',requireAuth,owner,asyncRoute(async(req,res)=>{await landedCosts.reverse(database,req.ctx,req.params.id,req.body);res.redirect(303,'/autopilot/landed-costs/'+req.params.id);}));
  router.post('/autopilot/putaway/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const made=await require('../../warehouse/agent-putaway').prepare(database,req.ctx,req.body.receiptLine,req.body.destination);
    res.redirect(303,'/warehouse/putaway/'+made.id);
  }));
  router.post('/autopilot/putaway/:id/rule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../warehouse/agent-putaway').teach(database,req.ctx,req.params.id,req.body);
    res.redirect(303,'/warehouse/putaway/'+req.params.id);
  }));
  router.post('/autopilot/pick-release/recheck',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../warehouse/agent-pick-release').recheck(database,req.ctx);res.redirect(303,'/autopilot/reviews/pick-release');
  }));
  router.post('/autopilot/pick-release/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await require('../../assistant/postgres-service').prepareAction(database,req.ctx,'Release the next ready orders at this warehouse',{action:'warehouse.release_orders',recordReference:req.body.order,quantity:req.body.quantity,strategy:req.body.strategy});
    if(prepared.status!=='PREPARED')throw new (require('../../domain/errors').ValidationError)(prepared.message||'Choose the first ready order at this warehouse.');
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/partner-stock-readings',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../connections/agent-partner-stock-reads').configure(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/reviews/third-party-stock');
  }));
  const abcPath=require('../../forecasting/monthly-product-classes').path;
  router.get(abcPath+'/products/:itemId',requireAuth,owner,starterAgentPage(15,'suggest','ABC count and safety planning',async(req,res)=>{
    return res.page('autopilot/monthly-abc-planning',{
      title:'ABC count and safety planning',nav:'autopilot',backTo:{href:abcPath,label:'Monthly ABC product classes'},
      model:await require('../../forecasting/agent-safety-stock').classPlanning(database,req.ctx,req.params.itemId,req.query),
    });
  }));
  router.get('/autopilot/reviews/:job',requireAuth,owner,asyncRoute(async(req,res)=>{
    return agentPage(req,res,'autopilot/review-result',{title:'Agent review',nav:'autopilot',backTo:{href:'/autopilot/reviews',label:'Agent reviews'}},async()=>{
      const result=await reviews.run(database,req.ctx,req.params.job,{filter:req.query.filter,page:req.query.page,change:req.query.change});
      const packs=require('../../accounting/agent-report-packs');
      if(Object.hasOwn(packs.downloads,req.params.job)&&(req.params.job!=='quarterly-supplier-pack'||result.rows.length)){
        result.download='/autopilot/reviews/'+req.params.job+'/download?'+new URLSearchParams({filter:req.query.filter||''});
        result.downloadLabel=packs.downloads[req.params.job].label;
      }
      if(req.params.job==='margin-prices'&&result.mode==='draft'){
        const pricePolicy=require('../../commercial/agent-plan');
        const state=await pricePolicy.accountState(database,req.ctx.workspaceId);
        result.pricePreparationHold=await pricePolicy.stopped(database,req.ctx.workspaceId,state,'catalog.restore_margin',false);
        result.reviewPrices=!result.pricePreparationHold;
      }
      if(req.params.job==='clearance-plan'&&result.mode!=='suggest')result.clearancePlanPath=require('../../pricing/agent-clearance-plans').path;
      if(req.params.job==='slow-stock'&&result.mode!=='suggest')result.slowStockPath=require('../../forecasting/agent-slow-stock-steps').path;
      if(req.params.job==='count-sources')result.countSourcePath=require('../../imports/physical-count-sources').path;
      if(req.params.job==='open-to-buy')result.openToBuyPath=monthlyBuying.path;
      if(req.params.job==='supplier-specifications')result.specForm=true;
      if(req.params.job==='warehouse-slotting')result.slottingPath=slotting.path;
      if(req.params.job==='repeat-loss')result.lossShifts=await require('../../autopilot/stock-loss-patterns').settings(database,req.ctx.workspaceId);
      if(req.params.job==='brand-watches')result.watches=await require('../../autopilot/brand-watches').list(database,req.ctx.workspaceId);
      if(req.params.job==='staff-count-lists')result.countAssignments={...await require('../../operations/agent-count-tasks').setup(database,req.ctx),requestKey:newId('count-assignment'),selectedLocationId:req.query.locationId};
      if(req.params.job==='vacation-deputy')result.vacation=await require('../../autopilot/vacation-deputy').setup(database,req.ctx);
      if(req.params.job==='purchase-approval-threshold'){
        const rule=await require('../../purchasing/dual-approval').setting(database,req.ctx.workspaceId);
        result.purchaseThreshold={...rule,amount:rule.amount_minor==null?'':require('../../domain/currency').fromMinor(rule.amount_minor,rule.currency)};
      }
      const watch=require('../../autopilot/activity-watches'),job=watch.definitions.find(d=>d.key===req.params.job);
      if(job&&[170,171].includes(job.id))result.watchSettings={job:job.id,...await watch.settings(database,req.ctx.workspaceId,job.id)};
      if(['combine-draft-orders','split-draft-orders'].includes(req.params.job))result.purchaseGrouping=req.params.job;
      if(req.params.job==='combine-draft-orders')result.freightCombine=await require('../../purchasing/agent-freight-combine').screen(database,req.ctx);
      if(req.params.job==='split-draft-orders')result.purchaseSplits=await require('../../purchasing/agent-purchase-splitting').screen(database,req.ctx);
      if(req.params.job==='overdue-customer-orders')result.overdueRule=await require('../../sales/agent-order-checks').rule(database,req.ctx.workspaceId);
      return {title:result.label,result,filter:req.query.filter||''};
    },402);
  }));
  router.post('/autopilot/alert-settings/:id',requireAuth,owner,asyncRoute(async(req,res)=>{
    const watch=require('../../autopilot/activity-watches'),id=Number(req.params.id);
    await watch.save(database,req.ctx,id,req.body);
    res.redirect(303,'/autopilot/reviews/'+watch.spec[id].key);
  }));
  router.post('/autopilot/vacation-deputy',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../autopilot/vacation-deputy').save(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/reviews/vacation-deputy');
  }));
  router.post('/autopilot/negotiation-draft',requireAuth,owner,asyncRoute(async(req,res)=>{
    const id=await require('../../purchasing/negotiation-drafts').prepare(database,req.ctx,req.body);
    res.redirect(303,'/messages/supplier/'+id);
  }));
  router.post('/autopilot/negotiation-rule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../purchasing/negotiation-drafts').configure(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/reviews/supplier-negotiation?'+new URLSearchParams({filter:req.body.supplier}));
  }));
  router.post('/autopilot/purchase-approval-threshold',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../purchasing/dual-approval').configure(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/reviews/purchase-approval-threshold');
  }));
  router.post('/autopilot/reviews/brand-watches/rules',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../autopilot/brand-watches').save(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/reviews/brand-watches');
  }));
  router.post('/autopilot/reviews/payment-run/approve',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../accounting/agent-cash-planning').approvePaymentRun(database,req.ctx,req.body);
    req.flash('success','Payment review recorded. Pay suppliers and record payments from their individual bills.');
    return res.redirect(303,'/autopilot/reviews/payment-run');
  }));
  router.get('/autopilot/reviews/:job/download',requireAuth,owner,asyncRoute(async(req,res)=>{
    const packs=require('../../accounting/agent-report-packs');
    const definition=packs.definitions.find(d=>d.key===req.params.job);
    if(!definition)throw new (require('../../domain/errors').NotFoundError)();
    await policy.requireWorkspaceJob(database,req.ctx.workspaceId,definition.id,'suggest');
    const report=await database.transaction(async c=>definition.readPage(c,req.ctx,{download:true,filter:req.query.filter,today:await require('../../lib/business-time').today(c,req.ctx.workspaceId)}),{isolation:'REPEATABLE READ'});
    const format=packs.downloads[definition.key],file=await format.render(report);
    res.set('Cache-Control','private, no-store').attachment(definition.key+'-'+report.span.closing+'.'+format.extension).send(file);
  }));
  router.post('/autopilot/reviews/repeat-loss/shifts',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../autopilot/stock-loss-patterns').save(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/reviews/repeat-loss');
  }));
  router.post('/autopilot/reviews/overdue-customer-orders/rule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../sales/agent-order-checks').configure(database,req.ctx,req.body.mode);
    res.redirect(303,'/autopilot/reviews/overdue-customer-orders');
  }));
  router.post('/autopilot/reviews/margin-prices/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await assistant.prepareAction(database,req.ctx,'Review the selling price after the cost increase',
      {action:'catalog.restore_margin',sku:req.body.sku});
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  const writeDown=require('../../accounting/agent-inventory-write-downs');
  const writeDownRoute=require('../../forecasting/agent-stock-age').route;
  router.get(writeDownRoute,requireAuth,owner,starterAgentPage(17,'draft','Review inventory write-down',async(req,res)=>{
    if(!req.query.position)return res.redirect(303,'/autopilot/reviews/stock-age');
    return res.page('autopilot/stock-write-down',{
      title:'Review inventory write-down',nav:'autopilot',
      backTo:{href:'/autopilot/reviews/stock-age',label:'Stock by age'},
      review:await writeDown.page(database,req.ctx,req.query.position),formKey:newId('stock-write-down')
    });
  },'Growth'));
  router.post(writeDownRoute,requireAuth,owner,asyncRoute(async(req,res)=>{
    if(req.body.confirmed!=='yes'||!req.body.expectedStockFingerprint)throw new ValidationError('Confirm the whole position and its valuation evidence before preparing the write-down.');
    const result=await assistant.prepareAction(database,req.ctx,'Prepare this stock write-down from the supported net recoverable value.',{
      action:writeDown.ACTION,recordReference:req.body.position,amount:req.body.amount,currency:req.body.currency,
      reference:req.body.reference,expectedStockFingerprint:req.body.expectedStockFingerprint
    });
    if(!result.proposal?.id)throw new ValidationError(result.answer||'Review the current stock and its valuation evidence.');
    return res.redirect(303,'/actions/'+result.proposal.id);
  }));
  router.post('/autopilot/reviews/stock-rotation/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const prepared=await assistant.prepareAction(database,req.ctx,'Review exact FIFO/FEFO reservations for this order',{action:'sales_order.reserve_rotation',recordReference:req.body.order,strategy:req.body.strategy,historicalFifoEvidence:req.body.historicalFifoEvidence});
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/stock-rotation/:order/release',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../warehouse/agent-stock-rotation').release(database,req.ctx,req.params.order);res.redirect(303,'/orders/'+req.params.order);
  }));
  router.post('/autopilot/reviews/:job/purchasing-prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    const actions={'reorder-drafts':'purchase_order.reorder_drafts','reorder-explanation':'purchase_order.reorder_drafts','supplier-options':'purchasing.select_supplier'};
    if(!Object.hasOwn(actions,req.params.job))throw new ValidationError('Choose a reorder or supplier review.');
    const prepared=await assistant.prepareAction(database,req.ctx,'Review current purchasing preparation',
      {action:actions[req.params.job],skuCodes:req.body.skuCodes,location:req.body.location,strategy:req.body.strategy,quantity:req.body.quantity,secondaryQuantities:req.body.secondaryQuantities,comparisonBasis:req.body.comparisonBasis,comparisonCurrency:req.body.comparisonCurrency,goodsOnlyReason:req.body.goodsOnlyReason});
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/reviews/combine-draft-orders/rule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../purchasing/agent-freight-combine').configure(database,req.ctx,req.body);
    req.flash('success',req.body.remove==='yes'?'Removed the freight-combining rule.':'Saved the freight-combining rule.');
    return res.redirect(303,'/autopilot/reviews/combine-draft-orders');
  }));
  const parseLineDates=value=>JSON.stringify(String(value||'').trim().split(/\r?\n/).map(line=>{
    const m=/^\s*(\d+)\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(line);
    if(!m)throw new ValidationError('Enter one line number and date per row, for example 1 2027-02-14.');
    return {line:Number(m[1]),date:m[2]};
  }));
  router.post('/autopilot/reviews/split-draft-orders/rule',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../purchasing/agent-purchase-splitting').configure(database,req.ctx,req.body);
    req.flash('success',req.body.remove==='yes'?'Removed the purchase split rule.':'Saved the purchase split rule.');
    return res.redirect(303,'/autopilot/reviews/split-draft-orders');
  }));
  router.post('/autopilot/reviews/split-draft-orders/dates',requireAuth,owner,asyncRoute(async(req,res)=>{
    await require('../../purchasing/agent-purchase-splitting').saveDates(database,req.ctx,{
      orderNumber:String(req.body.orderNumber||'').trim(),lineDates:parseLineDates(req.body.lineDates)
    });
    req.flash('success','Saved the requested delivery dates for the draft lines.');
    return res.redirect(303,'/autopilot/reviews/split-draft-orders');
  }));
  router.post('/autopilot/reviews/:job/regroup',requireAuth,owner,asyncRoute(async(req,res)=>{
    const actions={'combine-draft-orders':'purchase_order.combine_drafts','split-draft-orders':'purchase_order.split_draft'};
    if(!Object.hasOwn(actions,req.params.job))throw new ValidationError('Choose a purchase-order grouping.');
    const args={action:actions[req.params.job],sourceOrders:req.body.sourceOrders,splitStrategy:req.body.splitStrategy,budgetAmount:req.body.budgetAmount};
    if(args.splitStrategy==='delivery-date')args.lineDates=parseLineDates(req.body.lineDates);
    const prepared=await assistant.prepareAction(database,req.ctx,'Review replacement purchase orders',args);
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.post('/autopilot/reviews/supplier-specifications/prepare',requireAuth,owner,asyncRoute(async(req,res)=>{
    await policy.requireWorkspaceJob(database,req.ctx.workspaceId,129,'draft');
    const prepared=await require('../../assistant/postgres-service').prepareAction(database,req.ctx,'Review the supplier file product specifications',
      {action:'catalog.fill_supplier_specs',sourceImport:req.body.sourceImport,sourcePage:Number(req.body.sourcePage||1),sku:req.body.sku||undefined});
    res.redirect(303,'/actions/'+prepared.proposal.id);
  }));
  router.get('/purchasing/requests',requireAuth,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/purchase-requests',{
    title:'Staff purchase requests',nav:'purchasing',requestKey:newId('req')},()=>requests.page(database,req.ctx))));
  router.post('/purchasing/requests',requireAuth,asyncRoute(async(req,res)=>{
    await requests.submit(database,req.ctx,req.body);res.redirect(303,'/purchasing/requests');
  }));
  router.post('/purchasing/requests/:id/decision',requireAuth,owner,asyncRoute(async(req,res)=>{
    const po=await requests.decide(database,req.ctx,req.params.id,req.body);
    res.redirect(303,po?'/purchasing/orders/'+encodeURIComponent(po):'/purchasing/requests');
  }));
  const timeSaved=require('../../autopilot/time-saved');
  router.get('/autopilot/time-saved',requireAuth,owner,asyncRoute(async(req,res)=>agentPage(req,res,'autopilot/time-saved',{
    title:'Time saved',nav:'autopilot',backTo:{href:'/autopilot',label:'StockChief AI'},requestKey:newId('timing'),
    },()=>timeSaved.report(database,req.ctx,req.query.period))));
  router.post('/autopilot/time-saved',requireAuth,owner,asyncRoute(async(req,res)=>{
    await timeSaved.sample(database,req.ctx,req.body);
    res.redirect(303,'/autopilot/time-saved'+(req.body.period==='month'?'?period=month':''));
  }));
  router.get('/autopilot/playbooks',requireAuth,owner,asyncRoute(async(req,res)=>res.page('autopilot/playbooks',{
    title:'Playbooks',nav:'autopilot',backTo:{href:'/autopilot',label:'StockChief AI'},requestKey:newId('run'),
    ...(await playbooks.list(database,req.ctx))})));
  router.post('/autopilot/playbooks',requireAuth,owner,asyncRoute(async(req,res)=>{
    await playbooks.create(database,req.ctx,req.body);res.redirect(303,'/autopilot/playbooks');
  }));
  router.post('/autopilot/playbooks/:id/run',requireAuth,owner,asyncRoute(async(req,res)=>{
    await playbooks.run(database,req.ctx,req.params.id,req.body.requestKey);res.redirect(303,'/autopilot/playbooks');
  }));
  router.post('/autopilot/playbooks/:id/delete',requireAuth,owner,asyncRoute(async(req,res)=>{
    await playbooks.remove(database,req.ctx,req.params.id);res.redirect(303,'/autopilot/playbooks');
  }));
  router.get('/autopilot/progress',requireAuth,asyncRoute(async(req,res)=>res.json(
    await require('../../operations/postgres-maintenance-progress').read(database,req.ctx.workspaceId))));
  router.get('/autopilot',requireAuth,asyncRoute(async(req,res)=>res.page('autopilot/postgres-settings',{
    title:'What StockChief does',nav:'autopilot',backTo:{href:'/settings',label:'Settings'},
    ...(await autonomy.dashboard(database,req.ctx.workspaceId))})));
  router.get('/autopilot/daily',requireAuth,(req,res)=>res.redirect(302,'/needs-you'));
  router.get('/autopilot/history',requireAuth,asyncRoute(async(req,res)=>{const {recent,activityAfter,next}=await autonomy.workHistory(database,req.ctx.workspaceId,req.query.after);
    const groups={automatic:[],prepared:[],needsYou:[],blocked:[]};
    for(const item of recent){item.executionStatus=item.execution_status;item.approvalRequirement=item.approval_requirement;
      item.errorMessage=item.error_message;item.createdAt=item.created_at;item.completedAt=item.completed_at;
      if(item.executionStatus==='COMPLETED')groups[item.approvalRequirement==='NONE'?'automatic':'prepared'].push(item);
      else if(['FAILED','CANCELLED','REFUSED'].includes(item.executionStatus))groups.blocked.push(item);else groups.needsYou.push(item);}
    const describe=(item)=>{const action=item.recommendedAction||{};const subject=action.displayName||action.itemName||item.category||'business work';
      return {headline:item.executionStatus==='COMPLETED'?`Completed ${subject}`:`Review ${subject}`,
        detail:item.policyEvaluation?.reason||item.errorMessage||'The evidence and exact limits are recorded on this work item.'};};
    return res.page('autopilot/history',{title:"StockChief's work",nav:'autopilot',groups,operations:[],evaluations:[],describe,activityAfter,next});
  }));
  router.get('/autopilot/misses',requireAuth,asyncRoute(async(req,res)=>res.page('autopilot/postgres-misses',{
    title:'Report an Ask problem',nav:'ask',room:true,selectedInteraction:typeof req.query.interaction==='string'?req.query.interaction:null,interactions:await assistant.listInteractions(database,req.ctx.workspaceId,30)})));
  router.post('/autopilot/misses',requireAuth,asyncRoute(async(req,res)=>{
    const interactions=await assistant.listInteractions(database,req.ctx.workspaceId,100);
    const turn=interactions.find((entry)=>entry.id===req.body.interactionId);
    if(!turn)throw new Error('Choose a recent Ask StockChief response from this inventory.');
    await monitoring.raise(database,{workspaceId:req.ctx.workspaceId,severity:'WARNING',kind:'assistant.reported_miss',
      title:'Ask StockChief response reported by owner',detail:`Question: ${turn.message}\nAnswer: ${turn.answer}\nOwner note: ${String(req.body.note||'').trim()||'No note supplied.'}`,
      fingerprint:`assistant.reported_miss:${turn.id}`});
    req.flash('success','Problem recorded with the exact question and answer. StockChief did not learn a new rule silently.');
    return res.redirect(303,'/autopilot/misses');
  }));
  router.post('/autopilot/mode',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.setMode(database,req.ctx,req.user,req.body.mode);req.flash('success','StockChief authority was updated.');
    return res.redirect(303,'/autopilot');
  }));
  router.post('/autopilot/capability',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.setCapability(database,req.ctx,req.user,String(req.body.capability||''),req.body.granted==='1');
    req.flash('success',req.body.granted==='1'
      ?'That one job is authorised. No other authority changed.'
      :'That authority was removed immediately. No other authority changed.');
    return res.redirect(303,'/autopilot#jobs');
  }));
  router.post('/autopilot/routine-authority',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.configureRoutine(database,req.ctx,req.user,req.body);
    req.flash('success','Saved versioned routine-work authority. Anything outside these exact limits still asks first.');
    return res.redirect(303,'/autopilot');
  }));
  router.post('/autopilot/pause',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.pause(database,req.ctx,req.user,req.body.reason);req.flash('success','Automatic work is paused.');
    return res.redirect(303,req.body.returnToHome==='1'?'/':'/autopilot');
  }));
  router.post('/autopilot/resume',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.resume(database,req.ctx,req.user);req.flash('success','StockChief is watching again. Old work will not be replayed.');
    return res.redirect(303,req.body.returnToHome==='1'?'/':'/autopilot');
  }));
  router.post('/autopilot/run',requireAuth,requireCapability(database,'forecasting.basic'),asyncRoute(async(req,res)=>{
    await require('../../operations/postgres-maintenance-progress').request(database,req.ctx);
    req.flash('success','Business review queued. You can leave this page; completed batches are saved automatically.');
    return res.redirect(303,req.body.returnToHome==='1'?'/':'/autopilot');
  }));
  router.get('/autopilot/approval-email/:workspaceId/:workId',require('../middleware').requireAccount,asyncRoute(async(req,res)=>{
    const {workspaceId,workId}=req.params;
    const workspace=res.locals.workspaces.find(w=>w.workspaceId===workspaceId&&w.isOwner&&w.role==='owner');
    if(!workspace)throw new (require('../../domain/errors').NotFoundError)();
    await policy.requireWorkspaceJob(database,workspaceId,175,'draft');
    const destination=workId==='inbox'?'/needs-you':'/autopilot/work/'+encodeURIComponent(workId);
    if(req.ctx?.workspaceId===workspaceId)return res.redirect(destination);
    return res.page('autopilot/approval-inventory',{title:'Open purchase approvals',workspace,workspaceId,destination});
  }));
  router.get('/autopilot/work/:id',requireAuth,asyncRoute(async(req,res)=>{const item=await autonomy.getWork(database,req.ctx.workspaceId,req.params.id),access=require('../../actions/permissions'),required=item.recommendedAction.type==='customer_order'?access.VIEW_SALES:item.recommendedAction.type==='supplier_invoice'?access.VIEW_ACCOUNTING:item.recommendedAction.type==='transfer'?access.VIEW_TRANSFERS:access.VIEW_PURCHASING;access.assertCan(req.user,required,'review this business workflow');let approvalBlock=null;const action=item.recommendedAction;
    // Say what is in the way before the person presses Approve, not after.
    if(item.execution_status==='WAITING_FOR_APPROVAL'&&action.type==='purchase'&&action.supplierId&&(action.unitCost==null||action.value==null)){
      approvalBlock={reason:'Record the supplier’s unit price before sending this purchase order.',href:'/suppliers/'+encodeURIComponent(action.supplierId),label:'Review supplier prices'};
    }else if(item.execution_status==='WAITING_FOR_APPROVAL'&&item.evidenceQuality?.level==='low'){
      approvalBlock={reason:item.evidenceQuality.reason,href:'/autopilot',label:'Review inventory and purchasing'};
    }else if(item.execution_status==='WAITING_FOR_APPROVAL'&&action.type!=='transfer'&&action.supplierId){const ready=await autonomy.supplierDeliveryReadiness(database,req.ctx.workspaceId,action.supplierId);
      if(!ready.ready)approvalBlock=/email address/.test(ready.reason||'')?{reason:(action.supplierName||'This supplier')+' has no order email address yet, so the order can’t be sent.',href:'/suppliers/'+encodeURIComponent(action.supplierId)+'?edit=1',label:'Add the supplier’s email'}:{reason:ready.reason,href:'/settings/connections',label:'Fix the connection'};}
    return res.page('autopilot/postgres-work',{
    title:'Review StockChief’s decision',nav:'autopilot',backTo:{href:'/needs-you',label:'Needs you'},
    item,approvalBlock});}));
  router.post('/autopilot/work/:id/approve',requireAuth,asyncRoute(async(req,res)=>{
    try{await autonomy.approve(database,req.ctx,req.user,req.params.id,{destinationLocationId:req.body.destinationLocationId||null});}
    catch(error){if(!(error instanceof ValidationError))throw error;req.flash('error',error.message);return res.redirect(303,`/autopilot/work/${req.params.id}`);}
    req.flash('success','The approved preparation was recorded. StockChief will keep following the linked order or transfer through its remaining work.');
    return res.redirect(303,`/autopilot/work/${req.params.id}`);
  }));
  router.post('/autopilot/work/:id/cancel',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.cancel(database,req.ctx,req.user,req.params.id);req.flash('success','Discarded. Nothing was executed.');
    return res.redirect(303,'/needs-you');
  }));
  return router;
}

module.exports={createPostgresAutopilotRouter};
