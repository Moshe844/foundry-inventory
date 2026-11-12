'use strict';
// Job 45 follow-through. Once the mailbox accepts a claim, StockChief follows
// it until it is settled:
//  - the supplier's reply in the claim's email thread;
//  - posted supplier credits that name the claim reference or that the owner
//    links. These are the same posted credit notes jobs 105 and 115 record; a
//    credit already applied to a tracked supplier return never counts here;
//  - replacement goods received on the short order line after the claim was
//    sent, or a later receipt of the same product that the owner links;
//  - an outcome the owner records: refund received, supplier declined, or
//    claim withdrawn.
// The position is read from those records each time, so watching a claim
// changes nothing. A claim with no answer gets up to two reminders. A
// reminder is a supplier email: it goes alone only under the owner's claim
// rule and current routine authority, otherwise it waits in Needs you.
const {ValidationError,NotFoundError}=require('../domain/errors'),{newId}=require('../lib/util');
const money=require('../domain/currency'),exact=require('../domain/exact-quantity'),{hash}=require('../pricing/postgres-promotions');
const source=require('./supplier-claim-source');
const MAX_CHASES=2,DEFAULT_CHASE_DAYS=7,DAY=86400000;
const OUTCOMES=Object.freeze({REFUNDED:'Refund received',DECLINED:'Supplier declined',WITHDRAWN:'Claim withdrawn'});
const claims=()=>require('./agent-supplier-claims');
const businessError=e=>[400,402,403,404,422].includes(e?.status);

function chaseDays(value){
 if(value===undefined||value===null||value==='')return DEFAULT_CHASE_DAYS;
 const text=String(value);if(!/^\d{1,2}$/.test(text)||Number(text)<1||Number(text)>60)throw new ValidationError('Choose a reminder delay from 1 to 60 days.');
 return Number(text);
}
async function message(db,workspaceId,id){
 return (await db.query(`SELECT id,status,sent_at,external_message_id,external_thread_id,connector_id,recipient,subject,body,error_message
  FROM supplier_communications WHERE workspace_id=$1 AND id=$2`,[workspaceId,id])).rows[0]||null;
}
const accepted=m=>Boolean(m&&m.status==='SENT'&&m.external_message_id&&m.sent_at);
function measureOf(p){return p.claimKind==='shortage'&&p.missingWeight!=null?p.missingWeight:String(source.units(p));}
function smaller(a,b){return exact.atoms(exact.canonical(a),6)<=exact.atoms(exact.canonical(b),6)?exact.canonical(a):exact.canonical(b);}

