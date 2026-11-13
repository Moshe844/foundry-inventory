'use strict';
// Job 50 (Growth draft, Pro and Custom alone): tell customers when a waited-for
// item is back in stock. Telling the people who handle the customer is
// agent-stock-ready-staff.js.
//
// A waited-for item is an order line that a confirmation after the order was
// backordered reserved more stock for, and whose whole remaining quantity is
// now reserved at the order's dispatch location (quantity-tracked goods, not
// kits; lot, serial and kit lines are reviewed individually). Each line is told
// about once (agent_stock_ready_lines): one email per order covers the lines
// that became ready together, and later lines get their own email.
//
// Growth prepares each email for the owner's approval. Pro and Custom send
// future ones from the one mailbox the owner enabled. The first update to a
// business customer, or to a different address, needs the owner's own
// approval; online shoppers from connected sales channels are not held
// (page 13). The email never promises a date. Pause, Watch only, Ask me first
// and the first 14 days send nothing automatically.
const {ValidationError,AuthorizationError}=require('../domain/errors'),policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions');
const installed=require('../db/schema-installed'),exact=require('../domain/exact-quantity');
const action='sales_order.notify_stock_ready',kind='stock_ready_notice',LINES='stockchief_runtime.agent_stock_ready_lines';
const NOT_READY='Choose a previously backordered order with an item whose stock is now fully reserved at its recorded dispatch location.';
const tracked=db=>installed.has(db,LINES);

// The remaining quantity of a line still to ship.
const REMAINING="(l.quantity_ordered-l.quantity_fulfilled-coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0))";
// Waited-for lines whose stock is now reserved, with $1 the inventory.
// `filter` narrows the orders (for example 'AND o.id=$2').
function readyLines(filter=''){
 return `SELECT l.id AS line_id,o.id AS order_id,o.order_number,o.customer_id,o.created_by_user_id,o.updated_at AS order_updated_at,l.sku_id,s.code,i.name AS item_name,i.unit_label,
   ${REMAINING} AS remaining,ready.at AS ready_at
  FROM sales_orders o JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
  JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  JOIN LATERAL(SELECT max(e.created_at::timestamptz) AS at FROM sales_order_events b JOIN sales_order_events e ON e.workspace_id=b.workspace_id AND e.sales_order_id=b.sales_order_id
     AND e.event_type='confirmed' AND e.id<>b.id AND e.created_at::timestamptz>=b.created_at::timestamptz
     AND jsonb_path_exists(coalesce(e.detail::jsonb->'allocations','[]'::jsonb),'$[*] ? (@.lineId == $id)',jsonb_build_object('id',l.id))
    WHERE b.workspace_id=o.workspace_id AND b.sales_order_id=o.id AND b.event_type='confirmed' AND b.detail::jsonb->>'status'='BACKORDERED') ready ON ready.at IS NOT NULL
  WHERE o.workspace_id=$1 ${filter} AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED') AND o.fulfillment_location_id IS NOT NULL
   AND i.tracking_mode='quantity' AND ${REMAINING}>0
   AND NOT EXISTS(SELECT 1 FROM sales_order_kit_components k WHERE k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id)
   AND coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id AND a.location_id=o.fulfillment_location_id),0)>=${REMAINING}`;
}
// Lines no customer update covered yet, or only the update keyed `key` (a
// parameter such as '$4') when that update is being checked again. Before
// migration 507 an update covered its whole order.
function unnoticed(linesInstalled,key=null){
 const other=key?' AND m.idempotency_key IS DISTINCT FROM '+key:'';
 return linesInstalled?`NOT EXISTS(SELECT 1 FROM ${LINES} n${key?' LEFT JOIN customer_communications m ON m.workspace_id=n.workspace_id AND m.id=n.communication_id':''} WHERE n.workspace_id=l.workspace_id AND n.sales_order_line_id=l.id AND n.noticed_at IS NOT NULL${other})`
  :`NOT EXISTS(SELECT 1 FROM customer_communications m WHERE m.workspace_id=l.workspace_id AND m.stock_ready_order_id=l.sales_order_id${other})`;
}

