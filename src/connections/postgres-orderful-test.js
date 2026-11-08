'use strict';
const {ValidationError,NotFoundError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const money=require('../domain/currency');
const policy=require('../commercial/agent-plan');
const credentials=require('./postgres-credential-store');
const api=require('./orderful-test-api');
const types={ack:'855_PURCHASE_ORDER_ACKNOWLEDGMENT',ship:'856_SHIP_NOTICE_MANIFEST',invoice:'810_INVOICE'};
const key='agent-orderful-test';
async function access(db,ctx){
  const state=await require('../autopilot/job-reviews').ownerState(db,ctx);
  if(!policy.usesAgentTerms(state))policy.requireJob(null,185,'draft');
  return policy.requireWorkspaceJob(db,ctx.workspaceId,185,'draft');
}
async function connection(db,ctx){
  const row=(await db.query("SELECT id,config FROM workspace_connectors WHERE workspace_id=$1 AND connector_key=$2 AND status='connected' AND paused_at IS NULL",[ctx.workspaceId,key])).rows[0];
  if(!row)throw new ValidationError('Connect the Orderful test relationship first.');
  return {...JSON.parse(row.config),id:row.id};
}
async function remote(db,ctx,con,transport){
  const secret=await credentials.get(db,ctx.workspaceId,con.id,'provider');
  if(!secret?.apiKey)throw new ValidationError('Reconnect the test relationship.');
  return api.client(secret.apiKey,transport);
}
function inbound(meta,con){
  if(meta.stream!=='test'||meta.direction!=='in'||meta.senderId!==con.buyer||meta.receiverId!==con.seller||meta.validationStatus!=='VALID'||
    !['850_PURCHASE_ORDER','860_PURCHASE_ORDER_CHANGE'].includes(meta.ediTransactionType))
    throw new ValidationError('Choose a validated inbound test purchase order or change for this buyer and seller.');
}
async function connect(db,ctx,input,transport){
  await access(db,ctx);
  const config={buyer:String(input.buyer||'').trim(),seller:String(input.seller||'').trim(),customerId:input.customerId,locationId:input.locationId,currency:money.code(input.currency)};
  const token=String(input.apiKey||'').trim();
  if(!token||token.length>4096||/\s/.test(token)||!config.buyer||!config.seller||config.buyer===config.seller)throw new ValidationError('Enter both trading partner IDs and a test API key.');
  inbound(await api.client(token,transport).transaction(input.transactionId),config);
  return db.transaction(async c=>{
    const state=await access(c,ctx);
    const mapped=await c.query("SELECT 1 FROM customers u JOIN locations l ON l.workspace_id=u.workspace_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.record_state='ACTIVE' AND l.id=$3 AND l.is_active=1 AND l.custody_agreement_id IS NULL",[ctx.workspaceId,config.customerId,config.locationId]);
    if(!mapped.rowCount)throw new ValidationError('Choose a customer and a warehouse in this inventory.');
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
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function receive(db,ctx,transactionId,transport){
  await access(db,ctx);const con=await connection(db,ctx),provider=await remote(db,ctx,con,transport);
  const meta=await provider.transaction(transactionId);inbound(meta,con);
  const download=await provider.message(transactionId),msg=download.message||download;
  if(!msg.purchaseOrderNumber||msg.purchaseOrderNumber!==meta.businessNumber)throw new ValidationError('The downloaded document does not match the retailer PO number.');
  return db.transaction(async c=>{
    await access(c,ctx);await connection(c,ctx);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[con.id+msg.purchaseOrderNumber]);
    const old=(await c.query('SELECT * FROM stockchief_runtime.orderful_orders WHERE connector_id=$1 AND purchase_order_number=$2 FOR UPDATE',[con.id,msg.purchaseOrderNumber])).rows[0];
    // Mark a manually retried inbox entry in the same transaction as the imported business record.
    await c.query('UPDATE stockchief_runtime.orderful_inbox SET completed_at=coalesce(completed_at,now()),issue=NULL WHERE workspace_id=$1 AND transaction_id=$2',[ctx.workspaceId,transactionId]);
    if(meta.ediTransactionType==='860_PURCHASE_ORDER_CHANGE'){
      if(!old)throw new ValidationError('Import the original purchase order first.');
      const stored=await c.query('INSERT INTO stockchief_runtime.orderful_changes(workspace_id,source_id,transaction_id,message) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING transaction_id',
        [ctx.workspaceId,old.source_id,transactionId,JSON.stringify(msg)]);
      if(!stored.rowCount)return {orderId:old.sales_order_id,held:true,replayed:true};
      await c.query('UPDATE stockchief_runtime.orderful_orders SET superseding_message_id=$3 WHERE workspace_id=$1 AND source_id=$2',[ctx.workspaceId,old.source_id,transactionId]);
      return {orderId:old.sales_order_id,held:true};
    }
    if(old){if(old.source_id!==transactionId)throw new ValidationError('A different transaction already uses this retailer PO.');return {orderId:old.sales_order_id,replayed:true};}
    if(msg.purpose!=='original'||msg.purchaseOrderType!=='standalone'||!Array.isArray(msg.lineItems)||!msg.lineItems.length||msg.lineItems.length>500)
      throw new ValidationError('This importer supports original standalone retailer purchase orders with up to 500 lines.');
    if((msg.buyersCurrency && msg.buyersCurrency!==con.currency)||msg.allowances?.length||msg.charges?.length)
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
      return {skuId:matches[0].id,quantity:Number(l.quantity.value),unitPriceMinor:money.toMinor(l.unitCostPrice,con.currency),externalLineId:l.purchaseOrderLineId};
    });
    const sale=await require('../operations/postgres-business-workflows').createSalesOrderInTransaction(c,ctx,{customerId:con.customerId,fulfillmentLocationId:con.locationId,
      deliveryMethod:'SHIP',shipToAddress:[ship.name,ship.addressLine1,ship.addressLine2,ship.city,ship.stateOrProvinceCode,ship.postalCode,ship.countryCode].filter(Boolean).join(', '),
      orderDate:msg.purchaseOrderDate,currency:con.currency,reference:msg.purchaseOrderNumber,idempotencyKey:'orderful-test:'+transactionId,lines});
    await c.query('INSERT INTO stockchief_runtime.orderful_orders(workspace_id,source_id,connector_id,purchase_order_number,sales_order_id,original_message,retailer_line_skus) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)',
      [ctx.workspaceId,transactionId,con.id,msg.purchaseOrderNumber,sale.salesOrderId,JSON.stringify(msg),JSON.stringify(Object.fromEntries(lines.map(l=>[l.externalLineId,l.skuId])))]);
    return {orderId:sale.salesOrderId};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function outbound(db,ctx,sourceId,kind,recordId){
  await access(db,ctx);
  const con=await connection(db,ctx);
  const record=(await db.query(`SELECT e.*,o.status AS order_status,o.currency FROM stockchief_runtime.orderful_orders e JOIN sales_orders o ON o.id=e.sales_order_id
    WHERE e.workspace_id=$1 AND e.source_id=$2 AND e.connector_id=$3`,[ctx.workspaceId,sourceId,con.id])).rows[0];
  if(!record)throw new NotFoundError('This retailer order does not exist.');
  if(record.superseding_message_id)throw new ValidationError('The retailer changed this order. Reconcile the change before sending any document.');
  if(record.currency!==con.currency || !['CONFIRMED','PARTIALLY_FULFILLED','FULFILLED'].includes(record.order_status))throw new ValidationError('Confirm and reconcile the sales order before responding.');
  const original=record.original_message,originalLines=new Map(original.lineItems.map(l=>[l.purchaseOrderLineId,l]));
  const saleLines=(await db.query('SELECT id,sku_id,external_line_id,quantity_ordered,unit_price_minor FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2 ORDER BY id',[ctx.workspaceId,record.sales_order_id])).rows;
  if(saleLines.length!==originalLines.size||saleLines.some(s=>{const l=originalLines.get(s.external_line_id);return !l||record.retailer_line_skus[s.external_line_id]!==s.sku_id||Number(s.quantity_ordered)!==Number(l.quantity.value)||Number(s.unit_price_minor)!==money.toMinor(l.unitCostPrice,con.currency);}))
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
  return {con,document};
}
async function send(db,ctx,id,kind,recordId,transport,generation){
  const payload=await db.transaction(async c=>{
    const {document,con}=await outbound(c,ctx,id,kind,recordId);
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
    return {con,document,already:!receipt.rowCount};
  },{isolation:'SERIALIZABLE',retrySafe:true});
  if(payload.already)return {alreadySubmitted:true};
  let provider;
  try{
    const latest=await outbound(db,ctx,id,kind,recordId);
    if(!require('node:util').isDeepStrictEqual(payload.document,latest.document))throw new ValidationError('The source record changed. Review it again before sending.');
    provider=await remote(db,ctx,latest.con,transport);
    if(generation)await activeRule(db,ctx,generation);
  }catch(error){
    // No HTTP submission was attempted. A later authorized request can safely rebuild the document.
    await db.query("DELETE FROM stockchief_runtime.orderful_outbound WHERE workspace_id=$1 AND source_id=$2 AND kind=$3 AND record_id=$4 AND status='SUBMITTING' AND provider_id IS NULL AND provider_uuid IS NULL",[ctx.workspaceId,id,kind,recordId]);
    throw error;
  }
  const response=await provider.send(types[kind],payload.con.seller,payload.con.buyer,payload.document);
  await db.query('UPDATE stockchief_runtime.orderful_outbound SET status=$5,provider_id=$6,updated_at=now() WHERE workspace_id=$1 AND source_id=$2 AND kind=$3 AND record_id=$4',[ctx.workspaceId,id,kind,recordId,response.status,response.id]);
  return response;
}
async function reconcile(db,ctx,sourceId,kind,recordId,providerUuid,transport){
  await access(db,ctx);
  const con=await connection(db,ctx),provider=await remote(db,ctx,con,transport);
  const saved=(await db.query(`SELECT o.* FROM stockchief_runtime.orderful_outbound o JOIN stockchief_runtime.orderful_orders e USING(workspace_id,source_id)
    WHERE o.workspace_id=$1 AND o.source_id=$2 AND o.kind=$3 AND o.record_id=$4 AND e.connector_id=$5`,[ctx.workspaceId,sourceId,kind,recordId,con.id])).rows[0];
  if(!saved)throw new NotFoundError('This submission was not found.');
  const meta=await provider.transaction(providerUuid);
  if(meta.direction!=='out'||meta.senderId!==con.seller||meta.receiverId!==con.buyer||meta.ediTransactionType!==types[kind] ||
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
  const records=(await db.query(`SELECT e.source_id,e.sales_order_id,e.purchase_order_number,e.superseding_message_id,o.order_number,o.status,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('transaction',ch.transaction_id,'purpose',ch.message->>'purpose','received',ch.received_at) ORDER BY ch.received_at),'[]') FROM stockchief_runtime.orderful_changes ch WHERE ch.workspace_id=e.workspace_id AND ch.source_id=e.source_id) AS changes,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('kind',x.kind,'id',x.record_id,'status',x.status,'remote',x.provider_id,'uuid',x.provider_uuid) ORDER BY x.kind,x.record_id),'[]') FROM stockchief_runtime.orderful_outbound x WHERE x.workspace_id=e.workspace_id AND x.source_id=e.source_id) AS submitted,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'number',s.shipment_number) ORDER BY s.shipped_at),'[]') FROM sales_shipments s WHERE s.workspace_id=e.workspace_id AND s.sales_order_id=e.sales_order_id AND s.status IN ('SHIPPED','DELIVERED')) AS shipments,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'number',b.invoice_number) ORDER BY b.issue_date),'[]') FROM accounting_customer_invoices b WHERE b.workspace_id=e.workspace_id AND b.sales_order_id=e.sales_order_id AND b.status IN ('OPEN','PARTIALLY_PAID','PAID')) AS invoices
    FROM stockchief_runtime.orderful_orders e JOIN sales_orders o ON o.id=e.sales_order_id WHERE e.workspace_id=$1 AND (NOT $2::boolean OR (e.superseding_message_id IS NULL AND o.status IN ('CONFIRMED','PARTIALLY_FULFILLED','FULFILLED')))
    ORDER BY CASE WHEN $2 THEN e.last_polled_at END ASC NULLS FIRST,e.received_at DESC,e.source_id LIMIT CASE WHEN $2 THEN 25 ELSE 100 END`,[ctx.workspaceId,scheduled])).rows;
  const rule=(await db.query('SELECT checked_through,next_at,last_issue FROM stockchief_runtime.orderful_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
  const issues=(await db.query('SELECT transaction_id,business_number,issue FROM stockchief_runtime.orderful_inbox WHERE workspace_id=$1 AND issue IS NOT NULL AND completed_at IS NULL ORDER BY opened_at LIMIT 100',[ctx.workspaceId])).rows;
  return {enabled,linked,plan:state.plan,customers,locations,records,rule,issues};
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
async function activeRule(db,ctx,generation){
  await access(db,ctx);
  const rule=(await db.query('SELECT * FROM stockchief_runtime.orderful_rules WHERE workspace_id=$1 AND actor_id=$2 AND generation=$3',[ctx.workspaceId,ctx.actorId,generation])).rows[0];
  if(!rule)throw new ValidationError('The owner disabled this retailer rule.');
  const state=await require('../autopilot/postgres-service').getState(db,ctx.workspaceId);
  if(state.paused||state.suspended||state.mode!=='POLICY_AUTOMATED')throw new ValidationError('Automatic work is paused or awaiting standing authority.');
  return rule;
}
async function poll(db,job,transport){
  const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId},g=job.payload.generation;
  const rule=await activeRule(db,ctx,g),con=await connection(db,ctx),provider=await remote(db,ctx,con,transport);
  const end=(rule.window_end||new Date()).toISOString();
  const page=await provider.inbox(con,rule.checked_through.toISOString(),end,rule.next_cursor);
  await db.transaction(async c=>{
    await activeRule(c,ctx,g);
    const lock=(await c.query('SELECT * FROM stockchief_runtime.orderful_rules WHERE workspace_id=$1 AND generation=$2 FOR UPDATE',[ctx.workspaceId,g])).rows[0];
    if(!lock||lock.checked_through.getTime()!==rule.checked_through.getTime()||lock.next_cursor!==rule.next_cursor)return;
    for(const meta of page.items){
      if(!['850_PURCHASE_ORDER','860_PURCHASE_ORDER_CHANGE'].includes(meta.ediTransactionType))continue;
      inbound(meta,con);
      await c.query('INSERT INTO stockchief_runtime.orderful_inbox(workspace_id,transaction_id,business_number,kind,opened_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [ctx.workspaceId,meta.id,meta.businessNumber,meta.ediTransactionType,meta.createdAt]);
    }
    await c.query(`UPDATE stockchief_runtime.orderful_rules SET checked_through=CASE WHEN $3::text IS NULL THEN $4::timestamptz ELSE checked_through END,
      next_cursor=$3,window_end=CASE WHEN $3 IS NULL THEN NULL ELSE $4::timestamptz END WHERE workspace_id=$1 AND generation=$2`,[ctx.workspaceId,g,page.nextCursor,end]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
  // All pages must be collected before replaying a chronological window. A change must never precede its original order.
  if(page.nextCursor)return {more:true};
  const incoming=(await db.query(`SELECT transaction_id FROM stockchief_runtime.orderful_inbox WHERE workspace_id=$1 AND completed_at IS NULL AND issue IS NULL
    ORDER BY opened_at,kind,transaction_id LIMIT 25`,[ctx.workspaceId])).rows;
  let processed=0;
  for(const row of incoming){
    await activeRule(db,ctx,g);
    try{await receive(db,ctx,row.transaction_id,transport);processed++;}
    catch(e){if(e.code!=='validation_error')throw e;await db.query('UPDATE stockchief_runtime.orderful_inbox SET issue=$3 WHERE workspace_id=$1 AND transaction_id=$2',[ctx.workspaceId,row.transaction_id,e.message]);}
  }
  // Outstanding inbound exceptions or an unfinished page take priority over any outgoing acknowledgment or invoice.
  if((await db.query('SELECT 1 FROM stockchief_runtime.orderful_inbox WHERE workspace_id=$1 AND completed_at IS NULL LIMIT 1',[ctx.workspaceId])).rowCount)return {processed,held:true};
  const data=await dashboard(db,ctx,true);
  for(const order of data.records.filter(o=>!o.superseding_message_id&&['CONFIRMED','PARTIALLY_FULFILLED','FULFILLED'].includes(o.status))){
    await db.query('UPDATE stockchief_runtime.orderful_orders SET last_polled_at=now() WHERE workspace_id=$1 AND source_id=$2',[ctx.workspaceId,order.source_id]);
    const actions=[['ack',order.sales_order_id],...order.shipments.map(s=>['ship',s.id]),...(order.status==='FULFILLED'?order.invoices.map(b=>['invoice',b.id]):[])];
    for(const [kind,id] of actions){
      const prior=order.submitted.find(s=>s.kind===kind&&s.id===id);
      if(prior){if(!['ACCEPTED','DELIVERED','ACKNOWLEDGED'].includes(prior.status))break;continue;}
      await activeRule(db,ctx,g);
      try{const result=await send(db,ctx,order.source_id,kind,id,transport,g);if(result.status!=='ACCEPTED')break;}
      catch(e){if(e.code!=='validation_error')throw e;await db.query('UPDATE stockchief_runtime.orderful_rules SET last_issue=$3 WHERE workspace_id=$1 AND generation=$2',[ctx.workspaceId,g,e.message]);break;}
    }
  }
  return {processed};
}
module.exports={access,connect,receive,outbound,send,reconcile,dashboard,disconnect,configure,schedule,poll};