async function position(db,ctx,r,{now=Date.now()}={}){
 const p=r.snapshot,m=r.communication_id?await message(db,ctx.workspaceId,r.communication_id):null;
 const chases=(await db.query(`SELECT c.id,c.number,c.automatic,c.approved_by,c.created_at,m.id AS communication_id,m.status,m.sent_at,
   m.external_message_id,m.external_thread_id,m.error_message FROM stockchief_runtime.agent_supplier_claim_chases c
   JOIN supplier_communications m ON m.workspace_id=c.workspace_id AND m.id=c.communication_id
   WHERE c.workspace_id=$1 AND c.claim_id=$2 ORDER BY c.number`,[ctx.workspaceId,r.id])).rows;
 const days=r.chase_after_days||DEFAULT_CHASE_DAYS,base={claimId:r.id,remedy:p.remedy||null,totalMinor:p.totalMinor,currency:p.currency,
  chases,chaseAfterDays:days,replies:[],credits:[],replacements:[],creditedMinor:0,replaced:'0',replacedMinor:0,remainingMinor:p.totalMinor,
  outcome:r.outcome||null,outcomeDetail:r.outcome_detail||null,sentAt:null,nextChaseAt:null,chaseDue:false,exhausted:false,pendingChase:false};
 if(!accepted(m))return {...base,state:r.communication_id?'SENDING':'DRAFT'};
 const sentAt=new Date(m.sent_at).toISOString();
 const threads=[...new Set([m.external_thread_id,...chases.map(c=>c.external_thread_id)].filter(Boolean))];
 const ours=[m.external_message_id,...chases.map(c=>c.external_message_id)].filter(Boolean);
 const replies=threads.length?(await db.query(`SELECT id,subject,sender,received_at FROM connection_email_messages
   WHERE workspace_id=$1 AND connector_id=$2 AND supplier_id=$3 AND external_thread_id=ANY($4::text[]) AND lower(sender)=lower($5)
    AND trust_status='TRUSTED' AND received_at::timestamptz>=$6::timestamptz AND NOT (external_message_id=ANY($7::text[]))
    AND lower(coalesce(subject,'')) !~ '(automatic reply|auto-reply|out of office|undeliverable|delivery failure)'
   ORDER BY received_at::timestamptz,id LIMIT 20`,[ctx.workspaceId,m.connector_id,p.supplierId,threads,m.recipient,sentAt,ours])).rows:[];
 // Credits linked by the owner, or posted credits whose number or reason names
 // exactly this claim's reference and no other claim.
 const credits=(await db.query(`SELECT c.id,c.credit_number,c.credit_date,c.amount_minor,c.reason,b.currency,b.bill_number,s.id AS settlement_id,
   j.status AS journal_status,a.supplier_return_id,
   EXISTS(SELECT 1 FROM accounting_journal_entries v WHERE v.workspace_id=j.workspace_id AND v.reversal_of_entry_id=j.id AND v.status='POSTED') AS reversed,
   (SELECT count(*)::int FROM stockchief_runtime.agent_supplier_claims x WHERE x.workspace_id=c.workspace_id
     AND position(lower(x.reference) IN lower(coalesce(c.credit_number,'')||' '||coalesce(c.reason,'')))>0) AS named_claims
  FROM accounting_supplier_credits c
  JOIN accounting_supplier_bills b ON b.workspace_id=c.workspace_id AND b.id=c.supplier_bill_id
  LEFT JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id
  LEFT JOIN stockchief_runtime.agent_supplier_credit_applications a ON a.workspace_id=c.workspace_id AND a.credit_id=c.id
  LEFT JOIN stockchief_runtime.agent_supplier_claim_settlements s ON s.workspace_id=c.workspace_id AND s.credit_id=c.id
  WHERE c.workspace_id=$1 AND c.supplier_id=$2 AND (s.claim_id=$3 OR s.id IS NULL
    AND position(lower($4) IN lower(coalesce(c.credit_number,'')||' '||coalesce(c.reason,'')))>0)
  ORDER BY c.created_at,c.id LIMIT 50`,[ctx.workspaceId,p.supplierId,r.id,r.reference])).rows
  .map(c=>({...c,linked:Boolean(c.settlement_id),valid:c.journal_status==='POSTED'&&!c.reversed&&c.currency===p.currency&&!c.supplier_return_id&&(Boolean(c.settlement_id)||c.named_claims===1)}));
 const creditedMinor=money.sum(credits.filter(c=>c.valid).map(c=>Number(c.amount_minor)));
 // Replacement goods: receipt lines the owner linked, and for a shortage the
 // goods received later on the same order line.
 const replacements=(await db.query(`SELECT rl.id,rl.quantity_units::text AS quantity,rl.secondary_quantity::text AS secondary_quantity,
   r.received_at,r.reference,o.po_number,s.id AS settlement_id
  FROM purchase_order_receipt_lines rl JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id
  JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id
  LEFT JOIN stockchief_runtime.agent_supplier_claim_settlements s ON s.workspace_id=rl.workspace_id AND s.receipt_line_id=rl.id
  WHERE rl.workspace_id=$1 AND (s.claim_id=$2 OR s.id IS NULL AND $3::text IS NOT NULL AND rl.purchase_order_line_id=$3
    AND r.received_at::timestamptz>$4::timestamptz AND r.created_at::timestamptz>$4::timestamptz)
  ORDER BY r.received_at,rl.id LIMIT 50`,[ctx.workspaceId,r.id,p.claimKind==='shortage'?p.lineId:null,sentAt])).rows;
 const measured=p.claimKind==='shortage'&&p.missingWeight!=null;
 let replaced=replacements.reduce((n,x)=>exact.add(n,measured?x.secondary_quantity||'0':x.quantity),'0');
 replaced=smaller(replaced,measureOf(p));
 const replacedMinor=exact.costMinor(replaced,p.unitCostMinor);
 const remainingMinor=Math.max(0,Number(p.totalMinor)-creditedMinor-replacedMinor);
 const state=r.outcome?'CLOSED':remainingMinor===0?'SETTLED':creditedMinor>0||replacedMinor>0?'PART_SETTLED':replies.length?'REPLIED':'WAITING';
 const last=Math.max(Date.parse(sentAt),...chases.map(c=>Date.parse(c.sent_at||c.created_at)));
 const pendingChase=chases.some(c=>!['SENT','FAILED'].includes(c.status)),nextChaseAt=new Date(last+days*DAY).toISOString();
 const ready=state==='WAITING'&&!pendingChase&&now>=last+days*DAY;
 return {...base,state,sentAt,replies,credits,creditedMinor,replacements,replaced,replacedMinor,remainingMinor,nextChaseAt,pendingChase,
  chaseDue:ready&&chases.length<MAX_CHASES,exhausted:ready&&chases.length>=MAX_CHASES};
}

