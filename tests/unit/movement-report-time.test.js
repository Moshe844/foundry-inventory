'use strict';const test=require('node:test'),assert=require('node:assert/strict'),reports=require('../../src/reports/postgres-service');
test('movement date bounds retain parameter identities after preceding non-date filters',()=>{
 const config=reports.normalize({dataset:'movements',summary:true,aggregate:'sum',measure:'quantity_delta',filters:[{field:'sku',operator:'equals',value:'COFFEE-250'},{field:'occurred_on',operator:'equals',value:'2026-03-08'}]},{role:'owner'});
 const q=reports.queryFor(config,'workspace-one',{limit:2});
 assert.deepEqual(q.values,['workspace-one','COFFEE-250','2026-03-08',2,0]);
 assert.match(q.sql,/stockchief_movement_instant\(m\.occurred_at\)>=\(\$3::text::date::timestamp AT TIME ZONE/);
 assert.match(q.sql,/stockchief_movement_instant\(m\.occurred_at\)<\(\(\$3::text::date\+1\)::timestamp AT TIME ZONE/);
 assert.match(q.sql,/w\.id=\$1/);assert.doesNotMatch(q.sql,/"occurred_on"=\$3/,'The exact timestamp bounds replace repeated per-row date filters');
});
test('additive movement charts convert timestamps after grouping and retain indexed date bounds inside the source',()=>{
 const config=reports.normalize({dataset:'movements',groups:['occurred_on'],aggregate:'sum',measure:'quantity_delta',filters:[{field:'occurred_on',operator:'equals',value:'2026-11-01'}]},{role:'owner'}),q=reports.queryFor(config,'workspace-one');
 assert.match(q.sql,/movement_instants AS MATERIALIZED/);assert.match(q.sql,/GROUP BY m\.occurred_at/);
 assert(q.sql.indexOf('stockchief_movement_instant(m.occurred_at)>=')<q.sql.indexOf('GROUP BY m.occurred_at'),'Apply indexed date bounds before grouping');
 assert.doesNotMatch(q.sql,/movement_date_bounds/);
 for(const aggregate of ['count','average','minimum','maximum'])assert.doesNotMatch(reports.queryFor(reports.normalize({...config,aggregate,sort:undefined},{role:'owner'}),'workspace-one').sql,/movement_instants AS MATERIALIZED/);
 for(const change of [{filters:[{field:'quantity_delta',operator:'at_least',value:2}]},{groups:['quantity_delta']}])assert.doesNotMatch(reports.queryFor(reports.normalize({...config,...change,sort:undefined},{role:'owner'}),'workspace-one').sql,/movement_instants AS MATERIALIZED/);
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
test('impossible movement filter dates fail clearly before reaching PostgreSQL',()=>{
 for(const value of ['2026-02-30','2026-13-01','0000-01-01'])assert.throws(()=>reports.queryFor(reports.normalize({dataset:'movements',summary:true,aggregate:'count',filters:[{field:'occurred_on',operator:'equals',value}]},{role:'owner'}),'workspace-one'),error=>error.code==='validation_error'&&/real calendar date/.test(error.message));
});
