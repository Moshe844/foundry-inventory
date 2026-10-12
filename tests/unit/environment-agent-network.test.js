'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {restricted}=require('../../scripts/environment-agent-demo/network-guard');
test('remote database access requires a host-issued Staging capability, never a supplied URL or forged token',()=>{
 const databaseUrl='postgresql://fixture@unapproved.example.test:5432/postgres?sslmode=verify-full';
 assert.throws(()=>restricted({databaseUrl},()=>{}),/local isolated/);
 assert.throws(()=>restricted({databaseUrl,stagingAuthorization:{},ctx:{workspaceId:'foreign',actorId:'foreign'}},()=>{}),/Invalid Staging renderer/);
});
test('restricted application blocks fetch, HTTP, sockets, TLS, DNS and UDP; explicitly scoped loopback remains available',async t=>{
 const http=require('node:http');const server=http.createServer((req,res)=>res.end('local'));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const policy={databaseUrl:'postgresql://fixture@127.0.0.1:1/postgres'};
 await restricted(policy,async()=>{
  for(const call of [()=>fetch(origin),()=>http.get(origin),()=>require('node:net').connect({host:'127.0.0.1',port:server.address().port}),
   ()=>require('node:tls').connect(443,'example.test'),()=>require('node:dns').lookup('example.test',()=>{})])
   assert.throws(call,/DEMO_NETWORK_BLOCKED/);
  const udp=require('node:dgram').createSocket('udp4');assert.throws(()=>udp.send('data',53,'127.0.0.1'),/DEMO_NETWORK_BLOCKED/);udp.close();
 });
 assert.equal(await (await fetch(origin)).text(),'local');
 assert.equal(await restricted({...policy,httpOrigins:[origin]},async()=>await (await fetch(origin)).text()),'local');
});
