'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const queue=require('../../src/operations/postgres-job-queue');
const runtime=require('../../src/operations/postgres-runtime-handlers');
const progress='stockchief_runtime.mailbox_poll_progress';

async function mailbox(f,provider){
  const id='triage-'+provider+'-'+randomUUID(),at=new Date(Date.now()-300000).toISOString();
  const {db,ctx}=f;
  const row=(await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,
    capabilities,expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,credential_ref,created_at,updated_at)
    VALUES($1,$2,$1,$3,$3,'[]','{}','connected','[]',5,'CONNECTED',$4,$1,$5,$6,$7,$7) RETURNING *`,
    [id,ctx.workspaceId,provider,ctx.actorId,'mailbox@example.test','connection_credentials:'+id,at])).rows[0];
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,id,'provider',
    {accessToken:'synthetic-read-only-token',mailbox:'mailbox@example.test',expiresAt:Date.now()+3600000}));
  return row;
}
async function enqueue(f,box){
  return queue.enqueue(f.db,{workspaceId:f.ctx.workspaceId,kind:'mailbox.poll',
    idempotencyKey:randomUUID(),payload:{connectorId:box.id}});
}
async function processPage(f,handlers,extra={}){
  return queue.processOne(f.db,handlers,{owner:'native-triage-worker',kinds:['mailbox.poll'],...extra});
}
function completed(job){
  assert.equal(job?.status,'COMPLETED',JSON.stringify(job?.lastError));
  return job.result;
}
async function records(f){
  return (await f.db.query(`SELECT external_message_id AS id,agent_category AS category,agent_category_reason AS reason,'business' AS source
    FROM connection_email_messages WHERE workspace_id=$1
    UNION ALL SELECT external_message_id,agent_category,agent_category_reason,'set aside'
    FROM connection_email_set_aside WHERE workspace_id=$1 AND brought_in_at IS NULL ORDER BY id`,[f.ctx.workspaceId])).rows;
}

test('the native Gmail and Microsoft workers classify complete pages, preserve unknown privacy, and surface sorted mail across plan tiers',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t);
  const {db,ctx,browser}=f;
  await f.subscribe('growth');
  await db.query("UPDATE suppliers SET email='supplier@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
  const gmail=await mailbox(f,'gmail');
  const adapters={gmail:require('../../src/connections/providers/gmail'),microsoft365:require('../../src/connections/providers/microsoft365')};
  const handlers=runtime.create({get(type){
    const adapter=adapters[type];
    return adapter?{...adapter,metadata:()=>({...adapter.metadata(),available:true})}:null;
  }});
  const at=new Date(Date.now()-120000).toISOString(),base='https://graph.microsoft.com/v1.0';
  let gmailScenario='growth',networkFailure=true;
  const calls=[],saved=global.fetch;t.after(()=>{global.fetch=saved;});
  const message=(id,sender,subject,text,extra={})=>({id,sender,subject,text,...extra});
  const gmailData={
    order:message('order','receiver@example.test','New order','We would like to order five units.'),
    unknown:message('unknown','stranger@example.test','Delivery availability','Can you supply this next week? Private body marker.'),
    own:message('own','mailbox@example.test','Own outgoing message','Never sort this message.'),
    custom:message('custom','receiver@example.test','Invoice question','Can you confirm the invoice amount?'),
    starter:message('starter','receiver@example.test','New order','We would like to order ten units.')
  };
  const graphData={
    invoice:message('invoice','supplier@example.test','Invoice 77','Invoice for delivered components.'),
    archive:message('archive','supplier@example.test','Packing slip','Packing slip delivered with the original goods.'),
    junk:message('junk','supplier@example.test','Invoice 990','This apparent supplier invoice was placed in Junk.')
  };
  global.fetch=async raw=>{
    const url=new URL(raw);calls.push(url);
    if(url.hostname==='gmail.googleapis.com'){
      if(url.pathname.endsWith('/messages')){
        if(gmailScenario!=='growth')return Response.json({messages:[{id:gmailScenario}]});
        if(!url.searchParams.has('pageToken'))return Response.json({messages:[{id:'order'},{id:'own'}],nextPageToken:'gmail-next'});
        if(networkFailure){networkFailure=false;return Response.json({message:'Transient provider error.'},{status:503,headers:{'Retry-After':'60'}});}
        return Response.json({messages:[{id:'order'},{id:'unknown'}]});
      }
      const data=gmailData[url.pathname.split('/').at(-1)];assert(data,url.pathname);
      return Response.json({id:data.id,threadId:'thread-'+data.id,internalDate:String(Date.parse(at)),
        labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:data.sender},{name:'Subject',value:data.subject}],
          body:{data:Buffer.from(data.text).toString('base64url')}}});
    }
    assert.equal(url.hostname,'graph.microsoft.com');
    const folder=url.pathname.split('/').at(-2);
    const data=graphData[folder==='inbox'?'invoice':folder==='junkemail'?'junk':'archive'];
    assert(data,url.pathname);
    const mapped=row=>({id:row.id,internetMessageId:'<'+(row.original||row.id)+'@fixture>',receivedDateTime:at,subject:row.subject,
      from:{emailAddress:{address:row.sender}},body:{contentType:'text',content:row.text}});
    return Response.json({value:[mapped(data),...(folder==='archive'?[mapped({...graphData.invoice,id:'moved-invoice',original:'invoice'})]:[])]});
  };
  await enqueue(f,gmail);
  const first=completed(await processPage(f,handlers));assert.equal(first.accepted,1);assert.equal(first.ignoredOwn,1);assert(first.continued);
  assert.equal((await db.query('SELECT last_synced_at FROM workspace_connectors WHERE id=$1',[gmail.id])).rows[0].last_synced_at,null);
  const before=(await db.query('SELECT * FROM '+progress+' WHERE connector_id=$1',[gmail.id])).rows[0];
  assert.deepEqual(before.cursor,{token:'gmail-next'});
  const failed=await processPage(f,handlers);assert.equal(failed.status,'RETRY',JSON.stringify(failed.lastError));
  const retried=completed(await processPage(f,handlers,{now:failed.availableAt+1}));
  assert.equal(retried.replayed,1);assert.equal(retried.setAside,1);assert.equal(retried.continued,false);
  assert.equal((await db.query('SELECT 1 FROM '+progress+' WHERE connector_id=$1',[gmail.id])).rowCount,0);
  assert.equal((await db.query('SELECT last_synced_at FROM workspace_connectors WHERE id=$1',[gmail.id])).rows[0].last_synced_at,new Date(before.until_at).toISOString());
  const aside=(await db.query('SELECT * FROM connection_email_set_aside WHERE external_message_id=$1',['unknown'])).rows[0];
  assert.doesNotMatch(JSON.stringify(aside),/Private body marker/);
  await browser.get('/mail').expect(200).expect(/Sorted mail/);
  const sorted=await browser.get('/mail/sorted?filter=question').expect(200).expect(/Delivery availability/);
  assert(sorted.text.includes('/mail/set-aside?focus='+aside.id));
  await browser.get('/mail/set-aside?focus='+aside.id).expect(200).expect(/Delivery availability/);

  await f.subscribe('pro');
  const graph=await mailbox(f,'microsoft365');
  await enqueue(f,graph);
  for(const step of [true,true,false])assert.equal(completed(await processPage(f,handlers)).continued,step);
  assert.deepEqual((await records(f)).map(r=>[r.id,r.category,r.source]),[
    ['archive','delivery','business'],['invoice','invoice','business'],['junk','bulk','set aside'],['order','order','business'],['unknown','question','set aside']
  ]);
  await browser.get('/mail/sorted?filter=junk').expect(200).expect(/Invoice 990/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM connection_email_messages WHERE external_message_id='junk'")).rows[0].n,0);

  await f.subscribe('enterprise');gmailScenario='custom';await enqueue(f,gmail);
  assert.equal(completed(await processPage(f,handlers)).accepted,1);
  assert.equal((await records(f)).find(r=>r.id==='custom').category,'question');
  await f.subscribe('starter');gmailScenario='starter';await enqueue(f,gmail);
  assert.equal(completed(await processPage(f,handlers)).accepted,1);
  assert.equal((await records(f)).find(r=>r.id==='starter').category,null);
  await browser.get('/mail').expect(200).expect(res=>assert.doesNotMatch(res.text,/>Sorted mail</));
  await browser.get('/mail/sorted').expect(402);
  assert(!calls.some(url=>/send/i.test(url.pathname)));
});

test('continuations preserve exact cursor ownership, stop on pause and sort envelopes over the attachment limit',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;
  await f.subscribe('growth');
  const box=await mailbox(f,'gmail');
  let providerPages=0,mode='volume',expired=false;
  const plain=id=>({messageId:id,sender:'receiver@example.test',subject:'Stock availability?',bodyText:'Can you confirm?' });
  const adapter={poll:()=>{throw Error('The paged reader should be used.');},async pollPage({cursor}){
    providerPages++;
    if(mode==='expired'){
      if(!cursor)return {messages:[plain('expiration-original')],next:{token:'expired-page'}};
      if(!expired){expired=true;throw Object.assign(Error('Invalid page token'),{status:400});}
      return {messages:[],next:null};
    }
    if(mode==='quota')return {messages:[plain('quota-one'),plain('quota-two')],next:null};
    if(!cursor)return {messages:[{messageId:'oversized',sender:'receiver@example.test',subject:'New order',
      attachments:Array.from({length:51},(_,i)=>({filename:'Original item '+i+'.pdf'}))}],next:{token:'exact-page'}};
    return {messages:[{messageId:'rest',sender:'receiver@example.test',subject:'Still in stock?',bodyText:'Can you confirm?'}],next:null};
  }};
  const handlers=runtime.create({get:type=>type==='gmail'?adapter:null});
  await enqueue(f,box);
  const one=completed(await processPage(f,handlers));assert.equal(one.setAside,1);assert(one.continued);
  assert.equal((await records(f))[0].category,'order');
  assert.match((await db.query("SELECT reason FROM connection_email_set_aside WHERE external_message_id='oversized'")).rows[0].reason,/attachment reading limit/);
  await db.query('UPDATE workspace_connectors SET paused_at=$2 WHERE id=$1',[box.id,new Date().toISOString()]);
  assert.equal(completed(await processPage(f,handlers)).skipped,'connection_not_active');
  assert.equal(providerPages,1);
  await db.query('UPDATE workspace_connectors SET paused_at=NULL WHERE id=$1',[box.id]);
  await db.query('UPDATE '+progress+' SET page_number=100 WHERE connector_id=$1',[box.id]);
  await enqueue(f,box);
  const remaining=completed(await processPage(f,handlers));assert.equal(remaining.accepted,1);assert.equal(remaining.continued,false);
  assert.equal(providerPages,2);
  assert.equal((await records(f)).find(r=>r.id==='rest').category,'question');
  assert.equal((await db.query('SELECT 1 FROM '+progress+' WHERE workspace_id=$1',[ctx.workspaceId])).rowCount,0);

  mode='expired';await enqueue(f,box);
  assert(completed(await processPage(f,handlers)).continued);
  const restarted=completed(await processPage(f,handlers));assert(restarted.restarted);
  const reset=(await db.query('SELECT cursor,last_cursor_reset_at FROM '+progress+' WHERE connector_id=$1',[box.id])).rows[0];
  assert.equal(reset.cursor,null);assert(reset.last_cursor_reset_at);
  assert.equal(completed(await processPage(f,handlers)).replayed,1);
  assert.equal(completed(await processPage(f,handlers)).continued,false);

  mode='quota';
  const override=randomUUID();
  await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'incoming_emails',3,'Fixture mailbox limit')",
    [override,f.owner.accountId]);
  await enqueue(f,box);
  const paused=await processPage(f,handlers);assert.equal(paused.status,'PAUSED',JSON.stringify(paused.lastError));
  assert((await records(f)).some(row=>row.id==='quota-one'));
  assert(!(await records(f)).some(row=>row.id==='quota-two'));
  assert((await db.query('SELECT 1 FROM '+progress+' WHERE connector_id=$1',[box.id])).rowCount);
  await db.query('DELETE FROM commercial_entitlement_overrides WHERE id=$1',[override]);
  await db.transaction(c=>runtime.runtimeSweep({payload:{now:Date.now()}},c));
  const resumed=completed(await processPage(f,handlers));
  assert.equal(resumed.replayed,1);assert.equal(resumed.accepted,1);assert.equal(resumed.continued,false);
  assert((await records(f)).some(row=>row.id==='quota-two'));
});
