'use strict';

const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const assert=require('node:assert/strict');
const { startCluster }=require('../helpers/postgres-cluster');
const { openPostgres }=require('../../src/db/postgres');
const { migratePostgres }=require('../../src/db/migrate-postgres');
const auth=require('../../src/domain/postgres-auth-service');
const locations=require('../../src/domain/postgres-location-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const backups=require('../../src/operations/postgres-backup');

function databaseUrl(connectionString,name){const address=new URL(connectionString);address.pathname=`/${name}`;return address.toString();}

test('PostgreSQL backup restores every table count and critical business total into a separate empty database',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const source=openPostgres(cluster.connectionString,{applicationName:'stockchief-backup-source',max:3});
    let target=null;
    context.after(async()=>{if(target)await target.close();await source.close();cluster.stop();});
    await migratePostgres(source);
    const identity=await auth.createBusiness(source,{name:'Recovery Owner',businessName:'Recovery Business',
      email:'recovery@example.test',password:'recovery-password',now:'2026-09-23T12:00:00.000Z'});
    const ctx={workspaceId:identity.workspaceId,actorId:identity.userId};
    const location=await locations.createLocation(source,ctx,{name:'Recovery Warehouse',kind:'warehouse'});
    const item=await catalog.createItem(source,ctx,{name:'Recovery Widget',baseCode:'REC-WIDGET',trackingMode:'quantity'});
    await inventory.receive(source,ctx,{skuId:item.skuIds[0],locationId:location.id,quantity:37,
      reference:'RECOVERY-OPENING',notes:'Verified recovery fixture',idempotencyKey:'recovery-opening'});

    const backupDirectory=path.join(cluster.directory,'backups');
    const created=await backups.create(source,cluster.connectionString,{directory:backupDirectory,
      name:'recovery.dump',now:new Date('2026-09-23T13:00:00.000Z')});
    assert.ok(fs.statSync(created.path).size>0);
    assert.equal(created.manifest.snapshot.critical.workspaces,1);
    assert.equal(created.manifest.snapshot.critical.onHand,37);

    await source.query('CREATE DATABASE stockchief_restore_fixture');
    const targetUrl=databaseUrl(cluster.connectionString,'stockchief_restore_fixture');
    target=openPostgres(targetUrl,{applicationName:'stockchief-backup-target',max:2});
    const restored=await backups.restore(target,targetUrl,created.path);
    assert.equal(restored.restored.fingerprint,created.manifest.snapshot.fingerprint);
    assert.deepEqual(restored.restored.tableCounts,created.manifest.snapshot.tableCounts);
    assert.equal((await target.query('SELECT on_hand FROM balances WHERE sku_id=$1 AND location_id=$2',
      [item.skuIds[0],location.id])).rows[0].on_hand,'37');
    assert.equal((await target.query('SELECT email FROM accounts WHERE id=$1',[identity.accountId])).rows[0].email,'recovery@example.test');
    await assert.rejects(backups.restore(target,targetUrl,created.path),/not empty/i);

    const damaged=path.join(backupDirectory,'damaged.dump');
    fs.copyFileSync(created.path,damaged);fs.copyFileSync(created.manifestPath,`${damaged}.manifest.json`);
    fs.appendFileSync(damaged,'damaged');
    await source.query('CREATE DATABASE stockchief_restore_damaged');
    const damagedUrl=databaseUrl(cluster.connectionString,'stockchief_restore_damaged');
    const damagedDatabase=openPostgres(damagedUrl,{applicationName:'stockchief-backup-damaged',max:1});
    try{await assert.rejects(backups.restore(damagedDatabase,damagedUrl,damaged),/checksum/i);}
    finally{await damagedDatabase.close();}
  });
