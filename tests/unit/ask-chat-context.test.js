'use strict';const test=require('node:test'),assert=require('node:assert/strict'),context=require('../../src/assistant/ask-chat-context');
test('chat forms cannot forge a boundary or cross an actor, session, inventory or conversation',()=>{
 const scope={workspaceId:'fixture-workspace',actorId:'fixture-actor',sessionId:'fixture-session',chatId:'fixture-chat',startedAt:'2026-01-01T00:00:00.000Z'},now=Date.now(),token=context.issue('fixture-signing-secret',scope,now);
 const valid=context.verify('fixture-signing-secret',token,scope,now);assert.equal(valid.chatId,scope.chatId);assert.equal(valid.startedAt,scope.startedAt);assert.equal(valid.issuedAt,now);assert(!Buffer.from(token.split('.')[0],'base64url').toString().includes(scope.sessionId),'The token does not expose the session identifier');
 for(const key of ['workspaceId','actorId','sessionId','chatId'])assert.throws(()=>context.verify('fixture-signing-secret',token,{...scope,[key]:'different'},now));
 assert.throws(()=>context.verify('another-secret',token,scope,now));assert.throws(()=>context.verify('fixture-signing-secret',token,scope,now+86400001));
 const changed=Buffer.from(JSON.stringify({...scope,startedAt:'1900-01-01'})).toString('base64url')+'.'+token.split('.')[1];assert.throws(()=>context.verify('fixture-signing-secret',changed,scope,now));
});
