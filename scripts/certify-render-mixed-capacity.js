'use strict';

// A bounded, authenticated mixed-workload probe against a disposable database on
// the same Render PostgreSQL instance as staging. Never points writes at the
// configured staging database; live providers are not initialized.
process.env.NODE_ENV='test';
process.env.ANTHROPIC_API_KEY='';
process.env.STOCKCHIEF_CHECKOUT_ENABLED='false';
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {openPostgres}=require('../src/db/postgres');
const {migratePostgres}=require('../src/db/migrate-postgres');
const {createPostgresApp}=require('../src/postgres-app');
const auth=require('../src/domain/postgres-auth-service');
const jobs=require('../src/operations/postgres-job-queue');
const ledger=require('../src/accounting/postgres-ledger');
const {newId}=require('../src/lib/util');

const smoke=process.argv.includes('--smoke');
const settings={levels:smoke?[1]:[5,10,25,50],seconds:smoke?8:30,maxRps:smoke?2:16,maxDurationMs:15*60*1000,
  maxP95Ms:2500,maxErrorRate:.02,maxDbConnectionFraction:.7};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function percentile(sorted,fraction){return Math.round(sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)]||0);}
function csrf(html){const value=/name="_csrf" value="([^"]+)"/.exec(html)?.[1];
 if(!value)throw Error('CSRF token missing from authenticated page');return value;}
function browser(base){let cookie='';async function send(method,path,body,form=false,csrfToken=null){
 const headers={};if(cookie)headers.cookie=cookie;
 if(csrfToken)headers['x-csrf-token']=csrfToken;
 if(body!==undefined)headers['content-type']=form?'application/x-www-form-urlencoded':'application/json';
 const response=await fetch(base+path,{method,redirect:'manual',headers,
  body:body===undefined?undefined:form?new URLSearchParams(body):JSON.stringify(body),
  signal:AbortSignal.timeout(15000)});
 const setCookie=response.headers.get('set-cookie');if(setCookie)cookie=setCookie.split(';')[0];
 const text=await response.text();let parsed=null;
 if(response.headers.get('content-type')?.includes('application/json'))try{parsed=JSON.parse(text);}catch{}
 return {status:response.status,text,body:parsed,headers:response.headers};}
 return {get:path=>send('GET',path),post:(path,body,options={})=>send('POST',path,body,
  options.form===true,options.csrf||null)};}
function sourceUrl(){const value=process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL;
 if(!value)throw Error('Render DATABASE_URL/FOUNDRY_DATABASE_URL is required');return new URL(value);}
function pathFor(index){return ['/inventory','/sales','/purchasing/orders','/accounting/books',
 '/settings/connections','/settings/shipping','/imports','/ask','/inventory?search=CAP-'][index%9];}
function safeName(){return `stockchief_cap_${crypto.randomBytes(6).toString('hex')}`;}
function metric(result){const rows=result.rows[0];return {connections:Number(rows.connections),
  activeConnections:Number(rows.active_connections),waitingConnections:Number(rows.waiting_connections),
  lockWaiters:Number(rows.lock_waiters),databaseBytes:Number(rows.database_bytes),
  deadlocks:Number(rows.deadlocks),temporaryBytes:Number(rows.temporary_bytes),
  blocksRead:Number(rows.blocks_read),blocksHit:Number(rows.blocks_hit),
  maxConnections:Number(rows.max_connections)};}
async function dbMetrics(db){return metric(await db.query(`SELECT
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()) AS connections,
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='active') AS active_connections,
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event IS NOT NULL) AS waiting_connections,
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS lock_waiters,
 pg_database_size(current_database()) AS database_bytes,
 (SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()) AS deadlocks,
 (SELECT temp_bytes FROM pg_stat_database WHERE datname=current_database()) AS temporary_bytes,
 (SELECT blks_read FROM pg_stat_database WHERE datname=current_database()) AS blocks_read,
 (SELECT blks_hit FROM pg_stat_database WHERE datname=current_database()) AS blocks_hit,
 current_setting('max_connections')::int AS max_connections`));}
