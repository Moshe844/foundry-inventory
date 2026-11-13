'use strict';

process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

test('the configured report model builds a grouped report over an isolated synthetic business on each plan',
 {skip:process.env.STOCKCHIEF_SYNTHETIC_REPORT_MODEL!=='1',timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:12});
  const {db,ctx,workflows,subscribe}=f;
  const {createProviderUnobserved}=require('../../src/ai/provider');
  const {buildReportDefinition}=require('../../src/assistant/postgres-service');
  const config=require('../../src/config');
  assert.equal(config.ai.provider,'anthropic');
  assert.ok(config.ai.configured);
  const model=createProviderUnobserved('anthropic',config.ai.tier('fast'));
  const saved=await workflows.createSalesOrder(db,ctx,{
   customerId:'fixture-customer',fulfillmentLocationId:f.location.id,
   deliveryMethod:'PICKUP',idempotencyKey:randomUUID(),
   lines:[{skuId:f.item.skuIds[0],quantity:3,unitPriceMinor:900}]
  });
  assert.ok(saved.salesOrderId);
  const sentence='Count my draft sales orders by customer and sort by number of orders, highest first. Use a bar chart.';
  for(const tier of ['starter','growth','pro','enterprise']){
   await subscribe(tier);
   let requests=0;
   const provider={...model,async complete(input){
    assert.ok(++requests<=4,'Keep provider requests within the synthetic test allowance');
    assert.match(input.schemaName,/^stockchief_governed_report(?:_fit)?$/);
    const payload=JSON.parse(input.prompt);
    assert.equal(payload.request,sentence);
    assert.equal(payload.previousReport,null);
    const keys=['request','previousReport','catalogue','compositions','definition','fields','metrics','composition',
     'renderer','initialObjection','rejectedPlan','validationError','correction','baseCurrency'];
    assert.ok(Object.keys(payload).every(key=>keys.includes(key)));
    if(payload.baseCurrency!==undefined)assert.equal(payload.baseCurrency,'USD');
    return model.complete(input);
   }};
   const result=await buildReportDefinition(db,ctx,sentence,{provider});
   assert.equal(result.status,'ANSWERED',tier+' '+result.answer);
   assert.equal(result.creditsUsed,0,tier);
   assert.equal(result.reportConfig.dataset,'sales_orders');
   assert.deepEqual(result.reportConfig.groups,['customer']);
   assert.equal(result.reportConfig.aggregate,'count');
   assert.equal(result.reportConfig.sort,'count');
   assert.equal(result.reportConfig.direction,'desc');
   assert.equal(result.reportConfig.chart,'bar');
   assert.ok(result.reportConfig.filters.some(filter=>filter.field==='status'&&filter.operator==='equals'&&filter.value==='DRAFT'));
   assert.equal(result.rows.length,1,tier);
   assert.equal(Number(result.rows[0].count),1,tier);
   const receipts=(await db.query(`SELECT count(*)::int AS n FROM commercial_model_cost_holds
    WHERE workspace_id=$1 AND status='SETTLED' AND detail->>'includedReport'='true'`,[ctx.workspaceId])).rows[0].n;
   assert.ok(receipts>=requests,'Every included report call has a settled cost receipt');
   t.diagnostic(tier+' matched the draft-order filter, customer grouping, chart and recorded count with '+requests+' provider calls');
  }
 });
