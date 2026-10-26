'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('concurrent Send and Discard cannot both succeed or queue a reply after it is discarded',
  {timeout:120000},async t=>{
  const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
  const at=new Date().toISOString(),connectorId='send-discard-connector';
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,
    capabilities,expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
    VALUES($1,$2,'send-discard','Business mailbox','gmail','[]','{}','connected','[]',1,'CONNECTED',$3,$4,$4)`,[connectorId,ctx.workspaceId,ctx.actorId,at]);
  const connection=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[connectorId])).rows[0],mail=require('../../src/connections/postgres-mail');
  const providers={get:()=>({send:async()=>{throw new Error('No external send in this concurrency test');}})};
  for(let n=0;n<5;n++){
    const captured=await mail.capture(db,connection,{externalMessageId:'parallel-'+n,sender:'receiver@example.test',subject:'A recorded question',bodyText:'Please reply.',receivedAt:at});
    const draft={subject:'Re: A recorded question',body:'The saved reply.'};await mail.saveDraft(db,ctx,captured.messageId,draft);
    const outcomes=await Promise.allSettled([mail.queueSend(db,ctx,captured.messageId,draft,{providers}),
      require('../../src/connections/postgres-mail-preparation').discard(db,ctx,captured.messageId)]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    const row=await mail.get(db,ctx.workspaceId,captured.messageId),queued=(await db.query('SELECT count(*)::int n FROM stockchief_runtime.email_reply_outbox WHERE workspace_id=$1 AND message_id=$2',[ctx.workspaceId,captured.messageId])).rows[0].n;
    assert.equal(queued,outcomes[0].status==='fulfilled'?1:0);
    if(row.reply_state==='HANDLED')assert.equal(queued,0);
    assert.equal(row.draft_body,draft.body);assert.equal(row.reply_sent_at,null);
  }
  assert.equal(await f.balance(),4);
});
