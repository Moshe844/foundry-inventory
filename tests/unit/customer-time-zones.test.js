'use strict';const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
test('Needs You and initial/polled connection timestamps follow the saved account zone rather than a different device zone',async()=>{
 const instant='2026-11-01T06:15:27Z';
 for(const zone of ['Europe/Paris','Asia/Kolkata','America/New_York']){
  const expected=new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short',timeZone:zone}).format(new Date(instant));
  const time={dateTime:instant},label={},last={},next={},status={},updated={},root={dataset:{connectionSynchronization:'fixture',lastCheck:instant,productsMapped:'0',locationsMapped:'0'},querySelector:selector=>({'[data-connection-sync-progress]':status,'[data-connection-sync-updated]':updated,'[data-sync-last]':last,'[data-sync-next]':next})[selector],querySelectorAll:()=>[time]};
  const document={documentElement:{dataset:{timeZone:zone}},hidden:false,querySelector:()=>root,querySelectorAll:selector=>selector==='[data-inbox-time-zone]'?[label]:[time]};
  const context=vm.createContext({document,Date,Intl,AbortSignal,window:{setInterval:()=>{}},fetch:async()=>({ok:true,json:async()=>({lastCheckAt:instant,nextCheckAt:instant,mode:'active',productsMapped:0,locationsMapped:0})})});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../src/web/public/needs-you.js'),'utf8'),context);assert.equal(label.textContent,new Intl.DateTimeFormat(undefined,{timeZone:zone}).resolvedOptions().timeZone);assert.equal(time.textContent,expected);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../src/web/public/connection-sync.js'),'utf8'),context);await new Promise(r=>setImmediate(r));assert.equal(time.textContent,expected);assert.equal(last.textContent,expected);assert.equal(next.textContent,expected);assert(status.textContent.includes(expected));
 }
});
