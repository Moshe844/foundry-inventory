'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {makeDatabase,seedWorkspace,makeQuantityItem,cleanupAll}=require('../helpers');
const engine=require('../../src/domain/inventory-engine');
const records=require('../../src/attention/record-query');
const semantic=require('../../src/attention/semantic-query');
const planner=require('../../src/attention/query-planner');
test.after(cleanupAll);
function setup(){
 const {db}=makeDatabase();const w=seedWorkspace(db);
 const a=makeQuantityItem(db,w.ctx,{name:'Copper Sleeve',baseCode:'CS'});
 const b=makeQuantityItem(db,w.ctx,{name:'Graphite Sleeve',baseCode:'GS'});
 const c=makeQuantityItem(db,w.ctx,{name:'Ceramic Ring',baseCode:'CR'});
 engine.receive(db,w.ctx,{skuId:a.skuId,locationId:w.main.id,quantity:7});
 engine.receive(db,w.ctx,{skuId:b.skuId,locationId:w.store.id,quantity:3});
 return {db,w,a,b,c};
}
function query(overrides={}){return {dataset:'products',entityScope:'set',fields:[],filters:[{field:'active',operator:'eq',value:1}],filterMode:'all',aggregate:'count',measure:'',metrics:[],groupBy:[],sortField:'',sortDirection:'asc',limit:25,...overrides};}
function part(q){return {question:'Catalogue lookup',intent:'record_query',entityQuery:'',locationQuery:'',windowDays:30,limit:10,unsupportedReason:'',recordQuery:q};}
function reply(parts){return {decision:'answer',interpretation:'Read the requested live records',clarification:'',parts};}
function provider(data,inspect=()=>{}){return {async complete(request){inspect(request);return {data};}};}

