'use strict';process.env.NODE_ENV='test';const test=require('node:test');
test('missing-cost coverage reads only nonzero generated quantities and excludes other inventories',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t);t.diagnostic(JSON.stringify(await require('../helpers/sparse-coverage-read-checks').check(f.db,f.ctx)));
});
