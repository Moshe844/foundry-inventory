'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),reads=require('../../src/assistant/bounded-business-read');
const actor={role:'owner'};
test('the recorded receivables query sorts the calculated unpaid balance without changing its filters or currency grouping',()=>{
 const original={dataset:'customer_invoices',groups:['customer','currency'],summary:false,aggregate:'sum',measure:'balance_minor',filters:[{field:'balance_minor',operator:'greater_than',value:0}],sort:'balance_minor',direction:'desc',topN:100};
 const plan=reads.validate({status:'read',question:'',queries:[original]},actor),q=plan.queries[0];
 assert.equal(q.sort,'total');assert.deepEqual(q.filters,[{...original.filters[0],value:'0'}]);assert.deepEqual(q.groups,original.groups);assert.equal(q.topN,100);
 const engine=require('../../src/reports/postgres-service'),sql=engine.queryFor(q,'workspace-one').sql;assert.match(sql,/SUM\("balance_minor"\) AS "total"/);assert.match(sql,/ORDER BY "total" DESC/);
 for(const [aggregate,column]of [['sum','total'],['average','average'],['minimum','minimum'],['maximum','maximum']])assert.equal(engine.normalize({...original,aggregate},actor).sort,column);
 assert.equal(engine.normalize({...original,groups:['balance_minor','currency']},actor).sort,'balance_minor','Explicit group fields keep their own ordering');
 assert.throws(()=>engine.normalize({...original,sort:'not_a_registered_field'},actor),/registered field to sort/);
});
test('read-only requests select a browser-free bounded lane across business domains',()=>{
 for(const text of ['How many 500g Vanilla bags are in NJ?','Which variant sells best?','Compare sales and profit by month','Show the top 10 stock positions by value','Where is barcode 0123456789?','Why is coffee low?','Investigate inventory without changing records','I need to know where my stock is','Tell me about my inventory','Unfamiliar read-only wording'])assert.equal(reads.selected(text),true,text);
 for(const text of ['Receive 12 cases of Coffee','Transfer 3 Black variants to NJ','Create a purchase order'])assert.equal(reads.selected(text),false,text);
});
test('one model interpretation exposes registered reads and cannot supply SQL, execution or a browser',async()=>{
 let calls=0;const provider=require('../../src/commercial/relay-provider').register({complete:async request=>{calls++;assert.match(request.system,/No browser/);assert.match(request.prompt,/on_hand/);assert.equal(request.schemaName,'bounded_business_read');return {data:{status:'read',queries:[{dataset:'stock',summary:true,aggregate:'count'}],question:''}};}});
 const plan=await reads.interpret(provider,actor,'Count stock positions');assert.equal(calls,1);assert.equal(plan.queries.length,1);
 for(const spec of [{dataset:'stock',sql:'DROP TABLE items',summary:true},{dataset:'environment_browser',summary:true},{dataset:'stock',summary:true,topN:1000000},{dataset:'stock',columns:['password_hash']}])assert.throws(()=>reads.validate({status:'read',queries:[spec],question:''},actor));
 assert.throws(()=>reads.validate({status:'read',queries:[{dataset:'journal_lines',summary:true,aggregate:'count'}],question:''},{role:'viewer',permissions:[]}));
 const mixed=reads.validate({status:'read',queries:[{dataset:'stock',summary:true,aggregate:'sum',measure:'on_hand'}],question:''},actor);assert.deepEqual(mixed.queries[0].groups,['stock_unit']);assert.equal(mixed.queries[0].summary,false);
 for(const raw of [{complete:provider.complete},{...provider,ownsAccounting:true,commercial:true}])await assert.rejects(reads.interpret(raw,actor,'Count stock positions'),/REQUIRES_GOVERNED_PROVIDER/);assert.equal(calls,1,'Unfunded and forged provider objects cannot make a request');
});
test('answers render exact database values, explicit filters and truncation without another model or review loop',()=>{
 const sections=[{label:'Stock by product',config:{filters:[{field:'location',operator:'equals',value:'NJ-Main'}]},columns:['variant','on_hand'],columnLabels:{variant:'Variant','on_hand':'On hand'},rows:[{variant:'Vanilla / 500g',on_hand:'3.75'}],hasMore:true}];
 assert.equal(reads.render(sections),'### Stock by product\nFilters: location equals NJ-Main.\n\n| Variant | On hand |\n|---|---:|\n| Vanilla / 500g | 3.75 |\n\nShowing the first 1 results. Narrow the filters for the remaining records.');
 const large=reads.render([{...sections[0],rows:Array.from({length:100},()=>({variant:'Long product '.repeat(100),on_hand:'3.75'})),hasMore:false}]);assert(large.length<20000);assert.match(large,/This answer was shortened/);
});

test('saved display-only money answers remain readable without fabricating raw totals',()=>{
 const section={dataset:'customer_invoices',label:'Amounts owed',config:{filters:[],columns:['customer','balance_minor','currency']},columns:['customer','balance_minor','currency'],columnLabels:{customer:'Customer',balance_minor:'Balance',currency:'Currency'},rows:[{customer:'First customer',balance_minor:'$12.50',currency:'USD'},{customer:'Second customer',balance_minor:'$7.25',currency:'USD'}],hasMore:false};
 const text=reads.render([section]);assert.match(text,/First customer \| \$12\.50 \| USD/);assert.match(text,/Second customer \| \$7\.25 \| USD/);assert.doesNotMatch(text,/Total owed|\$0\.00/);
 const profit=['revenue_minor','cogs_minor'].map(measure=>({...section,dataset:'profit_activity',config:{dataset:'profit_activity',filters:[{field:'currency',operator:'equals',value:'USD'}],groups:['currency'],aggregate:'sum',measure},columns:['currency','total'],rows:[{currency:'USD',total:measure==='revenue_minor'?'$12.50':'$7.25'}]}));
 const legacy=reads.render(profit);assert.match(legacy,/\$12\.50/);assert.match(legacy,/\$7\.25/);assert.doesNotMatch(legacy,/Gross profit|Net profit|\$0\.00/);
});