async function registerFixtures(db,base,count){const agents=[];const fixtureId=crypto.randomBytes(4).toString('hex');
 for(let i=0;i<count;i++){
  const email=`capacity-${fixtureId}-${i}@example.test`,password=`Capacity-${fixtureId}-${i}-password!`;
  const owner=await auth.createBusiness(db,{name:`Capacity Owner ${i}`,businessName:`Capacity ${fixtureId} ${i}`,
   email,password});
  const now=new Date(),end=new Date(now.getTime()+31*86400000),plan=i%10<5?'starter':i%10<8?'growth':'pro';
  await db.query(`INSERT INTO account_subscriptions
   (id,account_id,plan_id,status,billing_interval,current_period_start,current_period_end,source)
   VALUES($1,$2,$3,'ACTIVE','MONTHLY',$4,$5,'TEST')`,
   [newId('sub'),owner.accountId,plan,now,end]);
  const location=newId('loc'),secondLocation=newId('loc'),item=newId('item'),sku=newId('sku');
  const supplier=newId('supplier'),customer=newId('customer');
  await db.query(`INSERT INTO locations(id,workspace_id,name,kind,is_active,created_at)
   VALUES($1,$2,'Capacity warehouse','warehouse',1,now())`,[location,owner.workspaceId]);
  await db.query(`INSERT INTO locations(id,workspace_id,name,kind,is_active,created_at)
   VALUES($1,$2,'Capacity overflow','warehouse',1,now())`,[secondLocation,owner.workspaceId]);
  await db.query(`INSERT INTO items(id,workspace_id,name,base_code,tracking_mode,is_active,created_at,updated_at)
   VALUES($1,$2,'Capacity product',$3,'quantity',1,now(),now())`,[item,owner.workspaceId,`CAP-${i}`]);
  await db.query(`INSERT INTO skus(id,workspace_id,item_id,code,is_default,is_active,created_at)
   VALUES($1,$2,$3,$4,1,1,now())`,[sku,owner.workspaceId,item,`CAP-${i}-1`]);
  await db.query(`INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at)
   VALUES($1,$2,'Capacity supplier','active','USD',now(),now())`,[supplier,owner.workspaceId]);
  await db.query(`INSERT INTO customers(id,workspace_id,name,email,record_state,created_by_user_id,created_at,updated_at)
   VALUES($1,$2,'Capacity customer',$3,'ACTIVE',$4,now(),now())`,
   [customer,owner.workspaceId,`capacity-buyer-${fixtureId}-${i}@example.test`,owner.userId]);
  await ledger.configure(db,{workspaceId:owner.workspaceId,actorId:owner.userId},
   {startDate:'2026-01-01',currency:'USD'});
  const agent=browser(base),login=await agent.get('/login');
  if(login.status!==200)throw Error(`Fixture login page ${login.status}`);
  const signed=await agent.post('/login',{_csrf:csrf(login.text),email,password,next:'/inventory'},
   {form:true});
  if(signed.status!==302)throw Error(`Fixture login ${signed.status}`);
  const page=await agent.get('/inventory');if(page.status!==200)throw Error(`Fixture inventory ${page.status}`);
  const token=csrf(page.text);
  const opening=await agent.post('/api/v1/business/inventory/receive',
   {skuId:sku,locationId:location,quantity:50,reference:'CAP-OPENING',
    idempotencyKey:`capacity:${fixtureId}:${i}:opening`},{csrf:token});
  if(opening.status!==201)throw Error(`Fixture opening inventory ${opening.status}: ${opening.text.slice(0,160)}`);
  agents.push({agent,csrf:token,workspaceId:owner.workspaceId,sku,location,secondLocation,
   supplier,customer,plan});
 }
 return agents;}
