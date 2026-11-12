'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 131: Starter does not include it. Growth, Pro and Custom set clear
// categories and tags on their own inside the owner's daily limit and leave
// unclear ones as suggestions. Every change is audited and can be undone.
test('new products get categories and tags from their supplier file and similar products on each plan',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe}=f,ws=ctx.workspaceId;
  const catalog=require('../../src/domain/postgres-catalog-service'),commerce=require('../../src/operations/postgres-commerce');
  const classes=require('../../src/catalog/agent-product-classification'),reviews=require('../../src/autopilot/job-reviews');
  const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
  const age=interval=>db.query(`UPDATE accounts SET created_at=(now()-interval '${interval}')::text WHERE id=$1`,[f.owner.accountId]);
  await age('30 days');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const product=async(code,name,{facts=null,category=null,old=false}={})=>{
    const made=await catalog.createItem(db,ctx,{name,baseCode:code,trackingMode:'quantity'});
    if(facts||category)await db.query(`INSERT INTO catalogue_item_facts(workspace_id,item_id,category,facts,created_at,updated_at) VALUES($1,$2,$3,$4,now(),now())`,
      [ws,made.itemId,category,JSON.stringify(facts||{})]);
    if(old)await db.query("UPDATE items SET created_at=(now()-interval '40 days')::text WHERE id=$1",[made.itemId]);
    return {item:made.itemId,sku:made.skuIds[0]};
  };
  const facts=async item=>(await db.query('SELECT category,facts::jsonb AS facts FROM catalogue_item_facts WHERE workspace_id=$1 AND item_id=$2',[ws,item])).rows[0]||null;
  const recordOf=async(item,kind,status=null)=>(await db.query(`SELECT * FROM stockchief_runtime.agent_product_classifications WHERE workspace_id=$1 AND item_id=$2 AND kind=$3
    AND ($4::text IS NULL OR status=$4) ORDER BY created_at DESC,id DESC LIMIT 1`,[ws,item,kind,status])).rows[0];
  const audits=action=>db.query('SELECT count(*)::int AS n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action]).then(r=>r.rows[0].n);
  const sweep=()=>classes.run({workspaceId:ws,payload:{}},db);
  const queued=key=>db.query('SELECT count(*)::int AS n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3',[ws,classes.kind,key]).then(r=>r.rows[0].n);
  const forget=()=>db.query("UPDATE stockchief_runtime.agent_product_classifications SET decided_at=decided_at-interval '2 days' WHERE workspace_id=$1 AND status='DONE'",[ws]);

  // Products that already have a category: two from one brand, three shirts
  // that disagree, and one bracket from the fixture supplier.
  await product('ACME-H','Acme hammer',{facts:{brand:'Acme',tags:['hand tools']},category:'Tools',old:true});
  await product('ACME-S','Acme saw',{facts:{brand:'Acme',tags:['hand tools','blades']},category:'Tools',old:true});
  await product('TEE','Cotton tee shirt',{category:'Apparel',old:true});
  await product('POLO','Cotton polo shirt',{category:'Apparel',old:true});
  await product('SHIRT-BOX','Cotton shirt box',{category:'Packaging',old:true});
  const bracket=await product('BRACKET','Widget bracket',{category:'Hardware',old:true});
  await commerce.linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:bracket.sku,supplierSku:'FS-BR'});

  // New products.
  const drill=await product('ACME-D','Acme drill',{facts:{brand:'Acme',material:'Steel'}});
  const dress=await product('DRESS','Cotton dress shirt');
  const clamp=await product('CLAMP','Widget clamp');
  await commerce.linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:clamp.sku,supplierSku:'FS-CL'});
  const lonely=await product('ZZ-1','Zyzzyva gadget');
  const imports=require('../../src/imports/postgres-service'),sourceFacts=require('../../src/domain/postgres-catalog-facts');
  const file=await imports.analyse(db,ctx,{text:'Name,SKU,Location,Qty\nCarton,CART-1,Dispatch,0',allowModel:false});
  await imports.approve(db,ctx,file.id,file.integrityHash);assert.ok((await imports.execute(db,ctx,file.id)).verified);
  const planter=await product('PLANT','Terracotta planter');
  await db.transaction(c=>sourceFacts.saveManyInTransaction(c,ctx,[{skuId:planter.sku,rowNumber:2,importId:file.id,name:'Product Type',value:'Garden'},
    {skuId:planter.sku,rowNumber:2,importId:file.id,name:'Tags',value:'outdoor, seasonal'}]));

  // Starter: the job is not included.
  await subscribe('starter');
  await assert.rejects(reviews.run(db,ctx,'product-categories',{}),e=>e.code==='entitlement_required');
  assert.match((await browser.get(classes.path).expect(200)).text,/data-agent-plan-locked/);
  await assert.rejects(classes.check(db,ctx),e=>e.code==='entitlement_required');
  assert.equal((await sweep()).skipped,true);
  assert.deepEqual(await classes.inbox(db,ws),[]);
  assert.equal(await queued('product-categories:import:'+file.id),0,'no routine on Starter');

  // Growth: clear ones are set on their own; unclear ones wait.
  await subscribe('growth');
  assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===131).allowed,['inherit','watch','ask','routine']);
  const live=await reviews.run(db,ctx,'product-categories',{});
  const line=code=>live.rows.find(r=>r.Code===code);
  assert.deepEqual([line('ACME-D')['Suggested category'],line('ACME-D')['Suggested tags']],['Tools','Acme, Steel, hand tools']);
  assert.match(line('ACME-D').Evidence,/2 categorized products with the same brand agree/);
  assert.deepEqual([line('DRESS')['Suggested category'],line('DRESS')['Possible categories']],[null,'Apparel, Packaging']);
  assert.match(line('CLAMP').Evidence,/Only one similar product has a category/);
  assert.equal(line('PLANT')['Suggested category'],'Garden');
  assert.equal(line('ZZ-1').Evidence,'More product evidence needed');
  const ask=require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review');
  assert.equal((await ask.prepare(null,db,ctx,'',{agentJob:'product-categories',search:'DRESS'})).rows[0]['Possible categories'],'Apparel, Packaging');

  const result=await sweep();
  assert.deepEqual([result.done,result.suggested],[4,2],JSON.stringify(result));
  assert.deepEqual(await facts(drill.item),{category:'Tools',facts:{brand:'Acme',material:'Steel',tags:['Acme','Steel','hand tools']}});
  assert.deepEqual(await facts(planter.item),{category:'Garden',facts:{tags:['outdoor','seasonal']}});
  const drillCat=await recordOf(drill.item,'CATEGORY');
  assert.deepEqual([drillCat.status,drillCat.automatic],['DONE',true]);
  const dressCat=await recordOf(dress.item,'CATEGORY');
  assert.deepEqual([dressCat.status,dressCat.details.options.map(o=>[o.category,o.count])],['SUGGESTED',[['Apparel',2],['Packaging',1]]]);
  assert.equal((await recordOf(clamp.item,'CATEGORY')).details.options[0].category,'Hardware');
  assert.equal(await recordOf(lonely.item,'CATEGORY'),undefined);
  assert.equal(await audits('Product category or tags set on their own'),4);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM catalogue_change_history WHERE workspace_id=$1 AND action IN ('agent_category','agent_tags')",[ws])).rows[0].n,4);
  const [needs]=await classes.inbox(db,ws);
  assert.match(needs.happened,/2 new products have a category or tags waiting for you/);
  assert.ok((await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).some(r=>r.href===classes.path));
  // A replay changes nothing more.
  await sweep();
  assert.equal(await audits('Product category or tags set on their own'),4);
  // The product page says what StockChief set, with Undo.
  assert.match((await browser.get('/inventory/'+planter.item).expect(200)).text,/data-class-note[\s\S]*Category set to Garden/);

  // A person picks a category, types one, or keeps the product as it is.
  await assert.rejects(classes.approve(db,ctx,dressCat.id,{confirmed:'yes',fingerprint:dressCat.fingerprint,choice:'9'}),/Choose one of the listed categories/);
  await assert.rejects(classes.approve(db,ctx,dressCat.id,{confirmed:'yes',fingerprint:'stale',choice:'0'}),/Review the current suggestion/);
  await assert.rejects(classes.approve(db,ctx,dressCat.id,{confirmed:'yes',fingerprint:dressCat.fingerprint,category:'x'.repeat(241)}),/up to 240 characters/);
  await classes.approve(db,ctx,dressCat.id,{confirmed:'yes',fingerprint:dressCat.fingerprint,choice:'0'});
  assert.equal((await facts(dress.item)).category,'Apparel');
  assert.deepEqual(await classes.approve(db,ctx,dressCat.id,{confirmed:'yes',fingerprint:dressCat.fingerprint,choice:'0'}),{replayed:true,id:dressCat.id});
  const clampCat=await recordOf(clamp.item,'CATEGORY');
  await classes.dismiss(db,ctx,clampCat.id,{confirmed:'yes'});
  await sweep();
  assert.equal((await recordOf(clamp.item,'CATEGORY')).status,'DISMISSED','a dismissed suggestion is not made again');
  assert.equal(await audits('Product category or tags approved'),1);

  // Undo: the category goes back; StockChief then waits for the owner.
  await classes.undo(db,ctx,drillCat.id,{confirmed:'yes'});
  assert.equal((await facts(drill.item)).category,null);
  assert.deepEqual(await classes.undo(db,ctx,drillCat.id,{confirmed:'yes'}),{replayed:true});
  await sweep();
  const again=await recordOf(drill.item,'CATEGORY','SUGGESTED');
  assert.deepEqual([again.would_apply,/You undid this before/.test(again.reason)],[true,true]);
  // The bulk list approves the ticked suggestions through the page.
  const page=await browser.get(classes.path).expect(200);
  for(const marker of ['data-class-bulk','data-class-waiting','data-class-done','data-class-limit'])assert.ok(page.text.includes(marker),marker);
  const pick=[...page.text.matchAll(/name="pick" value="([^"]+)"/g)].map(m=>m[1]).filter(v=>v.startsWith(again.id+':'));
  assert.equal(pick.length,1);
  await browser.post(classes.path+'/approve').type('form').send({_csrf:f.csrf(page.text),confirmed:'yes',pick}).expect(303);
  assert.equal((await facts(drill.item)).category,'Tools');
  // Undo from the product page goes back to the product.
  const tags=await recordOf(planter.item,'TAGS','DONE'),productPage=await browser.get('/inventory/'+planter.item).expect(200);
  assert.equal((await browser.post(classes.path+'/'+tags.id+'/undo').type('form').send({_csrf:f.csrf(productPage.text),confirmed:'yes',back:'product'}).expect(303)).headers.location,'/inventory/'+planter.item);
  assert.deepEqual((await facts(planter.item)).facts,{tags:[]});
  assert.equal(await audits('Product category or tags undone'),2);

  // The owner's daily limit, and asking every time.
  await forget();
  await classes.configure(db,ctx,{revision:0,confirmed:'yes',dailyLimit:'1'});
  const nail=await product('ACME-N','Acme nail gun',{facts:{brand:'Acme'}}),file2=await product('ACME-F','Acme file',{facts:{brand:'Acme'}});
  await sweep();
  const limited=[await recordOf(nail.item,'CATEGORY'),await recordOf(file2.item,'CATEGORY')];
  assert.deepEqual(limited.map(r=>r.status).sort(),['DONE','SUGGESTED']);
  assert.match(limited.find(r=>r.status==='SUGGESTED').reason,/over your limit of 1 changes a day/);
  await assert.rejects(classes.configure(db,ctx,{revision:0,confirmed:'yes',dailyLimit:'2'}),/Reload the page/);
  await assert.rejects(classes.configure(db,ctx,{revision:1,confirmed:'yes',dailyLimit:'0'}),/from 1 to 5,000/);
  await classes.configure(db,ctx,{revision:1,stop:'yes'});
  await forget();await sweep();
  const over=limited.find(r=>r.status==='SUGGESTED').item_id;
  assert.match((await recordOf(over,'CATEGORY','SUGGESTED')).reason,/approve every category and tag yourself/);
  await classes.configure(db,ctx,{revision:2,confirmed:'yes',dailyLimit:'100'});

  // Pause, shadow, Ask me first and Watch only keep clear ones waiting.
  const level=await product('ACME-L','Acme level',{facts:{brand:'Acme'}});
  await autopilot.pause(db,ctx,{role:'owner'},'checking');
  await sweep();
  assert.match((await recordOf(level.item,'CATEGORY')).reason,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});
  await age('1 day');
  await sweep();
  const shadow=await recordOf(level.item,'CATEGORY');
  assert.match(shadow.reason,/watching during the first 14 days/);
  await assert.rejects(classes.approve(db,ctx,shadow.id,{confirmed:'yes',fingerprint:shadow.fingerprint}),/watching during the first 14 days/);
  await age('30 days');
  await modes.save(db,ctx,131,{mode:'ask',revision:0});
  await sweep();
  assert.match((await recordOf(level.item,'CATEGORY')).reason,/Ask me first/);
  await modes.save(db,ctx,131,{mode:'watch',revision:1});
  await sweep();
  assert.match((await recordOf(level.item,'CATEGORY')).reason,/Watch only/);
  await modes.save(db,ctx,131,{mode:'inherit',revision:2});
  assert.equal((await facts(level.item)).category,null);
  await sweep();
  assert.equal((await facts(level.item)).category,'Tools');

  // An archived product is not changed; its suggestion closes.
  const archived=await product('ACME-X','Acme chisel',{facts:{brand:'Acme'}});
  await classes.configure(db,ctx,{revision:3,stop:'yes'});
  await sweep();
  const held=await recordOf(archived.item,'CATEGORY','SUGGESTED');
  await db.query('UPDATE items SET is_active=0 WHERE id=$1',[archived.item]);
  await assert.rejects(classes.approve(db,ctx,held.id,{confirmed:'yes',fingerprint:held.fingerprint}),/archived/);
  await sweep();
  assert.equal((await recordOf(archived.item,'CATEGORY')).status,'DISMISSED');
  await classes.configure(db,ctx,{revision:4,confirmed:'yes',dailyLimit:'100'});

  // Pro and Custom act alone without teaching.
  for(const tier of ['pro','enterprise']){
    await subscribe(tier);
    const made=await product('ACME-'+tier,'Acme '+tier+' wrench',{facts:{brand:'Acme'}});
    await sweep();
    const r=await recordOf(made.item,'CATEGORY');
    assert.deepEqual([r.status,r.automatic,(await facts(made.item)).category],['DONE',true,'Tools'],tier);
  }

  // The routine runs after a person adds a product, after an import and once a day.
  const form=await browser.get('/inventory/new').expect(200);
  const added=await browser.post('/inventory').type('form').send({_csrf:f.csrf(form.text),name:'Acme tape measure',baseCode:'ACME-T',trackingMode:'quantity',unitLabel:'each'}).expect(303);
  const addedId=added.headers.location.split('/').pop();
  assert.equal(await queued('product-categories:item:'+addedId),1);
  const work=await queue.processOne(db,handlers,{owner:'product-categories-worker',kinds:[classes.kind]});
  assert.equal(work.status,'COMPLETED',JSON.stringify(work.lastError));
  const file3=await imports.analyse(db,ctx,{text:'Name,SKU,Location,Qty\nCrate,CRATE-1,Dispatch,0',allowModel:false});
  await imports.approve(db,ctx,file3.id,file3.integrityHash);await imports.execute(db,ctx,file3.id);
  assert.equal(await queued('product-categories:import:'+file3.id),1);
  assert.equal((await classes.schedule(db,ws,'cycle-1')).queued,true);
  assert.equal((await classes.schedule(db,ws,'cycle-2')).queued,false);
  assert.match((await browser.get('/autopilot/reviews/product-categories').expect(200)).text,/Open categories and tags/);
  await assert.rejects(classes.page(db,{...ctx,actorId:'not-the-owner'}),/owner/);

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const view=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});view.setDefaultTimeout(15000);
    await view.goto(base+'/login');await view.getByLabel('Work email').fill(f.email);await view.locator('[name=password]').fill(f.password);
    await Promise.all([view.waitForNavigation(),view.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await view.goto(base+classes.path);
    assert(await view.getByRole('heading',{name:'Categories and tags',exact:true}).isVisible());
    assert(await view.getByRole('heading',{name:'Changes it makes on its own'}).isVisible());
    assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await view.screenshot({path:require('node:path').join(folder,'product-categories-'+name+'.png'),fullPage:true});
    await view.goto(base+'/inventory/'+drill.item);
    assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' product page must not scroll sideways');
    await view.close();
  }
});
