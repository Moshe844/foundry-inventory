'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('sales, tax and expense reports select their ledger accounts and retain exact signs',{timeout:90000},async t=>{
 const {db,ctx}=await require('../helpers/postgres-shipping-fixture').fixture(t),rollback=Error('End isolated ledger reports');
 await assert.rejects(db.transaction(async c=>{const scoped={query:c.query.bind(c),transaction:fn=>fn(c)};t.diagnostic(JSON.stringify(await require('../helpers/report-ledger-account-checks').check(scoped,ctx)));throw rollback;},{isolation:'REPEATABLE READ'}),e=>e===rollback);
});
