'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('provider review pages all records and searches late matches while semantic revisions reject stale approval',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,at=new Date().toISOString(),id='review-pages';
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,provides,config,authorized_by_user_id,created_at,updated_at)
  VALUES($1,$2,$1,'Review source','bigcommerce','connected','[]','{}',$3,$4,$4)`,[id,ctx.workspaceId,ctx.actorId,at]);
 await db.transaction(c=>require('../../src/domain/postgres-catalog-service').createImportedItemsInTransaction(c,ctx,
  Array.from({length:205},(_,i)=>({name:'Match target '+i,trackingMode:'quantity',variants:[{key:String(i),code:'TARGET-'+String(i).padStart(3,'0')}]}))));
 await db.query(`INSERT INTO locations(id,workspace_id,name,kind,is_active,created_at)
  SELECT 'review-place-'||n,$1,'Match location '||n,'store',1,$2 FROM generate_series(1,105)n`,[ctx.workspaceId,at]);
 const connection=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[id])).rows[0],cache=require('../../src/connections/postgres-catalog-cache').cacheRecords;
 const records=Array.from({length:205},(_,i)=>({entityType:'sku',externalId:String(i).padStart(4,'0'),code:'SOURCE-'+i,displayName:'Provider product '+i,providerData:{itemName:'Provider product '+i}}));
 await db.transaction(c=>cache(c,connection,records));
 const service=require('../../src/connections/postgres-catalog-import'),first=await service.describe(db,ctx,id);
 assert.equal(first.rows.length,100);assert.equal(first.skus.length,100);assert.equal(first.locations.length,100);assert(first.page.moreSkus&&first.page.moreLocations);
 const seen=new Set();let page=first;
 do{for(const row of page.rows){assert(!seen.has(row.external_id));seen.add(row.external_id);}if(!page.page.next)break;page=await service.describe(db,ctx,id,page.page.next);}while(true);
 assert.equal(seen.size,205);
 const found=await service.describe(db,ctx,id,{catalogueQ:'0204',matchQ:'TARGET-204'});
 assert.equal(found.rows.length,1);assert.equal(found.skus.length,1);assert.equal(found.skus[0].code,'TARGET-204');
 assert.equal((await service.describe(db,ctx,id,{matchQ:'Match location 105'})).locations.length,1);
 await db.transaction(c=>cache(c,connection,records));assert.equal((await service.describe(db,ctx,id)).revision,first.revision);
 await assert.rejects(db.transaction(async c=>{await cache(c,connection,[{...records[204],displayName:'Rolled back name'}]);throw new Error('rollback fixture');}),/rollback fixture/);
 assert.equal((await service.describe(db,ctx,id)).revision,first.revision,'Rolled-back changes cannot invalidate a review');
 await db.transaction(c=>cache(c,connection,[{...records[204],displayName:'Changed outside first page'}]));
 await assert.rejects(service.mapExternal(db,ctx,id,{entityType:'sku',externalId:'0000',foundryRecordId:found.skus[0].id,revision:first.revision}),/changed/);
 const current=await service.describe(db,ctx,id);
 await service.mapExternal(db,ctx,id,{entityType:'sku',externalId:'0000',foundryRecordId:found.skus[0].id,revision:current.revision});
 const mappedRevision=(await service.describe(db,ctx,id)).revision;assert.notEqual(mappedRevision,current.revision);
 await db.query('UPDATE connection_mappings SET foundry_record_id=$3 WHERE workspace_id=$1 AND connector_id=$2 AND external_id=\'0000\'',[ctx.workspaceId,id,f.item.skuIds[0]]);
 assert.notEqual((await service.describe(db,ctx,id)).revision,mappedRevision,'Direct mapping repairs also invalidate the review');
 const adapter={metadata:()=>({type:'bigcommerce',name:'BigCommerce',authMode:'oauth',available:true,provides:[]}),discover:async()=>({})},registry={get:type=>type==='bigcommerce'?adapter:null,catalog:()=>[adapter.metadata()]};
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'review-pages-test',connectionProviders:registry}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
 const browserPage=await browser.newPage(),origin='http://127.0.0.1:'+server.address().port;browserPage.setDefaultTimeout(20000);
 await browserPage.goto(origin+'/login');await browserPage.getByLabel('Work email',{exact:true}).fill(f.email);await browserPage.locator('[name=password]').fill(f.password);await Promise.all([browserPage.waitForURL(origin+'/'),browserPage.getByRole('button',{name:'Sign in',exact:true}).click()]);
 assert.equal((await browserPage.goto(origin+'/settings/connections/'+id)).status(),200);
 await Promise.all([browserPage.waitForNavigation(),browserPage.getByRole('link',{name:'Next provider records',exact:true}).click()]);assert.equal(await browserPage.locator('[data-external-product]').count(),100);
 await browserPage.getByLabel('Find provider record',{exact:true}).fill('0204');await browserPage.getByLabel('Find StockChief match',{exact:true}).fill('TARGET-204');
 await Promise.all([browserPage.waitForNavigation(),browserPage.getByRole('button',{name:'Search catalogue and matches',exact:true}).click()]);
 assert.equal(await browserPage.locator('[data-external-product]').count(),1);assert.match(await browserPage.locator('[data-external-product] select').innerText(),/TARGET-204/);
});
