'use strict';

const express=require('express');
const { requireAuth,requireOwner,requirePermission,asyncRoute }=require('../middleware');
const accounts=require('../../shipping/postgres-accounts');
const shipping=require('../../shipping/postgres-service');
const commerce=require('../../operations/postgres-commerce');
const address=require('../../shipping/address');
const providerRegistry=require('../../shipping/provider');
const legacyAccounts=require('../../shipping/accounts');
const {requireCapability,commercialScope}=require('../commercial-middleware');
const entitlements=require('../../entitlements/postgres-service');
const permissions=require('../../actions/permissions');
const carriers=require('../../sales/carriers');
const {newId,nowIso,trimOrNull,requireText}=require('../../lib/util');
const {ValidationError}=require('../../domain/errors');

async function shipmentPage(database,workspaceId,shipmentId){
  const state=await shipping.state(database,workspaceId,shipmentId);
  const [lineRows,orderDetail,noticeRows,mailboxRows,transactionRows,policyRows,ruleRows]=await Promise.all([
    database.query(`SELECT sl.*,l.name AS location_name,i.name AS item_name,i.unit_label,s.code AS sku_code,s.variant_label
      FROM sales_shipment_lines sl JOIN locations l ON l.id=sl.location_id AND l.workspace_id=sl.workspace_id
      JOIN skus s ON s.id=sl.sku_id AND s.workspace_id=sl.workspace_id
      JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
      WHERE sl.workspace_id=$1 AND sl.shipment_id=$2 ORDER BY l.name,i.name,sl.id`,[workspaceId,shipmentId]),
    commerce.salesOrder(database,workspaceId,state.shipment.sales_order_id),
    database.query(`SELECT * FROM customer_communications WHERE workspace_id=$1 AND shipment_id=$2
      ORDER BY created_at DESC,id DESC`,[workspaceId,shipmentId]),
    database.query(`SELECT id,display_name,provider_type,status FROM workspace_connectors WHERE workspace_id=$1
      AND provider_type IN ('gmail','microsoft365') AND status='connected' ORDER BY display_name`,[workspaceId]),
    database.query(`SELECT * FROM shipping_label_transactions WHERE workspace_id=$1 AND shipment_id=$2
      ORDER BY requested_at,id`,[workspaceId,shipmentId]),
    database.query(`SELECT * FROM shipping_operation_policy WHERE workspace_id=$1`,[workspaceId]),
    database.query(`SELECT * FROM shipping_rules WHERE workspace_id=$1 AND is_active=1 ORDER BY created_at,id`,[workspaceId]),
  ]);
  const stops=[];const stopMap=new Map();
  for(const line of lineRows.rows){
    if(!stopMap.has(line.location_id)){const stop={locationId:line.location_id,locationName:line.location_name,lines:[]};
      stopMap.set(line.location_id,stop);stops.push(stop);}
    stopMap.get(line.location_id).lines.push({...line,quantity:Number(line.quantity),kit_component_id:null});
  }
  const units=lineRows.rows.reduce((sum,line)=>sum+Number(line.quantity),0);
  const s={...state.shipment,units,ship_from_location_name:state.shipment.location_name,
    carrierName:state.shipment.carrier?carriers.displayName(state.shipment.carrier):null,
    trackingUrl:state.shipment.tracking_url,label_status:state.shipment.label_status||null};
  const paid=orderDetail.invoices.reduce((sum,invoice)=>sum+Number(invoice.paid_minor),0);
  const remaining=orderDetail.invoices.length
    ?orderDetail.invoices.reduce((sum,invoice)=>sum+Number(invoice.balance_minor),0)
    :Math.max(0,orderDetail.orderTotalMinor-paid);
  const terms=orderDetail.paymentTerms;const blocksShipping=Boolean(terms?.hold_shipping&&remaining>0);
  const paymentPosition={status:remaining>0?(paid>0?'Partially paid':'Unpaid'):'Paid',remainingMinor:remaining,
    currency:state.shipment.currency||orderDetail.order.currency,termsText:!terms?'No payment terms agreed':
      terms.kind==='DEPOSIT'?'Deposit required':terms.kind==='BEFORE_FULFILMENT'?'Payment before fulfilment':`Net ${Number(terms.net_days||0)}`,
    terms:terms||{source:'nothing agreed'},blocksShipping,heldReason:{ship:blocksShipping?'The agreed balance is still outstanding.':null}};
  const blocked=state.blocked.map((what)=>{const lower=what.toLowerCase();const key=lower.includes('weight')?'weight':
    lower.includes('postage account')?'account':lower.includes('ship-from')?'origin':lower.includes('phone')?'phone':'destination';
    return {key,what,href:key==='account'?'/settings/shipping':key==='origin'?'/locations':'/orders/'+s.sales_order_id};});
  const rates=state.rates.map((rate)=>({...rate,carrierName:carriers.displayName(rate.carrier),
    deliveryDate:rate.delivery_date,quotedAt:rate.quoted_at,guaranteed:rate.guaranteed}));
  const mode=policyRows.rows[0]?.mode||'RECOMMEND';
  const rules=ruleRows.rows.map(row=>({id:row.id,name:row.name,carrier:row.carrier,service:row.service,
    maxCostMinor:row.max_cost_minor===null?null:Number(row.max_cost_minor),
    maxDeliveryDays:row.max_delivery_days===null?null:Number(row.max_delivery_days),
    requireByPromised:Boolean(Number(row.require_by_promised)),active:Boolean(Number(row.is_active)),currency:row.currency,
    minWeightGrams:row.min_weight_grams==null?null:Number(row.min_weight_grams),maxWeightGrams:row.max_weight_grams==null?null:Number(row.max_weight_grams)})).filter(rule=>rule.active);
  const ruled=rules.length?require('../../shipping/rules').decide(null,workspaceId,rates,{rules,promisedDate:s.needed_by||null,weightGrams:Number(s.weight_grams)}):null;
  const recommended=rates.length&&mode!=='MANUAL'&&!rules.length
    ?{rate:rates[0],because:'This is the lowest current carrier price. Confirm its service and delivery date before buying.'}:null;
  let providerCapabilities={};
  const shipmentProvider=s.provider||state.account?.provider;
  if(shipmentProvider&&providerRegistry.has(shipmentProvider))providerCapabilities=providerRegistry.capabilities(shipmentProvider);
  const packagePresets=await require('../../shipping/postgres-parcel-options').presets(database,workspaceId);
  return {shipment:s,paymentPosition,pickList:{shipment:s,stops},shipping:{ready:state.ready,blocked,packagePresets,
    provider:s.provider||state.account?.provider||null,to:state.to,from:state.from,boxes:state.boxes,rates,promised:s.needed_by||null,promise:null,
    handling:{mode},ruled,recommended,rules:ruleRows.rows,events:state.events,quoteProblems:state.quoteProblems,
    transactions:transactionRows.rows,providerCapabilities},
    notices:noticeRows.rows.map((notice)=>({...notice,connectorId:notice.connector_id,errorMessage:notice.error_message,
      sentAt:notice.sent_at})),noticePolicy:{},mailboxes:mailboxRows.rows};
}

