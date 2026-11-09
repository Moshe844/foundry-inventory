'use strict';
const source=require('./customer-return-email-source'),policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions'),{ValidationError}=require('../domain/errors');
const action='customer_return.from_email';
function bound(p){return {customerId:p.customerId,customerEmail:p.customerEmail,connectorId:p.connectorId,mailboxAccount:p.mailboxAccount,providerType:p.providerType,locationId:p.locationId,resolution:p.input.resolution,products:p.lines.map(line=>({skuId:line.skuId,code:line.code,unit:line.unit})).sort((a,b)=>a.skuId.localeCompare(b.skuId))};}
function units(p){const n=p.lines.reduce((sum,line)=>sum+line.quantity,0);if(!Number.isSafeInteger(n)||n<1)throw new ValidationError('Review this return quantity individually.');return n;}
async function saved(db,workspaceId,messageId){return (await db.query('SELECT s.*,r.return_number,r.status FROM stockchief_runtime.agent_return_email_sources s LEFT JOIN customer_returns r ON r.workspace_id=s.workspace_id AND r.id=s.customer_return_id WHERE s.workspace_id=$1 AND s.message_id=$2',[workspaceId,messageId])).rows[0]||null;}
async function duplicate(db,ctx,id){
 const prior=await saved(db,ctx.workspaceId,id);if(prior?.customer_return_id)return prior;
 const message=(await db.query('SELECT subject,body_text,sender FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
 if(!message)return null;
 const parsed=source.parse(message.subject,message.body_text);if(!parsed.requestReference)return null;
 return (await db.query(`SELECT s.*,r.return_number,r.status FROM stockchief_runtime.agent_return_email_sources s
  JOIN customers c ON c.workspace_id=s.workspace_id AND c.id=s.customer_id
  JOIN customer_returns r ON r.workspace_id=s.workspace_id AND r.id=s.customer_return_id
  WHERE s.workspace_id=$1 AND lower(s.request_reference)=lower($2) AND lower(c.email)=lower($3) AND c.record_state='ACTIVE' LIMIT 1`,[ctx.workspaceId,parsed.requestReference,message.sender])).rows[0]||null;
}
async function preview(db,ctx,id,locationId){
 await source.owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,111,'draft');
 const prior=await duplicate(db,ctx,id),p=await source.facts(db,ctx,id,locationId||prior?.source_snapshot?.locationId,{excludeReturnId:prior?.customer_return_id||null});
 if(prior?.customer_return_id&&prior.input_hash!==hash(p.input))throw new ValidationError('This customer return reference already uses different products or instructions. Review the original RMA.');
 return {facts:p,existing:prior?.customer_return_id?prior:null};
}
async function create(db,ctx,id,input,{automatic=false}={}){
 return db.transaction(async c=>{
  await source.owner(c,ctx);const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,111,'draft'),stop=await policy.stopped(c,ctx.workspaceId,account,action,automatic);if(stop)throw new ValidationError(stop);
  await c.query('SELECT id FROM connection_email_messages WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id]);
  const settings=(await c.query('SELECT * FROM stockchief_runtime.agent_return_email_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
  const prepared=await preview(c,ctx,id,automatic?settings?.quarantine_location_id:input.locationId),p=prepared.facts;
  if(prepared.existing)return {customerReturnId:prepared.existing.customer_return_id,returnNumber:prepared.existing.return_number,replayed:true};
  if(automatic){
   if(!settings?.enabled||settings.authorized_by!==ctx.actorId||units(p)>settings.maximum_units||!p.requestReference)throw new ValidationError('This return needs individual approval because its scope, quantity or customer return reference is not authorized.');
   if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Automatic return requests are paused.');
   const related=(await c.query("SELECT r.*,u.role FROM stockchief_runtime.agent_return_email_rules r LEFT JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by WHERE r.workspace_id=$1 AND r.scope->>'customerId'=$2 AND r.scope->>'resolution'=$3 AND r.scope->>'locationId'=$4",[ctx.workspaceId,p.customerId,p.input.resolution,p.locationId])).rows.filter(row=>row.scope.products.some(product=>p.lines.some(line=>line.skuId===product.skuId)));
   const rule=related.find(row=>row.scope_hash===hash(bound(p)));
   if(related.length&&!rule)throw new ValidationError('The source or product scope changed from the owner’s saved return rule. Review it individually.');
   if(related.some(row=>row.role!=='owner'||row.authorized_by!==ctx.actorId||units(p)>row.maximum_units))throw new ValidationError('This return exceeds the owner’s saved customer/product rule. Review it individually.');
   policy.requireJob(account.plan,111,'automatic',{trained:Boolean(rule&&rule.role==='owner')});
  }else if(input.confirmed!=='yes'||input.expectedFingerprint!==p.sourceFingerprint)throw new ValidationError('Review and approve the exact original return email, products and quantities before creating the RMA.');
  if(p.requestReference)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['customer-return-email',ctx.workspaceId,p.customerId,p.requestReference.toLowerCase()])]);
  const again=await duplicate(c,ctx,id);if(again?.customer_return_id){if(again.input_hash!==hash(p.input))throw new ValidationError('This customer return reference already uses different instructions.');return {customerReturnId:again.customer_return_id,returnNumber:again.return_number,replayed:true};}
  const result=await require('../operations/postgres-returns').requestCustomerReturn({query:c.query,transaction:work=>work(c)},ctx,{...p.input,idempotencyKey:'customer-return-email:'+id});
  await c.query(`INSERT INTO stockchief_runtime.agent_return_email_sources(workspace_id,message_id,customer_return_id,customer_id,request_reference,source_snapshot,source_fingerprint,input_hash,automatic,processed_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,message_id) DO UPDATE SET customer_return_id=EXCLUDED.customer_return_id,customer_id=EXCLUDED.customer_id,request_reference=EXCLUDED.request_reference,source_snapshot=EXCLUDED.source_snapshot,source_fingerprint=EXCLUDED.source_fingerprint,input_hash=EXCLUDED.input_hash,automatic=EXCLUDED.automatic,processed_by=EXCLUDED.processed_by,problem=NULL`,[ctx.workspaceId,id,result.customerReturnId,p.customerId,p.requestReference,JSON.stringify(p),p.sourceFingerprint,hash(p.input),automatic,ctx.actorId]);
  return {...result,automatic};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function configure(db,ctx,input){
 return db.transaction(async c=>{
  await source.owner(c,ctx);const prior=(await c.query('SELECT * FROM stockchief_runtime.agent_return_email_settings WHERE workspace_id=$1 FOR UPDATE',[ctx.workspaceId])).rows[0];
  if((prior?.revision||0)!==Number(input.revision||0))throw new ValidationError('Reload the current return-email settings before saving.');
  if(input.stop==='yes'){
   await c.query('UPDATE stockchief_runtime.agent_return_email_settings SET enabled=false,revision=revision+1 WHERE workspace_id=$1',[ctx.workspaceId]);
   if(prior?.enabled)await require('../operations/postgres-security-audit').record(c,ctx,{action:'Routine return-email requests stopped'});
   return;
  }
  const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,111,'draft');
  if(account.shadow||input.confirmed!=='yes')throw new ValidationError('After the 14-day watch period, confirm the exact return request authority before enabling it.');
  const maximum=Number(input.maximumUnits);if(!Number.isSafeInteger(maximum)||maximum<1||maximum>100000)throw new ValidationError('Choose a whole maximum between 1 and 100,000 returned units per request.');
  if(!(await c.query('SELECT 1 FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,input.locationId])).rowCount)throw new ValidationError('Choose an active internal inspection location.');
  await c.query(`INSERT INTO stockchief_runtime.agent_return_email_settings(workspace_id,quarantine_location_id,maximum_units,authorized_by)
   VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id) DO UPDATE SET quarantine_location_id=EXCLUDED.quarantine_location_id,maximum_units=EXCLUDED.maximum_units,authorized_by=EXCLUDED.authorized_by,enabled=true,revision=agent_return_email_settings.revision+1`,[ctx.workspaceId,input.locationId,maximum,ctx.actorId]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Return-email request authority configured',after:{locationId:input.locationId,maximumUnits:maximum}});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function teach(db,ctx,messageId,input){
 return db.transaction(async c=>{
  await source.owner(c,ctx);
  const example=await saved(c,ctx.workspaceId,messageId);
  if(input.remove==='yes'){
   if(input.confirmed!=='yes'||!example?.customer_return_id||!example.source_snapshot)throw new ValidationError('Confirm removing this learned return limit. The plan’s routine settings will still apply.');
   const removed=await c.query('DELETE FROM stockchief_runtime.agent_return_email_rules WHERE workspace_id=$1 AND scope_hash=$2 AND revision=$3',[ctx.workspaceId,hash(bound(example.source_snapshot)),Number(input.revision)]);
   if(!removed.rowCount)throw new ValidationError('Reload the current learned return rule before removing it.');
   await require('../operations/postgres-security-audit').record(c,ctx,{action:'Learned return-email scope removed',reference:messageId});return;
  }
  if(!example?.customer_return_id||example.automatic||example.processed_by!==ctx.actorId||example.status==='CANCELLED')throw new ValidationError('Create and individually approve this original return email before teaching its customer/product scope.');
  const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,111,'draft');
  if(account.shadow||input.confirmed!=='yes')throw new ValidationError('Confirm a completed individual example after the watch period before teaching this return scope.');
  const p=(await preview(c,ctx,messageId,example.source_snapshot.locationId)).facts;
  if(p.sourceFingerprint!==example.source_fingerprint)throw new ValidationError('This source changed after the reviewed RMA. Use a current individually approved example.');
  const maximum=Number(input.maximumUnits),scope=bound(p),scopeHash=hash(scope);
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>100000)throw new ValidationError('Choose a whole maximum between 1 and 100,000 units for this scope.');
  const prior=(await c.query('SELECT revision FROM stockchief_runtime.agent_return_email_rules WHERE workspace_id=$1 AND scope_hash=$2 FOR UPDATE',[ctx.workspaceId,scopeHash])).rows[0];
  if((prior?.revision||0)!==Number(input.revision||0))throw new ValidationError('This customer return rule changed. Reload before saving.');
  await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?0:1);
  await c.query(`INSERT INTO stockchief_runtime.agent_return_email_rules(workspace_id,scope_hash,scope,maximum_units,authorized_by,example_message_id)
   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,scope_hash) DO UPDATE SET maximum_units=EXCLUDED.maximum_units,authorized_by=EXCLUDED.authorized_by,example_message_id=EXCLUDED.example_message_id,revision=agent_return_email_rules.revision+1`,[ctx.workspaceId,scopeHash,JSON.stringify(scope),maximum,ctx.actorId,messageId]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Learned return-email scope saved',reference:messageId,after:{maximumUnits:maximum,scope}});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function onArrival(db,workspaceId,messageId){
 const settings=(await db.query('SELECT * FROM stockchief_runtime.agent_return_email_settings WHERE workspace_id=$1 AND enabled',[workspaceId])).rows[0];if(!settings)return {skipped:true};
 try{return await create(db,{workspaceId,actorId:settings.authorized_by},messageId,{}, {automatic:true});}
 catch(error){
  if(![400,402,403,404,422].includes(error.status))throw error;
  await db.query(`INSERT INTO stockchief_runtime.agent_return_email_sources(workspace_id,message_id,problem) VALUES($1,$2,$3)
   ON CONFLICT(workspace_id,message_id) DO UPDATE SET problem=EXCLUDED.problem WHERE agent_return_email_sources.customer_return_id IS NULL`,[workspaceId,messageId,String(error.message).slice(0,500)]);return {held:true,reason:error.message};
 }
}
async function page(db,ctx,id,locationId){
 await source.owner(db,ctx);const account=await policy.accountState(db,ctx.workspaceId),locked=!policy.usesAgentTerms(account)||!policy.permits(account.plan,111,'draft');
 const message=(await db.query('SELECT id,subject,body_text,sender FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
 if(!message)throw new ValidationError('This customer email is not in this inventory.');
 const setting=(await db.query('SELECT * FROM stockchief_runtime.agent_return_email_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0],evidence=await saved(db,ctx.workspaceId,id);
 const places=(await db.query("SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL ORDER BY name,id LIMIT 251",[ctx.workspaceId])).rows;
 const selected=locationId||evidence?.source_snapshot?.locationId||setting?.quarantine_location_id||'';
 let prepared=null,problem=evidence?.problem||null;
 if(!locked&&selected){try{prepared=await preview(db,ctx,id,selected);}catch(error){if(![400,402,403,404,422].includes(error.status))throw error;problem=error.message;}}
 const profile=prepared?.facts||evidence?.source_snapshot;
 const rule=profile?(await db.query('SELECT revision,maximum_units FROM stockchief_runtime.agent_return_email_rules WHERE workspace_id=$1 AND scope_hash=$2',[ctx.workspaceId,hash(bound(profile))])).rows[0]:null;
 return {message,locked,setting,places:places.slice(0,250),morePlaces:places.length>250,selected,prepared,problem,evidence,rule,shadow:account.shadow,plan:account.plan,canTeach:Boolean(prepared?.existing&&!prepared.existing.automatic&&prepared.existing.processed_by===ctx.actorId)};
}
async function readPage(db,ctx,{filter='',page=1}={}){
 const rows=(await db.query(`SELECT m.id,m.sender,m.subject,m.received_at,r.return_number,s.problem FROM connection_email_messages m
  LEFT JOIN stockchief_runtime.agent_return_email_sources s ON s.workspace_id=m.workspace_id AND s.message_id=m.id
  LEFT JOIN customer_returns r ON r.workspace_id=s.workspace_id AND r.id=s.customer_return_id
  WHERE m.workspace_id=$1 AND m.classification='customer' AND lower(coalesce(m.subject,'')) ~ '^(return request|request to return|customer return)([[:space:]]*[:#-].*)?[.!]?$'
   AND ($2='' OR lower(m.sender)=lower($2)) ORDER BY m.received_at::timestamptz DESC,m.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 return {summary:'Create an RMA request from a clear original customer email. Starter is excluded. Growth needs individual approval or a matching taught rule; Pro and Custom can handle routine requests within the limits the owner enables. Receiving goods, return postage and refunds remain separate jobs.',rows:rows.slice(0,100).map(row=>({Customer:row.sender,Subject:row.subject,RMA:row.return_number||'Not created',Review:row.problem||'',link:'/mail/'+row.id+'/return'})),more:rows.length>100};
}
module.exports={preview,create,configure,teach,onArrival,saved,bound,page,definition:{id:111,key:'customer-return-emails',label:'Create RMA requests from customer emails',filterLabel:'Exact customer email',readPage}};
