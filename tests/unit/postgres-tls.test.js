'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {connectionOptions}=require('../../src/db/postgres');
test('production requires TLS even on a private network, without plaintext fallback',()=>{
 const url='postgres://fixture:fixture@private-postgres/fixture';
 assert.equal(connectionOptions(url,{privateNetwork:true,requireTls:true}).ssl.rejectUnauthorized,true);
 assert.throws(()=>connectionOptions(url+'?sslmode=disable',{privateNetwork:true,requireTls:true}),/requires encrypted TLS/);
 assert.equal(connectionOptions('postgres://fixture:fixture@127.0.0.1/fixture',{requireTls:true}).ssl,false,'Loopback disposable test clusters remain available');
});
test('a private certificate must match its explicitly trusted identity',()=>{
 const options={privateNetwork:true,requireTls:true,ca:'fixture-trust-anchor',tlsFingerprint:'AA'.repeat(32)};
 const ssl=connectionOptions('postgres://fixture:fixture@private-postgres/fixture',options).ssl;
 assert.equal(ssl.rejectUnauthorized,true);assert.equal(ssl.ca,options.ca);
 assert.equal(ssl.checkServerIdentity('private-postgres',{fingerprint256:Array(32).fill('AA').join(':')}),undefined);
 assert.equal(ssl.checkServerIdentity('private-postgres',{fingerprint256:'BB'.repeat(32)}).code,'DATABASE_TLS_IDENTITY_CHANGED');
 assert.throws(()=>connectionOptions('postgres://fixture:fixture@private-postgres/fixture',{...options,ca:undefined}),/trusted certificate/);
 assert.throws(()=>connectionOptions('postgres://fixture:fixture@private-postgres/fixture',{...options,tlsFingerprint:'bad'}),/fingerprint/);
 assert.throws(()=>connectionOptions('postgres://fixture:fixture@private-postgres/fixture?sslmode=require',options),/verified TLS/);
});
