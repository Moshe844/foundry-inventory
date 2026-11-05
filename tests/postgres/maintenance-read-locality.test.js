'use strict';process.env.NODE_ENV='test';const test=require('node:test');
test('empty inventory scheduling and paused-work sweeps avoid unrelated stock and completed jobs',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t);t.diagnostic(JSON.stringify(await require('../helpers/maintenance-read-locality-checks').check(f.db,f.ctx)));
});