// The claim rule that may send a reminder alone: the claim's own rule, or an
// enabled rule of the same owner covering exactly this claim's scope.
async function standing(c,ctx,r){
 const profileHash=hash(source.profile(r.snapshot));
 const row=(await c.query(`SELECT * FROM stockchief_runtime.agent_supplier_claim_rules WHERE workspace_id=$1 AND enabled AND authorized_by=$2
  AND profile_hash=$3 AND coalesce(scope->>'claimKind','damage')=$4 ORDER BY (id=$5) DESC,created_at DESC,id DESC LIMIT 1 FOR SHARE`,
 [ctx.workspaceId,ctx.actorId,profileHash,r.snapshot.claimKind==='shortage'?'shortage':'damage',r.rule_id||''])).rows[0];
 if(!row)return null;
 if(Number(source.units(r.snapshot))>Number(row.scope.maxShortUnits??row.max_units)||BigInt(r.snapshot.totalMinor)>BigInt(row.max_value_minor))return null;
 return row;
}

async function queueChase(c,ctx,r,pos,saved=null){
 const number=pos.chases.length+1,id=newId('claim-chase'),p=r.snapshot,words=source.composeChase(p,{number,sentAt:pos.sentAt});
 const g={kind:'supplier_claim',actorId:ctx.actorId,claimId:r.id,sourceFingerprint:r.source_fingerprint,chaseId:id,chaseNumber:number,
  automatic:Boolean(saved),manualApproval:!saved,...(saved?{ruleId:saved.id,ruleRevision:saved.revision}:{})};
 const result=await require('../connections/postgres-outbound-mail').queueInTransaction(c,ctx,{recipientKind:'supplier',recipientId:p.supplierId,
  recipientEmail:p.recipient,connectorId:p.connectorId,...words,standingAuthority:g},'supplier-claim-chase:'+r.id+':'+number,{agentRequested:true,agentJob:45});
 const inserted=await c.query(`INSERT INTO stockchief_runtime.agent_supplier_claim_chases(id,workspace_id,claim_id,number,communication_id,automatic,rule_id,rule_revision,approved_by)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(claim_id,number) DO NOTHING RETURNING id`,
 [id,ctx.workspaceId,r.id,number,result.communicationId,Boolean(saved),saved?.id||null,saved?.revision||null,ctx.actorId]);
 if(!inserted.rowCount)return {claimId:r.id,number,communicationId:result.communicationId,replayed:true};
 await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'supplier-claim-chase:'+id,Buffer.byteLength(words.body)+2048,{finished:true});
 await require('../operations/postgres-security-audit').record(c,ctx,{action:saved?'Supplier claim reminder queued under the owner’s claim rule':'Supplier claim reminder approved',
  reference:r.reference,after:{claimId:r.id,chaseId:id,number,communicationId:result.communicationId,automatic:Boolean(saved),ruleId:saved?.id||null}});
 return {claimId:r.id,chaseId:id,number,communicationId:result.communicationId,replayed:false};
}

