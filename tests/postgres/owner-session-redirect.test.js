'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('private authentication persists before redirect headers and failed session writes grant no authority',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db}=f;
 const store=new(require('../../src/web/postgres-session-store').PostgresSessionStore)(db),originalSet=store.set.bind(store);
 let mode='delay',faultInjected=false,writesStarted=0,writesFinished=0;
 store.set=(id,value,callback)=>{
  const authentication=value.ownerPending||value.owner;
  if(!faultInjected&&(mode==='fail-password'&&value.ownerPending||mode==='fail-mfa'&&value.owner)){
   faultInjected=true;return setImmediate(()=>callback(Object.assign(Error('Synthetic session write failure'),{code:'FIXTURE_WRITE_FAILED'})));
  }
  if(mode==='delay'&&authentication){writesStarted++;return setTimeout(()=>originalSet(id,value,error=>{writesFinished++;callback(error);}),250);}
  return originalSet(id,value,callback);
 };
 const app=require('../../src/platform-owner/app').createOwnerConsole({database:db,store,sessionSecret:'isolated-durable-owner-session',env:'test'}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),base='http://127.0.0.1:'+server.address().port;
 f.cleanup(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await store.close();});
 const csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)?.[1];
 for(const scenario of ['delay','fail-password','fail-mfa']){
  mode=scenario;faultInjected=false;
  const email=randomUUID()+'@example.test',account=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Isolated console owner',businessName:'Durable private sign-in',email,password:f.password});
  await db.query("INSERT INTO platform_console_operators(account_id,role,granted_by) VALUES($1,'OWNER','ISOLATED_AUTHENTICATION_REGRESSION')",[account.accountId]);
  const jar=new Map();
  async function send(route,options={}){
   const response=await fetch(base+route,{...options,redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...options.headers}});
   for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';',1)[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1));}
   return response;
  }
  const first=await send('/login'),firstHtml=await first.text();
  const login=await send('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf(firstHtml),email,password:f.password})});
  if(scenario==='fail-password'){
   assert.equal(login.status,500);assert.equal(login.headers.get('location'),null);await login.text();
  }else{
   assert.equal(login.status,303);assert.equal(login.headers.get('location'),'/verify');
   // Follow as soon as headers arrive, before consuming the redirect body.
   const challenge=await send('/verify'),html=await challenge.text();await login.text();
   assert.equal(challenge.status,200,'Password redirect must find the saved MFA challenge');
   const secret=/class="setup-key">([^<]+)/.exec(html)?.[1];assert(secret);
   if(scenario==='delay'){
    const denied=await send('/verify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf(html),code:'invalid'})});assert.equal(denied.status,303);assert.equal(denied.headers.get('location'),'/verify');
    const retry=await send('/verify'),retryHtml=await retry.text();await denied.text();assert.equal(retry.status,200);assert.match(retryHtml,/invalid, expired or already used/,'The failed-MFA message must be saved before its redirect');
    assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.sessions WHERE data->'owner'->>'accountId'=$1",[account.accountId])).rows[0].n,0);
   }
   const code=require('../../src/platform-owner/auth').codeAt(secret,Math.floor(Date.now()/30000));
   const verified=await send('/verify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf(html),code})});
   if(scenario==='fail-mfa'){
    assert.equal(verified.status,500);assert.equal(verified.headers.get('location'),null);await verified.text();
   }else{
    assert.equal(verified.status,303);assert.equal(verified.headers.get('location'),'/');
    const landing=await send('/'),landingHtml=await landing.text();await verified.text();assert.equal(landing.status,200,'MFA redirect must find the authenticated session');assert.match(landingHtml,/MFA verified/);assert(writesStarted>=2);assert.equal(writesFinished,writesStarted);continue;
   }
  }
  assert(faultInjected);const refused=await send('/');assert.equal(refused.status,303);assert.equal(refused.headers.get('location'),'/login');await refused.text();
  assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.sessions WHERE data->'owner'->>'accountId'=$1",[account.accountId])).rows[0].n,0,'A failed write must not be silently saved again while sending the error');
 }
 t.diagnostic(JSON.stringify({redirectsFollowedAtHeaders:true,delayedPersistence:true,passwordAndMfaFailureClosed:true,realMfa:true,liveAccountsChanged:0,paidCalls:0}));
});
