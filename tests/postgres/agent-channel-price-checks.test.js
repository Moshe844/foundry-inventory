'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const checks=require('../../src/pricing/agent-channel-price-checks');

// Job 87: channel prices recorded by the real Shopify, Square and WooCommerce
// connectors (their network answered by test stand-ins) are compared with the
// catalogue price and the owner's MAP terms. Nothing ever writes a price.
async function setup(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:4}),{db,ctx}=f,ws=ctx.workspaceId;
  await f.subscribe('growth');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const prices=require('../../src/pricing/postgres-service'),catalog=require('../../src/domain/postgres-catalog-service');
  const code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
  await prices.setPrice(db,ctx,{skuId:f.item.skuIds[0],amountMinor:1200,currency:'USD'});
  const gift=await catalog.createItem(db,ctx,{name:'Gift box',baseCode:'GIFT-'+randomUUID().slice(0,8),trackingMode:'quantity'});
  const giftCode=(await db.query('SELECT code FROM skus WHERE id=$1',[gift.skuIds[0]])).rows[0].code;
  // What each channel currently lists. The stand-ins answer the adapters' own API calls.
  const listed={shopify:{main:'12.00',gift:'5.00'},square:{main:1100,gift:600,override:1300},woo:{main:'9.00'}};
  const writes=[];
  t.mock.method(global,'fetch',async(value,options={})=>{
    const url=new URL(value),method=String(options.method||'GET').toUpperCase();
    if(url.hostname.endsWith('.myshopify.com')){
      const {query}=JSON.parse(options.body);
      if(/^\s*mutation/.test(query))writes.push('shopify '+query.slice(0,40));
      if(query.includes('Locations'))return Response.json({data:{locations:{nodes:[],pageInfo:{hasNextPage:false}}}});
      const variant=(id,sku,price)=>({id,title:'Default Title',sku,price,selectedOptions:[],product:{id:id+'-product',title:'Listed '+sku,status:'ACTIVE',isGiftCard:false},
        inventoryItem:{id:id+'-inventory',tracked:true,requiresShipping:true,inventoryLevels:{nodes:[],pageInfo:{hasNextPage:false}}}});
      return Response.json({data:{shop:{currencyCode:'USD'},productVariants:{nodes:[variant('gid://shopify/ProductVariant/1',code,listed.shopify.main),variant('gid://shopify/ProductVariant/2',giftCode,listed.shopify.gift)],pageInfo:{hasNextPage:false}}}});
    }
    if(url.hostname==='connect.squareupsandbox.com'){
      if(url.pathname==='/v2/locations')return Response.json({locations:[{id:'sq-dispatch',name:'Dispatch',status:'ACTIVE'}]});
      if(url.pathname==='/v2/catalog/list')return Response.json({objects:[{id:'sq-item',type:'ITEM',item_data:{name:'Parcel item'}},
        {id:'sq-main',type:'ITEM_VARIATION',version:1,item_variation_data:{item_id:'sq-item',name:'Regular',sku:code,price_money:{amount:listed.square.main,currency:'USD'},
          location_overrides:[{location_id:'sq-dispatch',price_money:{amount:listed.square.override,currency:'USD'}}]}},
        {id:'sq-gift',type:'ITEM_VARIATION',version:1,item_variation_data:{item_id:'sq-item',name:'Gift',sku:giftCode,price_money:{amount:listed.square.gift,currency:'USD'}}}]});
      if(url.pathname==='/v2/inventory/counts/batch-retrieve')return Response.json({counts:[]});
      writes.push('square '+method+' '+url.pathname);return Response.json({errors:[{detail:'No writes in this test'}]},{status:400});
    }
    throw new Error('Unexpected network call '+url);
  });
  const network=require('../../src/connections/providers/store-network');
  t.mock.method(network,'fetchStore',async(value,options={})=>{
    const url=new URL(value),method=String(options.method||'GET').toUpperCase();
    if(method!=='GET'){writes.push('woo '+method+' '+url.pathname);throw new Error('No writes in this test');}
    if(url.pathname.endsWith('/data/currencies/current'))return Response.json({code:'USD'});
    return Response.json([{id:41,name:'Parcel item',sku:code,type:'simple',price:listed.woo.main,status:'publish'}],{headers:{'x-wp-totalpages':'1'}});
  });
  // StockChief's own app keys are not configured in tests, and these stand-in
  // tokens never need renewal, so token renewal is left out. Discovery is real.
  const adapters={shopify:{...require('../../src/connections/providers/shopify'),refreshCredentials:undefined},woocommerce:require('../../src/connections/providers/woocommerce'),
    square:{...require('../../src/connections/providers/square'),refreshCredentials:undefined}};
  const registry={get:type=>adapters[type]||null,catalog:()=>[]};
  const connectors={};
  for(const [type,name,credentials] of [['shopify','Shopify store',{shop:'price-check.myshopify.com',accessToken:'test-shopify'}],
    ['square','Square till',{accessToken:'test-square',environment:'sandbox',merchantId:'merchant'}],
    ['woocommerce','Web shop',{storeUrl:'https://shop.example.test',consumerKey:'ck_'+'a'.repeat(40),consumerSecret:'cs_'+'b'.repeat(40)}]]){
    const id='con-'+type+'-'+randomUUID().slice(0,8);
    await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,
      expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
      VALUES($1,$2,$1,$3,$4,'[]','{}','connected','[]',$5,60,'CONNECTED',$6,$7,$3,now()::text,now()::text)`,[id,ws,name,type,'connection_credentials:'+id,ctx.actorId,type+'-account']);
    await db.transaction(tx=>require('../../src/connections/postgres-credential-store').put(tx,ws,id,'provider',credentials));
    connectors[type]=id;
  }
  const handlers=require('../../src/operations/postgres-runtime-handlers').create(registry);
  const sync=async type=>handlers['provider.catalog-sync']({id:'sync-'+randomUUID(),workspaceId:ws,payload:{connectorId:connectors[type]}},db);
  const worker=async()=>{
    const queued=await checks.schedule(db,ws);
    const job=(await db.query('SELECT payload FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1',[ws,checks.KIND])).rows[0];
    return {queued,result:await require('../../src/operations/postgres-runtime-handlers').create()[checks.KIND]({workspaceId:ws,payload:job?.payload||{}},db)};
  };
  const alerts=async(where='true')=>(await db.query(`SELECT * FROM stockchief_runtime.agent_channel_price_alerts WHERE workspace_id=$1 AND ${where}`,[ws])).rows.sort((a,b)=>a.label.localeCompare(b.label));
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('channel-price'));
  const pilot=async set=>{await db.query("INSERT INTO workspace_autopilot(workspace_id,mode,created_at,updated_at) VALUES($1,'SUPERVISED',now()::text,now()::text) ON CONFLICT(workspace_id) DO NOTHING",[ws]);
    await db.query(`UPDATE workspace_autopilot SET ${set} WHERE workspace_id=$1`,[ws]);};
  const priceRows=async()=>Number((await db.query('SELECT count(*) n FROM sku_prices WHERE workspace_id=$1',[ws])).rows[0].n);
  return {...f,ws,code,giftCode,gift,listed,writes,connectors,sync,worker,alerts,audits,needs,pilot,priceRows};
}

test('Recorded Shopify, Square and WooCommerce prices are checked against the catalogue, MAP terms and each other, and flags clear when prices match',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx,ws}=f;
  for(const type of ['shopify','square','woocommerce']){const done=await f.sync(type);assert.equal(done.autoMapped>=1,true,type+' maps the exact SKU codes');}
  const prices=await f.priceRows();
  await require('../../src/pricing/channel-price-review').save(db,ctx,{sku:f.code,minimum:'10.00',currency:'USD',revision:0});

  // The worker checks every recorded channel price on its own.
  const first=await f.worker();
  assert.deepEqual(first.queued,{queued:1});
  assert.equal(first.result.outcome,'CHECKED');assert.equal(first.result.checked,6);
  const open=await f.alerts("status='OPEN'");
  assert.deepEqual(open.map(a=>[a.label,a.kind,a.finding,Number(a.channel_minor),a.compared_minor==null?null:Number(a.compared_minor)]),[
    [f.code+' on Square till','MISMATCH','Recorded price differs from catalogue',1100,1200],
    [f.code+' on Square till at Dispatch','MISMATCH','Recorded price differs from catalogue',1300,1200],
    [f.code+' on Web shop','MAP_BREAK','Recorded price below MAP',900,1000],
    [f.giftCode+' on Shopify store','MISMATCH','Differs from other channels',500,600],
    [f.giftCode+' on Square till','MISMATCH','Differs from other channels',600,500]].sort((a,b)=>a[0].localeCompare(b[0])));
  assert.equal(await f.audits('StockChief checked channel prices'),1);
  let needs=await f.needs();
  assert(needs.some(n=>n.sourceId==='channel-price-map'&&n.importance==='Urgent'&&/1 channel price is below your minimum advertised price/.test(n.title)));
  assert(needs.some(n=>n.sourceId==='channel-price-mismatch'&&/4 channel prices differ/.test(n.title)));
  // The same recorded prices replay to the same check.
  const replay=await f.worker();
  assert.deepEqual(replay.queued,{queued:0});assert.equal(replay.result.replayed,true);
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_channel_price_runs WHERE workspace_id=$1',[ws])).rows[0].n,1);

  // The page shows every recorded price and its finding.
  const page=await f.browser.get(checks.href).expect(200);
  for(const text of ['Recorded price below MAP','Matches recorded catalogue price','Differs from other channels','Save supplier terms'])assert.match(page.text,new RegExp(text));

  // A person fixes the Square prices in Square; the next catalogue check records them and the flags clear.
  Object.assign(f.listed.square,{main:1200,override:1200,gift:500});
  await f.sync('square');
  const second=await f.worker();
  assert.equal(second.result.cleared.length,4);
  assert.deepEqual((await f.alerts("status='OPEN'")).map(a=>a.label),[f.code+' on Web shop']);
  assert.equal(await f.audits('StockChief checked channel prices'),2);

  // An old price is never compared as current, and never clears a flag.
  await db.query('UPDATE connection_external_records SET last_seen_at=$3 WHERE workspace_id=$1 AND connector_id=$2',[ws,f.connectors.woocommerce,new Date(Date.now()-2*86400000).toISOString()]);
  const third=await f.worker();
  assert.equal(third.result.review,1);assert.equal(third.result.cleared.length,0);
  assert.deepEqual((await f.alerts("status='OPEN'")).map(a=>a.label),[f.code+' on Web shop']);
  needs=await f.needs();
  assert(needs.some(n=>/1 channel price needs a fresh check/.test(n.title)&&/Refresh provider check/.test(n.happened)));
  // The next WooCommerce check records the corrected price and the MAP flag clears.
  f.listed.woo.main='12.00';await f.sync('woocommerce');
  const fourth=await f.worker();
  assert.equal(fourth.result.cleared.length,1);assert.equal((await f.alerts("status='OPEN'")).length,0);
  assert.deepEqual(await f.needs(),[]);

  // Prices are only checked: no channel or catalogue price was written.
  assert.deepEqual(f.writes,[]);
  assert.equal(await f.priceRows(),prices);
});

test('Starter is excluded; Growth, Pro and Custom check alone; pause holds; Watch only, Ask me first and shadow only watch',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx,ws}=f;
  for(const type of ['shopify','square','woocommerce'])await f.sync(type);

  await f.subscribe('starter');
  assert.deepEqual(await checks.schedule(db,ws),{queued:0});
  assert.deepEqual(await checks.run(db,ws),{skipped:'plan'});
  await assert.rejects(checks.checkNow(db,ctx),e=>e.code==='entitlement_required');
  await assert.rejects(require('../../src/autopilot/job-reviews').run(db,ctx,'channel-prices'),e=>e.code==='entitlement_required');
  assert.equal((await f.browser.get(checks.href)).status,402);
  assert.deepEqual(await checks.inbox(db,ws),[]);

  await f.subscribe('growth');
  await f.pilot('paused=1');
  assert.deepEqual(await checks.run(db,ws),{held:'paused'});
  await f.pilot('paused=0');
  await f.pilot("mode='OBSERVE'");
  const observed=await checks.run(db,ws);
  assert.equal(observed.outcome,'WATCHED');assert.match(observed.reason,/watch-only/);assert.equal(observed.flagged.length,5);
  await f.pilot("mode='SUPERVISED'");
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,87,{mode:'ask',revision:0});
  const asked=await checks.run(db,ws);
  assert.equal(asked.outcome,'WATCHED');assert.match(asked.reason,/Ask me first/);
  assert.equal((await f.alerts()).length,0,'Watching flags nothing');
  assert.deepEqual(await f.needs(),[]);
  // With Ask me first the owner checks from the page, and the flags open on the owner's say.
  const review=await f.browser.get(checks.href).expect(200);assert.match(review.text,/Check channel prices now/);
  await f.browser.post('/autopilot/channel-prices/check').type('form').send({_csrf:f.csrf(review.text)}).expect(303);
  assert.equal((await f.alerts("status='OPEN'")).length,5);
  assert.equal(await f.audits('Checked channel prices'),1);
  await modes.save(db,ctx,87,{mode:'watch',revision:1});
  await assert.rejects(checks.checkNow(db,ctx),/Watch only/);
  await modes.save(db,ctx,87,{mode:'inherit',revision:2});
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  const shadow=await checks.run(db,ws);
  assert.equal(shadow.outcome,'WATCHED');assert.match(shadow.reason,/first 14 days/);
  await assert.rejects(checks.checkNow(db,ctx),/first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);

  for(const plan of ['pro','enterprise']){
    await f.subscribe(plan);
    const result=await checks.run(db,ws);
    assert.equal(result.outcome,'CHECKED',plan);
    assert.equal((await f.alerts("status='OPEN'")).length,5);
  }
  // A paused channel's prices are not checked, and its flags stay until it is checked again.
  await db.query("UPDATE workspace_connectors SET paused_at=now()::text WHERE id=$1",[f.connectors.square]);
  const paused=await checks.run(db,ws);
  assert.equal(paused.cleared.length,0);assert.equal((await f.alerts("status='OPEN'")).length,5);
  assert.deepEqual(f.writes,[]);
});

test('The channel price review fits a phone and a desktop',{timeout:600000},async t=>{
  const f=await setup(t),{db,ws}=f;
  for(const type of ['shopify','square','woocommerce'])await f.sync(type);
  await checks.run(db,ws);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const http=app.listen(0,'127.0.0.1',()=>resolve(http));}),browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const [width,height,name] of [[390,844,'mobile'],[1600,1000,'desktop']]){
    const page=await browser.newPage({viewport:{width,height}});page.setDefaultTimeout(15000);
    await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(origin+checks.href);
    const text=await page.locator('main').innerText();
    assert.match(text,/Differs from other channels/);assert.match(text,/Recorded price differs from catalogue/);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' fits without sideways scrolling');
    require('node:fs').mkdirSync('output',{recursive:true});
    await page.screenshot({path:'output/channel-prices-'+name+'.png',fullPage:true,animations:'disabled'});
    await page.close();
  }
});
