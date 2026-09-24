'use strict';

const express=require('express');
const { requireAuth,requireOwner,requirePermission,asyncRoute }=require('../middleware');
const accounts=require('../../shipping/postgres-accounts');
const shipping=require('../../shipping/postgres-service');
const commerce=require('../../operations/postgres-commerce');
const address=require('../../shipping/address');
const providerRegistry=require('../../shipping/provider');
const legacyAccounts=require('../../shipping/accounts');
const permissions=require('../../actions/permissions');
const carriers=require('../../sales/carriers');
const {newId,nowIso,trimOrNull}=require('../../lib/util');
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
  const mode=policyRows.rows[0]?.mode||'RECOMMEND';const recommended=rates.length&&mode!=='MANUAL'
    ?{rate:rates[0],because:'This is the lowest current carrier price. Confirm its service and delivery date before buying.'}:null;
  let providerCapabilities={};
  if(state.account?.provider&&providerRegistry.has(state.account.provider))providerCapabilities=providerRegistry.capabilities(state.account.provider);
  return {shipment:s,paymentPosition,pickList:{shipment:s,stops},shipping:{ready:state.ready,blocked,
    provider:state.account?.provider||null,to:state.to,from:state.from,boxes:state.boxes,rates,promised:null,promise:null,
    handling:{mode},ruled:null,recommended,rules:ruleRows.rows,events:state.events,
    transactions:transactionRows.rows,providerCapabilities},
    notices:noticeRows.rows.map((notice)=>({...notice,connectorId:notice.connector_id,errorMessage:notice.error_message,
      sentAt:notice.sent_at})),noticePolicy:{},mailboxes:mailboxRows.rows};
}

