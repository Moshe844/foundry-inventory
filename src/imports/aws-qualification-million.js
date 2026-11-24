'use strict';
// Qualification only: the million-row import benchmark, run as a one-off task
// inside AWS beside the database with the import worker's own task definition.
// It connects with the scoped qualification role, so it can reach only the
// separate synthetic database. Synthetic data only; no paid provider calls.
// Steps (argv[2], comma separated): customer150k, catalogue, stock150k, stockMillion,
// audit-only. customer150k imports the website-test shape into its own business.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'../..');

function log(value){console.log(JSON.stringify({event:'qualification_million',at:new Date().toISOString(),...value}));}

async function run(env=process.env,steps=(process.argv[2]||'catalogue,stock150k,stockMillion').split(',')){
 if(env.STOCKCHIEF_IMPORT_DATABASE_ROLE!=='stockchief_qualification')throw new Error('The million-row benchmark runs only with the synthetic qualification role.');
 const {connectionString,ca}=require('./aws-database-connection').connection(env);
 const db=require('../db/postgres').openPostgres(connectionString,{max:6,...(ca?{ca}:{}),privateNetwork:false,requireTls:true,applicationName:'stockchief-qualification-million'});
 const imports=require('./postgres-service'),source=require(path.join(root,'scripts/lib/staging-million-source'));
 const run=String(env.STOCKCHIEF_QUALIFICATION_RUN||'').trim();
 if(!/^[a-z0-9-]{6,60}$/.test(run))throw new Error('Set STOCKCHIEF_QUALIFICATION_RUN to a new lower-case run id.');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'million-'));
 try{
  const where=(await db.query('SELECT current_user AS role,current_database() AS database,version() AS version')).rows[0];
  if(where.role!=='stockchief_qualification'||where.database!=='stockchief_qualification')throw new Error('Refusing to run outside the synthetic qualification database.');
  log({stage:'connected',database:where.database,postgres:where.version.split(' ').slice(0,2).join(' '),cpus:os.cpus().length,memoryMb:Math.round(os.totalmem()/1048576),stockWorkers:Number(env.FOUNDRY_IMPORT_STOCK_WORKERS||0),copy:env.STOCKCHIEF_IMPORT_COPY==='true'});
  const owner=await require(path.join(root,'scripts/lib/staging-million-fixture')).provision(db,run),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
  if(!(await db.query('SELECT 1 FROM locations WHERE workspace_id=$1 LIMIT 1',[ctx.workspaceId])).rowCount){
   await require('../accounting/postgres-ledger').configure(db,ctx,{currency:'USD',startDate:'2026-01-01'});
   for(const name of source.warehouses)await require('../domain/postgres-location-service').createLocation(db,ctx,{name,kind:'warehouse'});
  }
  let peakRss=0;const sources=[];
  async function execute(kind,count,{file=source.write(directory,kind,count,{run}),context=ctx}={}){
   const started=Date.now();let last='';
   const progress=phase=>async p=>{const rows=Number(p.processedRows||p.preparedRows||0),stamp=phase+':'+p.stage+':'+Math.floor(rows/50000),rss=process.memoryUsage().rss;peakRss=Math.max(peakRss,rss);
    if(stamp!==last){last=stamp;log({kind,phase,stage:p.stage,rows,elapsedMs:Date.now()-started,rssMb:Math.round(rss/1048576)});}};
   const plan=await imports.analyse(db,context,{buffer:fs.readFileSync(file),filename:path.basename(file),importMode:'add',allowModel:false,onProgress:progress('analysis')});
   const analysedMs=Date.now()-started;log({kind,stage:'analysed',ms:analysedMs,valid:plan.recordsValid,invalid:plan.recordsInvalid});
   assert.equal(plan.recordsValid,count);assert.equal(plan.recordsInvalid,0);
   await imports.approve(db,context,plan.id,plan.integrityHash);
   const result=await imports.execute(db,context,plan.id,{onProgress:progress('execution')});
   assert(result.verified);if(context===ctx)sources.push({planId:plan.id,file});
   log({kind,stage:'executed',analysisMs:analysedMs,savingMs:Date.now()-started-analysedMs,totalMs:Date.now()-started,rows:result.rowsImported,stockLanes:result.stockLanes||0,peakRssMb:Math.round(peakRss/1048576)});
   return plan.id;
  }
  if(steps.includes('customer150k')){
   // The website test's file shape, in a business of its own: 30,000 new
   // products in five sizes with barcode, category, cost, price and quantity.
   const owner=await require(path.join(root,'scripts/lib/staging-million-fixture')).provision(db,run+'-c'),customer={workspaceId:owner.workspaceId,actorId:owner.userId};
   await require('../accounting/postgres-ledger').configure(db,customer,{currency:'USD',startDate:'2026-01-01'});
   await require('../domain/postgres-location-service').createLocation(db,customer,{name:'NJ-Main',kind:'warehouse'});
   const file=require(path.join(root,'scripts/lib/customer-file-source')).write(directory,{products:30000});
   const planId=await execute('customer150k',150000,{file,context:customer});
   const audit=await require(path.join(root,'scripts/lib/import-audit')).audit(db,customer.workspaceId,[{planId,file}]);
   log({kind:'customer150k',stage:'audited',...audit});if(!audit.passed)throw new Error('The independent import audit found differences.');
  }
  if(steps.includes('audit-only')){
   // Re-audit a finished run without importing again: regenerate its exact
   // sources (deterministic for the run) and find the plans by source name.
   for(const [kind,count]of [['catalogue',50000],['stock150k',150000],['stockMillion',1000000]]){
    const file=source.write(directory,kind,count,{run}),plan=(await db.query("SELECT id FROM import_plans WHERE workspace_id=$1 AND source_name=$2 AND status='SUCCEEDED' ORDER BY created_at DESC LIMIT 1",[ctx.workspaceId,path.basename(file)])).rows[0];
    if(plan)sources.push({planId:plan.id,file});
   }
   if(sources.length!==3)throw new Error('This run does not have three finished imports to audit.');
  }
  if(steps.includes('catalogue')){
   await execute('catalogue',50000);
   // The last stock source row carries a decimal quantity for this measured SKU.
   const measured=(await db.query("SELECT item_id FROM skus WHERE workspace_id=$1 AND code='MILLION-4999-9'",[ctx.workspaceId])).rows[0];
   await db.transaction(c=>require('../domain/stock-quantity').save(c,ctx,measured.item_id,{unitLabel:'m',quantityPrecision:3,quantityIncrement:'0.001'}));
  }
  if(steps.includes('stock150k'))await execute('stock150k',150000);
  if(steps.includes('stockMillion')){
   for(const bin of source.bins){if((await db.query('SELECT 1 FROM locations WHERE workspace_id=$1 AND name=$2',[ctx.workspaceId,bin.name])).rowCount)continue;
    const parent=(await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND name=$2 AND parent_location_id IS NULL',[ctx.workspaceId,bin.warehouse])).rows[0];
    await require('../domain/postgres-location-service').createLocation(db,ctx,{name:bin.name,kind:'bin',parentLocationId:parent.id});}
   await execute('stockMillion',1000000);
  }
  const actual=(await db.query(`SELECT (SELECT count(*)::int FROM skus WHERE workspace_id=$1) skus,(SELECT count(*)::int FROM balances WHERE workspace_id=$1) positions,
   (SELECT sum(on_hand)::text FROM balances WHERE workspace_id=$1) units,(SELECT sum(total_cost_minor)::text FROM accounting_inventory_cost_balances WHERE workspace_id=$1) value_minor`,[ctx.workspaceId])).rows[0];
  // Independent audit: re-read every source file and compare each product and
  // location, row status, receipts, value and the ledger with the database.
  if(sources.length){const auditStarted=Date.now(),audit=await require(path.join(root,'scripts/lib/import-audit')).audit(db,ctx.workspaceId,sources);
  log({stage:'audited',ms:Date.now()-auditStarted,...audit});
  if(!audit.passed)throw new Error('The independent import audit found differences.');}
  log({stage:'done',actual});
  return actual;
 }finally{fs.rmSync(directory,{recursive:true,force:true});await db.close();}
}
if(require.main===module)run().catch(error=>{log({stage:'failed',code:error.code||error.name,message:String(error.message).slice(0,500)});process.exitCode=1;});
module.exports={run};
