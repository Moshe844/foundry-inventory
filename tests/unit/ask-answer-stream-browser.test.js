'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ejs=require('ejs');
test('the chat renders streamed sections immediately with no one-second HTTP poll',async t=>{
 const browser=await require('playwright').chromium.launch();t.after(()=>browser.close());const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const goal={id:'offline-stream',status:'RUNNING',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),answer:'',checkpoint:{runtime:'codex-staging',harness:{},observations:[]}};goal.conversation=require('../../src/assistant/agent-conversation').state(goal);
 const filename=path.resolve('src/web/views/partials/adaptive-goal.ejs'),html=ejs.render(fs.readFileSync(filename,'utf8'),{goal,csrfToken:'OFFLINE',isLatest:true,codexApprovals:[],renderAgentAnswer:require('../../src/web/public/agent-answer').render},{filename});await page.setContent(html);
 await page.evaluate(()=>{window.polls=0;window.fetch=()=>{window.polls++;throw Error('Polling is forbidden when the stream is healthy');};window.EventSource=class extends EventTarget{constructor(url){super();window.testStream=this;this.url=url;this.closed=false;}close(){this.closed=true;}};});
 await page.addScriptTag({content:fs.readFileSync('src/web/public/adaptive-goal.js','utf8').replace('catch{stream.close();poll();}','catch(error){window.streamFailure=error.stack;stream.close();poll();}')});
 assert.equal(await page.evaluate(()=>window.testStream.url),'/ask/goals/offline-stream/stream');
 async function push(status,message){await page.evaluate(({status,message})=>window.testStream.dispatchEvent(new MessageEvent('goal',{data:JSON.stringify({id:'offline-stream',status,conversation:{phase:status==='COMPLETED'?'completed':'working',label:status==='COMPLETED'?'Completed':'Working',message,canReply:false,history:[],terminal:status==='COMPLETED'},events:[],approvalIds:[]})})),{status,message});}
 await push('RUNNING','Coffee: 3.75 kg');assert.equal(await page.locator('[data-goal-answer]').innerText(),'Coffee: 3.75 kg');assert.equal(await page.evaluate(()=>window.testStream.closed),false,await page.evaluate(()=>window.streamFailure));
 await push('COMPLETED','Coffee: 3.75 kg\nRecorded value: $150.00');assert.match(await page.locator('[data-goal-answer]').innerText(),/\$150\.00/);assert.equal(await page.evaluate(()=>window.testStream.closed),true);assert.equal(await page.evaluate(()=>window.polls),0);assert.deepEqual(errors,[]);
});