function createPostgresShippingRouter(database,options={}){
  const router=express.Router();
  router.use(['/settings/shipping','/fulfilment'],requireAuth);
  router.get('/settings/shipping',asyncRoute(async(req,res)=>{
    const [account,ruleRows,policyRows,locationRows]=await Promise.all([accounts.describe(database,req.ctx.workspaceId),
      database.query(`SELECT * FROM shipping_rules WHERE workspace_id=$1 ORDER BY created_at,id`,[req.ctx.workspaceId]),
      database.query('SELECT * FROM shipping_operation_policy WHERE workspace_id=$1',[req.ctx.workspaceId]),
      database.query(`SELECT name,address FROM locations WHERE workspace_id=$1 AND is_active=1
        ORDER BY CASE WHEN TRIM(COALESCE(address,''))<>'' THEN 0 ELSE 1 END,created_at,id LIMIT 1`,[req.ctx.workspaceId])]);
    const origin=locationRows.rows[0]||{};const parsed=address.parse(origin.address);const rules=ruleRows.rows.map((row)=>({
      id:row.id,name:row.name,carrier:row.carrier,service:row.service,maxCostMinor:row.max_cost_minor===null?null:Number(row.max_cost_minor),
      requireByPromised:Boolean(Number(row.require_by_promised)),maxDeliveryDays:row.max_delivery_days===null?null:Number(row.max_delivery_days),
      active:Boolean(Number(row.is_active)),statedText:row.stated_text}));
    return res.page('shipping/rules',{title:'Shipping rules',nav:'settings',room:true,backTo:{href:'/settings',label:'Settings'},
      account,rules,operationPolicy:{mode:policyRows.rows[0]?.mode||'RECOMMEND'},
      referral:{available:false,opened:false,billingReady:false},shipengine:{available:false,opened:false,billingReady:false},
      openShipEngineSetup:false,workspaceName:req.workspace?.name||'',providers:accounts.PROVIDERS,carriers:carriers.list(),
      shipFromAddress:{name:origin.name||req.workspace?.name||'',company_name:req.workspace?.name||'',address_line1:parsed.line1||'',
        address_line2:parsed.line2||'',city_locality:parsed.city||'',state_province:parsed.state||'',postal_code:parsed.postalCode||'',
        country_code:parsed.country||'US'},
      webhookUrl:`${res.locals.origin}/webhooks/shipping/${account.provider||'<provider>'}/${req.ctx.workspaceId}`,
    });
  }));
  router.post('/settings/shipping',requirePermission(permissions.OPERATE,'set shipping rules'),asyncRoute(async(req,res)=>{
    const maxCost=trimOrNull(req.body.maxCost);const days=trimOrNull(req.body.maxDeliveryDays);
    const maxCostMinor=maxCost===null?null:Math.round(Number(maxCost)*100);const maxDeliveryDays=days===null?null:Number(days);
    if(maxCostMinor!==null&&(!Number.isSafeInteger(maxCostMinor)||maxCostMinor<0))throw new ValidationError('Enter a valid maximum postage cost.');
    if(maxDeliveryDays!==null&&(!Number.isSafeInteger(maxDeliveryDays)||maxDeliveryDays<1||maxDeliveryDays>30))
      throw new ValidationError('Delivery days must be between 1 and 30.');const at=nowIso();const carrier=trimOrNull(req.body.carrier);
    const service=trimOrNull(req.body.service);const name=[carrier?carrier.toUpperCase():'Any carrier',service,
      maxCostMinor!==null?`under $${(maxCostMinor/100).toFixed(2)}`:null].filter(Boolean).join(' · ');
    await database.query(`INSERT INTO shipping_rules(id,workspace_id,name,carrier,service,max_cost_minor,require_by_promised,
      max_delivery_days,is_active,stated_text,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$11)`,[newId('shiprule'),req.ctx.workspaceId,name,carrier,service,maxCostMinor,
      req.body.requireByPromised!==undefined?1:0,maxDeliveryDays,trimOrNull(req.body.statedText),req.ctx.actorId,at]);
    req.flash('success','Saved. StockChief will use this when a parcel is ready and it fits.');return res.redirect(303,'/settings/shipping');
  }));
  router.post('/settings/shipping/operation-mode',requirePermission(permissions.ADMIN,'change shipping automation'),asyncRoute(async(req,res)=>{
    const mode=String(req.body.mode||'');if(!['MANUAL','RECOMMEND','AUTOMATIC'].includes(mode))throw new ValidationError('Choose Manual, Recommend, or Automatic.');
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
    await verify({provider:req.body.provider,apiKey:req.body.apiKey});
    const account=await accounts.connect(database,req.ctx,req.body);
    req.flash('success',account.testMode?'Sandbox postage account connected. No real postage can be charged.':
      'This inventory’s own postage account is connected.');
    return res.redirect(303,'/settings/shipping');
  }));
  router.post('/settings/shipping/account/disconnect',requireOwner,asyncRoute(async(req,res)=>{
    await accounts.disconnect(database,req.ctx);
    req.flash('success','Postage account disconnected and its encrypted credentials removed.');
    return res.redirect(303,'/settings/shipping');
  }));
  router.post('/settings/shipping/account/remove',requireOwner,asyncRoute(async(req,res)=>{
    await accounts.disconnect(database,req.ctx);req.flash('success','Disconnected. Existing shipment, label and tracking history remains with this business.');
    return res.redirect(303,'/settings/shipping');
  }));
  router.post('/settings/shipping/:id/remove',requirePermission(permissions.OPERATE,'set shipping rules'),asyncRoute(async(req,res)=>{
    await database.query(`UPDATE shipping_rules SET is_active=0,updated_at=$3 WHERE workspace_id=$1 AND id=$2`,
      [req.ctx.workspaceId,req.params.id,nowIso()]);req.flash('success','That rule is off. StockChief will ask about these parcels instead.');
    return res.redirect(303,'/settings/shipping');
  }));
  router.get('/fulfilment/:id',asyncRoute(async(req,res)=>{
    const page=await shipmentPage(database,req.ctx.workspaceId,req.params.id);
    return res.page('sales/shipment',{title:page.shipment.shipment_number,nav:'fulfilment',room:true,
      backTo:{href:'/orders',label:'Orders'},...page,carriers:carriers.list(),postgresPlacement:true});
  }));
  router.post('/fulfilment/:id/packages',asyncRoute(async(req,res)=>{
    await shipping.setPackages(database,req.ctx,req.params.id,[{weightGrams:req.body.weightGrams,
      lengthMm:req.body.lengthMm,widthMm:req.body.widthMm,heightMm:req.body.heightMm}]);
    req.flash('success','Measured package details saved.');
    return res.redirect(303,`/fulfilment/${req.params.id}`);
  }));
  router.post('/fulfilment/:id/quote',asyncRoute(async(req,res)=>{
    await shipping.quote(database,req.ctx,req.params.id,{provider:options.providerResolver?
      options.providerResolver((await accounts.forWorkspace(database,req.ctx.workspaceId))?.provider):undefined});
    req.flash('success','Live rates refreshed. No postage was purchased.');
    return res.redirect(303,`/fulfilment/${req.params.id}#rates`);
  }));
  router.post('/fulfilment/:id/rates',asyncRoute(async(req,res)=>{
    await shipping.quote(database,req.ctx,req.params.id,{provider:options.providerResolver?
      options.providerResolver((await accounts.forWorkspace(database,req.ctx.workspaceId))?.provider):undefined});
    req.flash('success','Live rates refreshed. No postage was purchased.');
    return res.redirect(303,`/fulfilment/${req.params.id}#carrier`);
  }));
  router.post('/fulfilment/:id/buy',requireOwner,asyncRoute(async(req,res)=>{
    const queued=await shipping.queueLabelPurchase(database,req.ctx,req.params.id,req.body.rateId,
      {idempotencyKey:req.body.idempotencyKey});
    req.flash('success',queued.replayed?'That label request is already being verified. StockChief did not submit it twice.':
      'Label purchase queued. StockChief will record it only after the carrier confirms the charge and tracking number.');
    return res.redirect(303,`/fulfilment/${req.params.id}#label`);
  }));
  router.post('/fulfilment/:id/label',requireOwner,asyncRoute(async(req,res)=>{
    const queued=await shipping.queueLabelPurchase(database,req.ctx,req.params.id,req.body.rateId,
      {idempotencyKey:req.body.idempotencyKey||`label:${req.params.id}:${req.body.rateId}`});
    req.flash('success',queued.replayed?'That label request is already being verified. StockChief did not submit it twice.':
      'Label purchase queued. StockChief will record it only after the carrier confirms the charge and tracking number.');
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
    const method=String(req.body.deliveryMethod||'');const destination=trimOrNull(req.body.shippingAddress);
    if(!['SHIP','PICKUP'].includes(method))throw new ValidationError('Choose delivery or customer pickup.');
    if(method==='SHIP'&&!address.parse(destination).complete)throw new ValidationError(address.why(address.parse(destination)));
    const current=await shipping.requireShipment(database,req.ctx.workspaceId,req.params.id);
    await database.transaction(async(client)=>{
      await client.query(`UPDATE sales_shipments SET ship_to_address=$3,handover=$4,updated_at=$5 WHERE workspace_id=$1 AND id=$2`,
      [req.ctx.workspaceId,req.params.id,method==='SHIP'?destination:null,method==='PICKUP'?'COLLECTED':'CARRIER',nowIso()]);
      await client.query(`UPDATE sales_orders SET delivery_method=$3,ship_to_address=$4,ship_to_source='order',updated_at=$5
        WHERE workspace_id=$1 AND id=$2`,[req.ctx.workspaceId,current.sales_order_id,method,method==='SHIP'?destination:null,nowIso()]);
    });
    req.flash('success','Delivery choice saved for the order and this parcel. No stock moved.');
    return res.redirect(303,`/fulfilment/${req.params.id}`);
  }));
  router.post('/fulfilment/:id/delivered',asyncRoute(async(req,res)=>{
    await shipping.applyTracking(database,req.ctx,req.params.id,{provider:'manual',status:'DELIVERED',
      externalEventId:`manual-delivered:${req.params.id}`,detail:'Marked delivered by a StockChief user.',occurredAt:nowIso()});
    req.flash('success','Delivery recorded. Duplicate confirmation will not create a second event.');
    return res.redirect(303,`/fulfilment/${req.params.id}#tracking`);
  }));
  router.post('/fulfilment/:id/cancel',asyncRoute(async(req,res)=>{
    const changed=await database.query(`UPDATE sales_shipments SET status='CANCELLED',notes=COALESCE($3,notes),updated_at=$4
      WHERE workspace_id=$1 AND id=$2 AND status IN ('PICKING','PACKED')`,[req.ctx.workspaceId,req.params.id,
      trimOrNull(req.body.reason),nowIso()]);
    if(!changed.rowCount)throw new ValidationError('A shipment that already left cannot be cancelled.');
    req.flash('success','Shipment cancelled. Its committed stock is still on the customer order and can be picked again.');
    return res.redirect(303,`/fulfilment/${req.params.id}`);
  }));
  router.post('/fulfilment/:id/tracking/refresh',asyncRoute(async(req,res)=>{
    const account=await accounts.forWorkspace(database,req.ctx.workspaceId);
    await shipping.refreshTracking(database,req.ctx,req.params.id,{provider:options.providerResolver?
      options.providerResolver(account.provider):providerRegistry.get(account.provider)});
    req.flash('success','Carrier tracking checked. Duplicate scans were ignored.');
    return res.redirect(303,`/fulfilment/${req.params.id}#tracking`);
  }));
  return router;
}

module.exports={createPostgresShippingRouter};
