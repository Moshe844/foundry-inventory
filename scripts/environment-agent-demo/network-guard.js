'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const scope=new AsyncLocalStorage();let installed=false;
function blocked(kind){throw new Error(`DEMO_NETWORK_BLOCKED:${kind}`);}
// Trusted application code has no unrestricted outbound path while handling an
// agent request. This is defense in depth around the read-only renderer/gateway;
// arbitrary model-authored code runs only in the network-none Docker container.
function install(){
 if(installed)return;installed=true;
 const net=require('node:net'),tls=require('node:tls'),http=require('node:http'),https=require('node:https');
 const connect=net.Socket.prototype.connect;
 net.Socket.prototype.connect=function(...args){
  const policy=scope.getStore();if(policy){
   const normalized=net._normalizeArgs(Array.isArray(args[0])?args[0]:args)[0];
   const host=normalized.host||'localhost',port=Number(normalized.port);
   const database=policy.database&&host===policy.database.hostname&&port===policy.database.port;
   if(normalized.path||!database&&(!['127.0.0.1','localhost'].includes(host)||!policy.ports.has(port)))blocked('socket');
  }return connect.apply(this,args);
 };
 const tlsConnect=tls.connect;tls.connect=function(...args){const policy=scope.getStore();if(policy){
  const options=args[0];if(!policy.database||typeof options!=='object'||options.servername!==policy.database.hostname||
   options.rejectUnauthorized!==true||options.socket?.remotePort!==policy.database.port)blocked('tls');
 }return tlsConnect.apply(this,args);};
 for(const api of [http,https])for(const name of ['request','get']){
  const original=api[name];api[name]=function(...args){
   const policy=scope.getStore();if(policy){
    const first=args[0];let url;
    try{url=typeof first==='string'||first instanceof URL?new URL(first):new URL(`${first.protocol||'http:'}//${first.hostname||first.host||'localhost'}:${first.port||80}`);}catch{blocked('http');}
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!policy.httpPorts.has(Number(url.port||80)))blocked('http');
   }return original.apply(this,args);
  };
 }
 const fetch=globalThis.fetch;globalThis.fetch=function(input,options){
  const policy=scope.getStore();if(policy){const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
   if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!policy.httpPorts.has(Number(url.port||80)))blocked('fetch');
   options={...options,redirect:'error'};
  }return fetch.call(this,input,options);
 };
 const udp=require('node:dgram');const send=udp.Socket.prototype.send;
 udp.Socket.prototype.send=function(...args){if(scope.getStore())blocked('udp');return send.apply(this,args);};
 for(const api of [require('node:dns'),require('node:dns').promises])for(const name of Object.keys(api).filter(n=>n.startsWith('resolve')||n==='lookup')){
  const original=api[name];if(typeof original==='function')api[name]=function(...args){const policy=scope.getStore();
   if(policy&&(!policy.database||name!=='lookup'||args[0]!==policy.database.hostname))blocked('dns');return original.apply(this,args);};
 }
}
function restricted({databaseUrl,httpOrigins=[],stagingAuthorization=null,ctx=null},fn){
 install();const db=new URL(databaseUrl);
 let database=null;
 if(db.hostname!=='127.0.0.1'){
  if(!stagingAuthorization)throw new Error('Only a local isolated PostgreSQL fixture is allowed.');
  require('../../src/assistant/postgres-codex-pilot').assertReadAuthorization(stagingAuthorization,{connectionString:databaseUrl},ctx);
  if(db.searchParams.get('sslmode')!=='verify-full'||process.env.FOUNDRY_DATABASE_PRIVATE_NETWORK==='true')throw Error('STAGING_RENDERER_REQUIRES_VERIFIED_TLS');
  database={hostname:db.hostname,port:Number(db.port||5432)};
 }
 const httpPorts=new Set(httpOrigins.map(origin=>{const url=new URL(origin);if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw new Error('Only a local relay is allowed.');return Number(url.port);}));
 return scope.run({ports:new Set([...(database?[]:[Number(db.port)]),...httpPorts]),httpPorts,database},fn);
}
module.exports={restricted};
