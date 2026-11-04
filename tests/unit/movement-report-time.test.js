'use strict';const test=require('node:test'),assert=require('node:assert/strict'),reports=require('../../src/reports/postgres-service');
test('movement date bounds retain parameter identities after preceding non-date filters',()=>{
 const config=reports.normalize({dataset:'movements',summary:true,aggregate:'sum',measure:'quantity_delta',filters:[{field:'sku',operator:'equals',value:'COFFEE-250'},{field:'occurred_on',operator:'equals',value:'2026-03-08'}]},{role:'owner'});
 const q=reports.queryFor(config,'workspace-one',{limit:2});
 assert.deepEqual(q.values,['workspace-one','COFFEE-250','2026-03-08',2,0]);
 assert.match(q.sql,/stockchief_movement_instant\(m\.occurred_at\)>=\(\$3::text::date::timestamp AT TIME ZONE/);
 assert.match(q.sql,/stockchief_movement_instant\(m\.occurred_at\)<\(\(\$3::text::date\+1\)::timestamp AT TIME ZONE/);
 assert.match(q.sql,/w\.id=\$1/);assert.doesNotMatch(q.sql,/"occurred_on"=\$3/,'The exact timestamp bounds replace repeated per-row date filters');
});
test('movement day comparisons bound calendar days without assuming a 24-hour UTC duration',()=>{
 for(const [operator,fragment]of [['after','>=($2::text::date::timestamp'],['before','<(($2::text::date+1)::timestamp'],['greater_than','>=(($2::text::date+1)::timestamp'],['less_than','<($2::text::date::timestamp']]){
  const q=reports.queryFor(reports.normalize({dataset:'movements',summary:true,aggregate:'sum',measure:'quantity_delta',filters:[{field:'occurred_on',operator,value:'2026-11-01'}]},{role:'owner'}),'workspace-one');assert(q.sql.includes('stockchief_movement_instant(m.occurred_at)'+fragment),operator);assert.doesNotMatch(q.sql,/interval '24 hours'/);
 }
});
test('composed movement reads retain date parameters belonging to their own metric',()=>{
 const composed=require('../../src/reports/postgres-composed'),config=composed.normalize({dataset:'composed',dimension:'sku',metrics:[
  {alias:'stock',dataset:'stock',aggregate:'sum',measure:'on_hand',filters:[{field:'location',operator:'equals',value:'Main'}]},
  {alias:'moved',dataset:'movements',aggregate:'sum',measure:'quantity_delta',filters:[{field:'sku',operator:'equals',value:'COFFEE-250'},{field:'occurred_on',operator:'equals',value:'2026-11-01'}]}
 ],chart:'table'},{role:'owner'}),q=composed.queryFor(config,'workspace-one');
 assert.deepEqual(q.values.slice(0,4),['workspace-one','Main','COFFEE-250','2026-11-01']);
 assert.match(q.sql,/stockchief_movement_instant\(m\.occurred_at\)>=\(\$4::text::date::timestamp/);
 assert.match(q.sql,/stockchief_movement_instant\(m\.occurred_at\)<\(\(\$4::text::date\+1\)::timestamp/);
});
