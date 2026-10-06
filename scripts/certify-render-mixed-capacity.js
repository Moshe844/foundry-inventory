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
const imports=require('../src/imports/postgres-service');
const shipping=require('../src/shipping/postgres-service');
const shippingAccounts=require('../src/shipping/postgres-accounts');
const workflows=require('../src/operations/postgres-business-workflows');
const credentials=require('../src/connections/postgres-credential-store');
const runtimeHandlers=require('../src/operations/postgres-runtime-handlers');
const resourceMetrics=require('../src/commercial/resource-metrics');
const {newId}=require('../src/lib/util');

const smoke=process.argv.includes('--smoke');
const soak=process.argv.includes('--soak');
const realMixed=process.argv.includes('--real-mixed')||process.argv.includes('--real-mixed-smoke');
const realMixedSmoke=process.argv.includes('--real-mixed-smoke');
const settings={levels:realMixedSmoke?[1]:realMixed?[25]:smoke?[1]:soak?[25]:[5,10,25,50],
  seconds:realMixedSmoke?16:realMixed?300:smoke?8:soak?300:30,
  maxRps:realMixedSmoke?2:realMixed?10:smoke?2:16,maxDurationMs:15*60*1000,
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
  slowActiveQueries:Number(rows.slow_active_queries),oldestActiveQueryMs:Number(rows.oldest_active_query_ms),
  rollbacks:Number(rows.rollbacks),databaseErrors:Number(rows.database_errors),
  maxConnections:Number(rows.max_connections)};}
async function dbMetrics(db){return metric(await db.query(`SELECT
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()) AS connections,
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='active') AS active_connections,
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='active'
   AND wait_event IS NOT NULL) AS waiting_connections,
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS lock_waiters,
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='active'
   AND pid<>pg_backend_pid() AND clock_timestamp()-query_start>interval '1 second') AS slow_active_queries,
 (SELECT COALESCE(max(extract(epoch FROM clock_timestamp()-query_start)*1000),0)
   FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND pid<>pg_backend_pid()) AS oldest_active_query_ms,
 pg_database_size(current_database()) AS database_bytes,
 (SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()) AS deadlocks,
 (SELECT xact_rollback FROM pg_stat_database WHERE datname=current_database()) AS rollbacks,
 (SELECT conflicts FROM pg_stat_database WHERE datname=current_database()) AS database_errors,
 (SELECT temp_bytes FROM pg_stat_database WHERE datname=current_database()) AS temporary_bytes,
 (SELECT blks_read FROM pg_stat_database WHERE datname=current_database()) AS blocks_read,
 (SELECT blks_hit FROM pg_stat_database WHERE datname=current_database()) AS blocks_hit,
 current_setting('max_connections')::int AS max_connections`));}
