'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{addresses,recipients}=require('../../src/commercial/usage-categories');
test('business recipients count addresses across To, Cc and Bcc, without counting display names or duplicates',()=>{
 assert.deepEqual(addresses(['"Jones, Sarah" <Sarah@example.test>',['other@example.test; third@example.test'],{address:'sarah@EXAMPLE.test'}]),['sarah@example.test','other@example.test','third@example.test']);
 assert.equal(recipients([['a@example.test'],undefined,null,'B <b@example.test>'] ),2);
 for(const bad of ['good@example.test\r\nBcc: stolen@example.test','"unfinished <a@example.test>','a@example.test,,b@example.test','A <bad>','A <a@example.test>>'])assert.throws(()=>addresses(bad),/valid business email/);
});
