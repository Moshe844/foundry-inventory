'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const service=require('../../src/imports/agent-exact-variant-import'),queue=require('../../src/operations/postgres-job-queue');
const xlsx=require('xlsx');
function workbook(type,sheets){
  const book=xlsx.utils.book_new();
  for(const [name,rows] of Object.entries(sheets))xlsx.utils.book_append_sheet(book,xlsx.utils.aoa_to_sheet(rows),name);
  return xlsx.write(book,{type:'buffer',bookType:type});
}
const text=lines=>Buffer.from(lines.join('\n'),'utf8');
const authority={automatic:'yes',authorized:'yes'};

async function fixture(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;
  await f.subscribe('growth');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const run=()=>queue.processOne(db,handlers,{owner:'exact-variant-test',kinds:[service.kind]});
  const submit=(buffer,options={})=>service.enqueue(db,ctx,{buffer,filename:'Original variants.csv',...options});
  const load=(id,options)=>service.load(db,ctx,id,options);
  const approve=async(id,extra={})=>service.approve(db,ctx,id,{reviewHash:(await load(id)).review_hash,confirmed:'yes',...extra});
  const variants=async prefix=>(await db.query(`SELECT i.id AS item_id,i.name,i.base_code,s.id,s.code,s.barcode,s.variant_label
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE i.workspace_id=$1 AND s.code LIKE $2 ORDER BY s.code`,
    [ctx.workspaceId,prefix+'%'])).rows;
  return {...f,run,submit,load,approve,variants};
}

function complete(job,status){
  assert.equal(job?.status,'COMPLETED',JSON.stringify(job?.lastError));
  assert.equal(job.result.status,status,JSON.stringify(job.result));
  return job.result;
}

test('Growth approves every exact workbook variant and later extends the same native family from CSV without stock or price changes',{timeout:300000},async t=>{
  const f=await fixture(t),{db,ctx}=f;
  const rows={Products:[['Product Code','Product Name'],['SHIRT-A','Exact Cotton Shirt']],
    Red:[['Parent SKU','Variant SKU','Color','Size','Barcode','Qty','Price'],['SHIRT-A','SHIRT-RS','Red','S','0000123456',24,'90']],
    Blue:[['Product Code','Variant SKU','Colour','Size'],['SHIRT-A','SHIRT-BM','Blue','M']]};
  const bytes=workbook('xlsx',rows);
  await assert.rejects(f.submit(bytes,{filename:'Exact workbook.xlsx',...authority}),e=>e.code==='entitlement_required');
  const initial=await f.submit(bytes,{filename:'Exact workbook.xlsx'}),read=complete(await f.run(),'REVIEW');
  assert.equal(read.rows,2);assert.equal(read.blocking,0);
  assert.equal((await f.variants('SHIRT-')).length,0);
  const review=await f.load(initial.id,{original:true});assert(review.content.equals(bytes));
  assert.deepEqual(review.sheets.map(s=>s.name),['Products','Red','Blue']);
  await assert.rejects(f.approve(initial.id,{reviewHash:'changed'}),/Review and confirm/);
  const approvals=await Promise.all([f.approve(initial.id),f.approve(initial.id)]);assert.equal(approvals.filter(a=>a.replayed).length,1);
  const applied=complete(await f.run(),'APPLIED');
  assert.equal(applied.variantsCreated,2);assert.equal(applied.productsCreated,1);
  const native=await f.variants('SHIRT-');
  assert.deepEqual(native.map(r=>[r.base_code,r.code,r.barcode,r.variant_label]),[
    ['SHIRT-A','SHIRT-BM',null,'Blue / M'],['SHIRT-A','SHIRT-RS','0000123456','Red / S']
  ]);
  assert.equal((await f.submit(bytes,{filename:'Renamed workbook.xlsx'})).id,initial.id);
  const more=await f.submit(text(['Product Code,Product Name,SKU,Size,Color,Barcode,Qty,Price',
    'SHIRT-A,Exact Cotton Shirt,SHIRT-RS,S,Red,0000123456,500,400',
    'SHIRT-A,Exact Cotton Shirt,SHIRT-GS,S,Green,0000789012,500,400']));
  const addition=complete(await f.run(),'REVIEW');assert.equal(addition.blocking,0);
  await f.approve(more.id);const result=complete(await f.run(),'APPLIED');
  assert.equal(result.variantsCreated,1);assert.equal(result.variantsAlreadyRecorded,1);assert.equal(result.productsCreated,0);
  assert.equal(new Set((await f.variants('SHIRT-')).map(r=>r.item_id)).size,1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM movements WHERE workspace_id=$1 AND item_id=$2",[ctx.workspaceId,native[0].item_id])).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sku_prices WHERE workspace_id=$1 AND sku_id=ANY($2::text[])',
    [ctx.workspaceId,(await f.variants('SHIRT-')).map(r=>r.id)])).rows[0].n,0);
  assert.equal(await f.balance(),4);
});

