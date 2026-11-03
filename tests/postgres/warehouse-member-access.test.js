'use strict';process.env.NODE_ENV='test';
const test=require('node:test');
test('warehouse restrictions isolate reads, writes, bins, tokens, Ask and stale sessions',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t);await f.db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('warehouse-member',$1,'enterprise','COMP','ISOLATED_TEST')",[f.owner.accountId]);
 const second=await require('../../src/domain/postgres-location-service').createLocation(f.db,f.ctx,{name:'Other warehouse private',kind:'warehouse'});
 await require('../helpers/warehouse-member-checks').check(t,{...f,locations:[f.location,second]});
});
