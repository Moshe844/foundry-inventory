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
test("Render's database certificate settings from the shared group never apply to the AWS database",()=>{
 // Production keeps these in the settings group the Ohio services share with Virginia.
 const tls=tlsFor(rds,{},{FOUNDRY_DATABASE_TLS_CA:'-----BEGIN CERTIFICATE-----\nrender\n-----END CERTIFICATE-----',FOUNDRY_DATABASE_TLS_FINGERPRINT256:'a'.repeat(64)});
 assert.equal(tls.tlsFingerprint,undefined);assert.doesNotMatch(tls.ca,/render/);assert.match(tls.ca,/BEGIN CERTIFICATE/);
 const ssl=connectionOptions(rds,{requireTls:true,privateNetwork:false,...tls}).ssl;
 assert.equal(ssl.rejectUnauthorized,true);assert.equal(ssl.checkServerIdentity,undefined);
 assert.throws(()=>tlsFor(rds,{tlsFingerprint:'a'.repeat(64)},{}),/certificate chain, not a pin/);
});
test('other databases are unchanged: an explicit certificate wins and Render pins still apply',()=>{
 assert.equal(tlsFor(rds,{ca:'explicit'},{}).ca,'explicit');
 const render='postgresql://u:p@dpg-example-a.virginia-postgres.render.com/db';
 assert.deepEqual(tlsFor(render,{},{}),{ca:undefined,tlsFingerprint:undefined});
 assert.deepEqual(tlsFor(render,{},{FOUNDRY_DATABASE_TLS_CA:'pem',FOUNDRY_DATABASE_TLS_FINGERPRINT256:'b'.repeat(64)}),{ca:'pem',tlsFingerprint:'b'.repeat(64)});
});
