'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const inventory=require('../../src/domain/postgres-inventory-engine');
const ledger=require('../../src/accounting/postgres-ledger');const feeds=require('../../src/connections/postgres-service');
const ingestion=require('../../src/connections/postgres-event-ingestion');

test('ERP and tracked-stock correctness regressions',{timeout:180000},async t=>{
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString,{max:5});
 t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 const at='2026-10-29T12:00:00.000Z';
 await db.query("INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES('a','erp-regressions@example.test','Audit','fixture',$1)",[at]);
 await db.query("INSERT INTO workspaces(id,name,owner_account_id,created_at) VALUES('w','Audit','a',$1)",[at]);
 await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES('u','w','a','Audit','owner',$1)",[at]);
 await db.query("INSERT INTO locations(id,workspace_id,name,kind,is_active,created_at) VALUES('l','w','Main','warehouse',1,$1),('l2','w','Other','warehouse',1,$1)",[at]);
 for(const mode of ['quantity','serial','lot']){
  await db.query('INSERT INTO items(id,workspace_id,name,tracking_mode,is_active,created_at,updated_at) VALUES($1,\'w\',$2,$2,1,$3,$3)',['i-'+mode,mode,at]);
  await db.query('INSERT INTO skus(id,workspace_id,item_id,code,is_default,is_active,created_at) VALUES($1,\'w\',$2,$1,1,1,$3)',['s-'+mode,'i-'+mode,at]);
 }
 const ctx={workspaceId:'w',actorId:'u',accountId:'a'};
 await t.test('foreign-currency postings fail atomically without conversion evidence',async()=>{
  await ledger.configure(db,ctx,{startDate:'2026-01-01',currency:'USD'});
  const entry={postingDate:'2026-10-29',sourceKey:'foreign',currency:'EUR',lines:[{accountKey:'CASH',debitMinor:10000},{accountKey:'SALES_REVENUE',creditMinor:10000}]};
  await assert.rejects(ledger.post(db,ctx,entry),/currency conversion/);
  assert.equal(Number((await db.query("SELECT count(*) n FROM accounting_journal_entries WHERE workspace_id='w'")).rows[0].n),0);
  await ledger.post(db,ctx,{...entry,currency:'USD'});
 });
 await t.test('out-of-order snapshots and conflicting versions cannot overwrite stock',async()=>{
  const feed=await feeds.createFeed(db,ctx,{displayName:'Audit ERP'});const auth=await feeds.authenticate(db,`Bearer ${feed.token}`);
  const event=(id,version,count)=>({eventId:id,type:'inventory.adjust',version,data:{skuId:'s-quantity',locationId:'l',countedQuantity:count}});
  assert.equal((await ingestion.ingest(db,auth,event('new','2',20))).status,'COMPLETED');
  assert.equal((await ingestion.ingest(db,auth,event('old','1',5))).status,'STALE');
  assert.equal((await ingestion.ingest(db,auth,event('new','2',20))).replayed,true);
  await assert.rejects(ingestion.ingest(db,auth,event('conflict','2',99)),/conflicting quantities/);
  await assert.rejects(ingestion.ingest(db,auth,event('unversioned',null,8)),/version|timestamp/);
  await Promise.all([ingestion.ingest(db,auth,event('v3','3',30)),ingestion.ingest(db,auth,event('v4','4',40))]);
  assert.equal(Number((await db.query("SELECT on_hand FROM balances WHERE sku_id='s-quantity' AND location_id='l'")).rows[0].on_hand),40);
 });
 await t.test('serialized batches survive transfer, issue and return with reconciled lot balances',async()=>{
  const receipt=await inventory.receive(db,ctx,{skuId:'s-serial',locationId:'l',quantity:2,serials:['A','B'],lotCode:'BATCH',expiresAt:'2099-12-31',idempotencyKey:'batch'});
  assert.ok(receipt.lotId);const ids=receipt.serialUnitIds;
  assert.equal((await db.query('SELECT lot_id FROM serial_units WHERE id=$1',[ids[0]])).rows[0].lot_id,receipt.lotId);
  const amount=async location=>Number((await db.query('SELECT quantity FROM lot_balances WHERE lot_id=$1 AND location_id=$2',[receipt.lotId,location])).rows[0]?.quantity||0);
  assert.equal(await amount('l'),2);
  await inventory.transfer(db,ctx,{skuId:'s-serial',sourceLocationId:'l',destinationLocationId:'l2',quantity:1,serialUnitIds:[ids[0]]});
  assert.equal(await amount('l'),1);assert.equal(await amount('l2'),1);
  await inventory.issue(db,ctx,{skuId:'s-serial',locationId:'l2',quantity:1,serialUnitIds:[ids[0]],reasonCode:'sold'});
  assert.equal(await amount('l2'),0);
  await inventory.receive(db,ctx,{skuId:'s-serial',locationId:'l',quantity:1,returnSerialUnitIds:[ids[0]]});
  assert.equal(await amount('l'),2);
  await db.transaction(c=>inventory.dispatchTransferInTransaction(c,ctx,{skuId:'s-serial',sourceLocationId:'l',destinationLocationId:'l2',quantity:1,serialUnitIds:[ids[0]],idempotencyKey:'dispatch'}));
  assert.equal(await amount('l'),1);
  await db.transaction(c=>inventory.receiveTransferInTransaction(c,ctx,{skuId:'s-serial',sourceLocationId:'l',destinationLocationId:'l2',quantity:1,serialUnitIds:[ids[0]],idempotencyKey:'arrive'}));
  assert.equal(await amount('l2'),1);
  assert.equal((await inventory.receive(db,ctx,{skuId:'s-serial',locationId:'l',quantity:2,serials:['A','B'],lotCode:'BATCH',idempotencyKey:'batch'})).replayed,true);
  assert.equal(await amount('l'),1);
 });
 await t.test('expired lot and serial stock require explicit disposal and rollback unsuccessful issues',async()=>{
  for(const mode of ['lot','serial']){
   const receipt=await inventory.receive(db,ctx,{skuId:'s-'+mode,locationId:'l',quantity:1,lotCode:'EXPIRED-'+mode,lotReceivedAt:'2019-01-01',expiresAt:'2020-01-01',serials:mode==='serial'?['EXPIRED']:undefined});
   const issue={skuId:'s-'+mode,locationId:'l',quantity:1,lotId:receipt.lotId,serialUnitIds:receipt.serialUnitIds,reasonCode:'sold'};
   await assert.rejects(inventory.issue(db,ctx,issue),/expired/);
   assert.equal(Number((await db.query('SELECT quantity FROM lot_balances WHERE lot_id=$1 AND location_id=\'l\'',[receipt.lotId])).rows[0].quantity),1);
   await inventory.issue(db,ctx,{...issue,reasonCode:'disposal'});
  }
 });
});
