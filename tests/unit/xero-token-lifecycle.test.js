'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const lifecycle=require('../../src/connections/xero-token-lifecycle');

test('Xero grant changes serialize per application and support nested work on the held session',async()=>{
 let locks=0;const session={query:async()=>{}};
 const db={withSessionLock:async(key,operation)=>{locks++;assert.match(key,/^xero-grant:[a-f0-9]{64}$/);return operation(session);}};
 await lifecycle.run(db,'app-one',held=>lifecycle.run(held,'app-one',nested=>assert.equal(nested,session)));
 assert.equal(locks,1);assert.notEqual(lifecycle.key('app-one'),lifecycle.key('app-two'));
 await lifecycle.run(db,'app-one',async()=>{});assert.equal(locks,2);
});

test('busy and missing Xero session locks preserve grants without making provider requests',async()=>{
 let calls=0;const operation=async()=>{calls++;};
 await assert.rejects(lifecycle.run({},'app',operation),error=>error.code==='XERO_SESSION_LOCK_UNAVAILABLE'&&error.transient);
 await assert.rejects(lifecycle.run({withSessionLock:async()=>({busy:true})},'app',operation),error=>error.code==='XERO_AUTHORIZATION_BUSY'&&error.transient);
 assert.equal(calls,0);
});

test('Xero disconnect uses its connection ID, refreshes expired access, and does not retry uncertain deletes',async t=>{
 const saved={id:process.env.XERO_CLIENT_ID,secret:process.env.XERO_CLIENT_SECRET};
 process.env.XERO_CLIENT_ID='disconnect-fixture';process.env.XERO_CLIENT_SECRET='disconnect-fixture-secret';
 t.after(()=>{for(const [key,value]of [['XERO_CLIENT_ID',saved.id],['XERO_CLIENT_SECRET',saved.secret]])if(value===undefined)delete process.env[key];else process.env[key]=value;});
 const xero=require('../../src/connections/providers/xero');
 let rows=[{id:'connection-one',tenantId:'tenant-one',tenantType:'ORGANISATION'},{id:'connection-two',tenantId:'tenant-two'}],deletes=0,refreshes=0,status=204;
 t.mock.method(global,'fetch',async(value,options={})=>{
  const url=new URL(value);
  if(url.origin==='https://identity.xero.com'){
   refreshes++;assert.equal(new URLSearchParams(options.body).get('refresh_token'),'current-refresh');
   return Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:1800});
  }
  assert.equal(url.origin,'https://api.xero.com');assert.equal(options.headers.authorization,'Bearer new-access');
  if(url.pathname==='/connections')return Response.json(rows);
  assert.equal(options.method,'DELETE');assert.equal(url.pathname,'/connections/connection-one');deletes++;
  return status===204?new Response(null,{status}):Response.json({error:'temporary_failure'},{status});
 });
 const grant={accessToken:'expired',refreshToken:'current-refresh',tenantId:'tenant-one',xeroConnectionId:'connection-one',expiresAt:new Date(0).toISOString()};
 assert.equal(await xero.revokeAuthorization(grant),true);assert.equal(refreshes,1);assert.equal(deletes,1);
 status=503;await assert.rejects(xero.revokeAuthorization(grant));assert.equal(deletes,2,'Uncertain DELETE is attempted once');
 status=204;rows=[{id:'other-user-connection',tenantId:'tenant-one'}];
 assert.equal(await xero.revokeAuthorization(grant),true);assert.equal(deletes,2,'A different connection is not removed');
 rows=[{id:'connection-one',tenantId:'tenant-one'},{id:'other-user-connection',tenantId:'tenant-one'}];
 const legacy={...grant};delete legacy.xeroConnectionId;
 await assert.rejects(xero.revokeAuthorization(legacy),/one connection to remove/);assert.equal(deletes,2);
 rows=[{id:'connection-one',tenantId:'tenant-one'}];assert.equal(await xero.revokeAuthorization(legacy),true);assert.equal(deletes,3);
});

test('Xero connection retirement is admitted without opening unrelated unfunded writes',async t=>{
 const network=require('../../src/commercial/network');
 t.mock.method(require('../../src/commercial/entitlements'),'assertCapability',async()=>{});
 const context={database:{},scope:{workspaceId:'owned-workspace'}};
 const allowed=await network.before(context,'https://api.xero.com/connections/connection-one',{method:'DELETE'},'Xero');
 assert.equal(allowed.method,'DELETE');
 for(const url of ['https://api.xero.com/api.xro/2.0/Invoices','https://api.xero.com/connections',
  'https://api.xero.com/connections/one/extra','https://api.xero.com.example.test/connections/one'])
  await assert.rejects(network.before(context,url,{method:'DELETE'},'Xero'),/registered business operation/);
});