test('Pro and Custom use explicit per-original authority for paired and wide layouts, while Starter stops pending work',{timeout:300000},async t=>{
  const f=await fixture(t),{db,ctx}=f;
  await f.subscribe('pro');
  const paired=text(['Handle,Title,Variant SKU,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Variant Barcode',
    'work-gloves,Work gloves,GLOVE-RS,Colour,Red,Size,S,000087',
    'work-gloves,,GLOVE-BM,Colour,Blue,Size,M,000088']);
  await assert.rejects(f.submit(paired,{automatic:'yes'}),/Confirm automatic catalogue authority/);
  const one=await f.submit(paired,authority);
  assert.equal(complete(await f.run(),'APPLIED').variantsCreated,2);
  await f.subscribe('enterprise');
  const wide=workbook('ods',{Sizes:[['Product Code','Product Name','Color','Size: S SKU','Size: M SKU'],
    ['work-gloves','Work gloves','Green','GLOVE-GS','GLOVE-GM']]});
  const two=await f.submit(wide,{filename:'Sizes.ods',...authority});
  const result=complete(await f.run(),'APPLIED');assert.equal(result.variantsCreated,2);assert.equal(result.productsCreated,0);
  assert((await f.load(two.id,{original:true})).content.equals(wide));
  assert.equal(new Set((await f.variants('GLOVE-')).map(r=>r.item_id)).size,1);
  const queued=await f.submit(text(['Product Code,Product Name,Variant SKU,Size,Color',
    'work-gloves,Work gloves,GLOVE-STOP,L,Yellow']),authority);
  await f.subscribe('starter');
  assert.equal((await f.run()).status,'PAUSED');
  assert.equal((await f.load(queued.id)).status,'FAILED');
  await assert.rejects(f.submit(paired),e=>e.code==='entitlement_required');
  assert((await f.load(one.id,{original:true})).content.equals(paired));
  assert.equal((await f.variants('GLOVE-')).length,4);
  assert.equal(await f.balance(),4);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM commercial_usage_events WHERE workspace_id=$1 AND meter='ai_work_credits'",[ctx.workspaceId])).rows[0].n,0);
});

