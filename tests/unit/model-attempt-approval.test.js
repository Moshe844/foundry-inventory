'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),budget=require('../../src/commercial/model-budget');
test('temporary attempt approvals expire, remain account scoped and preserve failure limits',async t=>{
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_AI_MAX_MODEL_ATTEMPTS_PER_DAY','STOCKCHIEF_AI_MODEL_ATTEMPT_APPROVALS','STOCKCHIEF_AI_MAX_FAILED_MODEL_ATTEMPTS_PER_DAY'],before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys)if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];});
 delete process.env.STOCKCHIEF_AI_MAX_MODEL_ATTEMPTS_PER_DAY;delete process.env.STOCKCHIEF_AI_MAX_FAILED_MODEL_ATTEMPTS_PER_DAY;
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';process.env.STOCKCHIEF_AI_MODEL_ATTEMPT_APPROVALS=JSON.stringify([{accountId:'approved',maximum:1000,expiresAt:'2030-01-01T00:00:00Z'}]);
 const now=Date.parse('2029-12-31T23:00:00Z');assert.equal(budget.attemptCeiling('approved',now),1000);assert.equal(budget.attemptCeiling('other',now),250);
 assert.equal(budget.attemptCeiling('approved',Date.parse('2030-01-01T00:00:00Z')),250);
 let admitted;await budget.begin({query:async(sql,values)=>{admitted={sql,values};return{rows:[{day:'today'}]};}},'approved');
 assert.equal(admitted.values[1],1000);assert.equal(admitted.values[2],12);assert.match(admitted.sql,/attempts=commercial_model_daily_attempts.attempts\+1/);
 process.env.STOCKCHIEF_RUNTIME_ENV='production';assert.throws(()=>budget.attemptCeiling('approved',now),/Staging-only/);
});
