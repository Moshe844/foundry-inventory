'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),totp=require('../../src/domain/totp');
test('authenticator codes match RFC 6238 SHA-1 vectors and reject expired or replayed codes',()=>{
 const secret=totp.encode(Buffer.from('12345678901234567890'));assert.equal(totp.decode(secret).toString(),'12345678901234567890');
 for(const [seconds,expected]of [[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']])assert.equal(totp.code(secret,Math.floor(seconds/30),{digits:8}),expected);
 const now=1234567890000,counter=Math.floor(now/30000),code=totp.code(secret,counter);assert.equal(totp.verify(secret,code,{now}),counter);assert.equal(totp.verify(secret,code,{now,afterCounter:counter}),null);assert.equal(totp.verify(secret,code,{now:now+90000}),null);assert.equal(totp.verify(secret,'bad',{now}),null);assert.equal(totp.verify(secret,totp.code(secret,counter-1),{now}),counter-1);
});
