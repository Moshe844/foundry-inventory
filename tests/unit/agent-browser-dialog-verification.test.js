'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{randomUUID}=require('node:crypto');

test('an observed open dialog survives fresh verification and restart without restoring inputs or submitting',{timeout:45000},async t=>{
 // Recorded browser-013 failure: the model opened a native dialog and cited
 // its heading and required/default fields. Verification fetched the same
 // URL with the dialog closed, then rejected those correct claims.
 const id='dialog-'+randomUUID(),field='field-'+randomUUID();let changed=false,duplicate=false,posts=0,gets=0;
 const server=http.createServer((req,res)=>{if(req.method!=='GET')posts++;else gets++;res.setHeader('content-type','text/html');res.setHeader('x-stockchief-page','1');
  const dialog=`<dialog id="${id}"><form method="post" action="/governed"><h2>Unfamiliar receiving zone</h2><label>Label<input name="${field}" ${changed?'':'required'}></label><label>Type<select name="kind" required><option value="warehouse">Warehouse</option><option value="vehicle">Vehicle</option></select></label><button>Save</button></form></dialog>`;
  res.end(`<html><body><main><h1>Places</h1><button onclick="document.getElementById('${id}').showModal()">Open editor</button>${dialog}${duplicate?dialog:''}</main></body></html>`);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const origin='http://127.0.0.1:'+server.address().port,browser=await require('playwright').chromium.launch();t.after(()=>browser.close());
 const create=()=>require('../../scripts/environment-agent-demo/browser').createBrowserTools(browser,{origin});let tools=await create();t.after(()=>tools.close());
 const first=await tools.inspect(),opened=await tools.act({action:'click',ref:first.controls.find(c=>c.label==='Open editor').ref});
 const controlIndex=opened.controls.findIndex(c=>c.name===field);assert(controlIndex>=0);assert.equal(opened.controls[controlIndex].required,true);
 const heading=Object.entries(opened.textBlocks).find(([,v])=>v==='Unfamiliar receiving zone');assert(heading);
 const count=gets,fresh=await tools.verifyObservation(opened.url,opened);
 assert(gets>count,'A separate authorized GET must still verify current facts');
 assert(fresh.controls.some(c=>c.name===field),'The independently opened native dialog must remain visible for verification');
 const compare=require('../../src/assistant/browser-control-verification').unchangedControl;
 assert.equal(compare(opened,fresh,'/controls/'+controlIndex+'/required').matched,true);
 assert.equal(require('../../src/assistant/browser-text-verification').unchangedLine(opened,fresh,'/textBlocks/'+heading[0]).matched,true);
 const legacy=structuredClone(opened);delete legacy.viewState.openDialogs;
 assert((await tools.verifyObservation(legacy.url,legacy)).controls.some(c=>c.name===field),'Existing recorded journals recover only an entire uniquely unchanged dialog');
 await tools.act({action:'fill',ref:(await tools.inspect()).controls.find(c=>c.name===field).ref,value:'Unsaved input'});
 const edited=await tools.inspect();await tools.close();tools=await create();
 const restarted=await tools.verifyObservation(edited.url,edited);
 assert.equal(restarted.controls.find(c=>c.name===field).value,'','Restoration must not replay form inputs');
 assert.equal(compare(edited,restarted,'/controls/'+edited.controls.findIndex(c=>c.name===field)+'/value').matched,false);
 changed=true;assert.equal(compare(opened,await tools.verifyObservation(opened.url,opened),'/controls/'+controlIndex+'/required').matched,false,'Changed constraints cannot be hidden by presentation restoration');
 const legacyChanged=await tools.verifyObservation(legacy.url,legacy);
 assert.equal(compare(legacy,legacyChanged,'/controls/'+controlIndex+'/required').matched,false);
 changed=false;duplicate=true;
 const ambiguous=await tools.verifyObservation(opened.url,opened);
 assert.equal(ambiguous.controls.some(c=>c.name===field),false,'Ambiguous dialog identity cannot select a substitute');
 assert.equal(posts,0,'No business operation or submitted input is replayed');
});
