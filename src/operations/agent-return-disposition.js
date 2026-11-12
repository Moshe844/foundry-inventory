'use strict';
// Job 113: a returned product's physical condition, recorded by the person
// who checked it, is decided as restock, repair or scrap by the owner's rules.
// A rule names a condition and, when the owner wants, one product, words in the
// customer's return reason, a highest goods value, a longest time since the
// goods left and the fewest days left before their batch expires. The most
// specific rule that covers a line decides it. Pro prepares decisions from a
// rule only after a matching, physically completed manual example teaches it;
// Custom needs no training. Decided restock and repair moves are then made by
// the worker on their own. Scrap is a write-off, and writing off stock always
// needs a person (plan page 13), so it waits for the owner's approval.
const policy=require('../commercial/agent-plan'),{ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {newId}=require('../lib/util'),{hash}=require('../pricing/postgres-promotions'),exact=require('../domain/exact-quantity'),money=require('../domain/currency');
const action='customer_return.plan_disposition',restockAction='customer_return.restock',kind='return.disposition-plan.v1',applyKind='return.disposition-apply.v1';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
const day=86400000;
function text(v,label,max=200){if(typeof v!=='string'||!v.trim()||v.trim().length>max||/[\u0000-\u001f\u007f]/.test(v))throw new ValidationError('Enter '+label+' on one plain line, up to '+max+' characters.');return v.trim();}
function condition(v){const code=text(v,'a condition code',40).toUpperCase();if(!/^[A-Z0-9][A-Z0-9_-]*$/.test(code))throw new ValidationError('Condition codes use letters, numbers, underscores or hyphens.');return code;}
function units(v){const n=Number(v);if(!Number.isSafeInteger(n)||n<1||n>100000)throw new ValidationError('Choose one to 100,000 whole units.');return n;}
function days(v,label){if(v===undefined||v===null||String(v).trim()==='')return null;const n=Number(v);if(!Number.isSafeInteger(n)||n<0||n>3650)throw new ValidationError('Enter '+label+' as whole days between 0 and 3,650.');return n;}
// The owner's optional rule conditions beyond product and physical condition.
function criteria(input,currency){
 const reason=input.reasonContains==null||String(input.reasonContains).trim()===''?null:text(input.reasonContains,'the words to look for in the return reason');
 const value=input.maximumValue==null||String(input.maximumValue).trim()===''?null:money.userToMinor(input.maximumValue,currency,{label:'Highest goods value'});
 if(value!==null&&!(value>0))throw new ValidationError('Enter a positive highest goods value.');
 const c={reason_contains:reason,maximum_value_minor:value,value_currency:value===null?null:currency,maximum_age_days:days(input.maximumAgeDays,'the longest time since the goods left'),minimum_expiry_days:days(input.minimumExpiryDays,'the fewest days before expiry')};
 const none=Object.values(c).every(v=>v===null);
 return {...c,criteria_key:none?'':hash([c.reason_contains?.toLowerCase()||null,c.maximum_value_minor,c.value_currency,c.maximum_age_days,c.minimum_expiry_days])};
}
function describe(p){
 return [p.reason_contains?'reason mentions “'+p.reason_contains+'”':null,p.maximum_value_minor!=null?'worth up to '+money.format(Number(p.maximum_value_minor),p.value_currency):null,
  p.maximum_age_days!=null?'left us within '+p.maximum_age_days+' days':null,p.minimum_expiry_days!=null?'at least '+p.minimum_expiry_days+' days before expiry':null].filter(Boolean).join(' · ');
}
async function owner(c,ctx,lock=false){
 const row=(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
 WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)${lock?' FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!row)throw new AuthorizationError('Only the current inventory owner can authorize return disposition facts and rules.');
 await require('./postgres-warehouse-access').assertInventoryWide(c,ctx);
 if(lock)await c.query('SELECT a.id FROM accounts a JOIN workspaces w ON w.owner_account_id=a.id WHERE w.id=$1 FOR UPDATE OF a',[ctx.workspaceId]);
}
async function access(c,ctx,{automatic=false,trained=false,stopped=true}={}){
 await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
 const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,113,automatic?'automatic':'draft',{trained});
 if(stopped){const reason=await policy.stopped(c,ctx.workspaceId,account,action,automatic);if(reason)throw new ValidationError(reason);}
 if(automatic){await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('The owner must enable routine work before automatic disposition planning.');}
 return account;
}
// The exact received return: every line, its received batches and cost, and
// the facts rules can use (value at the order price, when the goods left, the
// batch expiry dates). Lines already moved by this return's earlier decisions
// are marked done.
async function facts(c,ctx,id,{lock=false,allowDone=false}={}){
 const r=(await c.query(`SELECT r.id,r.return_number,r.status,r.resolution,r.reason,r.quarantine_location_id,l.name quarantine_name,l.is_active,l.custody_agreement_id,so.currency,so.customer_id,so.order_number
 FROM customer_returns r JOIN sales_orders so ON so.workspace_id=r.workspace_id AND so.id=r.sales_order_id
 JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.quarantine_location_id WHERE r.workspace_id=$1 AND r.id=$2${lock?' FOR UPDATE OF r':''}`,[ctx.workspaceId,id])).rows[0];
 if(!r)throw new NotFoundError('That customer return is not in this inventory.');
 if(r.status!=='RECEIVED'||!r.is_active||r.custody_agreement_id)throw new ValidationError('Receive every unit into an active internal quarantine location before recording physical inspection facts.');
 const lines=(await c.query(`SELECT rl.id,rl.sku_id,rl.sales_order_line_id,rl.quantity_authorized::text,rl.quantity_received::text,rl.quantity_restocked::text,rl.quantity_scrapped::text,rl.quantity_repair::text,
 rl.receive_movement_ids,rl.disposition_movement_ids,rl.tracking_evidence,s.code,i.name,i.tracking_mode,i.quantity_precision,i.secondary_unit_label,sol.unit_price_minor::text unit_price_minor,
 b.quantity_units::text cost_quantity,b.total_cost_minor::text cost_minor,
 EXISTS(SELECT 1 FROM sales_order_kit_components k WHERE k.workspace_id=rl.workspace_id AND k.sales_order_line_id=rl.sales_order_line_id) kit
 FROM customer_return_lines rl JOIN skus s ON s.workspace_id=rl.workspace_id AND s.id=rl.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 JOIN sales_order_lines sol ON sol.workspace_id=rl.workspace_id AND sol.id=rl.sales_order_line_id
 LEFT JOIN accounting_inventory_cost_balances b ON b.workspace_id=rl.workspace_id AND b.sku_id=rl.sku_id AND b.location_id=$3
 WHERE rl.workspace_id=$1 AND rl.customer_return_id=$2 ORDER BY rl.created_at,rl.id LIMIT 101`,[ctx.workspaceId,id,r.quarantine_location_id])).rows;
 const done=l=>Number(l.quantity_restocked)+Number(l.quantity_repair)+Number(l.quantity_scrapped)!==0;
 if(!lines.length||lines.length>100||new Set(lines.map(l=>l.sku_id)).size!==lines.length||lines.some(l=>!['quantity','lot','serial'].includes(l.tracking_mode)||l.quantity_precision!==0||l.secondary_unit_label||l.kit||Number(l.quantity_received)!==Number(l.quantity_authorized)||(!allowDone&&done(l))))throw new ValidationError('Rule planning covers one to 100 distinct whole-unit product lines, fully received and still uninspected. Use the regular return inspection for mixed conditions within a line, kits or measured goods.');
 const lotIds=[...new Set(lines.flatMap(l=>(JSON.parse(l.tracking_evidence||'{}').receivedBatches||[]).map(b=>b.lotId).filter(Boolean)))];
 const lots=lotIds.length?(await c.query('SELECT id,code,expires_at FROM lots WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,lotIds])).rows:[];
 const left=(await c.query(`SELECT greatest(
  (SELECT max(je.created_at::timestamptz) FROM accounting_journal_entries je WHERE je.workspace_id=$1 AND je.source_type='sale_fulfillment' AND je.status='POSTED' AND je.metadata::jsonb->>'salesOrderLineId'=ANY($2::text[])),
  (SELECT max(coalesce(nullif(s.delivered_at,''),s.shipped_at)::timestamptz) FROM sales_shipments s JOIN customer_returns x ON x.workspace_id=s.workspace_id AND x.sales_order_id=s.sales_order_id
   WHERE s.workspace_id=$1 AND x.id=$3 AND s.customer_return_id IS NULL AND s.status IN('SHIPPED','DELIVERED'))) AS at`,[ctx.workspaceId,lines.map(l=>l.sales_order_line_id),id])).rows[0]?.at;
 for(const l of lines){
  l.done=done(l);
  units(l.quantity_received);const cost=Number(l.cost_minor),qty=Number(l.cost_quantity);
  if(!l.done&&(!Number.isSafeInteger(cost)||cost<0||!Number.isSafeInteger(qty)||qty<Number(l.quantity_received)))throw new ValidationError('Reconcile the actual quarantine stock cost before preparing disposition.');
  l.writeoffMinor=l.done?0:exact.ratioMinor(cost,Number(l.quantity_received),qty);
  l.valueMinor=l.unit_price_minor==null?null:exact.costMinor(Number(l.quantity_received),Number(l.unit_price_minor));
  l.lots=[...new Set((JSON.parse(l.tracking_evidence||'{}').receivedBatches||[]).map(b=>b.lotId).filter(Boolean))].map(lotId=>{const lot=lots.find(x=>x.id===lotId);return {lotId,code:lot?.code||null,expiresAt:lot?.expires_at||null};});
 }
 const result={...r,leftAt:left?new Date(left).toISOString():null,lines};return {...result,sourceHash:hash(result)};
}
// Facts that change with the calendar are worked out when a decision is made.
function measure(f,l,now=Date.now()){
 return {valueMinor:l.valueMinor,ageDays:f.leftAt?Math.max(0,Math.floor((now-Date.parse(f.leftAt))/day)):null,
  daysToExpiry:l.lots.length?Math.min(...l.lots.map(x=>x.expiresAt?Math.floor((Date.parse(String(x.expiresAt).slice(0,10)+'T00:00:00Z')-now)/day):-Infinity)):null};
}
function covers(p,o,l,f,m){
 if(p.condition_code!==o.conditionCode||p.sku_id&&p.sku_id!==o.skuId)return false;
 if(p.reason_contains&&!String(f.reason||'').toLowerCase().includes(p.reason_contains.toLowerCase()))return false;
 if(p.maximum_value_minor!=null&&(m.valueMinor==null||p.value_currency!==f.currency||m.valueMinor>Number(p.maximum_value_minor)))return false;
 if(p.maximum_age_days!=null&&(m.ageDays==null||m.ageDays>p.maximum_age_days))return false;
 if(p.minimum_expiry_days!=null&&(m.daysToExpiry==null||m.daysToExpiry<p.minimum_expiry_days))return false;
 return true;
}
const specificity=p=>(p.sku_id?16:0)+[p.reason_contains,p.maximum_value_minor,p.maximum_age_days,p.minimum_expiry_days].filter(x=>x!=null).length;
// The most specific enabled rule that covers the line, if its unit limit fits.
function pick(rules,o,l,f,m){
 const fit=rules.filter(p=>covers(p,o,l,f,m)).sort((a,b)=>specificity(b)-specificity(a)||String(a.created_at).localeCompare(String(b.created_at))||a.id.localeCompare(b.id))[0];
 return fit&&o.quantity<=fit.maximum_units?fit:null;
}
async function assessment(c,ctx,id,lock=false){const p=(await c.query('SELECT * FROM stockchief_runtime.agent_return_assessments WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];if(!p)throw new NotFoundError('That physical return assessment is not in this inventory.');return p;}
async function location(c,ctx,id){if(!(await c.query('SELECT 1 FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,id])).rowCount)throw new ValidationError('Choose an active internal disposition location.');}
async function rule(c,ctx,id,lock=false){const p=(await c.query('SELECT * FROM stockchief_runtime.agent_return_disposition_rules WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];if(!p)throw new NotFoundError('That return rule is not in this inventory.');return p;}
async function example(c,ctx,p,id){
 if(!id)return false;
 const a=await assessment(c,ctx,id),r=(await c.query('SELECT inspected_by_user_id,inspected_at FROM customer_returns WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,a.return_id])).rows[0];
 const o=a.observations.find(o=>(!p.sku_id||o.skuId===p.sku_id)&&o.conditionCode===p.condition_code),d=o&&a.proposal?.lines.find(d=>d.lineId===o.lineId);
 if(a.status!=='APPLIED'||a.applied_by!==ctx.actorId||a.proposal?.automatic||a.proposal?.byRules||!o||!d||d.outcome!==p.outcome||(d.destinationId||null)!==(p.destination_id||null)||p.maximum_units>o.quantity||r?.inspected_by_user_id!==ctx.actorId||!r.inspected_at)throw new ValidationError('Pro needs an individually chosen, physically completed inspection with the same product, condition, outcome and destination, covering this unit limit.');
 const current=(await c.query('SELECT quantity_restocked::text,quantity_repair::text,quantity_scrapped::text FROM customer_return_lines WHERE workspace_id=$1 AND id=$2 AND customer_return_id=$3',[ctx.workspaceId,o.lineId,a.return_id])).rows[0];
 if(!current||Number(current[{RESTOCK:'quantity_restocked',REPAIR:'quantity_repair',SCRAP:'quantity_scrapped'}[p.outcome]])!==o.quantity)throw new ValidationError('The completed physical example no longer proves this disposition.');return true;
}
async function saveRule(db,ctx,input){return tx(db,async c=>{
 await owner(c,ctx,true);await access(c,ctx,{stopped:false});
 const prior=input.id?await rule(c,ctx,input.id,true):null;
 const p={sku_id:prior?prior.sku_id:input.skuId||null,condition_code:condition(input.conditionCode),condition_label:text(input.conditionLabel,'the physical condition label'),outcome:String(input.outcome||'').toUpperCase(),destination_id:input.destinationId||null,maximum_units:units(input.maximumUnits)};
 if(!prior&&!p.sku_id&&input.allProducts!=='yes'){const rows=(await c.query('SELECT id FROM skus WHERE workspace_id=$1 AND code=$2 LIMIT 2',[ctx.workspaceId,text(input.skuCode,'the exact SKU code',240)])).rows;if(rows.length!==1)throw new ValidationError('Match the exact SKU code to one product in this inventory.');p.sku_id=rows[0].id;}
 if(!['RESTOCK','REPAIR','SCRAP'].includes(p.outcome)||input.confirmed!=='yes')throw new ValidationError('Confirm the exact product, physical condition, disposition and unit limit.');
 if(p.sku_id&&!(await c.query("SELECT 1 FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=$2 AND s.is_active=1 AND i.is_active=1 AND i.tracking_mode IN ('quantity','lot','serial') AND i.quantity_precision=0 AND i.secondary_unit_label IS NULL",[ctx.workspaceId,p.sku_id])).rowCount)throw new ValidationError('Choose an active whole-unit product.');
 const base=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency;
 Object.assign(p,prior?{reason_contains:prior.reason_contains,maximum_value_minor:prior.maximum_value_minor,value_currency:prior.value_currency,maximum_age_days:prior.maximum_age_days,minimum_expiry_days:prior.minimum_expiry_days,criteria_key:prior.criteria_key}:criteria(input,money.code(input.currency||base||'USD')));
 if(p.outcome==='SCRAP')p.destination_id=null;else await location(c,ctx,p.destination_id);
 if(prior&&(Number(input.revision)!==prior.revision||prior.condition_code!==p.condition_code))throw new ValidationError('Reload the rule; its product, condition and conditions stay fixed.');
 await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
 const id=prior?.id||newId('return-rule');await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'return-rule:'+id,8192,{finished:true});
 if(prior)await c.query('UPDATE stockchief_runtime.agent_return_disposition_rules SET condition_label=$3,outcome=$4,destination_id=$5,maximum_units=$6,enabled=true,routine_enabled=false,trained_assessment_id=NULL,authorized_by=$7,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,p.condition_label,p.outcome,p.destination_id,p.maximum_units,ctx.actorId]);
 else {const inserted=await c.query(`INSERT INTO stockchief_runtime.agent_return_disposition_rules(id,workspace_id,sku_id,condition_code,condition_label,outcome,destination_id,maximum_units,authorized_by,reason_contains,maximum_value_minor,value_currency,maximum_age_days,minimum_expiry_days,criteria_key)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(workspace_id,(coalesce(sku_id,'')),condition_code,criteria_key) DO NOTHING RETURNING id`,[id,ctx.workspaceId,p.sku_id,p.condition_code,p.condition_label,p.outcome,p.destination_id,p.maximum_units,ctx.actorId,p.reason_contains,p.maximum_value_minor,p.value_currency,p.maximum_age_days,p.minimum_expiry_days,p.criteria_key]);
  if(!inserted.rowCount)throw new ValidationError('This product and condition already have a rule with these conditions. Open the existing rule.');}
 await require('./postgres-security-audit').record(c,ctx,{action:'Return disposition rule saved for individual review',reference:id,after:{...p,conditions:describe(p)||'none'}});return {id};
 });}
async function configure(db,ctx,id,input){return tx(db,async c=>{
 await owner(c,ctx,true);const p=await rule(c,ctx,id,true);if(Number(input.revision)!==p.revision)throw new ValidationError('Reload the current return rule before changing it.');
 if(input.stop==='yes'){await c.query('UPDATE stockchief_runtime.agent_return_disposition_rules SET enabled=false,routine_enabled=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);await require('./postgres-security-audit').record(c,ctx,{action:'Return disposition rule stopped',reference:id,after:{existingPhysicalHoldsPreserved:true}});return {id,stopped:true};}
 const trained=await example(c,ctx,p,input.exampleId||p.trained_assessment_id);await access(c,ctx,{automatic:true,trained});
 if(input.confirmed!=='yes')throw new ValidationError('Confirm this exact automatic decision authority. Write-offs still need your separate approval.');
 if(p.outcome!=='SCRAP')await location(c,ctx,p.destination_id);await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],p.enabled?0:1);
 await c.query('UPDATE stockchief_runtime.agent_return_disposition_rules SET enabled=true,routine_enabled=true,trained_assessment_id=$3,authorized_by=$4,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,trained?(input.exampleId||p.trained_assessment_id):null,ctx.actorId]);await require('./postgres-security-audit').record(c,ctx,{action:'Routine return decisions authorized',reference:id,after:{maximumUnits:p.maximum_units,conditionCode:p.condition_code,conditions:describe(p)||'none',outcome:p.outcome,destinationId:p.destination_id,completedExampleId:trained?(input.exampleId||p.trained_assessment_id):null,writeOffsNeedSeparateApproval:true}});return {id};
 });}
async function observe(db,ctx,input){return tx(db,async c=>{
 await owner(c,ctx,true);await access(c,ctx,{stopped:false});const f=await facts(c,ctx,input.returnId,{lock:true});
 if(input.confirmed!=='yes'||input.sourceHash!==f.sourceHash||!Array.isArray(input.lines)||input.lines.length!==f.lines.length)throw new ValidationError('Confirm the exact fully received products and the physical condition you actually inspected.');
 const observations=f.lines.map(l=>{const matches=input.lines.filter(x=>x.lineId===l.id);if(matches.length!==1)throw new ValidationError('Record each received product exactly once.');const raw=matches[0];return {lineId:l.id,skuId:l.sku_id,sku:l.code,product:l.name,quantity:Number(l.quantity_received),conditionCode:condition(raw.conditionCode),note:text(raw.note,'what you physically checked',500)};});
 const prior=(await c.query("SELECT * FROM stockchief_runtime.agent_return_assessments WHERE workspace_id=$1 AND return_id=$2 AND status IN('OBSERVED','READY') FOR UPDATE",[ctx.workspaceId,f.id])).rows[0];
 if(prior){if(prior.source_hash===f.sourceHash&&hash(prior.observations)===hash(observations))return {id:prior.id,replayed:true};throw new ValidationError('Stop the existing unreviewed assessment before recording different physical facts.');}
 const id=newId('return-assessment');await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'return-assessment:'+id,Buffer.byteLength(JSON.stringify({f,observations}))*2+32768,{finished:true});
 await c.query('INSERT INTO stockchief_runtime.agent_return_assessments(id,workspace_id,return_id,observed_by,source_snapshot,observations,source_hash) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)',[id,ctx.workspaceId,f.id,ctx.actorId,JSON.stringify(f),JSON.stringify(observations),f.sourceHash]);
 await require('./postgres-job-queue').enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,idempotencyKey:id,payload:{assessmentId:id,ownerId:ctx.actorId},priority:65});return {id};
 });}
async function prepare(db,ctx,id,input={}, {automatic=false}={}){return tx(db,async c=>{
 await owner(c,ctx,true);await access(c,ctx,{stopped:false});const a=await assessment(c,ctx,id,true);
 if(a.status==='APPLIED')return {id,replayed:true};if(!['OBSERVED','READY'].includes(a.status))throw new ValidationError('This assessment was stopped. Record a new physical inspection.');
 if(automatic&&a.status==='READY')return {id,replayed:true,automatic:Boolean(a.proposal?.automatic)};if(!automatic&&(Number(input.revision)!==a.revision||input.confirmed!=='yes'))throw new ValidationError('Reload and confirm the current physical assessment before preparing its decisions.');
 if((a.proposal?.lines||[]).some(l=>l.appliedAt))throw new ValidationError('Part of this return was already moved. Approve or stop the remaining decisions.');
 const f=await facts(c,ctx,a.return_id,{lock:true});if(f.sourceHash!==a.source_hash)throw new ValidationError('The return, quarantine stock or cost changed. Stop this assessment and inspect the current facts.');
 const byRules=automatic||input.byRules==='yes',rules=byRules?(await c.query('SELECT * FROM stockchief_runtime.agent_return_disposition_rules WHERE workspace_id=$1 AND (sku_id IS NULL OR sku_id=ANY($2::text[])) AND enabled ORDER BY id FOR SHARE',[ctx.workspaceId,a.observations.map(o=>o.skuId)])).rows:[];
 const lines=[],destinations=new Set();let allTrained=true;
 for(const o of a.observations){
  const l=f.lines.find(x=>x.id===o.lineId),m=measure(f,l),p=byRules?pick(rules.filter(r=>r.authorized_by===ctx.actorId),o,l,f,m):null,manual=(input.lines||[]).find(x=>x.lineId===o.lineId);
  if(byRules&&!p)throw new ValidationError('No current owner rule covers '+o.sku+' / '+o.conditionCode+' and this quantity. Choose this disposition individually.');
  if(automatic){if(!p.routine_enabled)throw new ValidationError('This rule needs individual disposition review.');allTrained=Boolean(await example(c,ctx,p,p.trained_assessment_id))&&allTrained;}
  const outcome=byRules?p.outcome:String(manual?.outcome||'').toUpperCase(),destinationId=outcome==='SCRAP'?null:(byRules?p.destination_id:manual?.destinationId);
  if(!['RESTOCK','REPAIR','SCRAP'].includes(outcome))throw new ValidationError('Choose restock, repair or scrap for every physically inspected product.');if(destinationId){if(!destinations.has(destinationId))await location(c,ctx,destinationId);destinations.add(destinationId);}else if(outcome!=='SCRAP')throw new ValidationError('Choose the actual disposition location.');
  lines.push({...o,outcome,destinationId,writeoffMinor:outcome==='SCRAP'?l.writeoffMinor:0,ruleId:byRules?p.id:null,ruleRevision:byRules?p.revision:null,ruleConditions:byRules?describe(p)||null:null,...m});
 }
 await access(c,ctx,{automatic,trained:allTrained});const proposal={automatic,byRules,lines};
 await c.query("UPDATE stockchief_runtime.agent_return_assessments SET status='READY',proposal=$3::jsonb,problem=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,JSON.stringify(proposal)]);
 if(automatic&&lines.some(l=>l.outcome!=='SCRAP'))await require('./postgres-job-queue').enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind:applyKind,idempotencyKey:'apply:'+id,payload:{assessmentId:id,ownerId:ctx.actorId},priority:65});
 return {id,automatic};
 });}
// Moves the chosen lines through the return's own inspection path: restock and
// repair transfer the exact batches and serials at their recorded cost; scrap
// issues them and writes off that cost. Later lines can follow separately.
async function applyLines(c,ctx,a,f,chosen,{automatic}){
 const ids=chosen.map(l=>l.lineId).sort();
 const result=await require('./postgres-returns').inspectCustomerReturn(scoped(c),ctx,a.return_id,{partial:true,idempotencyKey:'agent-return-disposition:'+a.id+':'+hash(ids).slice(0,24),lines:chosen.map(l=>({lineId:l.lineId,restock:l.outcome==='RESTOCK'?l.quantity:0,repair:l.outcome==='REPAIR'?l.quantity:0,scrap:l.outcome==='SCRAP'?l.quantity:0,restockLocationId:l.outcome==='RESTOCK'?l.destinationId:null,repairLocationId:l.outcome==='REPAIR'?l.destinationId:null,conditionNote:l.conditionCode+': '+l.note}))});
 for(const d of chosen.filter(l=>l.outcome==='REPAIR')){
  const holdId=newId('return-repair');await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'return-repair:'+holdId,8192,{finished:true});
  await c.query('INSERT INTO stockchief_runtime.agent_return_repair_holds(id,workspace_id,assessment_id,return_line_id,sku_id,location_id,quantity) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(return_line_id) DO NOTHING',[holdId,ctx.workspaceId,a.id,d.lineId,d.skuId,d.destinationId,d.quantity]);
 }
 const at=new Date().toISOString(),proposal={...a.proposal,lines:a.proposal.lines.map(l=>ids.includes(l.lineId)?{...l,appliedAt:at,appliedBy:ctx.actorId,appliedAutomatically:automatic}:l)};
 const finished=proposal.lines.every(l=>l.appliedAt),fresh=finished?null:await facts(c,ctx,a.return_id,{lock:true,allowDone:true});
 await c.query(`UPDATE stockchief_runtime.agent_return_assessments SET proposal=$3::jsonb,status=CASE WHEN $4 THEN 'APPLIED' ELSE status END,applied_by=CASE WHEN $4 THEN $5 ELSE applied_by END,
  applied_at=CASE WHEN $4 THEN clock_timestamp() ELSE applied_at END,source_hash=coalesce($6,source_hash),source_snapshot=coalesce($7::jsonb,source_snapshot),problem=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,
  [ctx.workspaceId,a.id,JSON.stringify(proposal),finished,ctx.actorId,fresh?.sourceHash||null,fresh?JSON.stringify(fresh):null]);
 await require('./postgres-security-audit').record(c,ctx,{action:automatic?'Returned goods moved on their own':'Physically inspected return disposition approved',reference:a.id,after:{returnId:a.return_id,automatic,lines:chosen.map(l=>({sku:l.sku,outcome:l.outcome,quantity:l.quantity,writeoffMinor:l.writeoffMinor,rule:l.ruleConditions||null})),remaining:proposal.lines.filter(l=>!l.appliedAt).length,refundNotPerformed:true}});
 return result;
}
async function apply(db,ctx,id,input){return tx(db,async c=>{
 await owner(c,ctx,true);await access(c,ctx);const a=await assessment(c,ctx,id,true);if(a.status==='APPLIED')return {id,replayed:true};
 if(a.status!=='READY'||input.confirmed!=='yes'||Number(input.revision)!==a.revision||input.proposalHash!==hash(a.proposal))throw new ValidationError('Review and confirm the current exact disposition before changing stock.');
 const f=await facts(c,ctx,a.return_id,{lock:true,allowDone:true});if(f.sourceHash!==a.source_hash)throw new ValidationError('The physical return, quarantine stock or cost changed. Stop this assessment and inspect the current facts.');
 const remaining=a.proposal.lines.filter(l=>!l.appliedAt);
 if(remaining.some(l=>l.outcome==='SCRAP')&&input.writeoffConfirmed!=='yes')throw new ValidationError('Separately approve the exact returned-stock write-off before scrapping anything.');
 for(const d of remaining){if(d.ruleId){const p=await rule(c,ctx,d.ruleId);if(!p.enabled||p.revision!==d.ruleRevision||p.authorized_by!==ctx.actorId)throw new ValidationError('A disposition rule changed or stopped. Prepare and review the current decisions again.');}if(d.destinationId)await location(c,ctx,d.destinationId);}
 const result=await applyLines(c,ctx,a,f,remaining,{automatic:false});return {id,result};
 });}
// The worker makes the restock and repair moves a routine rule decided; a
// write-off always waits for the owner.
async function applyRoutine(db,workspaceId,id,ownerId){
 const ctx={workspaceId,actorId:ownerId};
 try{return await tx(db,async c=>{
  await owner(c,ctx,true);const a=await assessment(c,ctx,id,true);
  if(a.status!=='READY'||!a.proposal?.automatic)return {id,skipped:true};
  const chosen=[],reasons=new Set();let account=null;
  for(const d of a.proposal.lines.filter(l=>!l.appliedAt&&l.outcome!=='SCRAP')){
   const p=d.ruleId?await rule(c,ctx,d.ruleId):null;
   if(!p||!p.enabled||!p.routine_enabled||p.revision!==d.ruleRevision||p.authorized_by!==ctx.actorId){reasons.add('A disposition rule changed or stopped. Review the remaining decisions.');continue;}
   account=account||await access(c,ctx,{automatic:true,trained:Boolean(await example(c,ctx,p,p.trained_assessment_id))});
   // Putting goods back into sellable stock is also job 114's step.
   if(d.outcome==='RESTOCK'){
    policy.requireJob(account.plan,114,'automatic');
    const hold=await policy.stopped(c,workspaceId,account,restockAction,true);if(hold){reasons.add(hold);continue;}
   }
   chosen.push(d);
  }
  if(!chosen.length){if(reasons.size)await c.query('UPDATE stockchief_runtime.agent_return_assessments SET problem=$3 WHERE workspace_id=$1 AND id=$2',[workspaceId,id,[...reasons].join(' ').slice(0,500)]);return {id,applied:[]};}
  const f=await facts(c,ctx,a.return_id,{lock:true,allowDone:true});if(f.sourceHash!==a.source_hash)throw new ValidationError('The physical return, quarantine stock or cost changed. Stop this assessment and inspect the current facts.');
  for(const d of chosen)if(d.destinationId)await location(c,ctx,d.destinationId);
  await applyLines(c,ctx,a,f,chosen,{automatic:true});
  if(reasons.size)await c.query('UPDATE stockchief_runtime.agent_return_assessments SET problem=$3 WHERE workspace_id=$1 AND id=$2',[workspaceId,id,[...reasons].join(' ').slice(0,500)]);
  return {id,applied:chosen.map(l=>l.lineId)};
 });}catch(error){if(![400,402,403,404,422].includes(error.status))throw error;await db.query("UPDATE stockchief_runtime.agent_return_assessments SET problem=$3 WHERE workspace_id=$1 AND id=$2 AND status='READY'",[workspaceId,id,String(error.message).slice(0,500)]);return {id,held:true,reason:error.message};}
}
async function stop(db,ctx,id,input){return tx(db,async c=>{await owner(c,ctx,true);const a=await assessment(c,ctx,id,true);if(input.confirmed!=='yes'||Number(input.revision)!==a.revision)throw new ValidationError('Reload and confirm stopping this unreviewed assessment.');if(a.status==='APPLIED')throw new ValidationError('An applied physical disposition cannot be undone here.');await c.query("UPDATE stockchief_runtime.agent_return_assessments SET status='STOPPED',revision=revision+1 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id]);return {id};});}
async function onObservation(db,workspaceId,id,ownerId){try{return await prepare(db,{workspaceId,actorId:ownerId},id,{}, {automatic:true});}catch(error){if(![400,402,403,404,422].includes(error.status))throw error;await db.query("UPDATE stockchief_runtime.agent_return_assessments SET problem=$3 WHERE workspace_id=$1 AND id=$2 AND status='OBSERVED'",[workspaceId,id,String(error.message).slice(0,500)]);return {held:true,reason:error.message};}}
async function repairHolds(c,ctx,ids,lock=false){return (await c.query(`SELECT h.*,s.code,i.name,l.name location_name,r.return_number,b.on_hand::text,b.quality_held::text,cb.quantity_units::text cost_quantity,cb.total_cost_minor::text cost_minor
 FROM stockchief_runtime.agent_return_repair_holds h JOIN skus s ON s.workspace_id=h.workspace_id AND s.id=h.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 JOIN locations l ON l.workspace_id=h.workspace_id AND l.id=h.location_id JOIN customer_return_lines rl ON rl.workspace_id=h.workspace_id AND rl.id=h.return_line_id JOIN customer_returns r ON r.workspace_id=rl.workspace_id AND r.id=rl.customer_return_id
 JOIN balances b ON b.workspace_id=h.workspace_id AND b.sku_id=h.sku_id AND b.location_id=h.location_id LEFT JOIN accounting_inventory_cost_balances cb ON cb.workspace_id=h.workspace_id AND cb.sku_id=h.sku_id AND cb.location_id=h.location_id
 WHERE h.workspace_id=$1 AND h.id=ANY($2::text[]) ORDER BY h.id${lock?' FOR UPDATE OF h,b':''}`,[ctx.workspaceId,ids])).rows.map(p=>({...p,sourceHash:hash(p)}));}
async function repairHold(c,ctx,id,lock=false){const p=(await repairHolds(c,ctx,[id],lock))[0];if(!p)throw new NotFoundError('That held repair is not in this inventory.');return p;}
async function releaseRepair(db,ctx,id,input){return tx(db,async c=>{
 await owner(c,ctx,true);await access(c,ctx);const p=await repairHold(c,ctx,id,true);if(p.status==='RELEASED')return {id,replayed:true};
 if(input.confirmed!=='yes'||input.sourceHash!==p.sourceHash)throw new ValidationError('Confirm the current exact goods were repaired, physically rechecked and are ready for sale.');const note=text(input.note,'the actual completed repair and checks',500);await location(c,ctx,input.destinationId);
 await c.query("UPDATE stockchief_runtime.agent_return_repair_holds SET status='RELEASED',released_by=$3,release_note=$4,released_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,ctx.actorId,note]);
 if(input.destinationId!==p.location_id){const movement=await require('../domain/postgres-inventory-engine').transfer(scoped(c),ctx,{skuId:p.sku_id,sourceLocationId:p.location_id,destinationLocationId:input.destinationId,quantity:p.quantity,reference:'Repaired '+p.return_number,idempotencyKey:'return-repair-release:'+id});await require('../accounting/postgres-costing').transferInTransaction(c,ctx,{outMovementId:movement.outMovementId,inMovementId:movement.inMovementId,sourceType:'customer_return_repair_complete',sourceRecordId:id});}
 await require('./postgres-security-audit').record(c,ctx,{action:'Physically repaired return released after human reinspection',reference:id,after:{quantity:p.quantity,destinationId:input.destinationId,note}});return {id};
 });}
async function screen(db,ctx,input={}){
 await owner(db,ctx);const account=await policy.accountState(db,ctx.workspaceId),allowed=policy.usesAgentTerms(account)&&policy.permits(account.plan,113,'draft');
 const assessments=(await db.query('SELECT a.id,a.status,a.problem,a.created_at,r.return_number FROM stockchief_runtime.agent_return_assessments a JOIN customer_returns r ON r.workspace_id=a.workspace_id AND r.id=a.return_id WHERE a.workspace_id=$1 ORDER BY a.created_at DESC,a.id LIMIT 101',[ctx.workspaceId])).rows;
 const places=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL ORDER BY name,id LIMIT 251',[ctx.workspaceId])).rows;
 const rules=(await db.query("SELECT p.*,coalesce(s.code,'Any product') code,l.name destination_name FROM stockchief_runtime.agent_return_disposition_rules p LEFT JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id LEFT JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.destination_id WHERE p.workspace_id=$1 ORDER BY p.created_at,p.id LIMIT 501",[ctx.workspaceId])).rows.map(p=>({...p,conditions:describe(p)}));
 const returns=allowed?(await db.query("SELECT r.id,r.return_number,so.order_number,c.name FROM customer_returns r JOIN sales_orders so ON so.workspace_id=r.workspace_id AND so.id=r.sales_order_id JOIN customers c ON c.workspace_id=so.workspace_id AND c.id=so.customer_id WHERE r.workspace_id=$1 AND r.status='RECEIVED' ORDER BY r.created_at,r.id LIMIT 101",[ctx.workspaceId])).rows:[];
 const repairIds=(await db.query("SELECT id FROM stockchief_runtime.agent_return_repair_holds WHERE workspace_id=$1 AND status='HELD' ORDER BY created_at,id LIMIT 101",[ctx.workspaceId])).rows,repairs=repairIds.length?await repairHolds(db,ctx,repairIds.slice(0,100).map(r=>r.id)):[];
 let selected=null,physical=null,problem=null;if(input.id){selected=await assessment(db,ctx,input.id);selected.proposalHash=selected.proposal?hash(selected.proposal):null;}
 if(allowed&&input.returnId){try{physical=await facts(db,ctx,input.returnId);}catch(e){if(![400,402,403,404,422].includes(e.status))throw e;problem=e.message;}}
 const base=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency||'USD';
 return {allowed,plan:account.plan,shadow:account.shadow,currency:base,repairs,moreRepairs:repairIds.length>100,assessments:assessments.slice(0,100),moreAssessments:assessments.length>100,places:places.slice(0,250),morePlaces:places.length>250,rules:rules.slice(0,500),moreRules:rules.length>500,returns:returns.slice(0,100),moreReturns:returns.length>100,selected,physical,problem};
}
async function readPage(db,ctx){const s=await screen(db,ctx);return {summary:'Recorded physical conditions are decided as restock, repair or scrap by your rules: condition, product, return reason, goods value, time since the goods left and days before expiry. Pro needs a matching completed manual example for routine decisions; Custom does not need training. Restock and repair moves then happen on their own; every write-off needs your approval.',rows:s.assessments.map(a=>({Return:a.return_number,Status:a.status.replace('_',' '),Review:a.problem||'',link:'/autopilot/return-disposition?id='+a.id})),more:s.moreAssessments};}
function notices(summary){if(!summary||!Number(summary.n))return [];return [{kind:'order',importance:'Needs You',priority:50,title:Number(summary.n)+' return task'+(Number(summary.n)===1?' needs':'s need')+' review',happened:'Return goods await disposition or completed-repair checks and remain protected from sale.',why:'Review the exact decisions, approve write-offs, stop an outdated assessment, or confirm a physically completed repair. Refunds remain separate.',actionLabel:'Review return decisions',sourceId:'return-disposition-assessments',href:'/autopilot/return-disposition',createdAt:summary.created_at,at:summary.created_at}];}
module.exports={owner,facts,assessment,saveRule,configure,observe,prepare,apply,applyRoutine,stop,onObservation,repairHold,releaseRepair,screen,notices,describe,kind,applyKind,action,restockAction,definition:{id:113,key:'return-disposition',label:'Review return restock, repair or scrap rules',readPage}};
