'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {randomUUID}=require('node:crypto'),{chromium}=require('playwright');
const {createBrowserTools}=require('../../scripts/environment-agent-demo/browser');
const {preview,bytes}=require('../../scripts/environment-agent-demo/context');

// Mechanical, offline tool tests. Their scripted actions are NOT agent evidence.
test('live inspection pages arbitrary controls/text/options and exposes changed form contracts without registering them',async t=>{
 const target='/'+randomUUID(),field=randomUUID(),heading=randomUUID();let version=0,posts=0;
 const server=http.createServer((req,res)=>{
  if(req.method!=='GET')posts++;
  res.setHeader('content-type','text/html');
  if(req.url===target)return res.end(`<h1>${heading}</h1><form method="post" action="${target}">
   <span id="field-label">${version?'Approved crate count':'Measured quantity'}</span><span id="help">Check the observed contract.</span>
   ${version?`<select name="${field}-changed" aria-labelledby="field-label" aria-describedby="help" required>${Array.from({length:251},(_,i)=>`<option value="v${i}">Choice ${i}</option>`).join('')}</select>`:
   `<input type="number" name="${field}" aria-labelledby="field-label" aria-describedby="help" required min="2" max="13" step="1">`}
   <button>Commit</button></form>`);
  res.end(`<body>${Array.from({length:215},(_,i)=>`<button>Unrelated ${i}</button>`).join('')}<a href="${target}">${heading}</a><div>${'text '.repeat(4000)}END-OF-LIVE-CONTENT</div></body>`);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
 const ui=await createBrowserTools(browser,{origin:`http://127.0.0.1:${server.address().port}`});t.after(()=>ui.close());
 const first=await ui.inspect();assert.ok(first.controls.length>0&&first.controls.length<=200);assert.equal(first.pagination.controlTotal,216);
 assert.ok(first.pagination.controlsNextRef&&first.pagination.textNextRef);
 const packed=preview(first,'observation-1');assert.ok(bytes(packed)<=6500);
 assert.equal(packed.pagination.controlTotal,216);assert.ok(packed.omittedControls>0);
 const tail=await ui.act({action:'inspect',ref:packed.pagination.textNextRef});assert.match(tail.text,/END-OF-LIVE-CONTENT/);
 const later=await ui.act({action:'inspect',ref:tail.pagination.controlsNextRef});
 const link=later.controls.find(c=>c.label===heading);assert.ok(link);
 let screen=await ui.act({action:'click',ref:link.ref});let control=screen.controls.find(c=>c.name===field);
 assert.equal(control.label,'Measured quantity');assert.equal(control.description,'Check the observed contract.');
 assert.equal(control.required,true);assert.equal(control.min,'2');assert.equal(control.max,'13');assert.equal(control.form.method,'post');
 const old=control.ref;version=1;screen=await ui.act({action:'refresh'});
 assert.equal((await ui.act({action:'fill',ref:old,value:'5'})).error.code,'STALE_BROWSER_REFERENCE');
 screen=await ui.inspect();control=screen.controls.find(c=>c.name===field+'-changed');
 assert.equal(control.tag,'select');assert.equal(control.optionsTotal,251);assert.equal(control.label,'Approved crate count');
 let details=await ui.act({action:'inspect',ref:control.optionsNextRef});
 assert.equal(details.controls[0].optionsOffset,10);
 details=await ui.act({action:'inspect',ref:details.controls[0].optionsNextRef});
 assert.equal(details.controls[0].optionsOffset,110);
 details=await ui.act({action:'inspect',ref:details.controls[0].optionsNextRef});
 assert.equal(details.controls[0].options.at(-1).value,'v250');assert.equal(details.controls[0].optionsTruncated,false);
 screen=await ui.act({action:'select',ref:details.controls[0].ref,value:'v250'});
 assert.equal(screen.controls.find(c=>c.name===field+'-changed').value,'v250');
 const commit=screen.controls.find(c=>c.label==='Commit');await ui.act({action:'click',ref:commit.ref});assert.equal(posts,0);
 assert.equal((await ui.act({action:'inspect',ref:first.pagination.controlsNextRef})).error.code,'STALE_BROWSER_REFERENCE');
});

test('many large live selects stay below journal truncation and every control remains reachable',async t=>{
 const options=Array.from({length:100},(_,i)=>`<option value="${'v'.repeat(390)}${i}">${'label '.repeat(65)}${i}</option>`).join('');
 const html=Array.from({length:24},(_,i)=>`<label>Field ${i}<select name="f${i}">${options}</select></label>`).join('');
 const server=http.createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(html);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
 const ui=await createBrowserTools(browser,{origin:`http://127.0.0.1:${server.address().port}`});t.after(()=>ui.close());
 let screen=await ui.inspect();const names=new Set();let pages=0;
 while(true){
  assert.ok(JSON.stringify(screen).length<128000,'the journal must store valid complete JSON');
  for(const c of screen.controls)names.add(c.name);
  const packed=preview(screen,'observation-'+pages++);assert.ok(bytes(packed)<=6500);
  if(!packed.pagination.controlsNextRef)break;
  screen=await ui.act({action:'inspect',ref:packed.pagination.controlsNextRef});
 }
 assert.equal(names.size,24);assert.ok(pages>1);
 const field=screen.controls[0];let details=await ui.act({action:'inspect',ref:field.ref});
 assert.ok(JSON.stringify(details).length<128000);assert.equal(details.controls[0].optionsTotal,100);
 const packed=preview(details,'options');assert.equal(packed.controls[0].ref,field.ref);assert.equal(packed.controls[0].optionsPreviewOnly,true);
});
