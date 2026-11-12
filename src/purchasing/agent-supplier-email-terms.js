'use strict';
const source=require('./supplier-email-terms-source'),policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions'),{ValidationError}=require('../domain/errors');
const action='supplier.email_terms',jobKind='mail.supplier-terms.v1',numeric=source.numeric;
const instant=value=>new Date(value).getTime();
const scope=p=>({supplierId:p.supplierId,supplierEmail:p.supplierEmail,connectorId:p.connectorId,mailboxAccount:p.mailboxAccount,providerType:p.providerType,
 products:[...new Map(p.changes.filter(r=>r.skuId).map(r=>[r.skuId,r.product])).values()].sort((a,b)=>a.skuId.localeCompare(b.skuId)),fields:[...new Set(p.changes.map(r=>r.field))].sort()});
function limits(input){
 const values={};for(const key of ['maximumLeadDays','maximumLeadChangeDays','maximumMoq','maximumMoqChange']){
  if(input[key]===null||input[key]===undefined||String(input[key]).trim()==='')throw new ValidationError('Enter every maximum explicitly, including zero for fields you do not authorize.');
  const value=source.decimal(input[key],key.includes('Lead')?365:100000);if(key.includes('Lead')&&!Number.isInteger(value))throw new ValidationError('Lead-time limits must be whole days.');values[key]=value;
 }
 // Pack sizes change how many stock units each purchase unit holds. With no
 // pack-size limit, every pack-size change waits for a person.
 let pack=null;if(input.maximumPackChange!==null&&input.maximumPackChange!==undefined&&String(input.maximumPackChange).trim()!==''){pack=source.decimal(input.maximumPackChange,100000);if(!Number.isInteger(pack))throw new ValidationError('The pack-size limit must be a whole number of stock units.');}
 return {...values,maximumPackChange:pack,allowUnset:input.allowUnset==='yes'};
}
function within(change,caps){
 if(source.personOnly.has(change.field))return false;
 if(!numeric.has(change.field))return true;
 if(change.before===null&&!caps.allowUnset)return false;
 const scaled=value=>Math.round(Number(value||0)*1e6);
 if(change.field==='units_per_purchase_unit')return caps.maximumPackChange!==null&&caps.maximumPackChange!==undefined&&Math.abs(scaled(change.value)-scaled(change.before))<=scaled(caps.maximumPackChange);
 const lead=change.field==='lead_time_days'||change.field==='default_lead_time_days',max=lead?caps.maximumLeadDays:caps.maximumMoq,delta=lead?caps.maximumLeadChangeDays:caps.maximumMoqChange;
 return change.value<=max&&Math.abs(scaled(change.value)-scaled(change.before))<=scaled(delta);
}
async function lock(db,ctx){
 await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
 await source.owner(db,ctx);return policy.requireWorkspaceJob(db,ctx.workspaceId,96,'draft');
}
async function saved(db,workspaceId,id){return (await db.query('SELECT * FROM stockchief_runtime.agent_supplier_term_sources WHERE workspace_id=$1 AND message_id=$2',[workspaceId,id])).rows[0]||null;}
async function older(db,workspaceId,p){
 const heads=(await db.query('SELECT *,effective_date::text FROM stockchief_runtime.agent_supplier_term_heads WHERE workspace_id=$1 AND supplier_id=$2',[workspaceId,p.supplierId])).rows;
 return p.changes.some(change=>{
  const head=heads.find(h=>h.target_id===change.targetId&&h.field===change.field);
  const priorAutomatic=head?.automatic&&instant(head.record_updated_at)===instant(change.updatedAt)&&hash(head.applied_value)===hash(change.before);
  return instant(change.updatedAt)>instant(p.receivedAt)&&!priorAutomatic||head&&(head.effective_date>p.effectiveDate||instant(head.authority_at)>instant(p.receivedAt)||instant(head.received_at)>=instant(p.receivedAt));
 });
}
async function preview(db,ctx,id){const p=await source.facts(db,ctx,id),receipt=await saved(db,ctx.workspaceId,id);if(receipt?.processed_at&&receipt.instruction_hash!==p.instructionHash)throw new ValidationError('The original email or product units changed after this update. Review the saved record individually.');return {facts:p,receipt,older:receipt?.processed_at?false:await older(db,ctx.workspaceId,p),today:await require('../lib/business-time').today(db,ctx.workspaceId)};}
// Growth applies only what a taught example covers. Pro and Custom apply inside
// the owner's saved supplier limits, and a lower taught limit still applies.
async function automaticAuthority(c,ctx,account,p){
 if(p.unclear?.length)throw new ValidationError(p.unclear[0].reason+' A person needs to check this email.');
 if(p.other?.length)throw new ValidationError('This email also mentions prices, payment, bank or other terms. Those always need a person.');
 if(p.changes.some(change=>source.personOnly.has(change.field)&&change.before!==change.value))throw new ValidationError('A new order email address always needs you. Purchase orders would go to it, so check it with the supplier by phone first.');
 const setting=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_term_settings WHERE workspace_id=$1 AND supplier_id=$2 FOR SHARE',[ctx.workspaceId,p.supplierId])).rows[0];
 const rules=(await c.query("SELECT r.*,u.role FROM stockchief_runtime.agent_supplier_term_rules r LEFT JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by WHERE r.workspace_id=$1 AND r.scope->>'supplierId'=$2",[ctx.workspaceId,p.supplierId])).rows;
 const settingOk=Boolean(setting?.enabled&&setting.authorized_by===ctx.actorId&&instant(p.receivedAt)>=instant(setting.authorized_at));
 if(!settingOk&&!rules.length)throw new ValidationError('Only new supplier emails within an enabled owner-authorized scope or a taught example can update these records.');
 const s=scope(p);let current=null;
 if(settingOk){
  current=await configScope(c,ctx,p.supplierId,setting.scope.connectorId,setting.scope.allProducts?'all':setting.scope.products.map(r=>r.skuId),setting.scope.fields);
  if(hash(current)!==setting.scope_hash)throw new ValidationError('The supplier, mailbox, product codes or purchase units changed. Review the saved supplier update scope.');
  if(s.supplierEmail!==current.supplierEmail||s.connectorId!==current.connectorId||s.mailboxAccount!==current.mailboxAccount||s.providerType!==current.providerType)throw new ValidationError('The original email came from outside the owner-authorized supplier mailbox.');
 }
 if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Automatic supplier updates are paused.');
 let trained=true;
 for(const change of p.changes){
  const related=rules.filter(r=>r.scope.fields.includes(change.field)&&(change.skuId?r.scope.products.some(product=>product.skuId===change.skuId):!r.scope.products.length||r.scope.fields.some(field=>!source.itemFields.has(field))));
  const matching=related.filter(r=>r.scope.supplierEmail===s.supplierEmail&&r.scope.connectorId===s.connectorId&&r.scope.mailboxAccount===s.mailboxAccount&&r.scope.providerType===s.providerType&&(!change.skuId||r.scope.products.some(product=>hash(product)===hash(change.product))));
  if(related.some(rule=>rule.authorized_by!==ctx.actorId||rule.role!=='owner'||!matching.includes(rule)||!within(change,rule.limits)))throw new ValidationError('This update changed a taught scope or exceeds a lower owner-taught limit. Review it individually.');
  const inSetting=settingOk&&current.fields.includes(change.field)&&(!change.skuId||current.allProducts||current.products.some(product=>hash(product)===hash(change.product)));
  if(inSetting&&!within(change,setting.limits))throw new ValidationError('This supplier update exceeds the owner’s maximum or needs approval to fill an empty value.');
  if(!matching.length){trained=false;if(!inSetting)throw new ValidationError('The original email includes fields or products outside the owner-authorized supplier scope.');}
 }
 policy.requireJob(account.plan,96,'automatic',{trained});return setting;
}
function column(field){return source.itemFields.has(field)?'supplier_items':'suppliers';}
async function apply(db,ctx,id,input={}, {automatic=false}={}){
 return db.transaction(async c=>{
  const account=await lock(c,ctx),stop=await policy.stopped(c,ctx.workspaceId,account,action,automatic);if(stop)throw new ValidationError(stop);
  await c.query('SELECT id FROM connection_email_messages WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id]);
  let p=await source.facts(c,ctx,id);
  await c.query('SELECT id FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[ctx.workspaceId,[...new Set(p.changes.map(r=>r.skuId).filter(Boolean))]]);
  await c.query('SELECT id FROM suppliers WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,p.supplierId]);
  await c.query('SELECT id FROM supplier_items WHERE workspace_id=$1 AND supplier_id=$2 AND id=ANY($3::text[]) ORDER BY id FOR UPDATE',[ctx.workspaceId,p.supplierId,p.changes.filter(r=>r.skuId).map(r=>r.targetId)]);
  const prepared=await preview(c,ctx,id);p=prepared.facts;
  if(prepared.receipt?.processed_at)return {replayed:true,changedCount:prepared.receipt.changed_count,automatic:prepared.receipt.automatic};
  if(prepared.receipt?.dismissed_at)throw new ValidationError('You chose to keep the current values for this email.');
  if(automatic){await automaticAuthority(c,ctx,account,p);if(prepared.older)throw new ValidationError('A newer supplier email or owner edit exists. Review both sources before changing these values.');}
  else{
   if(input.confirmed!=='yes'||input.expectedFingerprint!==p.sourceFingerprint||prepared.older&&input.overrideNewer!=='yes')throw new ValidationError('Approve these exact original instructions and current values. Confirm separately if you intend to replace a newer owner edit or supplier source.');
   if(!p.changes.length)throw new ValidationError('This email has no exact supplier values to apply. Keep the current values, or update the supplier record yourself.');
   const address=p.changes.find(change=>source.personOnly.has(change.field)&&change.before!==change.value);
   if(address&&input.confirmAddress!=='yes')throw new ValidationError('Confirm you checked the new order email address with the supplier by phone or another known contact.');
   if(address&&(await c.query("SELECT 1 FROM suppliers WHERE workspace_id=$1 AND id<>$2 AND status='active' AND lower(email)=lower($3) LIMIT 1",[ctx.workspaceId,p.supplierId,address.value])).rowCount)throw new ValidationError('Another supplier already uses '+address.value+'.');
  }
  if(p.effectiveDate>prepared.today)throw Object.assign(new ValidationError('These supplier details take effect on '+p.effectiveDate+'. They cannot change the current record early.'),{effectiveDate:p.effectiveDate});
  const at=new Date().toISOString(),changedTargets=new Set(p.changes.filter(change=>change.before!==change.value).map(change=>change.targetId));let changedCount=0;
  for(const change of p.changes){
   // Column names are fixed parser fields. This intentionally does not call the
   // supplier-product upsert, which would refresh an unchanged purchase cost.
   if(!Object.hasOwn(source.labels,change.field))throw new ValidationError('This supplier field needs individual review.');
   if(change.before!==change.value){
    const result=await c.query('UPDATE '+column(change.field)+' SET '+change.field+'=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,change.targetId,change.value,at]);
    if(result.rowCount!==1)throw new ValidationError('The selected supplier record is no longer available.');changedCount++;
   }
   await c.query(`INSERT INTO stockchief_runtime.agent_supplier_term_heads(workspace_id,supplier_id,target_id,field,message_id,received_at,effective_date,authority_at,record_updated_at,applied_value,automatic)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) ON CONFLICT(workspace_id,supplier_id,target_id,field) DO UPDATE SET message_id=EXCLUDED.message_id,received_at=EXCLUDED.received_at,effective_date=EXCLUDED.effective_date,authority_at=EXCLUDED.authority_at,record_updated_at=EXCLUDED.record_updated_at,applied_value=EXCLUDED.applied_value,automatic=EXCLUDED.automatic`,[ctx.workspaceId,p.supplierId,change.targetId,change.field,id,p.receivedAt,p.effectiveDate,automatic?p.receivedAt:at,changedTargets.has(change.targetId)?at:change.updatedAt,JSON.stringify(change.value),automatic]);
  }
  await c.query(`INSERT INTO stockchief_runtime.agent_supplier_term_sources(workspace_id,message_id,supplier_id,source_snapshot,instruction_hash,changed_count,automatic,processed_by,processed_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,message_id) DO UPDATE SET supplier_id=EXCLUDED.supplier_id,source_snapshot=EXCLUDED.source_snapshot,instruction_hash=EXCLUDED.instruction_hash,changed_count=EXCLUDED.changed_count,automatic=EXCLUDED.automatic,processed_by=EXCLUDED.processed_by,processed_at=EXCLUDED.processed_at,problem=NULL`,[ctx.workspaceId,id,p.supplierId,JSON.stringify(p),p.instructionHash,changedCount,automatic,ctx.actorId,at]);
  const message=(await c.query('SELECT subject,body_text,sender FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
  const reply=require('../connections/reply-triage').judge({...message,bodyText:message.body_text,knownCounterparty:true,processingStatus:'SAVED_NO_ACTION'});
  if(reply.state==='HANDLED')await c.query(`UPDATE connection_email_messages m SET reply_state='HANDLED',reply_reason='StockChief recorded these supplier details. The original email asks for no reply.',reply_state_at=$3
   WHERE m.workspace_id=$1 AND m.id=$2 AND m.reply_state='NEEDS_REPLY' AND m.reply_state_by_user_id IS NULL AND m.reply_sent_at IS NULL AND m.draft_source IS DISTINCT FROM 'owner'
    AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.email_reply_outbox o WHERE o.workspace_id=m.workspace_id AND o.message_id=m.id AND o.status IN ('PENDING','SENDING','AMBIGUOUS'))`,[ctx.workspaceId,id,at]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier details updated from original email',reference:id,before:{values:p.changes.map(r=>({product:r.product?.code||p.supplierName,field:source.labels[r.field],value:r.before}))},after:{automatic,changedCount,values:p.changes.map(r=>({product:r.product?.code||p.supplierName,field:source.labels[r.field],value:r.value}))}});
  return {changedCount,automatic,replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
// Puts back the values an email changed, while nothing has changed them since.
async function undo(db,ctx,id,input={}){
 return db.transaction(async c=>{
  await source.owner(c,ctx);const receipt=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_term_sources WHERE workspace_id=$1 AND message_id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
  if(receipt?.undone_at)return {replayed:true};
  if(!receipt?.processed_at||!receipt.changed_count||input.confirmed!=='yes')throw new ValidationError('Confirm undoing the supplier details this email changed.');
  const p=receipt.source_snapshot,changed=p.changes.filter(change=>change.before!==change.value),restored=[];
  for(const change of changed){
   const head=(await c.query('SELECT message_id,applied_value FROM stockchief_runtime.agent_supplier_term_heads WHERE workspace_id=$1 AND supplier_id=$2 AND target_id=$3 AND field=$4 FOR UPDATE',[ctx.workspaceId,p.supplierId,change.targetId,change.field])).rows[0];
   const row=(await c.query('SELECT '+change.field+' AS value FROM '+column(change.field)+' WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,change.targetId])).rows[0];
   const now=row?.value===null||row?.value===undefined?null:numeric.has(change.field)?Number(row.value):row.value;
   if(head?.message_id!==id||!row||JSON.stringify(now)!==JSON.stringify(change.value))throw new ValidationError((source.labels[change.field]||'A supplier value')+(change.product?' on '+change.product.code:'')+' changed again after this email. Open the supplier record to correct it.');
   restored.push(change);
  }
  const at=new Date().toISOString();
  for(const change of restored){
   await c.query('UPDATE '+column(change.field)+' SET '+change.field+'=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,change.targetId,change.before,at]);
   await c.query('DELETE FROM stockchief_runtime.agent_supplier_term_heads WHERE workspace_id=$1 AND supplier_id=$2 AND target_id=$3 AND field=$4 AND message_id=$5',[ctx.workspaceId,p.supplierId,change.targetId,change.field,id]);
  }
  await c.query('UPDATE stockchief_runtime.agent_supplier_term_sources SET undone_at=$3,undone_by=$4 WHERE workspace_id=$1 AND message_id=$2',[ctx.workspaceId,id,at,ctx.actorId]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier details update undone',reference:id,before:{values:restored.map(r=>({product:r.product?.code||p.supplierName,field:source.labels[r.field],value:r.value}))},after:{values:restored.map(r=>({product:r.product?.code||p.supplierName,field:source.labels[r.field],value:r.before}))}});
  return {restored:restored.length,replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
// The owner keeps current values instead of an email's update.
async function dismiss(db,ctx,id,input={}){
 return db.transaction(async c=>{
  await source.owner(c,ctx);if(input.confirmed!=='yes')throw new ValidationError('Confirm keeping the current supplier values.');
  const message=(await c.query("SELECT supplier_id FROM connection_email_messages WHERE workspace_id=$1 AND id=$2 AND classification='supplier' FOR UPDATE",[ctx.workspaceId,id])).rows[0];if(!message)throw new ValidationError('This supplier email is not in this inventory.');
  const receipt=await saved(c,ctx.workspaceId,id);if(receipt?.processed_at)throw new ValidationError('This email was already applied. Undo it instead.');if(receipt?.dismissed_at)return {replayed:true};
  await c.query(`INSERT INTO stockchief_runtime.agent_supplier_term_sources(workspace_id,message_id,supplier_id,dismissed_at,dismissed_by) VALUES($1,$2,$3,now(),$4)
   ON CONFLICT(workspace_id,message_id) DO UPDATE SET dismissed_at=now(),dismissed_by=EXCLUDED.dismissed_by`,[ctx.workspaceId,id,message.supplier_id,ctx.actorId]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier details email kept without changes',reference:id});return {replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function configScope(c,ctx,supplierId,connectorId,skuIds,fields){
 const supplier=(await c.query("SELECT id,email FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,supplierId])).rows[0];
 const mailbox=(await c.query("SELECT provider_type,provider_account_id FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 AND status='connected' AND paused_at IS NULL AND provider_type IN ('gmail','microsoft365') AND provider_account_id IS NOT NULL",[ctx.workspaceId,connectorId])).rows[0];
 const allProducts=skuIds==='all';
 if(!supplier?.email||!mailbox||!allProducts&&(!Array.isArray(skuIds)||skuIds.length>250||new Set(skuIds).size!==skuIds.length)||!Array.isArray(fields)||!fields.length||new Set(fields).size!==fields.length||fields.some(field=>!Object.hasOwn(source.labels,field)||source.personOnly.has(field)))throw new ValidationError('Choose the known supplier, connected source mailbox, exact products and allowed fields. A new order email address always needs a person.');
 const all=await source.catalog(c,ctx.workspaceId,supplierId),products=allProducts?[]:all.filter(row=>skuIds.includes(row.sku_id)).map(source.product);
 if(!allProducts&&products.length!==skuIds.length||fields.some(field=>source.itemFields.has(field))&&!allProducts&&!products.length)throw new ValidationError('Choose active linked supplier products for lead times, minimum quantities or pack sizes.');
 return {supplierId,supplierEmail:supplier.email,connectorId,mailboxAccount:mailbox.provider_account_id,providerType:mailbox.provider_type,products,fields:[...fields].sort(),...(allProducts?{allProducts:true}:{})};
}
async function configure(db,ctx,supplierId,input){
 return db.transaction(async c=>{
  await source.owner(c,ctx);const prior=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_term_settings WHERE workspace_id=$1 AND supplier_id=$2 FOR UPDATE',[ctx.workspaceId,supplierId])).rows[0];
  if((prior?.revision||0)!==Number(input.revision||0))throw new ValidationError('Reload the current supplier update settings before saving.');
  if(input.stop==='yes'){await c.query('UPDATE stockchief_runtime.agent_supplier_term_settings SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND supplier_id=$2',[ctx.workspaceId,supplierId]);if(prior?.enabled)await require('../operations/postgres-security-audit').record(c,ctx,{action:'Routine supplier email updates stopped',reference:supplierId});return;}
  const account=await lock(c,ctx);if(account.shadow||input.confirmed!=='yes')throw new ValidationError('After the 14-day watch period, confirm the supplier, mailbox, product scope, fields and limits explicitly.');
  const fields=[].concat(input.fields||[]),s=await configScope(c,ctx,supplierId,input.connectorId,input.allProducts==='yes'?'all':[].concat(input.skuIds||[]),fields),caps=limits(input);
  await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
  await c.query(`INSERT INTO stockchief_runtime.agent_supplier_term_settings(workspace_id,supplier_id,scope,scope_hash,limits,authorized_by)
   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,supplier_id) DO UPDATE SET scope=EXCLUDED.scope,scope_hash=EXCLUDED.scope_hash,limits=EXCLUDED.limits,authorized_by=EXCLUDED.authorized_by,authorized_at=clock_timestamp(),enabled=true,revision=agent_supplier_term_settings.revision+1`,[ctx.workspaceId,supplierId,JSON.stringify(s),hash(s),JSON.stringify(caps),ctx.actorId]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Routine supplier email update scope authorized',reference:supplierId,after:{scope:s,limits:caps}});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function teach(db,ctx,id,input){
 return db.transaction(async c=>{
  await source.owner(c,ctx);const receipt=await saved(c,ctx.workspaceId,id);if(!receipt?.processed_at)throw new ValidationError('Approve an original supplier email before teaching its exact scope.');
  const snapshot={...receipt.source_snapshot,changes:receipt.source_snapshot.changes.filter(change=>!source.personOnly.has(change.field))};
  if(!snapshot.changes.length)throw new ValidationError('A new order email address always needs a person, so it cannot be taught.');
  const s=scope(snapshot),scopeHash=hash(s),prior=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_term_rules WHERE workspace_id=$1 AND scope_hash=$2 FOR UPDATE',[ctx.workspaceId,scopeHash])).rows[0];
  if((prior?.revision||0)!==Number(input.revision||0)||input.confirmed!=='yes')throw new ValidationError('Reload and confirm the current learned supplier rule.');
  if(input.remove==='yes'){if(!prior)throw new ValidationError('This learned rule no longer exists.');await c.query('DELETE FROM stockchief_runtime.agent_supplier_term_rules WHERE workspace_id=$1 AND scope_hash=$2',[ctx.workspaceId,scopeHash]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Learned supplier update scope removed',reference:id});return;}
  const account=await lock(c,ctx);if(account.shadow||receipt.automatic||receipt.processed_by!==ctx.actorId||receipt.undone_at)throw new ValidationError('Use an individually approved example after the 14-day watch period. Automatic or undone changes cannot teach more authority.');
  const p=await source.facts(c,ctx,id);if(p.instructionHash!==receipt.instruction_hash)throw new ValidationError('The source or product units changed after the individual example. Review a current source first.');
  const caps=limits(input);await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?0:1);
  await c.query(`INSERT INTO stockchief_runtime.agent_supplier_term_rules(workspace_id,scope_hash,scope,limits,authorized_by,example_message_id)
   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,scope_hash) DO UPDATE SET limits=EXCLUDED.limits,authorized_by=EXCLUDED.authorized_by,example_message_id=EXCLUDED.example_message_id,revision=agent_supplier_term_rules.revision+1`,[ctx.workspaceId,scopeHash,JSON.stringify(s),JSON.stringify(caps),ctx.actorId,id]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Learned supplier email update limits saved',reference:id,after:{scope:s,limits:caps}});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function ownerId(db,workspaceId){return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE u.workspace_id=$1 AND u.role='owner' ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;}
// Called when a supplier email arrives, and again when its attachments have
// been read. Anything it cannot apply on its own waits in Needs you.
async function onArrival(db,workspaceId,id){
 const actorId=await ownerId(db,workspaceId);if(!actorId)return {skipped:true};
 const receipt=await saved(db,workspaceId,id);if(receipt?.dismissed_at)return {skipped:'kept_current_values'};
 const ctx={workspaceId,actorId};
 if(!receipt?.processed_at)try{const p=(await preview(db,ctx,id)).facts;
  if(p.freeForm&&!p.unclear.length&&!p.other.length&&p.changes.every(change=>change.before===change.value))return {skipped:'unchanged'};
 }catch(error){if(error.notRelevant)return {skipped:'not_relevant'};if(error.waiting)return {waiting:true};if(![400,402,403,404,422].includes(error.status))throw error;}
 try{return await apply(db,ctx,id,{}, {automatic:true});}
 catch(error){
  if(![400,402,403,404,422].includes(error.status))throw error;
  if(error.notRelevant)return {skipped:'not_relevant'};if(error.waiting)return {waiting:true};
  if(error.effectiveDate){const clock=await require('../lib/business-time').forWorkspace(db,workspaceId),due=Date.parse(require('../lib/business-time').dayBoundary(error.effectiveDate,clock.timeZone));if(due>Date.now()&&due<Date.now()+366*86400000)await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:jobKind,idempotencyKey:'supplier-terms-due:'+id+':'+error.effectiveDate,payload:{messageId:id},availableAt:due,priority:55,maxAttempts:3});}
  await db.query(`INSERT INTO stockchief_runtime.agent_supplier_term_sources(workspace_id,message_id,supplier_id,problem) SELECT $1,$2,supplier_id,$3 FROM connection_email_messages WHERE workspace_id=$1 AND id=$2 ON CONFLICT(workspace_id,message_id) DO UPDATE SET problem=EXCLUDED.problem WHERE agent_supplier_term_sources.processed_at IS NULL`,[workspaceId,id,String(error.message).slice(0,500)]);return {held:true,reason:error.message};
 }
}
// Queues a supplier email whose text or read attachments may state new details.
async function queueMessage(db,workspaceId,id){
 const row=(await db.query(`SELECT m.subject,m.body_text,m.classification,m.supplier_id,(SELECT string_agg(coalesce(a.extracted_text,''),E'\\n' ORDER BY a.id) FROM connection_email_attachments a WHERE a.workspace_id=m.workspace_id AND a.message_id=m.id AND coalesce(a.external_attachment_id,'') NOT LIKE 'stockchief:%') AS attached
  FROM connection_email_messages m WHERE m.workspace_id=$1 AND m.id=$2`,[workspaceId,id])).rows[0];
 if(!row||row.classification!=='supplier'||!row.supplier_id)return {queued:false};
 if(!source.isSubject(row.subject)&&!require('./supplier-detail-text').mentions(row.subject,(row.body_text||'')+'\n'+(row.attached||'')))return {queued:false};
 const state=await policy.accountState(db,workspaceId);if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,96,'draft'))return {queued:false};
 const key='supplier-terms-email:'+id+(row.attached?':'+hash(row.attached).slice(0,16):'');
 await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:jobKind,idempotencyKey:key,payload:{messageId:id},priority:55,maxAttempts:3});return {queued:true};
}
async function page(db,ctx,id){
 await source.owner(db,ctx);const account=await policy.accountState(db,ctx.workspaceId),locked=!policy.usesAgentTerms(account)||!policy.permits(account.plan,96,'draft'),message=(await db.query('SELECT id,subject,body_text,sender,supplier_id FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
 if(!message)throw new ValidationError('This supplier email is not in this inventory.');let prepared=null,problem=null;
 if(!locked){try{prepared=await preview(db,ctx,id);}catch(error){if(![400,402,403,404,422].includes(error.status))throw error;problem=error.message;}}
 const receipt=await saved(db,ctx.workspaceId,id),p=prepared?.facts||receipt?.source_snapshot,setting=message.supplier_id?(await db.query('SELECT * FROM stockchief_runtime.agent_supplier_term_settings WHERE workspace_id=$1 AND supplier_id=$2',[ctx.workspaceId,message.supplier_id])).rows[0]:null;
 const teachable=p?{...p,changes:p.changes.filter(change=>!source.personOnly.has(change.field))}:null;
 const rule=teachable?.changes.length?(await db.query('SELECT * FROM stockchief_runtime.agent_supplier_term_rules WHERE workspace_id=$1 AND scope_hash=$2',[ctx.workspaceId,hash(scope(teachable))])).rows[0]:null;
 const attachments=(await db.query("SELECT id,filename,extraction_status FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2 AND coalesce(external_attachment_id,'') NOT LIKE 'stockchief:%' ORDER BY id",[ctx.workspaceId,id])).rows;
 return {message,locked,prepared,facts:p||null,receipt,problem:problem||receipt?.problem,setting,rule,labels:source.labels,scopeLabels:Object.fromEntries(Object.entries(source.labels).filter(([field])=>!source.personOnly.has(field))),shadow:account.shadow,plan:account.plan,attachments,
  canTeach:Boolean(receipt?.processed_at&&!receipt.automatic&&!receipt.undone_at&&receipt.processed_by===ctx.actorId&&teachable?.changes.length),
  canUndo:Boolean(receipt?.processed_at&&receipt.changed_count>0&&!receipt.undone_at),canKeep:Boolean(!locked&&!receipt?.processed_at&&!receipt?.dismissed_at&&message.supplier_id),
  addressChange:prepared?.facts.changes.find(change=>source.personOnly.has(change.field)&&change.before!==change.value)||null,
  mailboxes:message.supplier_id?(await db.query("SELECT id,display_name FROM workspace_connectors WHERE workspace_id=$1 AND status='connected' AND paused_at IS NULL AND provider_type IN ('gmail','microsoft365') ORDER BY display_name,id LIMIT 101",[ctx.workspaceId])).rows:[],products:message.supplier_id?(await source.catalog(db,ctx.workspaceId,message.supplier_id)).slice(0,250):[]};
}
const reviewSubject=`lower(coalesce(m.subject,'')) ~ '^(supplier (terms|details) update|lead time and minimum order update)([[:space:]]*[:#-][[:space:]]*[a-z0-9_.-]+)?[.!]?$'`;
async function readPage(db,ctx,{filter='',page=1}={}){
 const rows=(await db.query(`SELECT m.id,m.sender,m.subject,m.received_at,s.changed_count,s.processed_at,s.problem,s.dismissed_at,s.undone_at FROM connection_email_messages m LEFT JOIN stockchief_runtime.agent_supplier_term_sources s ON s.workspace_id=m.workspace_id AND s.message_id=m.id
  WHERE m.workspace_id=$1 AND m.classification='supplier' AND (s.message_id IS NOT NULL OR ${reviewSubject}) AND ($2='' OR lower(m.sender)=lower($2)) ORDER BY m.received_at::timestamptz DESC,m.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 return {summary:'Keep supplier lead times, minimum orders, pack sizes and contact names or phones current from their emails and attached files. Starter is excluded. Growth asks until you teach it with an approved example; Pro and Custom update within your saved limits. A new order email address, prices, payment terms and anything unclear always wait for you.',
  rows:rows.slice(0,100).map(r=>({Supplier:r.sender,Subject:r.subject,Updated:r.undone_at?'Undone':r.processed_at?r.changed_count+' fields':r.dismissed_at?'Kept current values':'Needs review',Review:r.processed_at||r.dismissed_at?'':r.problem||'',link:'/mail/'+r.id+'/supplier-details'})),more:rows.length>100};
}
async function inbox(db,workspaceId,actorId){
 const owner=(await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[workspaceId,actorId])).rowCount;if(!owner)return [];
 const account=await policy.accountState(db,workspaceId);if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,96,'draft'))return [];
 const rows=(await db.query(`SELECT * FROM (
   SELECT m.id,m.sender,m.received_at,s.problem FROM connection_email_messages m
   LEFT JOIN stockchief_runtime.agent_supplier_term_sources s ON s.workspace_id=m.workspace_id AND s.message_id=m.id
   WHERE m.workspace_id=$1 AND m.classification='supplier' AND s.processed_at IS NULL AND s.dismissed_at IS NULL AND ${reviewSubject}
   UNION
   SELECT m.id,m.sender,m.received_at,s.problem FROM stockchief_runtime.agent_supplier_term_sources s
   JOIN connection_email_messages m ON m.workspace_id=s.workspace_id AND m.id=s.message_id
   WHERE s.workspace_id=$1 AND s.processed_at IS NULL AND s.dismissed_at IS NULL AND m.classification='supplier'
  ) waiting ORDER BY received_at,id LIMIT 101`,[workspaceId])).rows;
 const entries=rows.slice(0,100).map(row=>({kind:'mail',importance:'Needs You',priority:/order email address/i.test(row.problem||'')?88:81,title:'Review supplier details from '+row.sender,happened:'A known supplier sent new lead times, minimum orders, pack sizes or contact details.',why:row.problem||'The original email needs your review or a saved routine scope.',recommendation:'Compare the email and any attached file with the current supplier values before approving.',href:'/mail/'+row.id+'/supplier-details',actionLabel:'Review supplier updates',sourceId:'supplier-email-details:'+row.id,createdAt:row.received_at,at:row.received_at}));
 if(rows.length>100)entries.push({kind:'mail',grouped:true,importance:'Needs You',priority:80,title:'More supplier detail updates need review',happened:'More than 100 original supplier messages are waiting.',why:'Each source needs its own review or an authorized routine scope.',recommendation:'Open the paged supplier update list.',href:'/autopilot/reviews/supplier-email-details',actionLabel:'Review all supplier updates',sourceId:'supplier-email-details:more'});
 return entries;
}
module.exports={preview,apply,undo,dismiss,configure,teach,onArrival,queueMessage,page,saved,scope,limits,within,jobKind,inbox,definition:{id:96,key:'supplier-email-details',label:'Update supplier details from original emails',filterLabel:'Exact supplier email',readPage}};
