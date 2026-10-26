'use strict';
// One read projection for inbox counts, drawers and message headings. Verified
// sent text remains immutable; projecting an old row never repairs it by writing.
const DRAWER_SQL=`CASE WHEN EXISTS (SELECT 1 FROM stockchief_runtime.email_reply_outbox outbox
 WHERE outbox.workspace_id=message.workspace_id AND outbox.message_id=message.id
 AND outbox.status IN ('PENDING','SENDING')) THEN 'SENDING'
 WHEN EXISTS (SELECT 1 FROM stockchief_runtime.email_reply_outbox outbox
 WHERE outbox.workspace_id=message.workspace_id AND outbox.message_id=message.id
 AND outbox.status='AMBIGUOUS') THEN 'UNCERTAIN'
 WHEN message.reply_sent_at IS NOT NULL AND message.reply_state='NEEDS_REPLY' THEN 'WAITING'
 ELSE message.reply_state END`;
const words={NEEDS_REPLY:'Needs a reply',WAITING:'Waiting on them',HANDLED:'Handled',SENDING:'Sending reply',UNCERTAIN:'Delivery uncertain'};
function message(row){const state=row.display_reply_state||(['PENDING','SENDING'].includes(row.outbox_status)?'SENDING':row.outbox_status==='AMBIGUOUS'?'UNCERTAIN':row.reply_sent_at&&row.reply_state==='NEEDS_REPLY'?'WAITING':row.reply_state);return {...row,stored_reply_state:row.reply_state,reply_state:state,stateWords:words[state]||state};}
module.exports={DRAWER_SQL,message};
