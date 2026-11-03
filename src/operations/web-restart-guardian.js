'use strict';
const http=require('node:http'),{fork}=require('node:child_process'),{EventEmitter}=require('node:events');
const statusUrl='https://moshe844.github.io/stockchief-status/';
function fallback(req,res){
 if(res.destroyed||res.writableEnded)return;if(res.headersSent){res.destroy();return;}req.resume();
 const message='StockChief is restarting. Please try again shortly.',json=String(req.headers.accept||'').includes('application/json')||req.url.startsWith('/api/')||req.url.startsWith('/healthz');
 res.writeHead(503,{'Content-Type':json?'application/json; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','Retry-After':'2','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'strict-origin-when-cross-origin','Strict-Transport-Security':'max-age=31536000; includeSubDomains','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
 if(json)return res.end(JSON.stringify({error:{code:'temporarily_unavailable',message,statusUrl}}));
 return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>StockChief · Reconnecting</title><style>body{font:18px system-ui;color:#172033;background:#f7f8fb;margin:12vh auto;padding:24px;max-width:620px}strong{color:#4338ca}h1{font-size:32px}a{color:#4338ca}p{line-height:1.6}</style><strong>StockChief</strong><h1>We’ll be back shortly</h1><p>'+message+'</p><p>If you were saving a change, check its saved record before trying again.</p><a href="'+statusUrl+'">Check service status</a></html>');
}
async function start({entrypoint,port=0,host='0.0.0.0',env=process.env,restartDelayMs=250,shutdownTimeoutMs=110000,logger=()=>{},forkOptions={}}){
 const events=new EventEmitter(),agent=new http.Agent({keepAlive:true,maxSockets:100,maxFreeSockets:20});let child=null,backendPort=null,closing=false,restartTimer,startedAt=0,restarts=0;
 const server=http.createServer((req,res)=>{
  if(req.url==='/status'||req.url.startsWith('/status?')){res.writeHead(302,{Location:statusUrl,'Cache-Control':'no-store','Strict-Transport-Security':'max-age=31536000; includeSubDomains','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'strict-origin-when-cross-origin','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"});res.end();return;}
  if(!backendPort)return fallback(req,res);
  const upstream=http.request({hostname:'127.0.0.1',port:backendPort,path:req.url,method:req.method,headers:req.headers,agent},response=>{
   res.writeHead(response.statusCode,response.headers);response.pipe(res);response.on('error',()=>res.destroy());
  });
  upstream.setTimeout(65000,()=>upstream.destroy());upstream.on('error',()=>fallback(req,res));req.on('aborted',()=>upstream.destroy());res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});
  // Stream each request once. A lost POST response is never an automatic retry.
  req.pipe(upstream);
 });
 function launch(){if(closing)return;backendPort=null;startedAt=Date.now();const next=fork(entrypoint,[],{...forkOptions,env:{...env,STOCKCHIEF_WEB_BACKEND:'1',PORT:'0'},stdio:forkOptions.stdio||['ignore','inherit','inherit','ipc']});child=next;let settled=false;
  next.on('message',message=>{if(!settled&&child===next&&message?.type==='stockchief.web.ready'&&Number.isInteger(message.port)&&message.port>0&&message.port<65536){backendPort=message.port;events.emit('ready',{port:backendPort,pid:next.pid});}});
  function ended(code,signal){if(settled)return;settled=true;if(child===next){backendPort=null;child=null;}if(closing)return;restarts++;logger({event:'stockchief.web.restart',code,signal,restarts});events.emit('restart',{code,signal,restarts});const uptime=Date.now()-startedAt;restartTimer=setTimeout(launch,uptime>60000?restartDelayMs:Math.min(30000,restartDelayMs*2**Math.min(restarts-1,6)));}
  next.once('exit',ended);
  next.once('error',error=>{logger({event:'stockchief.web.spawn_error',code:error.code||'spawn_failed'});ended(null,null);});
 }
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});launch();
 async function close(){if(closing)return;closing=true;clearTimeout(restartTimer);const current=child;let timer;const forced=new Promise(resolve=>{timer=setTimeout(()=>{current?.kill('SIGKILL');server.closeAllConnections();resolve();},shutdownTimeoutMs);timer.unref();}),stopped=current&&current.exitCode===null?new Promise(resolve=>{current.once('exit',resolve);current.kill('SIGTERM');}):Promise.resolve(),drained=new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});await Promise.race([Promise.all([stopped,drained]),forced]);clearTimeout(timer);agent.destroy();}
 return {server,events,close,status:()=>({ready:Boolean(backendPort),restarts,pid:child?.pid||null})};
}
module.exports={start,fallback};
