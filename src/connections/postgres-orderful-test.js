'use strict';

// Job 185: handles EDI orders, ship notices (ASN) and invoices with big
// retailers. Pro needs the paid EDI add-on; Custom includes it; Starter and
// Growth are excluded.
//
// One EDI connection carries documents for every retailer the owner sets up:
// its EDI ID, the customer and warehouse its orders use, its currency and the
// largest order StockChief may confirm on its own (agent_edi_retailers). The
// documents run from the real records, every five minutes while scheduled EDI
// is on:
//  - an incoming 850 becomes a customer order (a draft) through the normal
//    order service; StockChief confirms it when the retailer's prices match
//    its last confirmed order, the ship-to address is known and the order is
//    within the owner's limit and fully in stock; otherwise it waits for a
//    person, who confirms it on the order as usual;
//  - the 855 acknowledgment goes once the order is confirmed;
//  - the 856 ship notice goes once each shipment has actually left;
//  - the 810 invoice goes once the order is fully shipped and invoiced, and
//    every shipment's notice was accepted.
// A document from an EDI ID that is not set up, an item, unit, currency or
// charge that does not match, a retailer change (860) or a record that no
// longer matches the original order stops and asks in Needs you. Pause, watch
// mode, the first 14 days, Watch only, Ask me first, routine work being off and
// a retailer the owner sends for themselves leave each document for a person,
// who sends it from Retail EDI. Every document sent is audited and recorded
// before it leaves, so a replay or a lost answer never sends it twice.
//
// The EDI network is reached only through edi-providers.js (Orderful's test
// stream is built in).

