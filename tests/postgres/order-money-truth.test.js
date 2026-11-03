'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),ejs=require('ejs');

test('cancelled orders, deposits, one sales total, plan locks, number order and profit answers tell the truth',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Truth shop',email:'truth@example.test',password:'Truth-password-1!'});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId},wf=require('../../src/operations/postgres-business-workflows'),catalog=require('../../src/domain/postgres-catalog-service'),commerce=require('../../src/operations/postgres-commerce'),shipping=require('../../src/shipping/postgres-service'),deposits=require('../../src/sales/postgres-deposit-refunds');
 const location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Main',kind:'warehouse',address:'1 Main St, Monroe, NY 10950',phone:'845-555-0100'});
 const items=[];for(const name of ['Item 10','Item 2','Item 1','Item 11','Item 3'])items.push(await catalog.createItem(db,ctx,{name,baseCode:name.replace(' ','-'),trackingMode:'quantity',unitLabel:'each'}));
 const at=new Date().toISOString(),sku=items[0].skuIds[0];
 await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('sup',$1,'Supply','active','USD',$2,$2)",[ctx.workspaceId,at]);
 const po=await wf.createPurchaseOrder(db,ctx,{supplierId:'sup',destinationLocationId:location.id,idempotencyKey:'po',lines:[{skuId:sku,quantityUnits:50,unitCost:10}]});
 await wf.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'poa'});await wf.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'pop'});
 await wf.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'por',reference:'R',lines:[{lineId:po.lineIds[0],quantity:50,locationId:location.id}]});
 await db.query("INSERT INTO customers(id,workspace_id,name,email,phone,shipping_address,record_state,created_by_user_id,created_at,updated_at) VALUES('cust',$1,'Sarah','s@example.test','718-555-0101','245 Bedford Ave, Brooklyn, NY 11211','ACTIVE',$2,$3,$3)",[ctx.workspaceId,ctx.actorId,at]);
 const order=async(key,quantity=1)=>{const made=await wf.createSalesOrder(db,ctx,{customerId:'cust',deliveryMethod:'SHIP',shipToAddress:'245 Bedford Ave, Brooklyn, NY 11211',fulfillmentLocationId:location.id,idempotencyKey:key,lines:[{skuId:sku,quantity,unitPriceMinor:10000}]});await wf.confirmSalesOrder(db,ctx,made.salesOrderId,{idempotencyKey:key+'c'});return made.salesOrderId;};
 const openParcel=async id=>{const detail=await commerce.salesOrder(db,ctx.workspaceId,id),{lines,locationId}=require('../../src/sales/parcel-lines').forParcel(detail);return (await shipping.prepare(db,ctx,id,{idempotencyKey:'parcel:'+id,shipFromLocationId:locationId,shipToAddress:detail.order.ship_to_address,startPicking:true,lines})).shipmentId;};

 await t.test('cancelling closes the open parcel; a saved label stops it until voided',async()=>{
  const id=await order('plain'),parcel=await openParcel(id);
  await wf.cancelSalesOrder(db,ctx,id,{idempotencyKey:'plain-x'});
  assert.equal((await shipping.requireShipment(db,ctx.workspaceId,parcel)).status,'CANCELLED');
  const labelled=await order('labelled'),other=await openParcel(labelled);
  await db.query("UPDATE sales_shipments SET label_status='PURCHASED' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,other]);
  await assert.rejects(()=>wf.cancelSalesOrder(db,ctx,labelled,{idempotencyKey:'labelled-x'}),/void/i);
  assert.notEqual((await commerce.salesOrder(db,ctx.workspaceId,labelled)).order.status,'CANCELLED');
  await db.query("UPDATE sales_shipments SET label_status='VOIDED' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,other]);
  await wf.cancelSalesOrder(db,ctx,labelled,{idempotencyKey:'labelled-y'});
 });

 await t.test('a deposit on a cancelled order is owed back, shows in Needs you, and clears once refunded',async()=>{
  const id=await order('deposit');
  await wf.recordCustomerDeposit(db,ctx,{customerId:'cust',salesOrderId:id,amountMinor:5000,method:'card',idempotencyKey:'dep'});
  assert.equal((await deposits.due(db,ctx.workspaceId)).length,0,'an open order has nothing to refund');
  await wf.cancelSalesOrder(db,ctx,id,{idempotencyKey:'dep-x'});
  assert.equal((await deposits.forOrder(db,ctx.workspaceId,id)).toRefundMinor,5000);
  const needs=await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);
  assert(needs.some(item=>/Deposit to refund: \$50\.00 to Sarah/.test(item.title)&&item.href==='/orders/'+id+'#deposit-refund'));
  assert.equal(needs.find(item=>/Deposit to refund/.test(item.title)).importance,'Needs You','a deposit cancelled just now is not an alarm');
  const importance=require('../../src/projections/postgres-service').orderImportance,day=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
  assert.equal(importance(null),'Needs You');assert.equal(importance(day(30)),'Needs You');assert.equal(importance(day(2)),'Important');assert.equal(importance(day(-1)),'Urgent');
  await assert.rejects(()=>wf.refundCustomerDeposit(db,ctx,{salesOrderId:id,amountMinor:5001,idempotencyKey:'too-much'}),/more than/);
  const cashBefore=await require('../../src/accounting/postgres-reports').balanceSheet(db,ctx.workspaceId,{});
  await wf.refundCustomerDeposit(db,ctx,{salesOrderId:id,amountMinor:2000,idempotencyKey:'part'});
  await wf.refundCustomerDeposit(db,ctx,{salesOrderId:id,amountMinor:2000,idempotencyKey:'part'});
  assert.equal((await deposits.forOrder(db,ctx.workspaceId,id)).toRefundMinor,3000,'the same request is not refunded twice');
  await wf.refundCustomerDeposit(db,ctx,{salesOrderId:id,amountMinor:3000,idempotencyKey:'rest'});
  assert.equal((await deposits.due(db,ctx.workspaceId)).length,0);
  const lines=(await db.query("SELECT a.system_key,sum(l.debit_minor)::bigint debit,sum(l.credit_minor)::bigint credit FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id=l.entry_id JOIN accounting_accounts a ON a.id=l.account_id WHERE e.workspace_id=$1 AND e.source_type='customer_deposit_refund' GROUP BY a.system_key",[ctx.workspaceId])).rows;
  assert.deepEqual(Object.fromEntries(lines.map(l=>[l.system_key,[Number(l.debit),Number(l.credit)]])),{CASH:[0,5000],CUSTOMER_DEPOSITS:[5000,0]});
  assert(cashBefore);
  assert.equal((await require('../../src/accounting/postgres-reports').profitAndLoss(db,ctx.workspaceId,{})).revenueMinor,0,'a deposit and its refund are not sales');
 });

 await t.test('Orders, Money and Reports give one sales figure, and an unshipped order is not a sale',async()=>{
  await order('open-big',10);
  const shipped=await order('shipped',2),detail=await commerce.salesOrder(db,ctx.workspaceId,shipped);
  await wf.fulfillSalesOrder(db,ctx,shipped,{idempotencyKey:'ship',lines:detail.lines.map(line=>({lineId:line.id,quantity:2,locationId:location.id}))});
  
  const shared=await require('../../src/accounting/posted-sales').thisMonth(db,ctx.workspaceId);
  const money=await require('../../src/accounting/customer-money').snapshot(db,ctx.workspaceId,{summary:true});
  const view=await require('../../src/web/orders-view').ordersList(db,ctx.workspaceId,await require('../../src/web/postgres-presenters').sales(db,ctx.workspaceId),{});
  assert.equal(view.kpis.month.minor,shared.minor);
  assert.equal(shared.minor,money.pnl.revenueMinor);assert(shared.minor>0);assert(shared.minor<100000,'ten unshipped units are not counted');

 });

 await t.test('a plan lock never offers an upgrade to the plan the account is already on',async()=>{
  const growth=(await db.query("SELECT * FROM commercial_plan_versions WHERE plan_id='growth' AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1")).rows[0];
  await db.query("INSERT INTO commercial_plan_versions(id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters) VALUES('older-growth','growth',$1,'RETIRED',$2,$3,$4,$5::jsonb,$6::jsonb)",[Number(growth.version_number)+100,growth.currency,growth.monthly_amount_minor,growth.annual_amount_minor,JSON.stringify(growth.entitlements.filter(e=>e.capability!=='authority.advanced')),JSON.stringify(growth.meters)]);
  await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,current_period_start,current_period_end,source) VALUES('truth-sub',$1,'growth','older-growth','COMP','MONTHLY','2026-11-01','2099-12-01','ISOLATED_TEST') ON CONFLICT(account_id) DO UPDATE SET plan_id='growth',plan_version_id='older-growth',status='COMP'",[owner.accountId]);
  const scope={accountId:owner.accountId,workspaceId:ctx.workspaceId},planGates=await require('../../src/web/presentation/plan-gates').read(db,scope),lock=path.join(__dirname,'../../src/web/views/components/plan-lock.ejs');
  assert.equal(planGates['authority.advanced'].enabled,false);assert.equal(planGates['authority.advanced'].currentOfferIncludes,true);
  const older=await ejs.renderFile(lock,{planGates,capability:'authority.advanced',label:'Custom roles and approval limits'});
  assert.match(older,/\/billing\/terms/);assert.doesNotMatch(older,/Upgrade/);
  await db.query("UPDATE account_subscriptions SET plan_version_id=$2 WHERE account_id=$1",[owner.accountId,growth.id]);
  assert.equal((await require('../../src/web/presentation/plan-gates').read(db,scope))['authority.advanced'].enabled,true,'current Growth includes custom roles');
  const starter=(await db.query("SELECT id FROM commercial_plan_versions WHERE plan_id='starter' AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1")).rows[0];
  await db.query("UPDATE account_subscriptions SET plan_id='starter',plan_version_id=$2 WHERE account_id=$1",[owner.accountId,starter.id]);
  const below=await ejs.renderFile(lock,{planGates:await require('../../src/web/presentation/plan-gates').read(db,scope),capability:'authority.advanced',label:'Custom roles and approval limits'});
  assert.match(below,/Upgrade/);assert.match(below,/Growth/);
  await db.query("UPDATE account_subscriptions SET plan_id='growth',plan_version_id=$2 WHERE account_id=$1",[owner.accountId,growth.id]);
 });

 await t.test('stock names sort in number order, across pages',async()=>{
  const first=await catalog.listItems(db,ctx.workspaceId,{sort:'name',pageSize:3});
  assert.deepEqual(first.items.map(item=>item.name),['Item 1','Item 2','Item 3']);
  const last=first.items.at(-1);
  const second=await catalog.listItems(db,ctx.workspaceId,{sort:'name',pageSize:3,afterItemId:last.id});
  assert.deepEqual(second.items.map(item=>item.name),['Item 10','Item 11']);
  const flat=await require('../../src/domain/postgres-flat-catalog').list(db,ctx.workspaceId,{sort:'name'});
  assert.deepEqual([...new Set(flat.items.map(row=>row.name||row.item_name))],['Item 1','Item 2','Item 3','Item 10','Item 11']);
 });

 await t.test('a profit question is one card with every figure named',async()=>{
  const reads=require('../../src/assistant/bounded-business-read'),actor=(await db.query('SELECT * FROM users WHERE id=$1',[ctx.actorId])).rows[0];
  const plan=reads.validate({status:'read',question:'',queries:[{dataset:'profit_activity',aggregate:'sum',measure:'net_profit_minor',groups:['currency']},{dataset:'profit_activity',aggregate:'sum',measure:'revenue_minor',groups:['currency']}]},actor);
  assert.deepEqual(plan.queries.map(q=>q.measure),['revenue_minor','cogs_minor','expenses_minor']);
  const answer=reads.render(await reads.execute(db,ctx,actor,plan));
  assert.equal((answer.match(/Recorded sales, product cost/g)||[]).length,0);
  for(const name of ['Sales','Product cost','Gross profit','Expenses','Net profit'])assert.match(answer,new RegExp('\\| '+name+' \\| \\$'),name);
  assert.match(answer,/Gross profit = sales − product cost\. Net profit = gross profit − expenses\./);
  const html=require('../../src/web/public/agent-answer').render(answer);assert.match(html,/<table/);
  const sales=reads.validate({status:'read',question:'',queries:[{dataset:'profit_activity',aggregate:'sum',measure:'revenue_minor',groups:['currency']}]},actor);
  assert.equal(sales.queries.length,1,'a sales question stays a sales question');
 });

 await t.test('a connection problem uses the connection name, not its internal type',async()=>{
  const now=new Date().toISOString();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,setup_status,authorized_by_user_id,created_at,updated_at)
   VALUES('conn-store',$1,'store-key','ShipStation Custom Store','shipstation_custom_store','[]','{}','connected','[]','READY',$2,$3,$3)`,[ctx.workspaceId,ctx.actorId,now]);
  await db.query("INSERT INTO connection_issues(id,workspace_id,connector_id,issue_type,fingerprint,title,detail,resolution_hint,created_at,updated_at) VALUES('issue-1',$1,'conn-store','SYNC_FAILED','fp','Orders stopped syncing','The last pull failed.','Reconnect it.',$2,$2)",[ctx.workspaceId,now]);
  const items=await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId),issue=items.find(item=>item.title==='Orders stopped syncing');
  assert.match(issue.why,/^ShipStation Custom Store /);assert.doesNotMatch(JSON.stringify(issue),/shipstation_custom_store/);
 });
});