async function registerFixtures(db,base,count){const agents=[];const fixtureId=crypto.randomBytes(4).toString('hex');
 for(let i=0;i<count;i++){
  const email=`capacity-${fixtureId}-${i}@example.test`,password=`Capacity-${fixtureId}-${i}-password!`;
  const owner=await auth.createBusiness(db,{name:`Capacity Owner ${i}`,businessName:`Capacity ${fixtureId} ${i}`,
   email,password});
  const now=new Date(),end=new Date(now.getTime()+31*86400000),plan=realMixedSmoke?'pro':i%10<5?'starter':i%10<8?'growth':'pro';
  await db.query(`INSERT INTO account_subscriptions
   (id,account_id,plan_id,status,billing_interval,current_period_start,current_period_end,source)
   VALUES($1,$2,$3,'ACTIVE','MONTHLY',$4,$5,'TEST')`,
   [newId('sub'),owner.accountId,plan,now,end]);
  const location=newId('loc'),secondLocation=newId('loc'),item=newId('item'),sku=newId('sku');
  const supplier=newId('supplier'),customer=newId('customer');
  await db.query(`INSERT INTO locations(id,workspace_id,name,kind,address,phone,is_active,created_at)
   VALUES($1,$2,'Capacity warehouse','warehouse','1 Main St, Monroe, NY 10950','845-555-0100',1,now())`,[location,owner.workspaceId]);
  await db.query(`INSERT INTO locations(id,workspace_id,name,kind,is_active,created_at)
   VALUES($1,$2,'Capacity overflow','warehouse',1,now())`,[secondLocation,owner.workspaceId]);
  await db.query(`INSERT INTO items(id,workspace_id,name,base_code,tracking_mode,is_active,created_at,updated_at)
   VALUES($1,$2,'Capacity product',$3,'quantity',1,now(),now())`,[item,owner.workspaceId,`CAP-${i}`]);
  await db.query(`INSERT INTO skus(id,workspace_id,item_id,code,is_default,is_active,created_at)
   VALUES($1,$2,$3,$4,1,1,now())`,[sku,owner.workspaceId,item,`CAP-${i}-1`]);
  const supplierEmail=`capacity-supplier-${fixtureId}-${i}@example.test`;
  await db.query(`INSERT INTO suppliers(id,workspace_id,name,email,status,currency,created_at,updated_at)
   VALUES($1,$2,'Capacity supplier',$3,'active','USD',now(),now())`,[supplier,owner.workspaceId,supplierEmail]);
  await db.query(`INSERT INTO customers(id,workspace_id,name,email,phone,shipping_address,record_state,created_by_user_id,created_at,updated_at)
   VALUES($1,$2,'Capacity customer',$3,'518-555-0100','10 Jobsite Rd, Albany, NY 12207','ACTIVE',$4,now(),now())`,
   [customer,owner.workspaceId,`capacity-buyer-${fixtureId}-${i}@example.test`,owner.userId]);
  let connectorId=null;
  if(realMixed&&plan!=='starter'){
   connectorId=newId('con');
   await db.query(`INSERT INTO workspace_connectors
    (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,
     expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
    VALUES($1,$2,$3,'Capacity Gmail','gmail','["business mail"]','{}','connected','["mail:read","mail:send"]',$4,
      5,'CONNECTED',$5,$6,$7,now(),now())`,[connectorId,owner.workspaceId,`gmail:${connectorId}`,
      `connection_credentials:${connectorId}`,owner.userId,`capacity-${i}`,`capacity-${i}@example.test`]);
   await db.transaction(client=>credentials.put(client,owner.workspaceId,connectorId,'provider',
    {accessToken:'capacity-mock-token',mailbox:`capacity-${i}@example.test`}));
   await shippingAccounts.connect(db,{workspaceId:owner.workspaceId,actorId:owner.userId},
    {provider:'shipengine',apiKey:'TEST_capacity_fixture_1234'});
  }
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
  agents.push({agent,csrf:token,workspaceId:owner.workspaceId,actorId:owner.userId,
   sku,location,secondLocation,supplier,supplierEmail,customer,connectorId,plan});
 }
 return agents;}
