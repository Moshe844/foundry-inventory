'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
test('pilot attempts and immutable corpus survive process restart without refill or repeat',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-journal-'));
 const {ExperimentBudget}=require('../../scripts/environment-agent-demo/budget'),{PilotJournal}=require('../../scripts/environment-agent-demo/pilot-journal');
 const b=new ExperimentBudget(path.join(dir,'test.sqlite'),'offline');t.after(()=>{b.close();fs.rmSync(dir,{recursive:true,force:true});});
 const manifest={hash:'frozen',attempts:18};const first=new PilotJournal(b,manifest);first.begin('a','openai');
 const second=new PilotJournal(b,manifest);assert.throws(()=>second.begin('b','claude'),/UNRESOLVED/);
 first.finish('a','openai',{outcome:'partial'});assert.throws(()=>second.begin('a','openai'),/UNIQUE/);
 assert.throws(()=>new PilotJournal(b,{hash:'different'}),/CHANGED/);assert.equal(b.status().ceiling,0);
});
