'use strict';

// Disposable, localhost-only PostgreSQL inventory for manual in-app-browser
// verification of the governed report builder. Stop with Ctrl+C to remove it.
const request=require('supertest');
const {startCluster}=require('./postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const config=require('../../src/config');
const {createProviderUnobserved}=require('../../src/ai/provider');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const commerce=require('../../src/operations/postgres-commerce');
const ledger=require('../../src/accounting/postgres-ledger');

const csrf=(html)=>/name="_csrf" value="([^"]+)"/.exec(html)?.[1];

async function main(){
  const cluster=await startCluster();
  const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-report-browser-preview'});
  let app,server;
  const cleanup=async()=>{
    if(server){server.closeAllConnections();await new Promise((resolve)=>server.close(resolve));}
    if(app)await app.locals.sessionStore.close();
    await database.close();cluster.stop();
  };
  try{
    await migratePostgres(database);
    const aiProvider=process.env.REPORT_BROWSER_AI==='1'
      ?createProviderUnobserved(config.ai.provider,config.ai.tier('fast')):null;
    if(process.env.REPORT_BROWSER_AI==='1'&&!config.ai.configured)
      throw new Error('The local reporting browser model is not configured.');
    app=createPostgresApp({database,env:'test',sessionSecret:'disposable-report-browser-preview',aiProvider});
    const agent=request.agent(app),registration=await agent.get('/register');
    await agent.post('/register').type('form').send({_csrf:csrf(registration.text),
      businessName:'Reporting Browser Lab',name:'Report Tester',
      email:'report-browser@example.test',password:'report-browser-test-password'});
    const ctx=(await database.query(`SELECT w.id AS "workspaceId",u.id AS "actorId"
      FROM workspaces w JOIN users u ON u.workspace_id=w.id
      WHERE w.name='Reporting Browser Lab'`)).rows[0];
    const location=await locations.createLocation(database,ctx,{name:'Main warehouse',kind:'warehouse'});
    const first=await catalog.createItem(database,ctx,{name:'Canvas shoes',baseCode:'SHOE-101',trackingMode:'quantity'});
    const second=await catalog.createItem(database,ctx,{name:'Leather shoes',baseCode:'SHOE-102',trackingMode:'quantity'});
    await inventory.receive(database,ctx,{skuId:first.skuIds[0],locationId:location.id,quantity:24,
      idempotencyKey:'report-browser-first-receipt',reference:'LAB-RECEIPT-1'});
    await inventory.receive(database,ctx,{skuId:second.skuIds[0],locationId:location.id,quantity:11,
      idempotencyKey:'report-browser-second-receipt',reference:'LAB-RECEIPT-2'});
    const customer=await commerce.createCustomer(database,ctx,{name:'Example Retailer',email:'retailer@example.test'});
    await ledger.configure(database,ctx,{startDate:'2026-01-01',currency:'USD'});
    for(const [key,skuId,itemId,date,revenue,cost] of [
      ['canvas',first.skuIds[0],first.itemId,'2026-09-12',12000,5500],
      ['leather',second.skuIds[0],second.itemId,'2026-09-19',8000,5000],
      ['canvas-again',first.skuIds[0],first.itemId,'2026-10-03',6000,2800]]){
      await ledger.post(database,ctx,{postingDate:date,sourceKey:`report-browser-${key}`,
        sourceType:'sale_fulfillment',description:`Posted sale ${key}`,currency:'USD',lines:[
          {accountKey:'ACCOUNTS_RECEIVABLE',debitMinor:revenue,customerId:customer.id,itemId,skuId},
          {accountKey:'SALES_REVENUE',creditMinor:revenue,customerId:customer.id,itemId,skuId},
          {accountKey:'COST_OF_GOODS_SOLD',debitMinor:cost,customerId:customer.id,itemId,skuId},
          {accountKey:'INVENTORY_ASSET',creditMinor:cost,customerId:customer.id,itemId,skuId}]});
    }
    server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    process.stdout.write(`REPORT_BROWSER_READY http://127.0.0.1:${server.address().port}/reports\n`);
    const stop=()=>{cleanup().then(()=>process.exit(0),()=>process.exit(1));};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    process.stdin.on('data',(input)=>{if(String(input).trim()==='quit')stop();});
  }catch(error){await cleanup();throw error;}
}
main().catch((error)=>{process.stderr.write(`${error.stack||error}\n`);process.exitCode=1;});
