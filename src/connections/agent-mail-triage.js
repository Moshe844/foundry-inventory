'use strict';
const policy=require('../commercial/agent-plan'),triage=require('./reply-triage');
const labels={order:'Order',invoice:'Invoice',delivery:'Delivery document',question:'Question',bulk:'Bulk or automated',review:'Review sender',message:'Other business mail'};
function classify({sender,subject,bodyText,attachments},kind){
  const body=triage.prose(bodyText||''),text=String(subject||'')+' '+body;
  const asks=/\?/.test(text)||triage.ASKING.some(phrase=>triage.saysPhrase(text.toLowerCase(),phrase));
  const attachedInvoice=(attachments||[]).some(a=>/invoice|\bbill\b/i.test(a.filename||''));
  const result=require('./email-ingestion').classify(subject,body,attachments||[],{knownCustomer:kind==='customer',knownSupplier:kind==='supplier'});
  // An invoice attached to automated mail is still an invoice.
  if(result==='invoice'&&(attachedInvoice||!asks))return 'invoice';
  if(result==='customer_order_request'||result==='purchase_order')return 'order';
  if(result==='delivery_document')return 'delivery';
  if(triage.NO_REPLY_SENDER.test(sender||'')||triage.AUTOMATIC_SUBJECT.test(subject||'')||/\bunsubscribe\b|manage (?:your )?email preferences/i.test(body))return 'bulk';
  if(!kind)return 'review';
  if(asks)return 'question';
  return 'message';
}
async function forCapture(c,workspaceId,message,kind){
  const state=await policy.accountState(c,workspaceId);
  return policy.usesAgentTerms(state)&&policy.permits(state.plan,138,'automatic')?classify(message,kind):null;
}
async function draftAccess(c,workspaceId,{required=false}={}){
  const state=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(state))return true;
  if(required)policy.requireJob(state.plan,187,'draft');
  return policy.permits(state.plan,187,'draft');
}
async function readPage(db,ctx,{filter,page}){
  const category=Object.keys(labels).find(k=>[k,labels[k].toLowerCase()].includes(filter.toLowerCase()))||'';
  const {rows}=await db.query(`SELECT * FROM (
    SELECT m.id,m.sender,m.subject,m.received_at,m.agent_category AS category,c.display_name AS mailbox,'/mail/'||m.id AS link FROM connection_email_messages m
      JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id WHERE m.workspace_id=$1
    UNION ALL SELECT m.id,m.sender,m.subject,m.received_at,m.agent_category,c.display_name,'/mail/set-aside' FROM connection_email_set_aside m
      JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id WHERE m.workspace_id=$1 AND m.brought_in_message_id IS NULL
    ) mail WHERE ($2='' OR category=$2) AND ($3='' OR lower(sender)=lower($3) OR lower(mailbox)=lower($3))
    ORDER BY received_at::timestamptz DESC,id LIMIT 101 OFFSET $4`,[ctx.workspaceId,category,category?'':filter,(page-1)*100]);
  return {rows:rows.slice(0,100).map(r=>({Category:labels[r.category]||'Awaiting classification',Mailbox:r.mailbox,From:r.sender,Subject:r.subject||'(No subject)',Received:r.received_at,link:r.link})),
    more:rows.length>100,summary:'New mailbox arrivals are sorted by their subject, text, sender and attachment names. Unknown senders stay set aside for owner review.'};
}
const definition={id:138,key:'shared-inbox-triage',label:'Sort shared inbox mail by the work it needs',filterLabel:'Category, mailbox name or sender',readPage};
module.exports={classify,forCapture,draftAccess,definition};