// The owner sends a reminder now, with one tap.
async function chase(db,ctx,id,input){return db.transaction(async c=>{
 const r=await claims().claim(c,ctx,id,true);await source.access(c,ctx,{});
 const pos=await position(c,ctx,r);
 if(input.confirmed!=='yes'||Number(input.number)!==pos.chases.length+1)throw new ValidationError('Reload this claim and confirm the reminder.');
 if(pos.state!=='WAITING'||pos.pendingChase)throw new ValidationError('This claim already has a reply, a settlement or a reminder on its way.');
 if(pos.chases.length>=MAX_CHASES)throw new ValidationError('Two reminders were already sent. Contact the supplier directly.');
 return queueChase(c,ctx,r,pos);
},{isolation:'SERIALIZABLE',retrySafe:true});}

// Checked again just before the reminder reaches the provider.
async function chaseAuthority(c,workspaceId,g){
 const ctx={workspaceId,actorId:g.actorId},r=await claims().claim(c,ctx,g.claimId),p=r.snapshot;
 const row=(await c.query('SELECT * FROM stockchief_runtime.agent_supplier_claim_chases WHERE workspace_id=$1 AND id=$2 AND claim_id=$3',[workspaceId,g.chaseId,r.id])).rows[0];
 if(!row||row.number!==g.chaseNumber||g.sourceFingerprint!==r.source_fingerprint||row.approved_by!==ctx.actorId||row.automatic!==Boolean(g.automatic))
  throw new ValidationError('Review this exact claim reminder.');
 if(g.automatic){
  const saved=await claims().rule(c,ctx,g.ruleId);
  if(!saved.enabled||saved.revision!==g.ruleRevision||saved.authorized_by!==ctx.actorId||saved.profile_hash!==hash(source.profile(p)))
   throw new ValidationError('The claim rule changed. Review this reminder.');
  await source.access(c,ctx,{automatic:true,trained:Boolean(saved.example_id)});
 }else{if(g.manualApproval!==true)throw new ValidationError('Approve this reminder individually.');await source.access(c,ctx,{});}
 const contact=(await c.query("SELECT email FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[workspaceId,p.supplierId])).rows[0];
 if(!contact||String(contact.email||'').toLowerCase()!==String(p.recipient).toLowerCase())throw new ValidationError('The supplier email changed. Review this claim before any reminder.');
 const pos=await position(c,ctx,r);
 if(pos.state!=='WAITING')throw new ValidationError('The supplier answered or the claim is settled, so this reminder was not sent.');
 const m=await message(c,workspaceId,row.communication_id),words=source.composeChase(p,{number:row.number,sentAt:pos.sentAt});
 if(!m||m.recipient!==p.recipient||m.connector_id!==p.connectorId||m.subject!==words.subject||m.body!==words.body)throw new ValidationError('The queued reminder no longer matches its claim.');
 return r;
}

// Posted credits of this supplier and later receipts of this product that the
// owner can link. Credits on tracked supplier returns are left out.
async function candidates(db,ctx,r,pos){
 if(!pos.sentAt||pos.state==='CLOSED')return {credits:[],receipts:[]};
 const p=r.snapshot;
 const credits=(await db.query(`SELECT c.id,c.credit_number,c.credit_date,c.amount_minor,b.bill_number FROM accounting_supplier_credits c
  JOIN accounting_supplier_bills b ON b.workspace_id=c.workspace_id AND b.id=c.supplier_bill_id AND b.currency=$3
  JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id AND j.status='POSTED'
  WHERE c.workspace_id=$1 AND c.supplier_id=$2
   AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries v WHERE v.workspace_id=j.workspace_id AND v.reversal_of_entry_id=j.id AND v.status='POSTED')
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_claim_settlements s WHERE s.workspace_id=c.workspace_id AND s.credit_id=c.id)
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_credit_applications a WHERE a.workspace_id=c.workspace_id AND a.credit_id=c.id AND a.supplier_return_id IS NOT NULL)
  ORDER BY c.created_at DESC,c.id DESC LIMIT 25`,[ctx.workspaceId,p.supplierId,p.currency])).rows.filter(c=>!pos.credits.some(x=>x.id===c.id));
 const receipts=(await db.query(`SELECT rl.id,rl.quantity_units::text AS quantity,r.received_at,r.reference,o.po_number FROM purchase_order_receipt_lines rl
  JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id
  JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id AND o.supplier_id=$2
  WHERE rl.workspace_id=$1 AND rl.sku_id=$3 AND r.received_at::timestamptz>$4::timestamptz
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_claim_settlements s WHERE s.workspace_id=rl.workspace_id AND s.receipt_line_id=rl.id)
  ORDER BY r.received_at DESC,rl.id DESC LIMIT 25`,[ctx.workspaceId,p.supplierId,p.skuId,pos.sentAt])).rows.filter(x=>!pos.replacements.some(y=>y.id===x.id));
 return {credits,receipts};
}

// The owner links a posted credit or a replacement receipt to the claim.
async function link(db,ctx,id,input){return db.transaction(async c=>{
 const r=await claims().claim(c,ctx,id,true);await source.owner(c,ctx);await require('../commercial/agent-plan').requireWorkspaceJob(c,ctx.workspaceId,45,'draft');
 const pos=await position(c,ctx,r);
 if(!pos.sentAt)throw new ValidationError('Send the claim before linking a credit note or replacement goods.');
 if(pos.state==='CLOSED')throw new ValidationError('This claim is closed.');
 const creditId=input.creditId?String(input.creditId):null,receiptLineId=input.receiptLineId?String(input.receiptLineId):null;
 if(Boolean(creditId)===Boolean(receiptLineId)||input.confirmed!=='yes')throw new ValidationError('Choose one posted credit note or one replacement receipt line, and confirm it belongs to this claim.');
 const prior=(await c.query('SELECT claim_id FROM stockchief_runtime.agent_supplier_claim_settlements WHERE workspace_id=$1 AND (credit_id=$2 OR receipt_line_id=$3)',[ctx.workspaceId,creditId,receiptLineId])).rows[0];
 if(prior){if(prior.claim_id===r.id)return {claimId:r.id,replayed:true};throw new ValidationError('That record already settles another claim.');}
 const open=await candidates(c,ctx,r,pos);
 if(creditId&&!open.credits.some(x=>x.id===creditId)||receiptLineId&&!open.receipts.some(x=>x.id===receiptLineId))
  throw new ValidationError(creditId?'Choose a posted credit from this supplier, in the claim currency, that is not used for a return or another claim.':'Choose a receipt of this product from this supplier received after the claim was sent.');
 const sid=newId('claim-settlement');
 await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'supplier-claim-settlement:'+sid,2048,{finished:true});
 await c.query('INSERT INTO stockchief_runtime.agent_supplier_claim_settlements(id,workspace_id,claim_id,credit_id,receipt_line_id,linked_by) VALUES($1,$2,$3,$4,$5,$6)',
  [sid,ctx.workspaceId,r.id,creditId,receiptLineId,ctx.actorId]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:creditId?'Supplier credit linked to claim':'Replacement goods linked to claim',reference:r.reference,after:{claimId:r.id,creditId,receiptLineId}});
 return {claimId:r.id,settlementId:sid,replayed:false};
},{isolation:'SERIALIZABLE',retrySafe:true});}

