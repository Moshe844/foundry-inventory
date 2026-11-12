'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const orders=require('../../src/purchasing/agent-container-orders'),autopilot=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');
const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
const DAY=86400000;

// One supplier, one warehouse and products with real demand:
// A sells about 0.28 a day and is below its reorder point; B sells 0.5 a day
// and is well stocked (a top-up candidate); C is below its reorder point.
async function setup(t,plan,{withC=true,limits=null}={}){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx}=f,origin=process.env.FOUNDRY_PUBLIC_URL;
 process.env.FOUNDRY_PUBLIC_URL='https://stockchief.example.test';t.after(()=>{if(origin===undefined)delete process.env.FOUNDRY_PUBLIC_URL;else process.env.FOUNDRY_PUBLIC_URL=origin;});
 await f.subscribe(plan);await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 if(limits)await db.query("UPDATE commercial_plan_versions SET configuration=jsonb_set(configuration,'{agentPurchaseLimits}',$1::jsonb) WHERE plan_id='enterprise' AND status='ACTIVE'",[JSON.stringify(limits)]);
 await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 await db.query("UPDATE suppliers SET email='container-supplier@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
 const connector=randomUUID();
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
  VALUES($1,$2,$1,'Purchasing mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'purchasing-mailbox',now(),now())`,[connector,ctx.workspaceId,'connection_credentials:'+connector,ctx.actorId]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',{accessToken:'synthetic-token'}));
 const catalog=require('../../src/domain/postgres-catalog-service'),engine=require('../../src/domain/postgres-inventory-engine'),commerce=require('../../src/operations/postgres-commerce');
 async function product(code,{dims=true,size,grams,stock,issued=[],pack=1,moq=1,multiple=1,price,reorder=null,target=null}){
  const item=await catalog.createItem(db,ctx,{name:'Container '+code,baseCode:code+'-'+randomUUID().slice(0,6),trackingMode:'quantity',startingQuantity:String(stock),startingLocationId:f.location.id,startingCost:'1.00',
   ...(dims?{lengthMm:String(size[0]),widthMm:String(size[1]),heightMm:String(size[2]),weightGrams:String(grams)}:{})});
  const skuId=item.skuIds[0];
  await commerce.linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId,lastUnitCost:price,purchaseUnit:pack>1?'case':'piece',unitsPerPurchaseUnit:pack,minimumOrderQuantity:moq,orderMultiple:multiple});
  for(const [i,q] of issued.entries())await engine.issue(db,ctx,{skuId,locationId:f.location.id,quantity:q,occurredAt:new Date(Date.now()-(10+i*7)*DAY).toISOString(),idempotencyKey:randomUUID()});
  if(reorder!=null)await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,0,'manual',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId,skuId,f.location.id,reorder,target]);
  return {skuId,itemId:item.itemId,code:(await db.query('SELECT code FROM skus WHERE id=$1',[skuId])).rows[0].code};
 }
 const A=await product('CRATE',{size:[500,400,300],grams:10000,stock:30,issued:[5,5,5,5,5],moq:10,multiple:5,price:'1.00',reorder:10,target:50});
 const B=await product('BOX',{size:[300,300,300],grams:2000,stock:100,issued:[15,15,15],pack:10,moq:2,price:'0.50'});
 const C=withC?await product('LAMP',{dims:false,stock:2,price:'2.00',reorder:5,target:10}):null;
 const input={supplierId:'fixture-supplier',destinationId:f.location.id,feet:'20',lengthMm:'4000',widthMm:'1000',heightMm:'1000',payloadKg:'1000',fillPercent:'90',minimumFillPercent:'10',coverDays:'180',maximumValue:'500.00',routine:'yes',confirmed:'yes'};
 const rule=async(extra={})=>orders.save(db,ctx,{...input,...extra});
 // The routine runs through the worker queue. The autopilot check queues a due rule once per hour; tests queue each run directly.
 const run=async(id)=>{const ruleId=id||(await db.query('SELECT id FROM stockchief_runtime.agent_container_order_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].id;await jobs.enqueue(db,{workspaceId:ctx.workspaceId,kind:orders.kind,idempotencyKey:randomUUID(),payload:{ruleId}});const done=await jobs.processOne(db,{[orders.kind]:handlers[orders.kind]},{owner:'container-order-worker'});assert(done,'A routine job was queued');assert.equal(done.status,'COMPLETED',JSON.stringify(done.lastError));return done.result;};
 const due=id=>db.query(`UPDATE stockchief_runtime.agent_container_order_rules SET next_check_at=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
 const pos=async()=>(await db.query('SELECT count(*)::int n FROM purchase_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 const linesOf=async id=>(await db.query('SELECT l.sku_id,l.quantity_units::int q,l.quantity_purchase_units::int packs,l.unit_cost::text cost FROM purchase_order_lines l WHERE l.purchase_order_id=$1 ORDER BY l.line_number',[id])).rows;
 const history=async id=>(await db.query('SELECT id,status,reason,automatic,purchase_order_id,effect_id FROM stockchief_runtime.agent_container_orders WHERE workspace_id=$1 AND rule_id=$2 ORDER BY created_at,id',[ctx.workspaceId,id])).rows;
 const audits=async()=>(await db.query('SELECT action FROM security_event_history WHERE workspace_id=$1',[ctx.workspaceId])).rows.map(r=>r.action);
 return {...f,A,B,C,input,rule,run,due,pos,linesOf,history,audits,connector};
}

test('the planner fills by space and by weight, keeps supplier minimums and packs, and tops up the next most-needed product',()=>{
 const r={id:'r',revision:1,supplier_id:'s',destination_id:'d',currency:'USD',container:{feet:'40',length:10000,width:2000,height:2000,payload:1000000},fill_percent:90,minimum_fill_percent:50,cover_days:100,maximum_minor:100000};
 const p=(code,extra)=>({skuId:code,itemId:code,code,name:code,unit:'unit',purchaseUnit:'case',unitsPer:10,moq:5,mult:5,minPacks:5,unitCostMinor:100,measure:{kind:'product',unitMm3:1000000,unitGrams:5000},rate:1,projected:0,need:0,q:0,...extra});
 // Heavy goods: the weight limit binds long before the space does.
 const heavy=orders.calculate(r,{supplier:{name:'S'},place:{name:'D'},products:[p('HEAVY',{need:300})]});
 assert.equal(heavy.lines[0].quantity,200);assert.equal(heavy.weightPercent,100);assert(heavy.volumePercent<1);
 assert.deepEqual(heavy.left.map(l=>[l.code,l.units]),[['HEAVY',100]]);
 // A small need still orders the supplier minimum (5 cases of 10), then tops up by whole order steps up to the cover limit.
 const small=orders.calculate(r,{supplier:{name:'S'},place:{name:'D'},products:[p('SMALL',{need:3,rate:1,projected:0})]});
 assert.equal(small.lines[0].quantity,100);assert.equal(small.lines[0].purchaseUnits,10);
 // Cartons: space is counted in whole cartons.
 const carton=orders.calculate({...r,cover_days:1},{supplier:{name:'S'},place:{name:'D'},products:[p('CARTON',{need:13,unitsPer:1,moq:1,mult:1,minPacks:1,measure:{kind:'carton',unitsPerCarton:12,cartonMm3:12000000,cartonGrams:60000}})]});
 assert.equal(carton.lines[0].quantity,13);assert.equal(carton.lines[0].cartons,2);assert.equal(carton.usedMm3,24000000);
 // Two products: the one with fewer days of stock is topped up first.
 const two=orders.calculate({...r,cover_days:30},{supplier:{name:'S'},place:{name:'D'},products:[p('LOW',{projected:5,unitsPer:1,moq:1,mult:1,minPacks:1}),p('HIGH',{projected:25,unitsPer:1,moq:1,mult:1,minPacks:1})]});
 assert.deepEqual(two.lines.map(l=>[l.code,l.quantity,l.why]),[['HIGH',5,'top-up'],['LOW',25,'top-up']]);
 // A missing size or price stops the plan instead of guessing.
 const missing=orders.calculate(r,{supplier:{name:'S'},place:{name:'D'},products:[p('NOSIZE',{need:5,measure:null}),p('NOPRICE',{rate:1,unitCostMinor:null})]});
 assert.deepEqual(missing.missing.map(m=>[m.code,m.missing.join()]),[['NOSIZE','size and weight'],['NOPRICE','supplier price']]);assert.equal(missing.lines.length,0);
});

test('Starter and Growth are locked; the page shows the plan lock and the routine holds after a downgrade',{timeout:300000},async t=>{
 const f=await setup(t,'enterprise',{withC:false}),{db,ctx}=f,saved=await f.rule();
 for(const tier of ['starter','growth']){
  await f.subscribe(tier);
  await assert.rejects(f.rule({supplierId:'fixture-supplier'}),/Pro|Custom|plan/);
  await assert.rejects(orders.prepare(db,ctx,saved.id,{confirmed:'yes',fingerprint:'x'}),/Pro|Custom|plan/);
  const page=await f.browser.get('/autopilot/container-orders').expect(200);assert.match(page.text,/Pro or Custom required/);assert.doesNotMatch(page.text,/Save container rule/);
  const before=await f.pos();await f.due(saved.id);assert.equal((await orders.onRule(db,ctx.workspaceId,saved.id)).held,true);assert.equal(await f.pos(),before);
 }
});

test('Pro stops for missing sizes, drafts until taught, then orders on its own within its limits; undo before sending cancels the PO and the email',{timeout:420000},async t=>{
 const f=await setup(t,'pro'),{db,ctx,A,B,C}=f,saved=await f.rule();
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_container_order_rules WHERE workspace_id=$1 AND enabled',[ctx.workspaceId])).rows[0].n,1,'One saved rule');
 // C has no size or weight: the routine stops and asks; no PO is made.
 assert.equal((await orders.schedule(db,ctx.workspaceId)).queued,1);await orders.schedule(db,ctx.workspaceId);
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2',[ctx.workspaceId,orders.kind])).rows[0].n,1,'A replayed check queues the rule once');
 const queued=await jobs.processOne(db,{[orders.kind]:handlers[orders.kind]},{owner:'container-order-worker'});assert.equal(queued.status,'COMPLETED');
 assert.equal((await orders.schedule(db,ctx.workspaceId)).queued,0,'Checked again in an hour');
 const before=await f.pos();let result=await f.run();
 assert.equal(result.held,true);assert.match(result.reason,new RegExp(C.code));assert.match(result.reason,/size and weight/);assert.equal(await f.pos(),before);
 assert.equal((await f.history(saved.id))[0].status,'NEEDS_FACTS');
 let needs=(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).filter(n=>n.sourceId==='container-order:'+saved.id);
 assert.equal(needs.length,1);assert.match(needs[0].why,new RegExp(C.code));
 await db.query("UPDATE skus SET length_mm=100,width_mm=100,height_mm=100,weight_grams=500 WHERE id=$1",[C.skuId]);
 // Untaught Pro drafts the container order for approval.
 await f.due(saved.id);result=await f.run();
 assert.equal(result.status,'DRAFTED');assert.match(result.reason,/teach/);
 const draft=(await db.query('SELECT status FROM purchase_orders WHERE id=$1',[result.purchaseOrderId])).rows[0];assert.equal(draft.status,'DRAFT');
 // Needed first (A below its reorder point: 45 to reach 50, C: 8 to reach 10), then the top-up B in whole cases above the 2-case minimum.
 assert.deepEqual((await f.linesOf(result.purchaseOrderId)).map(l=>[l.sku_id,l.q,l.packs]),[[A.skuId,45,45],[C.skuId,8,8],[B.skuId,30,3]]);
 const [order]=(await f.history(saved.id)).filter(o=>o.status==='DRAFTED'),plan=(await db.query('SELECT plan FROM stockchief_runtime.agent_container_orders WHERE id=$1',[order.id])).rows[0].plan;
 assert.equal(plan.volumePercent,88);assert.equal(plan.weightPercent,51.4);assert.equal(plan.valueMinor,7600);
 // Replaying while the draft waits adds nothing.
 await f.due(saved.id);assert(( await f.run()).waiting);assert.equal(await f.pos(),before+1);
 // The owner approves the drafted order and teaches from it.
 await assert.rejects(orders.teach(db,ctx,order.id,{confirmed:'yes'}),/approved yourself/);
 await f.workflows.approvePurchaseOrder(db,ctx,result.purchaseOrderId,{idempotencyKey:randomUUID()});
 await orders.teach(db,ctx,order.id,{confirmed:'yes'});
 // New demand: A's reorder point rises. Now StockChief orders on its own, approves within the limits and queues the email.
 await db.query('UPDATE reorder_policies SET reorder_point=60,target_stock=100 WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,A.skuId]);
 await f.due(saved.id);result=await f.run();
 assert.equal(result.status,'SENT',JSON.stringify(result));
 assert.equal((await db.query('SELECT status FROM purchase_orders WHERE id=$1',[result.purchaseOrderId])).rows[0].status,'APPROVED');
 // A's approved order already brings it to 50, so it needs 50 more to reach 100. B and C are well stocked now.
 assert.deepEqual((await f.linesOf(result.purchaseOrderId)).map(l=>[l.sku_id,l.q]),[[A.skuId,50]]);
 const mail=(await db.query("SELECT m.status,e.status effect FROM supplier_communications m JOIN stockchief_runtime.provider_effects e ON e.aggregate_id=m.id WHERE m.workspace_id=$1 AND m.purchase_order_id=$2",[ctx.workspaceId,result.purchaseOrderId])).rows[0];
 assert.deepEqual(mail,{status:'QUEUED',effect:'PENDING'});
 assert.equal((await db.query("SELECT count(*)::int n FROM work_items WHERE workspace_id=$1 AND purchase_order_id=$2 AND approval_requirement='NONE'",[ctx.workspaceId,result.purchaseOrderId])).rows[0].n,1,'Counts against the weekly automatic limit');
 const sent=(await f.history(saved.id)).find(o=>o.status==='SENT');
 // Undo before the email goes out: the PO and the email are cancelled. Replays change nothing.
 await orders.undo(db,ctx,sent.id,{confirmed:'yes'});assert.equal((await orders.undo(db,ctx,sent.id,{confirmed:'yes'})).replayed,true);
 assert.equal((await db.query('SELECT status FROM purchase_orders WHERE id=$1',[result.purchaseOrderId])).rows[0].status,'CANCELLED');
 assert.deepEqual((await db.query("SELECT m.status,e.status effect FROM supplier_communications m JOIN stockchief_runtime.provider_effects e ON e.aggregate_id=m.id WHERE m.purchase_order_id=$1",[result.purchaseOrderId])).rows[0],{status:'CANCELLED',effect:'CANCELLED'});
 // The undone order is not placed again for the same facts.
 const afterUndo=await f.pos();await f.due(saved.id);result=await f.run();assert.equal(result.replayed,true);assert.equal(await f.pos(),afterUndo);
 const actions=await f.audits();for(const a of ['Container order rule saved','Container order drafted for approval','Container ordering taught from an approved example','Container order placed and queued to the supplier','Container order undone before sending'])assert(actions.includes(a),a);
 // An email already being sent cannot be undone.
 await db.query('UPDATE reorder_policies SET reorder_point=70,target_stock=110 WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,A.skuId]);
 await f.due(saved.id);result=await f.run();assert.equal(result.status,'SENT');
 const second=(await f.history(saved.id)).find(o=>o.purchase_order_id===result.purchaseOrderId);
 await db.query("UPDATE stockchief_runtime.provider_effects SET status='SUCCEEDED' WHERE id=$1",[second.effect_id]);await db.query("UPDATE supplier_communications SET status='SENT' WHERE purchase_order_id=$1",[result.purchaseOrderId]);
 await assert.rejects(orders.undo(db,ctx,second.id,{confirmed:'yes'}),/already gone out/);
});

test('Custom orders on its own without teaching inside agreed limits; pause, Watch only, shadow and Ask me first stop or ask; weekly and rule limits ask',{timeout:420000},async t=>{
 const f=await setup(t,'enterprise',{withC:false,limits:{currency:'USD',perOrder:1000,perWeek:100}}),{db,ctx,A,B}=f,saved=await f.rule({maximumValue:'400.00'}),before=await f.pos();
 // Pause, Watch only and shadow: it records what it would have ordered and places nothing.
 await db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1',[ctx.workspaceId]);
 let result=await orders.onRule(db,ctx.workspaceId,saved.id);assert.equal(result.held,true);assert.match(result.reason,/paused/);
 await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1',[ctx.workspaceId]);
 await modes.save(db,ctx,38,{mode:'watch',revision:0});result=await orders.onRule(db,ctx.workspaceId,saved.id);assert.equal(result.watched,true);assert.match(result.reason,/Watch only/);
 await modes.save(db,ctx,38,{mode:'inherit',revision:1});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);result=await orders.onRule(db,ctx.workspaceId,saved.id);assert.equal(result.watched,true);assert.match(result.reason,/14 days/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 assert.equal(await f.pos(),before);assert.deepEqual((await f.history(saved.id)).map(o=>o.status),['WATCHED']);
 // Ask me first: the exact order is drafted for approval.
 await modes.save(db,ctx,38,{mode:'ask',revision:2});result=await orders.onRule(db,ctx.workspaceId,saved.id);
 assert.equal(result.status,'DRAFTED');assert.match(result.reason,/Ask me first/);
 await f.workflows.cancelPurchaseOrder(db,ctx,result.purchaseOrderId,{idempotencyKey:randomUUID(),reason:'Owner decided to wait'});
 await modes.save(db,ctx,38,{mode:'routine',revision:3});
 // No teaching on Custom. Two workers at once place one order.
 const raised=await f.rule({id:saved.id,revision:(await orders.rule(db,ctx,saved.id)).revision,maximumValue:'500.00'});
 const both=await Promise.all([orders.onRule(db,ctx.workspaceId,raised.id),orders.onRule(db,ctx.workspaceId,raised.id)]);
 const placed=both.find(r=>r.status==='SENT');assert(placed,JSON.stringify(both));assert.equal(both.filter(r=>r.status==='SENT').length,1);
 assert.deepEqual((await f.linesOf(placed.purchaseOrderId)).map(l=>[l.sku_id,l.q]),[[A.skuId,45],[B.skuId,30]]);
 assert.equal((await db.query('SELECT status FROM purchase_orders WHERE id=$1',[placed.purchaseOrderId])).rows[0].status,'APPROVED');
 // The next order would pass the agreed $100 a week: it waits for a person.
 await db.query('UPDATE reorder_policies SET reorder_point=60,target_stock=100 WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,A.skuId]);
 result=await orders.onRule(db,ctx.workspaceId,saved.id);assert.equal(result.status,'DRAFTED');assert.match(result.reason,/weekly automatic purchasing limit/);
 await f.workflows.cancelPurchaseOrder(db,ctx,result.purchaseOrderId,{idempotencyKey:randomUUID(),reason:'Over the week'});
 // Over the owner's own container limit: it asks.
 await f.rule({id:saved.id,revision:(await orders.rule(db,ctx,saved.id)).revision,maximumValue:'20.00'});
 result=await orders.onRule(db,ctx.workspaceId,saved.id);assert.equal(result.status,'DRAFTED');assert.match(result.reason,/over your container order limit/);
 // Every automatic order shows in the daily work digest.
 const digest=(await require('../../src/autopilot/agent-work-digest').report(db,ctx)).rows.filter(r=>r.link==='/autopilot/container-orders/'+saved.id);
 assert(digest.some(r=>/placed and queued/.test(r.Action)));assert(digest.some(r=>/drafted for approval/.test(r.Action)));
});

test('container order pages render at desktop width and on a phone',{timeout:300000},async t=>{
 const f=await setup(t,'pro'),{db,ctx}=f,saved=await f.rule();
 await db.query("UPDATE skus SET length_mm=100,width_mm=100,height_mm=100,weight_grams=500 WHERE id=$1",[f.C.skuId]);
 await f.due(saved.id);const drafted=await f.run();assert.equal(drafted.status,'DRAFTED');
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  const page=await browser.newPage({viewport,isMobile:viewport.width<500,hasTouch:viewport.width<500}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/login');await page.getByLabel('Work email',{exact:true}).fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  for(const path of ['/autopilot/container-orders','/autopilot/container-orders/'+saved.id]){
   const response=await page.goto(origin+path);assert.equal(response.status(),200,path);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scroll on '+path+' at '+viewport.width);
   require('node:fs').mkdirSync('output',{recursive:true});await page.screenshot({path:'output/container-orders-'+(path.endsWith(saved.id)?'rule':'index')+'-'+viewport.width+'.png',fullPage:true});
  }
  const text=await page.locator('main').innerText();
  assert.match(text,/Space used/);assert.match(text,/Weight used/);assert.match(text,/Needed now/);assert.match(text,/Top-up/);assert.match(text,/Drafted for approval/);
  assert.deepEqual(errors,[]);await page.close();
 }
 // The owner can save a new rule from the page.
 const page=await f.browser.get('/autopilot/container-orders').expect(200);assert.match(page.text,/New container rule/);
});
