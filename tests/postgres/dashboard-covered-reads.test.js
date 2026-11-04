'use strict';process.env.NODE_ENV='test';const test=require('node:test');
test('Money and stock-value previews support covered reads while retaining exact balances',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t);t.diagnostic(JSON.stringify(await require('../helpers/dashboard-covered-read-checks').check(f.db,f.ctx)));
});
