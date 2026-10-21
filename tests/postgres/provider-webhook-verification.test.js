'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('operator webhook challenges are encrypted, expiring, bounded and cannot authorize or impersonate business events',{timeout:150000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const keys=['CLOVER_CLIENT_ID','CLOVER_ENVIRONMENT'],before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.CLOVER_CLIENT_ID='fixture-clover-app';process.env.CLOVER_ENVIRONMENT='sandbox';let normalized=0;
 const registry={get:type=>type==='clover'?{verifyWebhook(){throw Error('Unsigned event must not be trusted');},normalizeWebhook(){normalized++;throw Error('A setup challenge is never a business event');}}:null,catalog:()=>[]};
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),connectionProviders:registry});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();await db.close();await cluster.stop();for(const k of keys)if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];});
 const base='http://127.0.0.1:'+server.address().port,endpoint=base+'/api/v1/connections/clover/webhooks';
 const code=randomUUID(),send=body=>fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 let response=await send({verificationCode:code});assert.equal(response.status,200);assert.deepEqual(await response.json(),{verificationCode:code});
 response=await send({verificationCode:code});assert.equal(response.status,200);
 const rows=(await db.query('SELECT * FROM stockchief_runtime.provider_webhook_challenges')).rows;
 assert.equal(rows.length,1,'Repeated delivery is retained once');assert(!JSON.stringify(rows).includes(code),'Never retain the challenge as plaintext');
 const service=require('../../src/connections/postgres-webhook-verification'),scope={provider:'clover',appId:'fixture-clover-app',environment:'sandbox'};
 const receipt=await service.readLatest(db,scope);assert.equal(receipt.code,code);assert.equal(receipt.providerVerified,false);
 assert.equal(await service.readLatest(db,{...scope,appId:'another-app'}),null);
 assert.equal(await service.readLatest(db,{...scope,environment:'production'}),null);
 assert.equal(await service.readLatest(db,scope,{now:Date.parse(receipt.expiresAt)}),null,'A code expires exactly at its boundary');
 assert.equal((await send({verificationCode:code,merchants:{untrusted:[{objectId:'I:bad'}]}})).status,400);
 for(const bad of [null,{},['code'],'a'.repeat(257),'code with spaces'])assert.equal((await send({verificationCode:bad})).status,400);
 const settings=await fetch(base+'/settings/connections',{redirect:'manual'});assert.notEqual(settings.status,200);assert(!(await settings.text()).includes(code));
 const publicRead=await fetch(endpoint+'/verification');assert.notEqual(publicRead.status,200);assert(!(await publicRead.text()).includes(code));
 for(let index=0;index<23;index++)await service.retain(db,{...scope,code:randomUUID()});
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.provider_webhook_challenges')).rows[0].n,20,'Public setup input cannot cause unbounded retention');
 assert.equal(normalized,0);
 const effects=(await db.query(`SELECT (SELECT count(*)::int FROM movements) movements,
  (SELECT count(*)::int FROM accounting_journal_entries) journals,
  (SELECT count(*)::int FROM connector_feed_events) business_events,
  (SELECT count(*)::int FROM connection_mappings) mappings`)).rows[0];
 assert.deepEqual(effects,{movements:0,journals:0,business_events:0,mappings:0});
 await db.transaction(client=>require('../../src/operations/postgres-runtime-handlers').create(registry)['system.runtime-sweep']({payload:{now:Date.now()+16*60000}},client));
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.provider_webhook_challenges')).rows[0].n,0,'Existing runtime expiry removes expired setup challenges');
});
