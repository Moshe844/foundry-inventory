'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{chromium}=require('playwright');
test('owner browser imports grouped provider variants and exact opening stock once, preserving tenant and review boundaries',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);await require('../../src/db/migrate-postgres').migratePostgres(db);
 const adapter={metadata:()=>({type:'shopify',name:'Shopify',authMode:'oauth',available:true,provides:[]}),discover:async()=>({})},registry={get:type=>type==='shopify'?adapter:null,catalog:()=>[adapter.metadata()]};
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:crypto.randomUUID(),connectionProviders:registry}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await chromium.launch();
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();await db.close();cluster.stop();});
 const page=await browser.newPage(),base='http://127.0.0.1:'+server.address().port,email=crypto.randomUUID()+'@example.test',errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/register');await page.getByLabel('Business name').fill('Provider import fixture');await page.getByLabel('Your name').fill('Fixture owner');await page.getByLabel('Work email').fill(email);const password='Test!'+crypto.randomUUID();await page.locator('[name=password]').fill(password);if(await page.locator('[name=confirmPassword]').count())await page.locator('[name=confirmPassword]').fill(password);await Promise.all([page.waitForURL(base+'/onboarding'),page.getByRole('button',{name:'Create account'}).click()]);
 const owner=(await db.query('SELECT u.workspace_id,u.id FROM users u JOIN accounts a ON a.id=u.account_id WHERE a.email=$1',[email])).rows[0],ctx={workspaceId:owner.workspace_id,actorId:owner.id},id='con_'+crypto.randomUUID().replaceAll('-',''),at=new Date().toISOString();
 await db.query("INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at) VALUES($1,$2,$3,'Shopify fixture','shopify','connected','[]','[]','{}',360,'MAPPING',$4,$5,$5)",[id,ctx.workspaceId,'shopify:'+id,ctx.actorId,at]);
 const connection=(await db.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0],sync=require('../../src/connections/postgres-provider-sync'),service=require('../../src/connections/postgres-catalog-import');
 const records=[{entityType:'location',externalId:'store-a',displayName:'Provider shop',providerData:{active:true}},
  {entityType:'location',externalId:'store-b',displayName:'Provider depot',providerData:{active:true}},
  ...['Red','Blue'].map((color,index)=>({entityType:'sku',externalId:'variant-'+color,parentExternalId:'provider-product',displayName:'Travel bag / '+color,providerData:{itemName:'Travel bag',variationName:color,tracked:true,productStatus:'ACTIVE',selectedOptions:[{name:'Color',value:color}],priceMoney:{amount:index?0:1250,currency:'JPY'},inventoryCounts:[{externalLocationId:'store-a',quantity:index?0:4,state:'IN_STOCK'},{externalLocationId:'store-b',quantity:index?0:6,state:'IN_STOCK'}]}})),
  {entityType:'sku',externalId:'gift',displayName:'Provider gift card',providerData:{isGiftCard:true,tracked:true}}];
 await db.transaction(async c=>{for(const row of records)await sync.cacheRecord(c,connection,row);});
 const unchanged=(await service.describe(db,ctx,id)).revision;
 await db.transaction(async c=>{for(const row of records)await sync.cacheRecord(c,connection,row);});
 assert.equal((await service.describe(db,ctx,id)).revision,unchanged,'An unchanged background refresh must preserve the reviewed facts');
 const changed={...records[2],providerData:{...records[2].providerData,priceMoney:{amount:1500,currency:'JPY'}}};
 await db.transaction(c=>sync.cacheRecord(c,connection,changed));
 await assert.rejects(service.importProducts(db,ctx,id,{externalIds:['variant-Red'],revision:unchanged}),/changed/);
 await db.transaction(c=>sync.cacheRecord(c,connection,records[2]));
 await assert.rejects(service.importProducts(db,ctx,id,{externalIds:['variant-Red'],includeOpening:true}),/Match every location/);assert.equal((await db.query('SELECT count(*) AS n FROM items WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 await page.goto(base+'/settings/connections/'+id);
 assert.match(await page.locator('main').innerText(),/Travel bag \/ Red/);
 const staleRevision=(await service.describe(db,ctx,id)).revision;
 for(const external of ['store-a','store-b']){await Promise.all([page.waitForNavigation(),page.locator('[data-external-location="'+external+'"]').getByRole('button',{name:'Create this provider location'}).click()]);}
 await assert.rejects(service.importProducts(db,ctx,id,{externalIds:['variant-Red'],revision:staleRevision}),/changed/);
 await page.getByRole('checkbox',{name:'Import Travel bag / Red',exact:true}).check();await page.getByRole('checkbox',{name:/Import the provider/}).check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Import selected products',exact:true}).click()]);
 assert.match(await page.locator('main').innerText(),/Imported 2 variants with 2 prices and 10 physical units/);
 const variants=(await db.query('SELECT s.id,s.variant_label,s.code,i.has_variants FROM skus s JOIN items i ON i.id=s.item_id WHERE s.workspace_id=$1 ORDER BY s.variant_label',[ctx.workspaceId])).rows;assert.equal(variants.length,2);assert(variants.every(v=>Number(v.has_variants)===1));assert.notEqual(variants[0].code,variants[1].code);
 const money=(await db.query('SELECT amount_minor,currency FROM sku_prices WHERE workspace_id=$1 ORDER BY amount_minor',[ctx.workspaceId])).rows;assert.deepEqual(money.map(p=>[Number(p.amount_minor),p.currency]),[[0,'JPY'],[1250,'JPY']]);
 const units=async()=>Number((await db.query('SELECT coalesce(sum(on_hand),0) AS n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);assert.equal(await units(),10);
 const repeated=await service.importProducts(db,ctx,id,{externalIds:['variant-Red'],includeOpening:true});assert.equal(repeated.replayed,true);assert.equal(await units(),10);
 await assert.rejects(service.mapExternal(db,ctx,id,{entityType:'location',externalId:'store-a',foundryRecordId:'foreign-location'}),/not in this inventory/);
 await assert.rejects(service.importProducts(db,{...ctx,actorId:'not-an-owner'},id,{externalIds:['variant-Red']}),/Only an owner/);
 await page.locator('summary').filter({hasText:'Excluded or non-physical'}).click();assert.equal(await page.getByRole('button',{name:'Confirm exclusion',exact:true}).count(),0);assert.match(await page.locator('main').innerText(),/Gift cards are financial products/);
 await db.transaction(c=>sync.cacheRecord(c,connection,records.at(-1)));assert.equal((await db.query("SELECT mapping_status FROM connection_external_records WHERE workspace_id=$1 AND connector_id=$2 AND external_id='gift'",[ctx.workspaceId,id])).rows[0].mapping_status,'EXCLUDED');
 assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'2');assert.equal((await db.query('SELECT count(*) AS n FROM accounting_supplier_bills WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');assert.deepEqual(errors,[]);
});
