'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');

test('direct upload is tenant scoped, idempotent, requires approval and keeps stock/cost verification; outbox survives publish failure',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const direct=require('../../src/imports/postgres-direct-uploads'),uploads=require('../../src/imports/postgres-source-uploads');
 const jobs=require('../../src/operations/postgres-job-queue'),imports=require('../../src/imports/postgres-service');
 const bytes=Buffer.from(`Product,SKU,Location,Quantity,Unit cost\nAWS Coffee,AWS-COFFEE,${f.location.name},2,3.00`);
 const sourceHash=crypto.createHash('sha256').update(bytes).digest('hex');let signed,reads=0;
 const transport={async upload(row){signed=row;return {url:'https://s3.invalid',fields:{}};},async inspect(){return 'source-version-1';},async read(row){assert.equal(row.version_id,'source-version-1');reads++;return bytes;}};
 const input={filename:'coffee.csv',bytes:bytes.length,sha256:sourceHash,requestKey:'aws-upload-fixture'};
 const first=await direct.prepare(db,ctx,input,{transport});
 assert.equal((await direct.prepare(db,ctx,input,{transport})).id,first.id);
 assert.equal(signed.workspace_id,ctx.workspaceId);
 await assert.rejects(direct.prepare(db,ctx,{...input,sha256:'a'.repeat(64)},{transport}),/different file/);
 const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other',businessName:'Other tenant',email:crypto.randomUUID()+'@example.test',password:'OtherFixture!'+crypto.randomUUID()});
 await assert.rejects(direct.complete(db,{workspaceId:other.workspaceId,actorId:other.userId},first.id,{transport}),/not found/);
 await Promise.all([direct.complete(db,ctx,first.id,{transport}),direct.complete(db,ctx,first.id,{transport})]);
 assert.equal((await db.query('SELECT count(*)::int n FROM import_source_uploads WHERE id=$1',[first.id])).rows[0].n,1);
 const job=(await db.query("SELECT id FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='import.analyse-source.aws'",[ctx.workspaceId])).rows[0];
 assert.ok(job);
 await assert.rejects(require('../../src/imports/aws-outbox').publish(db,{notify:async()=>{throw new Error('simulated SQS outage');}}),/SQS outage/);
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.import_transport_outbox WHERE job_id=$1',[job.id])).rows[0].n,1);
 const notified=[];
 await require('../../src/imports/aws-outbox').publish(db,{notify:async id=>notified.push(id)});
 assert.ok(notified.includes(job.id));
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.import_transport_outbox WHERE job_id=$1',[job.id])).rows[0].n,0);
 const handler=Object.assign((job,db)=>uploads.run(job,db,{sourceTransport:transport}),{externalEffect:true});
 const analysed=await jobs.processOne(db,{'import.analyse-source.aws':handler},{owner:'aws-fixture-reader'});
 assert.equal(analysed.status,'COMPLETED',JSON.stringify(analysed.lastError));assert.equal(reads,1);
 const plan=await imports.get(db,ctx.workspaceId,analysed.result.planId);
 assert.equal(plan.recordsInvalid,0);assert.equal(plan.recordsValid,1);
 assert.equal(await f.balance(),4,'Reading an S3 file cannot change stock');
 await assert.rejects(imports.queueExecution(db,ctx,plan.id,plan.integrityHash),/approve/);
 await imports.approveAndQueue(db,ctx,plan.id,plan.integrityHash);
 const handlers=require('../../src/imports/aws-worker').dedicatedHandlers(require('../../src/operations/postgres-runtime-handlers').create());
 const executed=await jobs.processOne(db,{'import.execute-approved':handlers['import.execute-approved']},{owner:'aws-fixture-apply'});
 assert.equal(executed.status,'COMPLETED',JSON.stringify(executed.lastError));assert.equal(executed.result.verified,true);
 assert.equal(await f.balance(),6);
 const value=(await db.query(`SELECT b.on_hand,c.total_cost_minor FROM balances b
  JOIN skus s ON s.id=b.sku_id AND s.workspace_id=b.workspace_id
  JOIN accounting_inventory_cost_balances c ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id
  WHERE b.workspace_id=$1 AND s.code='AWS-COFFEE'`,[ctx.workspaceId])).rows[0];
 assert.equal(Number(value.on_hand),2);assert.equal(Number(value.total_cost_minor),600);
 assert.equal(await jobs.processOne(db,{'import.execute-approved':handlers['import.execute-approved']},{owner:'duplicate-wake'}),null,'Repeated queue delivery cannot apply stock twice');
 const expired=await direct.prepare(db,ctx,{...input,requestKey:'expired-intent'},{transport});
 await db.query("UPDATE import_external_uploads SET expires_at=now()-interval '1 minute' WHERE id=$1",[expired.id]);
 await require('../../src/imports/aws-outbox').cleanupExpired(db);
 assert.equal((await db.query('SELECT count(*)::int n FROM import_external_uploads WHERE id=$1',[expired.id])).rows[0].n,0);
 assert.equal((await db.query("SELECT count(*)::int n FROM commercial_storage_reservations WHERE workspace_id=$1 AND reservation_key=$2",[ctx.workspaceId,'upload:'+expired.id])).rows[0].n,0,'Abandoned uploads cannot leak a permanent storage reservation');
});
