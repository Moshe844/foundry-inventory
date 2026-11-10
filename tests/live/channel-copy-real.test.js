'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('real configured provider writes factual multilingual channel copy and books actual token receipts',{skip:process.env.STOCKCHIEF_CHANNEL_COPY_REAL!=='1',timeout:300000},async t=>{
 const f=await require('../helpers/agent-channel-copy-fixture').fixture(t),s=f.service;
 const tee=await f.catalog.createItem(f.db,f.ctx,{name:'Cotton workshop apron',baseCode:'SYN-APRON',trackingMode:'quantity',description:'<p>Woven cotton apron with two front pockets. Machine wash at 30°C. No water-resistant coating.</p>',hasVariants:true,options:[{name:'Color',values:['Navy','Olive']}]});
 const lot=await f.catalog.createItem(f.db,f.ctx,{name:'Cedar drawing pencils',baseCode:'SYN-PENCIL',trackingMode:'lot',description:'A box of 12 cedar pencils with HB graphite. Unsharpened.'});
 const serial=await f.catalog.createItem(f.db,f.ctx,{name:'Desktop label printer',baseCode:'SYN-PRINTER',trackingMode:'serial',description:'USB desktop label printer for 58 mm rolls. Power adapter included. Labels are not included.'});
 const measured=await f.catalog.createItem(f.db,f.ctx,{name:'Linen fabric',baseCode:'SYN-LINEN',trackingMode:'quantity',unitLabel:'metre',quantityPrecision:3,description:'Plain-weave linen fabric, 150 cm wide. Sold by the metre.'});
 const ids=[...tee.skuIds,...lot.skuIds,...serial.skuIds,...measured.skuIds],evidence=[];
 for(const settings of [{label:'Synthetic French marketplace',channelName:'Synthetic marketplace',channelStyle:'marketplace',language:'French',tone:'clear',descriptionStyle:'bullets'},{label:'Synthetic English store',channelName:'Synthetic direct store',channelStyle:'store',language:'English',tone:'warm',descriptionStyle:'paragraph'}]){
  const p=await f.prepare({...settings,skuIds:ids,includeDescription:'yes',titleLimit:120,descriptionLimit:1600});assert.equal(p.preview.document.length,5);assert(p.preview.document.every(r=>!r.problem));
  const page=await s.screen(f.db,f.ctx,{id:p.copyId});assert.equal(page.latestRun.status,'APPROVED');assert(page.latestRun.credits>=p.preview.credits);
  const csv=await s.download(f.db,f.ctx,p.id);for(const code of p.preview.source.products.map(x=>x.code))assert(csv.includes(code));
  assert.doesNotMatch(p.preview.document.map(r=>r.description).join(' '),/perfect|ideal|efficient|practical|high.quality/i);
  if(settings.language==='French')assert.match(p.preview.document.map(r=>r.description).join('\n'),/coton|crayons|imprimante|lin/i);
  evidence.push({settings,credits:page.latestRun.credits,document:p.preview.document});
 }
 const costs=(await f.db.query("SELECT provider,model,operation,sum(quantity)::float8 AS tokens,sum(amount_minor)::float8 AS amount_minor FROM commercial_cost_events WHERE workspace_id=$1 AND operation IN('model_input','model_output','cache_read','cache_write_5m','cache_write_1h') GROUP BY provider,model,operation ORDER BY operation",[f.ctx.workspaceId])).rows;
 assert.equal(await f.balance(),20);assert(costs.length>=2);assert(costs.every(r=>r.amount_minor>0));
 const fs=require('node:fs');fs.mkdirSync('output',{recursive:true});fs.writeFileSync('output/channel-writing-real-evidence.json',JSON.stringify({at:new Date().toISOString(),synthetic:true,costs,batches:evidence},null,2));
 t.diagnostic(JSON.stringify({provider:costs[0].provider,model:costs[0].model,products:10,batches:2,costMinor:costs.reduce((n,r)=>n+r.amount_minor,0),credits:evidence.map(e=>e.credits)}));
});
