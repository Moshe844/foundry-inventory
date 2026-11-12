'use strict';
// Job 93: "Sends requests for quotes (RFQs) to several suppliers."
// The owner says when they want competition: a new item, a purchase worth
// more than an amount, or named items or categories. When such an item needs
// buying (the native reorder position), StockChief prepares one RFQ for the
// suppliers the rule names and sends it through the outbound mail queue:
// Pro once the owner has sent one from the rule and taught it, Custom on its
// own. It reminds suppliers who have not replied, captures replies as
// quotations (job 92) and shows the comparison. It never accepts a price or
// places an order: page 13 keeps those for a person.
const policy=require('../commercial/agent-plan'),source=require('./supplier-rfq-source'),rfqs=require('./agent-supplier-rfqs');
const {ValidationError,NotFoundError}=require('../domain/errors'),{newId}=require('../lib/util'),{hash}=require('../pricing/postgres-promotions');
const {addDays}=require('../accounting/customer-money'),money=require('../domain/currency');
const table='stockchief_runtime.agent_rfq_competition_rules',jobKind='agent.rfq-competition.v1',replyKind='mail.supplier-rfq-reply.v1',action='supplier.request_quotes';
const REPEAT_DAYS=30;
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const held=e=>[400,402,403,404,409,422].includes(e?.status)||['validation_error','entitlement_required','forbidden','not_found'].includes(e?.code);
const today=(c,workspaceId)=>require('../lib/business-time').today(c,workspaceId);
const list=v=>String(v||'').split(/\r?\n|,/).map(s=>s.trim()).filter(Boolean);
function whole(value,label,min,max){const text=String(value??'').trim();if(!/^\d{1,4}$/.test(text)||Number(text)<min||Number(text)>max)throw new ValidationError(label+' must be a whole number from '+min+' to '+max+'.');return Number(text);}

