'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-channel-copy-fixture');
test('more than one thousand actual native products yield exact channel copy with bounded source reads and complete CSV output',{timeout:300000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f,ids=[...f.item.skuIds];
 for(let n=1;n<1001;n++){const item=await f.catalog.createItem(db,ctx,{name:'Recorded native product '+n,baseCode:'COPY-'+String(n).padStart(4,'0'),trackingMode:'quantity'});ids.push(...item.skuIds);}
 let reads=0;const counted={query:async(...args)=>{reads++;return db.query(...args);}};
 const args={...f.input,skuIds:ids},preview=await s.preview(counted,ctx,args);
 assert.equal(preview.source.products.length,1001);assert(reads<=35,'Read 1,001 products in bounded batches, got '+reads);
 const p=await f.prepare(args),csv=await s.download(db,ctx,p.id);
 assert.match(csv,/"COPY-0999","Recorded native product 999"/);assert.equal((csv.match(/"Our online store"/g)||[]).length,1001);
 assert.equal((await s.preview(db,ctx,{...f.input,allProducts:'yes'})).source.products.length,1001);assert.equal(await f.balance(),20);
});
test('enabled channel copy scopes share the real Pro 500-rule allowance and over-limit downgrades stop writing',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f,p=await f.prepare();await s.configure(db,ctx,p.copyId,{revision:1,confirmed:'yes'});
 await db.query("INSERT INTO stockchief_runtime.agent_channel_copy_sets(id,workspace_id,label,sku_ids,channel_name,title_limit,description_style,include_description,authorized_by,enabled) SELECT 'native-copy-quota-'||n,p.workspace_id,'Checked copy rule '||n,p.sku_ids,p.channel_name,p.title_limit,p.description_style,p.include_description,p.authorized_by,true FROM stockchief_runtime.agent_channel_copy_sets p CROSS JOIN generate_series(1,499)n WHERE p.workspace_id=$1 AND p.id=$2",[ctx.workspaceId,p.copyId]);
 const extra=await f.prepare({label:'Manual copy does not grant a routine slot'});
 await assert.rejects(s.configure(db,ctx,extra.copyId,{revision:1,confirmed:'yes'}),/500 active rules/);
 await f.subscribe('enterprise');await s.configure(db,ctx,extra.copyId,{revision:1,confirmed:'yes'});
 await f.subscribe('pro');await f.rename('Current source requiring a new batch');
 assert.equal((await s.onCopy(db,ctx.workspaceId,p.copyId)).held,true);
 await s.configure(db,ctx,extra.copyId,{revision:2,stop:'yes'});
 assert.equal((await s.onCopy(db,ctx.workspaceId,p.copyId)).replayed,false);
});
test('only a distinct exported batch enters measured work; previews, unexported versions and repeat downloads cannot invent time savings',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f,roi=require('../../src/autopilot/time-saved'),digest=require('../../src/autopilot/agent-work-digest');
 const count=async()=>(await roi.report(db,ctx)).rows.find(r=>r.key==='channel-copy');
 await s.preview(db,ctx,f.input);const p=await f.prepare();
 assert.equal((await count()).count,0);
 await s.download(db,ctx,p.id);await s.download(db,ctx,p.id);assert.equal((await count()).count,1);assert.equal((await count()).minutes,null);
 await roi.sample(db,ctx,{activity:'channel-copy',manualMinutes:'60',reviewMinutes:'10',requestKey:f.requestKey()});
 assert.equal((await count()).minutes,50);
 const changed=await f.prepare({id:p.copyId,revision:1,titleLimit:159});assert.equal(changed.replayed,false);
 await s.download(db,ctx,changed.id);assert.equal((await count()).count,1,'Changed scope with identical copy cannot inflate saved work');
 const duplicate=await f.prepare({label:'Same output in another saved scope'});await s.download(db,ctx,duplicate.id);assert.equal((await count()).count,1,'Identical exported copy across saved scopes counts only once');
 assert.equal((await digest.report(db,ctx)).rows.filter(r=>r.link==='/autopilot/channel-copy/'+p.copyId).length,1);
});
