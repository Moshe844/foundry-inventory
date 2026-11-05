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
test('movement headlines sum the bounded quantities without grouping or converting timestamps',()=>{
 const q=reports.queryFor(reports.normalize({dataset:'movements',summary:true,aggregate:'sum',measure:'quantity_delta',filters:[{field:'occurred_on',operator:'equals',value:'2026-11-01'}]},{role:'owner'}),'workspace-one',{dateContext:{timeZone:'America/New_York'}});
 assert.match(q.sql,/SELECT SUM\("quantity_delta"\)/);assert.match(q.sql,/stockchief_movement_instant\(m\.occurred_at\)>=/);
 assert.doesNotMatch(q.sql,/movement_instants|GROUP BY|to_char|JOIN items/);
 const all=reports.queryFor(reports.normalize({dataset:'movements',summary:true,aggregate:'sum',measure:'quantity_delta'},{role:'owner'}),'workspace-one',{dateContext:{timeZone:'America/New_York'}});
 assert.deepEqual(all.values,['workspace-one',201,0],'An unfiltered scalar total must not bind an unused time-zone parameter');
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
test('a known business clock binds the movement time zone without changing date or composed metric parameters',()=>{
 const actor={role:'owner'},dateContext={timeZone:'America/New_York',calendarDate:'2026-11-01'},filters=[{field:'occurred_on',operator:'equals',value:'2026-11-01'}];
 const q=reports.queryFor(reports.normalize({dataset:'movements',groups:['occurred_on'],aggregate:'sum',measure:'quantity_delta',filters},actor),'workspace-one',{dateContext,limit:5});
 assert.deepEqual(q.values,['workspace-one','2026-11-01','America/New_York',5,0]);
 assert.match(q.sql,/\$2::text::date::timestamp AT TIME ZONE \$3::text/);
 assert.match(q.sql,/to_char\(stockchief_movement_instant\(m\.occurred_at\) AT TIME ZONE \$3::text/);
 assert.doesNotMatch(q.sql,/FROM workspaces/);
 const composed=require('../../src/reports/postgres-composed'),spec=composed.normalize({dataset:'composed',dimension:'sku',metrics:[
  {alias:'moved',dataset:'movements',aggregate:'sum',measure:'quantity_delta',filters},
  {alias:'stock',dataset:'stock',aggregate:'sum',measure:'on_hand',filters:[{field:'location',operator:'equals',value:'Main'}]},
  {alias:'later',dataset:'movements',aggregate:'sum',measure:'quantity_delta',filters:[{field:'occurred_on',operator:'equals',value:'2026-11-02'}]}
 ],chart:'table'},actor),combined=composed.queryFor(spec,'workspace-one',{dateContext});
 assert.deepEqual(combined.values.slice(0,7),['workspace-one','2026-11-01','America/New_York','Main','2026-11-02','America/New_York',201]);
 assert.match(combined.sql,/stockchief_movement_instant\(m\.occurred_at\)>=\(\$5::text::date::timestamp AT TIME ZONE \$6::text/);
 assert.match(combined.sql,/"location"=\$4/);
});