function createPostgresShippingRouter(database,options={}){
  const router=express.Router();
  router.use(['/settings/shipping','/fulfilment','/returns'],requireAuth);
  router.get('/fulfilment/batches/new',requireOwner,asyncRoute(async(req,res)=>{
    const currency=(await database.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[req.ctx.workspaceId])).rows[0]?.base_currency||'USD';
    return res.page('shipping/batch-new',{title:'Buy labels together',nav:'fulfilment',room:true,candidates:await require('../../shipping/postgres-batches').candidates(database,req.ctx.workspaceId),currency,requestKey:newId('batch-request')});
  }));
  router.post('/fulfilment/batches',requireOwner,requireCapability(database,'shipping.labels'),asyncRoute(async(req,res)=>{
    if(req.body.confirmed!=='yes')throw new ValidationError('Confirm the postage purchases before starting this batch.');
    const entries=Object.entries(req.body.choices||{}).filter(([,rateId])=>rateId).map(([shipmentId,rateId])=>({shipmentId,rateId}));
    const batch=await require('../../shipping/postgres-batches').queue(database,req.ctx,{entries,currency:req.body.currency,maxAmountMinor:require('../../domain/currency').toMinor(req.body.maxCost,req.body.currency),idempotencyKey:req.body.idempotencyKey});
    return res.redirect(303,'/fulfilment/batches/'+batch.id);
  }));
  router.get('/fulfilment/batches/:batchId/print',asyncRoute(async(req,res)=>{
    const batch=await require('../../shipping/postgres-batches').detail(database,req.ctx.workspaceId,req.params.batchId),print=require('../../shipping/bulk-print'),format=String(req.query.format||'PDF'),offset=Number(req.query.offset||0);
    if(!Number.isSafeInteger(offset)||offset<0||!['PDF','ZPL'].includes(format))throw new ValidationError('Choose a saved label group to print.');
    const documents=batch.entries.flatMap(e=>e.documents).filter(d=>d.format===format).slice(offset,offset+print.CHUNK),content=await print.build(documents,format);
    // Check again after downloading: another tab may have voided the label.
    const fresh=await require('../../shipping/postgres-batches').detail(database,req.ctx.workspaceId,req.params.batchId),current=new Set(fresh.entries.flatMap(e=>e.documents).map(d=>d.url));
    if(documents.some(d=>!current.has(d.url)))throw new ValidationError('A label changed or was voided while printing. Reload this batch before printing.');
    res.set('Cache-Control','no-store');res.set('Content-Disposition',(format==='PDF'?'inline':'attachment')+'; filename="stockchief-labels.'+format.toLowerCase()+'"');return res.type(format==='PDF'?'application/pdf':'application/x-zpl').send(content);
  }));
  router.get('/fulfilment/batches/:batchId',asyncRoute(async(req,res)=>res.page('shipping/batch',{title:'Label batch',nav:'fulfilment',room:true,batch:await require('../../shipping/postgres-batches').detail(database,req.ctx.workspaceId,req.params.batchId),printChunk:require('../../shipping/bulk-print').CHUNK})));
  router.get('/fulfilment/batches/:batchId/status',asyncRoute(async(req,res)=>{
    const batch=await require('../../shipping/postgres-batches').detail(database,req.ctx.workspaceId,req.params.batchId);res.set('Cache-Control','no-store');return res.json({complete:batch.complete,needsAttention:batch.needsAttention,total:batch.entries.length});
  }));
  router.post('/returns/:id/postage',requirePermission(permissions.OPERATE,'prepare return postage'),asyncRoute(async(req,res)=>{
    const result=await require('../../shipping/postgres-return-parcels').prepare(database,req.ctx,req.params.id,{locationId:req.body.locationId,outboundShipmentId:req.body.outboundShipmentId});
    req.flash('success','Return parcel prepared. Confirm its actual measurements before comparing postage. Stock and refunds have not changed.');return res.redirect(303,'/fulfilment/'+result.shipmentId+'#carrier');
  }));
  router.get('/settings/shipping',asyncRoute(async(req,res)=>{
    const [shippingAccounts,ruleRows,policyRows,locationRows,setupRows]=await Promise.all([accounts.describeAll(database,req.ctx.workspaceId),
      database.query(`SELECT * FROM shipping_rules WHERE workspace_id=$1 ORDER BY created_at,id`,[req.ctx.workspaceId]),
      database.query('SELECT * FROM shipping_operation_policy WHERE workspace_id=$1',[req.ctx.workspaceId]),
      database.query(`SELECT name,address FROM locations WHERE workspace_id=$1 AND is_active=1
        ORDER BY CASE WHEN TRIM(COALESCE(address,''))<>'' THEN 0 ELSE 1 END,created_at,id LIMIT 1`,[req.ctx.workspaceId]),
      database.query('SELECT connector_id,status,last_error FROM shipping_webhook_setups WHERE workspace_id=$1',[req.ctx.workspaceId])]);
    const account=shippingAccounts[0]||await accounts.describe(database,req.ctx.workspaceId);
    const origin=locationRows.rows[0]||{};const parsed=address.parse(origin.address);const rules=ruleRows.rows.map((row)=>({
      id:row.id,name:row.name,carrier:row.carrier,service:row.service,maxCostMinor:row.max_cost_minor===null?null:Number(row.max_cost_minor),
      requireByPromised:Boolean(Number(row.require_by_promised)),maxDeliveryDays:row.max_delivery_days===null?null:Number(row.max_delivery_days),
      active:Boolean(Number(row.is_active)),statedText:row.stated_text}));
    return res.page('shipping/postgres-settings',{title:'Shipping settings',nav:'settings',room:true,backTo:{href:'/settings',label:'Settings'},
      account,shippingAccounts:shippingAccounts.map(a=>({...a,webhookSetup:setupRows.rows.find(row=>row.connector_id===a.connectorId)||null,webhookUrl:`${res.locals.origin}/webhooks/shipping/${a.provider}/${req.ctx.workspaceId}`})),rules,
      purchaseLimits:await require('../../shipping/postgres-purchase-policy').get(database,req.ctx.workspaceId),fromMinor:require('../../domain/currency').fromMinor,currency:(await database.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[req.ctx.workspaceId])).rows[0]?.base_currency||'USD',
      automaticShippingAvailable:false,operationPolicy:{mode:policyRows.rows[0]?.mode||'RECOMMEND'},
      referral:{available:false,opened:false,billingReady:false},shipengine:{available:false,opened:false,billingReady:false},
      openShipEngineSetup:false,workspaceName:req.workspace?.name||'',providers:accounts.PROVIDERS,carriers:carriers.list(),
      shipFromAddress:{name:origin.name||req.workspace?.name||'',company_name:req.workspace?.name||'',address_line1:parsed.line1||'',
        address_line2:parsed.line2||'',city_locality:parsed.city||'',state_province:parsed.state||'',postal_code:parsed.postalCode||'',
        country_code:parsed.country||'US'},
      webhookUrl:`${res.locals.origin}/webhooks/shipping/${account.provider||'<provider>'}/${req.ctx.workspaceId}`,
    });
  }));
  router.post('/settings/shipping/limits',requireOwner,asyncRoute(async(req,res)=>{
    const currency=req.body.currency,convert=value=>String(value??'').trim()===''?null:require('../../domain/currency').toMinor(value,currency);
    await require('../../shipping/postgres-purchase-policy').save(database,req.ctx,{currency,perLabelMinor:convert(req.body.perLabel),rollingDayMinor:convert(req.body.rollingDay)});
    req.flash('success','Postage limits saved. Pending purchases count toward the rolling 24-hour limit.');return res.redirect(303,'/settings/shipping#limits');
  }));
  router.post('/settings/shipping',requirePermission(permissions.OPERATE,'set shipping preferences'),asyncRoute(async(req,res)=>{
    await require('../../shipping/postgres-rules').save(database,req.ctx,{...req.body,requireByPromised:req.body.requireByPromised!==undefined});
    req.flash('success','Shipping preference saved. Matching rates are recommended for review; no postage was purchased.');return res.redirect(303,'/settings/shipping');
  }));
  router.post('/settings/shipping/operation-mode',requirePermission(permissions.ADMIN,'change shipping handling'),requireCapability(database,'shipping.rates'),asyncRoute(async(req,res)=>{
    const mode=String(req.body.mode||'');if(!['MANUAL','RECOMMEND','AUTOMATIC'].includes(mode))throw new ValidationError('Choose Manual, Recommend, or Automatic.');
    if(mode==='AUTOMATIC')await require('../../commercial/enforcement').workspace(database,req.ctx.workspaceId,'shipping.automation');
    const at=nowIso();await database.query(`INSERT INTO shipping_operation_policy(workspace_id,mode,updated_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$4) ON CONFLICT(workspace_id) DO UPDATE SET mode=EXCLUDED.mode,
      updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=EXCLUDED.updated_at`,[req.ctx.workspaceId,mode,req.ctx.actorId,at]);
    req.flash('success',mode==='AUTOMATIC'?'Shipping is set to Automatic. Exact authority and a matching rule are still required.':
      mode==='RECOMMEND'?'Shipping is set to Recommend. StockChief compares rates, but you approve every purchase.':
        'Shipping is set to Manual. StockChief shows carrier facts and leaves every choice to you.');
    return res.redirect(303,'/settings/shipping#handling');
  }));
  router.post('/settings/shipping/account',requireOwner,asyncRoute(async(req,res)=>{
    const verify=options.verifyAccount||legacyAccounts.verifyInput;
    const provider=accounts.requireProvider(req.body.provider),apiKey=requireText(req.body.apiKey,'API key',{max:400});
    await require('../../commercial/operations').run(database,req.ctx.workspaceId,{capability:'shipping.rates',
      key:newId('shipping-account-verification'),provider,operation:'shipping_account_verify'},async()=>{
      try{return await verify({provider,apiKey});}
      catch(error){
        // Provider responses can echo credentials. Never copy their body or
        // exception into the page, commercial ledger, job history or logs.
        throw new ValidationError('The '+provider+' account could not be verified'+
          (Number.isInteger(Number(error.status))?' (HTTP '+Number(error.status)+')':'')+
          '. Check that the key is active and belongs to the selected platform.');
      }
    });
    const account=await accounts.connect(database,req.ctx,{...req.body,provider,apiKey});
    req.flash('success',account.testMode?'Sandbox postage account connected. No real postage can be charged.':
      'This inventory’s own postage account is connected.');
    return res.redirect(303,'/settings/shipping');
  }));
  router.post('/settings/shipping/account/disconnect',requireOwner,asyncRoute(async(req,res)=>{
    await accounts.disconnect(database,req.ctx,{connectorId:req.body.connectorId});
    req.flash('success','Postage account disconnected and its encrypted credentials removed.');
    return res.redirect(303,'/settings/shipping');
  }));
  router.post('/settings/shipping/account/remove',requireOwner,asyncRoute(async(req,res)=>{
    await accounts.disconnect(database,req.ctx,{connectorId:req.body.connectorId});req.flash('success','Disconnected. Existing shipment, label and tracking history remains with this business.');
    return res.redirect(303,'/settings/shipping');
  }));
  router.post('/settings/shipping/:id/remove',requirePermission(permissions.OPERATE,'set shipping rules'),asyncRoute(async(req,res)=>{
    await database.query(`UPDATE shipping_rules SET is_active=0,updated_at=$3 WHERE workspace_id=$1 AND id=$2`,
      [req.ctx.workspaceId,req.params.id,nowIso()]);req.flash('success','That rule is off. StockChief will ask about these parcels instead.');
    return res.redirect(303,'/settings/shipping');
  }));
  router.get('/fulfilment/:id',asyncRoute(async(req,res)=>{
    const saved=await shipping.requireShipment(database,req.ctx.workspaceId,req.params.id);
    if(saved.customer_return_id){const state=await shipping.state(database,req.ctx.workspaceId,saved.id),packagePresets=await require('../../shipping/postgres-parcel-options').presets(database,req.ctx.workspaceId);
      return res.page('shipping/return-parcel',{title:saved.shipment_number,nav:'fulfilment',room:true,shipment:saved,state,packagePresets,purchaseKey:newId('return-postage')});}
    const page=await shipmentPage(database,req.ctx.workspaceId,req.params.id);
    return res.page('sales/shipment',{title:page.shipment.shipment_number,nav:'fulfilment',room:true,
      backTo:{href:'/orders',label:'Orders'},...page,carriers:carriers.list(),postgresPlacement:true});
  }));
  router.get('/fulfilment/:id/label/status',asyncRoute(async(req,res)=>{
    await shipping.requireShipment(database,req.ctx.workspaceId,req.params.id);
    const operation=String(req.query.operation||'');if(!operation||operation.length>500)throw new ValidationError('Choose the saved label request.');
    const transaction=(await database.query(`SELECT status,requested_at FROM shipping_label_transactions
      WHERE workspace_id=$1 AND shipment_id=$2 AND id=$3`,[req.ctx.workspaceId,req.params.id,operation])).rows[0];
    if(!transaction)throw new ValidationError('That label request is not in this inventory.');
    res.set('Cache-Control','no-store');return res.json({state:transaction.status==='SUCCEEDED'?'COMPLETED':transaction.status,
      startedAt:transaction.requested_at});
  }));
  router.post('/fulfilment/:id/packages',asyncRoute(async(req,res)=>{
    await shipping.setPackages(database,req.ctx,req.params.id,req.body.packages||[{weightGrams:req.body.weightGrams,
      lengthMm:req.body.lengthMm,widthMm:req.body.widthMm,heightMm:req.body.heightMm}],{expectedUpdatedAt:req.body.expectedUpdatedAt});
    req.flash('success','Measured package details saved.');
    return res.redirect(303,`/fulfilment/${req.params.id}`);
  }));
  router.post('/fulfilment/:id/options',asyncRoute(async(req,res)=>{
    await require('../../shipping/postgres-parcel-options').saveOptions(database,req.ctx,req.params.id,req.body);
    req.flash('success','Label format and delivery confirmation saved. Refresh carrier rates before buying.');return res.redirect(303,'/fulfilment/'+req.params.id+'#carrier');
  }));
  router.post('/fulfilment/:id/preset',requireOwner,asyncRoute(async(req,res)=>{
    const boxes=await shipping.packagesFor(database,req.ctx.workspaceId,req.params.id);
    await require('../../shipping/postgres-parcel-options').savePreset(database,req.ctx,{name:req.body.name,packages:boxes});
    req.flash('success','Package defaults saved for this business. Confirm actual weights each time you use them.');return res.redirect(303,'/fulfilment/'+req.params.id+'#carrier');
  }));
  router.post('/fulfilment/:id/preset/apply',asyncRoute(async(req,res)=>{
    await require('../../shipping/postgres-parcel-options').applyPreset(database,req.ctx,req.params.id,req.body.presetId,{expectedUpdatedAt:req.body.expectedUpdatedAt});
    req.flash('success','Saved packages applied. Weigh these actual parcels and confirm their measurements before comparing rates.');return res.redirect(303,'/fulfilment/'+req.params.id+'#carrier');
  }));
  async function quoteShipment(req){
    return shipping.quote(database,req.ctx,req.params.id,{idempotencyKey:req.body.usageKey||newId('quote'),providerResolver:options.providerResolver});
  }
  router.post('/fulfilment/:id/quote',requireCapability(database,'shipping.rates'),asyncRoute(async(req,res)=>{
    const quoted=await quoteShipment(req);
    req.flash(quoted.quoteProblems?.length?'warning':'success',quoted.quoteProblems?.length?
      'Rates refreshed. Some connected accounts could not return rates; their offers are excluded. No postage was purchased.':
      'Rates refreshed across connected shipping accounts. No postage was purchased.');
    return res.redirect(303,`/fulfilment/${req.params.id}#rates`);
  }));
  router.post('/fulfilment/:id/rates',requireCapability(database,'shipping.rates'),asyncRoute(async(req,res)=>{
    const quoted=await quoteShipment(req);
    req.flash(quoted.quoteProblems?.length?'warning':'success',quoted.quoteProblems?.length?
      'Rates refreshed. Some connected accounts could not return rates; their offers are excluded. No postage was purchased.':
      'Rates refreshed across connected shipping accounts. No postage was purchased.');
    return res.redirect(303,`/fulfilment/${req.params.id}#carrier`);
  }));
  router.post('/fulfilment/:id/buy',requireOwner,requireCapability(database,'shipping.labels'),asyncRoute(async(req,res)=>{
    const queued=await shipping.queueLabelPurchase(database,req.ctx,req.params.id,req.body.rateId,
      {idempotencyKey:req.body.idempotencyKey});
    req.flash('success',queued.replayed?'That label request is already being verified. StockChief did not submit it twice.':
      'Label purchase queued. StockChief will record it only after the carrier confirms the charge and tracking number.');
    return res.redirect(303,`/fulfilment/${req.params.id}#label`);
  }));
  router.post('/fulfilment/:id/label',requireOwner,requireCapability(database,'shipping.labels'),asyncRoute(async(req,res)=>{
    const queued=await shipping.queueLabelPurchase(database,req.ctx,req.params.id,req.body.rateId,
      {idempotencyKey:req.body.idempotencyKey||`label:${req.params.id}:${req.body.rateId}`});
    req.flash('success',queued.replayed?'That label request is already being verified. StockChief did not submit it twice.':
      'Label purchase queued. StockChief will record it only after the carrier confirms the charge and tracking number.');
    return res.redirect(303,`/fulfilment/${req.params.id}#label`);
  }));
  router.post('/fulfilment/:id/label/void',requireOwner,asyncRoute(async(req,res)=>{
    const result=await require('../../shipping/postgres-label-voids').queue(database,req.ctx,req.params.id,
      {idempotencyKey:req.body.idempotencyKey});
    req.flash('success',result.replayed?'The saved void request is already being checked. It was not submitted twice.':
      'Void requested. StockChief will verify the carrier response. Stock and bank balances have not changed.');
    return res.redirect(303,`/fulfilment/${req.params.id}#label`);
  }));
  router.post('/fulfilment/:id/handoff',asyncRoute(async(req,res)=>{
    await shipping.handoff(database,req.ctx,req.params.id,{...req.body,idempotencyKey:req.body.idempotencyKey,
      shippingCostMinor:trimOrNull(req.body.shippingCost)===null?null:Math.round(Number(req.body.shippingCost)*100)});
    req.flash('success','Carrier handoff recorded. Inventory, order, and accounting now reflect the goods leaving.');
    return res.redirect(303,`/fulfilment/${req.params.id}#tracking`);
  }));
  router.post('/fulfilment/:id/ship',asyncRoute(async(req,res)=>{
    await shipping.handoff(database,req.ctx,req.params.id,{...req.body,idempotencyKey:req.body.idempotencyKey||`shipment-handoff:${req.params.id}`,
      shippingCostMinor:trimOrNull(req.body.shippingCost)===null?null:Math.round(Number(req.body.shippingCost)*100)});
    req.flash('success','Handoff recorded. Inventory, the customer order, revenue, product cost and receivable changed together.');
    return res.redirect(303,`/fulfilment/${req.params.id}#tracking`);
  }));
  router.post('/fulfilment/:id/destination',asyncRoute(async(req,res)=>{
    const parcel=await shipping.requireShipment(database,req.ctx.workspaceId,req.params.id);
    if(parcel.customer_return_id)throw new ValidationError('Return postage keeps its reviewed customer and return-location addresses. Void unused postage before preparing a different return route.');
    const method=String(req.body.deliveryMethod||'');const destination=trimOrNull(req.body.shippingAddress);
    if(!['SHIP','PICKUP'].includes(method))throw new ValidationError('Choose delivery or customer pickup.');
    if(method==='SHIP'&&!address.parse(destination).complete)throw new ValidationError(address.why(address.parse(destination)));
    await database.transaction(async(client)=>{
      const current=await shipping.requireShipment(client,req.ctx.workspaceId,req.params.id,true);
      shipping.assertParcelEditable(current);
      await client.query(`UPDATE sales_shipments SET ship_to_address=$3,handover=$4,updated_at=$5 WHERE workspace_id=$1 AND id=$2`,
      [req.ctx.workspaceId,req.params.id,method==='SHIP'?destination:null,method==='PICKUP'?'COLLECTED':'CARRIER',nowIso()]);
      await client.query(`UPDATE sales_orders SET delivery_method=$3,ship_to_address=$4,ship_to_source='order',updated_at=$5
        WHERE workspace_id=$1 AND id=$2`,[req.ctx.workspaceId,current.sales_order_id,method,method==='SHIP'?destination:null,nowIso()]);
    });
    req.flash('success','Delivery choice saved for the order and this parcel. No stock moved.');
    return res.redirect(303,`/fulfilment/${req.params.id}`);
  }));
  router.post('/fulfilment/:id/delivered',requirePermission(permissions.FULFILL_SALES,'confirm delivery'),asyncRoute(async(req,res)=>{
    await shipping.applyTracking(database,req.ctx,req.params.id,{provider:'manual',status:'DELIVERED',
      externalEventId:`manual-delivered:${req.params.id}`,allPackagesConfirmed:true,detail:'Marked delivered by a StockChief user.',occurredAt:nowIso()});
    req.flash('success','Delivery recorded. Duplicate confirmation will not create a second event.');
    return res.redirect(303,`/fulfilment/${req.params.id}#tracking`);
  }));
  router.post('/fulfilment/:id/cancel',asyncRoute(async(req,res)=>{
    await database.transaction(async client=>{
    shipping.assertParcelEditable(await shipping.requireShipment(client,req.ctx.workspaceId,req.params.id,true));
    const changed=await client.query(`UPDATE sales_shipments SET status='CANCELLED',notes=COALESCE($3,notes),updated_at=$4
      WHERE workspace_id=$1 AND id=$2 AND status IN ('PICKING','PACKED')`,[req.ctx.workspaceId,req.params.id,
      trimOrNull(req.body.reason),nowIso()]);
    if(!changed.rowCount)throw new ValidationError('A shipment that already left cannot be cancelled.');
    });
    req.flash('success','Shipment cancelled. Its committed stock is still on the customer order and can be picked again.');
    return res.redirect(303,`/fulfilment/${req.params.id}`);
  }));
  router.post('/fulfilment/:id/tracking/refresh',asyncRoute(async(req,res)=>{
    const shipment=await shipping.requireShipment(database,req.ctx.workspaceId,req.params.id);
    const account=await accounts.forWorkspace(database,req.ctx.workspaceId,{connectorId:shipment.shipping_connector_id||null,provider:shipment.provider});
    if(!account)throw new ValidationError('Reconnect this shipment’s shipping account before checking tracking.');
    await shipping.refreshTracking(database,req.ctx,req.params.id,{provider:options.providerResolver?
      options.providerResolver(account.provider):providerRegistry.get(account.provider)});
    req.flash('success','Carrier tracking checked. Duplicate scans were ignored.');
    return res.redirect(303,`/fulfilment/${req.params.id}#tracking`);
  }));
  return router;
}

module.exports={createPostgresShippingRouter};
