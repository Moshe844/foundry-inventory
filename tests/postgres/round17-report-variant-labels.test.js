'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('SKU report rows name variants while explicit columns, parent filters and parent totals retain their meaning',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service'),reports=require('../../src/reports/postgres-service');
 const item=await catalog.createItem(db,ctx,{name:'Lotion report fixture',baseCode:'REPORT-OPTIONS',trackingMode:'quantity',hasVariants:true,options:[{name:'Scent',values:'Rose,Plain'}]});
 for(const id of item.skuIds)await require('../../src/domain/postgres-opening-stock').receive(db,ctx,{skuId:id,locationId:f.location.id,quantity:3,unitCost:'2',idempotencyKey:'report-label-'+id});
 const filter={field:'product',operator:'equals',value:'Lotion report fixture'},base={dataset:'stock',filters:[filter],chart:'table'};
 const labelled=await reports.run(db,ctx,{role:'owner'},{...base,columns:['product','sku','on_hand']});assert.equal(labelled.rows.length,2);assert.deepEqual(labelled.rows.map(r=>r.product).sort(),['Lotion report fixture — Plain','Lotion report fixture — Rose']);assert.deepEqual(labelled.displayRows.map(r=>r.product),labelled.rows.map(r=>r.product));
 const explicit=await reports.run(db,ctx,{role:'owner'},{...base,columns:['product','sku','variant','on_hand']});assert(explicit.rows.every(r=>r.product==='Lotion report fixture'));assert.deepEqual(explicit.rows.map(r=>r.variant).sort(),['Plain','Rose']);
 const grouped=await reports.run(db,ctx,{role:'owner'},{...base,groups:['product'],aggregate:'sum',measure:'on_hand'});assert.deepEqual(grouped.rows.map(({href,...r})=>r),[{product:'Lotion report fixture',total:'6'}]);
 const foreign=await reports.run(db,{...ctx,workspaceId:'foreign-inventory'},{role:'owner'},{...base,columns:['product','sku']});assert.equal(foreign.rows.length,0);
});