async function rule(c,ctx,id,lock=false){
 const r=(await c.query('SELECT * FROM '+table+' WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
 if(!r)throw new NotFoundError('That quote rule is not in this inventory.');return r;
}
async function input(c,ctx,value){
 const name=String(value.name||'').trim();if(!name||name.length>120||/[\x00-\x1f\x7f]/.test(name))throw new ValidationError('Give the rule a short name.');
 const newItems=value.newItems==='yes'||value.newItems===true,thresholdText=String(value.threshold??'').trim();
 let currency=null,thresholdMinor=null;
 if(thresholdText){currency=money.code(value.currency||'');thresholdMinor=money.userToMinor(thresholdText,currency,{label:'Purchase amount'});if(!(thresholdMinor>0))throw new ValidationError('Enter a purchase amount above zero, or leave it empty.');}
 const codes=[...new Set(list(value.skuCodes))],categories=[...new Map(list(value.categories).map(v=>[v.toLowerCase(),v])).values()];
 if(codes.length>100||categories.length>50||categories.some(v=>v.length>160))throw new ValidationError('Name up to 100 product codes and 50 categories.');
 const skus=codes.length?(await c.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND code=ANY($2::text[]) AND is_active=1 ORDER BY id',[ctx.workspaceId,codes])).rows:[];
 if(skus.length!==codes.length)throw new ValidationError('Match every product code to an active product in this inventory.');
 if(!newItems&&thresholdMinor===null&&!skus.length&&!categories.length)throw new ValidationError('Choose when you want quotes: new items, a purchase amount, named products or categories.');
 const names=list(value.supplierNames);
 if(names.length<2||names.length>20||new Set(names.map(n=>n.toLowerCase())).size!==names.length)throw new ValidationError('Name two to twenty different suppliers, one per line.');
 const suppliers=(await c.query("SELECT id,name,email,currency FROM suppliers WHERE workspace_id=$1 AND lower(name)=ANY($2::text[]) AND status='active' ORDER BY id",[ctx.workspaceId,names.map(n=>n.toLowerCase())])).rows;
 if(suppliers.length!==names.length)throw new ValidationError('Match every supplier name to one active supplier in this inventory.');
 if(suppliers.some(s=>!s.email||!s.currency))throw new ValidationError('Every supplier in the rule needs an email address and a currency.');
 const location=(await c.query('SELECT id FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1',[ctx.workspaceId,String(value.locationId||'')])).rows[0];
 if(!location)throw new ValidationError('Choose where the goods should be delivered.');
 const mailbox=(await require('../connections/postgres-outbound-mail').mailboxes(c,ctx.workspaceId)).find(m=>m.id===String(value.connectorId||''));
 if(!mailbox)throw new ValidationError('Choose a connected mailbox to send from.');
 const replyDays=whole(value.replyDays,'Days to reply',1,60),deliveryDays=whole(value.deliveryDays,'Days until delivery',1,365),chaseDays=whole(value.chaseDays,'Days before a reminder',1,60),maxPerWeek=whole(value.maxRequestsPerWeek,'RFQs a week',1,20);
 if(deliveryDays<replyDays)throw new ValidationError('The delivery date must come after the reply date.');
 return {name,new_items:newItems,threshold_minor:thresholdMinor,currency,sku_ids:skus.map(s=>s.id),categories,supplier_ids:suppliers.map(s=>s.id),location_id:location.id,connector_id:mailbox.id,reply_days:replyDays,delivery_days:deliveryDays,chase_days:chaseDays,max_requests_per_week:maxPerWeek};
}
async function save(db,ctx,value){return tx(db,async c=>{
 await source.owner(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,93,'draft');
 if(value.confirmed!=='yes')throw new ValidationError('Confirm the rule before saving it.');
 const v=await input(c,ctx,value),existing=value.ruleId?await rule(c,ctx,value.ruleId,true):null;
 if(existing&&existing.revision!==Number(value.revision))throw new ValidationError('This rule changed. Open its current version.');
 await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],existing?.enabled?0:1);
 const id=existing?.id||newId('rfq-competition'),cols=Object.keys(v),values=cols.map(k=>v[k]);
 // A changed rule must be taught again on Pro: its example no longer matches.
 if(existing)await c.query('UPDATE '+table+' SET '+cols.map((k,i)=>k+'=$'+(i+3)).join(',')+',enabled=true,authorized_by=$'+(cols.length+3)+',example_request_id=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,...values,ctx.actorId]);
 else await c.query('INSERT INTO '+table+'(id,workspace_id,authorized_by,'+cols.join(',')+') VALUES($1,$2,$3,'+cols.map((k,i)=>'$'+(i+4)).join(',')+')',[id,ctx.workspaceId,ctx.actorId,...values]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier quote rule saved',reference:id,before:existing?{revision:existing.revision}:{},after:{...v,purchaseAuthority:false}});
 return {id};
});}
async function stop(db,ctx,id,value){return tx(db,async c=>{
 await source.owner(c,ctx);const saved=await rule(c,ctx,id,true);
 if(saved.revision!==Number(value.revision))throw new ValidationError('This rule changed. Open its current version.');
 await c.query('UPDATE '+table+' SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier quote rule stopped',reference:id});return {id};
});}
// Pro learns from an RFQ the rule prepared that the owner reviewed and sent to
// every supplier, with each email confirmed by the mailbox.
async function example(c,ctx,saved,requestId){
 const r=await rfqs.request(c,ctx,requestId).catch(error=>{if(error.status===404)return null;throw error;});if(!r)return null;
 const n=(await c.query(`SELECT count(*)::int n FROM stockchief_runtime.agent_rfq_deliveries d JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id
  WHERE d.workspace_id=$1 AND d.request_id=$2 AND NOT d.automatic AND d.approved_by=$3 AND m.status='SENT' AND nullif(m.external_message_id,'') IS NOT NULL`,[ctx.workspaceId,r.id,saved.authorized_by])).rows[0].n;
 return r.competition_rule_id===saved.id&&r.reviewed_by===saved.authorized_by&&n===r.snapshot.suppliers.length&&r.snapshot.supplierIds.every(id=>saved.supplier_ids.includes(id))&&r.snapshot.connectorId===saved.connector_id?r:null;
}
async function trained(c,ctx,saved){return Boolean(saved.example_request_id&&await example(c,ctx,saved,saved.example_request_id));}
async function teach(db,ctx,id,value){return tx(db,async c=>{
 await source.owner(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,93,'draft');const saved=await rule(c,ctx,id,true);
 if(saved.revision!==Number(value.revision)||value.confirmed!=='yes'||!saved.enabled)throw new ValidationError('Open the current rule and confirm before teaching it.');
 if(saved.authorized_by!==ctx.actorId||!await example(c,ctx,saved,String(value.requestId||'')))throw new ValidationError('Teach with an RFQ from this rule that you sent yourself to every supplier, after the mailbox confirmed each email.');
 await c.query('UPDATE '+table+' SET example_request_id=$3,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,value.requestId]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier quote rule taught from a sent RFQ',reference:id,after:{requestId:value.requestId}});return {id};
});}
// Checked when an automatic RFQ or reminder is queued and again just before
// the mailbox sends it.
async function sendAuthority(c,ctx,r,grant){
 const saved=await rule(c,ctx,grant.competitionRuleId);
 if(!saved.enabled||saved.authorized_by!==ctx.actorId||saved.revision!==grant.competitionRevision||r.competition_rule_id!==saved.id||r.snapshot.connectorId!==saved.connector_id||!r.snapshot.supplierIds.every(id=>saved.supplier_ids.includes(id)))
  throw new ValidationError('This RFQ no longer fits the owner’s current quote rule.');
 await source.access(c,ctx,{automatic:true,trained:await trained(c,ctx,saved)});
 await source.knownPartners(c,ctx,r.snapshot);
 return saved;
}
// Null when the rule may send on its own now, or the reason a person must.
async function automaticReason(c,ctx,saved,state){
 const mode=await require('../autopilot/job-modes').restriction(c,ctx.workspaceId,93,true);if(mode)return mode;
 if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)return 'StockChief is set to ask before acting. Review and send this RFQ.';
 const stopped=await policy.stopped(c,ctx.workspaceId,state,action,true);if(stopped)return stopped;
 if(!policy.permits(state.plan,93,'automatic',{trained:await trained(c,ctx,saved)}))return 'Send one RFQ from this rule yourself, then teach the rule. After that StockChief sends them on its own.';
 return null;
}
// Items at the rule's location that need buying now, and why the owner wants competition for each.
async function needs(c,ctx,saved,day){
 const planning=require('../forecasting/postgres-planning-service'),decision=require('./replenishment-decision');
 const only=!saved.new_items&&saved.threshold_minor===null&&!saved.categories.length?saved.sku_ids:null,short=new Map();
 let after=null;
 for(let page=0;page<20;page++){
  const rows=await planning.position(c,ctx.workspaceId,{afterSkuId:after,limitSkus:1000,onlySkuIds:only});
  for(const row of rows){
   if(row.planning_suppressed||!row.shortage||row.tracking_mode!=='quantity'||!(row.location_id===saved.location_id||row.scope==='workspace'))continue;
   const quantity=Math.ceil(decision.requiredUnits(row));if(!(quantity>0)||quantity>100000)continue;
   if(!short.has(row.sku_id)||row.location_id===saved.location_id)short.set(row.sku_id,quantity);
  }
  if(!rows.coverage.partial)break;after=rows.coverage.nextAfterSkuId;
 }
 if(!short.size)return [];
 const facts=(await c.query(`SELECT s.id,s.code,lower(f.category) AS category,
   EXISTS(SELECT 1 FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
    WHERE l.workspace_id=s.workspace_id AND l.sku_id=s.id AND o.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')) AS bought,
   (SELECT l.unit_cost::text FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
    WHERE l.workspace_id=s.workspace_id AND l.sku_id=s.id AND o.currency=$3 AND l.unit_cost IS NOT NULL AND o.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')
    ORDER BY o.ordered_at::timestamptz DESC NULLS LAST,o.id DESC LIMIT 1) AS last_cost
  FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  LEFT JOIN catalogue_item_facts f ON f.workspace_id=i.workspace_id AND f.item_id=i.id
  WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 AND i.quantity_precision=0 AND i.secondary_unit_label IS NULL
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_rfq_requests r CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'lines') line
    WHERE r.workspace_id=s.workspace_id AND line->>'skuId'=s.id AND r.created_at>=now()-make_interval(days=>$4))
  ORDER BY s.code,s.id`,[ctx.workspaceId,[...short.keys()],saved.currency,REPEAT_DAYS])).rows;
 const categories=new Set(saved.categories.map(v=>v.toLowerCase())),found=[];
 for(const f of facts){
  const quantity=short.get(f.id),why=[];
  if(saved.sku_ids.includes(f.id))why.push('named in the rule');
  if(f.category&&categories.has(f.category))why.push('in the '+f.category+' category');
  if(saved.new_items&&!f.bought)why.push('never bought before');
  if(saved.threshold_minor!==null&&f.last_cost!==null){
   const value=Math.round(Number(f.last_cost)*10**money.exponent(saved.currency))*quantity;
   if(Number.isSafeInteger(value)&&value>=Number(saved.threshold_minor))why.push('about '+money.format(value,saved.currency)+' at the last price');
  }
  if(why.length)found.push({skuId:f.id,code:f.code,quantity,why:why.join(', ')});
 }
 return found.slice(0,100);
}
async function note(c,ctx,id,text){await c.query('UPDATE '+table+' SET last_note=$3,last_run_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,String(text).slice(0,2000)]);}
async function runRule(c,ctx,id){
 const saved=await rule(c,ctx,id,true);if(!saved.enabled)return {ruleId:id,skipped:'stopped'};
 const state=await policy.accountState(c,ctx.workspaceId),day=await today(c,ctx.workspaceId),wanted=await needs(c,ctx,saved,day);
 if(!wanted.length){await note(c,ctx,id,'Nothing this rule covers needs buying right now.');return {ruleId:id,prepared:false};}
 const items=wanted.map(w=>w.code+' ('+w.why+')').join('; ');
 if(state.shadow){await note(c,ctx,id,'Watching during the first 14 days. It would have asked '+saved.supplier_ids.length+' suppliers to quote for '+items+'.');return {ruleId:id,watched:true};}
 const stopped=await policy.stopped(c,ctx.workspaceId,state,action,false);
 if(stopped){await note(c,ctx,id,stopped+' It would have asked for quotes for '+items+'.');return {ruleId:id,stopped};}
 const lines=wanted.map(w=>({skuId:w.skuId,quantity:w.quantity})),signature=hash(lines),triggerKey='competition:'+saved.id+':'+day+':'+signature;
 let r;
 await c.query('SAVEPOINT rfq_competition_prepare');
 try{
  // A short code from the products keeps each RFQ's reference, and so the replies, apart.
  r=await rfqs.create(c,ctx,source.input({reference:saved.name+' · '+day+' · '+signature.slice(0,6).toUpperCase(),requestKey:triggerKey,connectorId:saved.connector_id,supplierIds:saved.supplier_ids,lines,
   replyBy:addDays(day,saved.reply_days),deliverBy:addDays(day,saved.delivery_days),locationId:saved.location_id}),{competitionRuleId:saved.id,triggerKey});
  await c.query('RELEASE SAVEPOINT rfq_competition_prepare');
 }catch(error){
  if(!held(error))throw error;
  await c.query('ROLLBACK TO SAVEPOINT rfq_competition_prepare');await c.query('RELEASE SAVEPOINT rfq_competition_prepare');
  await note(c,ctx,id,'Could not prepare an RFQ for '+items+': '+error.message);return {ruleId:id,problem:error.message};
 }
 if(!r.created)return {ruleId:id,requestId:r.id,replayed:true};
 let why=await automaticReason(c,ctx,saved,state),sent=false;
 if(!why){
  await c.query('SAVEPOINT rfq_competition_send');
  try{await rfqs.queue(c,ctx,r,{competition:saved});await c.query('RELEASE SAVEPOINT rfq_competition_send');sent=true;}
  catch(error){if(!held(error))throw error;await c.query('ROLLBACK TO SAVEPOINT rfq_competition_send');await c.query('RELEASE SAVEPOINT rfq_competition_send');why=error.message;}
 }
 if(!sent)await c.query('UPDATE stockchief_runtime.agent_rfq_requests SET needs_person=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,r.id,why]);
 await note(c,ctx,id,(sent?'Asked '+saved.supplier_ids.length+' suppliers to quote for ':'Prepared an RFQ for you to send, for ')+items+'.'+(sent?'':' '+why));
 await require('../operations/postgres-security-audit').record(c,ctx,{action:sent?'Supplier RFQ prepared and sent from the owner’s quote rule':'Supplier RFQ prepared from the owner’s quote rule for review',reference:r.id,after:{ruleId:saved.id,lines:wanted,needsPerson:why,purchaseAuthority:false}});
 return {ruleId:id,requestId:r.id,sent,needsPerson:why};
}
// A supplier who has not replied within the rule's days gets one reminder.
async function chaseDue(db,workspaceId){
 const due=(await db.query(`SELECT d.id,d.request_id,r.competition_rule_id,q.authorized_by FROM stockchief_runtime.agent_rfq_deliveries d
  JOIN stockchief_runtime.agent_rfq_requests r ON r.workspace_id=d.workspace_id AND r.id=d.request_id
  JOIN ${table} q ON q.workspace_id=r.workspace_id AND q.id=r.competition_rule_id AND q.enabled
  JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id
  WHERE d.workspace_id=$1 AND m.status='SENT' AND d.reply_message_id IS NULL AND d.quote_document_id IS NULL AND d.chase_communication_id IS NULL
   AND r.closed_at IS NULL AND m.sent_at::timestamptz<=now()-make_interval(days=>q.chase_days)
  ORDER BY m.sent_at,d.id LIMIT 100`,[workspaceId])).rows,results=[];
 for(const row of due){
  results.push(await tx(db,async c=>{
   const ctx={workspaceId,actorId:row.authorized_by},saved=await rule(c,ctx,row.competition_rule_id,true),r=await rfqs.request(c,ctx,row.request_id,true);
   if(await findReply(c,workspaceId,row.id))return {deliveryId:row.id,replied:true};
   const state=await policy.accountState(c,workspaceId);if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,93,'draft'))return {deliveryId:row.id,skipped:'plan'};
   const why=await automaticReason(c,ctx,saved,state);if(why)return {deliveryId:row.id,needsPerson:why};
   await c.query('SAVEPOINT rfq_chase');
   try{const sent=await rfqs.queueChase(c,ctx,r,row.id,{competition:saved});await c.query('RELEASE SAVEPOINT rfq_chase');return {deliveryId:row.id,chased:sent.communicationId};}
   catch(error){if(!held(error))throw error;await c.query('ROLLBACK TO SAVEPOINT rfq_chase');await c.query('RELEASE SAVEPOINT rfq_chase');return {deliveryId:row.id,needsPerson:error.message};}
  }));
 }
 return results;
}
async function enqueue(db,workspaceId,cycleId){
 const state=await policy.accountState(db,workspaceId);
 if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,93,'draft'))return {skipped:true};
 if(!(await db.query('SELECT 1 FROM '+table+' WHERE workspace_id=$1 AND enabled LIMIT 1',[workspaceId])).rowCount)return {skipped:true};
 return require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:jobKind,idempotencyKey:'rfq-competition:'+cycleId,payload:{cycleId},priority:64,maxAttempts:3});
}
async function run(db,workspaceId){
 const state=await policy.accountState(db,workspaceId);
 if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,93,'draft'))return {skipped:'This plan does not include supplier RFQs.'};
 const saved=(await db.query(`SELECT r.id,r.authorized_by FROM ${table} r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.role='owner'
  WHERE r.workspace_id=$1 AND r.enabled ORDER BY r.created_at,r.id LIMIT 50`,[workspaceId])).rows,rules=[];
 for(const row of saved)rules.push(await tx(db,c=>runRule(c,{workspaceId,actorId:row.authorized_by},row.id)));
 return {rules,reminders:await chaseDue(db,workspaceId)};
}
// The reply, if any: on the RFQ's mail thread or naming the RFQ in its subject.
async function findReply(c,workspaceId,deliveryId){
 const d=(await c.query(`SELECT d.*,r.snapshot->>'reference' AS reference,m.sent_at,m.external_thread_id FROM stockchief_runtime.agent_rfq_deliveries d
  JOIN stockchief_runtime.agent_rfq_requests r ON r.workspace_id=d.workspace_id AND r.id=d.request_id
  JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id WHERE d.workspace_id=$1 AND d.id=$2`,[workspaceId,deliveryId])).rows[0];
 if(!d)return null;if(d.reply_message_id)return d.reply_message_id;if(!d.sent_at)return null;
 const reply=(await c.query(`SELECT e.id FROM connection_email_messages e WHERE e.workspace_id=$1 AND e.supplier_id=$2 AND e.trust_status='TRUSTED' AND e.classification='supplier'
   AND e.created_at::timestamptz>=$3::timestamptz AND ((e.external_thread_id IS NOT NULL AND e.external_thread_id IN (SELECT external_thread_id FROM supplier_communications WHERE workspace_id=$1 AND id IN ($4,coalesce($5,$4))))
    OR right(lower(trim(coalesce(e.subject,''))),length($6))=lower($6))
  ORDER BY e.created_at,e.id LIMIT 1`,[workspaceId,d.supplier_id,d.sent_at,d.communication_id,d.chase_communication_id,'request for quotation · '+d.reference])).rows[0];
 if(!reply)return null;
 await c.query('UPDATE stockchief_runtime.agent_rfq_deliveries SET reply_message_id=$3 WHERE workspace_id=$1 AND id=$2 AND reply_message_id IS NULL',[workspaceId,deliveryId,reply.id]);
 return reply.id;
}
// Called while a supplier email is captured: an RFQ reply is read separately.
async function queueReply(client,workspaceId,{messageId,supplierId,threadId,subject}){
 const match=(await client.query(`SELECT 1 FROM stockchief_runtime.agent_rfq_deliveries d
  JOIN stockchief_runtime.agent_rfq_requests r ON r.workspace_id=d.workspace_id AND r.id=d.request_id
  JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id IN (d.communication_id,d.chase_communication_id)
  WHERE d.workspace_id=$1 AND d.supplier_id=$2 AND m.status='SENT' AND d.quote_document_id IS NULL
   AND (($3::text IS NOT NULL AND m.external_thread_id=$3) OR right(lower(trim(coalesce($4::text,''))),length('request for quotation · '||(r.snapshot->>'reference')))=lower('request for quotation · '||(r.snapshot->>'reference')))
  LIMIT 1`,[workspaceId,supplierId,threadId||null,subject||null])).rowCount;
 if(!match)return false;
 const state=await policy.accountState(client,workspaceId);if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,93,'draft'))return false;
 const scoped={query:(sql,values)=>client.query(sql,values),transaction:work=>work(client)};
 await require('../operations/postgres-job-queue').enqueue(scoped,{workspaceId,kind:replyKind,idempotencyKey:'supplier-rfq-reply:'+messageId,payload:{messageId},priority:55,maxAttempts:3});
 return true;
}
// Reads the reply. A reply in the RFQ's format becomes a quotation on its own
// when routine work is allowed; anything else waits for the owner to record.
async function captureReply(db,workspaceId,{messageId}){return tx(db,async c=>{
 const message=(await c.query("SELECT * FROM connection_email_messages WHERE workspace_id=$1 AND id=$2 AND trust_status='TRUSTED' AND classification='supplier' AND supplier_id IS NOT NULL",[workspaceId,messageId])).rows[0];
 if(!message)return {skipped:'Not a trusted supplier message.'};
 const candidates=(await c.query(`SELECT d.id FROM stockchief_runtime.agent_rfq_deliveries d JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id
  WHERE d.workspace_id=$1 AND d.supplier_id=$2 AND m.status='SENT' AND m.sent_at::timestamptz<=$3::timestamptz ORDER BY m.sent_at DESC,d.id DESC LIMIT 20`,[workspaceId,message.supplier_id,message.created_at])).rows;
 let delivery=null;
 for(const row of candidates)if(await findReply(c,workspaceId,row.id)===message.id){delivery=row.id;break;}
 if(!delivery)return {skipped:'Not a reply to an RFQ.'};
 const d=(await c.query('SELECT * FROM stockchief_runtime.agent_rfq_deliveries WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,delivery])).rows[0];
 if(d.quote_document_id)return {deliveryId:d.id,replayed:true};
 const r=await rfqs.request(c,{workspaceId,actorId:d.approved_by},d.request_id),ctx={workspaceId,actorId:r.prepared_by};
 const state=await policy.accountState(c,workspaceId);
 if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,93,'draft'))return {deliveryId:d.id,needsPerson:'plan'};
 const parsed=require('./supplier-rfq-reply-parser').parse(message.body_text,r.snapshot);
 if(parsed.problem)return {deliveryId:d.id,needsPerson:parsed.problem};
 const mode=await require('../autopilot/job-modes').restriction(c,workspaceId,93,true),stopped=await policy.stopped(c,workspaceId,state,action,true);
 if(mode||stopped||!(await require('../autopilot/postgres-service').getState(c,workspaceId)).canAutomate)return {deliveryId:d.id,needsPerson:mode||stopped||'StockChief is set to ask before acting. Record this quote yourself.'};
 await c.query('SAVEPOINT rfq_reply_capture');
 try{
  await source.owner(c,ctx);
  const evidence=require('./postgres-supplier-evidence'),checked=await evidence.assessQuotation(c,ctx,r,d.supplier_id,{...parsed.document,sourceMessageId:message.id});
  const saved=await evidence.recordQuotation(c,ctx,checked.payload);await c.query('RELEASE SAVEPOINT rfq_reply_capture');
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier quotation captured from an RFQ reply on its own',reference:r.id,after:{supplierId:d.supplier_id,documentId:saved.documentId,status:saved.status,accepted:false}});
  return {deliveryId:d.id,documentId:saved.documentId,status:saved.status};
 }catch(error){
  if(!held(error))throw error;await c.query('ROLLBACK TO SAVEPOINT rfq_reply_capture');await c.query('RELEASE SAVEPOINT rfq_reply_capture');
  return {deliveryId:d.id,needsPerson:error.message};
 }
});}
async function rules(db,ctx){
 return (await db.query(`SELECT r.*,l.name AS location_name,(SELECT count(DISTINCT request_id)::int FROM stockchief_runtime.agent_rfq_deliveries d WHERE d.workspace_id=r.workspace_id AND d.competition_rule_id=r.id AND d.automatic AND d.created_at>=now()-interval '168 hours') AS used,
  (SELECT array_agg(s.name ORDER BY s.name) FROM suppliers s WHERE s.workspace_id=r.workspace_id AND s.id=ANY(r.supplier_ids)) AS supplier_names,
  (SELECT array_agg(k.code ORDER BY k.code) FROM skus k WHERE k.workspace_id=r.workspace_id AND k.id=ANY(r.sku_ids)) AS sku_codes
  FROM ${table} r JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id WHERE r.workspace_id=$1 ORDER BY r.enabled DESC,r.created_at DESC,r.id DESC LIMIT 50`,[ctx.workspaceId])).rows;
}
// The page's form names are prefixed so they never clash with the RFQ form.
function fromForm(body){
 return {ruleId:body.ruleId,revision:body.revision,confirmed:body.confirmed,name:body.ruleName,newItems:body.ruleNewItems,threshold:body.ruleThreshold,currency:body.ruleCurrency,
  skuCodes:body.ruleSkuCodes,categories:body.ruleCategories,supplierNames:body.ruleSuppliers,locationId:body.ruleLocationId,connectorId:body.ruleConnectorId,
  replyDays:body.ruleReplyDays,deliveryDays:body.ruleDeliveryDays,chaseDays:body.ruleChaseDays,maxRequestsPerWeek:body.ruleMaxPerWeek};
}
module.exports={fromForm,save,stop,teach,rule,rules,sendAuthority,trained,example,needs,run,runRule,chaseDue,enqueue,findReply,queueReply,captureReply,jobKind,replyKind};
