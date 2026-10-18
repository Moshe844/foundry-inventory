'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),network=require('../../src/connections/providers/store-network');
test('tenant-supplied stores reject private destinations, mixed DNS and encoded loopback without a request',async()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','172.31.0.1','192.168.0.1','169.254.169.254','0.0.0.0','::1','fc00::1','fe80::1','::ffff:127.0.0.1','224.0.0.1'])assert.equal(network.publicIp(ip),false,ip);
 for(const url of ['http://shop.example.com','https://user:pass@shop.example.com','https://2130706433','https://0x7f000001','https://[::1]','https://localhost'])assert.throws(()=>network.address(url));
 let resolves=0;await assert.rejects(()=>network.destination(new URL('https://public-store.example'),async()=>{resolves++;return [{address:'93.184.216.34',family:4},{address:'10.0.0.2',family:4}];}),/private or reserved/);assert.equal(resolves,1);
 assert.deepEqual(await network.destination(new URL('https://public-store.example'),async()=>[{address:'93.184.216.34',family:4}]),{address:'93.184.216.34',family:4});
});
test('loopback certification exception requires the explicit exact origin and a test runtime',()=>{
 const before={node:process.env.NODE_ENV,origins:process.env.STOCKCHIEF_PROVIDER_TEST_ORIGINS};try{
 process.env.STOCKCHIEF_PROVIDER_TEST_ORIGINS='https://127.0.0.1:44443';process.env.NODE_ENV='production';assert.throws(()=>network.address('https://127.0.0.1:44443'));
 process.env.NODE_ENV='test';assert.equal(network.address('https://127.0.0.1:44443').hostname,'127.0.0.1');assert.throws(()=>network.address('https://127.0.0.1:44444'));assert.throws(()=>network.address('https://[::1]:44443'));
 }finally{for(const[k,v]of Object.entries({NODE_ENV:before.node,STOCKCHIEF_PROVIDER_TEST_ORIGINS:before.origins}))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
