'use strict';
// Qualification only: page speed while a million-row import runs. One AWS task
// (2 vCPU) runs the real web app in this process and the million-row import in
// a separate child process, both against the synthetic qualification database.
// It times real signed-in page loads for the importing business (A) and for a
// different business (B), before, during and after the import. Synthetic data
// only; passwords are random and live only in this process.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{fork}=require('node:child_process');
const root=path.join(__dirname,'../..');
function log(value){console.log(JSON.stringify({event:'qualification_pages',at:new Date().toISOString(),...value}));}
const PAGES=['/','/needs-you','/orders','/inventory','/inventory/table?view=flat','/purchasing/orders','/money','/reports','/ask','PRODUCT','SEARCH'];

async function main(env=process.env){
 // A local smoke test (NODE_ENV=test only) may point at a disposable local database and skip the import.
 const local=env.NODE_ENV==='test'&&env.STOCKCHIEF_PAGES_LOCAL_URL;
 if(!local&&env.STOCKCHIEF_IMPORT_DATABASE_ROLE!=='stockchief_qualification')throw new Error('Runs only with the synthetic qualification role.');
 const run=String(env.STOCKCHIEF_QUALIFICATION_RUN||'').trim();if(!/^[a-z0-9-]{6,50}$/.test(run))throw new Error('Set a new lower-case run id.');
 const {connectionString,ca}=local?{connectionString:local}:require('./aws-database-connection').connection(env),open=(name,max)=>require('../db/postgres').openPostgres(connectionString,{max,...(ca?{ca}:{}),privateNetwork:false,requireTls:true,applicationName:name});
 const db=open('stockchief-qualification-pages',4),web=open('stockchief-qualification-web',10);
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pages-'));
 try{
  // Business B: a different, already-stocked business (50,000 SKUs, 150,000 positions).
  const fixture=require(path.join(root,'scripts/lib/staging-million-fixture')),source=require(path.join(root,'scripts/lib/staging-million-source')),imports=require('./postgres-service');
  const b=await fixture.provision(db,run+'-b'),bctx={workspaceId:b.workspaceId,actorId:b.userId};
  await require('../accounting/postgres-ledger').configure(db,bctx,{currency:'USD',startDate:'2026-01-01'});
  for(const name of source.warehouses)await require('../domain/postgres-location-service').createLocation(db,bctx,{name,kind:'warehouse'});
  for(const [kind,count]of [['catalogue',50000],['stock150k',150000]]){const file=source.write(directory,kind,count,{run:run+'-b'});
   const plan=await imports.analyse(db,bctx,{buffer:fs.readFileSync(file),filename:path.basename(file),importMode:'add',allowModel:false});
   await imports.approve(db,bctx,plan.id,plan.integrityHash);await imports.execute(db,bctx,plan.id);}
  log({stage:'business-b-ready'});
  // The real web app, with the real CSRF and password sign-in.
  const app=require('../postgres-app').createPostgresApp({database:web,env:'test',sessionSecret:crypto.randomBytes(32).toString('hex')});
  const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),base='http://127.0.0.1:'+server.address().port;
  const password=crypto.randomBytes(24).toString('base64url')+'!Aa7',hash=require('../domain/auth-service').hashPassword(password);
  async function signIn(email){
   await db.query("UPDATE accounts SET password_hash=$2 WHERE email=$1 AND email LIKE '%@example.test'",[email,hash]);
   let cookie='';const take=r=>{for(const c of r.headers.getSetCookie?.()||[])cookie=[...cookie.split('; ').filter(x=>x&&!x.startsWith(c.split('=')[0]+'=')),c.split(';')[0]].join('; ');};
   const page=await fetch(base+'/login',{redirect:'manual'});take(page);const csrf=/name="_csrf" value="([^"]+)"/.exec(await page.text())?.[1];
   const done=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf,email,password}).toString()});take(done);
   if(done.status!==303&&done.status!==302)throw new Error('Synthetic sign-in failed: '+done.status);return cookie;
  }
  const sessions={B:{cookie:await signIn('stockchief-million-'+run+'-b@example.test'),workspaceId:bctx.workspaceId}};
  async function targets(workspaceId){const item=(await db.query("SELECT item_id,code FROM skus WHERE workspace_id=$1 AND code='MILLION-2500-5'",[workspaceId])).rows[0];
   return PAGES.map(p=>p==='PRODUCT'?(item?'/inventory/'+item.item_id:null):p==='SEARCH'?'/search?q=MILLION-2500-5':p).filter(Boolean);}
  const results=[];let phase='before-import';
  async function measure(name){const s=sessions[name];if(!s)return;s.pages??=await targets(s.workspaceId);
   for(const page of s.pages){const started=performance.now();let status=0;
    try{const r=await fetch(base+page,{redirect:'manual',headers:{cookie:s.cookie},signal:AbortSignal.timeout(60000)});status=r.status;await r.arrayBuffer();}catch(e){status=e.name==='TimeoutError'?'timeout':'error';}
    results.push({business:name,phase,page,ms:Math.round(performance.now()-started),status,first:!s.seen?.has(page)});(s.seen??=new Set()).add(page);}}
  await measure('B');await measure('B');log({stage:'baseline-b',rows:results.length});
  // Business A: the million-row qualification in its own process.
  const steps=local?'none':'catalogue,stock150k,stockMillion';
  const child=steps==='none'?null:fork(path.join(__dirname,'aws-qualification-million.js'),[steps],{env:{...process.env,STOCKCHIEF_QUALIFICATION_RUN:run},stdio:['ignore','pipe','inherit','ipc']});
  let exited=child?null:0,line='';child?.on('exit',code=>{exited=code;});
  child?.stdout.on('data',chunk=>{line+=chunk;let i;while((i=line.indexOf('\n'))>=0){const text=line.slice(0,i);line=line.slice(i+1);process.stdout.write(text+'\n');
   try{const o=JSON.parse(text);if(o.kind==='stockMillion'&&o.phase)phase='million-'+(o.phase==='analysis'?'preview':'saving');else if(o.kind==='stockMillion'&&o.stage==='executed')phase='million-audit';else if(o.kind&&o.phase)phase='a-'+o.kind;}catch{}}});
  const aEmail='stockchief-million-'+run+'@example.test';
  while(exited===null){
   if(!sessions.A){const a=(await db.query("SELECT w.id FROM accounts a JOIN workspaces w ON w.owner_account_id=a.id WHERE a.email=$1",[aEmail])).rows[0];
    if(a&&phase.startsWith('million'))sessions.A={cookie:await signIn(aEmail),workspaceId:a.id};}
   await measure('B');await measure('A');await new Promise(r=>setTimeout(r,5000));
  }
  phase='after-import';await measure('A');await measure('B');await measure('A');await measure('B');
  server.close();
  const summary={};for(const r of results){const key=r.business+' '+r.phase+' '+r.page;const s=summary[key]??={business:r.business,phase:r.phase,page:r.page,n:0,max:0,ms:[],errors:0,first:null};
   s.n++;s.ms.push(r.ms);s.max=Math.max(s.max,r.ms);if(r.status!==200)s.errors++;if(r.first)s.first=r.ms;}
  for(const s of Object.values(summary)){s.ms.sort((x,y)=>x-y);s.median=s.ms[Math.floor(s.ms.length/2)];delete s.ms;}
  log({stage:'summary',importExit:exited,pages:Object.values(summary)});
  if(exited!==0)process.exitCode=1;
 }finally{fs.rmSync(directory,{recursive:true,force:true});await db.close();await web.close();}
}
if(require.main===module)main().catch(error=>{log({stage:'failed',code:error.code||error.name,message:String(error.message).slice(0,500)});process.exitCode=1;});
module.exports={main};
