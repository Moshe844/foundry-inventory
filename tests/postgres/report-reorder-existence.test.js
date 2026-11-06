'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('report setup checks start from applicable policies and preserve archive and warehouse scope',{timeout:90000},async t=>{
 const {db,ctx}=await require('../helpers/postgres-shipping-fixture').fixture(t),rollback=Error('End isolated report test');
 await assert.rejects(db.transaction(async c=>{t.diagnostic(JSON.stringify(await require('../helpers/report-reorder-existence-checks').check(c,ctx)));throw rollback;},{isolation:'READ COMMITTED'}),e=>e===rollback);
});
