'use strict';
const source=require('./supplier-claim-source'),photos=require('../operations/quality-photos'),policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions');
const {ValidationError,NotFoundError}=require('../domain/errors'),{newId}=require('../lib/util');
const kind='supplier_claim',action='supplier.open_damage_claim';
async function claim(c,ctx,id,lock=false){
 const r=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_claims WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
 if(!r)throw new NotFoundError('That supplier claim is not in this inventory.');
 const {sourceFingerprint,ageDays,...p}=r.snapshot;if(sourceFingerprint!==r.source_fingerprint||hash(p)!==sourceFingerprint)throw new ValidationError('This claim no longer matches its recorded evidence. Review the physical inspection again.');return r;
}
async function current(c,ctx,r,{readOnly=false,automatic=false}={}){
 const p=r.snapshot,fresh=await source.facts(c,ctx,{holdId:p.holdId,comparisonId:p.comparisonId,lineId:p.lineId,
  connectorId:p.connectorId,photoIds:p.photos.map(x=>x.id),reference:p.reference},{readOnly,automatic});
 if(hash(source.stable(fresh))!==hash(source.stable(p)))throw new ValidationError('The inspection, supplier, price, mailbox or photo evidence changed. Prepare and review a current claim before sending.');return fresh;
}
async function preview(db,ctx,input){return db.transaction(async c=>{
 const ids=input.photoIds===undefined?[]:Array.isArray(input.photoIds)?input.photoIds:[input.photoIds];await source.access(c,ctx,{withPhotos:ids.length>0});
 const shortage=Boolean(input.comparisonId);
 if(shortage&&(!input.lineId||input.holdId||input.shortageConfirmed!=='yes'))
  throw new ValidationError('Confirm these goods were due in this delivery and the exact missing quantity is a shortage.');
 const sourceId=shortage?input.lineId:input.holdId;
 if(shortage)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['supplier-shortage:'+ctx.workspaceId+':'+sourceId]);
 const sourceColumn=shortage?'purchase_order_line_id':'hold_id';
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
 else await c.query(`INSERT INTO stockchief_runtime.agent_supplier_claims(id,workspace_id,hold_id,reference,prepared_by,snapshot,source_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,ctx.workspaceId,p.holdId,reference,ctx.actorId,JSON.stringify(p),p.sourceFingerprint]);
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
 if(existing&&(existing.supplier_id!==p.supplierId||existing.sku_id!==p.skuId||existing.location_id!==p.locationId||existing.connector_id!==p.connectorId||existing.scope.claimKind!==p.claimKind))throw new ValidationError('A claim rule keeps its exact supplier, product, location, claim type and mailbox. Stop it and authorize a new scope for different records.');
 const shortage=p.claimKind==='shortage',includePhotos=input.includePhotos==='yes';
 if(shortage&&includePhotos)throw new ValidationError('Authorize shortage claims from their original delivery and receipt evidence.');
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
 const rid=existing?.id||newId('claim-rule'),profile=source.profile(p),scope=shortage?{...profile,maxShortUnits:maxUnits,maxShortWeight:maxWeight}:profile;
 const values=[ctx.workspaceId,rid,JSON.stringify(scope),hash(profile),Math.max(1,Math.ceil(maxUnits)),maxValue,maxWeekly,maxAgeDays,includePhotos,done?.id||null,ctx.actorId];
 try{if(existing)await c.query('UPDATE stockchief_runtime.agent_supplier_claim_rules SET scope=$3,profile_hash=$4,max_units=$5,max_value_minor=$6,max_weekly_minor=$7,max_age_days=$8,include_photos=$9,example_id=$10,authorized_by=$11,enabled=true,revision=revision+1 WHERE workspace_id=$1 AND id=$2',values);
 else await c.query(`INSERT INTO stockchief_runtime.agent_supplier_claim_rules(workspace_id,id,scope,profile_hash,max_units,max_value_minor,max_weekly_minor,max_age_days,include_photos,example_id,authorized_by,supplier_id,sku_id,location_id,connector_id,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[...values,p.supplierId,p.skuId,p.locationId,p.connectorId,p.currency]);}catch(e){if(e.code==='23505')throw new ValidationError('An active rule already covers this supplier, product and location. Update that rule.');throw e;}
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Bounded supplier damage claim authority recorded',reference:rid,after:{profile:source.profile(p),maxUnits,maxValue,maxWeekly,maxAgeDays,includePhotos,exampleId:done?.id||null,settlementAuthority:false}});return {id:rid};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function authority(c,workspaceId,g){
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
async function attachments(db,workspaceId,g){const r=await deliveryAuthority(db,workspaceId,g),out=[];for(const ref of r.snapshot.photos){const p=await photos.load(db,{workspaceId,actorId:g.actorId},ref.id,{email:true});if(p.content_hash!==ref.originalHash||p.email_hash!==ref.emailHash)throw new ValidationError('The photo copy needs an evidence integrity review.');out.push({filename:ref.filename,contentType:'image/jpeg',content:p.bytes});}return out;}
async function queue(c,ctx,r,saved=null){
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
 await c.query('UPDATE stockchief_runtime.agent_supplier_claims SET communication_id=$3,automatic=$4,rule_id=$5,rule_revision=$6,automatic_reserved_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,r.id,result.communicationId,Boolean(saved),saved?.id||null,saved?.revision||null]);return {claimId:r.id,...result};
}
async function send(db,ctx,id,input){return db.transaction(async c=>{const r=await claim(c,ctx,id,true);await source.access(c,ctx,{withPhotos:r.snapshot.photos.length>0});if(input.confirmed!=='yes'||input.sourceFingerprint!==r.source_fingerprint)throw new ValidationError('Review the exact supplier claim and its evidence before sending.');await c.query('UPDATE stockchief_runtime.agent_supplier_claims SET reviewed_by=$3,reviewed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,ctx.actorId]);return queue(c,ctx,{...r,reviewed_by:ctx.actorId,reviewed_at:new Date().toISOString()});},{isolation:'SERIALIZABLE',retrySafe:true});}
async function sendAutomatic(db,ctx,id,ruleId){return db.transaction(async c=>{const r=await claim(c,ctx,id,true),saved=await rule(c,ctx,ruleId,true);return queue(c,ctx,r,saved);},{isolation:'SERIALIZABLE',retrySafe:true});}
async function page(db,ctx,{id=null}={}){
 await source.owner(db,ctx,{lock:false});const state=await policy.accountState(db,ctx.workspaceId),locked=!policy.usesAgentTerms(state)||!policy.permits(state.plan,45,'draft');
 const rows=(await db.query('SELECT id,reference,created_at FROM stockchief_runtime.agent_supplier_claims WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[ctx.workspaceId])).rows;
 const rules=(await db.query('SELECT * FROM stockchief_runtime.agent_supplier_claim_rules WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[ctx.workspaceId])).rows;
 const saved=id&&!locked?await claim(db,ctx,id):null,m=saved?.communication_id?await require('../connections/postgres-outbound-mail').get(db,ctx.workspaceId,'supplier',saved.communication_id):null;
 let problem=null;if(saved)try{await current(db,ctx,saved,{readOnly:true});}catch(e){if(![400,402,403,404,422].includes(e.status))throw e;problem=e.message;}
 return {goodsCost:saved?require('../domain/currency').format(saved.snapshot.totalMinor,saved.snapshot.currency):null,locked,plan:state.plan,shadow:state.shadow,rows,rules,saved,delivery:m,problem,words:saved?source.compose(saved.snapshot):null,matchingRule:saved?rules.find(r=>r.enabled&&r.profile_hash===hash(source.profile(saved.snapshot))):null,manualExampleReady:Boolean(saved&&!saved.automatic&&saved.reviewed_by===ctx.actorId&&m?.status==='SENT'&&m.external_message_id),routineReady:!locked&&!state.shadow&&(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate};
}
const definition={id:45,key:'supplier-damage-claims',label:'Open supplier delivery claims',readPage:async()=>({summary:'Prepare a claim from a confirmed delivery shortage and its original receipt, or a failed physical damage inspection and its selected photo evidence. Pro learns from a completed manual send. Custom can authorize bounded routine claims without training. Credit, settlement and stock decisions stay separate.',rows:[{Action:'Review supplier claims',link:'/autopilot/supplier-claims'}],more:false})};
const photoDefinition={id:46,key:'delivery-damage-photos',label:'Prepare actual delivery damage photos',readPage:async()=>({summary:'Growth can preserve and prepare original JPEG/PNG delivery evidence for individual review. Pro and Custom can attach up to three resized copies within separately authorized claim rules without photo training. A person records the physical damage; photo preparation never infers a count or changes the original.',rows:[{Action:'Open physical delivery evidence',link:'/autopilot/delivery-quality'}],more:false})};
async function inbox(db,workspaceId,actorId){
 await source.owner(db,{workspaceId,actorId},{lock:false});const rows=(await db.query(`SELECT c.id,c.reference,c.created_at,c.snapshot->>'claimKind' AS claim_kind,m.status,e.status effect_status FROM stockchief_runtime.agent_supplier_claims c
 LEFT JOIN supplier_communications m ON m.workspace_id=c.workspace_id AND m.id=c.communication_id
 LEFT JOIN LATERAL(SELECT status FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=c.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' ORDER BY created_at DESC,id DESC LIMIT 1)e ON true
 WHERE c.workspace_id=$1 AND (c.communication_id IS NULL OR m.status='FAILED' OR e.status='AMBIGUOUS') ORDER BY c.created_at,c.id LIMIT 50`,[workspaceId])).rows;
 return rows.map(r=>({kind:'purchasing',importance:'Needs You',priority:r.effect_status==='AMBIGUOUS'?90:75,
  title:'Review supplier '+(r.claim_kind==='shortage'?'shortage':'damage')+' claim '+r.reference,
  happened:r.effect_status==='AMBIGUOUS'?'Mailbox acceptance is uncertain.':'A recorded delivery claim needs review.',
  why:r.effect_status==='AMBIGUOUS'?'Check the mailbox Sent folder before any further action.':
   r.claim_kind==='shortage'?'Check the original delivery, receipt, missing quantity, goods cost and recipient.':'Check the actual inspection, damaged units, goods cost, recipient and selected photos.',
  recommendation:'Open the exact saved claim. Credits, write-offs, replacement receipt and settlement need separate approval.',href:'/autopilot/supplier-claims/'+r.id,actionLabel:'Review claim',sourceId:'supplier-claim:'+r.id,at:r.created_at,createdAt:r.created_at}));
}
async function run(db,workspaceId,{afterId=''}={}){
 const shortageCursor=afterId.startsWith('shortage:');
 const candidates=shortageCursor?[]:(await db.query(`SELECT h.id,r.id rule_id,r.authorized_by,r.connector_id,r.include_photos,r.example_id FROM stockchief_runtime.agent_quality_holds h
  JOIN purchase_order_receipt_lines rl ON rl.workspace_id=h.workspace_id AND rl.id=h.receipt_line_id
  JOIN purchase_order_receipts pr ON pr.workspace_id=rl.workspace_id AND pr.id=rl.receipt_id
  JOIN purchase_orders o ON o.workspace_id=pr.workspace_id AND o.id=pr.purchase_order_id
  JOIN stockchief_runtime.agent_supplier_claim_rules r ON r.workspace_id=h.workspace_id AND r.supplier_id=o.supplier_id AND r.sku_id=h.sku_id AND r.location_id=h.location_id AND r.enabled AND r.scope->>'claimKind' IS NULL
  WHERE h.workspace_id=$1 AND h.id>$2 AND h.status='FAILED' AND h.inspection->>'damagedQuantity' IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_claims c WHERE c.workspace_id=h.workspace_id AND c.hold_id=h.id)
  ORDER BY h.id LIMIT 41`,[workspaceId,afterId])).rows;
 const results=[];for(const h of candidates.slice(0,40)){
  const ctx={workspaceId,actorId:h.authorized_by};try{
   await source.access(db,ctx,{automatic:true,trained:Boolean(h.example_id),withPhotos:h.include_photos});
   const ids=h.include_photos?(await db.query('SELECT id FROM stockchief_runtime.agent_quality_photos WHERE workspace_id=$1 AND hold_id=$2 ORDER BY created_at,id LIMIT 4',[workspaceId,h.id])).rows.map(p=>p.id):[];
   if(ids.length>3)throw new ValidationError('Choose the exact three photos to send; this delivery has more evidence than one routine email can attach.');
   const r=await preview(db,ctx,{holdId:h.id,connectorId:h.connector_id,photoIds:ids});results.push(await sendAutomatic(db,ctx,r.id,h.rule_id));
  }catch(e){if(![400,402,403,404,422].includes(e.status)&&e.code!=='23505')throw e;results.push({holdId:h.id,needsReview:e.message});}
 }
 if(candidates.length>40)return {results,more:true,nextAfterId:candidates[39].id};
 const room=40-results.length,after=shortageCursor?afterId.slice('shortage:'.length):'';
 const shortages=(await db.query(`SELECT c.id,r.id AS rule_id,r.authorized_by FROM stockchief_runtime.agent_supplier_claims c
  JOIN stockchief_runtime.agent_supplier_claim_rules r ON r.workspace_id=c.workspace_id AND r.enabled
   AND r.scope->>'claimKind'='shortage' AND r.supplier_id=c.snapshot->>'supplierId' AND r.sku_id=c.snapshot->>'skuId'
   AND r.location_id=c.snapshot->>'locationId' AND r.connector_id=c.snapshot->>'connectorId'
   AND r.authorized_by=c.prepared_by
  WHERE c.workspace_id=$1 AND c.id>$2 AND c.delivery_comparison_id IS NOT NULL AND c.communication_id IS NULL
  ORDER BY c.id LIMIT $3`,[workspaceId,after,room+1])).rows;
 for(const row of shortages.slice(0,room)){
  try{results.push(await sendAutomatic(db,{workspaceId,actorId:row.authorized_by},row.id,row.rule_id));}
  catch(e){if(![400,402,403,404,422].includes(e.status))throw e;results.push({claimId:row.id,needsReview:e.message});}
 }
 const more=shortages.length>room;
 return {results,more,nextAfterId:more?'shortage:'+(room?shortages[room-1].id:after):null};
}
module.exports={claim,preview,configure,authority,deliveryAuthority,attachments,send,sendAutomatic,rule,page,run,inbox,definition,photoDefinition,kind,action};
