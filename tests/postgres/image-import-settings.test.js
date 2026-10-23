'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

test('image columns become operational reorder settings and retained custom details after approval', {timeout:240000}, async t=>{
  const cluster=await require('../helpers/postgres-cluster').startCluster();
  const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
  t.after(async()=>{await db.close();await cluster.stop();});
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{
    name:'Owner',businessName:'Image settings evidence',email:randomUUID()+'@example.test',password:randomUUID()+'!A'});
  const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
  const location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Count room',kind:'warehouse'});
  const {createCanvas}=require('@napi-rs/canvas');
  const canvas=createCanvas(2450,360),c=canvas.getContext('2d');
  c.fillStyle='#fff';c.fillRect(0,0,canvas.width,canvas.height);c.font='25px Arial';
  const columns=[['SKU',25],['Product Name',265],['Quantity',650],['Reorder Point',850],['Target Stock',1150],['Safety Stock',1440],['Lead Time Days',1730],['Handling guidance',2090]];
  c.fillStyle='#143751';c.fillRect(0,20,canvas.width,65);c.fillStyle='#fff';
  for(const [label,x] of columns)c.fillText(label,x,62);
  const source=[['RACK-62','Bamboo rack',19,7,27,3,6,'Polished'],['MAT-83','Cork mat',8,4,20,2,9,'Natural']];
  c.fillStyle='#172c40';
  for(const [i,row] of source.entries())for(const [j,[,x]] of columns.entries())c.fillText(String(row[j]),x,145+i*80);
  const imports=require('../../src/imports/postgres-service');
  const plan=await imports.analyse(db,ctx,{buffer:canvas.toBuffer('image/png'),filename:'stock-settings.png',allowModel:false,defaultLocationId:location.id});
  assert.equal(plan.recordsDetected,source.length);
  for(const name of ['reorderPoint','targetStock','safetyStock','leadTimeDays'])assert.notEqual(plan.fieldMappings[name],undefined,'recognized image heading: '+name);
  await imports.revise(db,ctx,plan.id,{expectedHash:plan.integrityHash,confirmImageReading:true});
  const ready=await imports.get(db,ctx.workspaceId,plan.id);
  const rows=await imports.rowsFor(db,ctx.workspaceId,plan.id);
  t.diagnostic(JSON.stringify({columns:ready.sourceColumns,mappings:ready.fieldMappings,facts:rows.map(r=>r.parsed.sourceFacts)}));
  assert.equal(ready.recordsInvalid,0,JSON.stringify(rows.map(r=>({code:r.parsed.code,problems:r.problems}))));
  assert.deepEqual(rows.map(r=>r.parsed.reorder),source.map(r=>({reorderPoint:r[3],targetStock:r[4],safetyStock:r[5],leadTimeDays:r[6]})));
  assert.deepEqual(rows.map(r=>r.parsed.sourceFacts['Handling guidance']),source.map(r=>r[7]));
  assert.equal((await db.query('SELECT count(*)::int n FROM reorder_policies WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
  await imports.approve(db,ctx,plan.id,ready.integrityHash);
  assert.equal((await imports.execute(db,ctx,plan.id)).verified,true);
  const policies=(await db.query(`SELECT sku.code,p.reorder_point,p.target_stock,p.safety_stock,p.lead_time_days
    FROM reorder_policies p JOIN skus sku ON sku.workspace_id=p.workspace_id AND sku.id=p.sku_id
    WHERE p.workspace_id=$1 ORDER BY sku.code DESC`,[ctx.workspaceId])).rows;
  assert.deepEqual(policies.map(p=>[p.code,...['reorder_point','target_stock','safety_stock','lead_time_days'].map(k=>Number(p[k]))]),source.map(r=>[r[0],r[3],r[4],r[5],r[6]]));
  const facts=await require('../../src/domain/postgres-catalog-facts').exportRows(db,ctx.workspaceId);
  assert.deepEqual(facts.filter(f=>f.name==='Handling guidance').map(f=>f.value).sort(),source.map(r=>r[7]).sort());
  const firstSku=(await db.query('SELECT id FROM skus WHERE workspace_id=$1 AND code=$2',[ctx.workspaceId,source[0][0]])).rows[0].id;
  const at=new Date().toISOString();
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,source,created_at,updated_at)
    VALUES($1,$2,$3,NULL,1,'manual',$4,$4)`,[randomUUID(),ctx.workspaceId,firstSku,at]);
  const position=(await require('../../src/forecasting/postgres-planning-service').position(db,ctx.workspaceId))
    .find(p=>p.sku_id===firstSku&&p.location_id===location.id);
  assert.equal(position.reorderPoint,7,'a location-specific imported setting overrides the all-locations default');
  assert.equal((await imports.execute(db,ctx,plan.id)).duplicate,true);
  assert.equal((await db.query('SELECT sum(on_hand)::int n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,27);
});
