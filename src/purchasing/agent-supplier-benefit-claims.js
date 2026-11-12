'use strict';
// Job 97: prepares a rebate claim when the purchase period ends, sends it to the
// supplier through the outbox, and follows it to the supplier's credit note.
// Pro and Custom send on their own within the owner's claim limit; anything
// over it, Ask me first, a stopped agreement or changed purchases wait for a
// person. Rebate terms read from email always need a person to accept them.
const policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions'),{newId}=require('../lib/util'),{ValidationError,NotFoundError}=require('../domain/errors');
const kind='supplier_benefit_claim',action='supplier.claim_benefit',FOLLOW_UP_DAYS=30;
const benefits=()=>require('./agent-supplier-benefits'),audit=(...a)=>require('../operations/postgres-security-audit').record(...a);
// What a claim is for. Stable when the claim itself is added to the history.
function evidence(f){
 return hash({programId:f.program.id,terms:f.program.terms,currency:f.program.currency,period:[f.program.starts_on,f.program.ends_on],products:f.program.scope.products.map(p=>[p.skuId,p.unit]),
  eligible:f.eligible.map(r=>[r.id,r.net_minor,r.quantity,r.line_fingerprint,r.credit_fingerprint,r.return_fingerprint]),holds:f.holds.map(r=>r.id),potential:f.result.potentialBenefitMinor,scopeChanged:Boolean(f.scopeReview)});
}
async function row(c,workspaceId,id,{lock=false}={}){
 const r=(await c.query('SELECT *,submitted_on::text FROM stockchief_runtime.agent_supplier_benefit_claims WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[workspaceId,id])).rows[0];
 if(!r)throw new NotFoundError('That rebate claim is not in this inventory.');return r;
}
async function words(c,ctx,p,snapshot){
 const supplier=(await c.query("SELECT name,email FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,p.supplier_id])).rows[0];
 if(!supplier?.email)throw new ValidationError('Add the supplier’s email address before sending a claim.');
 const business=(await c.query('SELECT name FROM workspaces WHERE id=$1',[ctx.workspaceId])).rows[0]?.name||'',show=v=>benefits().displayMoney(v,p.currency),t=snapshot.result,tier=t.tier;
 const unit=p.scope.products[0]?.unit||'units',tierText=tier?(p.terms.basis==='net_spend'?'from '+show(tier.threshold):'from '+tier.threshold+' '+unit)+': '+(p.terms.benefit==='percentage'?tier.rateBasisPoints/100+'%':show(tier.unitPriceMinor)+' per '+p.terms.pricePerUnits+' '+unit):'none';
 const lines=['Hello '+supplier.name+',','',
  'Under our agreement "'+p.title+'" ('+p.source_reference+'), our purchases from '+p.starts_on+' to '+p.ends_on+' qualify for a rebate.','',
  'Eligible purchases: '+show(t.eligibleNetMinor)+(p.terms.basis==='stock_units'?' ('+t.eligibleQuantity+' '+unit+')':''),
  'Tier reached: '+tierText,'Rebate earned: '+show(t.potentialBenefitMinor),
  ...(BigInt(snapshot.claimedBeforeMinor)>0n?['Already claimed: '+show(snapshot.claimedBeforeMinor)]:[]),
  'Amount claimed now: '+show(snapshot.amountMinor),'','Invoices included:',
  ...snapshot.invoices.slice(0,100).map(i=>'- '+i.number+' ('+i.issueDate+'): '+show(i.netMinor)),
  ...(snapshot.invoices.length>100?['- and '+(snapshot.invoices.length-100)+' more']:[]),'',
  'Please send a credit note for '+show(snapshot.amountMinor)+' quoting '+snapshot.reference+'.','','Thank you,',business];
 return {recipient:supplier.email.toLowerCase(),subject:'Rebate claim '+snapshot.reference+': '+p.title,body:lines.join('\n')};
}
// Prepares the claim for the rebate earned in a finished purchase period.
async function prepare(c,ctx,p,f,{automatic=false}={}){
 const open=(await c.query("SELECT * FROM stockchief_runtime.agent_supplier_benefit_claims WHERE workspace_id=$1 AND program_id=$2 AND status IN ('PREPARED','SENDING') FOR UPDATE",[ctx.workspaceId,p.id])).rows[0];if(open)return {...open,replayed:true};
 if(!p.enabled)throw new ValidationError('Tracking is stopped for this agreement.');
 if(f.today<=p.ends_on)throw new ValidationError('The rebate is earned when the purchase period ends on '+p.ends_on+'.');
 if(!f.claimReady)throw new ValidationError(f.warnings[0]||'This agreement has nothing ready to claim.');
 if(!p.connector_id)throw new ValidationError('Choose the mailbox to send claims from.');
 const amount=BigInt(f.remainingClaimMinor);if(amount<=0n)throw new ValidationError('Nothing is left to claim.');
 const id=newId('supplier-benefit-claim'),reference='REB-'+id.replace(/[^A-Za-z0-9]/g,'').slice(-8).toUpperCase();
 const numbers=(await c.query('SELECT id,bill_number,supplier_invoice_number FROM accounting_supplier_bills WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,f.eligible.map(r=>r.id)])).rows;
 const snapshot={reference,programId:p.id,supplierId:p.supplier_id,connectorId:p.connector_id,currency:p.currency,result:f.result,amountMinor:amount.toString(),claimedBeforeMinor:f.submittedMinor,periodEnd:p.ends_on,
  invoices:f.eligible.map(r=>{const n=numbers.find(x=>x.id===r.id);return {id:r.id,number:n?.supplier_invoice_number||n?.bill_number||r.bill_number,issueDate:r.issue_date,netMinor:r.net_minor,quantity:r.quantity};})};
 snapshot.words=await words(c,ctx,p,snapshot);
 await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'supplier-benefit-claim:'+id,Buffer.byteLength(JSON.stringify(snapshot))+4096,{finished:true});
 await c.query(`INSERT INTO stockchief_runtime.agent_supplier_benefit_claims(id,workspace_id,program_id,request_key,source_fingerprint,source_snapshot,amount_minor,external_reference,status,origin,automatic,recorded_by)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PREPARED','prepared',$9,$10)`,[id,ctx.workspaceId,p.id,'prepared:'+id,evidence(f),JSON.stringify(snapshot),amount.toString(),reference,automatic,ctx.actorId]);
 await audit(c,ctx,{action:'Supplier rebate claim prepared',reference:id,after:{programId:p.id,reference,amountMinor:amount.toString(),currency:p.currency,automatic}});
 return row(c,ctx.workspaceId,id);
}
async function authority(c,workspaceId,g){
 const ctx={workspaceId,actorId:g.actorId};await benefits().owner(c,ctx);
 if(g.kind!==kind)throw new ValidationError('This message is not a rebate claim.');
 const account=await policy.requireWorkspaceJob(c,workspaceId,97,'draft'),claim=await row(c,workspaceId,g.claimId),p=await benefits().get(c,workspaceId,g.programId),snap=claim.source_snapshot;
 if(claim.program_id!==p.id||!['PREPARED','SENDING'].includes(claim.status)||claim.source_fingerprint!==g.evidence||!p.enabled||p.connector_id!==snap.connectorId)throw new ValidationError('This rebate claim or its agreement changed. Review it again before sending.');
 const f=await benefits().factsForDefinition(c,ctx,p);if(evidence(f)!==claim.source_fingerprint)throw new ValidationError('The purchases behind this claim changed. Discard it and prepare a new claim.');
 const others=f.claims.filter(x=>x.id!==claim.id&&x.status!=='WITHDRAWN').reduce((sum,x)=>sum+BigInt(x.amount_minor),0n);
 if(others+BigInt(claim.amount_minor)>BigInt(f.result.potentialBenefitMinor))throw new ValidationError('This claim is more than the rebate still unclaimed.');
 const stop=await policy.stopped(c,workspaceId,account,action,Boolean(g.automatic));if(stop)throw new ValidationError(stop);
 if(g.automatic){
  policy.requireJob(account.plan,97,'automatic');
  if(p.authorized_by!==ctx.actorId||!p.claim_limit_minor||BigInt(claim.amount_minor)>BigInt(p.claim_limit_minor))throw new ValidationError('This claim is over your automatic claim limit. Approve it yourself.');
  if(!(await require('../autopilot/postgres-service').getState(c,workspaceId)).canAutomate)throw new ValidationError('Automatic work is paused.');
 }else if(g.manualApproval!==true||claim.reviewed_by!==ctx.actorId||!claim.reviewed_at)throw new ValidationError('Approve this exact claim before it is sent.');
 const fresh=await words(c,ctx,p,snap);if(hash(fresh)!==hash(snap.words))throw new ValidationError('The supplier’s email address or the claim wording changed. Prepare a new claim.');
 if(claim.communication_id){const m=(await c.query('SELECT recipient,connector_id,subject,body FROM supplier_communications WHERE workspace_id=$1 AND id=$2',[workspaceId,claim.communication_id])).rows[0];
  if(!m||m.recipient.toLowerCase()!==snap.words.recipient||m.connector_id!==snap.connectorId||m.subject!==snap.words.subject||m.body!==snap.words.body)throw new ValidationError('The queued claim no longer matches the approved wording and recipient.');}
 return claim;
}
async function deliveryAuthority(...args){try{return await authority(...args);}catch(e){if([400,402,403,404,422].includes(e.status)){e.code='claim_needs_review';e.retryable=false;}throw e;}}
async function queue(c,ctx,claim,p,{automatic=false}={}){
 const g={kind,actorId:ctx.actorId,programId:p.id,claimId:claim.id,evidence:claim.source_fingerprint,automatic,manualApproval:!automatic};
 await authority(c,ctx.workspaceId,g);const w=claim.source_snapshot.words;
 const result=await require('../connections/postgres-outbound-mail').queueInTransaction(c,ctx,{recipientKind:'supplier',recipientId:p.supplier_id,recipientEmail:w.recipient,connectorId:p.connector_id,subject:w.subject,body:w.body,standingAuthority:g},
  'supplier-benefit-claim:'+claim.id+':'+claim.revision,{agentRequested:true,agentJob:97});
 await c.query("UPDATE stockchief_runtime.agent_supplier_benefit_claims SET status='SENDING',communication_id=$3,automatic=$4,problem=NULL WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,claim.id,result.communicationId,automatic]);
 await audit(c,ctx,{action:'Supplier rebate claim queued to send',reference:claim.id,after:{reference:claim.external_reference,amountMinor:claim.amount_minor,automatic,communicationId:result.communicationId}});
 return {claimId:claim.id,...result};
}
async function program(c,ctx,id){await benefits().lockPlan(c,ctx);return benefits().get(c,ctx.workspaceId,id,{lock:true});}
async function prepareClaim(db,ctx,id){return db.transaction(async c=>{const p=await program(c,ctx,id),f=await benefits().factsForDefinition(c,ctx,p);return prepare(c,ctx,p,f,{automatic:false});},{isolation:'SERIALIZABLE',retrySafe:true});}
async function send(db,ctx,id,claimId,input={}){
 return db.transaction(async c=>{
  const p=await program(c,ctx,id),claim=await row(c,ctx.workspaceId,claimId,{lock:true});
  if(claim.program_id!==p.id)throw new NotFoundError('That claim is not part of this agreement.');
  if(claim.status!=='PREPARED')return {claimId,replayed:true};
  if(input.confirmed!=='yes'||input.expectedEvidence!==claim.source_fingerprint)throw new ValidationError('Review this exact claim, amount and email before sending it to the supplier.');
  await c.query('UPDATE stockchief_runtime.agent_supplier_benefit_claims SET reviewed_by=$3,reviewed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,claimId,ctx.actorId]);
  return queue(c,ctx,await row(c,ctx.workspaceId,claimId),p,{automatic:false});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function discard(db,ctx,id,claimId,input={}){
 return db.transaction(async c=>{
  const p=await program(c,ctx,id),claim=await row(c,ctx.workspaceId,claimId,{lock:true});
  if(claim.program_id!==p.id||claim.status!=='PREPARED'||input.confirmed!=='yes')throw new ValidationError('Only a claim that has not been sent can be discarded. Confirm discarding it.');
  await c.query('DELETE FROM stockchief_runtime.agent_supplier_benefit_claims WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,claimId]);
  await audit(c,ctx,{action:'Prepared supplier rebate claim discarded',reference:claimId,before:{reference:claim.external_reference,amountMinor:claim.amount_minor}});return {discarded:true};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
// Moves a queued claim on once the mailbox reports what happened.
async function sync(c,ctx,claim){
 if(claim.status!=='SENDING'||!claim.communication_id)return claim;
 const m=(await c.query(`SELECT m.status,m.sent_at,m.error_message,e.status AS effect_status FROM supplier_communications m
  LEFT JOIN LATERAL(SELECT status FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' ORDER BY e.created_at DESC,e.id DESC LIMIT 1)e ON true
  WHERE m.workspace_id=$1 AND m.id=$2`,[ctx.workspaceId,claim.communication_id])).rows[0];
 if(m?.status==='SENT'){
  const day=(await require('../lib/business-time').forWorkspace(c,ctx.workspaceId,new Date(m.sent_at||Date.now()))).calendarDate;
  await c.query("UPDATE stockchief_runtime.agent_supplier_benefit_claims SET status='SUBMITTED',submitted_on=$3,problem=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND status='SENDING'",[ctx.workspaceId,claim.id,day]);
  await audit(c,ctx,{action:'Supplier rebate claim sent',reference:claim.id,after:{reference:claim.external_reference,submittedOn:day}});
 }else if(m?.effect_status==='AMBIGUOUS')await c.query('UPDATE stockchief_runtime.agent_supplier_benefit_claims SET problem=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,claim.id,'The mailbox did not confirm sending. Check its Sent folder before sending again.']);
 else if(!m||m.status==='FAILED'||m.effect_status==='FAILED'||m.effect_status==='CANCELLED')
  await c.query("UPDATE stockchief_runtime.agent_supplier_benefit_claims SET status='PREPARED',communication_id=NULL,automatic=false,reviewed_by=NULL,reviewed_at=NULL,problem=$3,revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND status='SENDING'",[ctx.workspaceId,claim.id,'The claim was not sent: '+String(m?.error_message||'the mailbox refused it').slice(0,300)]);
 return row(c,ctx.workspaceId,claim.id);
}
const creditSql=`SELECT c.id,c.credit_number,c.credit_date,c.amount_minor::text,c.reason,b.currency FROM accounting_supplier_credits c
 JOIN accounting_supplier_bills b ON b.workspace_id=c.workspace_id AND b.id=c.supplier_bill_id
 JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id AND j.status='POSTED'
 WHERE c.workspace_id=$1 AND c.supplier_id=$2 AND c.credit_date>=$3 AND b.currency=$4
  AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id AND r.status='POSTED')
  AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_benefit_claim_credits l WHERE l.credit_id=c.id)`;
async function link(c,ctx,claim,credit,{automatic}){
 const amount=BigInt(credit.amount_minor),left=BigInt(claim.amount_minor)-BigInt(claim.credited_minor),use=amount<left?amount:left;
 await c.query('INSERT INTO stockchief_runtime.agent_supplier_benefit_claim_credits(credit_id,claim_id,workspace_id,amount_minor,automatic,linked_by) VALUES($1,$2,$3,$4,$5,$6)',[credit.id,claim.id,ctx.workspaceId,use.toString(),automatic,ctx.actorId]);
 const credited=BigInt(claim.credited_minor)+use,done=credited===BigInt(claim.amount_minor);
 await c.query("UPDATE stockchief_runtime.agent_supplier_benefit_claims SET credited_minor=$3,status=CASE WHEN $4 THEN 'CREDITED' ELSE status END,problem=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,claim.id,credited.toString(),done]);
 await audit(c,ctx,{action:'Supplier credit note matched to rebate claim',reference:claim.id,after:{creditId:credit.id,creditNumber:credit.credit_number,amountMinor:use.toString(),creditedMinor:credited.toString(),complete:done,automatic}});
 return row(c,ctx.workspaceId,claim.id);
}
// Finds the supplier's posted credit note that quotes this claim's reference.
async function trackCredits(c,ctx,p,claim){
 if(!['SUBMITTED','ACKNOWLEDGED'].includes(claim.status)||BigInt(claim.credited_minor)>=BigInt(claim.amount_minor))return claim;
 const ref=claim.external_reference.toLowerCase(),credits=(await c.query(creditSql+` AND (strpos(lower(coalesce(c.credit_number,'')),$5)>0 OR strpos(lower(coalesce(c.reason,'')),$5)>0
  OR EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_credit_applications a JOIN stockchief_runtime.agent_supplier_invoice_intakes i ON i.workspace_id=a.workspace_id AND i.id=a.intake_id
   LEFT JOIN connection_email_attachments t ON t.workspace_id=i.workspace_id AND t.id=i.attachment_id LEFT JOIN stockchief_runtime.agent_supplier_invoice_uploads u ON u.workspace_id=i.workspace_id AND u.id=i.source_upload_id
   WHERE a.credit_id=c.id AND strpos(lower(coalesce(t.extracted_text,u.extracted_text,'')),$5)>0)) ORDER BY c.credit_date,c.id LIMIT 20`,[ctx.workspaceId,p.supplier_id,claim.submitted_on,p.currency,ref])).rows;
 let current=claim;
 for(const credit of credits){
  if(BigInt(current.credited_minor)+BigInt(credit.amount_minor)>BigInt(current.amount_minor)){await c.query('UPDATE stockchief_runtime.agent_supplier_benefit_claims SET problem=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,claim.id,'Credit note '+(credit.credit_number||credit.id)+' is more than the rest of this claim. Check it and match it yourself.']);continue;}
  current=await link(c,ctx,current,credit,{automatic:true});if(current.status==='CREDITED')break;
 }
 return current;
}
async function linkCredit(db,ctx,id,claimId,input={}){
 return db.transaction(async c=>{
  const p=await program(c,ctx,id),claim=await row(c,ctx.workspaceId,claimId,{lock:true});
  if(claim.program_id!==p.id||!['SUBMITTED','ACKNOWLEDGED'].includes(claim.status)||input.confirmed!=='yes')throw new ValidationError('Confirm this posted supplier credit note is for this rebate claim.');
  const credit=(await c.query(creditSql+' AND c.id=$5',[ctx.workspaceId,p.supplier_id,claim.submitted_on,p.currency,String(input.creditId||'')])).rows[0];
  if(!credit)throw new ValidationError('Choose a posted credit note from this supplier, dated after the claim and not matched to another claim.');
  return link(c,ctx,claim,credit,{automatic:false});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function credits(db,ctx,p,claim){
 const linked=(await db.query(`SELECT l.credit_id,l.amount_minor::text,l.automatic,c.credit_number,c.credit_date FROM stockchief_runtime.agent_supplier_benefit_claim_credits l JOIN accounting_supplier_credits c ON c.id=l.credit_id WHERE l.workspace_id=$1 AND l.claim_id=$2 ORDER BY c.credit_date,c.id`,[ctx.workspaceId,claim.id])).rows;
 const open=['SUBMITTED','ACKNOWLEDGED'].includes(claim.status)?(await db.query(creditSql+' ORDER BY c.credit_date,c.id LIMIT 50',[ctx.workspaceId,p.supplier_id,claim.submitted_on,p.currency])).rows:[];
 return {linked,open};
}
// One background step for an agreement: follow sent claims, match credit notes,
// and claim a finished period. Ask me first prepares without sending.
async function cycle(c,ctx,p,{ask=false}={}){
 const rows=(await c.query("SELECT *,submitted_on::text FROM stockchief_runtime.agent_supplier_benefit_claims WHERE workspace_id=$1 AND program_id=$2 AND status IN ('SENDING','SUBMITTED','ACKNOWLEDGED') ORDER BY created_at,id",[ctx.workspaceId,p.id])).rows;
 for(const claim of rows){const synced=await sync(c,ctx,claim);await trackCredits(c,ctx,p,synced);}
 const f=await benefits().factsForDefinition(c,ctx,p);
 if(!p.connector_id||!f.claimReady||f.today<=p.ends_on)return {prepared:false};
 const claim=await prepare(c,ctx,p,f,{automatic:!ask});if(claim.replayed)return {prepared:false};
 if(ask)return {prepared:true,sent:false};
 if(!p.claim_limit_minor||BigInt(claim.amount_minor)>BigInt(p.claim_limit_minor)){
  await c.query('UPDATE stockchief_runtime.agent_supplier_benefit_claims SET automatic=false,problem=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,claim.id,p.claim_limit_minor?'This claim is over your automatic claim limit of '+benefits().displayMoney(p.claim_limit_minor,p.currency)+'.':'No automatic claim limit is set, so you approve each claim.']);
  return {prepared:true,sent:false};
 }
 await c.query('SAVEPOINT supplier_benefit_claim_send');
 try{const sent=await queue(c,ctx,claim,p,{automatic:true});await c.query('RELEASE SAVEPOINT supplier_benefit_claim_send');return {prepared:true,sent:true,communicationId:sent.communicationId};}
 catch(error){
  await c.query('ROLLBACK TO SAVEPOINT supplier_benefit_claim_send');await c.query('RELEASE SAVEPOINT supplier_benefit_claim_send');
  if(![400,402,403,404,422].includes(error.status))throw error;
  await c.query('UPDATE stockchief_runtime.agent_supplier_benefit_claims SET automatic=false,problem=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,claim.id,String(error.message).slice(0,500)]);return {prepared:true,sent:false};
 }
}
async function configure(db,ctx,id,input={}){
 return db.transaction(async c=>{
  const p=await program(c,ctx,id);if(p.revision!==Number(input.revision))throw new ValidationError('Reload this agreement before changing its claim settings.');
  const connectorId=String(input.connectorId||'').trim()||null;
  if(connectorId&&!(await c.query("SELECT 1 FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 AND status='connected' AND paused_at IS NULL AND provider_type IN ('gmail','microsoft365')",[ctx.workspaceId,connectorId])).rowCount)throw new ValidationError('Choose a connected Gmail or Microsoft 365 mailbox.');
  const raw=String(input.claimLimit??'').trim(),limit=raw?require('../domain/currency').userToMinor(raw,p.currency,{label:'Automatic claim limit'}):null;if(limit!==null&&limit<=0)throw new ValidationError('Leave the claim limit empty to approve every claim, or enter a positive amount.');
  const percent=Number(input.alertPercent??p.alert_percent);if(!Number.isInteger(percent)||percent<1||percent>50)throw new ValidationError('Choose a tier alert from 1% to 50%.');
  if(input.confirmed!=='yes')throw new ValidationError('Confirm the claim mailbox and limit.');
  if(limit!==null&&p.enabled&&p.claim_limit_minor===null)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
  await c.query('UPDATE stockchief_runtime.agent_supplier_benefit_programs SET connector_id=$3,claim_limit_minor=$4,alert_percent=$5,authorized_by=$6,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,connectorId,limit,percent,ctx.actorId]);
  await audit(c,ctx,{action:'Supplier rebate claim settings saved',reference:id,before:{connectorId:p.connector_id,claimLimitMinor:p.claim_limit_minor,alertPercent:p.alert_percent},after:{connectorId,claimLimitMinor:limit,alertPercent:percent}});return {id};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
// Rebate terms in a supplier email become an offer for a person to check.
async function noticeOffer(db,workspaceId,messageId){
 const m=(await db.query(`SELECT m.id,m.supplier_id,m.subject,m.body_text,m.content_hash,m.classification,m.trust_status,(SELECT string_agg(coalesce(a.extracted_text,''),E'\\n' ORDER BY a.id) FROM connection_email_attachments a WHERE a.workspace_id=m.workspace_id AND a.message_id=m.id AND a.extraction_status='READABLE' AND coalesce(a.external_attachment_id,'') NOT LIKE 'stockchief:%') attached
  FROM connection_email_messages m WHERE m.workspace_id=$1 AND m.id=$2`,[workspaceId,messageId])).rows[0];
 if(!m||m.classification!=='supplier'||!m.supplier_id||m.trust_status!=='TRUSTED')return {skipped:true};
 const text=[m.subject,require('../connections/reply-triage').prose(m.body_text||''),m.attached||''].join('\n'),reader=require('./supplier-rebate-text');if(!reader.RELEVANT.test(text))return {skipped:true};
 const state=await policy.accountState(db,workspaceId);if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,97,'suggest'))return {skipped:true};
 const reading=reader.read(text);if(!reading.relevant||!reading.tiers.length)return {skipped:true};
 const inserted=await db.query('INSERT INTO stockchief_runtime.agent_supplier_benefit_offers(id,workspace_id,supplier_id,message_id,source_hash,reading) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,message_id) DO NOTHING RETURNING id',[newId('benefit-offer'),workspaceId,m.supplier_id,m.id,hash({content:m.content_hash,attached:m.attached||''}),JSON.stringify(reading)]);
 return {offerId:inserted.rows[0]?.id||null};
}
async function offer(db,ctx,id){
 const o=(await db.query(`SELECT o.*,m.sender,m.subject,m.received_at,s.name AS supplier_name,s.currency AS supplier_currency FROM stockchief_runtime.agent_supplier_benefit_offers o JOIN connection_email_messages m ON m.workspace_id=o.workspace_id AND m.id=o.message_id JOIN suppliers s ON s.workspace_id=o.workspace_id AND s.id=o.supplier_id WHERE o.workspace_id=$1 AND o.id=$2`,[ctx.workspaceId,id])).rows[0];
 if(!o)throw new NotFoundError('Those rebate terms are not in this inventory.');return o;
}
function offerInput(o){
 const r=o.reading,period=r.startsOn&&r.endsOn?' '+r.startsOn+' to '+r.endsOn:'';
 return {supplierId:o.supplier_id,title:('Rebate from '+o.supplier_name+period).slice(0,200),sourceReference:('Email from '+o.sender+' on '+String(o.received_at).slice(0,10)+': '+(o.subject||'')).slice(0,500),currency:o.supplier_currency,startsOn:r.startsOn||'',endsOn:r.endsOn||'',claimOn:r.claimOn||'',claimBy:r.claimBy||'',allProducts:'yes',basis:'net_spend',benefit:'percentage',method:r.method||'',tiersText:r.tiers.map(t=>t.threshold+' | '+t.rate).join('\n'),offerId:o.id};
}
async function dismissOffer(db,ctx,id,input={}){
 return db.transaction(async c=>{
  await benefits().owner(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,97,'suggest');const o=await offer(c,ctx,id);
  if(input.confirmed!=='yes')throw new ValidationError('Confirm you do not want to track these terms.');if(o.status!=='OPEN')return {replayed:true};
  await c.query("UPDATE stockchief_runtime.agent_supplier_benefit_offers SET status='DISMISSED',decided_by=$3,decided_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,ctx.actorId]);
  await audit(c,ctx,{action:'Supplier rebate terms from email not tracked',reference:id});return {dismissed:true};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function inbox(db,workspaceId,{canTrack}){
 const offers=(await db.query("SELECT o.id,o.created_at,s.name FROM stockchief_runtime.agent_supplier_benefit_offers o JOIN suppliers s ON s.workspace_id=o.workspace_id AND s.id=o.supplier_id WHERE o.workspace_id=$1 AND o.status='OPEN' ORDER BY o.created_at,o.id LIMIT 25",[workspaceId])).rows.map(o=>({kind:'purchasing',importance:'Needs You',priority:70,
  title:'Check rebate terms from '+o.name,happened:'A supplier email describes rebate or volume-discount tiers.',why:'Accepting supplier terms always needs you. StockChief read the tiers it could; check them against the email.',recommendation:'Open the terms, correct anything missing, then track or estimate them.',
  href:'/autopilot/supplier-benefits?offer='+encodeURIComponent(o.id),actionLabel:'Check rebate terms',sourceId:'supplier-benefit-offer:'+o.id,createdAt:o.created_at,at:o.created_at}));
 if(!canTrack)return offers;
 const today=await require('../lib/business-time').today(db,workspaceId);
 const claims=(await db.query(`SELECT c.id,c.program_id,c.external_reference,c.status,c.problem,c.submitted_on::text,c.created_at,p.title,e.status AS effect_status FROM stockchief_runtime.agent_supplier_benefit_claims c
  JOIN stockchief_runtime.agent_supplier_benefit_programs p ON p.workspace_id=c.workspace_id AND p.id=c.program_id
  LEFT JOIN LATERAL(SELECT status FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=c.workspace_id AND e.aggregate_id=c.communication_id AND e.kind='mail.outbound.send' ORDER BY e.created_at DESC,e.id DESC LIMIT 1)e ON true
  WHERE c.workspace_id=$1 AND c.origin='prepared' AND (c.status='PREPARED' OR c.status='SENDING' AND e.status='AMBIGUOUS'
   OR c.status IN ('SUBMITTED','ACKNOWLEDGED') AND (c.problem IS NOT NULL OR c.submitted_on<=($2::date-$3::int)))
  ORDER BY c.created_at,c.id LIMIT 50`,[workspaceId,today,FOLLOW_UP_DAYS])).rows;
 return offers.concat(claims.map(c=>({kind:'purchasing',importance:'Needs You',priority:c.effect_status==='AMBIGUOUS'?90:c.status==='PREPARED'?74:68,
  title:(c.status==='PREPARED'?'Approve rebate claim ':c.effect_status==='AMBIGUOUS'?'Check rebate claim was sent: ':'No credit note yet for rebate claim ')+c.external_reference,
  happened:c.status==='PREPARED'?'StockChief prepared the claim for '+c.title+'.':c.status==='SENDING'?'The mailbox did not confirm sending.':'The supplier has not sent a credit note for this claim.',
  why:c.problem||(c.status==='PREPARED'?'Check the amount and the email before it goes to the supplier.':'Follow up with the supplier, or match a posted credit note yourself.'),
  recommendation:'Open the agreement to review the claim.',href:'/autopilot/supplier-benefits/'+c.program_id+'#claims',actionLabel:'Review rebate claim',sourceId:'supplier-benefit-claim:'+c.id,createdAt:c.created_at,at:c.created_at})));
}
module.exports={kind,action,evidence,prepare,prepareClaim,send,discard,sync,trackCredits,linkCredit,credits,cycle,configure,authority,deliveryAuthority,noticeOffer,offer,offerInput,dismissOffer,inbox,FOLLOW_UP_DAYS};
