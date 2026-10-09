'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { chromium }=require('playwright');
const { startCluster }=require('../helpers/postgres-cluster');
const { openPostgres }=require('../../src/db/postgres');
const { migratePostgres }=require('../../src/db/migrate-postgres');
const { createPostgresApp }=require('../../src/postgres-app');
const imports=require('../../src/imports/postgres-service');
const assistant=require('../../src/assistant/postgres-service');
const reports=require('../../src/reports/postgres-service');
const ledger=require('../../src/accounting/postgres-ledger');
const fs=require('node:fs');
const path=require('node:path');

test('real Chromium previews, approves, imports and reconciles PostgreSQL inventory with duplicate and rollback safety',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-imports-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-imports-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{
      await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();
    });
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const errors=[];page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(20000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Import Business');
    await page.getByLabel('Your name').fill('Import Owner');
    await page.getByLabel('Work email').fill('imports-pg@example.test');
    await page.getByLabel('Password').fill('imports-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    await page.goto(`${base}/locations`);
    await page.getByRole('button',{name:'Add your first location'}).click();
    await page.getByLabel('Name',{exact:true}).fill('Main Warehouse');
    await page.getByLabel('Type',{exact:true}).selectOption('warehouse');
    await Promise.all([page.waitForNavigation(),page.locator('#modal-location').getByRole('button',{name:'Add location'}).click()]);
    await page.goto(`${base}/onboarding`);
    const source=Buffer.from('Product,SKU,Size,Location,Quantity\nTrail Shoe,SHOE-8,8,Main Warehouse,7\nTrail Shoe,SHOE-9,9,Main Warehouse,5\n');
    await page.getByLabel('Inventory spreadsheets').setInputFiles({name:'opening-stock.csv',mimeType:'text/csv',buffer:source});
    await page.waitForURL(/\/imports\/imp_/);
    assert.match(await page.locator('main').innerText(),/2 rows read · 2 ready · 0 need correction/);
    assert.match(await page.locator('main').innerText(),/No inventory changed yet/);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='imports-pg@example.test'`)).rows[0];
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM items WHERE workspace_id=$1',[identity.workspace_id])).rows[0].count,'0');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve 2 rows'}).click()]);
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM items WHERE workspace_id=$1',[identity.workspace_id])).rows[0].count,'0');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Import and verify'}).click()]);
    const main=await page.locator('main').innerText();
    assert.match(main,/Verified/);assert.match(main,/2 rows created 1 product, 2 SKUs and 12 opening units/);
    const truth=(await database.query(`SELECT COUNT(DISTINCT i.id) AS items,COUNT(DISTINCT s.id) AS skus,
      COALESCE(SUM(b.on_hand),0) AS units,COALESCE(SUM(m.quantity_delta),0) AS ledger_units
      FROM items i JOIN skus s ON s.item_id=i.id LEFT JOIN balances b ON b.sku_id=s.id
      LEFT JOIN movements m ON m.sku_id=s.id WHERE i.workspace_id=$1`,[identity.workspace_id])).rows[0];
    assert.deepEqual(truth,{items:'1',skus:'2',units:'12',ledger_units:'12'});

    await page.goto(`${base}/onboarding?add=1`);
    await page.getByLabel('Inventory spreadsheets').setInputFiles({name:'opening-stock.csv',mimeType:'text/csv',buffer:source});
    await page.waitForURL(/\/imports\/imp_/);
    const duplicateMain=await page.locator('main').innerText();
    assert.match(duplicateMain,/This exact source was already imported/);
    assert.match(duplicateMain,/Approve 2 rows/);
    assert.equal(await page.getByRole('button',{name:'Approve 2 rows'}).isDisabled(),true);
    assert.deepEqual((await database.query(`SELECT COUNT(*) AS items,COALESCE((SELECT SUM(on_hand) FROM balances
      WHERE workspace_id=$1),0) AS units FROM items WHERE workspace_id=$1`,[identity.workspace_id])).rows[0],
    {items:'1',units:'12'});

    await page.goto(`${base}/ask`);
    const askSource=Buffer.from('Product,SKU,Location,Quantity\nAsk Imported Valve,ASK-VALVE-1,Main Warehouse,9\n');
    await page.locator('input[type="file"][name="file"]').setInputFiles({
      name:'ask-inventory.csv',mimeType:'text/csv',buffer:askSource});
    await Promise.all([page.waitForURL(/\/imports\/imp_/),page.getByRole('button',{name:'Continue'}).click()]);
    assert.match(await page.locator('main').innerText(),/1 row read · 1 ready · 0 need correction/);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM items WHERE workspace_id=$1
      AND name='Ask Imported Valve'`,[identity.workspace_id])).rows[0].count,0);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve 1 row'}).click()]);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Import and verify'}).click()]);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM items WHERE workspace_id=$1
      AND name='Ask Imported Valve'`,[identity.workspace_id])).rows[0].count,1);

    // A readable file with unfamiliar headings must reach the existing
    // human-correctable preview instead of failing its Ask upload outright.
    const unknownSource=Buffer.from('Alpha,Beta,Gamma\nOdd Widget,OW-1,5\nOther Widget,OW-2,3\n');
    // Force an unresolved interpretation rather than relying on whichever AI
    // provider happens to be configured in this test environment.
    const unknownPlan=await imports.analyse(database,{workspaceId:identity.workspace_id,
      actorId:identity.actor_id},{buffer:unknownSource,filename:'unfamiliar-columns.csv',
      mappings:{notes:0}});
    const unknownId=unknownPlan.id;
    await page.goto(`${base}/imports/${unknownId}`);
    assert.equal(unknownPlan.detectedType,'unknown');
    assert.equal(unknownPlan.recordsValid,0);
    assert.match(await page.locator('main').innerText(),/Help StockChief identify the products/);
    assert.equal(await page.getByRole('button',{name:'Approve 0 rows'}).isDisabled(),true);
    await assert.rejects(imports.approve(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},
      unknownId,unknownPlan.integrityHash),/Map a product name or SKU/);
    await page.getByLabel('Source column “Alpha”').selectOption('name');
    await page.getByLabel('Source column “Beta”').selectOption('code');
    await page.getByLabel('Source column “Gamma”').selectOption('quantity');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Recalculate preview'}).click()]);
    assert.match(await page.locator('main').innerText(),/2 rows read · 2 ready · 0 need correction/);
    assert.equal((await imports.get(database,identity.workspace_id,unknownId)).detectedType,'inventory');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve 2 rows'}).click()]);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Import and verify'}).click()]);
    assert.match(await page.locator('main').innerText(),/8 opening units/);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM skus WHERE workspace_id=$1
      AND code IN ('OW-1','OW-2')`,[identity.workspace_id])).rows[0].count,2);

    await page.goto(`${base}/ask`);
    const unusual=Buffer.from('Part reference,What we call it,How many are on shelf,Where we keep it\n'+
      'CERT-SEAL-1,Certification Seal One,12,Main Warehouse\n'+
      'CERT-SEAL-2,Certification Seal Two,7,Main Warehouse\n');
    await page.locator('input[type="file"][name="file"]').setInputFiles({
      name:'unusual-headings.csv',mimeType:'text/csv',buffer:unusual});
    await Promise.all([page.waitForURL(/\/imports\/imp_/),page.getByRole('button',{name:'Continue'}).click()]);
    const unusualPlan=await imports.get(database,identity.workspace_id,page.url().split('/').at(-1));
    assert.equal(unusualPlan.fieldMappings.quantity,2);
    assert.equal(unusualPlan.recordsValid,2,JSON.stringify({mappings:unusualPlan.fieldMappings,
      rows:await imports.rowsFor(database,identity.workspace_id,unusualPlan.id)}));
    assert.match(await page.locator('main').innerText(),/12.*7/s);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve 2 rows'}).click()]);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Import and verify'}).click()]);
    assert.match(await page.locator('main').innerText(),/19 opening units/);
    assert.equal(Number((await database.query(`SELECT COALESCE(SUM(b.on_hand),0) AS units
      FROM balances b JOIN skus s ON s.id=b.sku_id AND s.workspace_id=b.workspace_id
      WHERE b.workspace_id=$1 AND s.code IN ('CERT-SEAL-1','CERT-SEAL-2')`,
    [identity.workspace_id])).rows[0].units),19);

    const ambiguous=Buffer.from('SKU,Product,Metric X,Location\nCERT-COUNT-1,Certification Count One,8,Main Warehouse\n');
    const ambiguousPlan=await imports.analyse(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},
      {text:ambiguous.toString('utf8'),filename:'ambiguous-metric.csv',
        mappings:{code:0,name:1,location:3}});
    const ambiguousId=ambiguousPlan.id;
    await page.goto(`${base}/imports/${ambiguousId}`);
    assert.equal(ambiguousPlan.fieldMappings.quantity,undefined);
    assert.deepEqual(ambiguousPlan.transformations.unmappedNumericColumns,['Metric X']);
    assert.equal(await page.getByRole('button',{name:'Approve 1 row'}).isDisabled(),true);
    await assert.rejects(imports.approve(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},
      ambiguousId,ambiguousPlan.integrityHash),/numeric source column was not mapped/i);
    await database.query(`UPDATE import_plans SET transformations=(transformations::jsonb-'unmappedNumericColumns')::text
      WHERE workspace_id=$1 AND id=$2`,[identity.workspace_id,ambiguousId]);
    await assert.rejects(imports.approve(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},
      ambiguousId,ambiguousPlan.integrityHash),/numeric source column was not mapped/i);
    await page.getByLabel('Source column “Metric X”').selectOption('quantity');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Recalculate preview'}).click()]);
    assert.equal((await imports.get(database,identity.workspace_id,ambiguousId)).fieldMappings.quantity,2);
    assert.equal(await page.getByRole('button',{name:'Approve 1 row'}).isEnabled(),true);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve 1 row'}).click()]);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Import and verify'}).click()]);
    assert.match(await page.locator('main').innerText(),/8 opening units/);

    for(const [name,kind] of [['Lab Main Warehouse','warehouse'],['Lab Overflow Shelf','shelf']]){
      await page.goto(`${base}/locations`);
      await page.getByRole('button',{name:'Add location',exact:true}).first().click();
      const dialog=page.locator('#modal-location');
      await dialog.getByLabel('Name',{exact:true}).fill(name);
      await dialog.getByLabel('Type',{exact:true}).selectOption(kind);
      await Promise.all([page.waitForNavigation(),dialog.getByRole('button',{name:'Add location'}).click()]);
    }
    await page.goto(`${base}/ask`);
    await page.locator('input[type="file"][name="file"]').setInputFiles({
      name:'ask-import-stock.pdf',mimeType:'application/pdf',
      buffer:fs.readFileSync(path.join(__dirname,'../fixtures/ask-import-stock.pdf'))});
    await Promise.all([page.waitForURL(/\/imports\/imp_/),page.getByRole('button',{name:'Continue'}).click()]);
    assert.match(await page.locator('main').innerText(),/3 rows read · 3 ready · 0 need correction/);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM skus WHERE workspace_id=$1
      AND code IN ('LAB-PT-012','LAB-BN-015','LAB-PC-022')`,[identity.workspace_id])).rows[0].count,0);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve 3 rows'}).click()]);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Import and verify'}).click()]);
    assert.match(await page.locator('main').innerText(),/3 rows created/);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM skus WHERE workspace_id=$1
      AND code IN ('LAB-PT-012','LAB-BN-015','LAB-PC-022')`,[identity.workspace_id])).rows[0].count,3);

    await page.goto(`${base}/ask`);
    const correctionSource=Buffer.from('Product,SKU,Location,Quantity\nCorrected Tape,CORR-TAPE,Old Warehouse,6\nCorrected Valve,CORR-VALVE,Old Warehouse,invalid\n');
    await page.locator('input[type="file"][name="file"]').setInputFiles({
      name:'needs-correction.csv',mimeType:'text/csv',buffer:correctionSource});
    await Promise.all([page.waitForURL(/\/imports\/imp_/),page.getByRole('button',{name:'Continue'}).click()]);
    assert.match(await page.locator('main').innerText(),/2 rows read · 0 ready · 2 need correction/);
    const correctionId=page.url().split('/').at(-1);
    const staleHash=(await imports.get(database,identity.workspace_id,correctionId)).integrityHash;
    const other=await browser.newPage();
    await other.goto(`${base}/register`);
    await other.getByLabel('Business name').fill('Other Import Business');
    await other.getByLabel('Your name').fill('Other Owner');
    await other.getByLabel('Work email').fill('other-imports-pg@example.test');
    await other.getByLabel('Password').fill('other-import-password');
    await Promise.all([other.waitForURL(`${base}/onboarding`),other.getByRole('button',{name:'Create account'}).click()]);
    const otherIdentity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id
      WHERE a.email='other-imports-pg@example.test'`)).rows[0];
    await assert.rejects(imports.revise(database,{workspaceId:otherIdentity.workspace_id,
      actorId:otherIdentity.actor_id},correctionId,{expectedHash:staleHash}),/not be found/i);
    await page.getByLabel(/Source location “Old Warehouse”/).selectOption({label:'Main Warehouse'});
    await page.getByLabel(/Row 3 · Corrected Valve quantity/).fill('4');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Recalculate preview'}).click()]);
    assert.match(await page.locator('main').innerText(),/2 rows read · 2 ready · 0 need correction/);
    await assert.rejects(imports.revise(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},
      correctionId,{expectedHash:staleHash,locationMappings:{'Old Warehouse':'not-this-workspace'}}),
    /preview changed/i);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM skus WHERE workspace_id=$1
      AND code IN ('CORR-TAPE','CORR-VALVE')`,[identity.workspace_id])).rows[0].count,0);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve 2 rows'}).click()]);
    await assert.rejects(imports.revise(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},
      correctionId,{expectedHash:(await imports.get(database,identity.workspace_id,correctionId)).integrityHash}),
    /unapproved preview/i);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Import and verify'}).click()]);
    assert.match(await page.locator('main').innerText(),/2 rows created 2 products, 2 SKUs and 10 opening units/);

    const variantPlan=await imports.analyse(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},{
      text:'Product,SKU,Size,Location,Quantity\nVariant Gloves,VG-400,Small,Main Warehouse,3\nVariant Gloves,VG-400,Large,Main Warehouse,4\n',
      filename:'reused-base-code.csv'});
    assert.equal(variantPlan.recordsValid,2);
    await imports.approve(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},
      variantPlan.id,variantPlan.integrityHash);
    await imports.execute(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},variantPlan.id);
    const variants=(await database.query(`SELECT s.variant_label,s.code,COALESCE(SUM(b.on_hand),0)::int AS units
      FROM items i JOIN skus s ON s.item_id=i.id AND s.workspace_id=i.workspace_id
      LEFT JOIN balances b ON b.sku_id=s.id AND b.workspace_id=s.workspace_id
      WHERE i.workspace_id=$1 AND i.name='Variant Gloves'
      GROUP BY s.id ORDER BY s.variant_label`,[identity.workspace_id])).rows;
    assert.deepEqual(variants.map((row)=>({label:row.variant_label,units:row.units})),
      [{label:'Large',units:4},{label:'Small',units:3}]);
    assert.equal(new Set(variants.map((row)=>row.code)).size,2);

    await database.query('UPDATE accounting_settings SET enabled=0 WHERE workspace_id=$1',[identity.workspace_id]);
    const unconfiguredCost=await imports.analyse(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},{
      text:'Product,SKU,Location,Quantity,Unit Cost,Selling Price\nCosted Valve,COST-1,Main Warehouse,3,12.50,24.00\n',
      filename:'costed-opening.csv'});
    assert.equal(unconfiguredCost.fieldMappings.unitCost,4,
      `Unit Cost must be mapped, not silently dropped: ${JSON.stringify(unconfiguredCost.fieldMappings)}`);
    assert.equal(unconfiguredCost.recordsInvalid,1);
    assert.match((await imports.rowsFor(database,identity.workspace_id,unconfiguredCost.id))[0].problems
      .map((entry)=>entry.message).join(' '),/Configure accounting/);
    await ledger.configure(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},
      {startDate:'2026-01-01',currency:'USD'});
    const costed=await imports.analyse(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},{
      text:'Product,SKU,Location,Quantity,Unit Cost,Selling Price\nCosted Valve,COST-1,Main Warehouse,3,12.50,24.00\n',
      filename:'costed-opening-after-accounting.csv'});
    assert.equal(costed.recordsValid,1);
    await imports.approve(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},
      costed.id,costed.integrityHash);
    const costRun=await imports.execute(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},costed.id);
    assert.equal(costRun.verified,true);
    assert.deepEqual(costRun.checks.slice(-3).map((check)=>check.ok),[true,true,true]);
    assert.equal(costRun.checks.at(-2).observed,3750);
    assert.equal(costRun.checks.at(-1).observed,3750);
    assert.equal((await database.query(`SELECT amount_minor::int AS price FROM sku_prices
      WHERE workspace_id=$1 AND sku_id IN (SELECT sku_id FROM import_rows WHERE import_id=$2)`,
    [identity.workspace_id,costed.id])).rows[0].price,2400);
    const costEvidence=await assistant.lookup(database,{workspaceId:identity.workspace_id,
      actorId:identity.actor_id},{view:'purchase_costs',search:'COST-1'});
    assert.equal(costEvidence.rows.length,1);
    assert.equal(costEvidence.rows[0].purchaseCost,'Not recorded');
    assert.equal(costEvidence.rows[0].inventoryBookCost,'$37.50');
    assert.equal(costEvidence.rows[0].openingImportCost,'$37.50');
    assert.equal(costEvidence.rows[0].openingImportUnits,3);
    const reportActor=(await database.query(`SELECT u.role,u.permissions,a.email FROM users u
      JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2`,
    [identity.workspace_id,identity.actor_id])).rows[0];
    const bookReport=await reports.run(database,{workspaceId:identity.workspace_id},reportActor,{
      dataset:'inventory_valuation',groups:['sku','currency'],aggregate:'sum',measure:'book_cost_minor',
      filters:[{field:'sku',operator:'equals',value:'COST-1'}],sort:'total'});
    assert.equal(bookReport.displayRows[0].total,'$37.50');
    const openingReport=await reports.run(database,{workspaceId:identity.workspace_id},reportActor,{
      dataset:'inventory_cost_movements',groups:['sku','currency'],aggregate:'sum',
      measure:'book_cost_change_minor',filters:[{field:'sku',operator:'equals',value:'COST-1'},
        {field:'source_kind',operator:'equals',value:'opening_inventory'}],sort:'total'});
    assert.equal(openingReport.displayRows[0].total,'$37.50');
    const costReplay=await imports.execute(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},costed.id);
    assert.equal(costReplay.duplicate,true);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM accounting_inventory_cost_movements
      WHERE workspace_id=$1 AND cost_source_record_id IN
        (SELECT id FROM import_rows WHERE import_id=$2)`,[identity.workspace_id,costed.id])).rows[0].count,1);

    const failing=await imports.analyse(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},{
      text:'Product,SKU,Location,Quantity\nRollback One,RB-1,Main Warehouse,3\nRollback Two,RB-2,Main Warehouse,4\n',
      filename:'rollback.csv'});
    await imports.approve(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},failing.id,failing.integrityHash);
    await assert.rejects(imports.execute(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},failing.id,{
      beforeGroup:({itemsCreated})=>{if(itemsCreated===1)throw new Error('simulated process failure');},
    }),/simulated process failure/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM items WHERE workspace_id=$1
      AND name IN ('Rollback One','Rollback Two')`,[identity.workspace_id])).rows[0].count,'0');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM movements WHERE workspace_id=$1
      AND reference LIKE 'Import rollback.csv%'`,[identity.workspace_id])).rows[0].count,'0');
    assert.equal((await database.query(`SELECT status FROM import_executions WHERE import_id=$1`,[failing.id])).rows[0].status,'FAILED');
    assert.deepEqual(errors,[]);
  });
