'use strict';
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {randomUUID}=require('node:crypto');
const run=promisify(execFile);
const LABEL='stockchief.environment-demo';
function createArgs({image,name}){
 if(!/^sha256:[a-f0-9]{64}$/.test(image))throw new Error('Use a locally verified immutable Docker image ID. No implicit pull is allowed.');
 if(!/^stockchief-demo-[a-f0-9-]+$/.test(name))throw new Error('Invalid sandbox identity.');
 return ['run','--detach','--rm','--pull=never','--name',name,'--label',`${LABEL}=1`,
  '--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
  '--memory','512m','--memory-swap','512m','--cpus','1','--pids-limit','64',
  '--user','1000:1000','--workdir','/workspace',
  '--tmpfs','/workspace:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=700',
  '--tmpfs','/tmp:rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=700',
  '--tmpfs','/home/node:rw,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=700',
  '--env','HOME=/home/node','--env','NODE_ENV=test','--env','UV_THREADPOOL_SIZE=1','--env','NODE_OPTIONS=--v8-pool-size=1',image,'sleep','1200'];
}
function validateInspection(info,image){
 const h=info.HostConfig,c=info.Config;
 if(info.Image!==image||!info.State.Running||c.Labels?.[LABEL]!=='1'||c.User!=='1000:1000'||
  h.NetworkMode!=='none'||h.Privileged||!h.ReadonlyRootfs||h.Memory!==512*1024*1024||h.MemorySwap!==h.Memory||
  h.NanoCpus!==1000000000||h.PidsLimit!==64||h.CpusetCpus&&!/^\d+$/.test(h.CpusetCpus)||h.Binds?.length||h.PortBindings&&Object.keys(h.PortBindings).length||
  info.Mounts?.some(m=>m.Type!=='tmpfs')||!h.CapDrop?.some(v=>v.toUpperCase()==='ALL')||
  !h.SecurityOpt?.some(v=>v.startsWith('no-new-privileges'))||Object.keys(h.Tmpfs||{}).length!==3)
  throw new Error('SANDBOX_ISOLATION_MISMATCH');
 for(const [directory,size]of [['/workspace','256m'],['/tmp','32m'],['/home/node','16m']])
  if(!h.Tmpfs[directory]?.includes(`size=${size}`)||!h.Tmpfs[directory]?.includes('uid=1000'))throw new Error('SANDBOX_DISK_LIMIT_MISMATCH');
 return true;
}
async function createSandbox({image,containerId=null,runtimeFiles=null}){
 async function docker(args,options={}){return run('docker',args,{windowsHide:true,timeout:25000,maxBuffer:128*1024,...options});}
 const created=!containerId;const name=`stockchief-demo-${randomUUID()}`;
 if(created)containerId=(await docker(createArgs({image,name}))).stdout.trim();
 if(!/^[a-f0-9]{64}$/.test(containerId))throw new Error('Invalid container identity.');
 async function inspect(){const info=JSON.parse((await docker(['inspect',containerId])).stdout)[0];validateInspection(info,image);return info;}
 try{
  const info=await inspect();
  if(!info.HostConfig.CpusetCpus){
   // CPU quotas bound CPU time but leave all host CPUs visible to native Rust
   // and V8 pools. Restrict affinity to one ALREADY allowed CPU as well, so
   // pools fit the unchanged one-CPU/64-PID sandbox on large Docker hosts.
   const status=(await docker(['exec','--user','1000:1000',containerId,'cat','/proc/self/status'])).stdout;
   const cpu=status.match(/^Cpus_allowed_list:\s*(\d+)/m)?.[1];if(!cpu)throw Error('SANDBOX_CPU_AFFINITY_UNAVAILABLE');
   await docker(['update','--cpuset-cpus',cpu,containerId]);await inspect();
  }
 }catch(error){if(created)await docker(['rm','--force',containerId]).catch(()=>{});throw error;}
 async function command(args){await inspect();return docker(['exec','--user','1000:1000','--workdir','/workspace',containerId,
  'timeout','--signal=KILL','15s',...args]);}
 let closing=null;
 const {Manifest}=require('@openai/agents/sandbox');
 const state={manifest:new Manifest({root:'/workspace'}),workspaceReady:true,containerId,image};
 const session={state,
  async exec({cmd,workdir='/workspace',runAs='node'}){
   if(workdir!=='/workspace'||!['node','1000:1000'].includes(runAs)||typeof cmd!=='string'||cmd.length>12000)throw new Error('Sandbox command contract violated.');
   const start=Date.now();let result;
   try{result=await command(['/bin/sh','-c',cmd]);}
   catch(error){if(typeof error.code!=='number')throw error;result={stdout:error.stdout||'',stderr:error.stderr||'',code:error.code};}
   return {stdout:result.stdout.slice(0,12000),stderr:result.stderr.slice(0,12000),output:(result.stdout+result.stderr).slice(0,12000),
    exitCode:result.code||0,wallTimeSeconds:(Date.now()-start)/1000};
  },
  async readFile({path,maxBytes=24000}){
   if(typeof path!=='string'||!path.startsWith('/workspace/')||maxBytes>24000)throw new Error('Only bounded workspace files are readable.');
   const script=`const fs=require('fs');const p=fs.realpathSync(process.argv[1]);if(!p.startsWith('/workspace/'))throw Error('Path outside workspace');const fd=fs.openSync(p,'r');const s=fs.fstatSync(fd);if(!s.isFile()||s.size>24000)throw Error('File limit');const b=Buffer.alloc(s.size);fs.readSync(fd,b,0,b.length,0);process.stdout.write(b.toString('base64'));`;
   return Buffer.from((await command(['node','-e',script,path])).stdout,'base64');
  },
  async certify(){
   const info=await inspect();if(!/^\d+$/.test(info.HostConfig.CpusetCpus))throw Error('SANDBOX_CPU_AFFINITY_MISMATCH');
   const result=await command(['node','-e',`const fs=require('fs'),net=require('net');${runtimeFiles?require('./codex-image-contract').probe(runtimeFiles):''}if(process.getuid()!==1000)throw Error('root');for(const k of Object.keys(process.env))if(/API_KEY|DATABASE_URL|OAUTH_TOKEN/.test(k))throw Error('secret');try{fs.writeFileSync('/root-write-test','x');throw Error('writable root')}catch(e){if(e.message==='writable root')throw e}const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(1000);s.on('connect',()=>{s.destroy();process.exit(9)});s.on('error',()=>process.stdout.write('isolated'));s.on('timeout',()=>{s.destroy();process.stdout.write('isolated')});`]);
   if(result.stdout!=='isolated')throw new Error('SANDBOX_PROBE_FAILED');
   return {passed:true,containerId,image,cpuSet:info.HostConfig.CpusetCpus,checkedAt:new Date().toISOString(),checks:['non-root','network-none','no-host-mounts','read-only-root','cpu-memory-pids-disk-bounds','single-cpu-affinity','no-provider-credentials',...(runtimeFiles?['native-runtime-source-match']:[])]};
  },
  async close(){
   // Native report correction can retire a sandbox before the outer lifetime
   // cleanup runs. Join concurrent/previous successful teardown; still retain
   // the original identity/isolation check before the first removal.
   if(!closing)closing=(async()=>{await inspect();await docker(['rm','--force',containerId]);})()
    .catch(error=>{closing=null;throw error;});
   return closing;
  }
 };
 return session;
}
module.exports={createArgs,validateInspection,createSandbox};
