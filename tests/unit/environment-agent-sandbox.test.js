'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createArgs,validateInspection}=require('../../scripts/environment-agent-demo/sandbox');
test('sandbox launch has no mounts, no network, immutable local image and bounded resources',()=>{
 const image='sha256:'+'a'.repeat(64),args=createArgs({image,name:'stockchief-demo-aaaa'});
 for(const forbidden of ['--privileged','--volume','-v','--publish','-p'])assert.ok(!args.includes(forbidden));
 assert.ok(args.includes('--pull=never'));assert.equal(args[args.indexOf('--network')+1],'none');
 assert.throws(()=>createArgs({image:'node:latest',name:'stockchief-demo-aaaa'}),/immutable/);
 const tmpfs=Object.fromEntries(args.flatMap((v,i)=>v==='--tmpfs'?[args[i+1].split(/:(.*)/s).slice(0,2)]:[]));
 const info={Image:image,State:{Running:true},Config:{User:'1000:1000',Labels:{'stockchief.environment-demo':'1'}},Mounts:[],
  HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Memory:536870912,MemorySwap:536870912,NanoCpus:1000000000,PidsLimit:64,
   CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Tmpfs:tmpfs}};
 assert.equal(validateInspection(info,image),true);
 for(const mutation of [x=>x.HostConfig.NetworkMode='bridge',x=>x.HostConfig.Binds=['/:/host'],
  x=>x.HostConfig.Memory=0,x=>x.Config.User='root',x=>x.HostConfig.Tmpfs['/workspace']='rw,size=99g']){
  const changed=structuredClone(info);mutation(changed);assert.throws(()=>validateInspection(changed,image),/MISMATCH/);
 }
});
