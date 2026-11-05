'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const reads=require('../../src/assistant/bounded-business-read'),direct=require('../../src/assistant/direct-business-reads');

test('questions about who owes whom are read directly, and a period or reason is left to the planner',()=>{
 const balanceSides=text=>{const query=direct.classify(text);return query?.kind==='balances'?query.side:null;};
 const kind=text=>{const query=direct.classify(text);return query?query.kind+':'+(query.side||''):null;};
 for(const text of ['Who owes me money?','Which customers owe me money, and how much each?','How much am I owed?','Show unpaid invoices','who owes us','Late invoices'])assert.equal(kind(text),'balances:invoices',text);
 for(const text of ['Who do I owe?','How much do we owe suppliers?','Unpaid bills','What bills to pay do I have'])assert.equal(kind(text),'balances:bills',text);
 for(const text of ['Why does Sarah owe me money?','Who owed me money last month?','Who owes me money compared to last year?'])assert.notEqual(kind(text),'balances:invoices',text);
 assert.equal(direct.classify('How much does Sarah Klein owe me?').party,'Sarah Klein');
 assert.equal(direct.classify('How much do I owe Nike Wholesale?').party,'Nike Wholesale');
 assert.equal(direct.classify('Who is late paying? Overdue invoices').late,true);
 for(const text of ['How many items are in my inventory currently?','How many products do we currently have?','How many items do I have right now?'])assert.equal(direct.classify(text).kind,'summary',text);
 assert.equal(direct.classify('How many Trail Shoe do we have?').kind,'stock');
 assert.equal(direct.classify('Who ows me money?').kind,'balances');
 for(const text of ['give me a table','I asked for a table','put it in a table please','Make it a table'])assert.equal(direct.classify(text).kind,'as_table',text);
 assert.notEqual(direct.classify('Give me a table of customers')?.kind,'as_table');
 for(const text of ['change it to 20','make those 5 each','what about last month?','show only the late ones','and for Nike'])assert.equal(direct.standalone(text),false,text+' leans on what was just said');
 for(const text of ['What is in stock right now?','Create a purchase order for Nike','Who owes me money?'])assert.equal(direct.standalone(text),true,text);
 for(const text of ['Any unpaid supplier bills and customer invoices?','Show AP and AR outstanding.','What do we currently owe suppliers, and what customer money is still outstanding?'])assert.equal(balanceSides(text),null,text);
});

test('a close model choice is corrected to the report rules instead of stopping the run',()=>{
 const actor={role:'owner',permissions:[]},plan=spec=>reads.validate({status:'read',question:'',queries:[spec]},actor).queries[0];
 const noCurrency=plan({dataset:'customer_invoices',groups:['customer'],aggregate:'sum',measure:'balance_minor',filters:[{field:'balance_minor',operator:'greater_than',value:0}],sort:'total',direction:'desc'});
 assert.deepEqual(noCurrency.groups,['customer','currency']);
 const wrongSort=plan({dataset:'customer_invoices',groups:['customer','currency'],aggregate:'sum',measure:'balance_minor',sort:'balance_minor',direction:'desc'});
 assert.equal(wrongSort.sort,'total');
 const whole=plan({dataset:'customer_invoices',summary:true,aggregate:'sum',measure:'balance_minor'});
 assert.deepEqual(whole.groups,['currency']);assert.equal(whole.summary,false);
 const stray=plan({dataset:'customer_invoices',groups:['customer','currency'],aggregate:'sum',measure:'balance_minor',sort:'due_date'});
 assert.notEqual(stray.sort,'due_date');
});

