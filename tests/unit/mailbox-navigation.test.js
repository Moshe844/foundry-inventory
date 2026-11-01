'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('a late background mailbox check cannot reload a submitted catalogue form',async()=>{
 const source=fs.readFileSync(require.resolve('../../src/web/public/app.js'),'utf8'),start=source.indexOf('  function initLiveMailbox()'),end=source.indexOf('\n  /**',start);assert(start>0&&end>start);
 async function scenario(submit){let check,onSubmit,reloads=0,finish;const response=new Promise(resolve=>{finish=resolve;}),document={hidden:false,activeElement:null,querySelector:()=>({dataset:{connectorId:'fixture',signature:'before'}}),addEventListener:(name,fn)=>{if(name==='submit')onSubmit=fn;}},window={setInterval:fn=>{check=fn;},location:{reload:()=>{reloads++;}}};vm.runInNewContext(source.slice(start,end)+'\ninitLiveMailbox();',{document,window,fetch:()=>response});check();if(submit)onSubmit();finish({ok:true,json:async()=>({signature:'after'})});await new Promise(resolve=>setImmediate(resolve));return reloads;}
 assert.equal(await scenario(true),0,'Saving the form owns navigation even when an earlier poll completes later');assert.equal(await scenario(false),1,'An idle mailbox still refreshes when its confirmed data changes');
});