async function phase(db,agents,level){const rps=Math.min(settings.maxRps,Math.max(3,Math.ceil(level*.4)));
 const count=rps*settings.seconds,delay=1000/rps,observations=[],inflight=new Set();
 let providerCalls=0,bytesOut=0,completedJobs=0,maxPoolWaiters=0,maxConnections=0,maxLockWaiters=0;
 const started=performance.now(),startCpu=process.cpuUsage(),startDb=await dbMetrics(db),startMemory=process.memoryUsage().rss;
 const prefix=`capacity:${crypto.randomUUID()}:`;
 async function run(index){const actor=agents[index%level],kind=[
   'receive','ask','background','connector-event','mailbox','accounting-write','shipping',
   'import','search','sales-order','purchasing-write','inventory','transfer',
   'accounting-read','replenishment','import-job'][index%16];
  const since=performance.now();let status=200,size=0;
  try{
   if(['background','connector-event','mailbox','import-job'].includes(kind)){
    const result=await jobs.enqueue(db,{kind:'certification.noop',
     idempotencyKey:`${prefix}${index}`,payload:{workspaceId:actor.workspaceId,kind},maxAttempts:1});
    if(!result)throw Error('Job did not enqueue');
    const processed=await jobs.processOne(db,{'certification.noop':async()=>({kind})},
     {owner:`capacity-${index}`,leaseMs:30000});
    if(processed?.status!=='COMPLETED')throw Error('Job did not complete');completedJobs++;
   }else{
    let response;
    if(kind==='receive')response=await actor.agent.post('/api/v1/business/inventory/receive',
      {skuId:actor.sku,locationId:actor.location,quantity:1,
       reference:`CAP-${index}`,idempotencyKey:`${prefix}${index}`},{csrf:actor.csrf});
    else if(kind==='ask')response=await actor.agent.post('/ask',{_csrf:actor.csrf,
      message:'How many Capacity product do we have?'},{form:true});
    else if(kind==='transfer')response=await actor.agent.post('/api/v1/business/inventory/transfer',
      {skuId:actor.sku,sourceLocationId:actor.location,destinationLocationId:actor.secondLocation,
       quantity:1,reference:`CAP-TRANSFER-${index}`,idempotencyKey:`${prefix}${index}`},{csrf:actor.csrf});
    else if(kind==='purchasing-write')response=await actor.agent.post('/api/v1/business/purchasing/orders',
      {supplierId:actor.supplier,destinationLocationId:actor.location,idempotencyKey:`${prefix}${index}`,
       lines:[{skuId:actor.sku,quantityUnits:3,unitCost:8}]},{csrf:actor.csrf});
    else if(kind==='sales-order'){
      response=await actor.agent.post('/api/v1/business/sales/orders',
       {customerId:actor.customer,deliveryMethod:'PICKUP',idempotencyKey:`${prefix}${index}`,
        lines:[{skuId:actor.sku,quantity:1,unitPriceMinor:1500}]},{csrf:actor.csrf});
      if(response.status===201&&response.body?.result?.salesOrderId){
       const confirmed=await actor.agent.post(`/api/v1/business/sales/orders/${response.body.result.salesOrderId}/confirm`,
        {idempotencyKey:`${prefix}${index}:confirm`},{csrf:actor.csrf});
       if(confirmed.status!==200)response=confirmed;}}
    else if(kind==='accounting-write')response=await actor.agent.post('/api/v1/business/accounting/journals',
      {postingDate:new Date().toISOString().slice(0,10),sourceKey:`${prefix}${index}`,
       description:'Capacity fixture sale',sourceType:'sale',
       lines:[{accountKey:'ACCOUNTS_RECEIVABLE',debitMinor:1500},
        {accountKey:'SALES_REVENUE',creditMinor:1500}]},{csrf:actor.csrf});
    else {const paths={accounting:'/accounting/books',shipping:'/settings/shipping',
      'accounting-read':'/accounting/books',import:'/imports',search:'/inventory?search=CAP-',
      replenishment:'/planning',inventory:'/inventory'};
      response=await actor.agent.get(paths[kind]||pathFor(index));}
    status=response.status;size=Buffer.byteLength(response.text||JSON.stringify(response.body||{}));bytesOut+=size;
   }
  }catch(error){status='EXCEPTION';size=0;observations.push({kind,status,ms:performance.now()-since,
    error:String(error.message).slice(0,140)});return;}
  observations.push({kind,status,ms:performance.now()-since,size});
 }
 for(let i=0;i<count;i++){
  const wait=started+i*delay-performance.now();if(wait>0)await sleep(wait);
  if(inflight.size>=24)await Promise.race(inflight);
  const pending=run(i).finally(()=>inflight.delete(pending));inflight.add(pending);
  if(i%Math.max(1,rps*3)===0){const current=await dbMetrics(db);maxConnections=Math.max(maxConnections,current.connections);
   maxLockWaiters=Math.max(maxLockWaiters,current.lockWaiters);
   maxPoolWaiters=Math.max(maxPoolWaiters,db.poolMetrics().waiting);}
 }
 await Promise.all(inflight);
 const elapsedMs=performance.now()-started,endCpu=process.cpuUsage(startCpu),endDb=await dbMetrics(db);
 const durations=observations.map(x=>x.ms).sort((a,b)=>a-b),errors=observations.filter(x=>x.status==='EXCEPTION'||
   Number(x.status)>=400),cpuFraction=(endCpu.user+endCpu.system)/1000/elapsedMs;
 const queue=(await db.query(`SELECT status,count(*)::int AS count FROM stockchief_runtime.jobs
   WHERE idempotency_key LIKE $1 GROUP BY status`,[`${prefix}%`])).rows;
 const result={businesses:level,plannedRequests:count,completed:observations.length,
  durationMs:Math.round(elapsedMs),throughputRps:Number((observations.length/elapsedMs*1000).toFixed(2)),
  p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),p99Ms:percentile(durations,.99),
  errors:errors.length,errorRate:Number((errors.length/Math.max(1,observations.length)).toFixed(4)),
  errorsByKind:Object.fromEntries([...new Set(errors.map(x=>x.kind))].map(kind=>
   [kind,errors.filter(x=>x.kind===kind).map(x=>x.status).slice(0,12)])),
  byKind:Object.fromEntries([...new Set(observations.map(x=>x.kind))].map(kind=>{
   const items=observations.filter(x=>x.kind===kind),sorted=items.map(x=>x.ms).sort((a,b)=>a-b);
   return [kind,{count:items.length,p95Ms:percentile(sorted,.95),errors:items.filter(x=>x.status==='EXCEPTION'||Number(x.status)>=400).length}];})),
  process:{cpuFraction:Number(cpuFraction.toFixed(3)),rssStartBytes:startMemory,
   rssEndBytes:process.memoryUsage().rss,rssPeakBytes:process.memoryUsage().rss},
  postgres:{start:startDb,end:endDb,maxConnections,maxLockWaiters,maxPoolWaiters,
   storageGrowthBytes:endDb.databaseBytes-startDb.databaseBytes,
   temporaryBytes:endDb.temporaryBytes-startDb.temporaryBytes,
   deadlocks:endDb.deadlocks-startDb.deadlocks},
  queue,completedJobs,providerCalls,estimatedEgressBytes:bytesOut,
  safeByProbe:errors.length/Math.max(1,observations.length)<=settings.maxErrorRate&&
   percentile(durations,.95)<=settings.maxP95Ms&&
   maxConnections/endDb.maxConnections<settings.maxDbConnectionFraction&&maxLockWaiters===0};
 await db.query(`DELETE FROM stockchief_runtime.jobs WHERE kind='certification.noop' AND idempotency_key LIKE $1`,[`${prefix}%`]);
 return result;}
