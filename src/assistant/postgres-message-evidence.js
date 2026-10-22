'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors');
async function read(database,ctx,{search=null,offset=0}={}){
 offset=Number(offset);if(!Number.isSafeInteger(offset)||offset<0||offset>1000000)throw new ValidationError('Choose a valid message page offset.');
 const actor=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!actor)throw new AuthorizationError('Current business membership is required.');
 require('../actions/permissions').assertCan(actor,require('../actions/permissions').VIEW,'read business messages');
 const result=await database.query(`WITH records AS (
  SELECT 'supplier_communication'::text source_type,'supplier'::text recipient_kind,c.id,c.workspace_id,
   CASE WHEN c.status='SENT' THEN 'sent supplier email' WHEN c.status='PREPARED' THEN 'draft supplier email' ELSE 'outgoing supplier email' END kind,
   c.recipient,c.subject,left(c.body,2000) body,c.status,
   CASE WHEN c.approved_at IS NOT NULL THEN 'Sending approval recorded' WHEN c.status='PREPARED' THEN 'Prepared; no sending approval recorded here' ELSE 'Approval evidence not recorded here' END approval_stage,
   c.external_message_id,coalesce(c.sent_at,c.approved_at,c.created_at) at,'/messages/supplier/'||c.id href
   FROM supplier_communications c WHERE c.workspace_id=$1
  UNION ALL
  SELECT 'customer_communication',CASE WHEN c.customer_id IS NOT NULL THEN 'customer' ELSE 'customer_or_address' END,c.id,c.workspace_id,
   CASE WHEN c.customer_id IS NULL THEN CASE WHEN c.status='SENT' THEN 'sent business email' WHEN c.status='PREPARED' THEN 'draft business email' ELSE 'outgoing business email' END
    ELSE CASE WHEN c.status='SENT' THEN 'sent customer email' WHEN c.status='PREPARED' THEN 'draft customer email' ELSE 'outgoing customer email' END END,
   c.recipient,c.subject,left(c.body,2000),c.status,
   CASE WHEN c.approved_at IS NOT NULL THEN 'Sending approval recorded' WHEN c.status='PREPARED' THEN 'Prepared; no sending approval recorded here' ELSE 'Approval evidence not recorded here' END,
   c.external_message_id,coalesce(c.sent_at,c.approved_at,c.created_at),'/messages/customer/'||c.id
   FROM customer_communications c WHERE c.workspace_id=$1
  UNION ALL
  SELECT 'received','unclassified',m.id,m.workspace_id,'received business email',m.sender,m.subject,left(m.body_text,2000),m.reply_state,
   'Incoming email; not an outgoing approval',NULL::text,m.received_at,'/mail/'||m.id
   FROM connection_email_messages m WHERE m.workspace_id=$1
  UNION ALL
  SELECT 'attachment','unclassified',a.id,a.workspace_id,'saved incoming email attachment',m.sender,a.filename,
   ''::text,a.extraction_status,'Document evidence only; not a posted bill, payment or physical receipt',
   NULL::text,m.received_at,'/mail/'||m.id||'/attachments/'||a.id||'/text'
   FROM connection_email_attachments a JOIN connection_email_messages m ON m.workspace_id=a.workspace_id AND m.id=a.message_id
   WHERE a.workspace_id=$1
  UNION ALL
  SELECT 'reply_draft','unclassified',m.id,m.workspace_id,'draft reply',m.sender,coalesce(m.draft_subject,m.subject),left(m.draft_body,2000),coalesce(o.status,'DRAFT'),
   CASE WHEN o.id IS NULL THEN 'Prepared; no sending approval recorded here' ELSE 'Sending authorization recorded' END,
   NULL::text,coalesce(m.draft_at,m.received_at),'/mail/'||m.id
   FROM connection_email_messages m LEFT JOIN LATERAL (SELECT id,status FROM stockchief_runtime.email_reply_outbox e
    WHERE e.workspace_id=m.workspace_id AND e.message_id=m.id ORDER BY e.started_at DESC,e.id DESC LIMIT 1) o ON true
   WHERE m.workspace_id=$1 AND m.draft_body IS NOT NULL AND trim(m.draft_body)<>'' AND m.reply_sent_at IS NULL
  UNION ALL
  SELECT 'proposal',coalesce(p.payload->>'recipientKind','unclassified'),p.id,p.workspace_id,'prepared business email proposal',
   p.payload->>'recipientEmail',p.payload->>'subject',left(p.payload->>'body',2000),p.status,
   'Prepared action; proposal state alone does not establish sending approval',NULL::text,p.created_at::text,'/actions/'||p.id
   FROM stockchief_runtime.assistant_action_proposals p WHERE p.workspace_id=$1 AND p.actor_user_id=$3
    AND p.action_type='communication.send_email' AND p.status IN ('PENDING','EXECUTING')
 ), enriched AS (
  SELECT r.*,e.status provider_state,
   coalesce(r.source_type IN ('supplier_communication','customer_communication') AND r.status='SENT' AND r.external_message_id IS NOT NULL
    AND e.status='SUCCEEDED' AND e.result->>'externalMessageId'=r.external_message_id,false) provider_confirmed
   FROM records r LEFT JOIN LATERAL (SELECT status,result FROM stockchief_runtime.provider_effects e
    WHERE e.workspace_id=r.workspace_id AND e.aggregate_id=r.id AND e.kind='mail.outbound.send'
    AND e.aggregate_type=r.source_type ORDER BY e.created_at DESC,e.id DESC LIMIT 1) e ON true
 ), classified AS (
  SELECT *,CASE WHEN source_type='received' THEN 'received'
   WHEN source_type='attachment' THEN 'document_evidence'
   WHEN source_type='proposal' AND status='PENDING' OR status IN ('PREPARED','DRAFT') THEN 'prepared'
   WHEN source_type='proposal' AND status='EXECUTING' THEN 'execution_started'
   WHEN provider_confirmed THEN 'provider_confirmed'
   WHEN status='SENT' THEN 'recorded_sent'
   WHEN status IN ('QUEUED','SENDING','PENDING','RUNNING','IN_PROGRESS') THEN 'awaiting_provider'
   WHEN status='CANCELLED' THEN 'stopped'
   WHEN status IN ('FAILED','AMBIGUOUS') THEN 'unconfirmed_failure'
   ELSE 'recorded_state' END stage
  FROM enriched WHERE $2::text IS NULL OR recipient ILIKE '%'||$2||'%' OR coalesce(subject,'') ILIKE '%'||$2||'%'
   OR kind ILIKE '%'||$2||'%' OR status ILIKE '%'||$2||'%' OR body ILIKE '%'||$2||'%'
   OR source_type='attachment' AND EXISTS(SELECT 1 FROM connection_email_attachments a
    JOIN connection_email_messages m ON m.workspace_id=a.workspace_id AND m.id=a.message_id
    WHERE a.workspace_id=enriched.workspace_id AND a.id=enriched.id
      AND (a.extraction_status='READABLE' AND a.extracted_text ILIKE '%'||$2||'%' OR m.subject ILIKE '%'||$2||'%'))
 ), grouped AS (SELECT recipient_kind,source_type,stage,count(*)::int n FROM classified GROUP BY recipient_kind,source_type,stage),
 coverage AS (SELECT (SELECT count(*)::int FROM classified) total_matches,
  coalesce((SELECT jsonb_agg(jsonb_build_object('recipientKind',recipient_kind,'recordType',source_type,'stage',stage,'count',n)
   ORDER BY recipient_kind,source_type,stage) FROM grouped),'[]'::jsonb) counts),
 page AS (SELECT * FROM classified ORDER BY at::timestamptz DESC,source_type,id LIMIT 100 OFFSET $4)
 SELECT page.*,coverage.total_matches,coverage.counts FROM coverage LEFT JOIN page ON true
 ORDER BY page.at::timestamptz DESC,page.source_type,page.id`,[ctx.workspaceId,search,ctx.actorId,offset]);
 const total=Number(result.rows[0].total_matches),counts=result.rows[0].counts;
 const attachmentIds=result.rows.filter(r=>r.source_type==='attachment'&&r.id).map(r=>r.id);
 const documents=new Map(attachmentIds.length?(await database.query(`WITH context AS (
  SELECT id,message_id,filename,content_hash,extraction_status,extraction_error,
   CASE WHEN extraction_status='READABLE' THEN coalesce(extracted_text,'') ELSE '' END text,
   greatest(0,coalesce(nullif(strpos(lower(CASE WHEN extraction_status='READABLE' THEN coalesce(extracted_text,'') ELSE '' END),lower($3::text)),0)-1,0)-200)::int AS text_offset
  FROM connection_email_attachments WHERE workspace_id=$1 AND id=ANY($2::text[]))
  SELECT id,message_id,filename,content_hash,extraction_status,extraction_error,
   length(regexp_replace(text,$4,'xx','g'))::int total,
   length(regexp_replace(left(text,text_offset),$4,'xx','g'))::int text_offset,
   substring(text FROM text_offset+1 FOR 600) fragment FROM context`,
  [ctx.workspaceId,attachmentIds,search,'['+String.fromCodePoint(0x10000)+'-'+String.fromCodePoint(0x10ffff)+']'])).rows.map(r=>[r.id,r]):[]);
 const rows=result.rows.filter(r=>r.id).map(r=>({id:r.source_type+':'+r.recipient_kind+':'+r.id,recordId:r.id,kind:r.kind,recordType:r.source_type,recipientKind:r.recipient_kind,
  party:r.recipient||'',subject:r.subject||'',message:r.source_type==='attachment'?documents.get(r.id)?.fragment??'':r.body||'',status:r.status,stage:r.stage,approvalStage:r.approval_stage,
  ...(r.source_type==='attachment'?{document:(()=>{const d=documents.get(r.id);if(!d)throw new ValidationError('The saved document changed while reading. No document outcome is verified.');return {messageId:d.message_id,filename:d.filename,contentHash:d.content_hash,status:d.extraction_status,error:d.extraction_error||null,
   textOffset:d.text_offset,totalCharacters:d.total,textComplete:d.extraction_status==='READABLE'&&d.text_offset===0&&d.fragment.length===d.total,
   previousTextHref:d.text_offset?r.href+'?offset='+Math.max(0,d.text_offset-6000):null,nextTextHref:d.text_offset+d.fragment.length<d.total?r.href+'?offset='+(d.text_offset+d.fragment.length):null,
   untrusted:true,scope:'Saved extracted document text; no bill, payment, receipt or sending authority is implied.'};})()}:{}),
  providerState:r.provider_state||null,providerConfirmed:r.provider_confirmed,
  providerMessageIdRecorded:Boolean(r.external_message_id),
  providerConfirmation:r.provider_confirmed?'Mailbox provider accepted the message':r.source_type==='received'?'Incoming message':r.source_type==='attachment'?'Saved incoming document; no financial or physical effect is implied':
   r.stage==='prepared'?'Not submitted for sending':r.status==='SENT'?'Sent is recorded; provider receipt not established here':'Provider acceptance not confirmed',
  at:r.at,href:r.href}));
 return {answer:rows.length?`Showing ${rows.length} of ${total} recorded business email items. Preparation, approval, execution and provider acceptance are distinct stages.`:
  total?`No email items on this page; ${total} matching records exist.`:'No recorded business email item matched this scope.',rows,
  extent:{returnedRows:rows.length,totalRows:total,offset,nextOffset:offset+rows.length<total?offset+rows.length:null,complete:offset===0&&rows.length===total,
   scope:'Recorded supplier/customer communications, incoming messages and their saved attachments, unsent reply drafts, and pending or executing governed email proposals. Attachment text is bounded and includes its exact text offset, total and continuation links. Executed proposals are represented by their communication records. Free-form chat work products and set-aside unknown senders are not indexed as active business email.'},
  stateCoverage:{complete:true,counts,scope:'This business’s recorded messages and this actor’s pending email proposals. Other actors’ private proposals are outside this read.',
   absentCombinationsHaveZeroWithinScope:true,incomingAndReplyRecipientKind:'Unclassified; no customer or supplier identity is inferred from an email address.',
   unlinkedCustomerCommunicationKind:'customer_or_address means no current customer link is recorded; it may be direct-address mail or a former customer link.'},
  columns:['kind','recipientKind','party','subject','status','approvalStage','providerConfirmation','at']};
}
module.exports={read};
