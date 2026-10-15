'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),{randomUUID}=require('node:crypto');
test('real website form remains verifiable after navigation chrome changes; actual changed form facts still fail',{timeout:90000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString),cleanup=[];
 t.after(async()=>{for(const close of cleanup.reverse())await close();await db.close();cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',password='Offline!'+randomUUID(),owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Form verifier',businessName:'Offline fixture',email,password});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),aiProvider:{complete:async()=>{throw Error('NO_MODEL_CALLS');}}});cleanup.push(()=>app.locals.sessionStore.close());
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});cleanup.push(()=>new Promise(resolve=>server.close(resolve)));
 const origin='http://127.0.0.1:'+server.address().port,browser=await require('playwright').chromium.launch();cleanup.push(()=>browser.close());
 const web=request.agent(app),login=await web.get('/login'),csrf=/name="_csrf" value="([^"]+)"/.exec(login.text)[1];
 const signed=await web.post('/login').type('form').send({_csrf:csrf,email,password}),cookie=signed.headers['set-cookie'].find(c=>c.startsWith('foundry.sid='));
 const tools=await require('../../scripts/environment-agent-demo/browser').createBrowserTools(browser,{origin});cleanup.push(()=>tools.close());
 await tools.context.addCookies([{name:'foundry.sid',value:cookie.split(';')[0].slice('foundry.sid='.length),url:origin}]);
 const fixture=require('../fixtures/codex-browser-line-shift.json');
 const store=require('../../src/assistant/postgres-goal-store'),goal=await store.claim(db,ctx,(await store.create(db,ctx,fixture.request)).id);
 const gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:goal.original_request,goalId:goal.id,runToken:goal.run_token});
 const session=require('../../scripts/environment-agent-demo/session').createSession({database:db,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:gateway.authorize});
 // This is the real report-builder route from the recorded trace, reached as
 // host test setup. No route/field knowledge is added to the embedded agent.
 await tools.page.goto(origin+'/reports');
 const form=await session.execute('environment_browser',{action:'recorded-navigation'},()=>tools.restore(origin+'/reports/builder?dataset=stock'));
 assert(form.textRegions.some(region=>region.tag==='form'));
 const saved=await store.get(db,ctx,goal.id),entry=Object.values(saved.checkpoint.harness.evidence).findLast(e=>e.name==='environment_browser');
 // Insert unrelated navigation chrome into the ORIGINAL observation as an
 // authentic visible DOM change, then record it with fresh journal hashes.
 await tools.page.evaluate(()=>{const chrome=document.createElement('p');chrome.id='offline-chrome';chrome.innerText='Earlier page\nReturn to list';document.querySelector('main').prepend(chrome);});
 const observed=await session.execute('environment_browser',{action:'changed-chrome'},()=>tools.inspect());
 const current=await store.get(db,ctx,goal.id),evidence=Object.values(current.checkpoint.harness.evidence).findLast(e=>e.name==='environment_browser');
 const claims=fixture.claims.map(claim=>{
  const found=Object.entries(observed.textBlocks).filter(([,value])=>value===claim.value);
  // Repeated option labels are all within the unchanged full form.
  assert(found.length,'Recorded form value is present in the actual renderer: '+claim.value);
  return {evidenceId:evidence.id,path:'/textBlocks/'+found[0][0],value:claim.value};
 });
 const last=Object.entries(observed.textBlocks).at(-1);
 claims.push({evidenceId:evidence.id,path:'/textBlocks/'+last[0],value:last[1]});
 const report={status:'completed',outcome:'navigation',answer:'Ready to open the observed report form.',claims,navigation:{evidenceId:evidence.id,path:'/url'}};
 const verification=require('../../src/assistant/postgres-codex-verification'),catalogue=(await gateway.authorize()).catalogue;
 const checked=await verification.verify(db,ctx,current,JSON.stringify(report),catalogue,{browser:tools});
 assert.equal(checked.verified,true,JSON.stringify(checked));assert.equal(checked.navigation.href,'/reports/builder?dataset=stock');
 assert.equal(current.status,'RUNNING','Verification alone does not deliver or execute an outcome');
 const original=tools.verifyObservation;let reads=0;
 tools.verifyObservation=async url=>{const fresh=await original(url);reads++;
  const key=Object.keys(fresh.textBlocks).find(key=>fresh.textBlocks[key]===claims[0].value);fresh.textBlocks[key]='Changed business-form meaning';return fresh;};
 const changed=await verification.verify(db,ctx,current,JSON.stringify(report),catalogue,{browser:tools});
 assert.equal(changed.verified,false);assert.equal(reads,1,'Fresh browser evidence is consolidated once for all claims');
 assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
});
