'use strict';
// Runs ONLY inside the immutable, network-none container. The official SDK
// launches the official Codex binary. This bridge transports HTTP/MCP and native
// checkpoints; it never implements planning, compaction, or recovery decisions.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {gzipSync,gunzipSync}=require('node:zlib');
const {createInterface}=require('node:readline'),{randomBytes}=require('node:crypto');
const HOME='/home/node/codex',MAX=6*1024*1024;
let serial=0;const pending=new Map();
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
function rpc(kind,data){return new Promise((resolve,reject)=>{
 const id=++serial;pending.set(id,{resolve,reject});send({id,kind,...data});
});}
function nativeFiles(){
 const files={};let size=0;
 function walk(dir){if(!fs.existsSync(dir))return;
  for(const item of fs.readdirSync(dir,{withFileTypes:true})){
   const file=path.join(dir,item.name);if(item.isSymbolicLink())throw Error('NATIVE_STATE_SYMLINK');
   if(item.isDirectory())walk(file);
   else if(item.isFile()){
    const rel=path.relative(HOME,file).replaceAll('\\','/');
    // Native JSONL sessions are the canonical SDK resume input. Exclude mutable
    // SQLite indexes, logs, caches and process locks from the checkpoint.
    if(!rel.startsWith('sessions/')||!rel.endsWith('.jsonl'))continue;
    const data=fs.readFileSync(file);size+=data.length;if(size>MAX)throw Error('NATIVE_STATE_LIMIT');
    // Lossless storage compression only. The SDK receives exactly its original
    // JSONL bytes; this does not summarize, trim or enlarge native context.
    files[rel]=gzipSync(data).toString('base64');
   }
  }
 }walk(path.join(HOME,'sessions'));return files;
}
function restore(files,encoding){const validated=[];let size=0;
 if(encoding!=null&&encoding!=='gzip')throw Error('INVALID_NATIVE_STATE_ENCODING');
 for(const [name,data]of Object.entries(files||{})){
 if(!/^sessions\/[a-zA-Z0-9_./-]+\.jsonl$/.test(name)||name.split('/').includes('..'))throw Error('INVALID_NATIVE_STATE_PATH');
 if(typeof data!=='string'||Buffer.byteLength(data)>8*1024*1024)throw Error('NATIVE_STATE_LIMIT');
 const encoded=Buffer.from(data,'base64');if(encoded.toString('base64')!==data)throw Error('INVALID_NATIVE_STATE');
 const raw=encoding==='gzip'?gunzipSync(encoded,{maxOutputLength:MAX}):encoded;
 size+=raw.length;if(size>MAX)throw Error('NATIVE_STATE_LIMIT');validated.push([name,raw]);
 }
 // Validate every path and decoded size BEFORE creating any file.
 for(const [name,raw]of validated){const target=path.join(HOME,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,raw);}
}
function workspaceFiles(){const files={};let size=0;
 function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,item.name);if(item.isSymbolicLink())throw Error('WORKSPACE_STATE_SYMLINK');
  if(item.isDirectory())walk(file);else if(item.isFile()){
   const data=fs.readFileSync(file);size+=data.length;if(size>256*1024)throw Error('WORKSPACE_STATE_LIMIT');
   files[path.relative('/workspace',file)]=data.toString('base64');
  }
 }}walk('/workspace');return files;
}
function restoreWorkspace(files){let size=0;const validated=[];
 for(const [name,data]of Object.entries(files||{})){
  if(!name||name.includes('\0')||name.startsWith('/')||name.split('/').some(p=>!p||p==='..'))throw Error('INVALID_WORKSPACE_STATE_PATH');
  if(typeof data!=='string')throw Error('INVALID_WORKSPACE_STATE');
  const raw=Buffer.from(data,'base64');size+=raw.length;if(raw.toString('base64')!==data||size>256*1024)throw Error('WORKSPACE_STATE_LIMIT');
  validated.push([name,raw]);
 }
 for(const [name,raw]of validated){const target=path.join('/workspace',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,raw);}
}
async function main(start){
 const profile=require('./codex-models.cjs').getProfile(start.profile);
 fs.mkdirSync(HOME,{recursive:true,mode:0o700});restore(start.files,start.encoding);restoreWorkspace(start.workspaceFiles);
 const token=randomBytes(32).toString('hex');let thread;
 const resources=()=>{const processes=[];for(const name of fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n))){try{
  const status=fs.readFileSync('/proc/'+name+'/status','utf8');processes.push({name:status.match(/^Name:\s*(.*)/m)?.[1],threads:Number(status.match(/^Threads:\s*(\d+)/m)?.[1]||0)});
 }catch{}}return {processes,totalThreads:processes.reduce((n,p)=>n+p.threads,0)};};
 const checkpoint=(terminal=false)=>rpc('checkpoint',{threadId:thread?.id||start.threadId||null,encoding:'gzip',files:nativeFiles(),workspaceFiles:workspaceFiles(),resources:resources(),terminal});
 const server=http.createServer(async(req,res)=>{
  try{
   if(req.headers.authorization!==`Bearer ${token}`)throw Error('UNAUTHORIZED_BRIDGE');
   const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>2*1024*1024)throw Error('REQUEST_LIMIT');chunks.push(part);}
   const body=Buffer.concat(chunks).toString('utf8');
   if(req.url.startsWith('/v1/')){
    await checkpoint();
    const result=await rpc('provider',{method:req.method,url:req.url,body});
    res.writeHead(result.status,{'content-type':result.contentType,'cache-control':'no-store'});res.end(result.body);return;
   }
   if(req.url!=='/mcp'||req.method!=='POST')throw Error('UNAPPROVED_BRIDGE_ENDPOINT');
   const message=JSON.parse(body);let result;
   if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'stockchief',version:'1.0.0'}};
   else if(message.method==='tools/list')result={tools:start.tools};
   else if(message.method==='tools/call'){result=await rpc('tool',{name:message.params.name,input:message.params.arguments});await checkpoint();}
   else if(message.method==='ping')result={};
   else if(!Object.hasOwn(message,'id')){res.writeHead(202);res.end();return;}
   else throw Error('UNSUPPORTED_MCP_METHOD');
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  }catch(error){res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'STOCKCHIEF_GATE_STOPPED',message:String(error.message).slice(0,250)}}));}
 });
 server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const {Codex}=await import('/opt/stockchief/codex-sdk.mjs');
 const economicThreshold=require('./codex-models.cjs').compactionTokenLimit(profile);
 if(!Number.isSafeInteger(start.nativeCompactionTokenLimit)||start.nativeCompactionTokenLimit!==economicThreshold)throw Error('INVALID_NATIVE_COMPACTION_POLICY');
 const codex=new Codex({codexPathOverride:'/opt/codex/vendor/x86_64-unknown-linux-musl/bin/codex',
  // Docker CPU quotas do not change the host CPU count seen by thread pools.
  // Bound native pools to the existing one-CPU/64-PID sandbox, rather than
  // increasing its resource limits to accommodate host-sized default pools.
  env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/home/node',CODEX_HOME:HOME,STOCKCHIEF_BRIDGE_TOKEN:token,
   TOKIO_WORKER_THREADS:'1',RAYON_NUM_THREADS:'1',UV_THREADPOOL_SIZE:'1',NODE_OPTIONS:'--v8-pool-size=1'},
  config:{model_provider:'stockchief',model_reasoning_effort:profile.effort,
   model_providers:{stockchief:{name:'StockChief governed relay',base_url:origin+'/v1',env_key:'STOCKCHIEF_BRIDGE_TOKEN',wire_api:'responses',
    request_max_retries:0,stream_max_retries:0,supports_websockets:false}},
   mcp_servers:{stockchief:{url:origin+'/mcp',bearer_token_env_var:'STOCKCHIEF_BRIDGE_TOKEN',required:true,default_tools_approval_mode:'approve'}},
   features:{shell_tool:false,multi_agent:false,js_repl:false},
   developer_instructions:start.instructions,
   // Test-only trigger changes WHEN native Codex compacts; never its algorithm.
   model_auto_compact_token_limit:start.offlineCompact?1:start.nativeCompactionTokenLimit}});
 const options={model:profile.model,modelReasoningEffort:profile.effort,workingDirectory:'/workspace',skipGitRepoCheck:true,
  sandboxMode:'read-only',approvalPolicy:'never',webSearchMode:'disabled',networkAccessEnabled:false};
 thread=start.threadId?codex.resumeThread(start.threadId,options):codex.startThread(options);
 let turnCompleted=false;
 try{
  const result=await thread.runStreamed(start.prompt);
  for await(const event of result.events){
   await rpc('event',{event});
   // The SDK's semantic completion precedes CLI/MCP shutdown. Save native
   // state now; the host can verify and deliver without waiting for teardown.
   if(event.type==='turn.completed'){turnCompleted=true;await checkpoint(true);}
  }
  await checkpoint(turnCompleted);send({kind:'done',threadId:thread.id});
 }finally{server.closeAllConnections();server.close();}
}
let started=false;
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{
 try{
  if(line.length>12*1024*1024)throw Error('BRIDGE_FRAME_LIMIT');
  const value=JSON.parse(line);
  if(!started){started=true;main(value).then(()=>{lines.close();process.exit(0);}).catch(error=>{send({kind:'failed',message:error.message});process.exit(1);});return;}
  const item=pending.get(value.id);if(!item)throw Error('UNKNOWN_BRIDGE_RESPONSE');pending.delete(value.id);
  if(value.error)item.reject(Error(value.error));else item.resolve(value.result);
 }catch(error){send({kind:'failed',message:error.message});process.exit(1);}
});
lines.on('close',()=>{if(pending.size)process.exit(1);});
