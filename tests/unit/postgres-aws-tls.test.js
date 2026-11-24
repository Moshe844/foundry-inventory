'use strict';
// The website on Render (Ohio) connects to the AWS database with full certificate and
// hostname checks, using AWS's root certificates that ship with the app.
const test=require('node:test'),assert=require('node:assert/strict'),{tlsFor,connectionOptions}=require('../../src/db/postgres');
const rds='postgresql://stockchief_runtime:secret@stockchief-qualification-postgres.abc123.us-east-2.rds.amazonaws.com:5432/stockchief?sslmode=verify-full';
test('an Ohio AWS database address uses the bundled AWS certificates with full verification',()=>{
 const tls=tlsFor(rds,{},{});assert.match(tls.ca,/BEGIN CERTIFICATE/);
 const ssl=connectionOptions(rds,{requireTls:true,privateNetwork:false,...tls}).ssl;
 assert.equal(ssl.rejectUnauthorized,true);assert.equal(ssl.ca,tls.ca);assert.equal(ssl.checkServerIdentity,undefined,'standard hostname checks, no pin');
});
test('a leftover Render certificate pin is refused for the AWS database',()=>{
 assert.throws(()=>tlsFor(rds,{},{FOUNDRY_DATABASE_TLS_FINGERPRINT256:'a'.repeat(64)}),/Remove FOUNDRY_DATABASE_TLS_FINGERPRINT256/);
});
test('other databases are unchanged: an explicit certificate wins and Render pins still apply',()=>{
 assert.equal(tlsFor(rds,{ca:'explicit'},{}).ca,'explicit');
 const render='postgresql://u:p@dpg-example-a.virginia-postgres.render.com/db';
 assert.deepEqual(tlsFor(render,{},{}),{ca:undefined,tlsFingerprint:undefined});
 assert.deepEqual(tlsFor(render,{},{FOUNDRY_DATABASE_TLS_CA:'pem',FOUNDRY_DATABASE_TLS_FINGERPRINT256:'b'.repeat(64)}),{ca:'pem',tlsFingerprint:'b'.repeat(64)});
});
