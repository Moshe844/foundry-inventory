'use strict';process.env.NODE_ENV='test';
// Products, options, SKUs and prices an import creates take time-ordered IDs, so each
// batch lands at the end of their indexes. With random IDs every new SKU, price and
// binding read a random index page from disk once the catalogue outgrew memory: at a
// million SKUs, preparing slowed from 5 to 55 seconds per 10,000 rows.
const test=require('node:test'),assert=require('node:assert/strict');
const APPEND=prefix=>new RegExp('^'+prefix+'_[0-7][0-9a-hjkmnp-tv-z]{25}$');
test('an imported catalogue gets time-ordered product, option, SKU and price IDs',{timeout:180000},async t=>{
 const {db,ctx,location}=await require('../helpers/postgres-shipping-fixture').fixture(t),imports=require('../../src/imports/postgres-service');
 const rows=['Product,SKU,Option1 Name,Option1 Value,Price,Quantity,Unit cost,Location'];
 for(let p=0;p<3;p++)for(const size of ['S','M','L'])rows.push([`Ordered shirt ${p}`,`ORD-${p}-${size}`,'Size',size,'9.00',2,'3.00','Dispatch'].join(','));
 const plan=await imports.analyse(db,ctx,{text:rows.join('\n'),filename:'ordered-ids.csv',allowModel:false,importMode:'add',defaultLocationId:location.id});
 assert.equal(plan.recordsInvalid,0);await imports.approve(db,ctx,plan.id,plan.integrityHash);
 const result=await imports.execute(db,ctx,plan.id);assert(result.verified);assert.equal(result.skusCreated,9);
 const skus=(await db.query("SELECT s.id,s.item_id FROM skus s WHERE s.workspace_id=$1 AND s.code LIKE 'ORD-%' ORDER BY s.code",[ctx.workspaceId])).rows;
 assert.equal(skus.length,9);
 for(const s of skus){assert.match(s.id,APPEND('sku'));assert.match(s.item_id,APPEND('item'));}
 const options=(await db.query('SELECT id FROM item_options WHERE workspace_id=$1 AND item_id=ANY($2::text[])',[ctx.workspaceId,[...new Set(skus.map(s=>s.item_id))]])).rows;
 assert(options.length>0);for(const o of options)assert.match(o.id,APPEND('opt'));
 const prices=(await db.query('SELECT id FROM sku_prices WHERE workspace_id=$1 AND sku_id=ANY($2::text[])',[ctx.workspaceId,skus.map(s=>s.id)])).rows;
 assert.equal(prices.length,9);for(const p of prices)assert.match(p.id,APPEND('prc'));
});
