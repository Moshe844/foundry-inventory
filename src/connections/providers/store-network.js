'use strict';
// Self-hosted stores are tenant-supplied destinations. Resolve and pin a public
// address for every request; TLS and the original hostname remain mandatory.
// The narrowly scoped loopback fixture is unavailable outside NODE_ENV=test.
const dns=require('node:dns').promises,https=require('node:https'),net=require('node:net'),ipaddr=require('ipaddr.js');
const {ValidationError}=require('../../domain/errors');
const LIMIT=16*1024*1024;
function localFixture(url){
 return process.env.NODE_ENV==='test'&&url.hostname==='127.0.0.1'&&
  String(process.env.STOCKCHIEF_PROVIDER_TEST_ORIGINS||'').split(',').includes(url.origin);
}
function address(value){
 let url;try{url=new URL(String(value));}catch{throw new ValidationError('Enter a valid HTTPS store address.');}
 if(url.protocol!=='https:'||url.username||url.password)throw new ValidationError('Store connections require HTTPS without credentials in the address.');
 if(url.hash||url.search)throw new ValidationError('The store address must not include a query or fragment.');
 const host=url.hostname.replace(/^\[|\]$/g,'');
 if(!localFixture(url)&&(host==='localhost'||host.endsWith('.localhost')||net.isIP(host)&&!publicIp(host)))throw new ValidationError('A store must have a public Internet address.');
 return url;
}
function publicIp(value){try{let a=ipaddr.parse(value);if(a.kind()==='ipv6'&&a.isIPv4MappedAddress())a=a.toIPv4Address();return a.range()==='unicast';}catch{return false;}}
async function destination(url,lookup=dns.lookup){
 address(url.origin);
 const host=url.hostname.replace(/^\[|\]$/g,'');
 if(localFixture(url))return {address:'127.0.0.1',family:4};
 const rows=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await lookup(host,{all:true,verbatim:true});
 if(!rows.length||rows.some(r=>!publicIp(r.address)))throw new ValidationError('The store address resolves to a private or reserved network. No request was sent.');
 return rows[0];
}
async function fetchStore(value,options={}){
 const url=new URL(value),pinned=await destination(url);
 if(options.signal?.aborted)throw options.signal.reason;
 return new Promise((resolve,reject)=>{
  const req=https.request(url,{method:options.method||'GET',headers:options.headers,
   signal:options.signal,agent:false,
   lookup:(_hostname,opts,cb)=>opts?.all?cb(null,[pinned]):cb(null,pinned.address,pinned.family)},
   response=>{
    // Never forward authorization to a redirect, including a same-host redirect
    // whose next DNS resolution could point at a different/private address.
    const chunks=[];let bytes=0;
    response.on('data',chunk=>{bytes+=chunk.length;if(bytes>LIMIT){const error=new ValidationError('The store response exceeds the safe page size. Request a smaller page.');error.providerOutcomeUncertain=!['GET','HEAD','OPTIONS'].includes(String(options.method||'GET').toUpperCase());response.destroy(error);}else chunks.push(chunk);});
    response.on('error',reject);response.on('end',()=>{
     const headers=new Headers();for(const [name,v]of Object.entries(response.headers))if(v!=null)for(const item of Array.isArray(v)?v:[v])headers.append(name,String(item));
     resolve(new Response([204,205,304].includes(response.statusCode)?null:Buffer.concat(chunks),{status:response.statusCode,headers}));
    });
   });
  req.on('error',reject);
  if(options.body!=null)req.write(options.body instanceof URLSearchParams?options.body.toString():options.body);
  req.end();
 });
}
module.exports={address,publicIp,destination,fetchStore};
