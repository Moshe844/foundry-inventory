'use strict';
const policy=require('../commercial/agent-plan'),source=require('./container-plan-source'),packing=require('./container-packing'),{hash}=require('../pricing/postgres-promotions'),{newId}=require('../lib/util'),{ValidationError,NotFoundError}=require('../domain/errors'),owner=require('./supplier-email-terms-source').owner;
const action='purchasing.plan_container',jobKind='purchasing.container-plan.v1';
const numbers=text=>String(text||'').split(/[\r\n,]+/).map(s=>s.trim()).filter(Boolean);
const bind=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
async function lockOwner(c,ctx){await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);await owner(c,ctx);}
async function lock(c,ctx){await lockOwner(c,ctx);return policy.requireWorkspaceJob(c,ctx.workspaceId,38,'draft');}
async function project(db,ctx,id,{lock=false}={}){const p=(await db.query('SELECT * FROM stockchief_runtime.agent_container_projects WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];if(!p)throw new NotFoundError('This container plan is not in this inventory.');return p;}
async function prepare(db,ctx,input){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,38,'draft');const facts=await source.orders(db,ctx,numbers(input.ordersText),{byNumber:true}),spec=packing.container(input),keys=facts.rows.map(row=>hash(source.identity(row)));
 const profiles=(await db.query('SELECT * FROM stockchief_runtime.agent_container_pack_profiles WHERE workspace_id=$1 AND scope_hash=ANY($2::text[])',[ctx.workspaceId,keys])).rows;
 return {input,spec,facts,rows:facts.rows.map(row=>({...row,profile:profiles.find(p=>p.scope_hash===hash(source.identity(row)))}))};
}
async function record(c,ctx,p,facts,{automatic=false}={}){
 const result=source.calculate(p.container_spec,facts,p.package_profiles),fingerprint=hash({facts:facts.snapshot,scope:p.authority_scope}),prior=(await c.query('SELECT * FROM stockchief_runtime.agent_container_runs WHERE workspace_id=$1 AND project_id=$2 AND source_fingerprint=$3',[ctx.workspaceId,p.id,fingerprint])).rows[0];
 if(prior)return {id:prior.id,replayed:true,result:prior.result};
 const id=newId('container-run');await c.query('INSERT INTO stockchief_runtime.agent_container_runs(id,workspace_id,project_id,source_fingerprint,source_snapshot,result,automatic,created_by,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $7 THEN clock_timestamp() ELSE NULL END)',[id,ctx.workspaceId,p.id,fingerprint,{...facts.snapshot,scope:p.authority_scope,container:p.container_spec,packages:p.package_profiles},result,automatic,ctx.actorId]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Container load plan calculated',reference:id,after:{projectId:p.id,sourceFingerprint:fingerprint,cartons:result.cartons,loaded:result.loaded,remaining:result.remaining,automatic}});
 return {id,replayed:false,result};
}
async function create(db,ctx,input){
 return db.transaction(async c=>{
  const account=await lock(c,ctx),stop=await policy.stopped(c,ctx.workspaceId,account,action,false);if(stop)throw new ValidationError(stop);
  if(input.confirmed!=='yes'||!/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestKey||''))throw new ValidationError('Confirm the exact orders, usable container measurements, gross carton weights and packing references.');
  const title=String(input.title||'').trim();if(!title||title.length>160)throw new ValidationError('Name this container planning group using up to 160 characters.');
  const spec=packing.container(input),facts=await source.orders(c,ctx,numbers(input.ordersText),{byNumber:true,lock:true});
  if(input.sourceFingerprint!==facts.fingerprint)throw new ValidationError('The selected orders changed. Reload their current quantities before confirming packing facts.');
  let raw=input.packages;if(input.packagesJson!==undefined){try{raw=JSON.parse(input.packagesJson);}catch{throw new ValidationError('Reload the packing form before confirming its measurements.');}}
  const inputs=Array.isArray(raw)?raw:Object.values(raw||{});if(inputs.length!==facts.rows.length||inputs.some(p=>!p||typeof p!=='object'||Array.isArray(p)))throw new ValidationError('Enter the packing facts for every selected line.');
  const profiles=facts.rows.map(row=>source.packageInput(row,inputs.find(p=>p.lineId===row.line_id)||{}));source.calculate(spec,facts,profiles);
  const scopes=new Map();for(const p of profiles){if(scopes.has(p.scopeHash)&&scopes.get(p.scopeHash)!==p.profileHash)throw new ValidationError('The same supplier, product and warehouse must use one unambiguous packing profile. Separate orders with different physical packaging.');scopes.set(p.scopeHash,p.profileHash);}
  const authority={orderIds:facts.headers.map(p=>p.id),container:spec,profiles:profiles.map(p=>({lineId:p.lineId,scopeHash:p.scopeHash,profileHash:p.profileHash})),maximumCartons:2000},requestHash=hash({title,authority,sourceFingerprint:facts.fingerprint}),prior=(await c.query('SELECT * FROM stockchief_runtime.agent_container_projects WHERE workspace_id=$1 AND request_key=$2',[ctx.workspaceId,input.requestKey])).rows[0];
  if(prior){if(prior.request_hash!==requestHash)throw new ValidationError('This request was already used for different packing facts. Reload before creating another plan.');return {id:prior.id,replayed:true};}
  const distinctProfiles=[...new Map(profiles.map(p=>[p.scopeHash,p])).values()];
  await c.query(`INSERT INTO stockchief_runtime.agent_container_pack_profiles(workspace_id,scope_hash,supplier_id,sku_id,identity,pack,source_reference,profile_hash,verified_by)
   SELECT $1,p."scopeHash",p.identity->>'supplierId',p.identity->>'skuId',p.identity,p.pack,p."sourceReference",p."profileHash",$3
   FROM jsonb_to_recordset($2::jsonb)p("scopeHash" text,identity jsonb,pack jsonb,"sourceReference" text,"profileHash" text) ORDER BY p."scopeHash"
   ON CONFLICT(workspace_id,scope_hash) DO UPDATE SET identity=EXCLUDED.identity,pack=EXCLUDED.pack,source_reference=EXCLUDED.source_reference,profile_hash=EXCLUDED.profile_hash,verified_by=EXCLUDED.verified_by,revision=agent_container_pack_profiles.revision+1,verified_at=clock_timestamp() WHERE agent_container_pack_profiles.profile_hash<>EXCLUDED.profile_hash`,[ctx.workspaceId,JSON.stringify(distinctProfiles),ctx.actorId]);
  const id=newId('container-plan');await c.query('INSERT INTO stockchief_runtime.agent_container_projects(id,workspace_id,title,order_ids,container_spec,package_profiles,authority_scope,authorized_by,request_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,ctx.workspaceId,title,JSON.stringify(authority.orderIds),spec,JSON.stringify(profiles),authority,ctx.actorId,input.requestKey,requestHash]);
  const p=await project(c,ctx,id),run=await record(c,ctx,p,facts);return {id,runId:run.id,replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function current(c,ctx,p){
 if(hash(p.container_spec)!==hash(p.authority_scope.container)||hash(p.order_ids)!==hash(p.authority_scope.orderIds)||hash(p.package_profiles.map(profile=>({lineId:profile.lineId,scopeHash:profile.scopeHash,profileHash:profile.profileHash})))!==hash(p.authority_scope.profiles))throw new ValidationError('The saved container scope changed. Review a new planning group before continuing.');
 const facts=await source.orders(c,ctx,p.order_ids,{lock:true});source.loadLines(facts,p.package_profiles);
 const profiles=(await c.query('SELECT scope_hash,profile_hash FROM stockchief_runtime.agent_container_pack_profiles WHERE workspace_id=$1 AND scope_hash=ANY($2::text[]) FOR SHARE',[ctx.workspaceId,p.package_profiles.map(x=>x.scopeHash)])).rows;
 if(p.package_profiles.some(profile=>!profiles.some(saved=>saved.scope_hash===profile.scopeHash&&saved.profile_hash===profile.profileHash)))throw new ValidationError('The confirmed packing measurements changed. Create a freshly reviewed planning group instead of reusing earlier measurements.');
 return facts;
}
async function review(db,ctx,id,input){
 return db.transaction(async c=>{
  const account=await lock(c,ctx),stop=await policy.stopped(c,ctx.workspaceId,account,action,false);if(stop)throw new ValidationError(stop);
  const run=(await c.query('SELECT * FROM stockchief_runtime.agent_container_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];if(!run)throw new NotFoundError('This calculated load is not in this inventory.');
  const p=await project(c,ctx,run.project_id,{lock:true}),facts=await current(c,ctx,p),fingerprint=hash({facts:facts.snapshot,scope:p.authority_scope});
  if(input.confirmed!=='yes'||input.sourceFingerprint!==run.source_fingerprint||fingerprint!==run.source_fingerprint)throw new ValidationError('Review the current calculated quantities and every leftover before approving this plan.');
  if(run.reviewed_at&&run.reviewed_by===ctx.actorId)return {projectId:p.id,replayed:true};await c.query('UPDATE stockchief_runtime.agent_container_runs SET reviewed_by=$3,reviewed_at=clock_timestamp(),completed_at=coalesce(completed_at,clock_timestamp()) WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,ctx.actorId]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Container plan individually reviewed',reference:id,before:{reviewedBy:run.reviewed_by,reviewedAt:run.reviewed_at},after:{sourceFingerprint:fingerprint,loaded:run.result.loaded,remaining:run.result.remaining}});return {projectId:p.id,replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function rebuild(db,ctx,id,{automatic=false}={}){
 return db.transaction(async c=>{
  const account=await lock(c,ctx),p=await project(c,ctx,id,{lock:true}),stop=await policy.stopped(c,ctx.workspaceId,account,action,automatic);if(stop)throw new ValidationError(stop);
  const rule=(await c.query('SELECT r.*,u.role FROM stockchief_runtime.agent_container_rules r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by WHERE r.workspace_id=$1 AND r.project_id=$2',[ctx.workspaceId,id])).rows[0],trained=Boolean(rule&&rule.authorized_by===ctx.actorId&&rule.role==='owner'&&hash(rule.authority_scope)===hash(p.authority_scope));
  if(automatic){if(!p.enabled||p.authorized_by!==ctx.actorId||!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Routine container planning is stopped or needs the current owner’s authority.');policy.requireJob(account.plan,38,'automatic',{trained});}
  const facts=await current(c,ctx,p),result=await record(c,ctx,p,facts,{automatic});await c.query('UPDATE stockchief_runtime.agent_container_projects SET last_checked_at=clock_timestamp(),last_issue=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);return result;
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function teach(db,ctx,id,input){
 return db.transaction(async c=>{
  await lockOwner(c,ctx);const p=await project(c,ctx,id,{lock:true}),prior=(await c.query('SELECT * FROM stockchief_runtime.agent_container_rules WHERE workspace_id=$1 AND project_id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
  if(input.remove==='yes'){if(!prior||input.confirmed!=='yes'||prior.revision!==Number(input.ruleRevision))throw new ValidationError('Confirm removing this current taught container scope.');await c.query('DELETE FROM stockchief_runtime.agent_container_rules WHERE workspace_id=$1 AND project_id=$2',[ctx.workspaceId,id]);await c.query("UPDATE stockchief_runtime.agent_container_projects SET enabled=false,revision=revision+1,last_issue='The owner removed the taught scope and stopped routine planning.' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Taught container planning scope removed',reference:id});return;}
  const account=await lock(c,ctx),stop=await policy.stopped(c,ctx.workspaceId,account,action,false);if(stop)throw new ValidationError(stop);
  const run=(await c.query('SELECT * FROM stockchief_runtime.agent_container_runs WHERE workspace_id=$1 AND project_id=$2 AND id=$3',[ctx.workspaceId,id,input.runId])).rows[0],facts=await current(c,ctx,p),fingerprint=hash({facts:facts.snapshot,scope:p.authority_scope});
  if(input.confirmed!=='yes'||(prior?.revision||0)!==Number(input.ruleRevision||0)||!run||run.reviewed_by!==ctx.actorId||!run.reviewed_at||run.source_fingerprint!==fingerprint)throw new ValidationError('Individually review this exact current load before teaching the selected orders, measurements and container limits.');
  await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?0:1);
  await c.query(`INSERT INTO stockchief_runtime.agent_container_rules(project_id,workspace_id,authority_scope,authorized_by,example_run_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id) DO UPDATE SET authority_scope=EXCLUDED.authority_scope,authorized_by=EXCLUDED.authorized_by,example_run_id=EXCLUDED.example_run_id,revision=agent_container_rules.revision+1`,[id,ctx.workspaceId,p.authority_scope,ctx.actorId,run.id]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Reviewed container planning scope taught',reference:id,after:{exampleRunId:run.id,scope:p.authority_scope}});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function configure(db,ctx,id,input){
 return db.transaction(async c=>{
  await lockOwner(c,ctx);const p=await project(c,ctx,id,{lock:true});if(p.revision!==Number(input.revision))throw new ValidationError('Reload the current container planning settings.');
  if(input.stop==='yes'){await c.query('UPDATE stockchief_runtime.agent_container_projects SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Routine container planning stopped',reference:id});return;}
  const account=await lock(c,ctx),stop=await policy.stopped(c,ctx.workspaceId,account,action,true);if(stop)throw new ValidationError(stop);
  const rule=(await c.query('SELECT * FROM stockchief_runtime.agent_container_rules WHERE workspace_id=$1 AND project_id=$2',[ctx.workspaceId,id])).rows[0];policy.requireJob(account.plan,38,'automatic',{trained:Boolean(rule&&rule.authorized_by===ctx.actorId&&hash(rule.authority_scope)===hash(p.authority_scope))});
  if(input.confirmed!=='yes'||!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Explicitly authorize routine recalculation for only these selected orders and confirmed packing limits.');
  const facts=await current(c,ctx,p);if(input.sourceFingerprint!==hash({facts:facts.snapshot,scope:p.authority_scope}))throw new ValidationError('Reload the current order quantities before enabling routine recalculation.');
  await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],p.enabled?0:1);
  await c.query('UPDATE stockchief_runtime.agent_container_projects SET enabled=true,authorized_by=$3,revision=revision+1,last_checked_at=NULL,last_issue=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,ctx.actorId]);await enqueue(c,ctx.workspaceId,id,p.revision+1);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Routine container planning authorized',reference:id,after:{scope:p.authority_scope}});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function enqueue(c,workspaceId,id,revision){
 const hour=new Date().toISOString().slice(0,13);return require('../operations/postgres-job-queue').enqueue(typeof c.transaction==='function'?c:bind(c),{workspaceId,kind:jobKind,idempotencyKey:'container-plan:'+id+':'+revision+':'+hour,payload:{projectId:id},priority:35,maxAttempts:3});
}
async function onProject(db,workspaceId,id){
 try{const p=(await db.query('SELECT authorized_by FROM stockchief_runtime.agent_container_projects WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];if(!p)return {removed:true};return await rebuild(db,{workspaceId,actorId:p.authorized_by},id,{automatic:true});}
 catch(error){if(![400,402,403,404,422].includes(error.status))throw error;await db.query('UPDATE stockchief_runtime.agent_container_projects SET last_checked_at=clock_timestamp(),last_issue=$3 WHERE workspace_id=$1 AND id=$2',[workspaceId,id,String(error.message).slice(0,500)]);return {held:true,reason:error.message};}
}
async function schedule(db,workspaceId){const rows=(await db.query("SELECT id,revision FROM stockchief_runtime.agent_container_projects WHERE workspace_id=$1 AND enabled AND (last_checked_at IS NULL OR last_checked_at<now()-interval '1 hour') ORDER BY last_checked_at NULLS FIRST,id LIMIT 5",[workspaceId])).rows;for(const p of rows)await enqueue(db,workspaceId,p.id,p.revision);return {queued:rows.length};}
async function list(db,ctx,{page=1}={}){
 await owner(db,ctx);page=Number(page);if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid planning page.');
 const state=await policy.accountState(db,ctx.workspaceId),locked=!policy.usesAgentTerms(state)||!policy.permits(state.plan,38,'draft'),rows=(await db.query('SELECT p.id,p.title,p.enabled,p.revision,p.last_checked_at,p.last_issue,r.revision AS rule_revision FROM stockchief_runtime.agent_container_projects p LEFT JOIN stockchief_runtime.agent_container_rules r ON r.workspace_id=p.workspace_id AND r.project_id=p.id WHERE p.workspace_id=$1 ORDER BY p.created_at DESC,p.id LIMIT 101 OFFSET $2',[ctx.workspaceId,(page-1)*100])).rows;
 return {locked,plan:state.plan,shadow:state.shadow,rows:rows.slice(0,100),more:rows.length>100,page};
}
async function page(db,ctx,id){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,38,'draft');const p=await project(db,ctx,id),runs=(await db.query("SELECT id,source_fingerprint,created_at,jsonb_build_object('loaded',result->'loaded','remaining',result->'remaining') AS result FROM stockchief_runtime.agent_container_runs WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20",[ctx.workspaceId,id])).rows,rule=(await db.query('SELECT * FROM stockchief_runtime.agent_container_rules WHERE workspace_id=$1 AND project_id=$2',[ctx.workspaceId,id])).rows[0],state=await policy.accountState(db,ctx.workspaceId);
 let facts=null,problem=null;try{facts=await current(db,ctx,p);}catch(error){if(![400,402,403,404,422].includes(error.status))throw error;problem=error.message;}
 const fingerprint=facts?hash({facts:facts.snapshot,scope:p.authority_scope}):null,matching=fingerprint?(await db.query('SELECT * FROM stockchief_runtime.agent_container_runs WHERE workspace_id=$1 AND project_id=$2 AND source_fingerprint=$3',[ctx.workspaceId,id,fingerprint])).rows[0]:null;
 const latest=matching||(runs[0]?(await db.query('SELECT * FROM stockchief_runtime.agent_container_runs WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,runs[0].id])).rows[0]:null);
 return {project:p,runs,latest,rule,plan:state.plan,shadow:state.shadow,facts,problem,currentFingerprint:fingerprint,current:Boolean(matching)};
}
async function inbox(db,workspaceId,actorId){
 const ordering=await require('./agent-container-orders').inbox(db,workspaceId);
 const rows=(await db.query('SELECT id,title,last_issue,last_checked_at FROM stockchief_runtime.agent_container_projects WHERE workspace_id=$1 AND enabled AND last_issue IS NOT NULL ORDER BY last_checked_at,id LIMIT 50',[workspaceId])).rows;if(!rows.length)return ordering;
 await owner(db,{workspaceId,actorId});const state=await policy.accountState(db,workspaceId),eligible=policy.usesAgentTerms(state)&&policy.permits(state.plan,38,'draft');
 return ordering.concat(rows.map(row=>({kind:'purchase',importance:'Needs You',priority:72,title:'Review container planning: '+row.title,happened:'Routine recalculation stopped for review.',why:row.last_issue,recommendation:eligible?'Review the current orders and confirmed packing measurements.':'This plan does not include container planning. Stop the saved routine or review an upgrade.',href:eligible?'/autopilot/container-plans/'+row.id:'/autopilot/container-plans',actionLabel:eligible?'Review planning group':'Manage stopped planning',sourceId:'container-plan:'+row.id,at:row.last_checked_at,createdAt:row.last_checked_at})));
}
async function manifest(db,ctx,id){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,38,'draft');const run=(await db.query('SELECT * FROM stockchief_runtime.agent_container_runs WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];if(!run)throw new NotFoundError('This calculated load is not in this inventory.');
 const cell=v=>{let s=String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';},rows=[['Disposition','Container','PO','PO line','SKU','Cartons','Carton number','X mm','Y mm','Z mm','Outer length mm','Outer width mm','Outer height mm','Gross grams per carton','Supported grams above','Grams loaded above']];
 for(const carton of run.result.placed){const line=run.source_snapshot.lines.find(l=>l.lineId===carton.lineId);rows.push(['Loaded',carton.container,line?.orderNumber,line?.lineNumber,line?.identity.code,1,carton.carton,carton.x,carton.y,carton.z,carton.length,carton.width,carton.height,carton.weightGrams,carton.maximumAboveGrams,carton.aboveGrams]);}
 for(const remainder of run.result.rows.filter(r=>r.remaining)){const line=run.source_snapshot.lines.find(l=>l.lineId===remainder.lineId);rows.push(['Not loaded','',line?.orderNumber,line?.lineNumber,line?.identity.code,remainder.remaining,'','','','','','','','','','']);}
 return {csv:rows.map(row=>row.map(cell).join(',')).join('\r\n'),run};
}
module.exports={prepare,create,review,rebuild,teach,configure,enqueue,onProject,schedule,list,page,manifest,inbox,jobKind,action,definition:{id:38,key:'container-plans',label:'Fill import containers from reorder needs',readPage:async()=>({summary:'Plan an import order that fills a 20 ft or 40 ft container by space and weight: the most-needed products first, then the next most-needed, inside supplier minimums and packs. Pro drafts the order until you teach it; Custom orders on its own within your limits. You can also check a carton-by-carton layout for orders you already have.',rows:[{Action:'Fill a container from reorder needs',link:'/autopilot/container-orders'},{Action:'Check the carton layout of existing orders',link:'/autopilot/container-plans'}],more:false})}};
