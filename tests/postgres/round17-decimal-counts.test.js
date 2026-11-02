'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');

test('decimal physical counts preserve exact units and cents, including intervening receipts and replay',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,location}=f;
 const catalog=require('../../src/domain/postgres-catalog-service'),opening=require('../../src/domain/postgres-opening-stock'),counts=require('../../src/accounting/postgres-physical-count');
 const item=await catalog.createItem(db,ctx,{name:'Coffee by kg',baseCode:'COUNT-DECIMAL-KG',trackingMode:'quantity',unitLabel:'kg',quantityPrecision:3,quantityIncrement:'0.001'}),skuId=item.skuIds[0];
 const position=async()=>{const row=(await db.query(`SELECT b.on_hand::text physical,c.quantity_units::text costed,c.total_cost_minor::text value
 FROM balances b JOIN accounting_inventory_cost_balances c USING(workspace_id,sku_id,location_id)
 WHERE b.workspace_id=$1 AND b.sku_id=$2 AND b.location_id=$3`,[ctx.workspaceId,skuId,location.id])).rows[0];return Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Number(v)]));};
 await opening.receive(db,ctx,{skuId,locationId:location.id,quantity:'0.1',unitCost:'10.00',idempotencyKey:'decimal-count:opening'});
 const input={skuId,locationId:location.id,countedQuantity:'0.3',unitCost:'10.00',reasonCode:'found',idempotencyKey:'decimal-count:increase'};
 const increase=await counts.apply(db,ctx,input);assert.equal(increase.costDeltaMinor,200);assert.deepEqual(await position(),{physical:0.3,costed:0.3,value:300});
 assert.equal((await counts.apply(db,ctx,input)).replayed,true);assert.deepEqual(await position(),{physical:0.3,costed:0.3,value:300});
 const reduction=await counts.apply(db,ctx,{...input,countedQuantity:'0.1',reasonCode:'cycle_count',idempotencyKey:'decimal-count:decrease'});
 assert.equal(reduction.costDeltaMinor,-200);assert.deepEqual(await position(),{physical:0.1,costed:0.1,value:100});
 const before=await position();await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId,locationId:location.id,quantity:'0.3',unitCost:'10.00',idempotencyKey:'decimal-count:later-receipt'});
 const preserved=await counts.apply(db,ctx,{...input,preservePostPreviewMovements:true,expectedBefore:before,expectedCostDeltaMinor:200,idempotencyKey:'decimal-count:preserve-later'});
 assert.equal(preserved.costDeltaMinor,200);assert.deepEqual(await position(),{physical:0.6,costed:0.6,value:600});
 // Invalid input remains rejected rather than being rounded into a valid count.
 await assert.rejects(()=>counts.apply(db,ctx,{...input,countedQuantity:'abc',idempotencyKey:'decimal-count:invalid'}),/decimal|quantity/i);
 assert.deepEqual(await position(),{physical:0.6,costed:0.6,value:600});
});
