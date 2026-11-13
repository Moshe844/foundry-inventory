'use strict';
const source=require('./promotion-stock-source'),policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions');
const {newId}=require('../lib/util'),{ValidationError,NotFoundError}=require('../domain/errors');
const action='purchasing.plan_promotion_stock',jobKind='purchasing.promotion-stock-plan.v1';
// Recorded promotions (Sales › Pricing) that have dates and have not ended.
async function recorded(db,ctx){
 const time=require('../lib/business-time'),{timeZone}=await time.forWorkspace(db,ctx.workspaceId);
 const rows=(await db.query(`SELECT r.id,v.definition FROM stockchief_runtime.pricing_rules r JOIN stockchief_runtime.pricing_rule_versions v ON v.workspace_id=r.workspace_id AND v.rule_id=r.id AND v.revision=r.revision
  WHERE r.workspace_id=$1 AND v.definition->>'kind'='promotion' AND coalesce(v.definition->>'enabled','true')<>'false' AND v.definition->>'startsAt' IS NOT NULL AND v.definition->>'endsAt' IS NOT NULL
  AND (v.definition->>'endsAt')::timestamptz>now() ORDER BY v.definition->>'startsAt',r.id LIMIT 50`,[ctx.workspaceId])).rows;
 return rows.map(({id,definition:d})=>({id,name:String(d.name||'Promotion').slice(0,200),startsOn:time.context(timeZone,new Date(d.startsAt)).calendarDate,endsOn:time.context(timeZone,new Date(Date.parse(d.endsAt)-1)).calendarDate,
  skuIds:[...new Set([...(d.scope?.skuIds||[]),...(d.discount?.items||[]).map(i=>i.skuId)])]}));
}
// One plan per supplier: products go to their main supplier unless you name
// one. A recorded promotion supplies its name, dates and products.
async function preview(db,ctx,input){
 await source.owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,145,'suggest');
 let filled={...input},promotion=null;
 if(input.pricingRuleId){
  promotion=(await recorded(db,ctx)).find(p=>p.id===String(input.pricingRuleId));
  if(!promotion)throw new ValidationError('Choose a recorded promotion with start and end dates that has not ended.');
  filled={...filled,reference:String(input.reference||'').trim()||promotion.name,startsOn:input.startsOn||promotion.startsOn,endsOn:input.endsOn||promotion.endsOn};
  if(!String(input.skuCodes||'').trim()){
   if(!promotion.skuIds.length)throw new ValidationError('This promotion covers whole categories or every product. Enter the SKU codes to plan, one per line.');
   filled.skuCodes=(await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[]) AND is_active=1 ORDER BY code',[ctx.workspaceId,promotion.skuIds])).rows.map(r=>r.code).join('\n');
  }
 }
 if(!filled.skuIds&&!String(filled.skuCodes||'').trim())throw new ValidationError('Enter the products on promotion, one SKU code per line, or choose a recorded promotion.');
 const {scopes,notes}=await require('./planning-stock-source').scopes(db,ctx,filled,{allowNoSupplier:true});
 const drafts=[];for(const scope of scopes)drafts.push(await source.facts(db,ctx,scope));
 return {drafts,notes,promotion};
}
async function access(c,ctx,{automatic=false}={}){
 await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);await source.owner(c,ctx);
 const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,145,automatic?'automatic':'draft'),stop=await policy.stopped(c,ctx.workspaceId,account,action,automatic);if(stop)throw new ValidationError(stop);return account;
}
async function get(c,ctx,id,lock=false){const row=(await c.query('SELECT * FROM stockchief_runtime.agent_promotion_stock WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('That promotion is not in this inventory.');return row;}
const profile=p=>hash({scope:p.scope,supplier:p.supplier,location:p.location,locationIds:p.locationIds,products:p.products});
async function write(c,ctx,project,p,{automatic=false}={}){
 const prior=(await c.query('SELECT id FROM stockchief_runtime.agent_promotion_stock_plans WHERE workspace_id=$1 AND promotion_id=$2 AND source_fingerprint=$3',[ctx.workspaceId,project.id,p.sourceFingerprint])).rows[0];if(prior)return {id:prior.id,promotionId:project.id,replayed:true};
 const id=newId('promotion-stock-plan');await c.query('INSERT INTO stockchief_runtime.agent_promotion_stock_plans(id,workspace_id,promotion_id,source_fingerprint,source_snapshot,automatic,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,ctx.workspaceId,project.id,p.sourceFingerprint,p,automatic,ctx.actorId]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Promotion stock plan prepared',reference:id,after:{promotionId:project.id,sourceFingerprint:p.sourceFingerprint,automatic,totalMinor:p.calculated.totalMinor,warnings:p.warnings.length,purchaseCreated:false}});return {id,promotionId:project.id,replayed:false};
}
// The draft prepared for this promotion and not cancelled, if any.
async function prepared(c,ctx,promotionId){
 return (await c.query(`SELECT p.purchase_order_id FROM stockchief_runtime.agent_promotion_stock_plans p JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.purchase_order_id
  WHERE p.workspace_id=$1 AND p.promotion_id=$2 AND o.status<>'CANCELLED' ORDER BY p.purchase_created_at DESC LIMIT 1`,[ctx.workspaceId,promotionId])).rows[0]?.purchase_order_id||null;
}
// Saves every reviewed supplier plan from one promotion preview.
async function saveAll(db,ctx,input){
 let plans;try{plans=JSON.parse(String(input.plans||''));}catch{plans=null;}
 if(!Array.isArray(plans)||!plans.length||plans.length>20)throw new ValidationError('Review the supplier plans again before saving.');
 const saved=[];
 for(const p of plans)saved.push(await save(db,ctx,{...input,plans:undefined,supplierId:String(p?.supplierId||''),skuIds:Array.isArray(p?.skuIds)?p.skuIds.map(String):[],sourceFingerprint:String(p?.sourceFingerprint||'')}));
 return saved;
}
async function save(db,ctx,input){return db.transaction(async c=>{
 await access(c,ctx);const p=await source.facts(c,ctx,input);if(input.confirmed!=='yes'||input.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('Review the promotion scope, actual dates, recorded stock and exact plan before saving.');
 let project=(await c.query('SELECT * FROM stockchief_runtime.agent_promotion_stock WHERE workspace_id=$1 AND supplier_id=$2 AND location_id=$3 AND reference=$4 FOR UPDATE',[ctx.workspaceId,p.supplier.id,p.location.id,p.scope.reference])).rows[0];
 if(project&&hash(project.scope)!==hash(p.scope))throw new ValidationError('This promotion reference already identifies different dates, assumptions or products. Stop the earlier scope and record the corrected promotion separately.');
 if(!project){const id=newId('promotion-stock'),inserted=await c.query('INSERT INTO stockchief_runtime.agent_promotion_stock(id,workspace_id,supplier_id,location_id,reference,scope,authorized_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,supplier_id,location_id,reference) DO NOTHING RETURNING *',[id,ctx.workspaceId,p.supplier.id,p.location.id,p.scope.reference,p.scope,ctx.actorId]);if(!inserted.rowCount){const error=Error('This promotion was recorded concurrently. Retry the exact reviewed scope.');error.code='40001';throw error;}project=inserted.rows[0];}
 return write(c,ctx,project,p);
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function generate(db,ctx,id){return db.transaction(async c=>{
 await access(c,ctx,{automatic:true});const p=await get(c,ctx,id,true);if(!p.enabled||p.authorized_by!==ctx.actorId||!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Automatic promotion planning is stopped or needs the current owner’s routine authority.');
 const facts=await source.facts(c,ctx,p.scope);if(profile(facts)!==p.authorized_profile_hash)throw new ValidationError('The supplier, receiving locations, products or purchase terms changed. Review the saved planning scope.');
 const result=await write(c,ctx,p,facts,{automatic:true});let purchase=null,reason=facts.warnings.length?facts.warnings.map(w=>(w.sku?w.sku+': ':'')+w.reason).join(' ').slice(0,500):null;
 if(!reason&&facts.calculated.rows.some(r=>r.quantityUnits>0)){
  if(facts.calculated.totalMinor>Number(p.maximum_minor))reason='The proposed goods total exceeds your authorized promotion draft limit. Review it individually or change the limit yourself.';
  else purchase=await purchaseWithin(c,ctx,result.id,{confirmed:'yes',sourceFingerprint:facts.sourceFingerprint},{automatic:true,knownFacts:facts});
 }
 await c.query('UPDATE stockchief_runtime.agent_promotion_stock SET last_checked_at=clock_timestamp(),next_check_at=CASE WHEN enabled THEN clock_timestamp()+make_interval(days=>refresh_days) ELSE NULL END,last_issue=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,reason]);return {...result,replayed:result.replayed&&(!purchase||purchase.replayed),...(purchase?{purchaseOrderId:purchase.purchaseOrderId}:{}),...(reason?{held:true,reason}:{})};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function configure(db,ctx,id,input){return db.transaction(async c=>{
 await source.owner(c,ctx);const p=await get(c,ctx,id,true);if(Number(input.revision)!==p.revision)throw new ValidationError('Reload the current promotion planning authority.');
 if(input.stop==='yes'){await c.query('UPDATE stockchief_runtime.agent_promotion_stock SET enabled=false,revision=revision+1,next_check_at=NULL,last_issue=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Automatic promotion planning stopped',reference:id});return;}
 await access(c,ctx,{automatic:true});const days=String(input.refreshDays??'');if(input.confirmed!=='yes'||!/^\d{1,2}$/.test(days)||Number(days)<1||Number(days)>30||!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Choose an explicit update interval from one to thirty days and authorize only this promotion’s planning and one unapproved purchase draft.');
 if(await prepared(c,ctx,id))throw new ValidationError('This promotion already has its one purchase draft. Review that order; a separate promotion needs a new checked reference.');
 const facts=await source.facts(c,ctx,p.scope);if(input.sourceFingerprint!==facts.sourceFingerprint)throw new ValidationError('Reload the latest stock, promotion dates and purchase terms before enabling updates.');
 const overlap=(await c.query(`SELECT id FROM stockchief_runtime.agent_promotion_stock WHERE workspace_id=$1 AND supplier_id=$2 AND location_id=$3 AND id<>$4 AND enabled
  AND scope->'skuIds' ?| $5::text[] AND (scope->>'startsOn')<=$6 AND (scope->>'endsOn')>=$7 LIMIT 1`,[ctx.workspaceId,p.supplier_id,p.location_id,id,p.scope.skuIds,p.scope.endsOn,p.scope.startsOn])).rows[0];
 if(overlap)throw new ValidationError('Another enabled promotion plan overlaps these supplier products and dates. Stop the superseded scope before enabling this one.');
 if(input.maximumAmount==null||String(input.maximumAmount).trim()==='')throw new ValidationError('Enter your explicit maximum goods value for one unapproved purchase draft.');
 const maximum=require('../domain/currency').toMinor(String(input.maximumAmount),facts.supplier.currency);if(!Number.isSafeInteger(maximum)||maximum<0)throw new ValidationError('Choose an exact nonnegative maximum goods value in the supplier currency.');
 await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],p.enabled?0:1);
 await c.query('UPDATE stockchief_runtime.agent_promotion_stock SET enabled=true,authorized_by=$3,authorized_profile_hash=$4,refresh_days=$5,maximum_minor=$6,revision=revision+1,next_check_at=clock_timestamp(),last_issue=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,ctx.actorId,profile(facts),Number(days),maximum]);await enqueue(c,ctx.workspaceId,id,p.revision+1);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Promotion planning and one purchase draft authorized',reference:id,after:{scope:p.scope,profileHash:profile(facts),refreshDays:Number(days),maximumMinor:maximum,currency:facts.supplier.currency,purchaseApprovalAuthority:false}});
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function purchaseWithin(c,ctx,planId,input,{automatic=false,knownFacts=null}={}){
 await access(c,ctx,{automatic});const found=(await c.query('SELECT promotion_id FROM stockchief_runtime.agent_promotion_stock_plans WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,planId])).rows[0];if(!found)throw new NotFoundError('That promotion plan is not in this inventory.');const p=await get(c,ctx,found.promotion_id,true),run=(await c.query('SELECT * FROM stockchief_runtime.agent_promotion_stock_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,planId])).rows[0];
 const previous=await prepared(c,ctx,p.id);if(previous)return {purchaseOrderId:previous,replayed:true};const earlier=run.purchase_order_id;
 const facts=knownFacts||await source.facts(c,ctx,p.scope);if(input.confirmed!=='yes'||input.sourceFingerprint!==run.source_fingerprint||facts.sourceFingerprint!==run.source_fingerprint)throw new ValidationError('Review this exact plan against the current stock, incoming orders and supplier terms before preparing a purchase draft.');
 if(automatic&&(!p.enabled||p.authorized_by!==ctx.actorId||profile(facts)!==p.authorized_profile_hash||p.maximum_minor==null||facts.calculated.totalMinor>Number(p.maximum_minor)))throw new ValidationError('This purchase draft is outside the owner’s current promotion scope or maximum goods value.');
 if(facts.warnings.length)throw new ValidationError('Resolve the plan’s source warnings before preparing another purchase.');
 const rows=facts.calculated.rows.filter(r=>r.quantityUnits>0);if(!rows.length)throw new ValidationError('Recorded stock and timely incoming orders already cover this promotion estimate.');
 const order=await require('../operations/postgres-business-workflows').createPurchaseOrderInTransaction(c,ctx,{supplierId:p.supplier_id,destinationLocationId:p.location_id,currency:facts.supplier.currency,idempotencyKey:'promotion-purchase:'+run.id+(earlier?':after:'+earlier:''),lines:rows.map(r=>{const product=facts.products.find(s=>s.sku_id===r.skuId);return {skuId:r.skuId,quantityUnits:r.quantityUnits,quantityPurchaseUnits:r.purchaseUnits,unitsPerPurchaseUnit:product.units_per_purchase_unit,purchaseUnit:product.purchase_unit,unitCost:product.last_unit_cost};})});
 await c.query('UPDATE stockchief_runtime.agent_promotion_stock_plans SET purchase_order_id=$3,purchase_created_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,planId,order.purchaseOrderId]);
 if(p.enabled)await c.query('UPDATE stockchief_runtime.agent_promotion_stock SET enabled=false,revision=revision+1,next_check_at=NULL,last_issue=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.id]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Promotion purchase draft prepared',reference:planId,after:{purchaseOrderId:order.purchaseOrderId,sourceFingerprint:facts.sourceFingerprint,automatic,approved:false,sent:false}});return order;
}
async function purchase(db,ctx,planId,input){return db.transaction(c=>purchaseWithin(c,ctx,planId,input),{isolation:'SERIALIZABLE',retrySafe:true});}
// Undo: cancel the prepared draft while nobody has approved or changed it.
async function undo(db,ctx,planId){return db.transaction(async c=>{
 await source.owner(c,ctx);const run=(await c.query('SELECT * FROM stockchief_runtime.agent_promotion_stock_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,planId])).rows[0];
 if(!run?.purchase_order_id)throw new NotFoundError('That promotion plan has no purchase draft.');
 const order=(await c.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,run.purchase_order_id])).rows[0];
 if(order.status==='CANCELLED')return {purchaseOrderId:run.purchase_order_id,promotionId:run.promotion_id,replayed:true};
 if(order.status!=='DRAFT')throw new ValidationError('This purchase order has moved on from a draft. Open it to change or cancel it.');
 await require('../operations/postgres-business-workflows').cancelPurchaseOrderInTransaction(c,ctx,run.purchase_order_id,{idempotencyKey:'promotion-undo:'+planId,reason:'Owner undid the promotion purchase draft'});
 await c.query('UPDATE stockchief_runtime.agent_promotion_stock SET enabled=false,next_check_at=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND enabled',[ctx.workspaceId,run.promotion_id]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Promotion purchase draft undone',reference:planId,before:{purchaseOrderId:run.purchase_order_id,status:'DRAFT'},after:{status:'CANCELLED'}});
 return {purchaseOrderId:run.purchase_order_id,promotionId:run.promotion_id,replayed:false};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function page(db,ctx,id){
 await source.owner(db,ctx);const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,145,'suggest'),project=await get(db,ctx,id),rows=(await db.query('SELECT id,created_at,automatic,purchase_order_id FROM stockchief_runtime.agent_promotion_stock_plans WHERE workspace_id=$1 AND promotion_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20',[ctx.workspaceId,id])).rows;
 const latest=rows[0]?(await db.query('SELECT * FROM stockchief_runtime.agent_promotion_stock_plans WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,rows[0].id])).rows[0]:null;let fresh=null,problem=null;try{fresh=await source.facts(db,ctx,project.scope);}catch(error){if(![400,402,403,404,422].includes(error.status))throw error;problem=error.message;}
 const draft=(await db.query(`SELECT p.id AS plan_id,EXISTS(SELECT 1 FROM security_event_history h WHERE h.workspace_id=p.workspace_id AND h.reference=p.id AND h.after_state::jsonb->>'purchaseOrderId'=o.id AND h.after_state::jsonb->>'automatic'='true') AS automatic,o.id,o.po_number,o.status FROM stockchief_runtime.agent_promotion_stock_plans p JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.purchase_order_id
  WHERE p.workspace_id=$1 AND p.promotion_id=$2 ORDER BY p.purchase_created_at DESC LIMIT 1`,[ctx.workspaceId,id])).rows[0]||null;
 return {project,latest,runs:rows,fresh,problem:problem||project.last_issue,plan:state.plan,shadow:state.shadow,draft,purchaseOrderId:draft&&draft.status!=='CANCELLED'?draft.id:null};
}
async function list(db,ctx,{page=1}={}){
 await source.owner(db,ctx);page=Number(page);if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid promotion-stock-plan page.');const state=await policy.accountState(db,ctx.workspaceId),locked=!policy.usesAgentTerms(state)||!policy.permits(state.plan,145,'suggest');
 const rows=(await db.query('SELECT p.*,s.name AS supplier_name,l.name AS location_name FROM stockchief_runtime.agent_promotion_stock p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id WHERE p.workspace_id=$1 ORDER BY p.created_at DESC,p.id DESC LIMIT 101 OFFSET $2',[ctx.workspaceId,(page-1)*100])).rows;
 return {locked,plan:state.plan,shadow:state.shadow,page,rows:rows.slice(0,100),more:rows.length>100,promotions:locked?[]:await recorded(db,ctx)};
}
async function enqueue(c,workspaceId,id,revision){return require('../operations/postgres-job-queue').enqueue({query:(...a)=>c.query(...a),transaction:fn=>fn(c)},{workspaceId,kind:jobKind,idempotencyKey:'promotion-stock-plan:'+id+':'+revision+':'+new Date().toISOString().slice(0,10),payload:{promotionId:id},priority:30,maxAttempts:3});}
async function onProject(db,workspaceId,id){try{const p=(await db.query('SELECT authorized_by,enabled FROM stockchief_runtime.agent_promotion_stock WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];if(!p)return {removed:true};if(!p.enabled)return {stopped:true};return await generate(db,{workspaceId,actorId:p.authorized_by},id);}catch(error){if(![400,402,403,404,422].includes(error.status))throw error;await db.query("UPDATE stockchief_runtime.agent_promotion_stock SET last_checked_at=clock_timestamp(),next_check_at=clock_timestamp()+interval '15 minutes',last_issue=$3 WHERE workspace_id=$1 AND id=$2 AND enabled",[workspaceId,id,String(error.message).slice(0,500)]);return {held:true,reason:error.message};}}
async function schedule(db,workspaceId){const rows=(await db.query('SELECT id,revision FROM stockchief_runtime.agent_promotion_stock WHERE workspace_id=$1 AND enabled AND (next_check_at IS NULL OR next_check_at<=now()) ORDER BY next_check_at NULLS FIRST,id LIMIT 5',[workspaceId])).rows;for(const p of rows)await enqueue(db,workspaceId,p.id,p.revision);return {queued:rows.length};}
async function inbox(db,workspaceId,actorId){
 const rows=(await db.query('SELECT p.id,p.reference,p.last_issue,p.last_checked_at,s.name FROM stockchief_runtime.agent_promotion_stock p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id WHERE p.workspace_id=$1 AND p.enabled AND p.last_issue IS NOT NULL ORDER BY p.last_checked_at,p.id LIMIT 50',[workspaceId])).rows;if(!rows.length)return [];await source.owner(db,{workspaceId,actorId});const account=await policy.accountState(db,workspaceId),eligible=policy.usesAgentTerms(account)&&policy.permits(account.plan,145,'suggest');
 return rows.map(p=>({kind:'purchasing',importance:'Needs You',priority:70,title:'Review promotion: '+p.name+' · '+p.reference,happened:'The promotion plan needs a current source or purchasing decision.',why:p.last_issue,recommendation:'Review the recorded dates, stock and supplier terms before preparing a purchase.',href:eligible?'/autopilot/promotion-stock/'+p.id:'/autopilot/promotion-stock',actionLabel:'Review promotion plan',sourceId:'promotion-stock:'+p.id,at:p.last_checked_at,createdAt:p.last_checked_at}));
}
module.exports={preview,save,saveAll,generate,configure,purchase,undo,page,recorded,list,onProject,schedule,inbox,jobKind,action,definition:{id:145,key:'promotion-stock',label:'Plan stock for a promotion',readPage:async()=>({summary:'Use a recorded promotion or your own dates, recorded warehouse issues and your explicit extra demand assumption. Products are grouped by their main supplier, one purchase draft each. Pro reviews each draft. Custom can authorize planning and one unapproved draft per supplier within a chosen goods-value limit, without training. No selling prices change and no order is approved, sent or paid.',rows:[{Action:'Open promotion stock planning',link:'/autopilot/promotion-stock'}],more:false})}};
