'use strict';
const assert=require('node:assert/strict'),reports=require('../../src/reports/postgres-service'),scope=require('../../src/reports/postgres-profit-scope');
async function check(db,ctx,{large=false}={}){
 const actor={role:'owner'},input=[['posted_sales_activity','customer','revenue_minor'],['tax_activity','currency','net_tax_minor'],['expenses','category','amount_minor']],timings=[];
 for(const [dataset,group,measure]of input){
  const config=reports.normalize({dataset,groups:[group],aggregate:'sum',measure,sort:'total',filters:[{field:'currency',operator:'equals',value:'USD'}]},actor);
  const ids=await scope.accountIds(db,ctx.workspaceId,config);assert(Array.isArray(ids));
  const q=reports.queryFor(config,ctx.workspaceId,{limit:13,profitAccountIds:ids});assert(q.sql.includes('l.account_id=ANY('));
  const plan=(await db.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+q.sql,q.values)).rows[0]['QUERY PLAN'][0],nodes=[];function visit(n){nodes.push(n);for(const p of n.Plans||[])visit(p);}visit(plan.Plan);
  assert.equal(plan.Plan['Actual Rows'],0,'Opening asset/equity lines are not sales, taxes or expenses');
  if(large){for(const n of nodes.filter(n=>['skus','items','catalogue_item_facts','accounting_journal_lines'].includes(n['Relation Name']))){assert((n['Actual Rows']+(n['Rows Removed by Filter']||0))*n['Actual Loops']<100,'A sparse ledger report must not traverse unrelated opening stock: '+JSON.stringify(n));}assert(plan['Execution Time']<1500);}
  timings.push({dataset,ms:plan['Execution Time']});
 }
 const ledger=require('../../src/accounting/postgres-ledger'),postingDate=(await db.query('SELECT accounting_start_date FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].accounting_start_date;
 for(const [sourceKey,lines]of [
  ['bounded-report-sale',[{accountKey:'CASH',debitMinor:1120},{accountKey:'SALES_REVENUE',creditMinor:1000},{accountKey:'SALES_TAX_PAYABLE',creditMinor:120},{accountKey:'COST_OF_GOODS_SOLD',debitMinor:400},{accountKey:'INVENTORY_ASSET',creditMinor:400}]],
  ['bounded-report-return',[{accountKey:'SALES_RETURNS',debitMinor:100},{accountKey:'CASH',creditMinor:100}]],
  ['bounded-report-expense',[{accountKey:'OPERATING_EXPENSE',debitMinor:250},{accountKey:'CASH',creditMinor:250}]],
 ])await ledger.post(db,ctx,{postingDate,sourceKey,description:'Isolated ledger report check',currency:'USD',lines});
 const filters=[{field:'currency',operator:'equals',value:'USD'}];
 for(const [dataset,,measure]of input){const result=await reports.run(db,ctx,actor,{dataset,summary:true,aggregate:'sum',measure,filters},{limit:2});assert.equal(Number(result.rows[0].total),{posted_sales_activity:900,tax_activity:120,expenses:250}[dataset]);}
 const spec={dataset:'posted_sales_activity',groups:['customer'],aggregate:'sum',measure:'gross_profit_minor',filters};
 assert.equal(Number((await reports.run(db,ctx,actor,spec,{limit:2})).rows[0].total),500);assert.equal(await reports.countAtMost(db,ctx,actor,spec,1000),1);
 assert.deepEqual(await scope.accountIds(db,'unrelated-workspace',{dataset:'posted_sales_activity'}),[]);
 return {openingRowsExcludedBeforeProductJoins:true,exactSalesReturnsTaxExpense:true,grossProfitMinor:500,timings};
}
module.exports={check};
