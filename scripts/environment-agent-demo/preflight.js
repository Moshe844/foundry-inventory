'use strict';
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
function preflight(){
 const docker=spawnSync('docker',['info','--format','{{.ServerVersion}}'],{encoding:'utf8',timeout:10000,windowsHide:true});
 const directory=path.resolve(__dirname,'../../data/environment-agent-demo');
 const filename=path.join(directory,'spending.sqlite');let budget=null,attempts=0;
 if(fs.existsSync(filename)){
  const db=new DatabaseSync(filename,{readOnly:true});
  try{
   const policy=db.prepare('SELECT * FROM experiment_budget WHERE id=?').get('environment-pilot-2026-10');
   if(policy){
    const usage=db.prepare(`SELECT COALESCE(sum(CASE WHEN state='SETTLED' THEN charged ELSE reserved END),0) committed,
     count(*) calls,COALESCE(sum(CASE WHEN state IN ('RESERVED','UNKNOWN') THEN 1 ELSE 0 END),0) unresolved
     FROM experiment_calls WHERE experiment=?`).get(policy.id);
    budget={...policy,...usage,remaining:Math.max(0,policy.ceiling-usage.committed)};
    if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pilot_attempts'").get())
     attempts=db.prepare("SELECT count(*) n FROM pilot_attempts WHERE experiment=? AND state='FINISHED'").get(policy.id).n;
   }
  }finally{db.close();}
 }
 let certificate=null,certificationError=null;
 try{certificate=require('./certification').requireCertificate();}catch(error){certificationError=error.message;}
 const blockers=[];
 if(docker.status!==0)blockers.push('Docker engine is unavailable; there is no host-shell fallback.');
 if(!certificate)blockers.push('Current offline certification is required.');
 if(!budget?.approval||budget.expires<=Date.now())blockers.push('A current approved spending ledger is required.');
 if(budget?.stopped)blockers.push('Pilot spending is explicitly stopped.');
 if(budget?.unresolved)blockers.push('An outstanding model request requires reconciliation.');
 if(attempts>=18)blockers.push('All 18 approved pilot slots are finished. No additional paid run is authorized.');
 return {demonstrationOnly:true,readOnly:true,paidPrerequisitesSatisfied:blockers.length===0,
  candidates:require('./candidates').CANDIDATES,dockerAvailable:docker.status===0,
  dockerVersion:docker.status===0?docker.stdout.trim():null,certificate,certificationError,
  budget,completedAttempts:attempts,blockingRequirements:blockers};
}
if(require.main===module){try{console.log(JSON.stringify(preflight(),null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={preflight};