// The owner closes a claim: refund received, supplier declined, or withdrawn.
async function close(db,ctx,id,input){return db.transaction(async c=>{
 const r=await claims().claim(c,ctx,id,true);await source.owner(c,ctx);await require('../commercial/agent-plan').requireWorkspaceJob(c,ctx.workspaceId,45,'draft');
 const outcome=String(input.outcome||'');
 if(r.outcome){if(r.outcome===outcome)return {claimId:r.id,replayed:true};throw new ValidationError('This claim is already closed.');}
 const pos=await position(c,ctx,r);
 if(!pos.sentAt)throw new ValidationError('Only a sent claim can be closed here. An unsent draft is simply not sent.');
 if(!Object.hasOwn(OUTCOMES,outcome)||input.confirmed!=='yes')throw new ValidationError('Choose how this claim ended and confirm it.');
 const note=String(input.note||'').trim();if(note.length>500)throw new ValidationError('Keep the note to 500 characters.');
 const detail={note,remainingMinor:pos.remainingMinor};
 if(outcome==='REFUNDED'){
  const amount=money.userToMinor(String(input.amount||''),r.snapshot.currency,{label:'Refund received'}),reference=String(input.reference||'').trim();
  if(amount<=0||!reference||reference.length>120)throw new ValidationError('Enter the refund amount and the supplier’s payment reference.');
  Object.assign(detail,{amountMinor:amount,reference});
 }
 await c.query('UPDATE stockchief_runtime.agent_supplier_claims SET outcome=$3,outcome_detail=$4,outcome_by=$5,outcome_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',
  [ctx.workspaceId,r.id,outcome,JSON.stringify(detail),ctx.actorId]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier claim closed: '+OUTCOMES[outcome].toLowerCase(),reference:r.reference,after:{claimId:r.id,outcome,...detail,moneyPosted:false}});
 return {claimId:r.id,outcome,replayed:false};
},{isolation:'SERIALIZABLE',retrySafe:true});}

// The owner changes when an unanswered claim gets its next reminder.
async function schedule(db,ctx,id,input){return db.transaction(async c=>{
 const r=await claims().claim(c,ctx,id,true);await source.access(c,ctx,{});const days=chaseDays(input.chaseAfterDays);
 await c.query('UPDATE stockchief_runtime.agent_supplier_claims SET chase_after_days=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,r.id,days]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier claim reminder delay changed',reference:r.reference,before:{chaseAfterDays:r.chase_after_days},after:{chaseAfterDays:days}});
 return {claimId:r.id,chaseAfterDays:days};
},{isolation:'SERIALIZABLE',retrySafe:true});}

