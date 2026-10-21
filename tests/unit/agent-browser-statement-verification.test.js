'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
test('complete DOM statements survive unrelated live progress changes while changed facts and ownership fail closed',{timeout:45000},async t=>{
 let updated=false,changed=false,renamed=false,duplicate=false;
 const server=http.createServer((_req,res)=>{res.setHeader('content-type','text/html');res.setHeader('x-stockchief-page','1');res.end(`<main id="main"><header><h1>${renamed?'Another tenant record':'Operational record'}</h1></header>
 <section><h2>Background work</h2><p>Last checked ${updated?'12:32:01':'12:31:01'}</p>${updated?'<a href="/latest">New background result</a>':''}</section>
 <p>Matched products: ${changed?5:4}; matched locations: 2; unresolved: 0.</p><section><h2>Another record</h2>${duplicate?'<p>Matched products: 4; matched locations: 2; unresolved: 0.</p>':''}</section></main>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const browser=await require('playwright').chromium.launch();t.after(()=>browser.close());
 const tools=await require('../../scripts/environment-agent-demo/browser').createBrowserTools(browser,{origin:'http://127.0.0.1:'+server.address().port});t.after(()=>tools.close());
 const before=await tools.inspect(),line=Object.entries(before.textBlocks).find(([,text])=>text.startsWith('Matched products:'));assert(line);
 const pointer='/textBlocks/'+line[0],verify=require('../../src/assistant/browser-text-verification').unchangedLine;
 updated=true;const fresh=await tools.verifyObservation(before.url,before);
 assert.notEqual(fresh.textBlocks[line[0]],line[1],'the inserted progress link changes the positional pointer');
 assert.equal(verify(before,fresh,pointer).value,line[1]);
 changed=true;assert.equal(verify(before,await tools.verifyObservation(before.url,before),pointer).matched,false,'changed business facts cannot use a different old value');
 changed=false;renamed=true;assert.equal(verify(before,await tools.verifyObservation(before.url,before),pointer).matched,false,'same statement under a changed owning record is not the same evidence');
 renamed=false;duplicate=true;assert.equal(verify(before,await tools.verifyObservation(before.url,before),pointer).matched,false,'duplicate statements do not choose a substitute');
 duplicate=false;const tampered=structuredClone(fresh);tampered.textRegions.find(r=>r.kind==='statement'&&r.firstLine===Number(Object.entries(fresh.textBlocks).find(([,s])=>s===line[1])[0].slice(4))).sha256='forged';
 assert.equal(verify(before,tampered,pointer).matched,false);
});
