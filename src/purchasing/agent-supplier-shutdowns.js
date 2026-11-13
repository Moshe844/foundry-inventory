'use strict';
// Job 147: plans ahead for holidays and supplier shutdowns (e.g. Chinese New
// Year). Growth suggests. Pro and Custom keep each saved plan current on their
// own and, inside the owner's goods-value limit, prepare its one purchase draft
// before the supplier's last order date. Approval, sending, payment and
// receiving keep their ordinary controls; a prepared draft can be undone.
const source=require('./supplier-shutdown-source'),policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions');
const {newId}=require('../lib/util'),{ValidationError,NotFoundError}=require('../domain/errors'),installed=require('../db/schema-installed');
const action='purchasing.plan_supplier_shutdown',jobKind='purchasing.shutdown-plan.v1';
// One closure can cover several suppliers at once, one plan per supplier.
async function preview(db,ctx,input){
 await source.owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,147,'suggest');
 const {scopes,notes}=await require('./planning-stock-source').scopes(db,ctx,input);
 const drafts=[];for(const scope of scopes)drafts.push(await source.facts(db,ctx,scope));
 return {drafts,notes};
}
async function access(c,ctx,{automatic=false}={}){
 await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);await source.owner(c,ctx);
 const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,147,automatic?'automatic':'draft'),stop=await policy.stopped(c,ctx.workspaceId,account,action,automatic);if(stop)throw new ValidationError(stop);return account;
}
async function get(c,ctx,id,lock=false){const row=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_shutdowns WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('That supplier shutdown is not in this inventory.');return row;}
const profile=p=>hash({supplier:p.supplier,location:p.location,locationIds:p.locationIds,products:p.products});
const warningText=facts=>facts.warnings.length?facts.warnings.map(w=>(w.sku?w.sku+': ':'')+w.reason).join(' ').slice(0,500):null;
// The draft already prepared for this shutdown and not cancelled, if any.
async function prepared(c,ctx,shutdownId){
 return (await c.query(`SELECT p.purchase_order_id FROM stockchief_runtime.agent_supplier_shutdown_plans p JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.purchase_order_id
  WHERE p.workspace_id=$1 AND p.shutdown_id=$2 AND o.status<>'CANCELLED' ORDER BY p.purchase_created_at DESC LIMIT 1`,[ctx.workspaceId,shutdownId])).rows[0]?.purchase_order_id||null;
}
async function write(c,ctx,project,p,{automatic=false}={}){
 const prior=(await c.query('SELECT id FROM stockchief_runtime.agent_supplier_shutdown_plans WHERE workspace_id=$1 AND shutdown_id=$2 AND source_fingerprint=$3',[ctx.workspaceId,project.id,p.sourceFingerprint])).rows[0];if(prior)return {id:prior.id,shutdownId:project.id,replayed:true};
 const id=newId('shutdown-plan');await c.query('INSERT INTO stockchief_runtime.agent_supplier_shutdown_plans(id,workspace_id,shutdown_id,source_fingerprint,source_snapshot,automatic,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,ctx.workspaceId,project.id,p.sourceFingerprint,p,automatic,ctx.actorId]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier shutdown stock plan prepared',reference:id,after:{shutdownId:project.id,sourceFingerprint:p.sourceFingerprint,automatic,totalMinor:p.calculated.totalMinor,warnings:p.warnings.length,purchaseCreated:false}});return {id,shutdownId:project.id,replayed:false};
}
async function save(db,ctx,input){return db.transaction(async c=>{
 await access(c,ctx);const p=await source.facts(c,ctx,input);if(input.confirmed!=='yes'||input.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('Review the supplier notice, actual dates, recorded stock and exact plan before saving.');
 let project=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_shutdowns WHERE workspace_id=$1 AND supplier_id=$2 AND location_id=$3 AND reference=$4 FOR UPDATE',[ctx.workspaceId,p.supplier.id,p.location.id,p.scope.reference])).rows[0];
 if(project&&hash(project.scope)!==hash(p.scope))throw new ValidationError('This notice already identifies different dates or products. Stop the earlier scope and record the corrected supplier notice separately.');
 if(!project){const id=newId('supplier-shutdown'),inserted=await c.query('INSERT INTO stockchief_runtime.agent_supplier_shutdowns(id,workspace_id,supplier_id,location_id,reference,scope,authorized_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,supplier_id,location_id,reference) DO NOTHING RETURNING *',[id,ctx.workspaceId,p.supplier.id,p.location.id,p.scope.reference,p.scope,ctx.actorId]);if(!inserted.rowCount){const error=Error('This supplier shutdown was recorded concurrently. Retry the exact reviewed scope.');error.code='40001';throw error;}project=inserted.rows[0];}
 return write(c,ctx,project,p);
},{isolation:'SERIALIZABLE',retrySafe:true});}
// Saves every reviewed supplier plan from one holiday or closure preview.
async function saveAll(db,ctx,input){
 let plans;try{plans=JSON.parse(String(input.plans||''));}catch{plans=null;}
 if(!Array.isArray(plans)||!plans.length||plans.length>20)throw new ValidationError('Review the supplier plans again before saving.');
 const saved=[];
 for(const p of plans)saved.push(await save(db,ctx,{...input,plans:undefined,supplierId:String(p?.supplierId||''),skuIds:Array.isArray(p?.skuIds)?p.skuIds.map(String):[],sourceFingerprint:String(p?.sourceFingerprint||'')}));
 return saved;
}
// The worker run: refresh the plan and, inside the owner's limit, prepare its
// one purchase draft. Anything outside the limit or the source facts waits in
// Needs you with the reason.
async function generate(db,ctx,id){return db.transaction(async c=>{
 await access(c,ctx,{automatic:true});const p=await get(c,ctx,id,true);if(!p.enabled||p.authorized_by!==ctx.actorId||!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Automatic shutdown planning is stopped or needs the current owner’s routine authority.');
 const facts=await source.facts(c,ctx,p.scope);if(profile(facts)!==p.authorized_profile_hash)throw new ValidationError('The supplier, receiving locations, products or purchase terms changed. Review the saved planning scope.');
 const result=await write(c,ctx,p,facts,{automatic:true});let purchase=null,reason=warningText(facts);
 if(!reason&&p.maximum_minor!=null&&facts.calculated.rows.some(r=>r.quantityUnits>0)&&!(await prepared(c,ctx,p.id))){
  if(facts.calculated.totalMinor>Number(p.maximum_minor))reason='The planned order is over your limit for drafts StockChief prepares on its own. Review it and prepare it yourself, or raise the limit.';
  else purchase=await purchaseWithin(c,ctx,result.id,{confirmed:'yes',sourceFingerprint:facts.sourceFingerprint},{automatic:true,knownFacts:facts});
 }
 await c.query(`UPDATE stockchief_runtime.agent_supplier_shutdowns SET last_checked_at=clock_timestamp(),next_check_at=CASE WHEN $4 THEN NULL ELSE clock_timestamp()+make_interval(days=>refresh_days) END,
  enabled=enabled AND NOT $4,revision=revision+CASE WHEN $4 THEN 1 ELSE 0 END,last_issue=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,reason,Boolean(purchase)]);
 return {...result,replayed:result.replayed&&(!purchase||purchase.replayed),...(purchase?{purchaseOrderId:purchase.purchaseOrderId}:{}),...(reason?{held:true,reason}:{})};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function configure(db,ctx,id,input){return db.transaction(async c=>{
 await source.owner(c,ctx);const p=await get(c,ctx,id,true);if(Number(input.revision)!==p.revision)throw new ValidationError('Reload the current shutdown-planning authority.');
 if(input.stop==='yes'){await c.query('UPDATE stockchief_runtime.agent_supplier_shutdowns SET enabled=false,revision=revision+1,next_check_at=NULL,last_issue=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Automatic shutdown planning stopped',reference:id});return;}
 await access(c,ctx,{automatic:true});const days=String(input.refreshDays??'');if(input.confirmed!=='yes'||!/^\d{1,2}$/.test(days)||Number(days)<1||Number(days)>30||!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Choose an explicit update interval from one to thirty days and authorize private planning only.');
 const facts=await source.facts(c,ctx,p.scope);if(input.sourceFingerprint!==facts.sourceFingerprint)throw new ValidationError('Reload the latest stock, supplier notice and purchase terms before enabling updates.');
 const overlap=(await c.query(`SELECT id FROM stockchief_runtime.agent_supplier_shutdowns WHERE workspace_id=$1 AND supplier_id=$2 AND location_id=$3 AND id<>$4 AND enabled
  AND scope->'skuIds' ?| $5::text[] AND (scope->>'closedFrom')<=$6 AND (scope->>'nextArrivalDate')>=$7 LIMIT 1`,[ctx.workspaceId,p.supplier_id,p.location_id,id,p.scope.skuIds,p.scope.nextArrivalDate,p.scope.closedFrom])).rows[0];
 if(overlap)throw new ValidationError('Another enabled shutdown plan overlaps these supplier products and dates. Stop the superseded scope before enabling this one.');
 // An empty limit keeps the plan current only. A limit lets StockChief prepare
 // the one purchase draft itself when the planned goods total is within it.
 const raw=String(input.maximumAmount??'').trim();let maximum=null;
 if(raw){
  if(!await installed.has(c,'stockchief_runtime.agent_supplier_shutdowns','maximum_minor'))throw new ValidationError('StockChief is being updated. Try again in a few minutes.');
  maximum=require('../domain/currency').toMinor(raw,facts.supplier.currency,{label:'The purchase draft limit'});if(!Number.isSafeInteger(maximum)||maximum<0)throw new ValidationError('Choose an exact limit in '+facts.supplier.currency+', zero or more.');
  if(await prepared(c,ctx,id))throw new ValidationError('This shutdown already has its purchase draft. Review that order, or cancel it before StockChief prepares another.');
 }
 await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],p.enabled?0:1);
 await c.query('UPDATE stockchief_runtime.agent_supplier_shutdowns SET enabled=true,authorized_by=$3,authorized_profile_hash=$4,refresh_days=$5,revision=revision+1,next_check_at=clock_timestamp(),last_issue=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,ctx.actorId,profile(facts),Number(days)]);
 if(await installed.has(c,'stockchief_runtime.agent_supplier_shutdowns','maximum_minor'))await c.query('UPDATE stockchief_runtime.agent_supplier_shutdowns SET maximum_minor=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,maximum]);
 await enqueue(c,ctx.workspaceId,id,p.revision+1);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:maximum==null?'Private supplier shutdown planning authorized':'Supplier shutdown planning and one purchase draft authorized',reference:id,
  after:{scope:p.scope,profileHash:profile(facts),refreshDays:Number(days),maximumMinor:maximum,currency:facts.supplier.currency,purchaseAuthority:maximum!=null,purchaseApprovalAuthority:false}});
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function purchaseWithin(c,ctx,planId,input,{automatic=false,knownFacts=null}={}){
 await access(c,ctx,{automatic});const run=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_shutdown_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,planId])).rows[0];if(!run)throw new NotFoundError('That shutdown plan is not in this inventory.');const p=await get(c,ctx,run.shutdown_id,true);
 const earlier=run.purchase_order_id?(await c.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,run.purchase_order_id])).rows[0]:null;
 if(earlier&&earlier.status!=='CANCELLED')return {purchaseOrderId:run.purchase_order_id,replayed:true};
 const facts=knownFacts||await source.facts(c,ctx,p.scope);if(input.confirmed!=='yes'||input.sourceFingerprint!==run.source_fingerprint||facts.sourceFingerprint!==run.source_fingerprint)throw new ValidationError('Review this exact plan against the current stock, incoming orders and supplier terms before preparing a purchase draft.');
 if(automatic&&(!p.enabled||p.authorized_by!==ctx.actorId||profile(facts)!==p.authorized_profile_hash||p.maximum_minor==null||facts.calculated.totalMinor>Number(p.maximum_minor)))throw new ValidationError('This purchase draft is outside the owner’s current shutdown scope or limit.');
 if(facts.warnings.length)throw new ValidationError('Resolve the plan’s source warnings before preparing another purchase.');
 const rows=facts.calculated.rows.filter(r=>r.quantityUnits>0);if(!rows.length)throw new ValidationError('Recorded stock and timely incoming orders already cover this shutdown estimate.');
 const order=await require('../operations/postgres-business-workflows').createPurchaseOrderInTransaction(c,ctx,{supplierId:p.supplier_id,destinationLocationId:p.location_id,currency:facts.supplier.currency,idempotencyKey:'shutdown-purchase:'+run.id+(earlier?':after:'+run.purchase_order_id:''),lines:rows.map(r=>{const product=facts.products.find(s=>s.sku_id===r.skuId);return {skuId:r.skuId,quantityUnits:r.quantityUnits,quantityPurchaseUnits:r.purchaseUnits,unitsPerPurchaseUnit:product.units_per_purchase_unit,purchaseUnit:product.purchase_unit,unitCost:product.last_unit_cost};})});
 await c.query('UPDATE stockchief_runtime.agent_supplier_shutdown_plans SET purchase_order_id=$3,purchase_created_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,planId,order.purchaseOrderId]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:automatic?'Shutdown purchase draft prepared within the owner’s limit':'Reviewed shutdown purchase draft prepared',reference:planId,
  after:{purchaseOrderId:order.purchaseOrderId,sourceFingerprint:facts.sourceFingerprint,automatic,totalMinor:facts.calculated.totalMinor,approved:false,sent:false}});return order;
}
async function purchase(db,ctx,planId,input){return db.transaction(c=>purchaseWithin(c,ctx,planId,input),{isolation:'SERIALIZABLE',retrySafe:true});}
// Undo: cancel the prepared draft while nobody has approved or changed it.
async function undo(db,ctx,planId){return db.transaction(async c=>{
 await source.owner(c,ctx);const run=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_shutdown_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,planId])).rows[0];
 if(!run?.purchase_order_id)throw new NotFoundError('That shutdown plan has no purchase draft.');
 const order=(await c.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,run.purchase_order_id])).rows[0];
 if(order.status==='CANCELLED')return {purchaseOrderId:run.purchase_order_id,shutdownId:run.shutdown_id,replayed:true};
 if(order.status!=='DRAFT')throw new ValidationError('This purchase order has moved on from a draft. Open it to change or cancel it.');
 await require('../operations/postgres-business-workflows').cancelPurchaseOrderInTransaction(c,ctx,run.purchase_order_id,{idempotencyKey:'shutdown-undo:'+planId,reason:'Owner undid the shutdown purchase draft'});
 await c.query('UPDATE stockchief_runtime.agent_supplier_shutdowns SET enabled=false,next_check_at=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND enabled',[ctx.workspaceId,run.shutdown_id]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Shutdown purchase draft undone',reference:planId,before:{purchaseOrderId:run.purchase_order_id,status:'DRAFT'},after:{status:'CANCELLED'}});
 return {purchaseOrderId:run.purchase_order_id,shutdownId:run.shutdown_id,replayed:false};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function page(db,ctx,id){
 await source.owner(db,ctx);const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,147,'suggest'),project=await get(db,ctx,id),rows=(await db.query('SELECT id,created_at,automatic,purchase_order_id FROM stockchief_runtime.agent_supplier_shutdown_plans WHERE workspace_id=$1 AND shutdown_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20',[ctx.workspaceId,id])).rows;
 const latest=rows[0]?(await db.query('SELECT * FROM stockchief_runtime.agent_supplier_shutdown_plans WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,rows[0].id])).rows[0]:null;let fresh=null,problem=null;try{fresh=await source.facts(db,ctx,project.scope);}catch(error){if(![400,402,403,404,422].includes(error.status))throw error;problem=error.message;}
 const draft=(await db.query(`SELECT p.id AS plan_id,EXISTS(SELECT 1 FROM security_event_history h WHERE h.workspace_id=p.workspace_id AND h.reference=p.id AND h.after_state::jsonb->>'purchaseOrderId'=o.id AND h.after_state::jsonb->>'automatic'='true') AS automatic,o.id,o.po_number,o.status FROM stockchief_runtime.agent_supplier_shutdown_plans p JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.purchase_order_id
  WHERE p.workspace_id=$1 AND p.shutdown_id=$2 ORDER BY p.purchase_created_at DESC LIMIT 1`,[ctx.workspaceId,id])).rows[0]||null;
 return {project,latest,runs:rows,fresh,problem:problem||project.last_issue,plan:state.plan,shadow:state.shadow,draft,currency:fresh?.supplier.currency||latest?.source_snapshot?.supplier?.currency||null};
}
async function list(db,ctx,{page=1}={}){
 await source.owner(db,ctx);page=Number(page);if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid shutdown-plan page.');const state=await policy.accountState(db,ctx.workspaceId),locked=!policy.usesAgentTerms(state)||!policy.permits(state.plan,147,'suggest');
 const rows=(await db.query('SELECT p.*,s.name AS supplier_name,l.name AS location_name FROM stockchief_runtime.agent_supplier_shutdowns p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id WHERE p.workspace_id=$1 ORDER BY p.created_at DESC,p.id DESC LIMIT 101 OFFSET $2',[ctx.workspaceId,(page-1)*100])).rows;
 return {locked,plan:state.plan,shadow:state.shadow,page,rows:rows.slice(0,100),more:rows.length>100};
}
async function enqueue(c,workspaceId,id,revision){return require('../operations/postgres-job-queue').enqueue({query:(...a)=>c.query(...a),transaction:fn=>fn(c)},{workspaceId,kind:jobKind,idempotencyKey:'shutdown-plan:'+id+':'+revision+':'+new Date().toISOString().slice(0,10),payload:{shutdownId:id},priority:30,maxAttempts:3});}
async function onProject(db,workspaceId,id){try{const p=(await db.query('SELECT authorized_by,enabled FROM stockchief_runtime.agent_supplier_shutdowns WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];if(!p)return {removed:true};if(!p.enabled)return {stopped:true};return await generate(db,{workspaceId,actorId:p.authorized_by},id);}catch(error){if(![400,402,403,404,422].includes(error.status))throw error;await db.query("UPDATE stockchief_runtime.agent_supplier_shutdowns SET last_checked_at=clock_timestamp(),next_check_at=clock_timestamp()+interval '15 minutes',last_issue=$3 WHERE workspace_id=$1 AND id=$2 AND enabled",[workspaceId,id,String(error.message).slice(0,500)]);return {held:true,reason:error.message};}}
async function schedule(db,workspaceId){const rows=(await db.query('SELECT id,revision FROM stockchief_runtime.agent_supplier_shutdowns WHERE workspace_id=$1 AND enabled AND (next_check_at IS NULL OR next_check_at<=now()) ORDER BY next_check_at NULLS FIRST,id LIMIT 5',[workspaceId])).rows;for(const p of rows)await enqueue(db,workspaceId,p.id,p.revision);return {queued:rows.length};}
async function inbox(db,workspaceId,actorId){
 const rows=(await db.query('SELECT p.id,p.reference,p.last_issue,p.last_checked_at,s.name FROM stockchief_runtime.agent_supplier_shutdowns p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id WHERE p.workspace_id=$1 AND p.enabled AND p.last_issue IS NOT NULL ORDER BY p.last_checked_at,p.id LIMIT 50',[workspaceId])).rows;if(!rows.length)return [];await source.owner(db,{workspaceId,actorId});const account=await policy.accountState(db,workspaceId),eligible=policy.usesAgentTerms(account)&&policy.permits(account.plan,147,'suggest');
 return rows.map(p=>({kind:'purchasing',importance:'Needs You',priority:70,title:'Review supplier shutdown: '+p.name+' · '+p.reference,happened:'The shutdown plan needs a current source or purchasing decision.',why:p.last_issue,recommendation:'Review the recorded dates, stock and supplier terms before preparing a purchase.',href:eligible?'/autopilot/supplier-shutdowns/'+p.id:'/autopilot/supplier-shutdowns',actionLabel:'Review shutdown plan',sourceId:'supplier-shutdown:'+p.id,at:p.last_checked_at,createdAt:p.last_checked_at}));
}
module.exports={preview,save,saveAll,generate,configure,purchase,undo,page,list,onProject,schedule,inbox,jobKind,action,definition:{id:147,key:'supplier-shutdowns',label:'Plan stock for supplier shutdowns',readPage:async()=>({summary:'Use checked holiday or shutdown dates for one or more suppliers to plan stock from actual warehouse issues, promises and dated incoming orders. Growth suggests. Pro and Custom keep plans current and, within your limit, prepare the purchase draft before the last order date. Approval, sending and payment stay with you.',rows:[{Action:'Open supplier shutdown planning',link:'/autopilot/supplier-shutdowns'}],more:false})}};
