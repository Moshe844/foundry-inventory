'use strict';
const source=require('./po-delivery-date-source'),policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions'),{newId,nowIso}=require('../lib/util'),{ValidationError}=require('../domain/errors');
const action='purchase_order.update_delivery_date',jobKind='purchase-order.delivery-date.v1';
async function lock(c,ctx){await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);await source.owner(c,ctx);return policy.requireWorkspaceJob(c,ctx.workspaceId,31,'draft');}
async function saved(db,workspaceId,id){return (await db.query('SELECT * FROM stockchief_runtime.agent_po_date_sources WHERE workspace_id=$1 AND source_id=$2',[workspaceId,id])).rows[0]||null;}
async function preview(db,ctx,id){
 const p=await source.facts(db,ctx,id),receipt=await saved(db,ctx.workspaceId,id),head=(await db.query('SELECT *,expected_date::text,original_expected_date::text,received_at>=$3::timestamptz AS source_is_older FROM stockchief_runtime.agent_po_date_heads WHERE workspace_id=$1 AND purchase_order_id=$2',[ctx.workspaceId,p.orderId,p.receivedAt])).rows[0];
 p.originalDate=head?.original_expected_date||(/^\d{4}-\d{2}-\d{2}$/.test(p.currentDate||'')?p.currentDate:null);p.sourceFingerprint=hash(p);
 if(receipt?.processed_at&&receipt.instruction_hash!==p.instructionHash)throw new ValidationError('The original supplier response changed after it was processed. Review its original history.');
 const priorAutomatic=head?.automatic&&source.instant(head.record_updated_at)===source.instant(p.updatedAt)&&head.expected_date===p.currentDate&&head.order_profile_hash===p.orderProfileHash;
 const changedSinceSource=p.capturedProfileHash&&(p.capturedDate!==p.currentDate||p.capturedProfileHash!==p.currentProfileHash);
 return {facts:p,receipt,older:receipt?.processed_at?false:(source.instant(p.updatedAt)>source.instant(p.receivedAt)||changedSinceSource)&&!priorAutomatic||Boolean(head?.source_is_older),today:await require('../lib/business-time').today(db,ctx.workspaceId)};
}
async function automatic(c,ctx,account,p,today){
 if(!p.capturedProfileHash)throw new ValidationError('This historical supplier response needs individual review against the current order.');
 const settings=(await c.query('SELECT *,authorized_at<=$3::timestamptz AS source_after_authority FROM stockchief_runtime.agent_po_date_settings WHERE workspace_id=$1 AND supplier_id=$2 AND enabled FOR SHARE',[ctx.workspaceId,p.supplierId,p.receivedAt])).rows;
 const relevant=settings.filter(setting=>setting.scope.destinationLocationId===p.destinationLocationId&&setting.scope.currency===p.currency&&setting.scope.products.some(product=>p.scope.products.some(current=>current.skuId===product.skuId)));
 if(relevant.length!==1||relevant[0].authorized_by!==ctx.actorId||!relevant[0].source_after_authority||!source.covers(relevant[0].scope,p.scope))throw new ValidationError('This supplier date needs one current owner-authorized product, warehouse and date-limit scope. Review overlapping settings, a new authorization or changed facts.');
 const breaches=source.violations(p,relevant[0].limits,today);if(breaches.length)throw new ValidationError(breaches.join(' '));
 if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Automatic delivery-date updates are paused.');
 const rules=(await c.query('SELECT r.*,u.role FROM stockchief_runtime.agent_po_date_rules r LEFT JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by WHERE r.workspace_id=$1 AND r.supplier_id=$2',[ctx.workspaceId,p.supplierId])).rows;
 const related=rules.filter(rule=>rule.scope.destinationLocationId===p.destinationLocationId&&rule.scope.products.some(product=>p.scope.products.some(current=>current.skuId===product.skuId)));
 for(const rule of related){if(rule.authorized_by!==ctx.actorId||rule.role!=='owner'||!source.covers(rule.scope,{...p.scope,products:p.scope.products.filter(product=>rule.scope.products.some(learned=>learned.skuId===product.skuId))}))throw new ValidationError('The supplier, warehouse, products or purchase units changed from a taught date scope. Review them individually.');const lowerBreaches=source.violations(p,rule.limits,today);if(lowerBreaches.length)throw new ValidationError('A lower taught limit applies. '+lowerBreaches.join(' '));}
 const trained=p.scope.products.every(product=>related.some(rule=>source.covers(rule.scope,{...p.scope,products:[product]})));
 policy.requireJob(account.plan,31,'automatic',{trained});return relevant[0];
}
async function apply(db,ctx,id,input={}, {automated=false}={}){
 return db.transaction(async c=>{
  const account=await lock(c,ctx),stop=await policy.stopped(c,ctx.workspaceId,account,action,automated);if(stop)throw new ValidationError(stop);
  const found=(await c.query('SELECT l.purchase_order_id FROM stockchief_runtime.supplier_link_submissions r JOIN stockchief_runtime.supplier_order_links l ON l.token_hash=r.token_hash AND l.workspace_id=r.workspace_id WHERE r.workspace_id=$1 AND r.id=$2',[ctx.workspaceId,id])).rows[0];
  if(!found)throw new ValidationError('Choose a supplier response from this inventory.');
  await c.query('SELECT id FROM purchase_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,found.purchase_order_id]);
  const prepared=await preview(c,ctx,id),p=prepared.facts;if(prepared.receipt?.processed_at)return {replayed:true,changed:prepared.receipt.changed,automatic:prepared.receipt.automatic};
  if(automated){await automatic(c,ctx,account,p,prepared.today);if(prepared.older)throw new ValidationError('A newer supplier response or owner edit exists. Review both dates before replacing the order’s promise.');}
  else if(input.confirmed!=='yes'||input.expectedFingerprint!==p.sourceFingerprint||prepared.older&&input.overrideNewer!=='yes'||p.proposedDate<prepared.today&&input.pastDateConfirmed!=='yes')throw new ValidationError('Approve this exact supplier date and current order. Confirm separately before replacing newer work or recording a date already in the past.');
  const closed=['RECEIVED','CANCELLED'].includes(p.status);if(!closed&&!['ORDERED','PARTIALLY_RECEIVED'].includes(p.status))throw new ValidationError('Place the approved purchase order first. The supplier’s response is retained for review afterwards.');
  const changed=!closed&&p.currentDate!==p.proposedDate,at=nowIso();
  if(changed){
   await c.query('UPDATE purchase_orders SET expected_date=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.orderId,p.proposedDate,at]);
   await c.query(`INSERT INTO purchase_order_events(id,workspace_id,purchase_order_id,event,detail,actor_user_id,created_at) VALUES($1,$2,$3,'supplier_delivery_date_updated',$4,$5,$6)`,[newId('poevt'),ctx.workspaceId,p.orderId,JSON.stringify({sourceId:id,previousDate:p.currentDate,expectedDate:p.proposedDate,automatic:automated}),ctx.actorId,at]);
  }
  if(!closed)await c.query(`INSERT INTO stockchief_runtime.agent_po_date_heads(workspace_id,purchase_order_id,source_id,received_at,record_updated_at,expected_date,original_expected_date,order_profile_hash,automatic) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
   ON CONFLICT(workspace_id,purchase_order_id) DO UPDATE SET source_id=EXCLUDED.source_id,received_at=EXCLUDED.received_at,record_updated_at=EXCLUDED.record_updated_at,expected_date=EXCLUDED.expected_date,order_profile_hash=EXCLUDED.order_profile_hash,automatic=EXCLUDED.automatic`,[ctx.workspaceId,p.orderId,id,p.receivedAt,changed?at:p.updatedAt,p.proposedDate,p.originalDate||p.proposedDate,p.orderProfileHash,automated]);
  await c.query(`INSERT INTO stockchief_runtime.agent_po_date_sources(source_id,workspace_id,purchase_order_id,source_snapshot,instruction_hash,changed,automatic,processed_by,processed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
   ON CONFLICT(source_id) DO UPDATE SET purchase_order_id=EXCLUDED.purchase_order_id,source_snapshot=EXCLUDED.source_snapshot,instruction_hash=EXCLUDED.instruction_hash,changed=EXCLUDED.changed,automatic=EXCLUDED.automatic,processed_by=EXCLUDED.processed_by,processed_at=EXCLUDED.processed_at,problem=NULL,retry_after=NULL`,[id,ctx.workspaceId,p.orderId,JSON.stringify(p),p.instructionHash,changed,automated,ctx.actorId,at]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:closed?'Supplier delivery date retained for a closed order':'Supplier delivery promise reviewed',reference:p.orderId,before:{expectedDate:p.currentDate},after:{expectedDate:closed?p.currentDate:p.proposedDate,sourceId:id,changed,automatic:automated}});
  return {replayed:false,changed,automatic:automated,closed};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function configure(db,ctx,id,input){
 return db.transaction(async c=>{
  await source.owner(c,ctx);const existing=input.settingId?(await c.query('SELECT * FROM stockchief_runtime.agent_po_date_settings WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,input.settingId])).rows[0]:null;
  if(input.stop==='yes'){if(!existing||existing.revision!==Number(input.revision))throw new ValidationError('Reload the current delivery-date setting before stopping it.');await c.query('UPDATE stockchief_runtime.agent_po_date_settings SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,existing.id]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Routine PO delivery-date updates stopped',reference:existing.id});return;}
  const account=await lock(c,ctx);if(account.shadow||input.confirmed!=='yes')throw new ValidationError('After the 14-day watch period, confirm this supplier, warehouse, product scope and every date limit explicitly.');
  const p=await source.facts(c,ctx,id),limits=source.caps(input),key=hash(p.scope),prior=(await c.query('SELECT * FROM stockchief_runtime.agent_po_date_settings WHERE workspace_id=$1 AND scope_hash=$2 FOR UPDATE',[ctx.workspaceId,key])).rows[0];
  if((prior?.revision||0)!==Number(input.revision||0))throw new ValidationError('Reload the current delivery-date settings before saving.');
  await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
  const settingId=prior?.id||newId('po-date-setting');await c.query(`INSERT INTO stockchief_runtime.agent_po_date_settings(id,workspace_id,supplier_id,scope,scope_hash,limits,authorized_by) VALUES($1,$2,$3,$4,$5,$6,$7)
   ON CONFLICT(workspace_id,scope_hash) DO UPDATE SET scope=EXCLUDED.scope,limits=EXCLUDED.limits,authorized_by=EXCLUDED.authorized_by,authorized_at=clock_timestamp(),enabled=true,revision=agent_po_date_settings.revision+1`,[settingId,ctx.workspaceId,p.supplierId,JSON.stringify(p.scope),key,JSON.stringify(limits),ctx.actorId]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Routine PO delivery-date scope authorized',reference:settingId,after:{scope:p.scope,limits}});return {id:settingId};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function teach(db,ctx,id,input){
 return db.transaction(async c=>{
  await source.owner(c,ctx);if(input.remove==='yes'){
   const prior=(await c.query('SELECT * FROM stockchief_runtime.agent_po_date_rules WHERE workspace_id=$1 AND scope_hash=$2 FOR UPDATE',[ctx.workspaceId,input.scopeHash||''])).rows[0];
   if(!prior||prior.revision!==Number(input.revision)||input.confirmed!=='yes')throw new ValidationError('Confirm removing this current taught delivery-date limit.');await c.query('DELETE FROM stockchief_runtime.agent_po_date_rules WHERE workspace_id=$1 AND scope_hash=$2',[ctx.workspaceId,prior.scope_hash]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Taught PO delivery-date limit removed',reference:prior.scope_hash});return;
  }
  const account=await lock(c,ctx);if(account.shadow||input.confirmed!=='yes')throw new ValidationError('After the watch period, confirm teaching this individually reviewed supplier date scope.');
  const reviewed=await preview(c,ctx,id),p=reviewed.facts,receipt=reviewed.receipt;if(!receipt?.processed_at||receipt.automatic||receipt.processed_by!==ctx.actorId)throw new ValidationError('Individually approve this exact supplier date first before teaching its scope.');
  if(hash(receipt.source_snapshot.scope)!==hash(p.scope))throw new ValidationError('The products or their purchase units changed since this individual approval. Review a fresh supplier response before teaching the new scope.');
  const limits=source.caps(input),key=hash(p.scope),prior=(await c.query('SELECT * FROM stockchief_runtime.agent_po_date_rules WHERE workspace_id=$1 AND scope_hash=$2 FOR UPDATE',[ctx.workspaceId,key])).rows[0];
  if((prior?.revision||0)!==Number(input.revision||0))throw new ValidationError('Reload this taught supplier date rule.');await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?0:1);
  await c.query(`INSERT INTO stockchief_runtime.agent_po_date_rules(workspace_id,supplier_id,scope_hash,scope,limits,authorized_by,example_source_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,scope_hash) DO UPDATE SET scope=EXCLUDED.scope,limits=EXCLUDED.limits,authorized_by=EXCLUDED.authorized_by,example_source_id=EXCLUDED.example_source_id,revision=agent_po_date_rules.revision+1`,[ctx.workspaceId,p.supplierId,key,JSON.stringify(p.scope),JSON.stringify(limits),ctx.actorId,id]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Reviewed PO delivery-date scope taught',reference:key,after:{scope:p.scope,limits}});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function onArrival(db,workspaceId,id){
 const archived=await archive(db,workspaceId,id);if(archived)return {archived:true,changed:false};
 try{const owners=(await db.query("SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE u.workspace_id=$1 AND u.role='owner' ORDER BY u.id LIMIT 2",[workspaceId])).rows;if(owners.length!==1)throw new ValidationError('This supplier date needs one current inventory owner.');return await apply(db,{workspaceId,actorId:owners[0].id},id,{}, {automated:true});}
 catch(error){if(![400,402,403,404,422].includes(error.status))throw error;await db.query(`INSERT INTO stockchief_runtime.agent_po_date_sources(source_id,workspace_id,problem,retry_after) SELECT $1,$2,$3,now()+interval '15 minutes' FROM stockchief_runtime.supplier_link_submissions r WHERE r.workspace_id=$2 AND r.id=$1 ON CONFLICT(source_id) DO UPDATE SET problem=EXCLUDED.problem,retry_after=EXCLUDED.retry_after WHERE agent_po_date_sources.processed_at IS NULL`,[id,workspaceId,String(error.message).slice(0,500)]);return {held:true,reason:error.message};}
}
async function archive(db,workspaceId,id=null){
 const result=await db.query(`UPDATE stockchief_runtime.agent_po_date_sources s SET archived_at=now(),problem='This order closed or a newer supplier response was already reviewed. The original source is retained.' WHERE s.workspace_id=$1 AND s.processed_at IS NULL AND s.source_id IN (
  SELECT v.source_id FROM stockchief_runtime.agent_po_date_sources v JOIN stockchief_runtime.supplier_link_submissions r ON r.workspace_id=v.workspace_id AND r.id=v.source_id JOIN stockchief_runtime.supplier_order_links l ON l.workspace_id=r.workspace_id AND l.token_hash=r.token_hash JOIN purchase_orders po ON po.workspace_id=l.workspace_id AND po.id=l.purchase_order_id
  LEFT JOIN stockchief_runtime.agent_po_date_heads h ON h.workspace_id=po.workspace_id AND h.purchase_order_id=po.id
  WHERE v.workspace_id=$1 AND v.processed_at IS NULL AND v.archived_at IS NULL AND ($2::text IS NULL OR v.source_id=$2) AND (po.status IN ('RECEIVED','CANCELLED') OR h.received_at>=r.created_at) ORDER BY v.source_id LIMIT 100 FOR UPDATE OF v SKIP LOCKED)`,[workspaceId,id]);
 if(result.rowCount)return result.rowCount;if(id)return (await db.query('SELECT 1 FROM stockchief_runtime.agent_po_date_sources WHERE workspace_id=$1 AND source_id=$2 AND archived_at IS NOT NULL AND processed_at IS NULL',[workspaceId,id])).rowCount;return 0;
}
async function enqueue(c,workspaceId,id){await source.capture(c,workspaceId,id);const db=typeof c.transaction==='function'?c:{query:(sql,args)=>c.query(sql,args),transaction:operation=>operation(c)};return require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:jobKind,idempotencyKey:'supplier-po-date:'+id,payload:{sourceId:id},priority:55,maxAttempts:3});}
async function run(db,workspaceId){
 const archived=await archive(db,workspaceId),rows=(await db.query(`SELECT s.source_id AS id FROM stockchief_runtime.agent_po_date_sources s JOIN stockchief_runtime.supplier_link_submissions r ON r.workspace_id=s.workspace_id AND r.id=s.source_id WHERE s.workspace_id=$1 AND s.processed_at IS NULL AND s.archived_at IS NULL AND s.captured_order_profile_hash IS NOT NULL AND (s.retry_after IS NULL OR s.retry_after<=now()) ORDER BY s.retry_after NULLS FIRST,s.source_id LIMIT 5`,[workspaceId])).rows;
 let changed=0,held=0;for(const row of rows){const result=await onArrival(db,workspaceId,row.id);if(result.changed&&!result.replayed)changed++;if(result.held)held++;}return {changed,held,archived};
}
async function page(db,ctx,id){
 await source.owner(db,ctx);const account=await policy.accountState(db,ctx.workspaceId),locked=!policy.usesAgentTerms(account)||!policy.permits(account.plan,31,'draft');let prepared=null,problem=null;
 const receipt=await saved(db,ctx.workspaceId,id);if(!locked){try{prepared=await preview(db,ctx,id);}catch(error){if(![400,402,403,404,422].includes(error.status))throw error;problem=error.message;}}
 const p=prepared?.facts||receipt?.source_snapshot,settings=(await db.query('SELECT * FROM stockchief_runtime.agent_po_date_settings WHERE workspace_id=$1 ORDER BY id LIMIT 101',[ctx.workspaceId])).rows;
 const rule=p?(await db.query('SELECT * FROM stockchief_runtime.agent_po_date_rules WHERE workspace_id=$1 AND scope_hash=$2',[ctx.workspaceId,hash(p.scope)])).rows[0]:null;
 return {locked,plan:account.plan,shadow:account.shadow,prepared,receipt,problem:problem||receipt?.problem,p,settings:settings.slice(0,100),moreSettings:settings.length>100,setting:p?settings.find(setting=>setting.scope_hash===hash(p.scope)):null,rule,canTeach:Boolean(receipt?.processed_at&&!receipt.automatic&&receipt.processed_by===ctx.actorId)};
}
async function readPage(db,ctx,{filter='',page=1}={}){
 const rows=(await db.query(`SELECT r.id,r.expected_date::text,r.created_at,po.po_number,s.name,v.processed_at,v.changed,v.problem FROM stockchief_runtime.supplier_link_submissions r JOIN stockchief_runtime.supplier_order_links l ON l.token_hash=r.token_hash AND l.workspace_id=r.workspace_id JOIN purchase_orders po ON po.workspace_id=l.workspace_id AND po.id=l.purchase_order_id JOIN suppliers s ON s.workspace_id=po.workspace_id AND s.id=po.supplier_id LEFT JOIN stockchief_runtime.agent_po_date_sources v ON v.workspace_id=r.workspace_id AND v.source_id=r.id WHERE r.workspace_id=$1 AND r.kind IN ('date','confirm') AND r.expected_date IS NOT NULL AND ($2='' OR po.po_number ILIKE '%'||$2||'%' OR s.name ILIKE '%'||$2||'%') ORDER BY r.created_at DESC,r.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 return {summary:'Review exact delivery promises submitted through the supplier’s PO link. Pro needs a taught supplier, warehouse and product scope for routine changes. Custom needs explicit date limits and respects lower taught limits. Quantity, price and payment-term amendments still need separate workflows.',rows:rows.slice(0,100).map(row=>({Order:row.po_number,Supplier:row.name,'Supplier date':row.expected_date,Status:row.processed_at?(row.changed?'Delivery date updated':'Reviewed without changing the date'):'Needs review',Review:row.problem||'',link:'/autopilot/po-delivery-dates/'+row.id})),more:rows.length>100};
}
async function inbox(db,workspaceId,actorId){
 const rows=(await db.query(`SELECT r.id,r.created_at,po.po_number,s.problem FROM stockchief_runtime.supplier_link_submissions r JOIN stockchief_runtime.supplier_order_links l ON l.token_hash=r.token_hash AND l.workspace_id=r.workspace_id JOIN purchase_orders po ON po.workspace_id=l.workspace_id AND po.id=l.purchase_order_id LEFT JOIN stockchief_runtime.agent_po_date_sources s ON s.workspace_id=r.workspace_id AND s.source_id=r.id WHERE r.workspace_id=$1 AND r.kind IN ('date','confirm') AND r.expected_date IS NOT NULL AND s.processed_at IS NULL AND po.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED') AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_po_date_heads h WHERE h.workspace_id=r.workspace_id AND h.purchase_order_id=po.id AND h.received_at>=r.created_at) ORDER BY r.created_at,r.id LIMIT 51`,[workspaceId])).rows;
 if(!rows.length)return [];await source.owner(db,{workspaceId,actorId});const account=await policy.accountState(db,workspaceId);if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,31,'draft'))return [];
 return rows.slice(0,50).map(row=>({kind:'purchase',importance:'Needs You',priority:79,title:'Review supplier delivery date for '+row.po_number,happened:'The supplier submitted a delivery promise through this PO’s original link.',why:row.problem||'Compare it with the current promise and your authorized date limits.',recommendation:'Review the exact source before changing the order’s delivery date.',href:'/autopilot/po-delivery-dates/'+row.id,actionLabel:'Review supplier date',sourceId:'po-date:'+row.id,createdAt:row.created_at,at:row.created_at}));
}
module.exports={apply,preview,configure,teach,onArrival,enqueue,run,jobKind,action,saved,page,inbox,definition:{id:31,key:'po-delivery-dates',label:'Update delivery promises from original supplier responses',filterLabel:'PO number or supplier',readPage}};