async function owner(db,ctx){
 if(!(await db.query(`SELECT 1 FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner'
  AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL)`,[ctx.workspaceId,ctx.actorId])).rows.length)throw new AuthorizationError('Only the inventory owner can authorize stock-ready customer updates.');
}
// The update for an order now: its ready lines no update covered yet. `again`
// checks an update already prepared: its own lines, which only it may cover.
// An order whose ready lines all have an update gives that update again.
async function facts(db,ctx,id,connectorId,again=null){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,50,'draft');
 const o=(await db.query(`SELECT o.*,c.name customer_name,c.email customer_email,c.record_state FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
  WHERE o.workspace_id=$1 AND o.id=$2`,[ctx.workspaceId,id])).rows[0];
 if(!o||!['CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED'].includes(o.status)||o.record_state!=='ACTIVE'||!o.fulfillment_location_id)throw new ValidationError(NOT_READY);
 const linesInstalled=await tracked(db);
 const read=(lineIds,key)=>db.query(readyLines('AND o.id=$2')+(lineIds?' AND l.id=ANY($3::text[])':'')+' AND '+unnoticed(linesInstalled,key?'$4':null)+' ORDER BY s.code,l.id',
  lineIds?[ctx.workspaceId,id,lineIds,key]:[ctx.workspaceId,id]).then(r=>r.rows);
 let lines=again?await read(again.lineIds,again.noticeKey):await read(null,null);
 if(!lines.length&&!again&&linesInstalled){
  const last=(await db.query(`SELECT m.idempotency_key,array_agg(n.sales_order_line_id) AS lines FROM ${LINES} n JOIN customer_communications m ON m.workspace_id=n.workspace_id AND m.id=n.communication_id
   WHERE n.workspace_id=$1 AND n.sales_order_id=$2 AND m.idempotency_key LIKE 'stock-ready:%' GROUP BY m.idempotency_key,m.created_at ORDER BY m.created_at DESC LIMIT 1`,[ctx.workspaceId,id])).rows[0];
  if(last)lines=await read(last.lines,last.idempotency_key);
 }
 if(!lines.length||again&&lines.length!==again.lineIds.length)throw new ValidationError(NOT_READY);
 if(lines.length>100)throw new ValidationError('Review orders with more than 100 ready items individually.');
 const positions=await require('../domain/postgres-stock-availability').readMany(db,ctx.workspaceId,lines.map(l=>({skuId:l.sku_id,locationId:o.fulfillment_location_id})));
 if(lines.some(l=>{const p=positions.get(JSON.stringify([l.sku_id,o.fulfillment_location_id]));return !p||p.onHand<p.committed+p.reserved;}))throw new ValidationError('Review changed stock, other commitments or quality holds before telling the customer stock is ready.');
 // Other items on the order still waiting for stock.
 const stillWaiting=(await db.query(`SELECT 1 FROM sales_order_lines l WHERE l.workspace_id=$1 AND l.sales_order_id=$2 AND NOT (l.id=ANY($3::text[])) AND ${REMAINING}>
  coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id),0) LIMIT 1`,[ctx.workspaceId,id,lines.map(l=>l.line_id)])).rowCount>0;
 const recipient=o.contact_email||o.customer_email;
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient||''))throw new ValidationError('Confirm a valid customer email for this order first.');
 const box=await require('../shipping/agent-shipping-notices').mailbox(db,ctx.workspaceId,connectorId);if(!box)throw new ValidationError('Choose a connected Gmail or Microsoft 365 sending mailbox.');
 // Online shoppers from a connected sales channel are not held as a first customer (page 13).
 const channel=(await db.query(`SELECT 1 FROM connection_mappings WHERE workspace_id=$1 AND entity_type='sales_order' AND foundry_record_id=$2 LIMIT 1`,[ctx.workspaceId,o.id])).rowCount>0;
 const readyAt=lines.map(l=>new Date(l.ready_at).toISOString()).sort().at(-1);
 const p={recordId:o.id,orderNumber:o.order_number,customerId:o.customer_id,customerName:o.customer_name,recipient,customerEmail:o.customer_email,channel,locationId:o.fulfillment_location_id,
  orderVersion:Number(o.version),readyAt,lines:lines.map(l=>({lineId:l.line_id,sku:l.code,quantity:exact.canonical(String(l.remaining))})),stillWaiting,
  connectorId:box.id,mailboxAccount:box.provider_account_id,providerType:box.provider_type};
 return {...p,sourceFingerprint:hash(p),noticeKey:'stock-ready:'+o.id+':'+hash(p.lines.map(l=>l.lineId)).slice(0,24)};
}
function compose(p){
 const lines=p.lines.map(l=>l.quantity+' × '+l.sku).join('\n');
 return {subject:'Stock reserved for order '+p.orderNumber,body:'Hello '+p.customerName+',\n\n'+(p.stillWaiting?'Stock is now reserved for these items on your order '+p.orderNumber+':\n'+lines+'\n\nThe rest of your order is still waiting for stock.'
  :'Stock is now reserved for your order '+p.orderNumber+':\n'+lines)+'\n\nThis is a stock update, not a delivery date. We will send shipment details separately once the order has left.\n\nThank you.'};
}
async function authority(db,workspaceId,p){
 const ctx={workspaceId,actorId:p.actorId};await owner(db,ctx);const state=await policy.requireWorkspaceJob(db,workspaceId,50,p.automatic?'automatic':'draft');
 const stop=await policy.stopped(db,workspaceId,state,action,p.automatic,p);if(stop)throw new ValidationError(stop);
 const now=await facts(db,ctx,p.recordId,p.connectorId,{lineIds:(p.lines||[]).map(l=>l.lineId),noticeKey:p.noticeKey});if(now.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('The order, reservation, customer or mailbox changed. Review a fresh stock update.');
 if(!p.automatic)return now;
 if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)throw new ValidationError('Automatic stock-ready messages are paused.');
 const rule=(await db.query('SELECT *,enabled_at<=$2::timestamptz eligible_event FROM stockchief_runtime.agent_stock_ready_settings WHERE workspace_id=$1',[workspaceId,p.readyAt])).rows[0];
 if(!rule?.enabled||!rule.eligible_event||rule.authorized_by!==p.actorId||rule.revision!==p.ruleRevision||rule.connector_id!==p.connectorId||rule.mailbox_account!==p.mailboxAccount||rule.provider_type!==p.providerType)throw new ValidationError('The stock-ready sending setting changed, or this order was already ready before it was enabled.');
 if(now.channel)return now;
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
 await db.query('UPDATE customer_communications SET stock_ready_order_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,result.communicationId,p.recordId]);
 // One update per order line: a line another update already covered stops this one.
 if(await tracked(db)){
  const marked=(await db.query(`INSERT INTO ${LINES}(workspace_id,sales_order_line_id,sales_order_id,quantity,communication_id,noticed_at)
   SELECT $1,x.id,$2,x.quantity::numeric,$3,clock_timestamp() FROM jsonb_to_recordset($4::jsonb) AS x(id text,quantity text)
   ON CONFLICT(workspace_id,sales_order_line_id) DO UPDATE SET communication_id=EXCLUDED.communication_id,noticed_at=EXCLUDED.noticed_at WHERE ${LINES}.noticed_at IS NULL RETURNING 1`,
  [ctx.workspaceId,p.recordId,result.communicationId,JSON.stringify(p.lines.map(l=>({id:l.lineId,quantity:l.quantity})))])).rowCount;
  if(marked!==p.lines.length)throw new ValidationError('Another stock update already covers one of these items. Review the order before sending.');
 }
 return {...result,salesOrderId:p.recordId,href:'/sales/orders/'+p.recordId,replayed:Boolean(existing)};
}
async function build(db,ctx,row,args){const box=await require('../connections/postgres-outbound-mail').resolveMailbox(db,ctx.workspaceId,args.mailbox);if(!box.row)throw new ValidationError('Choose the exact connected sending mailbox.');const p=await facts(db,ctx,row.id,box.row.id);return {payload:p,summary:'Tell '+p.customerName+' ('+p.recipient+') that stock is reserved for '+p.lines.length+(p.lines.length===1?' item':' items')+' on '+p.orderNumber+'. No shipment, invoice, payment, delivery promise or stock change is recorded.'};}
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
 const candidates=(await db.query(`SELECT DISTINCT x.order_id AS id FROM (${readyLines()} AND ${unnoticed(await tracked(db))}) x
  LEFT JOIN stockchief_runtime.agent_stock_ready_checks checked ON checked.workspace_id=$1 AND checked.sales_order_id=x.order_id
  WHERE x.ready_at>=$2::timestamptz AND (checked.retry_after IS NULL OR checked.retry_after<=now() OR x.order_updated_at::timestamptz>checked.checked_at)
  ORDER BY 1 LIMIT 20`,[workspaceId,new Date(rule.enabled_at).toISOString()])).rows;
 for(const o of candidates){
  const status=await db.transaction(async c=>{await c.query('SAVEPOINT stock_ready_notice');try{const ctx={workspaceId,actorId:rule.authorized_by},p={...await facts(c,ctx,o.id,rule.connector_id),kind,actorId:rule.authorized_by,automatic:true,ruleRevision:rule.revision};const q=await queue(c,ctx,p);await c.query('RELEASE SAVEPOINT stock_ready_notice');return q.replayed?'skipped':'queued';}
   catch(error){if(!['validation_error','entitlement_required','forbidden'].includes(error.code))throw error;await c.query('ROLLBACK TO SAVEPOINT stock_ready_notice');await c.query('RELEASE SAVEPOINT stock_ready_notice');await c.query(`INSERT INTO stockchief_runtime.agent_stock_ready_checks(workspace_id,sales_order_id,checked_at,retry_after,problem) VALUES($1,$2,clock_timestamp(),clock_timestamp()+interval '15 minutes',$3)
    ON CONFLICT(workspace_id,sales_order_id) DO UPDATE SET checked_at=EXCLUDED.checked_at,retry_after=EXCLUDED.retry_after,problem=EXCLUDED.problem`,[workspaceId,o.id,error.message]);return 'held';}
  },{isolation:'SERIALIZABLE',retrySafe:true});result[status]++;
 }return result;
}
async function review(db,ctx,{page=1,filter=''}){
 const history=await require('../commercial/agent-history').access(db,ctx.workspaceId),lines=await tracked(db),staff=await require('./agent-stock-ready-staff').ready(db);
 const rows=(await db.query(`SELECT o.order_number "Order",c.name "Customer",CASE m.status WHEN 'SENT' THEN 'Sent' WHEN 'QUEUED' THEN 'Queued' WHEN 'SENDING' THEN 'Sending' WHEN 'FAILED' THEN 'Needs review: '||coalesce(m.error_message,'Delivery could not be confirmed') ELSE coalesce(checked.problem,'Review the current reservation') END "Customer update",
  ${staff?`(SELECT string_agg(DISTINCT u.name,', ') FROM stockchief_runtime.agent_stock_ready_staff t JOIN users u ON u.workspace_id=t.workspace_id AND u.id=t.user_id WHERE t.workspace_id=o.workspace_id AND t.sales_order_id=o.id)`:'NULL::text'} "Sales told",'/sales/orders/'||o.id link
  FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id LEFT JOIN stockchief_runtime.agent_stock_ready_checks checked ON checked.workspace_id=o.workspace_id AND checked.sales_order_id=o.id
  LEFT JOIN LATERAL(SELECT status,error_message FROM customer_communications m WHERE m.workspace_id=o.workspace_id AND m.stock_ready_order_id=o.id AND ($4::timestamptz IS NULL OR m.created_at::timestamptz>=$4::timestamptz) ORDER BY m.created_at DESC LIMIT 1)m ON true
  WHERE o.workspace_id=$1 AND (o.status='CONFIRMED' OR m.status IS NOT NULL${lines?` OR o.status IN ('BACKORDERED','PARTIALLY_FULFILLED') AND EXISTS(SELECT 1 FROM ${LINES} n WHERE n.workspace_id=o.workspace_id AND n.sales_order_id=o.id)`:''}) AND ($2='' OR lower(o.order_number)=lower($2) OR lower(c.name)=lower($2)) AND EXISTS(SELECT 1 FROM sales_order_events e WHERE e.workspace_id=o.workspace_id AND e.sales_order_id=o.id AND e.event_type='confirmed' AND e.detail::jsonb->>'status'='BACKORDERED')
  ORDER BY o.updated_at DESC,o.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100,history.activityAfter])).rows;
 const state=await policy.accountState(db,ctx.workspaceId),rule=(await db.query('SELECT * FROM stockchief_runtime.agent_stock_ready_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0],blocked=await policy.stopped(db,ctx.workspaceId,state,action,false);
 return {summary:'When an item a customer waited for is back in stock and reserved, StockChief tells the person who handles that customer in Needs you, and the customer by email. Growth asks you to approve each customer email. Pro and Custom send future ones from the mailbox you choose, and email, text or push your team if you choose. You approve the first email to a new business customer or a different address; online shoppers are not held.',
  rows:rows.slice(0,100),more:rows.length>100,stockReadyForm:{mailboxes:await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId),rule,automatic:policy.permits(state.plan,50,'automatic'),blocked}};
}
module.exports={compose,authority,configure,run,facts,readyLines,unnoticed,REMAINING,definition:{id:50,key:'stock-ready-updates',label:'Tell sales and customers when waited-for stock is back',filterLabel:'Order number or customer',readPage:review},spec:{name:action,description:'Notify the exact customer after an existing backorder becomes fully reserved. Uses recorded reservation events, current quantities, confirmed recipient and connected sending mailbox; never claims shipment or changes stock, prices, money or terms.',record:'sales_order',fields:['recordReference','mailbox'],permission:require('../actions/permissions').OPERATE,ownerOnly:true,capability:'connection.email',completionGate:'provider_effect_succeeded',resultingRecords:['customer_communications','stockchief_runtime.provider_effects'],build,execute,
 verify:async(db,ctx,r,p)=>Boolean((await db.query("SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND id=$2 AND stock_ready_order_id=$3 AND status IN ('QUEUED','SENDING','SENT')",[ctx.workspaceId,r.communicationId,p.recordId])).rows.length)}};
