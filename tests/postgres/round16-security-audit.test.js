'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest');
const csrf=html=>{const value=/name="_csrf" value="([^"]+)"/.exec(html)?.[1];assert(value);return value;};
test('access and preference changes have immutable, searchable audit records without credentials',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'security-audit-test'});f.cleanup(()=>app.locals.sessionStore.close());
 const agent=request.agent(app),login=await agent.get('/login');await agent.post('/login').type('form').send({_csrf:csrf(login.text),email:f.email,password:f.password}).expect(302);
 async function post(path,form){const page=await agent.get('/settings');return agent.post(path).type('form').send({_csrf:csrf(page.text),...form}).expect(303);}
 await post('/settings/workspace',{name:'Audited inventory'});
 await post('/settings/people',{name:'Audited person',email:'audit-person@example.test',role:'staff'});
 let invitation=(await db.query("SELECT id FROM workspace_invitations WHERE workspace_id=$1 AND status='PENDING'",[ctx.workspaceId])).rows[0];
 await post('/settings/people/'+invitation.id+'/resend',{});
 invitation=(await db.query("SELECT id FROM workspace_invitations WHERE workspace_id=$1 AND status='PENDING'",[ctx.workspaceId])).rows[0];await post('/settings/people/'+invitation.id+'/cancel',{});
 await post('/settings/email-alerts',{enabled:'1',recipients:'alerts@example.test',minimumSeverity:'important'});
 await post('/settings/ask-preferences',{answerLanguage:'en',answerStyle:'Concise',timeZone:'America/New_York'});
 await post('/settings/ai-spending',{confirmed:'yes',accountLimit:'25',workspaceLimit:'10'});
 const api=require('../../src/connections/postgres-public-api'),client=await api.create(db,ctx,{name:'Audit token',scopes:['inventory:read']});await api.revoke(db,ctx.workspaceId,client.id,ctx.actorId);
 const expected=['Inventory renamed','Team invitation created','Team invitation replaced','Team invitation cancelled','Notification settings changed','AI and business preferences changed','AI spending limits changed','API token created','API token revoked'];
 const events=(await db.query('SELECT * FROM security_event_history WHERE workspace_id=$1',[ctx.workspaceId])).rows;
 for(const action of expected){const event=events.find(e=>e.action===action);assert(event,action);assert.equal(event.actor_id,ctx.actorId);}
 assert(!JSON.stringify(events).includes(client.token));assert(!JSON.stringify(events).includes(f.password));
 const renamed=events.find(e=>e.action==='Inventory renamed');assert.equal(renamed.before_state.Name,'Shipping operation fixture');assert.equal(renamed.after_state.Name,'Audited inventory');
 const audit=await agent.get('/audit?q=token');assert.equal(audit.status,200);assert.match(audit.text,/API token created/);assert.match(audit.text,/API token revoked/);assert.doesNotMatch(audit.text,/Team invitation replaced/);
 const activity=await agent.get('/activity?q=token&user='+encodeURIComponent(ctx.actorId));assert.equal(activity.status,200);assert.match(activity.text,/API token created/);assert.match(activity.text,/API token revoked/);
 const exported=await agent.get('/audit/export?q=invit');assert.equal(exported.status,200);assert.match(exported.text,/Team invitation cancelled/);assert(!exported.text.includes(client.token));
 await assert.rejects(db.query('UPDATE security_event_history SET action=$2 WHERE id=$1',[renamed.id,'Erased']),/cannot be rewritten/i);
 const other=await require('../../src/domain/postgres-auth-service').createWorkspace(db,f.owner.accountId,{name:'Other audit inventory'});assert.equal((await require('../../src/operations/postgres-audit').page(db,other.workspaceId,{q:'token'})).rows.length,0);
 // Authenticator enrollment is deliberately available even on Starter.
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) SELECT 'audit-starter',$1,'starter',id,'ACTIVE' FROM commercial_plan_versions WHERE plan_id='starter' AND status='ACTIVE'",[f.owner.accountId]);
 assert.equal((await agent.get('/settings/security')).status,200);
 const setup=await agent.post('/settings/security/setup').type('form').send({_csrf:csrf((await agent.get('/settings/security')).text),currentPassword:f.password});assert.equal(setup.status,200);assert.match(setup.text,/data-authenticator-secret/);
});
