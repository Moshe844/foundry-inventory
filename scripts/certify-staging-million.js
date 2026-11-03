'use strict';
// Runs on existing staging compute. Synthetic data only, no paid provider calls.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i<0?fallback:process.argv[i+1];};
const mode=arg('mode','prepare'),run=arg('run');
if(!['prepare','million','verify'].includes(mode)||!/^[a-z0-9-]{6,60}$/.test(run||''))throw Error('Choose prepare, million or verify and a stable qualification run ID.');
if(process.env.RENDER_SERVICE_ID!=='srv-daqh418473hc73853e7g')throw Error('Only the existing StockChief staging worker may run this qualification.');
const url=require('./lib/staging-database-guard').assertDatabase(process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL);
const db=require('../src/db/postgres').openPostgres(url.href,{max:2,applicationName:'staging-million-row-qualification'}),imports=require('../src/imports/postgres-service');
const root=path.join(os.tmpdir(),'stockchief-million-'+run);fs.mkdirSync(root,{recursive:true});
const stateFile=path.join(root,'checkpoint.json'),{warehouses}=require('./lib/staging-million-source');let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{run,paidCalls:0};
function save(){fs.writeFileSync(stateFile,JSON.stringify(state));}
async function capacity(maxBytes=38000000000){const bytes=Number((await db.query('SELECT pg_database_size(current_database()) bytes')).rows[0].bytes);if(bytes>maxBytes)throw Error('Qualification stopped before writing: the existing 50 GB database needs more free headroom. No hosting capacity was purchased.');return bytes;}
async function source(kind,count){return require('./lib/staging-million-source').write(root,kind,count,{run});}
async function execute(kind,count){const ctx=state.ctx,key=kind+':'+count;state.imports||={};let evidence=state.imports[key];if(evidence?.verified)return evidence;
 const file=await source(kind,count);let last='';const progress=phase=>async p=>{const rows=Number(p.processedRows||p.preparedRows||0),bucket=Math.floor(rows/50000),stamp=phase+':'+p.stage+':'+bucket;if(stamp!==last){last=stamp;const rss=process.memoryUsage().rss;if(rss>1536*1024*1024)throw Error('The qualification exceeded its 1.5 GiB memory ceiling and stopped.');await capacity(44000000000);console.log(JSON.stringify({stage:kind,phase:p.stage,rows,elapsedMs:Date.now()-evidence.startedAt,rss}));}};
 if(!evidence){evidence=state.imports[key]={startedAt:Date.now(),sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')};save();}
 let plan=evidence.planId?await imports.get(db,ctx.workspaceId,evidence.planId):null;
 if(!plan){plan=await imports.analyse(db,ctx,{buffer:fs.readFileSync(file),filename:path.basename(file),importMode:'add',allowModel:false,onProgress:progress('analysis')});assert.equal(plan.recordsValid,count);assert.equal(plan.recordsInvalid,0);evidence.planId=plan.id;evidence.integrityHash=plan.integrityHash;save();}
 await imports.approve(db,ctx,plan.id,evidence.integrityHash);const result=await imports.execute(db,ctx,plan.id,{onProgress:progress('execution')});assert(result.verified);Object.assign(evidence,{elapsedMs:Date.now()-evidence.startedAt,verified:true,rows:count,rowsImported:result.rowsImported,finishedAt:new Date().toISOString(),rss:process.memoryUsage().rss});save();return evidence;
}
(async()=>{try{
 const health=await (await fetch('https://stockchief-staging-web.onrender.com/healthz')).json();if(!health.ok||health.releaseRef!==arg('release'))throw Error('Exact healthy staging release required.');
 if(!state.ctx){
  if(mode!=='prepare')throw Error('Prepare this synthetic run first.');state.beforeBytes=await capacity();
  const auth=require('../src/domain/postgres-auth-service'),owner=await auth.createBusiness(db,{name:'Synthetic scale owner',businessName:'Synthetic ERP release million '+run,email:'stockchief-million-'+run+'@example.test',password:crypto.randomBytes(32).toString('base64url')});
  state.ctx={workspaceId:owner.workspaceId,actorId:owner.userId};state.accountId=owner.accountId;state.releaseRef=health.releaseRef;save();
  await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,current_period_start,current_period_end,source) VALUES($1,$2,'pro','approved-2026-11-02:pro','COMP','MONTHLY',now(),now()+interval '1 month','ISOLATED_STAGING_QUALIFICATION')",['million-sub-'+run,owner.accountId]);
  await require('../src/accounting/postgres-ledger').configure(db,state.ctx,{currency:'USD',startDate:'2026-01-01'});
  for(const name of warehouses)await require('../src/domain/postgres-location-service').createLocation(db,state.ctx,{name,kind:'warehouse'});
 }
 const owner=(await db.query('SELECT w.name,a.email FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1 AND a.id=$2',[state.ctx.workspaceId,state.accountId])).rows[0];if(owner?.name!=='Synthetic ERP release million '+run||owner.email!=='stockchief-million-'+run+'@example.test')throw Error('Synthetic identity guard');
 if(mode==='prepare'){await execute('catalogue',50000);const measured=(await db.query("SELECT item_id FROM skus WHERE workspace_id=$1 AND code='MILLION-4999-9'",[state.ctx.workspaceId])).rows[0];await db.transaction(c=>require('../src/domain/stock-quantity').save(c,state.ctx,measured.item_id,{unitLabel:'m',quantityPrecision:3,quantityIncrement:'0.001'}));await capacity();const benchmark=await execute('stock150k',150000);state.stock150kPassed=benchmark.elapsedMs<300000;}
 if(mode==='million'){if(!state.imports?.['stock150k:150000']?.verified)throw Error('Prepare and verify the synthetic opening stock first.');await capacity();
  for(const bin of require('./lib/staging-million-source').bins){const found=(await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND name=$2',[state.ctx.workspaceId,bin.name])).rows[0];if(!found){const parent=(await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND name=$2 AND parent_location_id IS NULL',[state.ctx.workspaceId,bin.warehouse])).rows[0];if(!parent)throw Error('The synthetic warehouse is missing.');await require('../src/domain/postgres-location-service').createLocation(db,state.ctx,{name:bin.name,kind:'bin',parentLocationId:parent.id});}}
  await execute('stockMillion',1000000);}
 const actual=(await db.query(`SELECT (SELECT count(*)::int FROM items WHERE workspace_id=$1) products,(SELECT count(*)::int FROM skus WHERE workspace_id=$1) skus,(SELECT count(*)::int FROM suppliers WHERE workspace_id=$1) suppliers,(SELECT count(*)::int FROM balances WHERE workspace_id=$1) positions,(SELECT sum(on_hand)::text FROM balances WHERE workspace_id=$1) units,(SELECT sum(total_cost_minor)::text FROM accounting_inventory_cost_balances WHERE workspace_id=$1) value_minor`,[state.ctx.workspaceId])).rows[0];
 if(state.imports?.['stockMillion:1000000']?.verified){assert.equal(actual.skus,50000);assert.equal(actual.products,5000);assert.equal(actual.suppliers,200);assert.equal(actual.positions,1150000);assert.equal(Number(actual.units),2650000.25);assert.equal(Number(actual.value_minor),530000050);const pnl=await require('../src/accounting/postgres-reports').profitAndLoss(db,state.ctx.workspaceId,{});assert.equal(pnl.netIncomeMinor,0);state.millionPassed=true;}
 state.actual=actual;state.afterBytes=await capacity(44000000000);save();console.log(JSON.stringify({mode,run,releaseRef:state.releaseRef,workspaceId:state.ctx.workspaceId,stock150kPassed:state.stock150kPassed,millionPassed:state.millionPassed||false,imports:state.imports,actual,beforeBytes:state.beforeBytes,afterBytes:state.afterBytes,paidCalls:0}));
 if(mode==='prepare'&&!state.stock150kPassed)process.exitCode=1;
 }finally{await db.close();}})().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
