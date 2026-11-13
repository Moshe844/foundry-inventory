'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 202 is excluded on Starter and alone on Growth, Pro and Custom. While
// the owner is away, every approval that would wait for them goes to their
// deputy when the deputy may approve it themselves: purchases, transfers,
// returns, stock changes and the rest of the approval desk, a group of similar
// ones in one tap, and a second signature unless the deputy gave the first.
// Owner-only approvals stay with the owner. In the first 14 days, Watch only
// and pause nothing is delegated. When the owner is back, everything still
// waiting is theirs again and Needs you hands back what happened.
test('a vacation deputy covers every approval they may make, never signs twice, and hands back on return',{timeout:900000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:40}),{db,ctx,workflows,browser,subscribe}=f,ws=ctx.workspaceId;
 const P=require('../../src/actions/permissions'),auth=require('../../src/domain/postgres-auth-service'),assistant=require('../../src/assistant/postgres-service');
 const vacation=require('../../src/autopilot/vacation-deputy'),desk=require('../../src/autopilot/approval-desk'),groups=require('../../src/autopilot/approval-groups');
 const projection=require('../../src/projections/postgres-service'),auto=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');
 const time=require('../../src/lib/business-time'),addDays=require('../../src/accounting/customer-money').addDays;
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 async function member(name,grant,limit=null){
  const account=await auth.createBusiness(db,{name,businessName:name+' elsewhere',email:randomUUID()+'@example.test',password:f.password});
  const id='member-'+randomUUID();
  await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,po_approval_limit_minor,po_approval_currency,created_at)
   VALUES($1,$2,$3,$4,'staff',$5,$6,$7,now()::text)`,[id,ws,account.accountId,name,P.encodeGrant(grant),limit,limit==null?null:'USD']);
  return {workspaceId:ws,actorId:id,accountId:account.accountId,name};
 }
 const deputy=await member('Deputy',[P.VIEW,P.VIEW_PURCHASING,P.APPROVE_PO,P.VIEW_TRANSFERS,P.APPROVE_TRANSFER,P.ADJUST,P.AUTHORIZE_SUPPLIER_RETURN],5000);
 const viewer=await member('Viewer',[P.VIEW]);
 const owner={...ctx};
 // One waiting approval of each kind, in the business's own records.
 const buy=cost=>workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:2,unitCost:cost}]});
 const small=await buy(10),large=await buy(50);
 const annex=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Annex',kind:'warehouse'});
 const transfers=require('../../src/transfers/postgres-transfer-service');
 const move=await transfers.request(db,ctx,{fromLocationId:f.location.id,toLocationId:annex.id,reason:'Balance stock',idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:1}]});
 const rtv=await require('../../src/operations/postgres-returns').requestSupplierReturn(db,ctx,{supplierId:'fixture-supplier',reason:'Damaged',idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1}]});
 const prepare=async request=>{const r=await assistant.prepareAction(db,ctx,'Prepare this change',request);assert.equal(r.status,'PREPARED',JSON.stringify(r));return r.proposal.id;};
 const shelfA=await prepare({action:'adjust',sku:'Parcel item',location:'Dispatch',countedQuantity:39,reason:'Shelf count'});
 const shelfB=await prepare({action:'adjust',sku:'Parcel item',location:'Dispatch',countedQuantity:38,reason:'Shelf count'});
 const cost=await prepare({action:'set_purchase_cost',sku:'Parcel item',amount:'1.25',currency:'USD'});
 const K={small:'purchase:'+small.purchaseOrderId,large:'purchase:'+large.purchaseOrderId,move:'transfer:'+move.id,rtv:'supplier_return:'+rtv.supplierReturnId,
  shelfA:'proposal:'+shelfA,shelfB:'proposal:'+shelfB,cost:'proposal:'+cost};
 const covered=[K.small,K.move,K.rtv,K.shelfA,K.shelfB].sort(),kept=[K.large,K.cost].sort();
 const items=async actor=>(await projection.needs(db,ws,actor.actorId)).filter(r=>r.approvalRequest);
 const routed=async actor=>(await items(actor)).map(r=>r.approvalRequest.key).sort();
 const audits=async action=>Number((await db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
 const today=await time.today(db,ws),path=vacation.path;
 let revision=0;
 const save=async(input,as=ctx)=>{await vacation.save(db,as,{revision,...input});revision=(await db.query('SELECT revision FROM stockchief_runtime.vacation_deputies WHERE workspace_id=$1',[ws])).rows[0].revision;};
 const away={deputyId:deputy.actorId,start:today,end:addDays(today,3)};

 // Starter: excluded, with the plan lock.
 await subscribe('starter');
 assert.match((await browser.get(path).expect(402)).text,/Growth/);
 await assert.rejects(vacation.save(db,ctx,{...away,revision:0}),e=>e.code==='entitlement_required');

 // Growth: before the vacation every approval is the owner's (job 176 is not on Growth).
 await subscribe('growth');
 assert.deepEqual(await routed(deputy),[]);assert.deepEqual(await routed(owner),[...covered,...kept].sort());
 const page=await browser.get(path).expect(200);assert.match(page.text,/Deputy/);assert.doesNotMatch(page.text,/>Viewer</,'Someone who cannot approve anything is not offered.');
 await assert.rejects(vacation.save(db,deputy,{...away,revision:0}),/owner/);
 await assert.rejects(vacation.save(db,ctx,{...away,deputyId:viewer.actorId,revision:0}),/current team member/);
 await browser.post('/autopilot/vacation-deputy').type('form').send({_csrf:f.csrf(page.text),revision:0,...away}).expect(303);revision=1;
 assert.equal(await audits('Scheduled vacation coverage'),1);
 // Away: everything the deputy may approve is theirs; the $100 order is over their $50 limit and
 // supplier price changes need someone who can administer the inventory.
 assert.deepEqual(await routed(deputy),covered);assert.deepEqual(await routed(owner),kept);
 const shown=(await items(deputy)).find(r=>r.approvalRequest.key===K.rtv);
 assert.equal(shown.sourceId,'vacation-'+rtv.supplierReturnId);assert.match(shown.happened,new RegExp('Owner is away until '+away.end+'\\. You cover the approvals you are allowed to make'));
 assert.equal((await items(deputy)).filter(r=>r.approvalRequest.key===K.small).length,1,'Each approval shows once.');
 // Owner-only approvals never go to the deputy.
 const people=(await desk.desk(db,ws)).people,limits=[];
 assert.equal(vacation.delegate({key:'x',kind:'landed_cost',permission:P.ALLOCATE_LANDED_COST,readPermission:P.VIEW_ACCOUNTING,ownerOnly:true,person:people.find(p=>p.role==='owner')},
  await vacation.coverage(db,ws),{people,limits}).person.role,'owner');
 // The first 14 days, Watch only and pause keep everything with the owner.
 await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
 assert.deepEqual(await routed(deputy),[],'shadow');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await auto.pause(db,ctx,{role:'owner'},'Away');assert.deepEqual(await routed(deputy),[],'pause');
 await auto.resume(db,ctx,{role:'owner'});
 await auto.setMode(db,ctx,{role:'owner'},'OBSERVE');assert.deepEqual(await routed(deputy),[],'watch only');
 await auto.setMode(db,ctx,{role:'owner'},'SUPERVISED');assert.deepEqual(await routed(deputy),covered);
 // Losing a permission removes that work at once.
 await db.query('UPDATE users SET permissions=$2 WHERE id=$1',[deputy.actorId,P.encodeGrant([P.VIEW,P.VIEW_PURCHASING,P.APPROVE_PO,P.ADJUST,P.AUTHORIZE_SUPPLIER_RETURN])]);
 assert.deepEqual(await routed(deputy),covered.filter(k=>k!==K.move));assert.ok((await routed(owner)).includes(K.move));
 await db.query('UPDATE users SET permissions=$2 WHERE id=$1',[deputy.actorId,P.encodeGrant([P.VIEW,P.VIEW_PURCHASING,P.APPROVE_PO,P.VIEW_TRANSFERS,P.APPROVE_TRANSFER,P.ADJUST,P.AUTHORIZE_SUPPLIER_RETURN])]);

 // The routine records and audits each approval sent to the deputy, once.
 const record=()=>db.transaction(c=>vacation.record(c,ws));
 assert.equal((await record()).recorded,5);assert.equal((await record()).recorded,0);
 assert.equal(await audits('Approval sent to vacation deputy'),5);

 // The deputy decides through each approval's own service, within their own limit.
 await assert.rejects(workflows.approvePurchaseOrder(db,deputy,large.purchaseOrderId,{idempotencyKey:randomUUID()}),/above your/);
 assert.equal((await workflows.approvePurchaseOrder(db,deputy,small.purchaseOrderId,{idempotencyKey:randomUUID()})).status,'APPROVED');
 await transfers.approve(db,deputy,move.id,{idempotencyKey:randomUUID()});
 // Similar approvals in one tap: the two shelf counts at Dispatch.
 const group=groups.fromItems(await projection.needs(db,ws,deputy.actorId)).find(g=>g.label==='Stock count corrections at Dispatch that lower stock');
 assert.equal(group.count,2);
 const decided=await groups.decide(db,deputy,{group:group.key,decision:'approve',token:randomUUID(),keys:group.items.map(i=>i.key)});
 assert.equal(decided.done.length,2);assert.deepEqual(decided.failed,[]);
 for(const id of [shelfA,shelfB])assert.equal((await assistant.getProposal(db,ws,id)).status,'EXECUTED');
 assert.deepEqual(await routed(deputy),[K.rtv]);

 // Back early: the owner ends it. The rest is the owner's again, and Needs you hands back.
 await save({remove:'1'});
 assert.equal(await audits('Ended vacation coverage'),1);
 assert.deepEqual(await routed(deputy),[]);assert.ok((await routed(owner)).includes(K.rtv));
 const back=(await projection.needs(db,ws,ctx.actorId)).find(r=>r.sourceId?.startsWith('vacation-handback-'));
 assert.equal(back.title,'Welcome back: your approvals are yours again');
 assert.equal(back.happened,'Deputy covered your approvals from '+today+' to '+today+'. 4 were decided and 1 is back with you.');
 assert.equal((await projection.needs(db,ws,deputy.actorId)).find(r=>r.sourceId?.startsWith('vacation-handback-')),undefined);
 const handback=await browser.get(path).expect(200);
 assert.match(handback.text,/Welcome back/);assert.match(handback.text,/Back with you/);assert.match(handback.text,/Decided/);
 await browser.post('/autopilot/vacation-deputy/hand-back').type('form').send({_csrf:f.csrf(handback.text),revision:back.sourceId.replace('vacation-handback-','')}).expect(303);
 assert.equal(await audits('Took approvals back after vacation'),1);
 assert.equal((await projection.needs(db,ws,ctx.actorId)).find(r=>r.sourceId?.startsWith('vacation-handback-')),undefined);
 assert.deepEqual(await vacation.handBack(db,ctx,{revision:back.sourceId.replace('vacation-handback-','')}),{unchanged:true},'Taking them back twice changes nothing.');

 // A future start delegates nothing yet, and replacing it leaves nothing to hand back.
 await save({...away,start:addDays(today,1)});assert.deepEqual(await routed(deputy),[]);
 // Pro and Custom: the same, also when routing by role (job 176) is set to Watch only.
 for(const tier of ['pro','enterprise']){
  await subscribe(tier);
  await save(away);
  const setting=(await modes.page(db,ctx)).find(m=>m.id===176);
  await modes.save(db,ctx,176,{mode:'watch',revision:setting.revision});
  assert.deepEqual(await routed(deputy),[K.rtv],tier);assert.deepEqual(await routed(owner),kept,tier);
  await modes.save(db,ctx,176,{mode:'inherit',revision:setting.revision+1});
 }

 // Two people (job 205, Pro): the deputy can never be both signatures.
 await subscribe('pro');
 const dual=require('../../src/purchasing/dual-approval'),two=require('../../src/autopilot/two-person-approval');
 await dual.configure(db,ctx,{revision:(await dual.setting(db,ws)).revision,currency:'USD',amount:'1'});
 const big=await prepare({action:'adjust',sku:'Parcel item',location:'Dispatch',countedQuantity:30,reason:'Year-end count'});
 assert.equal((await two.approve(db,deputy,big)).status,'WAITING_FOR_SECOND_PERSON');
 const row=(await desk.desk(db,ws)).rows.find(r=>r.key==='proposal:'+big);
 assert.equal(row.person.role,'owner','The second signature waits for the owner, not the deputy who signed.');
 assert.ok(!(await routed(deputy)).includes('proposal:'+big));
 assert.equal((await two.approve(db,deputy,big)).status,'WAITING_FOR_SECOND_PERSON','The same person approving again counts once.');
 assert.equal((await assistant.getProposal(db,ws,big)).status,'PENDING');

 // Back on the last day's end: the owner gets the hand-back without ending it.
 // On Growth every approval would wait for the owner, so the return goes to the deputy.
 await subscribe('growth');assert.equal((await record()).recorded,1);
 await db.query('UPDATE stockchief_runtime.vacation_deputies SET starts_on=$2::date,ends_on=$3::date WHERE workspace_id=$1',[ws,addDays(today,-3),addDays(today,-1)]);
 await db.query('UPDATE stockchief_runtime.vacation_coverages SET starts_on=$2::date,ends_on=$3::date WHERE workspace_id=$1 AND revision=$4',[ws,addDays(today,-3),addDays(today,-1),revision]);
 assert.deepEqual(await routed(deputy),[]);
 const returned=(await projection.needs(db,ws,ctx.actorId)).find(r=>r.sourceId==='vacation-handback-'+revision);
 assert.match(returned.happened,new RegExp('^Deputy covered your approvals from '+addDays(today,-3)+' to '+addDays(today,-1)+'\\. 0 were decided and 1 is back with you\\.$'));

 // The page reads well on a desktop and on a 390 px phone.
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const chrome=await require('playwright').chromium.launch();
 t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const base='http://127.0.0.1:'+server.address().port;
 for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
  const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
  await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
  await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await tab.goto(base+path);
  assert(await tab.getByRole('heading',{name:'Welcome back'}).isVisible(),name);
  assert(await tab.getByRole('button',{name:'I have reviewed this'}).isVisible(),name);
  assert(await tab.getByRole('button',{name:'Save vacation coverage'}).isVisible(),name);
  assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
  await tab.close();
 }
});