test('source and catalogue changes hold exact approvals, while a large saved batch preserves every explicit SKU and existing stock',{timeout:300000},async t=>{
  const f=await fixture(t),{db,ctx}=f;
  const item=(await db.query('SELECT id,name,base_code FROM items WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,f.item.itemId])).rows[0];
  const first=await f.submit(text(['Product Code,Product Name,Variant SKU,Size',
    item.base_code+','+item.name+',PRESERVE-OLD-S,S']));
  assert.equal(complete(await f.run(),'REVIEW').blocking,0);
  await f.approve(first.id);
  await db.query("UPDATE items SET name='Reviewed native name changed' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,item.id]);
  assert.equal((await f.run()).status,'DEAD');
  assert.match((await f.load(first.id)).issue,/changed after approval/);
  assert.equal((await f.variants('PRESERVE-OLD')).length,0);
  await db.query('UPDATE items SET name=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,item.id,item.name]);
  await service.revise(db,ctx,first.id,{revision:(await f.load(first.id)).revision});
  complete(await f.run(),'REVIEW');await f.approve(first.id);
  assert.equal(complete(await f.run(),'APPLIED').variantsCreated,1);
  const appended=(await f.variants('PRESERVE-OLD'))[0];assert.equal(appended.item_id,item.id);
  assert.equal(await f.balance(),4);

  const missing=await f.submit(text(['Product Code,Product Name,SKU,Size','EXACT-PRODUCT,Exact source,,XL']));
  assert(complete(await f.run(),'REVIEW').blocking>0);
  await assert.rejects(f.approve(missing.id),/Review and confirm/);
  const conflict=await f.submit(text(['Product Code,Product Name,SKU,Size',
    item.base_code+','+item.name+',WRONG-SKU,S']));
  assert(complete(await f.run(),'REVIEW').blocking>0);
  assert.match((await f.load(conflict.id)).summary.problems.map(p=>p.message).join(' '),/different recorded SKU/);

  await f.subscribe('pro');
  const wide=text(['Product Code,Product Name,SKU,Size',
    ...Array.from({length:1053},(_,i)=>'EXACT-VOLUME,Variant volume,VOLUME-V'+(i+1)+',Label '+(i+1))]);
  const simultaneous=await Promise.all([f.submit(wide,authority),f.submit(wide,authority)]);
  assert.equal(simultaneous[0].id,simultaneous[1].id);assert.equal(simultaneous.filter(r=>r.replayed).length,1);
  const applied=complete(await f.run(),'APPLIED');
  assert.equal(applied.variantsCreated,1053);assert.equal(applied.productsCreated,1);
  assert.equal((await f.variants('VOLUME-V')).length,1053);
  const report=[];
  for await(const line of service.exportRows(db,ctx,simultaneous[0].id))report.push(line);
  assert.equal(report.length,1053);assert(report.every(line=>line[10]&&line[11]));
  assert.equal(await f.balance(),4);
  const limit=randomUUID();
  await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'storage_bytes',0,'Fixture variant storage cap')",
    [limit,f.owner.accountId]);
  await assert.rejects(f.submit(text(['Product,SKU,Size','Storage,VOLUME-OVER,S'])),e=>e.code==='entitlement_required');
});

test('the phone workflow maps source headings and approves a complete exact CSV review',{timeout:300000},async t=>{
  const f=await fixture(t),{db,ctx}=f;
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),url='http://127.0.0.1:'+server.address().port;
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url+'/login');await page.getByLabel('Work email',{exact:true}).fill(f.email);await page.locator('[name=password]').fill(f.password);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(url+'/imports');await page.getByRole('link',{name:'Spreadsheet variants',exact:true}).click();
  const bytes=text(['Item,Printed number,Coating style','Ceramic vessel,VESSEL-001,Matte']);
  await page.getByLabel('Original spreadsheet',{exact:true}).setInputFiles({name:'Original variant columns.csv',mimeType:'text/csv',buffer:bytes});
  await page.getByRole('button',{name:'Read variant spreadsheet'}).click();
  await page.locator('[data-variant-import-status]').waitFor();
  const read=complete(await f.run(),'REVIEW');assert(read.blocking);
  await page.reload();
  await page.locator('summary').filter({hasText:'Mapping needed'}).click();
  await page.getByLabel('Product name',{exact:true}).selectOption('0');
  await page.getByLabel('Exact variant SKU',{exact:true}).selectOption('1');
  await page.locator('input[name=axes][value="2"]').check();
  await page.getByText('Match option column names',{exact:true}).click();
  await page.getByLabel('Recorded option name for Coating style',{exact:true}).fill('Finish');
  await page.getByRole('button',{name:'Save mapping and review again'}).click();
  await page.locator('[data-variant-import-status]').waitFor();
  assert.equal(complete(await f.run(),'REVIEW').blocking,0);
  await page.reload();
  await page.getByLabel(/I checked every supplied SKU/).check();
  await page.getByRole('button',{name:'Approve exact variants'}).click();
  await page.locator('[data-variant-import-status]').waitFor();
  assert.equal(complete(await f.run(),'APPLIED').variantsCreated,1);
  const vessel=(await f.variants('VESSEL'))[0];
  assert.equal((await db.query('SELECT name FROM item_options WHERE workspace_id=$1 AND item_id=$2',[ctx.workspaceId,vessel.item_id])).rows[0].name,'Finish');
  await page.reload();
  assert.match(await page.locator('[data-variant-import-status]').innerText(),/Variants imported/);
  const download=page.waitForEvent('download');
  await page.getByRole('link',{name:'Download exact original'}).click();
  assert(require('node:fs').readFileSync(await(await download).path()).equals(bytes));
  const csv=page.waitForEvent('download');
  await page.getByRole('link',{name:'Download all review rows'}).click();
  assert.match(require('node:fs').readFileSync(await(await csv).path(),'utf8'),/VESSEL-001/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);
  await f.subscribe('starter');await page.reload();
  assert.equal(await page.locator('[data-variant-plan-locked]').count(),1);
  assert.equal(await page.getByRole('button',{name:'Read variant spreadsheet'}).count(),0);
  await f.browser.get('/imports/variants/'+read.id+'/original').expect(200);
  await db.query("UPDATE users SET role='staff' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
  await f.browser.get('/imports/variants/'+read.id+'/original').expect(403);
});
