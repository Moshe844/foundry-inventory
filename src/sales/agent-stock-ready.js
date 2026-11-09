'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors'),policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions');
const action='sales_order.notify_stock_ready',kind='stock_ready_notice';
async function owner(db,ctx){
 if(!(await db.query(`SELECT 1 FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner'
  AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL)`,[ctx.workspaceId,ctx.actorId])).rows.length)throw new AuthorizationError('Only the inventory owner can authorize stock-ready customer updates.');
}
async function facts(db,ctx,id,connectorId){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,50,'draft');
 const o=(await db.query(`SELECT o.*,c.name customer_name,c.email customer_email,c.record_state,ready.id ready_event,ready.created_at ready_at FROM sales_orders o
  JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
  JOIN LATERAL(SELECT e.id,e.created_at FROM sales_order_events e WHERE e.workspace_id=o.workspace_id AND e.sales_order_id=o.id AND e.event_type='confirmed' AND e.detail::jsonb->>'status'='CONFIRMED'
   AND EXISTS(SELECT 1 FROM sales_order_events before WHERE before.workspace_id=e.workspace_id AND before.sales_order_id=e.sales_order_id AND before.event_type='confirmed' AND before.detail::jsonb->>'status'='BACKORDERED' AND before.created_at::timestamptz<=e.created_at::timestamptz AND before.id<>e.id)
   ORDER BY e.created_at DESC,e.id DESC LIMIT 1)ready ON true WHERE o.workspace_id=$1 AND o.id=$2`,[ctx.workspaceId,id])).rows[0];
 if(!o||o.status!=='CONFIRMED'||o.record_state!=='ACTIVE'||!o.fulfillment_location_id)throw new ValidationError('Choose a previously backordered order whose stock is now fully reserved at its recorded dispatch location.');
 const lines=(await db.query(`SELECT l.id,l.sku_id,s.code,l.quantity_ordered::text,l.quantity_fulfilled::text,i.tracking_mode,
  coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id AND a.location_id=$3),0)::text allocated
  FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY l.id`,[ctx.workspaceId,id,o.fulfillment_location_id])).rows;
 if(!lines.length||lines.length>100||lines.some(l=>l.tracking_mode!=='quantity'||Number(l.quantity_fulfilled)!==0||Number(l.allocated)!==Number(l.quantity_ordered))||(await db.query('SELECT 1 FROM sales_order_kit_components WHERE workspace_id=$1 AND sales_order_line_id=ANY($2::text[]) LIMIT 1',[ctx.workspaceId,lines.map(l=>l.id)])).rows.length)throw new ValidationError('Review partly shipped orders, kits, lot or serial stock and incomplete reservations individually.');
 const positions=await require('../domain/postgres-stock-availability').readMany(db,ctx.workspaceId,lines.map(l=>({skuId:l.sku_id,locationId:o.fulfillment_location_id})));
 if(lines.some(l=>{const p=positions.get(JSON.stringify([l.sku_id,o.fulfillment_location_id]));return !p||p.onHand<p.committed+p.reserved+p.rentalReserved;}))throw new ValidationError('Review changed stock, other commitments or quality holds before telling the customer stock is ready.');
 const recipient=o.contact_email||o.customer_email;
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient||''))throw new ValidationError('Confirm a valid customer email for this order first.');
 const box=await require('../shipping/agent-shipping-notices').mailbox(db,ctx.workspaceId,connectorId);if(!box)throw new ValidationError('Choose a connected Gmail or Microsoft 365 sending mailbox.');
 const p={recordId:o.id,orderNumber:o.order_number,customerId:o.customer_id,customerName:o.customer_name,recipient,customerEmail:o.customer_email,locationId:o.fulfillment_location_id,orderVersion:Number(o.version),readyEvent:o.ready_event,readyAt:o.ready_at,lines:lines.map(l=>({sku:l.code,quantity:Number(l.quantity_ordered)})),connectorId:box.id,mailboxAccount:box.provider_account_id,providerType:box.provider_type};
 return {...p,sourceFingerprint:hash(p),noticeKey:'stock-ready:'+o.id};
}
function compose(p){return {subject:'Stock reserved for order '+p.orderNumber,body:'Hello '+p.customerName+',\n\nStock is now reserved for your order '+p.orderNumber+':\n'+p.lines.map(l=>l.quantity+' × '+l.sku).join('\n')+'\n\nThis is a stock update. We will send shipment details separately once the order has left.\n\nThank you.'};}
async function authority(db,workspaceId,p){
 const ctx={workspaceId,actorId:p.actorId};await owner(db,ctx);const state=await policy.requireWorkspaceJob(db,workspaceId,50,p.automatic?'automatic':'draft');
 const stop=await policy.stopped(db,workspaceId,state,action,p.automatic,p);if(stop)throw new ValidationError(stop);
 const now=await facts(db,ctx,p.recordId,p.connectorId);if(now.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('The order, reservation, customer or mailbox changed. Review a fresh stock update.');
 if(!p.automatic)return now;
 if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)throw new ValidationError('Automatic stock-ready messages are paused.');
 const rule=(await db.query('SELECT *,enabled_at<=$2::timestamptz eligible_event FROM stockchief_runtime.agent_stock_ready_settings WHERE workspace_id=$1',[workspaceId,p.readyAt])).rows[0];
 if(!rule?.enabled||!rule.eligible_event||rule.authorized_by!==p.actorId||rule.revision!==p.ruleRevision||rule.connector_id!==p.connectorId||rule.mailbox_account!==p.mailboxAccount||rule.provider_type!==p.providerType)throw new ValidationError('The stock-ready sending setting changed, or this order was already ready before it was enabled.');
 const known=(await db.query(`SELECT 1 FROM sales_orders o JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id WHERE o.workspace_id=$1 AND o.customer_id=$2 AND l.quantity_fulfilled>0
  AND lower(coalesce(o.contact_email,$3))=lower($4) LIMIT 1`,[workspaceId,p.customerId,p.customerEmail,p.recipient])).rows.length;
 const reviewed=known||(await db.query(`SELECT 1 FROM customer_communications m JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
  WHERE m.workspace_id=$1 AND m.customer_id=$2 AND m.stock_ready_order_id IS NOT NULL AND m.status='SENT' AND m.external_message_id IS NOT NULL AND e.payload->'standingAuthority'->>'kind'='stock_ready_notice'
   AND e.payload->'standingAuthority'->>'automatic'='false' AND m.recipient=$3 AND m.connector_id=$4
   AND e.payload->'standingAuthority'->>'mailboxAccount'=$5 AND e.payload->'standingAuthority'->>'providerType'=$6 LIMIT 1`,[workspaceId,p.customerId,p.recipient,p.connectorId,p.mailboxAccount,p.providerType])).rows.length;
 if((!known&&!reviewed)||p.recipient.toLowerCase()!==String(p.customerEmail||'').toLowerCase())throw new ValidationError('Approve the first update for this B2B customer or a different order email individually.');
 return now;
}
async function queue(db,ctx,p){
 await authority(db,ctx.workspaceId,p);const words=compose(p),existing=(await db.query(`SELECT m.*,e.id effect_id,e.payload FROM customer_communications m LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' WHERE m.workspace_id=$1 AND m.idempotency_key=$2`,[ctx.workspaceId,p.noticeKey])).rows[0];
 if(existing&&(existing.recipient!==p.recipient||existing.subject!==words.subject||existing.body!==words.body||existing.connector_id!==p.connectorId))throw new ValidationError('An earlier stock update already uses this order. Review its delivery before sending changed details.');
 if(existing?.status==='SENT')return {communicationId:existing.id,effectId:existing.effect_id,salesOrderId:p.recordId,status:'SENT',queued:false,alreadySent:true,replayed:true};
 if(existing&&(existing.status==='FAILED'||existing.payload?.standingAuthority?.sourceFingerprint!==p.sourceFingerprint))throw new ValidationError('Review the earlier stock update and its delivery before trying again.');
 if(existing){
  if(!existing.effect_id||existing.payload?.standingAuthority?.kind!==kind)throw new ValidationError('Review the earlier stock update and its delivery before trying again.');
  if(existing.status==='QUEUED')await authority(db,ctx.workspaceId,existing.payload.standingAuthority);
  return {communicationId:existing.id,effectId:existing.effect_id,salesOrderId:p.recordId,status:existing.status,queued:existing.status==='QUEUED',replayed:true};
 }
 const result=await require('../connections/postgres-outbound-mail').queueInTransaction(db,ctx,{recipientKind:'customer',recipientId:p.customerId,recipientEmail:p.recipient,connectorId:p.connectorId,...words,standingAuthority:p},p.noticeKey,{agentRequested:true,agentJob:50});
 await db.query('UPDATE customer_communications SET stock_ready_order_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,result.communicationId,p.recordId]);return {...result,salesOrderId:p.recordId,href:'/sales/orders/'+p.recordId,replayed:Boolean(existing)};
}
async function build(db,ctx,row,args){const box=await require('../connections/postgres-outbound-mail').resolveMailbox(db,ctx.workspaceId,args.mailbox);if(!box.row)throw new ValidationError('Choose the exact connected sending mailbox.');const p=await facts(db,ctx,row.id,box.row.id);return {payload:p,summary:'Tell '+p.customerName+' ('+p.recipient+') that stock is reserved for '+p.orderNumber+'. No shipment, invoice, payment, delivery promise or stock change is recorded.'};}
async function execute(db,ctx,p){return queue(db,ctx,{...p,kind,actorId:ctx.actorId,automatic:false});}
async function configure(db,ctx,input){
 await owner(db,ctx);return db.transaction(async c=>{
  const current=(await c.query('SELECT * FROM stockchief_runtime.agent_stock_ready_settings WHERE workspace_id=$1 FOR UPDATE',[ctx.workspaceId])).rows[0],revision=Number(input.revision);
  if(!Number.isSafeInteger(revision)||revision<0||revision!==(current?.revision||0))throw new ValidationError('Reload the stock-ready setting before changing it.');
  if(input.stop==='1'){await c.query('UPDATE stockchief_runtime.agent_stock_ready_settings SET enabled=false,revision=revision+1 WHERE workspace_id=$1',[ctx.workspaceId]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Automatic stock-ready updates stopped'});return;}
  const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,50,'automatic');if(state.shadow)throw new ValidationError('Enable stock-ready messages after the first 14 days of watching.');
  const box=await require('../shipping/agent-shipping-notices').mailbox(c,ctx.workspaceId,input.connectorId);if(!box)throw new ValidationError('Choose a connected sending mailbox.');
  await c.query(`INSERT INTO stockchief_runtime.agent_stock_ready_settings(workspace_id,connector_id,mailbox_account,provider_type,authorized_by,enabled,enabled_at) VALUES($1,$2,$3,$4,$5,true,clock_timestamp())
   ON CONFLICT(workspace_id) DO UPDATE SET connector_id=EXCLUDED.connector_id,mailbox_account=EXCLUDED.mailbox_account,provider_type=EXCLUDED.provider_type,authorized_by=EXCLUDED.authorized_by,enabled=true,enabled_at=EXCLUDED.enabled_at,revision=stockchief_runtime.agent_stock_ready_settings.revision+1`,[ctx.workspaceId,box.id,box.provider_account_id,box.provider_type,ctx.actorId]);
  await c.query('DELETE FROM stockchief_runtime.agent_stock_ready_checks WHERE workspace_id=$1',[ctx.workspaceId]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Automatic stock-ready updates enabled',after:{mailbox:box.display_name}});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function run(db,workspaceId){
 const result={queued:0,held:0,skipped:0},rule=(await db.query('SELECT * FROM stockchief_runtime.agent_stock_ready_settings WHERE workspace_id=$1 AND enabled',[workspaceId])).rows[0];if(!rule)return result;
 const state=await policy.accountState(db,workspaceId);if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,50,'automatic')||!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return result;
 const candidates=(await db.query(`SELECT DISTINCT o.id FROM sales_orders o JOIN sales_order_events e ON e.workspace_id=o.workspace_id AND e.sales_order_id=o.id AND e.event_type='confirmed' AND e.detail::jsonb->>'status'='CONFIRMED' AND e.created_at>=$2
  JOIN stockchief_runtime.agent_stock_ready_settings s ON s.workspace_id=o.workspace_id AND e.created_at::timestamptz>=s.enabled_at
  LEFT JOIN stockchief_runtime.agent_stock_ready_checks checked ON checked.workspace_id=o.workspace_id AND checked.sales_order_id=o.id WHERE o.workspace_id=$1 AND o.status='CONFIRMED'
   AND (checked.retry_after IS NULL OR checked.retry_after<=now() OR o.updated_at::timestamptz>checked.checked_at)
   AND EXISTS(SELECT 1 FROM sales_order_events b WHERE b.workspace_id=o.workspace_id AND b.sales_order_id=o.id AND b.event_type='confirmed' AND b.detail::jsonb->>'status'='BACKORDERED')
   AND NOT EXISTS(SELECT 1 FROM customer_communications m WHERE m.workspace_id=o.workspace_id AND m.stock_ready_order_id=o.id)
  ORDER BY o.id LIMIT 20`,[workspaceId,new Date(rule.enabled_at).toISOString()])).rows;
 for(const o of candidates){
  const status=await db.transaction(async c=>{await c.query('SAVEPOINT stock_ready_notice');try{const ctx={workspaceId,actorId:rule.authorized_by},p={...await facts(c,ctx,o.id,rule.connector_id),kind,actorId:rule.authorized_by,automatic:true,ruleRevision:rule.revision};const q=await queue(c,ctx,p);await c.query('RELEASE SAVEPOINT stock_ready_notice');return q.replayed?'skipped':'queued';}
   catch(error){if(!['validation_error','entitlement_required','forbidden'].includes(error.code))throw error;await c.query('ROLLBACK TO SAVEPOINT stock_ready_notice');await c.query('RELEASE SAVEPOINT stock_ready_notice');await c.query(`INSERT INTO stockchief_runtime.agent_stock_ready_checks(workspace_id,sales_order_id,checked_at,retry_after,problem) VALUES($1,$2,clock_timestamp(),clock_timestamp()+interval '15 minutes',$3)
    ON CONFLICT(workspace_id,sales_order_id) DO UPDATE SET checked_at=EXCLUDED.checked_at,retry_after=EXCLUDED.retry_after,problem=EXCLUDED.problem`,[workspaceId,o.id,error.message]);return 'held';}
  },{isolation:'SERIALIZABLE',retrySafe:true});result[status]++;
 }return result;
}
async function review(db,ctx,{page=1,filter=''}){
 const history=await require('../commercial/agent-history').access(db,ctx.workspaceId);
 const rows=(await db.query(`SELECT o.order_number "Order",c.name "Customer",CASE m.status WHEN 'SENT' THEN 'Sent' WHEN 'QUEUED' THEN 'Queued' WHEN 'SENDING' THEN 'Sending' WHEN 'FAILED' THEN 'Needs review: '||coalesce(m.error_message,'Delivery could not be confirmed') ELSE coalesce(checked.problem,'Review the current reservation') END "Customer update",'/sales/orders/'||o.id link
  FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id LEFT JOIN stockchief_runtime.agent_stock_ready_checks checked ON checked.workspace_id=o.workspace_id AND checked.sales_order_id=o.id
  LEFT JOIN LATERAL(SELECT status,error_message FROM customer_communications m WHERE m.workspace_id=o.workspace_id AND m.stock_ready_order_id=o.id AND ($4::timestamptz IS NULL OR m.created_at::timestamptz>=$4::timestamptz) ORDER BY m.created_at DESC LIMIT 1)m ON true
  WHERE o.workspace_id=$1 AND (o.status='CONFIRMED' OR m.status IS NOT NULL) AND ($2='' OR lower(o.order_number)=lower($2) OR lower(c.name)=lower($2)) AND EXISTS(SELECT 1 FROM sales_order_events e WHERE e.workspace_id=o.workspace_id AND e.sales_order_id=o.id AND e.event_type='confirmed' AND e.detail::jsonb->>'status'='BACKORDERED')
  ORDER BY o.updated_at DESC,o.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100,history.activityAfter])).rows;
 const state=await policy.accountState(db,ctx.workspaceId),rule=(await db.query('SELECT * FROM stockchief_runtime.agent_stock_ready_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0],blocked=await policy.stopped(db,ctx.workspaceId,state,action,false);
 return {summary:'Tell a customer when their waiting stock is reserved. Growth asks you to approve each message. Pro and Custom can send future updates from the mailbox you choose. You approve the first update for a new business customer or a different email address.',rows:rows.slice(0,100),more:rows.length>100,stockReadyForm:{mailboxes:await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId),rule,automatic:policy.permits(state.plan,50,'automatic'),blocked}};
}
module.exports={compose,authority,configure,run,facts,definition:{id:50,key:'stock-ready-updates',label:'Tell customers their waiting stock is reserved',filterLabel:'Order number or customer',readPage:review},spec:{name:action,description:'Notify the exact customer after an existing backorder becomes fully reserved. Uses recorded reservation events, current quantities, confirmed recipient and connected sending mailbox; never claims shipment or changes stock, prices, money or terms.',record:'sales_order',fields:['recordReference','mailbox'],permission:require('../actions/permissions').OPERATE,ownerOnly:true,capability:'connection.email',completionGate:'provider_effect_succeeded',resultingRecords:['customer_communications','stockchief_runtime.provider_effects'],build,execute,
 verify:async(db,ctx,r,p)=>Boolean((await db.query("SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND id=$2 AND stock_ready_order_id=$3 AND status IN ('QUEUED','SENDING','SENT')",[ctx.workspaceId,r.communicationId,p.recordId])).rows.length)}};