test('general predicates combine arbitrary measures, status, fields and grouping; counts are not truncated',()=>{
 const {db,w}=setup();
 assert.equal(records.execute(db,w.workspaceId,query({limit:1})).rows[0].value,3);
 const filtered=records.execute(db,w.workspaceId,query({filters:[{field:'on_hand',operator:'lt',value:5},{field:'product',operator:'contains',value:'Sleeve'}]}));
 assert.equal(filtered.rows[0].value,1);
 const grouped=records.execute(db,w.workspaceId,query({groupBy:['status']}));
 assert.deepEqual(Object.fromEntries(grouped.rows.map(r=>[r.status,r.value])),{'In stock':2,'None yet':1});
 const positions=records.execute(db,w.workspaceId,query({dataset:'positions',filters:[],aggregate:'sum',measure:'on_hand',groupBy:['location']}));
 assert.equal(positions.rows.reduce((n,r)=>n+r.value,0),10);
 const combined=records.execute(db,w.workspaceId,query({aggregate:'',metrics:[{operation:'count',field:''},{operation:'sum',field:'on_hand'},{operation:'average',field:'on_hand'}],groupBy:['tracking']}));
 assert.equal(combined.rows[0].count,3);assert.equal(combined.rows[0]['sum:on_hand'],10);assert.equal(combined.rows[0].matching_records,3);
 assert.match(combined.answer,/Total on hand: 10/);assert.match(combined.answer,/products: 3/);
});
test('arbitrary supplied fields are discovered and missing is distinct from an invented value',()=>{
 const {db,w,a}=setup();
 db.prepare(`INSERT INTO catalogue_sku_facts(workspace_id,sku_id,facts,created_at,updated_at) VALUES (?,?,?,datetime('now'),datetime('now'))`).run(w.workspaceId,a.skuId,JSON.stringify({'Pressure rating':'Class X','Finish schedule':'Custom','Thermal coefficient':42}));
 assert.ok(records.catalogue(db,w.workspaceId).variants.fields.includes('attribute:Pressure rating'));
 const present=records.execute(db,w.workspaceId,query({dataset:'variants',filters:[{field:'attribute:Pressure rating',operator:'eq',value:'Class X'}]}));
 assert.equal(present.rows[0].value,1);
 const missing=records.execute(db,w.workspaceId,query({dataset:'variants',filters:[{field:'attribute:Pressure rating',operator:'is_missing',value:null}]}));
 assert.equal(missing.rows[0].value,2);
 const sum=records.execute(db,w.workspaceId,query({dataset:'variants',filters:[],aggregate:'sum',measure:'attribute:Thermal coefficient'}));
 assert.equal(sum.rows[0].value,42);
 assert.throws(()=>records.execute(db,w.workspaceId,query({filters:[{field:'imagined_field',operator:'eq',value:'x'}]})),/verified safely/);
});
test('tenant scoping, parameterized values and invalid field/operator rejection',()=>{
 const {db,w}=setup();const other=seedWorkspace(db,{email:'other-chat@example.com'});
 makeQuantityItem(db,other.ctx,{name:'Private Product',baseCode:'P'});
 assert.equal(records.execute(db,w.workspaceId,query()).rows[0].value,3);
 assert.equal(records.execute(db,w.workspaceId,query({filters:[{field:'product',operator:'contains',value:"' OR 1=1 --"}]})).rows[0].value,0);
 for(const f of [{field:'on_hand; DROP TABLE items',operator:'eq',value:1},{field:'product',operator:'sql',value:'x'}])assert.throws(()=>records.execute(db,w.workspaceId,query({filters:[f]})),/verified safely/);
 assert.equal(db.prepare('SELECT count(*) n FROM items').get().n,4);
});
test('production ask uses one semantic interpretation for novel wording and keeps every subquestion',async()=>{
 const {db,w}=setup();let calls=0;
 const result=await planner.ask(db,w.workspaceId,'Count catalogue entries awaiting their very first receipt, and total units of sleeves.',{
  provider:provider(reply([part(query({filters:[{field:'status',operator:'eq',value:'None yet'}]})),part(query({aggregate:'sum',measure:'on_hand',filters:[{field:'product',operator:'contains',value:'Sleeve'}]}))]),r=>{calls++;assert.equal(r.schemaName,'stockchief_semantic_query');}),
 });
 assert.equal(calls,1);assert.equal(result.sections.length,2);
 assert.equal(result.sections[0].rows[0].value,1);assert.equal(result.sections[1].rows[0].value,10);
 assert.match(result.answer,/1/);assert.match(result.answer,/10/);assert.equal(result.plan.intent,'combined_lookup');
 assert.equal(result.question,'Count catalogue entries awaiting their very first receipt, and total units of sleeves.');
});
test('follow-ups carry only same-workspace context; explicit ambiguity asks without executing',async()=>{
 const {db,w}=setup();const clarification={decision:'clarify',interpretation:'Clarify value basis',clarification:'Do you mean recorded cost or selling-price value?',parts:[]};
 const result=await planner.ask(db,w.workspaceId,'How much is it worth?',{provider:provider(clarification)});
 assert.equal(result.needsClarification,true);assert.match(result.answer,/cost or selling/);
 for(const workspaceId of [w.workspaceId,'another-workspace']){
  await planner.ask(db,w.workspaceId,'Only those above five.',{conversation:{workspaceId,question:'List sleeves',semanticPlan:reply([part(query())])},provider:provider(clarification,r=>{
   const prompt=JSON.parse(r.prompt);assert.equal(Boolean(prompt.previous),workspaceId===w.workspaceId);
  })});
 }
});
test('invalid or oversized interpretation does not guess; interpreter failure is bounded',async()=>{
 const {db,w}=setup();
 const invalid=await planner.ask(db,w.workspaceId,'Anything?',{provider:provider(reply(Array(7).fill(part(query()))))});
 assert.equal(invalid.needsClarification,true);assert.equal(invalid.rows.length,0);
 await assert.rejects(semantic.boundedComplete({complete:()=>new Promise(()=>{})},{},20),/in time/);
});
test('actions never execute and reads never write business records',async()=>{
 const {db,w}=setup();const before=db.prepare('SELECT total_changes() n').get().n;
 const action=await planner.ask(db,w.workspaceId,'Email suppliers to reorder.',{provider:provider({decision:'action',interpretation:'Prepare supplier orders',clarification:'I will prepare the change for your review.',parts:[]})});
 assert.equal(action.isAction,true);
 await planner.ask(db,w.workspaceId,'Count everything',{provider:provider(reply([part(query())]))});
 assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
});
test('ambiguous singular product references are not silently combined',()=>{
 const {db,w}=setup();
 const result=semantic.executePart(db,w.workspaceId,{intent:'stock_level',entityQuery:'Sleeve',question:'How many of that sleeve?'},{});
 assert.equal(result.needsClarification,true);assert.match(result.answer,/Which product/);
 const generic=records.execute(db,w.workspaceId,query({entityScope:'single',aggregate:'sum',measure:'on_hand',filters:[{field:'product',operator:'contains',value:'Sleeve'}]}));
 assert.equal(generic.needsClarification,true);assert.equal(generic.rows.length,0);
});
test('every registered read model compiles and displays only documented fields',()=>{
 const {db,w}=setup();
 for(const dataset of Object.keys(records.REGISTRY)){
  const result=records.execute(db,w.workspaceId,query({dataset,aggregate:'',filters:[]}));
  assert.deepEqual(result.columns,records.REGISTRY[dataset].defaults,dataset);
 }
});
test('financial permissions are enforced before querying even when the model requests figures',()=>{
 const {db,w}=setup();
 const result=semantic.executePart(db,w.workspaceId,{intent:'balance_sheet',question:'Show all money'}, {membership:{role:'viewer'}});
 assert.equal(result.supported,false);assert.match(result.answer,/does not permit/);
 const supplier=semantic.executePart(db,w.workspaceId,{intent:'last_cost',question:'What did we pay?'},{membership:{role:'viewer'}});
 assert.equal(supplier.supported,false);assert.match(supplier.answer,/does not permit/);
});
test('unimplemented scope is clarified rather than silently returning a global figure',()=>{
 const {db,w}=setup();
 const global=semantic.executePart(db,w.workspaceId,{intent:'inventory_valuation',entityQuery:'Ceramic Ring',question:'Value only that ring'},{});
 assert.equal(global.needsClarification,true);assert.equal(global.rows.length,0);
 assert.throws(()=>semantic.executePart(db,w.workspaceId,{...part(query()),entityQuery:'Ceramic Ring'},{}),/unscoped total/);
});
