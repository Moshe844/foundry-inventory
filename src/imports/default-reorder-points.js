'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
const Database=require('better-sqlite3'),exact=require('../domain/exact-quantity'),{nowIso}=require('../lib/util');
const READ_PAGE=5000,WRITE_PAGE=1000;

// The temporary index bounds RAM and is rebuildable. Approved source rows and
// every business effect remain durable in PostgreSQL.
async function apply(client,ctx,importId,{beforePage}={}){
 await beforePage?.();
 // A global owner rule covers every position for its SKU. When every SKU
 // already has one, a million-position source needs no default preparation.
 const uncovered=(await client.query('SELECT EXISTS(SELECT 1 FROM skus s WHERE s.workspace_id=$1 AND NOT EXISTS(SELECT 1 FROM reorder_policies p WHERE p.workspace_id=$1 AND p.sku_id=s.id AND p.location_id IS NULL)) uncovered',[ctx.workspaceId])).rows[0].uncovered;
 if(!uncovered)return 0;
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-reorder-defaults-'));let scratch;
 try{
  scratch=new Database(path.join(directory,'source.sqlite'));
  scratch.pragma('journal_mode=OFF');scratch.pragma('synchronous=OFF');scratch.pragma('cache_size=-16384');scratch.pragma('mmap_size=0');scratch.pragma('temp_store=FILE');
  scratch.exec('CREATE TABLE source(sku_id TEXT NOT NULL,location_id TEXT NOT NULL,item_id TEXT NOT NULL,quantity TEXT,quantity_sort TEXT,row_number INTEGER NOT NULL,PRIMARY KEY(sku_id,location_id)) WITHOUT ROWID');
  const put=scratch.prepare('INSERT INTO source VALUES(?,?,?,?,?,?) ON CONFLICT(sku_id,location_id) DO UPDATE SET item_id=excluded.item_id,quantity=excluded.quantity,quantity_sort=excluded.quantity_sort,row_number=excluded.row_number WHERE excluded.row_number>source.row_number');
  const store=scratch.transaction(rows=>{for(const row of rows){
   if(!row.sku_id||!row.location_id)continue;
   const quantity=row.quantity===null?null:exact.canonical(row.quantity,{signed:true});
   // A fixed decimal key preserves exact stock order without float conversion.
   const positive=quantity!==null&&!quantity.startsWith('-')&&quantity!=='0',parts=positive?quantity.split('.'):null;
   const sort=parts?parts[0].padStart(16,'0')+'.'+(parts[1]||'').padEnd(6,'0'):null;
   put.run(row.sku_id,row.location_id,row.item_id,quantity,sort,Number(row.row_number));
  }});
  let lastRow=-1,lastId='';
  for(;;){
   await beforePage?.();
   const rows=(await client.query('SELECT id,row_number,sku_id,location_id,item_id,coalesce(parsed::jsonb->>\'quantity\',quantity::text) quantity FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status=\'IMPORTED\' AND (row_number,id)>($3::bigint,$4::text) ORDER BY row_number,id LIMIT '+READ_PAGE,[ctx.workspaceId,importId,lastRow,lastId])).rows;
   if(!rows.length)break;store(rows);lastRow=Number(rows.at(-1).row_number);lastId=rows.at(-1).id;
  }
  scratch.exec('CREATE INDEX source_quantity ON source(quantity_sort) WHERE quantity_sort IS NOT NULL; CREATE INDEX source_product_quantity ON source(item_id,quantity_sort) WHERE quantity_sort IS NOT NULL');
  const stocked=scratch.prepare('SELECT count(*) n FROM source WHERE quantity_sort IS NOT NULL').get().n;
  if(!stocked)return 0;
  const usual=scratch.prepare('SELECT quantity FROM source WHERE quantity_sort IS NOT NULL ORDER BY quantity_sort LIMIT 1 OFFSET ?').get(Math.floor((stocked-1)/2)).quantity;
  scratch.exec('CREATE TABLE product_medians(item_id TEXT PRIMARY KEY,quantity TEXT NOT NULL) WITHOUT ROWID; INSERT INTO product_medians SELECT item_id,quantity FROM(SELECT item_id,quantity,row_number() OVER(PARTITION BY item_id ORDER BY quantity_sort) n,count(*) OVER(PARTITION BY item_id) total FROM source WHERE quantity_sort IS NOT NULL) WHERE n=(total+1)/2');
  const page=scratch.prepare('SELECT r.*,coalesce(m.quantity,?) fallback FROM source r LEFT JOIN product_medians m USING(item_id) WHERE (r.sku_id,r.location_id)>(?,?) ORDER BY r.sku_id,r.location_id LIMIT '+WRITE_PAGE);
  const at=nowIso();let sku='',location='',created=0;
  for(;;){
   await beforePage?.();
   const rows=page.all(usual,sku,location);if(!rows.length)break;
   const everywhere=new Set((await client.query('SELECT sku_id FROM reorder_policies WHERE workspace_id=$1 AND location_id IS NULL AND sku_id=ANY($2::text[])',[ctx.workspaceId,[...new Set(rows.map(r=>r.sku_id))]])).rows.map(r=>r.sku_id));
   const policies=rows.filter(r=>!everywhere.has(r.sku_id)).map(r=>({id:'rpol_'+createHash('sha256').update(importId+':'+r.sku_id+':'+r.location_id).digest('hex').slice(0,24),sku_id:r.sku_id,location_id:r.location_id,target:r.quantity_sort===null?r.fallback:r.quantity}));
   if(policies.length)created+=(await client.query("INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,notes,created_at,updated_at) SELECT x.id,$1,x.sku_id,x.location_id,0,x.target,0,'manual','Set when this SKU was imported: reorder when it runs out. Change it any time.',$2,$2 FROM jsonb_to_recordset($3::jsonb) AS x(id text,sku_id text,location_id text,target numeric) ON CONFLICT DO NOTHING",[ctx.workspaceId,at,JSON.stringify(policies)])).rowCount;
   sku=rows.at(-1).sku_id;location=rows.at(-1).location_id;
  }
  return created;
 }finally{
  scratch?.close();const resolved=path.resolve(directory),parent=path.resolve(os.tmpdir());
  if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('stockchief-reorder-defaults-'))throw Error('Unsafe reorder scratch cleanup path.');
  fs.rmSync(resolved,{recursive:true,force:true});
 }
}
async function afterStock(client,ctx,plan,executionId,{covered=false}={}){
 if(covered)return {state:'COMPLETE',created:0};
 if(plan.recordsValid<5000)return {state:'COMPLETE',created:await apply(client,ctx,plan.id)};
 const queued=await require('../operations/postgres-job-queue').enqueue({query:client.query.bind(client),transaction:fn=>fn(client)},{workspaceId:ctx.workspaceId,kind:'import.initialize-reorders',idempotencyKey:'import-reorders:'+plan.id,payload:{importId:plan.id,executionId},priority:60,maxAttempts:5});
 return {state:'QUEUED',jobId:queued.job.id};
}
async function run(job,database){
 const ready=(await database.query("SELECT 1 FROM import_plans p JOIN import_executions e ON e.workspace_id=p.workspace_id AND e.import_id=p.id JOIN import_verifications v ON v.workspace_id=e.workspace_id AND v.execution_id=e.id AND v.verified=1 WHERE p.workspace_id=$1 AND p.id=$2 AND e.id=$3 AND p.status='SUCCEEDED' AND e.status='SUCCEEDED'",[job.workspaceId,job.payload.importId,job.payload.executionId])).rows.length;
 if(!ready)return {state:'NOT_REQUIRED',created:0};
 const beforePage=async()=>{if(!job.leaseToken)return;const valid=(await database.query("SELECT 1 FROM stockchief_runtime.jobs WHERE id=$1 AND workspace_id=$2 AND status='RUNNING' AND lease_token=$3 AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000)",[job.id,job.workspaceId,job.leaseToken])).rows.length;if(!valid)throw Object.assign(Error('Reorder preparation stopped because its worker lease changed. Saved stock is unaffected.'),{code:'job_lease_lost'});};
 return {state:'COMPLETE',created:await apply(database,{workspaceId:job.workspaceId},job.payload.importId,{beforePage})};
}
module.exports={apply,afterStock,run};
