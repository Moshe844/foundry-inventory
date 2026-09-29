'use strict';

process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE='false';

const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
const {startCluster}=require('../tests/helpers/postgres-cluster');
const {openPostgres}=require('../src/db/postgres');
const {migratePostgres}=require('../src/db/migrate-postgres');
const {createPostgresApp}=require('../src/postgres-app');
const catalog=require('../src/domain/postgres-catalog-service');
const locations=require('../src/domain/postgres-location-service');
const inventory=require('../src/domain/postgres-inventory-engine');
const pricing=require('../src/pricing/postgres-service');
const commerce=require('../src/operations/postgres-commerce');
const workflows=require('../src/operations/postgres-business-workflows');

const outputDirectory=path.join(__dirname,'..','src','web','public','demo');
const fields=(overrides={})=>({intent:'lookup',view:'inventory',action:null,search:null,sku:null,location:null,
  fromLocation:null,toLocation:null,quantity:null,countedQuantity:null,amount:null,currency:null,reason:null,
  reference:null,recipient:'',recipientKind:'',subject:'',body:'',mailbox:'',customer:'',supplier:'',
  deliveryMethod:'',shipToAddress:'',neededBy:'',...overrides});
const provider={name:'commercial-demo-fixture',model:'commercial-demo-fixture',async complete(){
  return {data:fields({search:'Black Tee Small'}),usage:{}};
}};

async function capture(page,base,route,name){
  await page.goto(`${base}${route}`,{waitUntil:'networkidle'});
  await page.screenshot({path:path.join(outputDirectory,name),fullPage:false});
}

async function main(){
  await fs.mkdir(outputDirectory,{recursive:true});
  const cluster=await startCluster();
  const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-commercial-demo-capture'});
  let server;let browser;
  try{
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'commercial-demo-secret',aiProvider:provider,
      assetVersion:'commercial-demo-capture'});
    server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    browser=await chromium.launch();
    const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
    page.setDefaultTimeout(20000);
    const base=`http://127.0.0.1:${server.address().port}`;

    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Maple & Main');
    await page.getByLabel('Your name').fill('Morgan Lee');
    await page.getByLabel('Work email').fill('demo-owner@stockchief.example');
    await page.getByLabel('Password').fill('commercial-demo-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);

    const identity=(await database.query(`SELECT workspace.id AS workspace_id,member.id AS actor_id
      FROM workspaces workspace JOIN users member ON member.workspace_id=workspace.id
      JOIN accounts account ON account.id=member.account_id WHERE account.email=$1`,
    ['demo-owner@stockchief.example'])).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const mainWarehouse=await locations.createLocation(database,ctx,{name:'Monroe warehouse',kind:'warehouse'});
    const overflowWarehouse=await locations.createLocation(database,ctx,{name:'Brooklyn warehouse',kind:'warehouse'});
    const shirt=await catalog.createItem(database,ctx,{name:'Black Tee Small',baseCode:'BLACK-S',trackingMode:'quantity'});
    await inventory.receive(database,ctx,{skuId:shirt.skuIds[0],locationId:mainWarehouse.id,quantity:20,
      reference:'OPENING-BLACK-S',idempotencyKey:'demo:shirt:main:opening'});
    await inventory.issue(database,ctx,{skuId:shirt.skuIds[0],locationId:mainWarehouse.id,quantity:18,
      reference:'SHOPIFY-DEMAND',idempotencyKey:'demo:shirt:main:demand'});
    await inventory.receive(database,ctx,{skuId:shirt.skuIds[0],locationId:overflowWarehouse.id,quantity:50,
      reference:'OPENING-BROOKLYN',idempotencyKey:'demo:shirt:overflow:opening'});
    await pricing.setPurchaseCost(database,ctx,{skuId:shirt.skuIds[0],amount:'14.00',currency:'USD',source:'supplier quote'});
    await pricing.setPrice(database,ctx,{skuId:shirt.skuIds[0],amountMinor:3600,currency:'USD'});
    const shirtId=(await database.query('SELECT item_id FROM skus WHERE id=$1',[shirt.skuIds[0]])).rows[0].item_id;

    await capture(page,base,`/inventory/${shirtId}`,'inventory.png');
    await capture(page,base,'/planning','planning.png');

    const supplier=await commerce.createSupplier(database,ctx,{name:'ABC Apparel',email:'orders@abc-apparel.example',currency:'USD',
      defaultLeadTimeDays:12});
    const purchase=await workflows.createPurchaseOrder(database,ctx,{supplierId:supplier.id,destinationLocationId:mainWarehouse.id,
      idempotencyKey:'demo:po:1054',lines:[{skuId:shirt.skuIds[0],quantityUnits:24,unitCost:14,
        destinationLocationId:mainWarehouse.id}]});
    await workflows.approvePurchaseOrder(database,ctx,purchase.purchaseOrderId,{idempotencyKey:'demo:po:approve'});
    await workflows.placePurchaseOrder(database,ctx,purchase.purchaseOrderId,{idempotencyKey:'demo:po:place'});

    await capture(page,base,'/','brief.png');
    await capture(page,base,`/purchasing/orders/${purchase.purchaseOrderId}`,'purchasing.png');
    await page.goto(`${base}/ask`);
    await page.getByLabel('Ask StockChief').fill('How many Black Tee Small do we have across both warehouses?');
    await Promise.all([page.waitForURL(`${base}/ask#latest`),page.getByRole('button',{name:'Continue'}).click()]);
    await page.screenshot({path:path.join(outputDirectory,'ask.png'),fullPage:false});

    await app.locals.sessionStore.close();
  } finally {
    if(browser)await browser.close();
    if(server)await new Promise((resolve)=>server.close(resolve));
    await database.close();
    cluster.stop();
  }
}

main().catch((error)=>{console.error(error);process.exitCode=1;});