// The routine: for each accepted, open claim whose reminder is due, send it
// alone when the owner's claim rule and routine authority allow; otherwise the
// reminder waits in Needs you.
async function run(db,workspaceId,{limit=40}={}){
 const rows=(await db.query(`SELECT c.id,c.prepared_by FROM stockchief_runtime.agent_supplier_claims c
  JOIN supplier_communications m ON m.workspace_id=c.workspace_id AND m.id=c.communication_id
  WHERE c.workspace_id=$1 AND c.outcome IS NULL AND m.status='SENT' AND nullif(m.external_message_id,'') IS NOT NULL
  ORDER BY c.created_at,c.id LIMIT $2`,[workspaceId,limit])).rows;
 const results=[];
 for(const row of rows){
  const ctx={workspaceId,actorId:row.prepared_by};
  try{results.push(await db.transaction(async c=>{
   const r=await claims().claim(c,ctx,row.id,true),pos=await position(c,ctx,r);
   if(!pos.chaseDue)return {claimId:r.id,state:pos.state,exhausted:pos.exhausted};
   const saved=await standing(c,ctx,r);
   if(!saved)return {claimId:r.id,state:pos.state,needsPerson:'A reminder is due. Claims outside a claim rule need your approval for each reminder.'};
   try{await source.access(c,ctx,{automatic:true,trained:Boolean(saved.example_id)});}
   catch(e){if(!businessError(e))throw e;return {claimId:r.id,state:pos.state,needsPerson:e.message};}
   return {...await queueChase(c,ctx,r,pos,saved),state:pos.state};
  },{isolation:'SERIALIZABLE',retrySafe:true}));}
  catch(e){if(!businessError(e))throw e;results.push({claimId:row.id,needsPerson:e.message});}
 }
 return {results};
}
module.exports={position,chase,chaseAuthority,candidates,link,close,schedule,run,chaseDays,OUTCOMES,MAX_CHASES,DEFAULT_CHASE_DAYS};
