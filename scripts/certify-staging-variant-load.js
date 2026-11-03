'use strict';
// Explicit staging-only qualification. Credentials and cookies stay in memory;
// the exported evidence contains timings, status counts and release identity.
const fs=require('node:fs');
const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i<0?fallback:process.argv[i+1];};
const base=new URL(arg('url','https://stockchief-staging-web.onrender.com'));
if(base.origin!=='https://stockchief-staging-web.onrender.com'||base.pathname!=='/')throw Error('This qualification is restricted to StockChief staging.');
const hosted=process.argv.includes('--hosted-sessions');let qa=hosted?null:JSON.parse(fs.readFileSync(arg('qa-file'), 'utf8'));
if(!hosted&&(!qa.owner?.email?.endsWith('@example.test')||!qa.owner.businessName?.startsWith('Synthetic ERP release')))throw Error('Use the dedicated synthetic staging QA account.');
if(hosted&&!['srv-daqh418473hc73853e40','srv-daqh418473hc73853e7g'].includes(process.env.RENDER_SERVICE_ID))throw Error('Hosted sessions may only be created by the existing staging web or worker service.');
const users=50,rpm=500,seconds=Number(arg('seconds','120')),output=arg('output');
if(!Number.isInteger(seconds)||seconds<60||seconds>600||!output)throw Error('Choose 60–600 seconds and an output evidence file.');
const paths=['/','/money','/reports','/needs-you','/inventory/table?view=flat','/inventory/table?category=Grocery','/api/search?q=R16-LOAD-101'];
const delay=ms=>new Promise(r=>setTimeout(r,Math.max(0,ms)));
function cookieJar(){const cookies=new Map();return {header:()=>[...cookies].map(([k,v])=>k+'='+v).join('; '),update:response=>{for(const entry of response.headers.getSetCookie()){const pair=entry.split(';',1)[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}}};}
async function request(jar,path,options={}){const response=await fetch(new URL(path,base),{...options,redirect:'manual',signal:AbortSignal.timeout(20000),headers:{Accept:path.startsWith('/api/')?'application/json':'text/html',cookie:jar.header(),...options.headers}});jar.update(response);return response;}
async function login(){const jar=cookieJar(),page=await request(jar,'/login'),html=await page.text(),csrf=/name="_csrf"[^>]*value="([^"]+)"/.exec(html)?.[1];if(!csrf)throw Error('The QA sign-in form could not load');const response=await request(jar,'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf,email:qa.owner.email,password:qa.password})});await response.arrayBuffer();if(response.status!==302||response.headers.get('location')!=='/')throw Error('Synthetic QA sign-in was refused; no load was started');return jar;}
const stats={};let failures=0,badGateways=0,completed=0;const startedAt=new Date().toISOString();
(async()=>{let hostedFixture,hostedDb;try{
 if(hosted){const url=new URL(process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL);if(!url.hostname.includes('dpg-damlkhuk1f9s739h5ga0-a')||url.pathname!=='/stockchief_staging')throw Error('Staging database guard');hostedDb=require('../src/db/postgres').openPostgres(url.href,{max:2});hostedFixture=await require('./lib/staging-load-sessions').create(hostedDb,arg('qa-workspace-id'),require('../src/config').sessionSecret);qa={owner:hostedFixture.owner};}
 const health=await (await fetch(new URL('/healthz',base))).json();if(!health.ok)throw Error('Staging is not healthy before the test');
 const expected=arg('release',health.releaseRef);if(health.releaseRef!==expected)throw Error('Staging release does not match the requested test revision');
 const jars=[];if(hostedFixture){for(const cookie of hostedFixture.cookies){const jar=cookieJar();jar.update({headers:{getSetCookie:()=>[cookie]}});jars.push(jar);}}else for(let offset=0;offset<users;offset+=5)jars.push(...await Promise.all(Array.from({length:Math.min(5,users-offset)},login)));
 const start=performance.now(),perUser=60000*users/rpm,progress=setInterval(()=>console.log(JSON.stringify({stage:'running',completed,failures,badGateways,elapsedMs:Math.round(performance.now()-start)})),10000);progress.unref();let missed=0;
 await Promise.all(jars.map(async(jar,user)=>{for(let n=0;user*120+n*perUser<seconds*1000;n++){
  const scheduled=user*120+n*perUser;await delay(start+scheduled-performance.now());if(performance.now()-start>=seconds*1000){missed++;continue;}const path=paths[(user+n)%paths.length],at=performance.now();let status=0,bytes=0;
  try{const response=await request(jar,path);status=response.status;bytes=(await response.arrayBuffer()).byteLength;}catch{status=0;}
  if(status!==200)failures++;if(status===502)badGateways++;completed++;const value=stats[path]||(stats[path]={latencies:[],statuses:{},bytes:0});value.latencies.push(Math.round(performance.now()-at));value.statuses[status]=(value.statuses[status]||0)+1;value.bytes+=bytes;
 }}));
 clearInterval(progress);const endHealth=await (await fetch(new URL('/healthz',base))).json(),elapsedMs=Math.round(performance.now()-start),routes={};for(const [path,value]of Object.entries(stats)){value.latencies.sort((a,b)=>a-b);routes[path]={requests:value.latencies.length,statuses:value.statuses,p50Ms:value.latencies[Math.floor(value.latencies.length*.5)],p95Ms:value.latencies[Math.floor(value.latencies.length*.95)],maxMs:value.latencies.at(-1),bytes:value.bytes};}
 const result={startedAt,finishedAt:new Date().toISOString(),releaseRef:health.releaseRef,virtualUsers:users,distinctAuthenticatedSessions:jars.length,syntheticAccountCount:1,targetRequestsPerMinute:rpm,durationSeconds:seconds,elapsedMs,completed,missed,failures,badGateways,releaseUnchanged:endHealth.ok&&endHealth.releaseRef===expected,routes};result.passed=failures===0&&badGateways===0&&missed===0&&result.releaseUnchanged&&elapsedMs<=seconds*1000+20000&&completed===Math.round(rpm*seconds/60);
 result.pageLatencyTargetMs=1500;result.pageLatencyPassed=['/','/money','/reports'].every(path=>routes[path]?.p95Ms<result.pageLatencyTargetMs);result.passed=result.passed&&result.pageLatencyPassed;
 result.driverLocation=hosted?'EXISTING_RENDER_STAGING_SERVICE':'EXTERNAL_CLIENT';fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.passed)process.exitCode=1;
 }finally{if(hostedFixture)await hostedFixture.close();if(hostedDb)await hostedDb.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