async function main(){const source=sourceUrl(),originalDatabase=decodeURIComponent(source.pathname.slice(1));
 if(!originalDatabase||originalDatabase.startsWith('stockchief_cap_'))throw Error('Unsafe source database');
 const name=safeName(),admin=openPostgres(source.toString(),{max:2,applicationName:'capacity-admin'});
 let db,app,server,created=false;
 try{
  await admin.query(`CREATE DATABASE ${name}`);created=true;
  const target=new URL(source);target.pathname=`/${name}`;
  db=openPostgres(target.toString(),{max:16,applicationName:'capacity-isolated'});
  await migratePostgres(db);
  const aiProvider=require('../tests/helpers/postgres-model-fixture').fixture({name:'capacity-fixture',model:'capacity-fixture',
   async complete(){return {data:{intent:'lookup',view:'inventory',action:null,search:'Capacity product',
    sku:null,location:null,fromLocation:null,toLocation:null,quantity:null,countedQuantity:null,reason:null,
    reference:null},usage:{}};}});
  app=createPostgresApp({database:db,env:'test',sessionSecret:`capacity-${crypto.randomUUID()}`,
   aiProvider,connectionProviders:{},shippingOptions:{},paymentOptions:{}});
  server=await new Promise(resolve=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const agents=await registerFixtures(db,base,Math.max(...settings.levels)),results=[];
  for(const level of settings.levels){const result=await phase(db,agents,level);results.push(result);
   console.log(JSON.stringify({event:'capacity_phase',...result}));
   if(!result.safeByProbe)break;
   if(performance.now()>settings.maxDurationMs)break;}
  console.log(JSON.stringify({event:'capacity_summary',database:name,sourceDatabase:originalDatabase,
   isolated:true,providerCalls:0,settings,results}));
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  if(app)await app.locals.sessionStore.close();
  if(db)await db.close();
  if(created){await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
   console.log(JSON.stringify({event:'capacity_cleanup',database:name,dropped:true}));}
  await admin.close();
 }}
main().catch(error=>{console.error(JSON.stringify({event:'capacity_error',message:error.message,stack:error.stack}));
 process.exitCode=1;});
