'use strict';
const source=require('./supplier-rfq-source'),{hash}=require('../pricing/postgres-promotions'),policy=require('../commercial/agent-plan');
const {ValidationError,NotFoundError}=require('../domain/errors'),{newId}=require('../lib/util');
const kind='supplier_rfq',action='supplier.request_quotes',jobKind='agent.mail.supplier_rfq.v1';
async function request(c,ctx,id,lock=false){
 const r=(await c.query('SELECT * FROM stockchief_runtime.agent_rfq_requests WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
 if(!r)throw new NotFoundError('That supplier quote request is not in this inventory.');
 const {sourceFingerprint,...facts}=r.snapshot;if(sourceFingerprint!==r.source_fingerprint||hash(facts)!==sourceFingerprint)throw new ValidationError('This RFQ no longer matches its reviewed source. Prepare a fresh request.');return r;
}
async function current(c,ctx,r,{readOnly=false}={}){
 const p=r.snapshot,clock=await require('../lib/business-time').forWorkspace(c,ctx.workspaceId),age=Date.parse(clock.instant)-Date.parse(p.preparedAt);
 if(!Number.isFinite(age)||age<0||age>86400000)throw new ValidationError('This RFQ is older than 24 hours. Prepare a current request before sending.');
 const fresh=await source.snapshot(c,ctx,p,{readOnly});if(hash(source.profile(fresh))!==hash(source.profile(p)))throw new ValidationError('A supplier, recipient, product, pack, mailbox or business time zone changed. Review a fresh quote request.');return p;
}
async function preview(db,ctx,input){
 const normalized=source.input(input),inputHash=hash(normalized);await source.access(db,ctx);
 const prior=(await db.query('SELECT id,input_hash FROM stockchief_runtime.agent_rfq_requests WHERE workspace_id=$1 AND request_key=$2',[ctx.workspaceId,normalized.requestKey])).rows[0];
 if(prior){if(prior.input_hash!==inputHash)throw new ValidationError('This RFQ reference was already used with different products or recipients. Open a new form.');return request(db,ctx,prior.id);}
 const p=await source.snapshot(db,ctx,normalized);for(const s of p.suppliers)source.compose(p,s.id);
 return db.transaction(async c=>{
  await source.access(c,ctx);const id=newId('rfq');
  const inserted=await c.query(`INSERT INTO stockchief_runtime.agent_rfq_requests(id,workspace_id,request_key,input_hash,snapshot,source_fingerprint,prepared_by)
   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,request_key) DO NOTHING RETURNING id,input_hash`,[id,ctx.workspaceId,p.requestKey,inputHash,JSON.stringify(p),p.sourceFingerprint,ctx.actorId]);
  const row=inserted.rows[0]||(await c.query('SELECT id,input_hash FROM stockchief_runtime.agent_rfq_requests WHERE workspace_id=$1 AND request_key=$2',[ctx.workspaceId,p.requestKey])).rows[0];
  if(row.input_hash!==inputHash)throw new ValidationError('This RFQ reference already identifies a different request.');return request(c,ctx,row.id);
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function rule(c,ctx,id,lock=false){
 const r=(await c.query('SELECT * FROM stockchief_runtime.agent_rfq_rules WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];if(!r)throw new NotFoundError('That RFQ rule is not in this inventory.');return r;
}
async function completedExample(c,ctx,id){
 const r=await request(c,ctx,id),n=(await c.query(`SELECT count(*)::int n FROM stockchief_runtime.agent_rfq_deliveries d
  JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id
  WHERE d.workspace_id=$1 AND d.request_id=$2 AND NOT d.automatic AND d.approved_by=$3 AND m.status='SENT' AND nullif(m.external_message_id,'') IS NOT NULL`,[ctx.workspaceId,id,ctx.actorId])).rows[0].n;
 if(r.reviewed_by!==ctx.actorId||n!==r.snapshot.suppliers.length)throw new ValidationError('On Pro, first individually approve and finish sending the exact matching RFQ to every selected supplier.');return r;
}
async function configure(db,ctx,id,input){return db.transaction(async c=>{
 await source.owner(c,ctx);
 const existing=input.ruleId?await rule(c,ctx,input.ruleId,true):null;
 if(existing&&existing.revision!==Number(input.revision))throw new ValidationError('Reload the current RFQ authority before changing it.');
 if(input.stop==='yes'){
  if(!existing)throw new ValidationError('Choose the current RFQ rule to stop.');await c.query('UPDATE stockchief_runtime.agent_rfq_rules SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,existing.id]);return {id:existing.id};
 }
 const r=await request(c,ctx,id),p=await current(c,ctx,r),account=await policy.accountState(c,ctx.workspaceId);let example=null;
 if(account.plan==='pro')example=await completedExample(c,ctx,input.exampleId||id);
 await source.access(c,ctx,{automatic:true,trained:Boolean(example)});
 if(example&&hash(source.profile(example.snapshot))!==hash(source.profile(p)))throw new ValidationError('The completed example must use these exact suppliers, products, packs and sending mailbox.');
 const maximum=String(input.maxRequestsPerWeek||'');if(input.confirmed!=='yes'||!/^\d{1,2}$/.test(maximum)||Number(maximum)<1||Number(maximum)>20)throw new ValidationError('Confirm the exact RFQ scope and a limit from one to twenty requests per rolling seven days.');
 if(example&&p.lines.some(l=>l.quantity>example.snapshot.lines.find(e=>e.skuId===l.skuId).quantity))throw new ValidationError('Pro cannot exceed a product quantity in the completed manual example.');
 await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],existing?.enabled?0:1);
 const scope={profile:source.profile(p),maxima:p.lines},profileHash=hash(scope.profile),newRuleId=existing?.id||newId('rfq-rule');
 try{
  if(existing)await c.query('UPDATE stockchief_runtime.agent_rfq_rules SET scope=$3,profile_hash=$4,max_requests_per_week=$5,authorized_by=$6,example_id=$7,enabled=true,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,newRuleId,JSON.stringify(scope),profileHash,Number(maximum),ctx.actorId,example?.id||null]);
  else await c.query(`INSERT INTO stockchief_runtime.agent_rfq_rules(id,workspace_id,scope,profile_hash,max_requests_per_week,authorized_by,example_id)
   VALUES($1,$2,$3,$4,$5,$6,$7)`,[newRuleId,ctx.workspaceId,JSON.stringify(scope),profileHash,Number(maximum),ctx.actorId,example?.id||null]);
 }catch(error){if(error.code==='23505')throw new ValidationError('An active rule already covers these suppliers, products and mailbox. Review and update that existing rule instead of creating a duplicate.');throw error;}
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Routine supplier RFQ scope authorized',reference:newRuleId,after:{scope,maxRequestsPerWeek:Number(maximum),exampleId:example?.id||null,purchaseAuthority:false}});return {id:newRuleId};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function authority(c,workspaceId,grant){
 const ctx={workspaceId,actorId:grant.actorId},r=await request(c,ctx,grant.requestId),p=r.snapshot;
 if(grant.kind!==kind||grant.sourceFingerprint!==r.source_fingerprint||r.prepared_by!==ctx.actorId||!p.supplierIds.includes(grant.supplierId))throw new ValidationError('Approve this exact supplier RFQ and recipient before sending.');
 if(grant.automatic){
  const saved=await rule(c,ctx,grant.ruleId);await source.access(c,ctx,{automatic:true,trained:Boolean(saved.example_id)});
  await source.knownPartners(c,ctx,p);
  if(!saved.enabled||saved.authorized_by!==ctx.actorId||saved.revision!==grant.ruleRevision||saved.profile_hash!==hash(source.profile(p))||p.lines.some(l=>{const max=saved.scope.maxima.find(x=>x.skuId===l.skuId);return !max||l.quantity>max.quantity;}))throw new ValidationError('The RFQ exceeds the owner’s current supplier, product or quantity authority.');
  const state=await policy.accountState(c,workspaceId);if(state.plan==='pro'){
   const example=await completedExample(c,ctx,saved.example_id);if(hash(source.profile(example.snapshot))!==saved.profile_hash||p.lines.some(l=>l.quantity>example.snapshot.lines.find(e=>e.skuId===l.skuId)?.quantity))throw new ValidationError('This RFQ no longer fits a completed Pro example.');
  }
 }else{
  await source.access(c,ctx);if(grant.manualApproval!==true||r.reviewed_by!==ctx.actorId||!r.reviewed_at)throw new ValidationError('Individually review and approve the exact RFQ emails before sending.');
 }
 await current(c,ctx,r);
 const queued=(await c.query(`SELECT m.recipient,m.connector_id,m.subject,m.body FROM stockchief_runtime.agent_rfq_deliveries d
  JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id WHERE d.workspace_id=$1 AND d.request_id=$2 AND d.supplier_id=$3`,[workspaceId,r.id,grant.supplierId])).rows[0],words=source.compose(p,grant.supplierId),supplier=p.suppliers.find(s=>s.id===grant.supplierId);
 if(queued&&(queued.recipient!==supplier.email||queued.connector_id!==p.connectorId||queued.subject!==words.subject||queued.body!==words.body))throw new ValidationError('The queued RFQ no longer matches its exact reviewed text and recipient.');return r;
}
async function deliveryAuthority(...args){try{return await authority(...args);}catch(error){
 if([400,402,403,404,422].includes(error.status)){error.code='rfq_needs_review';error.retryable=false;}throw error;
}}
async function queue(c,ctx,r,{savedRule=null}={}){
 const p=r.snapshot,automatic=Boolean(savedRule);
 if(savedRule){
  const usage=(await c.query('SELECT count(DISTINCT request_id)::int n FROM stockchief_runtime.agent_rfq_deliveries WHERE workspace_id=$1 AND rule_id=$2 AND automatic AND created_at>=now()-interval \'168 hours\' AND request_id<>$3',[ctx.workspaceId,savedRule.id,r.id])).rows[0].n;
  if(usage>=savedRule.max_requests_per_week)throw new ValidationError('This rule reached its rolling seven-day RFQ limit. Review the supplier requests before authorizing another.');
 }
 const grantFor=supplierId=>({kind,actorId:ctx.actorId,requestId:r.id,supplierId,sourceFingerprint:r.source_fingerprint,automatic,manualApproval:!automatic,...(savedRule?{ruleId:savedRule.id,ruleRevision:savedRule.revision}:{})});
 // All recipients and facts share the same serializable preparation snapshot.
 // Provider delivery always calls authority afresh for its individual recipient.
 await authority(c,ctx.workspaceId,grantFor(p.suppliers[0].id));
 const deliveries=[];
 for(const s of p.suppliers){
  const grant=grantFor(s.id);
  const existing=(await c.query(`SELECT d.id,d.communication_id,d.automatic,m.status,e.id effect_id,e.status effect_status,e.error_code,e.provider_reference,e.payload
   FROM stockchief_runtime.agent_rfq_deliveries d JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id
   JOIN stockchief_runtime.provider_effects e ON e.workspace_id=d.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send'
   WHERE d.workspace_id=$1 AND d.request_id=$2 AND d.supplier_id=$3 ORDER BY e.created_at DESC,e.id DESC LIMIT 1 FOR UPDATE OF d,m,e`,[ctx.workspaceId,r.id,s.id])).rows[0];
  let key='supplier-rfq:'+r.id+':'+s.id;
  if(existing){
   if(existing.status==='SENT'||existing.effect_status==='SUCCEEDED'||existing.effect_status==='RUNNING'||existing.effect_status==='PENDING'&&(!existing.automatic||automatic&&!existing.error_code&&existing.payload?.standingAuthority?.ruleId===savedRule.id&&existing.payload?.standingAuthority?.ruleRevision===savedRule.revision)){deliveries.push({communicationId:existing.communication_id,replayed:true});continue;}
   if(automatic)throw new ValidationError('A previous send of this RFQ needs an individual review. Automatic work cannot reset its delivery outcome.');
   const replace=existing.effect_status==='PENDING'||existing.effect_status==='FAILED'&&existing.error_code==='rfq_needs_review';
   if(!replace||Object.keys(existing.provider_reference||{}).length)throw new ValidationError('The earlier mailbox outcome needs review. Check the mailbox Sent folder; an uncertain or provider-attempted message is never resent automatically.');
   if(existing.effect_status==='PENDING')await c.query("UPDATE stockchief_runtime.provider_effects SET status='CANCELLED',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status='PENDING'",[ctx.workspaceId,existing.effect_id]);
   await c.query("UPDATE supplier_communications SET status='FAILED',error_message='Replaced by an exact individually reviewed RFQ before provider delivery.',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status<>'SENT'",[ctx.workspaceId,existing.communication_id]);
   key+=':review:'+newId('rfq-review');
  }
  const result=await require('../connections/postgres-outbound-mail').queueInTransaction(c,ctx,{recipientKind:'supplier',recipientId:s.id,recipientEmail:s.email,connectorId:p.connectorId,...source.compose(p,s.id),standingAuthority:grant},key,{agentRequested:true,agentJob:93});
  if(existing)await c.query('UPDATE stockchief_runtime.agent_rfq_deliveries SET communication_id=$3,automatic=false,rule_id=NULL,rule_revision=NULL,approved_by=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,existing.id,result.communicationId,ctx.actorId]);
  else await c.query(`INSERT INTO stockchief_runtime.agent_rfq_deliveries(id,workspace_id,request_id,supplier_id,communication_id,automatic,rule_id,rule_revision,approved_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[newId('rfq-send'),ctx.workspaceId,r.id,s.id,result.communicationId,automatic,savedRule?.id||null,savedRule?.revision||null,ctx.actorId]);deliveries.push(result);
 }
 return {requestId:r.id,deliveries};
}
async function send(db,ctx,id,input){return db.transaction(async c=>{
 await source.access(c,ctx);const r=await request(c,ctx,id,true);await current(c,ctx,r);
 if(input.confirmed!=='yes'||input.sourceFingerprint!==r.source_fingerprint)throw new ValidationError('Review every exact supplier, recipient, product, quantity and RFQ email before sending.');
 await c.query('UPDATE stockchief_runtime.agent_rfq_requests SET reviewed_by=$3,reviewed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,ctx.actorId]);return queue(c,ctx,{...r,reviewed_by:ctx.actorId,reviewed_at:new Date().toISOString()});
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function sendAutomatic(db,ctx,id,ruleId){return db.transaction(async c=>{
 const r=await request(c,ctx,id,true),saved=await rule(c,ctx,ruleId,true);return queue(c,ctx,r,{savedRule:saved});
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function fromForm(db,ctx,input){
 const names=String(input.supplierNames||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean),lines=String(input.productRows||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(row=>row.split('\t').map(v=>v.trim()));
 if(names.length<2||names.length>20||new Set(names.map(s=>s.toLowerCase())).size!==names.length||lines.length<1||lines.length>100||lines.some(r=>r.length!==2))throw new ValidationError('Enter two to twenty exact supplier names, one per line. Paste one to 100 SKU codes and quantities as two spreadsheet columns.');
 const suppliers=(await db.query('SELECT id,name FROM suppliers WHERE workspace_id=$1 AND lower(name)=ANY($2::text[]) AND status=\'active\' ORDER BY id',[ctx.workspaceId,names.map(s=>s.toLowerCase())])).rows;
 const products=(await db.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND code=ANY($2::text[]) AND is_active=1',[ctx.workspaceId,lines.map(r=>r[0])])).rows;
 if(suppliers.length!==names.length||products.length!==lines.length)throw new ValidationError('Match every supplier name and SKU code to an active record in this inventory.');
 return {...input,supplierIds:suppliers.map(s=>s.id),lines:lines.map(([code,quantity])=>({skuId:products.find(p=>p.code===code).id,quantity}))};
}
async function page(db,ctx,{id=null,page=1}={}){
 await source.owner(db,ctx,{lock:false});const state=await policy.accountState(db,ctx.workspaceId),locked=!policy.usesAgentTerms(state)||!policy.permits(state.plan,93,'draft');page=Number(page);
 if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid quote-request page.');
 const requests=(await db.query(`SELECT id,snapshot->>'reference' reference,created_at FROM stockchief_runtime.agent_rfq_requests WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 101 OFFSET $2`,[ctx.workspaceId,(page-1)*100])).rows;
 const rules=(await db.query(`SELECT r.*,(SELECT count(DISTINCT request_id)::int FROM stockchief_runtime.agent_rfq_deliveries d WHERE d.workspace_id=r.workspace_id AND d.rule_id=r.id AND d.automatic AND d.created_at>=now()-interval '168 hours') used FROM stockchief_runtime.agent_rfq_rules r WHERE r.workspace_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,[ctx.workspaceId])).rows;
 const saved=id&&!locked?await request(db,ctx,id):null,deliveries=saved?(await db.query(`SELECT d.*,s.name,m.recipient,m.subject,m.body,m.status,m.external_message_id,m.error_message,e.status effect_status,e.error_code,e.error_message effect_error
  FROM stockchief_runtime.agent_rfq_deliveries d JOIN suppliers s ON s.workspace_id=d.workspace_id AND s.id=d.supplier_id
  JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id
  LEFT JOIN LATERAL(SELECT status,error_code,error_message FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=d.workspace_id AND e.aggregate_type='supplier_communication' AND e.aggregate_id=d.communication_id AND e.kind='mail.outbound.send' ORDER BY created_at DESC,id DESC LIMIT 1)e ON true
  WHERE d.workspace_id=$1 AND d.request_id=$2 ORDER BY s.name,s.id`,[ctx.workspaceId,saved.id])).rows:[];
 let problem=null;if(saved)try{if(saved.prepared_by!==ctx.actorId)throw new ValidationError('Prepare a fresh RFQ under the current owner before sending.');await current(db,ctx,saved,{readOnly:true});}catch(error){if(![400,402,403,404,422].includes(error.status))throw error;problem=error.message;}
 const routineReady=!locked&&!state.shadow&&(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate;
 const eligibleRules=rules.filter(r=>r.enabled&&r.authorized_by===ctx.actorId&&policy.permits(state.plan,93,'automatic',{trained:Boolean(r.example_id)})&&r.used<r.max_requests_per_week&&(!saved||r.profile_hash===hash(source.profile(saved.snapshot))&&saved.snapshot.lines.every(l=>r.scope.maxima.some(m=>m.skuId===l.skuId&&l.quantity<=m.quantity))));
 const matchingRule=saved?rules.find(r=>r.enabled&&r.profile_hash===hash(source.profile(saved.snapshot))):null;
 const trainingExampleId=matchingRule?.example_id||saved?.id,manualExampleReady=Boolean(matchingRule?.example_id&&matchingRule.authorized_by===ctx.actorId||saved?.reviewed_by===ctx.actorId&&deliveries.length===saved.snapshot.suppliers.length&&deliveries.every(d=>!d.automatic&&d.status==='SENT'&&d.external_message_id));
 return {locked,plan:state.plan,shadow:state.shadow,matchingRule,trainingExampleId,manualExampleReady,problem,routineReady,eligibleRules,requests:requests.slice(0,100),more:requests.length>100,page,rules,saved,deliveries,mailboxes:locked?[]:await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId),requestKey:newId('rfq-preview'),words:saved?saved.snapshot.suppliers.map(s=>({...s,...source.compose(saved.snapshot,s.id)})):[]};
}
const definition={id:93,key:'supplier-rfqs',label:'Ask several known suppliers for quotations',readPage:async()=>({summary:'Prepare exact RFQs for two to twenty known suppliers and up to 100 whole-unit products. Pro learns from one completed manual batch; Custom can use an explicit bounded scope without training. First new supplier requests still need approval. RFQs never place orders or accept terms.',rows:[{Action:'Prepare supplier quote requests',link:'/autopilot/supplier-rfqs'}],more:false})};
async function inbox(db,workspaceId,actorId){
 const rows=(await db.query(`SELECT r.id,r.snapshot->>'reference' reference,r.created_at,count(*)::int affected,bool_or(e.status='AMBIGUOUS') uncertain
  FROM stockchief_runtime.agent_rfq_deliveries d JOIN stockchief_runtime.agent_rfq_requests r ON r.workspace_id=d.workspace_id AND r.id=d.request_id
  JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id
  JOIN LATERAL(SELECT status,error_code FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=d.workspace_id AND e.aggregate_type='supplier_communication' AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' ORDER BY e.created_at DESC,e.id DESC LIMIT 1)e ON true
  WHERE d.workspace_id=$1 AND (m.status='FAILED' OR e.status='AMBIGUOUS' OR e.status='PENDING' AND e.error_code IS NOT NULL)
  GROUP BY r.id,r.snapshot->>'reference',r.created_at ORDER BY r.created_at,r.id LIMIT 50`,[workspaceId])).rows;
 if(!rows.length)return [];await source.owner(db,{workspaceId,actorId},{lock:false});
 return rows.map(r=>({kind:'purchasing',importance:'Needs You',priority:r.uncertain?90:75,title:'Review supplier RFQ: '+r.reference,happened:r.affected+' supplier message'+(r.affected===1?' needs':'s need')+' review.',why:r.uncertain?'Mailbox acceptance is uncertain. Check the Sent folder before any further action.':'A current supplier, mailbox, authority or plan check stopped delivery.',recommendation:'Open the exact RFQ and its per-supplier delivery results. Confirmed sent messages are kept; uncertain outcomes are never resent automatically.',href:'/autopilot/supplier-rfqs/'+r.id,actionLabel:'Review RFQ delivery',sourceId:'supplier-rfq:'+r.id,at:r.created_at,createdAt:r.created_at}));
}
module.exports={preview,request,current,configure,send,sendAutomatic,authority,deliveryAuthority,rule,kind,action,jobKind,fromForm,page,inbox,definition};
