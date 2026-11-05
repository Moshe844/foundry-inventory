'use strict';process.env.NODE_ENV='test';const test=require('node:test');
test('cold stock reads stream positions while preserving exact availability and low-stock populations',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t);t.diagnostic(JSON.stringify(await require('../helpers/cold-stock-position-checks').check(f.db,f.ctx)));
});
