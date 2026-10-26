'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('supplier replies read actual purchase quantities and cost evidence using the canonical purchase line schema',
  {timeout:120000},async t=>{
  const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:9});
  const facts=await require('../../src/connections/postgres-reply-drafting').factsFor(f.db,f.ctx.workspaceId,
    {sender:'parts@example.test',supplier_id:'fixture-supplier'});
  assert(facts.some(s=>s.includes('9 ordered')&&s.includes('9 received')));
  assert(facts.some(s=>s.includes('USD 1.00')));
  assert.equal((await require('../../src/connections/postgres-reply-drafting').factsFor(f.db,'unrelated-business',
    {sender:'parts@example.test',supplier_id:'fixture-supplier'})).length,0);
  assert.equal(await f.balance(),9);
});
