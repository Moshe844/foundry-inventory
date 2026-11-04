'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
test('daily profit sums reconcile while transaction counts and averages retain their original journal population',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,ledger=require('../../src/accounting/postgres-ledger'),reports=require('../../src/reports/postgres-service');for(const amount of [200,300,400])await ledger.post(db,ctx,{sourceKey:'profit-projection:'+amount,sourceType:'test_cash_sale',currency:'USD',lines:[{accountKey:'CASH',debitMinor:amount},{accountKey:'SALES_REVENUE',creditMinor:amount}]});
 const actor={role:'owner'},spec={dataset:'profit_activity',summary:true,measure:'revenue_minor',filters:[{field:'currency',operator:'equals',value:'USD'}]};for(const [aggregate,expected,column]of [['sum',900,'total'],['count',3,'count'],['average',300,'average'],['minimum',200,'minimum'],['maximum',400,'maximum']]){const result=await reports.run(db,ctx,actor,{...spec,aggregate});assert.equal(Number(result.rows[0][column]),expected,aggregate);}
 const grouped=await reports.run(db,ctx,actor,{...spec,summary:false,groups:['posting_date'],aggregate:'sum'});assert.equal(grouped.rows.reduce((n,r)=>n+Number(r.total),0),900);const sources=await reports.run(db,ctx,actor,{dataset:'profit_activity',columns:['posting_date','currency','revenue_minor']});assert.equal(sources.rows.length,3);assert.equal(sources.rows.reduce((n,r)=>n+Number(r.revenue_minor),0),900);
 const sql=reports.queryFor(reports.normalize({...spec,aggregate:'sum'},actor),ctx.workspaceId,{limit:2,offset:0}).sql;assert.match(sql,/accounting_journal_lines/);assert.doesNotMatch(sql,/accounting_daily_account_totals/);assert.doesNotMatch(reports.queryFor(reports.normalize({...spec,aggregate:'count'},actor),ctx.workspaceId,{limit:2,offset:0}).sql,/accounting_daily_account_totals/);
 const filtered={...spec,aggregate:'sum',filters:[...spec.filters,{field:'revenue_minor',operator:'at_least',value:300}]};assert.equal(Number((await reports.run(db,ctx,actor,filtered)).rows[0].total),700,'A row-value filter must run before daily aggregation');assert.doesNotMatch(reports.queryFor(reports.normalize(filtered,actor),ctx.workspaceId,{limit:2,offset:0}).sql,/accounting_daily_account_totals/);
 await t.test('skewed opening history cannot turn profit reads into repeated journal scans',async()=>{
  const inputs=Array.from({length:10000},(_,n)=>({sourceKey:'skew-opening-'+n,sourceType:'test_opening_history',currency:'USD',lines:[{accountKey:'INVENTORY_ASSET',debitMinor:100},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:100}]}));
  await db.transaction(c=>ledger.postManyInTransaction(c,ctx,inputs),{isolation:'READ COMMITTED'});
  await db.query('ANALYZE accounting_journal_entries,accounting_journal_lines,accounting_accounts');
  for(const config of [reports.normalize({...spec,aggregate:'sum'},actor),reports.normalize({dataset:'profit_activity',columns:['posting_date','currency','revenue_minor']},actor)]){
   await db.transaction(async c=>{
    const profitAccountIds=await require('../../src/reports/postgres-profit-scope').accountIds(c,ctx.workspaceId,config),q=reports.queryFor(config,ctx.workspaceId,{limit:10,profitAccountIds});
    const plan=(await c.query('EXPLAIN (ANALYZE,FORMAT JSON) '+q.sql,q.values)).rows[0]['QUERY PLAN'][0],nodes=[];const visit=n=>{nodes.push(n);for(const child of n.Plans||[])visit(child);};visit(plan.Plan);
    assert(!nodes.some(n=>n['Relation Name']==='accounting_journal_lines'&&n['Node Type']==='Seq Scan'),'Profit cannot scan opening asset/equity history');
    const rows=(await c.query(q.sql,q.values)).rows;assert.equal(config.summary?Number(rows[0].total):rows.reduce((n,r)=>n+Number(r.revenue_minor),0),900);
   },{readOnly:true,isolation:'REPEATABLE READ',statementTimeoutMs:1500,jit:false});
  }
  assert.equal(await reports.countAtMost(db,ctx,actor,{dataset:'profit_activity',columns:['posting_date','currency','revenue_minor']},100),3);
  assert.equal(Number((await reports.run(db,ctx,actor,{...spec,aggregate:'sum'})).rows[0].total),900);
 });
 await t.test('posted profit remains available without the legacy daily summary view',async()=>{
  await db.query('DROP VIEW accounting_daily_account_totals');
  const uncached={query:db.query.bind(db),transaction:db.transaction.bind(db)};
  const pnl=await require('../../src/accounting/postgres-reports').profitAndLoss(uncached,ctx.workspaceId,{});
  assert.equal(pnl.revenueMinor,900);assert.equal(pnl.netIncomeMinor,900);
  assert(pnl.accounts.every(a=>['INCOME','COGS','EXPENSE'].includes(a.account_type)),'Profit excludes asset and equity accounts before reading their history');
  assert.equal(Number((await reports.run(uncached,ctx,actor,{...spec,aggregate:'sum'})).rows[0].total),900);
 });
});
