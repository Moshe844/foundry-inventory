'use strict';const test=require('node:test'),assert=require('node:assert/strict'),policy=require('../../src/lib/password-policy'),server=require('../../src/domain/auth-service');
test('the shared password assessment preserves the enforced server policy',()=>{
 for(const [name,value,error]of [
 ['empty','',/at least 12/],['short','Ax!56',/at least 12/],['too long','Aa!'+ 'q'.repeat(198),/too long/],['leading space',' A forest of words!',/spaces/],['trailing space','A forest of words! ',/spaces/],['missing letter','349284928492!',/letter and one symbol/],['missing symbol','CloudsOverTheValley',/letter and one symbol/],['common','Password1234!',/less predictable/],['sequential','abcdefghijkl!',/less predictable/],['valid minimum','Kites!goUp42',null],['long phrase','A meadow holds blue kites!',null]]){
  const assessment=policy.assess(value);assert.equal(assessment.valid,!error,name);if(error)assert.throws(()=>server.checkPasswordStrength(value),error,name);else assert.equal(server.checkPasswordStrength(value),value,name);
 }
 const result=policy.assess('A meadow holds blue kites!');assert.equal(result.score,4);assert(result.rules.every(r=>r.met));assert.equal(policy.assess('').score,0);assert.equal(Object.hasOwn(result,'value'),false,'Assessment never echoes the password');
});
