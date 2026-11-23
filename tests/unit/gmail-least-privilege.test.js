'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');

test('Gmail connects, identifies the mailbox, reads and sends using only the two requested Gmail scopes',async t=>{
 const before={...process.env},oldFetch=global.fetch;t.after(()=>{process.env={...before};global.fetch=oldFetch;});
 delete process.env.FOUNDRY_DATABASE_URL;delete process.env.DATABASE_URL;
 process.env.GMAIL_CLIENT_ID='least-privilege-fixture';process.env.GMAIL_CLIENT_SECRET='offline-fixture';
 const gmail=require('../../src/connections/providers/gmail'),requested=['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'];
 const auth=gmail.authorizationUrl({state:'server-owned-state',input:{redirectUri:'https://app.example.test/settings/connections/gmail/callback'}}),url=new URL(auth.url);
 assert.deepEqual(url.searchParams.get('scope').split(' '),requested);assert.equal(url.searchParams.get('include_granted_scopes'),'false');
 assert.equal(url.searchParams.get('access_type'),'offline');assert.equal(url.searchParams.get('prompt'),'select_account consent');
 assert.equal(url.searchParams.get('state'),'server-owned-state');
 const calls=[];global.fetch=async(raw,options={})=>{
  const u=new URL(raw);calls.push(u.pathname);
  if(u.hostname==='oauth2.googleapis.com'){
   const body=new URLSearchParams(options.body);assert.equal(body.get('redirect_uri'),auth.metadata.redirectUri);
   return Response.json({access_token:'scope-limited-fixture',refresh_token:'saved-fixture',expires_in:3600,scope:requested.join(' ')});
  }
  assert.equal(u.hostname,'gmail.googleapis.com');assert.equal(options.headers.authorization,'Bearer scope-limited-fixture');
  if(u.pathname.endsWith('/profile'))return Response.json({emailAddress:'review@example.test',historyId:'42'});
  if(u.pathname.endsWith('/messages/send')){
   const mime=Buffer.from(JSON.parse(options.body).raw,'base64url').toString('utf8');
   assert.match(mime,/To: supplier@example.test/);assert.match(mime,/Subject: Reviewed test reply/);assert.match(mime,/Approved reply body/);
   return Response.json({id:'sent-fixture',threadId:'thread-fixture'});
  }
  if(u.pathname.endsWith('/messages/incoming'))return Response.json({id:'incoming',threadId:'thread-fixture',internalDate:'1',payload:{mimeType:'text/plain',headers:[{name:'From',value:'supplier@example.test'}],body:{data:Buffer.from('An incoming supplier document').toString('base64url')}}});
  throw Error('Unexpected fixture request: '+u.pathname);
 };
 const result=await gmail.exchangeAuthorization({query:{code:'fixture-code'},metadata:auth.metadata});
 assert.equal(result.accountId,'review@example.test');assert.equal(result.credentials.mailbox,'review@example.test');
 assert.equal(result.credentials.refreshToken,'saved-fixture');assert.equal(result.credentials.scope,requested.join(' '));
 const incoming=await gmail.message(result.credentials,'incoming');assert.equal(incoming.bodyText,'An incoming supplier document');
 const sent=await gmail.send({credentials:result.credentials,message:{recipient:'supplier@example.test',subject:'Reviewed test reply',body:'Approved reply body'}});
 assert.equal(sent.externalMessageId,'sent-fixture');assert.equal(calls.length,4);
 assert(!calls.some(p=>/userinfo|revoke/.test(p)),'No identity API or existing-grant revocation is needed');
});
