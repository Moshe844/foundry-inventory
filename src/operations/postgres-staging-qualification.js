'use strict';
const path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
function specification(job,env=process.env){
 if(!/^[a-zA-Z0-9_-]{1,120}$/.test(job.id||''))throw Error('Invalid qualification job identity.');
 if(env.RENDER_SERVICE_ID!=='srv-daqh418473hc73853e7g')throw Error('Qualification runs only on the existing staging worker.');
 require('../../scripts/lib/staging-database-guard').assertDatabase(env.FOUNDRY_DATABASE_URL||env.DATABASE_URL);
 const release=String(job.payload?.release||'');if(!/^[a-f0-9]{40}$/.test(release)||release!==env.RENDER_GIT_COMMIT)throw Error('Exact deployed staging release required.');
 const root=path.resolve(__dirname,'../..'),output=path.join(os.tmpdir(),'stockchief-staging-load-'+job.id+'.json');
 if(job.kind==='qualification.staging-load'){
  if(!/^wsp_[a-z0-9]+$/.test(job.workspaceId||''))throw Error('A synthetic inventory is required.');
  const tenants=job.payload?.tenants;if(tenants&&(!Array.isArray(tenants)||tenants.length<2||tenants.length>4||tenants[0]?.workspaceId!==job.workspaceId||tenants.some(t=>!/^wsp_[a-z0-9]+$/.test(t?.workspaceId||'')||!Number.isInteger(t.users)||t.users<1||t.users>50)||tenants.reduce((n,t)=>n+t.users,0)!==50||new Set(tenants.map(t=>t.workspaceId)).size!==tenants.length))throw Error('Choose two to four synthetic inventories and exactly 50 members.');
  return {args:['--max-old-space-size=256',path.join(root,'scripts/certify-staging-variant-load.js'),'--hosted-sessions',...(tenants?['--qa-workspaces',JSON.stringify(tenants)]:['--qa-workspace-id',job.workspaceId]),'--release',release,'--seconds','120','--output',output],timeout:180000};
 }
 const mode=job.payload?.mode,run=job.payload?.run;if(job.kind!=='qualification.staging-million'||!['prepare','million','verify'].includes(mode)||!/^[a-z0-9-]{6,60}$/.test(run||''))throw Error('Invalid bounded qualification request.');
 return {args:['--max-old-space-size=1280',path.join(root,'scripts/certify-staging-million.js'),'--mode',mode,'--run',run,'--release',release],timeout:2700000};
}
async function run(job,db){
 const spec=specification(job),identity=(await db.query("SELECT w.name,a.email FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1 AND w.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL)",[job.workspaceId])).rows[0];
 if(!identity?.name.startsWith('Synthetic ERP release')||!identity.email.endsWith('@example.test'))throw Error('Only a dedicated synthetic staging inventory may run qualification.');
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,spec.args,{stdio:['ignore','pipe','pipe'],windowsHide:true});let stdout='',stderr='',leaseLost=false,pending=Promise.resolve();
  child.stdout.on('data',chunk=>{stdout=(stdout+chunk).slice(-500000);});child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-20000);});
  const heartbeat=setInterval(()=>{pending=pending.then(async()=>{if(job.leaseToken&&!await require('./postgres-job-queue').heartbeat(db,job.id,job.leaseToken,{leaseMs:180000})){leaseLost=true;child.kill('SIGTERM');}}).catch(()=>{leaseLost=true;child.kill('SIGTERM');});},5000);heartbeat.unref();
  const timer=setTimeout(()=>child.kill('SIGTERM'),spec.timeout);timer.unref();
  child.on('error',error=>{clearInterval(heartbeat);clearTimeout(timer);reject(error);});
  child.on('close',async(code,signal)=>{clearInterval(heartbeat);clearTimeout(timer);await pending;if(leaseLost)return reject(Object.assign(new Error('The qualification lease expired; the child stopped.'),{retryable:false}));
   let evidence=null;for(const line of stdout.trim().split(/\r?\n/).reverse()){try{const parsed=JSON.parse(line);if(parsed.finishedAt||parsed.mode){evidence=parsed;break;}}catch{}}
   resolve({passed:code===0&&Boolean(evidence),exitCode:code,signal,evidence,problem:code===0?null:stderr.trim().split(/\r?\n/).at(-1)||'The bounded test did not finish.',paidCalls:0,newInfrastructure:false});
  });
 });
}
module.exports={run,specification};