const {ValidationError,NotFoundError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const money=require('../domain/currency');
const policy=require('../commercial/agent-plan');
const credentials=require('./postgres-credential-store');
const providers=require('./edi-providers');
const audit=require('../operations/postgres-security-audit');
const installed=require('../db/schema-installed');
const types={ack:'855_PURCHASE_ORDER_ACKNOWLEDGMENT',ship:'856_SHIP_NOTICE_MANIFEST',invoice:'810_INVOICE'};
const labels={ack:'acknowledgment',ship:'ship notice',invoice:'invoice'};
const key='agent-orderful-test',JOB=185,RETAILERS='stockchief_runtime.agent_edi_retailers',href='/autopilot/orderful';
const IMPORTED='Retailer order imported from EDI',CONFIRMED='Retailer order confirmed by StockChief',SENT='EDI document sent to a retailer';

async function access(db,ctx){
  const state=await require('../autopilot/job-reviews').ownerState(db,ctx);
  if(!policy.usesAgentTerms(state))policy.requireJob(null,JOB,'draft');
  return policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
}
async function connection(db,ctx){
  const row=(await db.query("SELECT id,config FROM workspace_connectors WHERE workspace_id=$1 AND connector_key=$2 AND status='connected' AND paused_at IS NULL",[ctx.workspaceId,key])).rows[0];
  if(!row)throw new ValidationError('Connect the Orderful test relationship first.');
  const config=JSON.parse(row.config);
  return {...config,provider:config.provider||'orderful',id:row.id};
}
async function remote(db,ctx,con,transport){
  const secret=await credentials.get(db,ctx.workspaceId,con.id,'provider');
  if(!secret?.apiKey)throw new ValidationError('Reconnect the test relationship.');
  return providers.client(con.provider,secret,transport);
}
// A validated inbound order or change to this business. Which retailer sent it is decided separately.
function inbound(meta,con){
  if(meta.stream!=='test'||meta.direction!=='in'||meta.receiverId!==con.seller||meta.validationStatus!=='VALID'||
    !['850_PURCHASE_ORDER','860_PURCHASE_ORDER_CHANGE'].includes(meta.ediTransactionType))
    throw new ValidationError('Choose a validated inbound test purchase order or change for this buyer and seller.');
}
const unknownRetailer=id=>'No retailer is set up for EDI ID '+id+'. Add it on Retail EDI to read its orders.';
async function retailerFor(db,ctx,con,partnerId){
  const row=(await db.query(`SELECT * FROM ${RETAILERS} WHERE workspace_id=$1 AND connector_id=$2 AND partner_id=$3 AND enabled`,[ctx.workspaceId,con.id,String(partnerId||'')])).rows[0];
  if(!row)throw new ValidationError(unknownRetailer(partnerId||'(none)'));
  return row;
}

// Why StockChief may not confirm or send on its own right now, or null.
async function automaticStop(db,workspaceId,state){
  state=state||await policy.accountState(db,workspaceId);
  const stop=await policy.stopped(db,workspaceId,state,'edi.send_document',true);if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return 'Routine work is off for this inventory, so retailer documents wait for you.';
  return null;
}
// Why StockChief may not read new retailer orders in as drafts right now, or null.
async function importStop(db,workspaceId,state){
  state=state||await policy.accountState(db,workspaceId);
  const stop=await policy.stopped(db,workspaceId,state,'edi.import_order',false);if(stop)return stop;
  const config=(await db.query('SELECT paused,suspended FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];
  if(Number(config?.paused)||Number(config?.suspended))return 'Automatic work is paused. Read the retailer orders in yourself on Retail EDI.';
  return null;
}

async function connect(db,ctx,input,transport){
  await access(db,ctx);
  const provider=String(input.provider||'orderful').toLowerCase();
  if(!providers.has(provider))throw new ValidationError('Choose an available EDI network.');
  const config={buyer:String(input.buyer||'').trim(),seller:String(input.seller||'').trim(),customerId:input.customerId,locationId:input.locationId,currency:money.code(input.currency),...(provider==='orderful'?{}:{provider})};
  const token=String(input.apiKey||'').trim();
  if(!token||token.length>4096||/\s/.test(token)||!config.buyer||!config.seller||config.buyer===config.seller)throw new ValidationError('Enter both trading partner IDs and a test API key.');
  const meta=await providers.client(provider,{apiKey:token},transport).transaction(input.transactionId);
  inbound(meta,config);if(meta.senderId!==config.buyer)throw new ValidationError('Choose a validated inbound test purchase order or change for this buyer and seller.');
  return db.transaction(async c=>{
    const state=await access(c,ctx);
    const mapped=(await c.query("SELECT u.name FROM customers u JOIN locations l ON l.workspace_id=u.workspace_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.record_state='ACTIVE' AND l.id=$3 AND l.is_active=1 AND l.custody_agreement_id IS NULL",[ctx.workspaceId,config.customerId,config.locationId])).rows[0];
    if(!mapped)throw new ValidationError('Choose a customer and a warehouse in this inventory.');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[ctx.workspaceId+key]);
    const old=(await c.query('SELECT id,config FROM workspace_connectors WHERE workspace_id=$1 AND connector_key=$2 FOR UPDATE',[ctx.workspaceId,key])).rows[0];
    if(old && Object.entries(config).some(([k,v])=>JSON.parse(old.config)[k]!==v))throw new ValidationError('Use the original relationship mapping when rotating its key.');
    const id=old?.id||newId('con'),capacity=require('../commercial/connection-capacity'),at=nowIso();
    await capacity.assertActivation(c,{accountId:state.accountId,workspaceId:ctx.workspaceId},'orderful',old?await capacity.activationDelta(c,ctx.workspaceId,id):1);
    if(old)await c.query("UPDATE workspace_connectors SET status='connected',setup_status='CONNECTED',paused_at=NULL,updated_at=$3,credential_ref=$4 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,at,'connection_credentials:'+id]);
    else await c.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,
      credential_ref,setup_status,authorized_by_user_id,created_at,updated_at,expected_interval_minutes) VALUES($1,$2,$3,'Orderful test','orderful','["edi"]',$4,'connected','["850","855","856","810"]',$5,'CONNECTED',$6,$7,$7,0)`,
    [id,ctx.workspaceId,key,JSON.stringify(config),'connection_credentials:'+id,ctx.actorId,at]);
    await credentials.put(c,ctx.workspaceId,id,'provider',{apiKey:token});
    // The relationship's own buyer is the first retailer. The owner decides later whether StockChief acts for it alone.
    await c.query(`INSERT INTO ${RETAILERS}(workspace_id,connector_id,partner_id,name,customer_id,location_id,currency,authorized_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[ctx.workspaceId,id,config.buyer,mapped.name.slice(0,120),config.customerId,config.locationId,config.currency,ctx.actorId]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// The owner sets up one retailer, changes it, or stops it.
async function saveRetailer(db,ctx,input={}){
  return db.transaction(async c=>{
    await access(c,ctx);const con=await connection(c,ctx);
    const partner=String(input.partnerId||'').trim();
    if(!/^[A-Za-z0-9._:\-]{1,80}$/.test(partner))throw new ValidationError('Enter the retailer’s EDI ID, as its EDI network shows it.');
    if(partner===con.seller)throw new ValidationError('That is your own EDI ID. Enter the retailer’s.');
    const prior=(await c.query(`SELECT * FROM ${RETAILERS} WHERE workspace_id=$1 AND connector_id=$2 AND partner_id=$3 FOR UPDATE`,[ctx.workspaceId,con.id,partner])).rows[0];
    if(prior&&String(input.revision??'')!==String(prior.revision))throw new ValidationError('This retailer changed. Reload the page before saving it.');
    if(input.stop==='yes'){
      if(!prior?.enabled)throw new ValidationError('This retailer is not set up.');
      await c.query(`UPDATE ${RETAILERS} SET enabled=false,automatic=false,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND connector_id=$2 AND partner_id=$3`,[ctx.workspaceId,con.id,partner]);
      await audit.record(c,ctx,{action:'Retailer EDI settings saved',reference:partner,before:{enabled:true,automatic:prior.automatic},after:{enabled:false}});
      return {stopped:true};
    }
    const name=String(input.name||'').trim().replace(/\s+/g,' ');
    if(!name||name.length>120)throw new ValidationError('Name the retailer in up to 120 characters.');
    const currency=money.code(input.currency);
    const target=await c.query("SELECT 1 FROM customers u JOIN locations l ON l.workspace_id=u.workspace_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.record_state='ACTIVE' AND l.id=$3 AND l.is_active=1 AND l.custody_agreement_id IS NULL",[ctx.workspaceId,String(input.customerId||''),String(input.locationId||'')]);
    if(!target.rowCount)throw new ValidationError('Choose a customer and a warehouse in this inventory.');
    const automatic=input.automatic==='yes';
    const limit=String(input.maxOrder??'').trim()?money.userToMinor(input.maxOrder,currency,{label:'Largest order'}):null;
    if(limit!==null&&limit<=0)throw new ValidationError('The largest order must be more than zero.');
    if(automatic){
      await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
      if(limit===null)throw new ValidationError('Set the largest order StockChief may confirm on its own for this retailer.');
      if(!(prior?.enabled&&prior.automatic))await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    }
    await c.query(`INSERT INTO ${RETAILERS} AS r(workspace_id,connector_id,partner_id,name,customer_id,location_id,currency,automatic,max_order_minor,authorized_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,connector_id,partner_id) DO UPDATE SET name=excluded.name,customer_id=excluded.customer_id,
      location_id=excluded.location_id,currency=excluded.currency,automatic=excluded.automatic,max_order_minor=excluded.max_order_minor,enabled=true,
      authorized_by=excluded.authorized_by,revision=r.revision+1,updated_at=clock_timestamp()`,
    [ctx.workspaceId,con.id,partner,name,input.customerId,input.locationId,currency,automatic,limit,ctx.actorId]);
    // Documents that waited for this retailer to be set up are read again.
    await c.query('UPDATE stockchief_runtime.orderful_inbox SET issue=NULL WHERE workspace_id=$1 AND sender_id=$2 AND completed_at IS NULL AND issue IS NOT NULL',[ctx.workspaceId,partner]);
    await audit.record(c,ctx,{action:'Retailer EDI settings saved',reference:partner,
      before:prior?{name:prior.name,customerId:prior.customer_id,locationId:prior.location_id,currency:prior.currency,automatic:prior.automatic,maxOrderMinor:prior.max_order_minor,enabled:prior.enabled}:{},
      after:{name,customerId:input.customerId,locationId:input.locationId,currency,automatic,maxOrderMinor:limit}});
    return {saved:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function receive(db,ctx,transactionId,transport,{automatic=false}={}){
  await access(db,ctx);const con=await connection(db,ctx),provider=await remote(db,ctx,con,transport);
  const meta=await provider.transaction(transactionId);inbound(meta,con);
  await retailerFor(db,ctx,con,meta.senderId);
  const download=await provider.message(transactionId),msg=download.message||download;
  if(!msg.purchaseOrderNumber||msg.purchaseOrderNumber!==meta.businessNumber)throw new ValidationError('The downloaded document does not match the retailer PO number.');
  return db.transaction(async c=>{
    await access(c,ctx);await connection(c,ctx);const retailer=await retailerFor(c,ctx,con,meta.senderId);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[con.id+msg.purchaseOrderNumber]);
    const old=(await c.query('SELECT * FROM stockchief_runtime.orderful_orders WHERE connector_id=$1 AND purchase_order_number=$2 FOR UPDATE',[con.id,msg.purchaseOrderNumber])).rows[0];
    // Mark a manually retried inbox entry in the same transaction as the imported business record.
    await c.query('UPDATE stockchief_runtime.orderful_inbox SET completed_at=coalesce(completed_at,now()),issue=NULL WHERE workspace_id=$1 AND transaction_id=$2',[ctx.workspaceId,transactionId]);
    if(meta.ediTransactionType==='860_PURCHASE_ORDER_CHANGE'){
      if(!old)throw new ValidationError('Import the original purchase order first.');
      if((old.retailer_id||con.buyer)!==retailer.partner_id)throw new ValidationError('A different retailer sent a change to this PO. Check it with the retailer.');
      const stored=await c.query('INSERT INTO stockchief_runtime.orderful_changes(workspace_id,source_id,transaction_id,message) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING transaction_id',
        [ctx.workspaceId,old.source_id,transactionId,JSON.stringify(msg)]);
      if(!stored.rowCount)return {orderId:old.sales_order_id,held:true,replayed:true};
      await c.query('UPDATE stockchief_runtime.orderful_orders SET superseding_message_id=$3 WHERE workspace_id=$1 AND source_id=$2',[ctx.workspaceId,old.source_id,transactionId]);
      return {orderId:old.sales_order_id,held:true};
    }
    if(old){if(old.source_id!==transactionId)throw new ValidationError('A different transaction already uses this retailer PO.');return {orderId:old.sales_order_id,replayed:true};}
    if(msg.purpose!=='original'||msg.purchaseOrderType!=='standalone'||!Array.isArray(msg.lineItems)||!msg.lineItems.length||msg.lineItems.length>500)
      throw new ValidationError('This importer supports original standalone retailer purchase orders with up to 500 lines.');
    if((msg.buyersCurrency && msg.buyersCurrency!==retailer.currency)||msg.allowances?.length||msg.charges?.length)
      throw new ValidationError('The retailer currency, charges or allowances need a separate pricing review.');
    const ship=msg.parties?.shipTo;
    if(!ship?.addressLine1||!ship.city||!ship.postalCode||!ship.countryCode)throw new ValidationError('The retailer PO needs an explicit ship-to address.');
    if(msg.lineItems.some(l=>!l.purchaseOrderLineId||l.quantity?.unitOfMeasure!=='each'||!/^\d+$/.test(l.quantity.value)||Number(l.quantity.value)<=0||
      l.allowances?.length||l.charges?.length||!l.productIds||!Number.isSafeInteger(Number(l.quantity.value))))throw new ValidationError('Review unsupported units, allowances or incomplete order lines.');
    if(new Set(msg.lineItems.map(l=>l.purchaseOrderLineId)).size!==msg.lineItems.length)throw new ValidationError('Retailer order line numbers must be unique.');
    const codes=msg.lineItems.map(l=>l.productIds.vendorItemNumber||''),gtins=msg.lineItems.flatMap(l=>[l.productIds.gtin12,l.productIds.gtin13,l.productIds.gtin14].filter(Boolean));
    const skus=(await c.query('SELECT s.id,s.code,s.barcode FROM skus s JOIN items i ON i.id=s.item_id WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND (s.code=ANY($2) OR s.barcode=ANY($3))',[ctx.workspaceId,codes,gtins])).rows;
    const lines=msg.lineItems.map(l=>{
      const ids=l.productIds,barcodes=[ids.gtin12,ids.gtin13,ids.gtin14].filter(Boolean);
      const matches=skus.filter(s=>(ids.vendorItemNumber&&ids.vendorItemNumber===s.code)||barcodes.includes(s.barcode));
      if(matches.length!==1)throw new ValidationError('Match a unique vendor SKU or GTIN for retailer line '+l.purchaseOrderLineId+'.');
      return {skuId:matches[0].id,quantity:Number(l.quantity.value),unitPriceMinor:money.toMinor(l.unitCostPrice,retailer.currency),externalLineId:l.purchaseOrderLineId};
    });
    const sale=await require('../operations/postgres-business-workflows').createSalesOrderInTransaction(c,ctx,{customerId:retailer.customer_id,fulfillmentLocationId:retailer.location_id,
      deliveryMethod:'SHIP',shipToAddress:[ship.name,ship.addressLine1,ship.addressLine2,ship.city,ship.stateOrProvinceCode,ship.postalCode,ship.countryCode].filter(Boolean).join(', '),
      orderDate:msg.purchaseOrderDate,currency:retailer.currency,reference:msg.purchaseOrderNumber,idempotencyKey:'orderful-test:'+transactionId,lines});
    await c.query('INSERT INTO stockchief_runtime.orderful_orders(workspace_id,source_id,connector_id,purchase_order_number,sales_order_id,original_message,retailer_line_skus,retailer_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)',
      [ctx.workspaceId,transactionId,con.id,msg.purchaseOrderNumber,sale.salesOrderId,JSON.stringify(msg),JSON.stringify(Object.fromEntries(lines.map(l=>[l.externalLineId,l.skuId]))),retailer.partner_id]);
    await audit.record(c,ctx,{action:IMPORTED,reference:sale.salesOrderId,after:{automatic,retailer:retailer.name,purchaseOrder:msg.purchaseOrderNumber,lines:lines.length}});
    return {orderId:sale.salesOrderId,retailer:retailer.partner_id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Why a retailer order needs a person to confirm it, or null. Only records decide:
// the owner's limit, a ship-to used before, and the price on the retailer's last confirmed order.
async function confirmationCheck(db,ctx,record,retailer){
  if(!retailer.automatic||retailer.max_order_minor==null)return 'You confirm this retailer’s orders yourself.';
  const order=(await db.query('SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,record.sales_order_id])).rows[0];
  if(order.customer_id!==retailer.customer_id||order.currency!==retailer.currency)return 'The order no longer matches the retailer’s customer or currency.';
  const lines=(await db.query(`SELECT l.sku_id,l.quantity_ordered,l.unit_price_minor,s.code FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY l.id`,[ctx.workspaceId,order.id])).rows;
  const total=money.sum(lines.map(l=>{const n=Number(l.quantity_ordered)*Number(l.unit_price_minor);if(!Number.isSafeInteger(n))throw new ValidationError('The order total is outside the supported range.');return n;}));
  if(total>Number(retailer.max_order_minor))return 'This order is '+money.format(total,order.currency)+', over your limit of '+money.format(retailer.max_order_minor,order.currency)+' for '+retailer.name+'.';
  const known=await db.query(`SELECT 1 FROM sales_orders o WHERE o.workspace_id=$1 AND o.customer_id=$2 AND o.id<>$3 AND o.delivery_method='SHIP'
    AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED') AND lower(trim(o.ship_to_address))=lower(trim($4::text)) LIMIT 1`,[ctx.workspaceId,order.customer_id,order.id,order.ship_to_address]);
  if(!known.rowCount)return 'This order ships to a new address for '+retailer.name+'. A person confirms the first order to a new ship-to.';
  for(const line of lines){
    const last=(await db.query(`SELECT l.unit_price_minor FROM sales_order_lines l JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
      WHERE l.workspace_id=$1 AND o.customer_id=$2 AND o.id<>$3 AND l.sku_id=$4 AND o.currency=$5 AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED')
      ORDER BY o.confirmed_at DESC NULLS LAST,o.id DESC LIMIT 1`,[ctx.workspaceId,order.customer_id,order.id,line.sku_id,order.currency])).rows[0];
    if(!last)return 'This is the first order of '+line.code+' from '+retailer.name+'. A person confirms it.';
    if(Number(last.unit_price_minor)!==Number(line.unit_price_minor))return retailer.name+' pays '+money.format(line.unit_price_minor,order.currency)+' for '+line.code+'; its last confirmed order paid '+money.format(last.unit_price_minor,order.currency)+'.';
  }
  return null;
}
async function confirmAlone(db,ctx,record,retailer){
  const reason=await confirmationCheck(db,ctx,record,retailer);
  const hold=text=>db.query('UPDATE stockchief_runtime.orderful_orders SET hold_reason=$3 WHERE workspace_id=$1 AND source_id=$2',[ctx.workspaceId,record.source_id,text]);
  if(reason){await hold(reason);return {held:reason};}
  try{
    await require('../operations/postgres-business-workflows').confirmSalesOrder(db,ctx,record.sales_order_id,{idempotencyKey:'edi-confirm:'+record.source_id,requireFullAllocation:true});
  }catch(error){if(error.code!=='validation_error')throw error;await hold(error.message);return {held:error.message};}
  await hold(null);
  await audit.record(db,ctx,{action:CONFIRMED,reference:record.sales_order_id,after:{automatic:true,retailer:retailer.name,purchaseOrder:record.purchase_order_number,limitMinor:Number(retailer.max_order_minor)}});
  return {confirmed:true};
}

async function outbound(db,ctx,sourceId,kind,recordId){
  await access(db,ctx);
  const con=await connection(db,ctx);
  const record=(await db.query(`SELECT e.*,o.status AS order_status,o.currency,coalesce(r.currency,$4) AS agreed_currency,coalesce(e.retailer_id,$5) AS buyer,r.name AS retailer_name
    FROM stockchief_runtime.orderful_orders e JOIN sales_orders o ON o.id=e.sales_order_id
    LEFT JOIN ${RETAILERS} r ON r.workspace_id=e.workspace_id AND r.connector_id=e.connector_id AND r.partner_id=coalesce(e.retailer_id,$5)
    WHERE e.workspace_id=$1 AND e.source_id=$2 AND e.connector_id=$3`,[ctx.workspaceId,sourceId,con.id,con.currency,con.buyer])).rows[0];
  if(!record)throw new NotFoundError('This retailer order does not exist.');
  if(record.superseding_message_id)throw new ValidationError('The retailer changed this order. Reconcile the change before sending any document.');
  const currency=record.agreed_currency;
  if(record.currency!==currency || !['CONFIRMED','PARTIALLY_FULFILLED','FULFILLED'].includes(record.order_status))throw new ValidationError('Confirm and reconcile the sales order before responding.');
  const original=record.original_message,originalLines=new Map(original.lineItems.map(l=>[l.purchaseOrderLineId,l]));
  const saleLines=(await db.query('SELECT id,sku_id,external_line_id,quantity_ordered,unit_price_minor FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2 ORDER BY id',[ctx.workspaceId,record.sales_order_id])).rows;
  if(saleLines.length!==originalLines.size||saleLines.some(s=>{const l=originalLines.get(s.external_line_id);return !l||record.retailer_line_skus[s.external_line_id]!==s.sku_id||Number(s.quantity_ordered)!==Number(l.quantity.value)||Number(s.unit_price_minor)!==money.toMinor(l.unitCostPrice,currency);}))
    throw new ValidationError('The order items, quantities or prices changed. Reconcile with the retailer first.');
  const po=record.purchase_order_number,common=l=>({purchaseOrderLineId:l.purchaseOrderLineId,productIds:l.productIds}),qty=n=>({value:String(n),unitOfMeasure:'each'});
  let document;
  if(kind==='ack'){
    if(recordId!==record.sales_order_id)throw new ValidationError('Choose the source sales order.');
    document={purchaseOrderNumber:po,status:'accepted',lineItems:original.lineItems.map(l=>({...common(l),actions:[{status:'accepted',quantity:l.quantity,unitCostPrice:l.unitCostPrice}]}))};
  }else if(kind==='ship'){
    const ship=(await db.query("SELECT * FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2 AND id=$3 AND status IN ('SHIPPED','DELIVERED') AND shipped_at IS NOT NULL",[ctx.workspaceId,record.sales_order_id,recordId])).rows[0];
    if(!ship)throw new ValidationError('A recorded shipment handoff is required for this advance ship notice.');
    const rows=(await db.query('SELECT l.external_line_id,sum(x.quantity) AS shipped FROM sales_shipment_lines x JOIN sales_order_lines l ON l.id=x.sales_order_line_id WHERE x.workspace_id=$1 AND x.shipment_id=$2 GROUP BY l.external_line_id ORDER BY l.external_line_id',[ctx.workspaceId,recordId])).rows;
    if(!rows.length||rows.some(r=>!originalLines.has(r.external_line_id)))throw new ValidationError('Match each shipment line to its retailer PO line.');
    const day=await require('../lib/business-time').today(db,ctx.workspaceId,new Date(ship.shipped_at));
    document={purpose:'original',shipmentId:ship.shipment_number,dates:{shipDate:day},...(ship.tracking_number?{references:{trackingNumber:ship.tracking_number}}:{}),
      orders:[{purchaseOrderNumber:po,items:rows.map(r=>({...common(originalLines.get(r.external_line_id)),quantityShipped:qty(r.shipped)}))}]};
  }else if(kind==='invoice'){
    if(record.order_status!=='FULFILLED')throw new ValidationError('Complete fulfillment before sending the final invoice.');
    const bill=(await db.query("SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2 AND id=$3 AND status IN ('OPEN','PARTIALLY_PAID','PAID')",[ctx.workspaceId,record.sales_order_id,recordId])).rows[0];
    if(!bill||bill.currency!==record.currency||Number(bill.discount_minor)||Number(bill.tax_minor)||Number(bill.charges_minor))throw new ValidationError('A posted, reconciled invoice with supported taxes and charges is required.');
    const rows=(await db.query(`SELECT l.external_line_id,x.unit_price_minor,sum(x.quantity) AS quantity,sum(x.line_total_minor) AS total
      FROM accounting_customer_invoice_lines x JOIN sales_order_lines l ON l.id=x.sales_order_line_id WHERE x.workspace_id=$1 AND x.invoice_id=$2
      GROUP BY l.external_line_id,x.unit_price_minor ORDER BY l.external_line_id`,[ctx.workspaceId,recordId])).rows;
    if(!rows.length||rows.some(r=>!originalLines.has(r.external_line_id)||Number(r.total)!==Number(r.quantity)*Number(r.unit_price_minor))||
      money.sum(rows.map(r=>r.total))!==Number(bill.total_minor))throw new ValidationError('Invoice lines do not reconcile to the retailer invoice total.');
    document={invoiceNumber:bill.invoice_number,invoiceDate:bill.issue_date,purchaseOrderNumber:po,invoiceTotal:money.fromMinor(bill.total_minor,bill.currency),
      lineItems:rows.map(r=>({...common(originalLines.get(r.external_line_id)),quantityInvoiced:qty(r.quantity),unitPrice:money.fromMinor(r.unit_price_minor,bill.currency)}))};
  }else throw new ValidationError('Choose an acknowledgment, ship notice or invoice.');
  return {con,document,buyer:record.buyer,orderId:record.sales_order_id,po,retailer:record.retailer_name||record.buyer};
}
// A scheduled send checks, right before the document leaves, that the rule, the retailer and StockChief's authority still allow it.
async function sendAllowed(db,ctx,generation,buyer){
  const rule=await activeRule(db,ctx,generation);const con=await connection(db,ctx);
  const retailer=await retailerFor(db,ctx,con,buyer);
  if(!retailer.automatic)throw new ValidationError('You send this retailer’s documents yourself.');
  const stop=await automaticStop(db,ctx.workspaceId);if(stop)throw new ValidationError(stop);
  return rule;
}
async function send(db,ctx,id,kind,recordId,transport,generation){
  const payload=await db.transaction(async c=>{
    const {document,con,buyer,orderId,po,retailer}=await outbound(c,ctx,id,kind,recordId);
    if(kind!=='ack'){
      const ack=await c.query("SELECT 1 FROM stockchief_runtime.orderful_outbound WHERE workspace_id=$1 AND source_id=$2 AND kind='ack' AND status IN ('ACCEPTED','DELIVERED','ACKNOWLEDGED')",[ctx.workspaceId,id]);
      if(!ack.rowCount)throw new ValidationError('Send and verify the acknowledgment before this document.');
    }
    if(kind==='invoice'){
      const covered=(await c.query(`SELECT count(*) AS shipped,count(outbound.record_id) AS notices FROM sales_shipments s
        JOIN stockchief_runtime.orderful_orders o ON o.sales_order_id=s.sales_order_id AND o.workspace_id=s.workspace_id
        LEFT JOIN stockchief_runtime.orderful_outbound outbound ON outbound.workspace_id=o.workspace_id AND outbound.source_id=o.source_id AND outbound.kind='ship'
          AND outbound.record_id=s.id AND outbound.status IN ('ACCEPTED','DELIVERED','ACKNOWLEDGED')
        WHERE o.workspace_id=$1 AND o.source_id=$2 AND s.status IN ('SHIPPED','DELIVERED')`,[ctx.workspaceId,id])).rows[0];
      if(Number(covered.shipped)===0||covered.shipped!==covered.notices)throw new ValidationError('Verify the ship notices for every recorded shipment before invoicing.');
    }
    const receipt=await c.query(`INSERT INTO stockchief_runtime.orderful_outbound(workspace_id,source_id,kind,record_id,message,status) VALUES($1,$2,$3,$4,$5,'SUBMITTING')
      ON CONFLICT DO NOTHING RETURNING record_id`,[ctx.workspaceId,id,kind,recordId,JSON.stringify(document)]);
    return {con,document,buyer,orderId,po,retailer,already:!receipt.rowCount};
  },{isolation:'SERIALIZABLE',retrySafe:true});
  if(payload.already)return {alreadySubmitted:true};
  let provider;
  try{
    const latest=await outbound(db,ctx,id,kind,recordId);
    if(!require('node:util').isDeepStrictEqual(payload.document,latest.document))throw new ValidationError('The source record changed. Review it again before sending.');
    provider=await remote(db,ctx,latest.con,transport);
    if(generation)await sendAllowed(db,ctx,generation,payload.buyer);
  }catch(error){
    // No submission was attempted. A later authorized request can safely rebuild the document.
    await db.query("DELETE FROM stockchief_runtime.orderful_outbound WHERE workspace_id=$1 AND source_id=$2 AND kind=$3 AND record_id=$4 AND status='SUBMITTING' AND provider_id IS NULL AND provider_uuid IS NULL",[ctx.workspaceId,id,kind,recordId]);
    throw error;
  }
  const response=await provider.send(types[kind],payload.con.seller,payload.buyer,payload.document);
  await db.query('UPDATE stockchief_runtime.orderful_outbound SET status=$5,provider_id=$6,updated_at=now() WHERE workspace_id=$1 AND source_id=$2 AND kind=$3 AND record_id=$4',[ctx.workspaceId,id,kind,recordId,response.status,response.id]);
  await audit.record(db,ctx,{action:SENT,reference:payload.orderId,after:{automatic:Boolean(generation),document:labels[kind],kind,record:recordId,
    purchaseOrder:payload.po,retailer:payload.retailer,status:response.status,providerId:response.id}});
  return response;
}
async function reconcile(db,ctx,sourceId,kind,recordId,providerUuid,transport){
  await access(db,ctx);
  const con=await connection(db,ctx),provider=await remote(db,ctx,con,transport);
  const saved=(await db.query(`SELECT o.*,coalesce(e.retailer_id,$6) AS buyer FROM stockchief_runtime.orderful_outbound o JOIN stockchief_runtime.orderful_orders e USING(workspace_id,source_id)
    WHERE o.workspace_id=$1 AND o.source_id=$2 AND o.kind=$3 AND o.record_id=$4 AND e.connector_id=$5`,[ctx.workspaceId,sourceId,kind,recordId,con.id,con.buyer])).rows[0];
  if(!saved)throw new NotFoundError('This submission was not found.');
  const meta=await provider.transaction(providerUuid);
  if(meta.direction!=='out'||meta.senderId!==con.seller||meta.receiverId!==saved.buyer||meta.ediTransactionType!==types[kind] ||
    (saved.provider_uuid && saved.provider_uuid!==providerUuid))throw new ValidationError('The outbound transaction does not match this test relationship.');
  const downloaded=await provider.message(providerUuid);
  if(!require('node:util').isDeepStrictEqual(saved.message,downloaded.message||downloaded))throw new ValidationError('The Orderful transaction differs from the document that StockChief submitted.');
  const failed=meta.validationStatus==='INVALID'||meta.deliveryStatus==='FAILED'||['REJECTED','ACCEPTED_WITH_ERRORS'].includes(meta.acknowledgmentStatus);
  const delivered=meta.validationStatus==='VALID'&&meta.deliveryStatus==='DELIVERED';
  const status=failed?'REJECTED':delivered&&meta.acknowledgmentStatus==='ACCEPTED'?'ACKNOWLEDGED':delivered?'DELIVERED':'ACCEPTED';
  await db.query('UPDATE stockchief_runtime.orderful_outbound SET status=$5,provider_uuid=$6,updated_at=now() WHERE workspace_id=$1 AND source_id=$2 AND kind=$3 AND record_id=$4',[ctx.workspaceId,sourceId,kind,recordId,status,providerUuid]);
  return {status};
}
async function dashboard(db,ctx,scheduled=false){
  const state=await require('../autopilot/job-reviews').ownerState(db,ctx);
  let enabled=true;
  try{await access(db,ctx);}catch(e){if(e.code!=='entitlement_required')throw e;enabled=false;}
  const linked=(await db.query("SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND connector_key=$2 AND status='connected' AND paused_at IS NULL",[ctx.workspaceId,key])).rows[0];
  if(!enabled)return {enabled,linked,plan:state.plan};
  const customers=(await db.query("SELECT id,name FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' ORDER BY name,id LIMIT 500",[ctx.workspaceId])).rows;
  const locations=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL ORDER BY name,id',[ctx.workspaceId])).rows;
  const buyer=linked?(await connection(db,ctx)).buyer:null;
  const records=(await db.query(`SELECT e.source_id,e.sales_order_id,e.purchase_order_number,e.superseding_message_id,e.hold_reason,coalesce(e.retailer_id,$3) AS retailer_id,r.name AS retailer_name,
    r.automatic AS retailer_automatic,o.order_number,o.status,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('transaction',ch.transaction_id,'purpose',ch.message->>'purpose','received',ch.received_at) ORDER BY ch.received_at),'[]') FROM stockchief_runtime.orderful_changes ch WHERE ch.workspace_id=e.workspace_id AND ch.source_id=e.source_id) AS changes,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('kind',x.kind,'id',x.record_id,'status',x.status,'remote',x.provider_id,'uuid',x.provider_uuid) ORDER BY x.kind,x.record_id),'[]') FROM stockchief_runtime.orderful_outbound x WHERE x.workspace_id=e.workspace_id AND x.source_id=e.source_id) AS submitted,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'number',s.shipment_number) ORDER BY s.shipped_at),'[]') FROM sales_shipments s WHERE s.workspace_id=e.workspace_id AND s.sales_order_id=e.sales_order_id AND s.status IN ('SHIPPED','DELIVERED')) AS shipments,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'number',b.invoice_number) ORDER BY b.issue_date),'[]') FROM accounting_customer_invoices b WHERE b.workspace_id=e.workspace_id AND b.sales_order_id=e.sales_order_id AND b.status IN ('OPEN','PARTIALLY_PAID','PAID')) AS invoices
    FROM stockchief_runtime.orderful_orders e JOIN sales_orders o ON o.id=e.sales_order_id
    LEFT JOIN ${RETAILERS} r ON r.workspace_id=e.workspace_id AND r.connector_id=e.connector_id AND r.partner_id=coalesce(e.retailer_id,$3)
    WHERE e.workspace_id=$1 AND (NOT $2::boolean OR (e.superseding_message_id IS NULL AND o.status IN ('DRAFT','CONFIRMED','PARTIALLY_FULFILLED','FULFILLED')))
    ORDER BY CASE WHEN $2 THEN e.last_polled_at END ASC NULLS FIRST,e.received_at DESC,e.source_id LIMIT CASE WHEN $2 THEN 25 ELSE 100 END`,[ctx.workspaceId,scheduled,buyer])).rows;
  const rule=(await db.query('SELECT checked_through,next_at,last_issue FROM stockchief_runtime.orderful_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
  const issues=(await db.query('SELECT transaction_id,business_number,sender_id,issue FROM stockchief_runtime.orderful_inbox WHERE workspace_id=$1 AND issue IS NOT NULL AND completed_at IS NULL ORDER BY opened_at LIMIT 100',[ctx.workspaceId])).rows;
  const retailers=linked?(await db.query(`SELECT r.*,u.name AS customer_name,l.name AS location_name FROM ${RETAILERS} r JOIN customers u ON u.workspace_id=r.workspace_id AND u.id=r.customer_id
    JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id WHERE r.workspace_id=$1 AND r.connector_id=$2 ORDER BY r.enabled DESC,r.name,r.partner_id`,[ctx.workspaceId,linked.id])).rows
    .map(r=>({...r,max_order:r.max_order_minor==null?'':money.fromMinor(r.max_order_minor,r.currency)})):[];
  const automatic=policy.permits(state.plan,JOB,'automatic',{edi:true});
  const stop=linked&&!scheduled?await automaticStop(db,ctx.workspaceId,state):null;
  return {enabled,linked,plan:state.plan,customers,locations,records,rule,issues,retailers,automatic,stop};
}
async function disconnect(db,ctx){
  await db.transaction(async c=>{
    await require('../autopilot/job-reviews').ownerState(c,ctx);
    await c.query('DELETE FROM stockchief_runtime.orderful_rules WHERE workspace_id=$1',[ctx.workspaceId]);
    const con=await connection(c,ctx);await credentials.remove(c,ctx.workspaceId,con.id);
    await c.query("UPDATE workspace_connectors SET status='disconnected',setup_status='DISCONNECTED',credential_ref=NULL,paused_at=$3,updated_at=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,con.id,nowIso()]);
  });
}
async function configure(db,ctx,action){
  await require('../autopilot/job-reviews').ownerState(db,ctx);
  if(action==='disable'){await db.query('DELETE FROM stockchief_runtime.orderful_rules WHERE workspace_id=$1',[ctx.workspaceId]);return;}
  if(action!=='enable')throw new ValidationError('Choose whether to poll this relationship.');
  await access(db,ctx);await connection(db,ctx);
  await db.query(`INSERT INTO stockchief_runtime.orderful_rules(workspace_id,actor_id,generation,checked_through) VALUES($1,$2,$3,now())
    ON CONFLICT(workspace_id) DO NOTHING`,[ctx.workspaceId,ctx.actorId,newId('rule')]);
}
async function schedule(c){
  const rules=(await c.query('SELECT * FROM stockchief_runtime.orderful_rules WHERE next_at<=now() ORDER BY next_at LIMIT 50 FOR UPDATE SKIP LOCKED')).rows;
  const scoped={query:c.query.bind(c),transaction:fn=>fn(c)};
  for(const r of rules){
    await require('../operations/postgres-job-queue').enqueue(scoped,{kind:'orderful.test-inbox',workspaceId:r.workspace_id,
      payload:{actorId:r.actor_id,generation:r.generation},idempotencyKey:r.generation+'/'+r.next_at.toISOString()});
    await c.query("UPDATE stockchief_runtime.orderful_rules SET next_at=now()+interval '5 minutes' WHERE workspace_id=$1",[r.workspace_id]);
  }
}
// The owner's scheduled EDI is still on and the plan still allows it. Reading the
// retailers' documents changes nothing; what StockChief may then do is checked step by step.
async function activeRule(db,ctx,generation){
  await access(db,ctx);
  const rule=(await db.query('SELECT * FROM stockchief_runtime.orderful_rules WHERE workspace_id=$1 AND actor_id=$2 AND generation=$3',[ctx.workspaceId,ctx.actorId,generation])).rows[0];
  if(!rule)throw new ValidationError('The owner disabled this retailer rule.');
  return rule;
}
async function poll(db,job,transport){
  const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId},g=job.payload.generation;
  const rule=await activeRule(db,ctx,g),con=await connection(db,ctx),provider=await remote(db,ctx,con,transport);
  const end=(rule.window_end||new Date()).toISOString();
  const page=await provider.inbox({seller:con.seller},rule.checked_through.toISOString(),end,rule.next_cursor);
  await db.transaction(async c=>{
    await activeRule(c,ctx,g);
    const lock=(await c.query('SELECT * FROM stockchief_runtime.orderful_rules WHERE workspace_id=$1 AND generation=$2 FOR UPDATE',[ctx.workspaceId,g])).rows[0];
    if(!lock||lock.checked_through.getTime()!==rule.checked_through.getTime()||lock.next_cursor!==rule.next_cursor)return;
    for(const meta of page.items){
      if(!['850_PURCHASE_ORDER','860_PURCHASE_ORDER_CHANGE'].includes(meta.ediTransactionType))continue;
      let issue=null;try{inbound(meta,con);}catch(e){issue=e.message;}
      await c.query('INSERT INTO stockchief_runtime.orderful_inbox(workspace_id,transaction_id,business_number,kind,opened_at,sender_id,issue) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
        [ctx.workspaceId,meta.id,meta.businessNumber,meta.ediTransactionType,meta.createdAt,meta.senderId||null,issue]);
    }
    await c.query(`UPDATE stockchief_runtime.orderful_rules SET checked_through=CASE WHEN $3::text IS NULL THEN $4::timestamptz ELSE checked_through END,
      next_cursor=$3,window_end=CASE WHEN $3 IS NULL THEN NULL ELSE $4::timestamptz END WHERE workspace_id=$1 AND generation=$2`,[ctx.workspaceId,g,page.nextCursor,end]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
  // All pages must be collected before replaying a chronological window. A change must never precede its original order.
  if(page.nextCursor)return {more:true};
  const state=await policy.accountState(db,ctx.workspaceId);
  const reading=await importStop(db,ctx.workspaceId,state),stop=await automaticStop(db,ctx.workspaceId,state);
  const note=text=>db.query('UPDATE stockchief_runtime.orderful_rules SET last_issue=$3 WHERE workspace_id=$1 AND generation=$2',[ctx.workspaceId,g,text]);
  await note(reading||stop);
  let processed=0;
  if(!reading){
    const incoming=(await db.query(`SELECT transaction_id,sender_id FROM stockchief_runtime.orderful_inbox WHERE workspace_id=$1 AND completed_at IS NULL AND issue IS NULL
      ORDER BY opened_at,kind,transaction_id LIMIT 25`,[ctx.workspaceId])).rows;
    const known=new Set((await db.query(`SELECT partner_id FROM ${RETAILERS} WHERE workspace_id=$1 AND connector_id=$2 AND enabled`,[ctx.workspaceId,con.id])).rows.map(r=>r.partner_id));
    for(const row of incoming){
      await activeRule(db,ctx,g);
      if(row.sender_id&&!known.has(row.sender_id)){
        await db.query('UPDATE stockchief_runtime.orderful_inbox SET issue=$3 WHERE workspace_id=$1 AND transaction_id=$2',[ctx.workspaceId,row.transaction_id,unknownRetailer(row.sender_id)]);continue;
      }
      try{await receive(db,ctx,row.transaction_id,transport,{automatic:true});processed++;}
      catch(e){if(e.code!=='validation_error')throw e;await db.query('UPDATE stockchief_runtime.orderful_inbox SET issue=$3 WHERE workspace_id=$1 AND transaction_id=$2',[ctx.workspaceId,row.transaction_id,e.message]);}
    }
  }
  // An unread or unresolved document for a PO takes priority over any outgoing document for it.
  const waiting=new Set((await db.query('SELECT business_number FROM stockchief_runtime.orderful_inbox WHERE workspace_id=$1 AND completed_at IS NULL',[ctx.workspaceId])).rows.map(r=>r.business_number));
  if(stop)return {processed,held:true,reason:stop};
  const data=await dashboard(db,ctx,true),retailers=new Map(data.retailers.filter(r=>r.enabled).map(r=>[r.partner_id,r]));
  let confirmed=0,sent=0;
  for(const order of data.records){
    // Every order visited moves to the back of the queue, so no retailer's orders crowd out another's.
    await db.query('UPDATE stockchief_runtime.orderful_orders SET last_polled_at=now() WHERE workspace_id=$1 AND source_id=$2',[ctx.workspaceId,order.source_id]);
    if(waiting.has(order.purchase_order_number))continue;
    const retailer=retailers.get(order.retailer_id);
    if(!retailer?.automatic)continue;
    if(order.status==='DRAFT'){
      // An order left for a person stays with them; they confirm it on the order.
      if(order.hold_reason)continue;
      await activeRule(db,ctx,g);
      if(!(await confirmAlone(db,ctx,order,retailer)).confirmed)continue;
      confirmed++;order.status='CONFIRMED';
    }
    const actions=[['ack',order.sales_order_id],...order.shipments.map(s=>['ship',s.id]),...(order.status==='FULFILLED'?order.invoices.map(b=>['invoice',b.id]):[])];
    for(const [kind,id] of actions){
      const prior=order.submitted.find(s=>s.kind===kind&&s.id===id);
      if(prior){if(!['ACCEPTED','DELIVERED','ACKNOWLEDGED'].includes(prior.status))break;continue;}
      await activeRule(db,ctx,g);
      try{const result=await send(db,ctx,order.source_id,kind,id,transport,g);sent++;if(result.status!=='ACCEPTED')break;}
      catch(e){if(e.code!=='validation_error')throw e;await note(e.message);break;}
    }
  }
  return {processed,confirmed,sent};
}

// Needs you: what Retail EDI is waiting on a person for.
async function inbox(db,workspaceId){
  if(!await installed.has(db,RETAILERS))return [];
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft',{edi:true}))return [];
  try{await policy.requireWorkspaceJob(db,workspaceId,JOB,'draft');}catch(error){if(error.code==='entitlement_required')return [];throw error;}
  const con=(await db.query("SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND connector_key=$2 AND status='connected' AND paused_at IS NULL",[workspaceId,key])).rows[0];
  if(!con)return [];
  const stop=await automaticStop(db,workspaceId,state);
  const r=(await db.query(`SELECT
    (SELECT count(*) FROM stockchief_runtime.orderful_inbox WHERE workspace_id=$1 AND issue IS NOT NULL AND completed_at IS NULL)::int AS issues,
    (SELECT min(issue) FROM stockchief_runtime.orderful_inbox WHERE workspace_id=$1 AND issue IS NOT NULL AND completed_at IS NULL) AS issue,
    (SELECT count(*) FROM stockchief_runtime.orderful_orders e JOIN sales_orders o ON o.id=e.sales_order_id WHERE e.workspace_id=$1 AND e.superseding_message_id IS NOT NULL AND o.status<>'CANCELLED')::int AS changes,
    (SELECT count(*) FROM stockchief_runtime.orderful_outbound x WHERE x.workspace_id=$1 AND (x.status IN ('FAILED','REJECTED') OR x.status='SUBMITTING' AND x.updated_at<now()-interval '10 minutes'))::int AS uncertain,
    (SELECT count(*) FROM stockchief_runtime.orderful_orders e JOIN sales_orders o ON o.id=e.sales_order_id
      LEFT JOIN ${RETAILERS} r ON r.workspace_id=e.workspace_id AND r.connector_id=e.connector_id AND r.partner_id=e.retailer_id
      WHERE e.workspace_id=$1 AND o.status='DRAFT' AND e.superseding_message_id IS NULL AND (e.hold_reason IS NOT NULL OR $2::boolean OR NOT coalesce(r.automatic,false)))::int AS held,
    (SELECT min(e.hold_reason) FROM stockchief_runtime.orderful_orders e JOIN sales_orders o ON o.id=e.sales_order_id WHERE e.workspace_id=$1 AND o.status='DRAFT' AND e.hold_reason IS NOT NULL AND e.superseding_message_id IS NULL) AS hold_reason,
    (SELECT count(*) FROM stockchief_runtime.orderful_orders e JOIN sales_orders o ON o.id=e.sales_order_id
      LEFT JOIN ${RETAILERS} r ON r.workspace_id=e.workspace_id AND r.connector_id=e.connector_id AND r.partner_id=e.retailer_id
      WHERE e.workspace_id=$1 AND e.superseding_message_id IS NULL AND o.status IN ('CONFIRMED','PARTIALLY_FULFILLED','FULFILLED') AND ($2::boolean OR NOT coalesce(r.automatic,false)) AND (
        NOT EXISTS(SELECT 1 FROM stockchief_runtime.orderful_outbound x WHERE x.workspace_id=e.workspace_id AND x.source_id=e.source_id AND x.kind='ack')
        OR EXISTS(SELECT 1 FROM sales_shipments s WHERE s.workspace_id=e.workspace_id AND s.sales_order_id=e.sales_order_id AND s.status IN ('SHIPPED','DELIVERED')
          AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.orderful_outbound x WHERE x.workspace_id=e.workspace_id AND x.source_id=e.source_id AND x.kind='ship' AND x.record_id=s.id))
        OR o.status='FULFILLED' AND EXISTS(SELECT 1 FROM accounting_customer_invoices b WHERE b.workspace_id=e.workspace_id AND b.sales_order_id=e.sales_order_id AND b.status IN ('OPEN','PARTIALLY_PAID','PAID')
          AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.orderful_outbound x WHERE x.workspace_id=e.workspace_id AND x.source_id=e.source_id AND x.kind='invoice' AND x.record_id=b.id))))::int AS due`,
  [workspaceId,Boolean(stop)])).rows[0];
  const items=[],at=new Date().toISOString(),base={kind:'sales',grouped:true,importance:'Needs You',href,sourceId:'retail-edi',createdAt:at,at};
  const problems=r.issues+r.changes+r.uncertain;
  if(problems)items.push({...base,priority:78,title:problems+' retail EDI '+(problems===1?'document needs':'documents need')+' you',
    happened:r.issue||(r.changes?'A retailer changed an order. Its documents wait until you reconcile the change.':'The EDI network did not confirm or rejected a document.'),
    why:'When facts are missing or do not match, StockChief stops and asks. It never guesses.',recommendation:'Set up the retailer, fix the record, or check the document with the retailer.',actionLabel:'Review retail EDI'});
  if(r.held)items.push({...base,priority:76,title:r.held+' retailer '+(r.held===1?'order waits':'orders wait')+' for you to confirm',
    happened:stop||r.hold_reason||'You confirm this retailer’s orders yourself.',
    why:'A person confirms a retailer order that is over your limit, ships to a new address, changes a price, or comes while StockChief may not act alone.',recommendation:'Check the order, then confirm it on its page.',actionLabel:'Review retailer orders'});
  if(r.due)items.push({...base,priority:72,title:r.due+' retailer '+(r.due===1?'order has a document':'orders have documents')+' to send',
    happened:'Acknowledgments, ship notices or invoices are ready from the real orders, shipments and invoices.',why:stop||'You send this retailer’s documents yourself.',
    recommendation:'Send them from Retail EDI.',actionLabel:'Send documents'});
  return items;
}

module.exports={access,connect,saveRetailer,receive,outbound,send,reconcile,dashboard,disconnect,configure,schedule,poll,inbox,automaticStop,confirmationCheck,
  JOB,IMPORTED,CONFIRMED,SENT};