test('Ask answers the unpaid list on two accounts with no model, and count gains are never negative expenses',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:20}),{db,ctx}=f,assistant=require('../../src/assistant/postgres-service'),workflows=f.workflows,money=require('../../src/accounting/customer-money');
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,source) VALUES('balances-plan',$1,'pro','plan-services-2026-10-27:pro','COMP','CUSTOM','ISOLATED_TEST')",[f.owner.accountId]);
 const asked=async(context,question)=>assistant.ask(db,context,question,{requestKey:'balances-'+question});
 await t.test('nobody owes anything yet',async()=>{
  const none=await asked(ctx,'Who owes me money?');
  assert.match(none.answer,/Nobody owes you money/);
  assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 });
 const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 const order=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:'balances-sale',lines:[{skuId:f.item.skuIds[0],quantity:3,unitPriceMinor:9000}]});
 await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'balances-confirm'});
 await workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'balances-fulfill',lines:[{lineId:order.lineIds[0],quantity:3,locationId:f.location.id}]});
 await t.test('the answer is the same list Money shows, in every wording',async()=>{
  const name=(await db.query("SELECT name FROM customers WHERE id='fixture-customer'")).rows[0].name;
  for(const question of ['Who owes me money?','Which customers owe me money, and how much each?']){
   const result=await asked(ctx,question);
   assert.match(result.answer,new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+' \\$270\\.00'),result.answer);
   assert.equal(result.rows.length,1);assert.notEqual(result.goalId,undefined===result.goalId?1:undefined);
  }
  const model=await money.snapshot(db,ctx.workspaceId,{from:today,to:today});assert.equal(model.receivableTotals.totalMinor,27000);
  assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0','No agent run started for a fixed read');
 });
 await t.test('short follow-ups build on the last answer in the same conversation, with no AI',async()=>{
  const conversationId='chat_followups_balances',ask=async message=>assistant.ask(db,ctx,message,{requestKey:'followup-'+message,conversationId,usageKey:'followup-'+message});
  const name=(await db.query("SELECT name FROM customers WHERE id='fixture-customer'")).rows[0].name;
  assert.match((await ask('Who owes me money?')).answer,/Total owed: \$270\.00/);
  assert.match((await ask('just the late ones')).answer,/Nobody is late paying you/);
  assert.match((await ask('all of them')).answer,/Total owed: \$270\.00/);
  assert.match((await ask('what about '+name)).answer,/\$270\.00/);
  assert.match((await ask('and Nobody Real Inc')).answer,/no unpaid invoices for Nobody Real Inc/);
  assert.match((await ask('what about bills?')).answer,/no unpaid bills/i);
  const table=await ask('Who owes me money?');await ask('give me a table');
  assert.equal(table.rows.length,1);
  const goals=(await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;assert.equal(goals,'0','No agent run started for any of these');
  const other=await assistant.ask(db,ctx,'just the late ones',{requestKey:'followup-other',conversationId:'chat_other_conversation',usageKey:'followup-other'}).catch(error=>error);
  assert.doesNotMatch(String(other.answer||''),/Nobody is late paying you/,'Another conversation has nothing to follow up on');
 });
 await t.test('a second account sees only its own balances',async()=>{
  const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Second Owner',businessName:'Second shop',email:'second-'+Date.now()+'@example.test',password:'Second-password-1!'});
  const context={workspaceId:other.workspaceId,actorId:other.userId};
  await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,source) VALUES('balances-plan-2',$1,'pro','plan-services-2026-10-27:pro','COMP','CUSTOM','ISOLATED_TEST')",[other.accountId]);
  const result=await asked(context,'Who owes me money?');assert.match(result.answer,/Nobody owes you money/);
 });
 await t.test('a count gain is its own line, between gross and net',async()=>{
  const ledger=require('../../src/accounting/postgres-ledger'),reports=require('../../src/accounting/postgres-reports');
  const before=await reports.profitAndLoss(db,ctx.workspaceId,{from:today,to:today});
  await ledger.post(db,ctx,{postingDate:today,sourceKey:'balances-count-gain',sourceType:'physical_count',description:'Count gain',currency:'USD',lines:[{accountKey:'INVENTORY_ASSET',debitMinor:40000},{accountKey:'INVENTORY_ADJUSTMENTS',creditMinor:40000}]});
  const after=await reports.profitAndLoss(db,ctx.workspaceId,{from:today,to:today});
  assert.equal(after.operatingExpenseMinor,before.operatingExpenseMinor,'A count gain does not touch expenses');
  assert.ok(after.operatingExpenseMinor>=0,'Expenses are never negative from counts');
  assert.equal(after.stockCountMinor,before.stockCountMinor+40000);
  assert.equal(after.grossProfitMinor,before.grossProfitMinor);
  assert.equal(after.netIncomeMinor,before.netIncomeMinor+40000);
  const model=await money.snapshot(db,ctx.workspaceId,{from:today,to:today});
  assert.equal(money.sum(model.parts.stockCount,'amountMinor'),after.stockCountMinor);
  assert.equal(money.sum(model.parts.net,'amountMinor'),after.netIncomeMinor);
  const profit=await asked(ctx,"What's my profit this month?");
  assert.match(profit.answer,/Stock count gains \/ losses: \$/);assert.doesNotMatch(profit.answer,/Expenses: -/);
  const actor=(await db.query('SELECT * FROM users WHERE id=$1',[ctx.actorId])).rows[0],plan=reads.validate({status:'read',question:'',queries:[{dataset:'profit_activity',aggregate:'sum',measure:'net_profit_minor',groups:['currency']},{dataset:'profit_activity',aggregate:'sum',measure:'revenue_minor',groups:['currency']}]},actor);
  const card=reads.render(await reads.execute(db,ctx,actor,plan));
  assert.match(card,/\| Stock count gains \/ losses \| \$/);
  const report=await require('../../src/reports/postgres-service').run(db,ctx,actor,{dataset:'profit_activity',summary:true,aggregate:'sum',measure:'expenses_minor',filters:[{field:'currency',operator:'equals',value:'USD'},{field:'posting_date',operator:'after',value:today},{field:'posting_date',operator:'before',value:today}]},{limit:2});
  assert.equal(Number(report.rows[0].total),after.operatingExpenseMinor);
 });
});