async function realImport(db,actor,key,index){
 const ctx={workspaceId:actor.workspaceId,actorId:actor.actorId};
 const code=`CAP-IMPORT-${index}-${key.slice(-8)}`.toUpperCase();
 const plan=await imports.analyse(db,ctx,{text:`Product,SKU,Location,Quantity\nCapacity imported ${index},${code},Capacity warehouse,2\n`,
  filename:`${code}.csv`,defaultLocationId:actor.location});
 if(plan.recordsValid!==1||plan.recordsInvalid!==0)throw Error(`Import preview not valid: ${plan.recordsValid}/${plan.recordsInvalid}`);
 await imports.approve(db,ctx,plan.id,plan.integrityHash);
 const result=await imports.execute(db,ctx,plan.id);
 const replay=await imports.execute(db,ctx,plan.id);
 if(result.duplicate||result.replayed||!(replay.duplicate||replay.replayed))throw Error('Import idempotency failed');
 return plan.id;
}
async function realShipping(db,actor,key,index,carrier){
 const ctx={workspaceId:actor.workspaceId,actorId:actor.actorId};
 const order=await workflows.createSalesOrder(db,ctx,{customerId:actor.customer,deliveryMethod:'SHIP',
  fulfillmentLocationId:actor.location,idempotencyKey:`${key}:order`,
  lines:[{skuId:actor.sku,quantity:1,unitPriceMinor:1500}]});
 await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:`${key}:confirm`});
 const parcel=await shipping.prepare(db,ctx,order.salesOrderId,{idempotencyKey:`${key}:prepare`,
  lines:[{lineId:order.lineIds[0],locationId:actor.location,quantity:1}]});
 if(index%5===0){const replay=await shipping.prepare(db,ctx,order.salesOrderId,{idempotencyKey:`${key}:prepare`,
  lines:[{lineId:order.lineIds[0],locationId:actor.location,quantity:1}]});
  if(!replay.replayed||replay.shipmentId!==parcel.shipmentId)throw Error('Shipping prepare idempotency failed');}
 await shipping.setPackages(db,ctx,parcel.shipmentId,[{weightGrams:850,lengthMm:200,widthMm:150,heightMm:100}]);
 const quoted=await shipping.quote(db,ctx,parcel.shipmentId,{provider:carrier,idempotencyKey:`${key}:quote`});
 if(quoted.rates.length!==1)throw Error(`Shipping quote expected one stored rate, got ${quoted.rates.length}`);
 return parcel.shipmentId;
}
async function phase(db,agents,level){const rps=Math.min(settings.maxRps,Math.max(3,Math.ceil(level*.4)));
 const count=rps*settings.seconds,delay=1000/rps,observations=[],inflight=new Set();
 let providerCalls=0,bytesOut=0,completedJobs=0,maxPoolWaiters=0,maxConnections=0,maxLockWaiters=0;
 let maxSlowActiveQueries=0,maxOldestActiveQueryMs=0,maxQueueDepth=0,maxQueueAgeMs=0;
 const mixed={mailAccepted:0,mailReplayed:0,mailPolls:0,imports:0,shipments:0,quotes:0,
  autopilotEvaluations:0};
 const eligible=agents.slice(0,level).filter(actor=>actor.plan!=='starter');
 const pro=agents.slice(0,level).filter(actor=>actor.plan==='pro');
 const seenMail=new Map();
 const mailboxAdapter={async poll({credentials}){
  providerCalls++;
  const mailbox=String(credentials.mailbox),actor=eligible.find(item=>`capacity-${agents.indexOf(item)}@example.test`===mailbox);
  if(!actor)throw Error('Mock mailbox does not match an eligible fixture');
  const previous=seenMail.get(mailbox)||0,next=previous+1;seenMail.set(mailbox,next);
  const messageId=`capacity-message-${mailbox}-${Math.ceil(next/5)*5}`;
  return {cursor:`capacity-cursor-${next}`,messages:[{messageId,threadId:`thread-${messageId}`,
   sender:actor.supplierEmail,recipients:[mailbox],subject:`Capacity supplier ${next}`,
   bodyText:'Please confirm delivery time for our inventory order.',receivedAt:new Date().toISOString()}]};
 }};
 const mailboxHandler=runtimeHandlers.create({get:type=>type==='gmail'?mailboxAdapter:null})['mailbox.poll'];
 const carrier={async quote(){providerCalls++;return {providerShipmentIds:[`capacity-quote-${crypto.randomUUID()}`],rates:[
  {rateId:`rate-${crypto.randomUUID()}`,carrier:'ups',service:'Ground',amountMinor:1299,currency:'USD',deliveryDays:3}]};}};
 const phaseStartedAt=new Date(),started=performance.now(),startCpu=process.cpuUsage(),
  startDb=await dbMetrics(db),startMemory=process.memoryUsage().rss;
 const prefix=`capacity:${crypto.randomUUID()}:`;
 async function run(index){let actor=agents[index%level];const kinds=realMixed?[
   'receive','ask','background','inventory','mailbox','accounting-write','shipping',
   'import','search','sales-order','purchasing-write','inventory','transfer',
   'accounting-read','replenishment','import-job']: [
   'receive','ask','background','connector-event','mailbox','accounting-write','shipping',
   'import','search','sales-order','purchasing-write','inventory','transfer',
   'accounting-read','replenishment','import-job'];
  const occurrence=Math.floor(index/kinds.length);let kind=kinds[index%kinds.length];
  if(realMixed){
   // Polls, imports, quotes and autonomous evaluations are periodic work, not
   // something each business repeats on every page view. Keep the mix realistic.
   if(kind==='background'&&occurrence%20!==0)kind='replenishment';
   if(kind==='mailbox'&&!realMixedSmoke&&occurrence%13!==0)kind='connections-read';
   if(kind==='shipping'&&occurrence%5!==0)kind='shipping-read';
   if((kind==='import'||kind==='import-job')&&occurrence%7!==0)kind='imports-read';
   if(kind==='background')actor=pro[Math.floor(occurrence/20)%pro.length];
   if(kind==='mailbox'||kind==='shipping')actor=eligible[occurrence%eligible.length];
  }
  const since=performance.now();let status=200,size=0;
  try{
   if(realMixed&&kind==='mailbox'){
    const queued=await jobs.enqueue(db,{workspaceId:actor.workspaceId,kind:'mailbox.poll',
     idempotencyKey:`${prefix}${index}`,payload:{connectorId:actor.connectorId},maxAttempts:1});
    if(!queued.created)throw Error('Mailbox job unexpectedly duplicated');
    const processed=await resourceMetrics.measure(db,{runtimeKind:'worker',operation:'mailbox.poll'},
     ()=>jobs.processOne(db,{'mailbox.poll':mailboxHandler},
      {owner:`capacity-mail-${index}`,leaseMs:60000}));
    if(processed?.status!=='COMPLETED')throw Error(`Mailbox job ${processed?.status||'missing'}`);
    mixed.mailPolls++;mixed.mailAccepted+=processed.result.accepted;mixed.mailReplayed+=processed.result.replayed;
    completedJobs++;
   }else if(realMixed&&kind==='background'){
    const queued=await jobs.enqueue(db,{workspaceId:actor.workspaceId,kind:'autopilot.evaluate',
     idempotencyKey:`${prefix}${index}`,payload:{actorId:actor.actorId},maxAttempts:1});
    if(!queued.created)throw Error('Autopilot job unexpectedly duplicated');
    const processed=await resourceMetrics.measure(db,{runtimeKind:'worker',operation:'autopilot.evaluate'},
     ()=>jobs.processOne(db,{'autopilot.evaluate':runtimeHandlers.create()['autopilot.evaluate']},
      {owner:`capacity-autopilot-${index}`,leaseMs:60000}));
    if(processed?.status!=='COMPLETED')throw Error(`Autopilot job ${processed?.status||'missing'}`);
    mixed.autopilotEvaluations++;completedJobs++;
   }else if(realMixed&&(kind==='import'||kind==='import-job')){
    await resourceMetrics.measure(db,{runtimeKind:'worker',operation:'import.execute'},
     ()=>realImport(db,actor,`${prefix}${index}`,index));mixed.imports++;
   }else if(realMixed&&kind==='shipping'){
    await resourceMetrics.measure(db,{runtimeKind:'worker',operation:'shipping.quote'},
     ()=>realShipping(db,actor,`${prefix}${index}`,index,carrier));mixed.shipments++;mixed.quotes++;
   }else if(['background','connector-event','mailbox','import-job'].includes(kind)){
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
      'shipping-read':'/settings/shipping','connections-read':'/settings/connections',
      'imports-read':'/imports','accounting-read':'/accounting/books',import:'/imports',search:'/inventory?search=CAP-',
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
   maxPoolWaiters=Math.max(maxPoolWaiters,db.poolMetrics().waiting);
   maxSlowActiveQueries=Math.max(maxSlowActiveQueries,current.slowActiveQueries);
   maxOldestActiveQueryMs=Math.max(maxOldestActiveQueryMs,current.oldestActiveQueryMs);
   const q=(await db.query(`SELECT count(*) FILTER(WHERE status IN ('PENDING','RETRY','RUNNING'))::int AS depth,
    COALESCE(max(extract(epoch FROM clock_timestamp()-created_at)*1000)
    FILTER(WHERE status IN ('PENDING','RETRY','RUNNING')),0) AS oldest_ms
    FROM stockchief_runtime.jobs WHERE idempotency_key LIKE $1`,[`${prefix}%`])).rows[0];
   maxQueueDepth=Math.max(maxQueueDepth,Number(q.depth));maxQueueAgeMs=Math.max(maxQueueAgeMs,Number(q.oldest_ms));}
 }
 await Promise.all(inflight);
 const elapsedMs=performance.now()-started,endCpu=process.cpuUsage(startCpu),endDb=await dbMetrics(db);
 const durations=observations.map(x=>x.ms).sort((a,b)=>a-b),errors=observations.filter(x=>x.status==='EXCEPTION'||
   Number(x.status)>=400),cpuFraction=(endCpu.user+endCpu.system)/1000/elapsedMs;
 const queue=(await db.query(`SELECT status,count(*)::int AS count FROM stockchief_runtime.jobs
   WHERE idempotency_key LIKE $1 GROUP BY status`,[`${prefix}%`])).rows;
 const queryTelemetry=(await db.query(`SELECT count(*)::int AS measured_operations,
  count(*) FILTER(WHERE database_queries>0)::int AS operations_with_queries,
  COALESCE(percentile_cont(0.95) WITHIN GROUP(ORDER BY database_microseconds/NULLIF(database_queries,0))
   FILTER(WHERE database_queries>0),0)::numeric AS p95_mean_query_us,
  COALESCE(max(database_microseconds/NULLIF(database_queries,0)),0) AS max_mean_query_us,
  count(*) FILTER(WHERE database_microseconds/NULLIF(database_queries,0)>100000)::int AS slow_mean_query_operations,
  count(*) FILTER(WHERE outcome='FAILED')::int AS failed_operations
  FROM commercial_resource_measurements WHERE started_at>=$1`,[phaseStartedAt])).rows[0];
 let integrity=null;
 if(realMixed){
  const counts=(await db.query(`SELECT
   (SELECT count(*) FROM import_executions WHERE status='SUCCEEDED')::int AS successful_imports,
   (SELECT count(*) FROM sales_shipments WHERE status='PACKED')::int AS packed_shipments,
   (SELECT count(*) FROM shipment_rates)::int AS stored_rates,
   (SELECT count(*) FROM connection_email_messages)::int AS accepted_mail,
   (SELECT count(*) FROM stockchief_runtime.jobs WHERE kind='mailbox.poll' AND status='COMPLETED')::int AS completed_mail_jobs,
   (SELECT count(*) FROM stockchief_runtime.jobs WHERE kind='mailbox.poll' AND status IN ('PENDING','RETRY','RUNNING','DEAD'))::int AS unfinished_mail_jobs,
   (SELECT count(*) FROM balances b LEFT JOIN
    (SELECT workspace_id,sku_id,location_id,sum(quantity_delta) AS total FROM movements GROUP BY workspace_id,sku_id,location_id) m
    ON m.workspace_id=b.workspace_id AND m.sku_id=b.sku_id AND m.location_id=b.location_id
    WHERE b.on_hand<>COALESCE(m.total,0) OR b.on_hand<0)::int AS balance_mismatches,
   (SELECT count(*) FROM (SELECT workspace_id,connector_id,external_message_id,count(*) AS copies
    FROM connection_email_messages GROUP BY workspace_id,connector_id,external_message_id HAVING count(*)>1) duplicate)::int AS duplicate_mail,
   (SELECT count(*) FROM (SELECT workspace_id,source_hash,count(*) AS copies FROM import_plans
    WHERE status='SUCCEEDED' GROUP BY workspace_id,source_hash HAVING count(*)>1) duplicate)::int AS duplicate_imports`)).rows[0];
  integrity={...counts,expected:{imports:mixed.imports,shipments:mixed.shipments,rates:mixed.quotes,
   acceptedMail:mixed.mailAccepted,mailJobs:mixed.mailPolls},passed:
    counts.successful_imports===mixed.imports&&counts.packed_shipments===mixed.shipments&&
    counts.stored_rates===mixed.quotes&&counts.accepted_mail===mixed.mailAccepted&&
    counts.completed_mail_jobs===mixed.mailPolls&&counts.unfinished_mail_jobs===0&&
    counts.balance_mismatches===0&&counts.duplicate_mail===0&&counts.duplicate_imports===0};
 }
 const result={businesses:level,plannedRequests:count,completed:observations.length,
  durationMs:Math.round(elapsedMs),throughputRps:Number((observations.length/elapsedMs*1000).toFixed(2)),
  p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),p99Ms:percentile(durations,.99),
  errors:errors.length,errorRate:Number((errors.length/Math.max(1,observations.length)).toFixed(4)),
  errorsByKind:Object.fromEntries([...new Set(errors.map(x=>x.kind))].map(kind=>
   [kind,errors.filter(x=>x.kind===kind).map(x=>x.status).slice(0,12)])),
  errorSamples:errors.slice(0,12).map(x=>({kind:x.kind,status:x.status,error:x.error||null})),
  byKind:Object.fromEntries([...new Set(observations.map(x=>x.kind))].map(kind=>{
   const items=observations.filter(x=>x.kind===kind),sorted=items.map(x=>x.ms).sort((a,b)=>a-b);
   return [kind,{count:items.length,p95Ms:percentile(sorted,.95),errors:items.filter(x=>x.status==='EXCEPTION'||Number(x.status)>=400).length}];})),
  process:{cpuFraction:Number(cpuFraction.toFixed(3)),rssStartBytes:startMemory,
   rssEndBytes:process.memoryUsage().rss,rssPeakBytes:process.memoryUsage().rss},
  postgres:{start:startDb,end:endDb,maxConnections,maxLockWaiters,maxPoolWaiters,
   maxSlowActiveQueries,maxOldestActiveQueryMs,connectionErrors:db.connectionErrors?.length||0,
   queryTelemetry:{measuredOperations:Number(queryTelemetry.measured_operations),
    operationsWithQueries:Number(queryTelemetry.operations_with_queries),
    p95MeanQueryMs:Number((Number(queryTelemetry.p95_mean_query_us)/1000).toFixed(2)),
    maxMeanQueryMs:Number((Number(queryTelemetry.max_mean_query_us)/1000).toFixed(2)),
    slowMeanQueryOperations:Number(queryTelemetry.slow_mean_query_operations),
    failedOperations:Number(queryTelemetry.failed_operations)},
   storageGrowthBytes:endDb.databaseBytes-startDb.databaseBytes,
   temporaryBytes:endDb.temporaryBytes-startDb.temporaryBytes,
   deadlocks:endDb.deadlocks-startDb.deadlocks,rollbacks:endDb.rollbacks-startDb.rollbacks,
   databaseErrors:endDb.databaseErrors-startDb.databaseErrors},
  queue:{statuses:queue,maxDepth:maxQueueDepth,maxAgeMs:Math.round(maxQueueAgeMs)},
  completedJobs,mixed,integrity,mockedProviderBoundaryCalls:providerCalls,liveProviderCalls:0,
  estimatedEgressBytes:bytesOut,
  safeByProbe:errors.length/Math.max(1,observations.length)<=settings.maxErrorRate&&
   percentile(durations,.95)<=settings.maxP95Ms&&
   maxConnections/endDb.maxConnections<settings.maxDbConnectionFraction&&maxLockWaiters===0&&
   maxPoolWaiters===0&&(!realMixed||queue.every(row=>row.status==='COMPLETED'))&&
   maxQueueAgeMs<60000&&(integrity===null||integrity.passed)};
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
   isolated:true,providerCalls:0,liveProviderCalls:0,settings,results}));
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
