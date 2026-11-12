'use strict';
const source=require('./supplier-claim-source'),photos=require('../operations/quality-photos'),policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions');
const {ValidationError,NotFoundError}=require('../domain/errors'),{newId}=require('../lib/util'),followUp=require('./supplier-claim-follow-through');
const kind='supplier_claim',action='supplier.open_damage_claim';
async function claim(c,ctx,id,lock=false){
 const r=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_claims WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
 if(!r)throw new NotFoundError('That supplier claim is not in this inventory.');
 const {sourceFingerprint,ageDays,...p}=r.snapshot;if(sourceFingerprint!==r.source_fingerprint||hash(p)!==sourceFingerprint)throw new ValidationError('This claim no longer matches its recorded evidence. Review the physical inspection again.');return r;
}
async function current(c,ctx,r,{readOnly=false,automatic=false}={}){
 const p=r.snapshot,fresh=await source.facts(c,ctx,{holdId:p.holdId,comparisonId:p.comparisonId,lineId:p.lineId,reportId:p.reportId,
  connectorId:p.connectorId,photoIds:p.photos.map(x=>x.id),reference:p.reference,remedy:p.remedy},{readOnly,automatic});
 if(hash(source.stable(fresh))!==hash(source.stable(p)))throw new ValidationError('The inspection, supplier, price, mailbox or photo evidence changed. Prepare and review a current claim before sending.');return fresh;
}
// Every new claim states what it asks for. Only the routine, applying a rule
// authorized before that choice existed, may prepare a claim without one.
async function preview(db,ctx,input,{legacyRemedy=false}={}){return db.transaction(async c=>{
 const ids=input.photoIds===undefined?[]:Array.isArray(input.photoIds)?input.photoIds:[input.photoIds];await source.access(c,ctx,{withPhotos:ids.length>0});
 if(!input.remedy&&!legacyRemedy)throw new ValidationError('Choose what to ask the supplier for: a credit note, replacement goods or a refund.');
 const shortage=Boolean(input.comparisonId),report=!shortage&&Boolean(input.reportId);
 if(shortage&&(!input.lineId||input.holdId||input.reportId||input.shortageConfirmed!=='yes'))
  throw new ValidationError('Confirm these goods were due in this delivery and the exact missing quantity is a shortage.');
 if(report&&input.holdId)throw new ValidationError('Prepare one claim from one piece of delivery evidence.');
 if(!shortage&&!report&&!input.holdId)throw new ValidationError('Choose the checked delivery, failed inspection or staff damage report this claim is for.');
 const sourceId=shortage?input.lineId:report?input.reportId:input.holdId;
 if(shortage||report)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['supplier-'+(shortage?'shortage':'report')+':'+ctx.workspaceId+':'+sourceId]);
 const sourceColumn=shortage?'purchase_order_line_id':report?'damage_report_id':'hold_id';
 const prior=(await c.query(`SELECT id FROM stockchief_runtime.agent_supplier_claims WHERE workspace_id=$1 AND ${sourceColumn}=$2 FOR UPDATE`,[ctx.workspaceId,sourceId])).rows[0];
 const id=prior?.id||newId('claim'),r=prior?await claim(c,ctx,id):null,reference=r?.reference||'CLM-'+id.slice(-10).toUpperCase();
 if(r?.communication_id)throw new ValidationError('This physical delivery already has a queued or sent claim. Review that case before taking further action.');
 const p=await source.facts(c,ctx,{...input,photoIds:ids,reference});source.compose(p);
 if(shortage){
  if(r&&hash(source.stable(r.snapshot))===hash(source.stable(p))&&r.prepared_by===ctx.actorId)return r;
  const serialized=JSON.stringify(p);
  await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'shortage-claim:'+id+':'+p.sourceFingerprint,Buffer.byteLength(serialized)+4096,{finished:true});
  if(r)await c.query(`UPDATE stockchief_runtime.agent_supplier_claims SET snapshot=$3,source_fingerprint=$4,prepared_by=$5,
    reviewed_by=NULL,reviewed_at=NULL,delivery_comparison_id=$6 WHERE workspace_id=$1 AND id=$2`,
  [ctx.workspaceId,id,serialized,p.sourceFingerprint,ctx.actorId,p.comparisonId]);
  else await c.query(`INSERT INTO stockchief_runtime.agent_supplier_claims(id,workspace_id,delivery_comparison_id,
    purchase_order_line_id,reference,prepared_by,snapshot,source_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
  [id,ctx.workspaceId,p.comparisonId,p.lineId,reference,ctx.actorId,serialized,p.sourceFingerprint]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Confirmed supplier shortage recorded',reference,
    after:{comparisonId:p.comparisonId,purchaseOrderId:p.purchaseOrderId,lineId:p.lineId,missingUnits:p.missingUnits,missingWeight:p.missingWeight}});
 }else if(r)await c.query('UPDATE stockchief_runtime.agent_supplier_claims SET snapshot=$3,source_fingerprint=$4,prepared_by=$5,reviewed_by=NULL,reviewed_at=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,JSON.stringify(p),p.sourceFingerprint,ctx.actorId]);
 else if(report){
  await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'report-claim:'+id,Buffer.byteLength(JSON.stringify(p))+4096,{finished:true});
  await c.query(`INSERT INTO stockchief_runtime.agent_supplier_claims(id,workspace_id,damage_report_id,reference,prepared_by,snapshot,source_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,ctx.workspaceId,p.reportId,reference,ctx.actorId,JSON.stringify(p),p.sourceFingerprint]);
 }else await c.query(`INSERT INTO stockchief_runtime.agent_supplier_claims(id,workspace_id,hold_id,reference,prepared_by,snapshot,source_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,ctx.workspaceId,p.holdId,reference,ctx.actorId,JSON.stringify(p),p.sourceFingerprint]);
 if(!r&&!shortage)await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier claim prepared for review',reference,
  after:{claimId:id,source:shortage?'delivery check':report?'staff damage report':'failed inspection',remedy:p.remedy||null,totalMinor:p.totalMinor,currency:p.currency}});
 return claim(c,ctx,id);
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function rule(c,ctx,id,lock=false){const r=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_claim_rules WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];if(!r)throw new NotFoundError('That claim rule is not in this inventory.');return r;}
async function example(c,ctx,id){
 const r=await claim(c,ctx,id),m=r.communication_id&&(await c.query("SELECT id FROM supplier_communications WHERE workspace_id=$1 AND id=$2 AND status='SENT' AND nullif(external_message_id,'') IS NOT NULL",[ctx.workspaceId,r.communication_id])).rows[0];
 if(r.automatic||r.reviewed_by!==ctx.actorId||!r.reviewed_at||!m)throw new ValidationError('On Pro, first individually approve a matching supplier claim and finish sending it through the connected mailbox.');return r;
}
function fits(p,r){return r.profile_hash===hash(source.profile(p))&&Number(source.units(p))<=Number(r.scope.maxShortUnits??r.max_units)&&
 (p.missingWeight==null||Number(p.missingWeight)<=Number(r.scope.maxShortWeight))&&
 BigInt(p.totalMinor)<=BigInt(r.max_value_minor)&&p.ageDays<=r.max_age_days&&(!p.photos.length||r.include_photos);}
async function configure(db,ctx,id,input){return db.transaction(async c=>{
 await source.owner(c,ctx);const existing=input.ruleId?await rule(c,ctx,input.ruleId,true):null;
 if(existing&&existing.revision!==Number(input.revision))throw new ValidationError('Reload the current claim authority before changing it.');
 if(input.stop==='yes'){if(!existing)throw new ValidationError('Choose the claim rule to stop.');await c.query('UPDATE stockchief_runtime.agent_supplier_claim_rules SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,existing.id]);return {id:existing.id};}
 const r=await claim(c,ctx,id),p=await current(c,ctx,r),state=await policy.accountState(c,ctx.workspaceId),done=state.plan==='pro'?await example(c,ctx,input.exampleId||id):null;
 if(existing&&(existing.supplier_id!==p.supplierId||existing.sku_id!==p.skuId||existing.location_id!==p.locationId||existing.connector_id!==p.connectorId||(existing.scope.claimKind==='shortage')!==(p.claimKind==='shortage')))throw new ValidationError('A claim rule keeps its exact supplier, product, location, claim type and mailbox. Stop it and authorize a new scope for different records.');
 if(!p.remedy)throw new ValidationError('Choose what this claim asks the supplier for, then authorize routine claims from it.');
 const shortage=p.claimKind==='shortage',includePhotos=input.includePhotos==='yes',chaseAfterDays=followUp.chaseDays(input.chaseAfterDays);
 await source.access(c,ctx,{automatic:true,trained:Boolean(done),withPhotos:includePhotos});
 const integer=(value,min,max,label)=>{const text=String(value||'');if(!/^\d+$/.test(text)||!Number.isSafeInteger(Number(text))||Number(text)<min||Number(text)>max)throw new ValidationError('Choose '+label+' from '+min+' to '+max+'.');return Number(text);};
 const exact=require('../domain/exact-quantity');
 const maxUnits=shortage?exact.safeNumber(input.maxUnits,{precision:p.quantityPrecision,positive:p.missingWeight===null}):
  integer(input.maxUnits,1,100000,'a damaged-unit limit');
 const maxWeight=p.missingWeight==null?null:exact.safeNumber(input.maxWeight,{precision:p.weightPrecision,positive:true,label:'Maximum missing weight'});
 if(maxUnits>100000)throw new ValidationError('Enter a claim quantity limit up to 100,000 units.');
 const maxAgeDays=integer(input.maxAgeDays,1,365,'a delivery age in days'),money=require('../domain/currency');
 const maxValue=money.userToMinor(String(input.maxValue||''),p.currency,{label:'Per-claim goods cost limit'}),maxWeekly=money.userToMinor(String(input.maxWeekly||''),p.currency,{label:'Rolling seven-day goods cost limit'});
 if(input.confirmed!=='yes'||BigInt(maxValue)<=0||BigInt(maxWeekly)<BigInt(maxValue))throw new ValidationError('Confirm this exact scope, a positive per-claim limit and a rolling seven-day limit at least as large.');
 if(done&&(hash(source.profile(done.snapshot))!==hash(source.profile(p))||maxUnits>Number(source.units(done.snapshot))||
  maxWeight!==null&&maxWeight>Number(done.snapshot.missingWeight)||BigInt(maxValue)>BigInt(done.snapshot.totalMinor)||includePhotos&&!done.snapshot.photos.length))throw new ValidationError('Pro authority must fit the supplier, product, location, mailbox, quantity, weight, goods value and photo handling proven in the completed manual example.');
 await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],existing?.enabled?0:1);
 const rid=existing?.id||newId('claim-rule'),profile=source.profile(p),scope={...(shortage?{...profile,maxShortUnits:maxUnits,maxShortWeight:maxWeight}:profile),chaseAfterDays};
 const values=[ctx.workspaceId,rid,JSON.stringify(scope),hash(profile),Math.max(1,Math.ceil(maxUnits)),maxValue,maxWeekly,maxAgeDays,includePhotos,done?.id||null,ctx.actorId];
 try{if(existing)await c.query('UPDATE stockchief_runtime.agent_supplier_claim_rules SET scope=$3,profile_hash=$4,max_units=$5,max_value_minor=$6,max_weekly_minor=$7,max_age_days=$8,include_photos=$9,example_id=$10,authorized_by=$11,enabled=true,revision=revision+1 WHERE workspace_id=$1 AND id=$2',values);
 else await c.query(`INSERT INTO stockchief_runtime.agent_supplier_claim_rules(workspace_id,id,scope,profile_hash,max_units,max_value_minor,max_weekly_minor,max_age_days,include_photos,example_id,authorized_by,supplier_id,sku_id,location_id,connector_id,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[...values,p.supplierId,p.skuId,p.locationId,p.connectorId,p.currency]);}catch(e){if(e.code==='23505')throw new ValidationError('An active rule already covers this supplier, product and location. Update that rule.');throw e;}
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Bounded supplier damage claim authority recorded',reference:rid,after:{profile:source.profile(p),remedy:p.remedy,maxUnits,maxValue,maxWeekly,maxAgeDays,includePhotos,chaseAfterDays,exampleId:done?.id||null,settlementAuthority:false}});return {id:rid};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function authority(c,workspaceId,g){
 if(g.chaseId)return followUp.chaseAuthority(c,workspaceId,g);
 const ctx={workspaceId,actorId:g.actorId},r=await claim(c,ctx,g.claimId),p=r.snapshot;
 if(g.kind!==kind||g.sourceFingerprint!==r.source_fingerprint||r.prepared_by!==ctx.actorId)throw new ValidationError('Review this exact supplier claim under the current inventory owner.');
 let saved=null;if(g.automatic){saved=await rule(c,ctx,g.ruleId);await source.access(c,ctx,{automatic:true,trained:Boolean(saved.example_id),withPhotos:p.photos.length>0});
  const fresh=await current(c,ctx,r,{automatic:true});if(!saved.enabled||saved.authorized_by!==ctx.actorId||saved.revision!==g.ruleRevision||!fits(fresh,saved))throw new ValidationError('The claim exceeds current owner authority, goods value, quantity, receipt age or photo scope.');
  if((await policy.accountState(c,workspaceId)).plan==='pro'){const done=await example(c,ctx,saved.example_id);if(hash(source.profile(done.snapshot))!==saved.profile_hash||Number(source.units(p))>Number(source.units(done.snapshot))||
   p.missingWeight!=null&&Number(p.missingWeight)>Number(done.snapshot.missingWeight)||BigInt(p.totalMinor)>BigInt(done.snapshot.totalMinor)||p.photos.length&&!done.snapshot.photos.length)throw new ValidationError('This claim does not fit the completed Pro example.');}
  const used=(await c.query(`SELECT coalesce(sum((snapshot->>'totalMinor')::numeric),0)::text total FROM stockchief_runtime.agent_supplier_claims WHERE workspace_id=$1 AND rule_id=$2 AND automatic AND automatic_reserved_at>=now()-interval '168 hours' AND id<>$3`,[workspaceId,saved.id,r.id])).rows[0].total;
  if(BigInt(used)+BigInt(p.totalMinor)>BigInt(saved.max_weekly_minor))throw new ValidationError('The rule reached its rolling seven-day claim goods value limit.');
 }else{await source.access(c,ctx,{withPhotos:p.photos.length>0});if(g.manualApproval!==true||r.reviewed_by!==ctx.actorId||!r.reviewed_at)throw new ValidationError('Individually approve the exact supplier, claim quantity, goods value, text and supporting evidence.');await current(c,ctx,r);}
 if(r.communication_id){const m=(await c.query('SELECT recipient,connector_id,subject,body FROM supplier_communications WHERE workspace_id=$1 AND id=$2',[workspaceId,r.communication_id])).rows[0],words=source.compose(p);if(!m||m.recipient!==p.recipient||m.connector_id!==p.connectorId||m.subject!==words.subject||m.body!==words.body)throw new ValidationError('The queued claim no longer matches its reviewed text and recipient.');}
 return r;
}
async function deliveryAuthority(...args){try{return await authority(...args);}catch(e){if([400,402,403,404,422].includes(e.status)){e.code='claim_needs_review';e.retryable=false;}throw e;}}
async function attachments(db,workspaceId,g){const r=await deliveryAuthority(db,workspaceId,g),out=[];if(g.chaseId)return out;for(const ref of r.snapshot.photos){const p=await photos.load(db,{workspaceId,actorId:g.actorId},ref.id,{email:true});if(p.content_hash!==ref.originalHash||p.email_hash!==ref.emailHash)throw new ValidationError('The photo copy needs an evidence integrity review.');out.push({filename:ref.filename,contentType:'image/jpeg',content:p.bytes});}return out;}
async function queue(c,ctx,r,saved=null,{chaseAfterDays=null}={}){
 const p=r.snapshot,g={kind,actorId:ctx.actorId,claimId:r.id,sourceFingerprint:r.source_fingerprint,automatic:Boolean(saved),manualApproval:!saved,...(saved?{ruleId:saved.id,ruleRevision:saved.revision}:{})};
 await authority(c,ctx.workspaceId,g);let key='supplier-claim:'+r.id;
 if(r.communication_id){const e=(await c.query(`SELECT m.status,e.id,e.status effect_status,e.error_code,e.provider_reference FROM supplier_communications m JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' WHERE m.workspace_id=$1 AND m.id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT 1 FOR UPDATE OF m,e`,[ctx.workspaceId,r.communication_id])).rows[0];
  if(e&&(e.status==='SENT'||e.effect_status==='SUCCEEDED'||e.effect_status==='RUNNING'))return {claimId:r.id,communicationId:r.communication_id,replayed:true};
  if(e?.effect_status==='PENDING'&&r.automatic===Boolean(saved)&&(!saved||r.rule_id===saved.id&&r.rule_revision===saved.revision)&&!e.error_code)return {claimId:r.id,communicationId:r.communication_id,replayed:true};
  if(saved||!e||!(e.effect_status==='PENDING'||e.effect_status==='FAILED'&&e.error_code==='claim_needs_review')||Object.keys(e.provider_reference||{}).length)throw new ValidationError('Review the earlier mailbox outcome before sending anything further. Uncertain or provider-attempted claims are never resent automatically.');
  if(e.effect_status==='PENDING')await c.query("UPDATE stockchief_runtime.provider_effects SET status='CANCELLED',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,e.id]);
  await c.query("UPDATE supplier_communications SET status='FAILED',error_message='Replaced after exact individual review before provider delivery.',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,r.communication_id]);key+=':review:'+newId('review');
 }
 const result=await require('../connections/postgres-outbound-mail').queueInTransaction(c,ctx,{recipientKind:'supplier',recipientId:p.supplierId,recipientEmail:p.recipient,connectorId:p.connectorId,...source.compose(p),standingAuthority:g},key,{agentRequested:true,agentJob:45});
 await c.query('UPDATE stockchief_runtime.agent_supplier_claims SET communication_id=$3,automatic=$4,rule_id=$5,rule_revision=$6,automatic_reserved_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,chase_after_days=$7 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,r.id,result.communicationId,Boolean(saved),saved?.id||null,saved?.revision||null,chaseAfterDays??followUp.chaseDays(saved?.scope?.chaseAfterDays)]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:saved?'Supplier claim queued under the owner’s claim rule':'Supplier claim approved and queued',reference:r.reference,after:{claimId:r.id,communicationId:result.communicationId,automatic:Boolean(saved),ruleId:saved?.id||null,remedy:p.remedy||null,totalMinor:p.totalMinor,currency:p.currency}});
 return {claimId:r.id,...result};
}
async function send(db,ctx,id,input){return db.transaction(async c=>{const r=await claim(c,ctx,id,true);await source.access(c,ctx,{withPhotos:r.snapshot.photos.length>0});if(input.confirmed!=='yes'||input.sourceFingerprint!==r.source_fingerprint)throw new ValidationError('Review the exact supplier claim and its evidence before sending.');const chaseAfterDays=followUp.chaseDays(input.chaseAfterDays);await c.query('UPDATE stockchief_runtime.agent_supplier_claims SET reviewed_by=$3,reviewed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,ctx.actorId]);return queue(c,ctx,{...r,reviewed_by:ctx.actorId,reviewed_at:new Date().toISOString()},null,{chaseAfterDays});},{isolation:'SERIALIZABLE',retrySafe:true});}
async function sendAutomatic(db,ctx,id,ruleId){return db.transaction(async c=>{const r=await claim(c,ctx,id,true),saved=await rule(c,ctx,ruleId,true);return queue(c,ctx,r,saved);},{isolation:'SERIALIZABLE',retrySafe:true});}
async function page(db,ctx,{id=null}={}){
 await source.owner(db,ctx,{lock:false});const state=await policy.accountState(db,ctx.workspaceId),locked=!policy.usesAgentTerms(state)||!policy.permits(state.plan,45,'draft');
 const rows=(await db.query(`SELECT id,reference,created_at,outcome,snapshot->>'claimKind' AS claim_kind,communication_id IS NOT NULL AS sent
  FROM stockchief_runtime.agent_supplier_claims WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,[ctx.workspaceId])).rows;
 const rules=(await db.query('SELECT * FROM stockchief_runtime.agent_supplier_claim_rules WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[ctx.workspaceId])).rows;
 const saved=id&&!locked?await claim(db,ctx,id):null,m=saved?.communication_id?await require('../connections/postgres-outbound-mail').get(db,ctx.workspaceId,'supplier',saved.communication_id):null;
 const position=saved?await followUp.position(db,ctx,saved):null;
 // A sent claim keeps the evidence it was sent with; later receipts are its follow-through.
 let problem=null;if(saved&&!position.sentAt)try{await current(db,ctx,saved,{readOnly:true});}catch(e){if(![400,402,403,404,422].includes(e.status))throw e;problem=e.message;}
 const editable=Boolean(saved&&!saved.communication_id);
 const photosToChoose=editable?await photos.photoSet(db,ctx,source.photoSource(saved.snapshot)):[];
 const mailboxes=editable?await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId):[];
 return {goodsCost:saved?require('../domain/currency').format(saved.snapshot.totalMinor,saved.snapshot.currency):null,locked,plan:state.plan,shadow:state.shadow,rows,rules,saved,delivery:m,problem,
  words:saved?source.compose(saved.snapshot):null,matchingRule:saved?rules.find(r=>r.enabled&&r.profile_hash===hash(source.profile(saved.snapshot))):null,
  manualExampleReady:Boolean(saved&&!saved.automatic&&saved.reviewed_by===ctx.actorId&&m?.status==='SENT'&&m.external_message_id),
  routineReady:!locked&&!state.shadow&&(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate,
  position,candidates:position?.sentAt?await followUp.candidates(db,ctx,saved,position):{credits:[],receipts:[]},
  remedies:source.REMEDIES,outcomes:followUp.OUTCOMES,maxChases:followUp.MAX_CHASES,defaultChaseDays:followUp.DEFAULT_CHASE_DAYS,
  editable,photosToChoose,mailboxes,formatMoney:require('../domain/currency').format};
}
const definition={id:45,key:'supplier-damage-claims',label:'Open supplier delivery claims',readPage:async()=>({summary:'Opens a claim with the supplier from a checked short delivery, a failed QC inspection or a staff damage report at receiving. Each claim lists the purchase order, receipt, product, quantity and value at the purchase order price, and asks for a credit note, replacement goods or a refund. StockChief follows each sent claim to the supplier’s reply, a credit note or replacement goods, and reminds the supplier when there is no answer. Pro drafts claims until you teach it with one you send; Custom works within your limits without training.',rows:[{Action:'Review supplier claims',link:'/autopilot/supplier-claims'}],more:false})};
const photoDefinition={id:46,key:'delivery-damage-photos',label:'Add photos of damaged boxes to the claim',readPage:async()=>({summary:'Staff take photos of damaged boxes on the phone when receiving, on a delivery check or at a failed QC inspection. StockChief keeps each original JPEG or PNG unchanged and prepares a smaller email copy. Growth prepares the photo set for you to attach yourself. Pro and Custom attach up to three photos to the supplier claim on their own and keep them with the claim. Photos never decide damage or counts.',rows:[{Action:'Open physical delivery evidence',link:'/autopilot/delivery-quality'}],more:false})};
async function inbox(db,workspaceId,actorId){
 const ctx={workspaceId,actorId};await source.owner(db,ctx,{lock:false});
 const rows=(await db.query(`SELECT c.id,c.reference,c.created_at,c.snapshot->>'claimKind' AS claim_kind,m.status,e.status effect_status FROM stockchief_runtime.agent_supplier_claims c
 LEFT JOIN supplier_communications m ON m.workspace_id=c.workspace_id AND m.id=c.communication_id
 LEFT JOIN LATERAL(SELECT status FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=c.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' ORDER BY created_at DESC,id DESC LIMIT 1)e ON true
 WHERE c.workspace_id=$1 AND (c.communication_id IS NULL OR m.status='FAILED' OR e.status='AMBIGUOUS') ORDER BY c.created_at,c.id LIMIT 50`,[workspaceId])).rows;
 const items=rows.map(r=>({kind:'purchasing',importance:'Needs You',priority:r.effect_status==='AMBIGUOUS'?90:75,
  title:'Review supplier '+(r.claim_kind==='shortage'?'shortage':'damage')+' claim '+r.reference,
  happened:r.effect_status==='AMBIGUOUS'?'Mailbox acceptance is uncertain.':'A recorded delivery claim needs review.',
  why:r.effect_status==='AMBIGUOUS'?'Check the mailbox Sent folder before any further action.':
   r.claim_kind==='shortage'?'Check the original delivery, receipt, missing quantity, goods cost and recipient.':'Check the actual damage, damaged units, goods cost, what you ask for, recipient and selected photos.',
  recommendation:'Open the exact saved claim. Credits, write-offs, replacement receipt and settlement need separate approval.',href:'/autopilot/supplier-claims/'+r.id,actionLabel:'Review claim',sourceId:'supplier-claim:'+r.id,at:r.created_at,createdAt:r.created_at}));
 const state=await policy.accountState(db,workspaceId);
 if(policy.usesAgentTerms(state)&&!policy.permits(state.plan,45,'draft')&&policy.permits(state.plan,46,'draft'))items.push(...await photoSets(db,workspaceId));
 if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,45,'draft'))return items;
 // Sent claims that need a person: a reply to read, a reminder to approve,
 // no answer after the last reminder, or a part settlement.
 const open=(await db.query(`SELECT c.id FROM stockchief_runtime.agent_supplier_claims c JOIN supplier_communications m ON m.workspace_id=c.workspace_id AND m.id=c.communication_id
  WHERE c.workspace_id=$1 AND c.outcome IS NULL AND m.status='SENT' AND nullif(m.external_message_id,'') IS NOT NULL ORDER BY c.created_at,c.id LIMIT 25`,[workspaceId])).rows;
 const money=require('../domain/currency');
 for(const {id} of open){
  let r,pos;try{r=await claim(db,ctx,id);pos=await followUp.position(db,ctx,r);}catch(e){if(![400,404,422].includes(e.status))throw e;continue;}
  const p=r.snapshot,base={kind:'purchasing',importance:'Needs You',href:'/autopilot/supplier-claims/'+r.id,sourceId:'supplier-claim-follow:'+r.id,at:pos.sentAt,createdAt:pos.sentAt};
  const what=p.supplierName+' · '+p.poNumber+' · '+money.format(p.totalMinor,p.currency);
  if(pos.state==='REPLIED')items.push({...base,priority:72,title:'Supplier replied to claim '+r.reference,happened:what,why:'The supplier answered in the claim’s email thread.',recommendation:'Read the reply, then link the credit note or replacement goods, or record how the claim ended.',actionLabel:'Open claim'});
  else if(pos.chaseDue)items.push({...base,priority:66,title:'No reply to claim '+r.reference,happened:what,why:'No answer since '+new Date(pos.sentAt).toISOString().slice(0,10)+'. Reminders outside a claim rule need your approval.',recommendation:'Send reminder '+(pos.chases.length+1)+' of '+followUp.MAX_CHASES+' with one tap.',actionLabel:'Send reminder'});
  else if(pos.exhausted)items.push({...base,priority:70,title:'No reply to claim '+r.reference+' after '+followUp.MAX_CHASES+' reminders',happened:what,why:'The supplier has not answered by email.',recommendation:'Call or write to the supplier, then record how the claim ended.',actionLabel:'Open claim'});
  else if(pos.state==='PART_SETTLED')items.push({...base,priority:60,title:'Claim '+r.reference+' is partly settled',happened:money.format(pos.remainingMinor,p.currency)+' still owed of '+money.format(p.totalMinor,p.currency)+'.',why:'A credit or replacement covers part of the claim.',recommendation:'Wait for the rest, link it, or record how the claim ended.',actionLabel:'Open claim'});
 }
 // Staff damage reports from receiving that have no claim yet.
 const reports=(await db.query(`SELECT d.id,d.quantity::text AS quantity,d.created_at,rl.receipt_id,s.code,i.unit_label,o.po_number FROM stockchief_runtime.agent_receipt_damage_reports d
  JOIN purchase_order_receipt_lines rl ON rl.workspace_id=d.workspace_id AND rl.id=d.receipt_line_id
  JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id
  JOIN skus s ON s.workspace_id=rl.workspace_id AND s.id=rl.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  WHERE d.workspace_id=$1 AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_claims c WHERE c.workspace_id=d.workspace_id AND c.damage_report_id=d.id)
  ORDER BY d.created_at,d.id LIMIT 25`,[workspaceId])).rows;
 for(const d of reports)items.push({kind:'purchasing',importance:'Needs You',priority:68,title:'Damaged on arrival: '+d.code+' · '+Number(d.quantity)+' '+d.unit_label,
  happened:'Your receiving team marked these units damaged on '+d.po_number+'. They were written off.',why:'The supplier has not been asked for a credit, replacement or refund.',
  recommendation:'Prepare a supplier claim from the staff report.',href:'/autopilot/delivery-evidence/'+d.receipt_id,actionLabel:'Prepare claim',sourceId:'damage-report:'+d.id,at:d.created_at,createdAt:d.created_at});
 return items;
}

// Growth: deliveries with damage evidence and photos, ready for the owner to
// attach to a claim they send themselves.
async function photoSets(db,workspaceId){
 return (await db.query(`SELECT r.id,r.received_at,o.po_number,count(DISTINCT q.id)::int AS photos FROM purchase_order_receipts r
  JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id
  JOIN purchase_order_receipt_lines rl ON rl.workspace_id=r.workspace_id AND rl.receipt_id=r.id
  LEFT JOIN stockchief_runtime.agent_quality_holds h ON h.workspace_id=rl.workspace_id AND h.receipt_line_id=rl.id AND h.status='FAILED'
  LEFT JOIN stockchief_runtime.agent_receipt_damage_reports d ON d.workspace_id=rl.workspace_id AND d.receipt_line_id=rl.id
  JOIN stockchief_runtime.agent_quality_photos q ON q.workspace_id=r.workspace_id AND (q.receipt_id=r.id OR q.hold_id=h.id)
  WHERE r.workspace_id=$1 AND (h.id IS NOT NULL OR d.id IS NOT NULL) AND r.received_at::timestamptz>now()-interval '30 days'
  GROUP BY r.id,r.received_at,o.po_number ORDER BY r.received_at,r.id LIMIT 25`,[workspaceId])).rows
  .map(r=>({kind:'purchasing',importance:'Needs You',priority:55,title:'Photos ready for a supplier claim: '+r.po_number,happened:r.photos+' photo'+(r.photos===1?'':'s')+' of damaged goods from this delivery.',
   why:'Supplier claims need Pro or Custom, so StockChief prepared the photo set for you to send.',recommendation:'Download the email copies and attach them to your claim email.',
   href:'/autopilot/delivery-evidence/'+r.id,actionLabel:'Open photo set',sourceId:'delivery-photos:'+r.id,at:r.received_at,createdAt:r.received_at}));
}
// The workspace owner who receives prepared drafts.
async function ownerOf(db,workspaceId){
 return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
  WHERE u.workspace_id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}
// One piece of damage evidence: claimed alone under the owner's rule, or
// prepared as a draft for the owner when no rule covers it.
async function evidenceClaim(db,workspaceId,row,key,drafting){
 if(row.rule_id){
  const ctx={workspaceId,actorId:row.authorized_by};
  await source.access(db,ctx,{automatic:true,trained:Boolean(row.example_id),withPhotos:row.include_photos});
  const ids=row.include_photos?(await photos.photoSet(db,ctx,{[key]:row.id})).map(p=>p.id):[];
  if(ids.length>photos.MAX_PER_CLAIM)throw new ValidationError('Choose the exact three photos to send; this delivery has more evidence than one routine email can attach.');
  const r=await preview(db,ctx,{[key]:row.id,connectorId:row.connector_id,photoIds:ids,remedy:row.remedy||undefined},{legacyRemedy:!row.remedy});
  return {[key]:row.id,...await sendAutomatic(db,ctx,r.id,row.rule_id)};
 }
 if(!drafting.ownerId)return {[key]:row.id,needsReview:'No rule covers this evidence. Prepare the claim yourself.'};
 if(drafting.mailboxes.length!==1)return {[key]:row.id,needsReview:'Choose the sending mailbox and prepare this claim.'};
 // The draft asks for a credit note and carries the delivery's photos when
 // they fit one email; the owner can change both before sending.
 // When photo work is set to Watch only, the draft goes without photos.
 const ctx={workspaceId,actorId:drafting.ownerId},set=drafting.photosBlocked?[]:await photos.photoSet(db,ctx,{[key]:row.id});
 const r=await preview(db,ctx,{[key]:row.id,connectorId:drafting.mailboxes[0].id,remedy:'credit',photoIds:set.length<=photos.MAX_PER_CLAIM?set.map(p=>p.id):[]});
 return {[key]:row.id,drafted:r.id};
}
const RULE=`LEFT JOIN LATERAL(SELECT r.id rule_id,r.authorized_by,r.connector_id,r.include_photos,r.example_id,r.scope->>'remedy' remedy
  FROM stockchief_runtime.agent_supplier_claim_rules r WHERE r.workspace_id=o.workspace_id AND r.supplier_id=o.supplier_id AND r.sku_id=rl.sku_id
   AND r.location_id=rl.location_id AND r.enabled AND r.scope->>'claimKind' IS NULL ORDER BY r.created_at DESC,r.id DESC LIMIT 1) rule ON true`;
// One routine pass, at most 40 claims. Failed inspections, then staff damage
// reports, then confirmed shortages; the cursor names the phase.
async function run(db,workspaceId,{afterId=''}={}){
 const phase=afterId.startsWith('shortage:')?'shortage':afterId.startsWith('report:')?'report':'hold';
 const after=afterId.replace(/^(shortage|report|hold):/,'');
 const state=await policy.accountState(db,workspaceId),autopilot=await require('../autopilot/postgres-service').getState(db,workspaceId);
 const canDraft=policy.usesAgentTerms(state)&&policy.permits(state.plan,45,'draft')&&!state.shadow&&autopilot.mode!=='OBSERVE'&&!Number(autopilot.paused)&&!Number(autopilot.suspended);
 const drafting={ownerId:canDraft?await ownerOf(db,workspaceId):null,mailboxes:canDraft?await require('../connections/postgres-outbound-mail').mailboxes(db,workspaceId):[],
  photosBlocked:canDraft&&Boolean(await policy.stopped(db,workspaceId,state,'supplier.attach_damage_photos',false))};
 const results=[];
 const work=async(rows,key)=>{
  for(const row of rows.slice(0,40-results.length)){
   try{results.push(await evidenceClaim(db,workspaceId,row,key,drafting));}
   catch(e){if(![400,402,403,404,422].includes(e.status)&&e.code!=='23505')throw e;results.push({[key]:row.id,needsReview:e.message});}
  }
 };
 if(phase==='hold'){
  const holds=(await db.query(`SELECT h.id,rule.* FROM stockchief_runtime.agent_quality_holds h
   JOIN purchase_order_receipt_lines rl ON rl.workspace_id=h.workspace_id AND rl.id=h.receipt_line_id
   JOIN purchase_order_receipts pr ON pr.workspace_id=rl.workspace_id AND pr.id=rl.receipt_id
   JOIN purchase_orders o ON o.workspace_id=pr.workspace_id AND o.id=pr.purchase_order_id ${RULE}
   WHERE h.workspace_id=$1 AND h.id>$2 AND h.status='FAILED' AND h.inspection->>'damagedQuantity' IS NOT NULL AND (rule.rule_id IS NOT NULL OR $3)
    AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_claims c WHERE c.workspace_id=h.workspace_id AND c.hold_id=h.id)
   ORDER BY h.id LIMIT 41`,[workspaceId,after,Boolean(drafting.ownerId)])).rows;
  await work(holds,'holdId');
  if(holds.length>40)return {results,more:true,nextAfterId:'hold:'+holds[39].id};
 }
 if(phase!=='shortage'){
  const room=40-results.length,start=phase==='report'?after:'';
  const reports=(await db.query(`SELECT d.id,rule.* FROM stockchief_runtime.agent_receipt_damage_reports d
   JOIN purchase_order_receipt_lines rl ON rl.workspace_id=d.workspace_id AND rl.id=d.receipt_line_id
   JOIN purchase_order_receipts pr ON pr.workspace_id=rl.workspace_id AND pr.id=rl.receipt_id
   JOIN purchase_orders o ON o.workspace_id=pr.workspace_id AND o.id=pr.purchase_order_id ${RULE}
   WHERE d.workspace_id=$1 AND d.id>$2 AND (rule.rule_id IS NOT NULL OR $3)
    AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_claims c WHERE c.workspace_id=d.workspace_id AND c.damage_report_id=d.id)
   ORDER BY d.id LIMIT $4`,[workspaceId,start,Boolean(drafting.ownerId),room+1])).rows;
  await work(reports,'reportId');
  if(reports.length>room)return {results,more:true,nextAfterId:'report:'+(room?reports[room-1].id:start)};
 }
 const room=40-results.length,start=phase==='shortage'?after:'';
 const shortages=(await db.query(`SELECT c.id,r.id AS rule_id,r.authorized_by FROM stockchief_runtime.agent_supplier_claims c
  JOIN stockchief_runtime.agent_supplier_claim_rules r ON r.workspace_id=c.workspace_id AND r.enabled
   AND r.scope->>'claimKind'='shortage' AND r.supplier_id=c.snapshot->>'supplierId' AND r.sku_id=c.snapshot->>'skuId'
   AND r.location_id=c.snapshot->>'locationId' AND r.connector_id=c.snapshot->>'connectorId'
   AND r.authorized_by=c.prepared_by
  WHERE c.workspace_id=$1 AND c.id>$2 AND c.delivery_comparison_id IS NOT NULL AND c.communication_id IS NULL
  ORDER BY c.id LIMIT $3`,[workspaceId,start,room+1])).rows;
 for(const row of shortages.slice(0,room)){
  try{results.push(await sendAutomatic(db,{workspaceId,actorId:row.authorized_by},row.id,row.rule_id));}
  catch(e){if(![400,402,403,404,422].includes(e.status))throw e;results.push({claimId:row.id,needsReview:e.message});}
 }
 const more=shortages.length>room;
 return {results,more,nextAfterId:more?'shortage:'+(room?shortages[room-1].id:start):null};
}
module.exports={claim,preview,configure,authority,deliveryAuthority,attachments,send,sendAutomatic,rule,page,run,inbox,definition,photoDefinition,kind,action};
