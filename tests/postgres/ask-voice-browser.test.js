'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// In a real browser with a test microphone: Speak records a voice note, sends
// it as the WAV the server reads, and puts the words — here Yiddish — in the box
// to check before sending. The box writes Yiddish right to left.
test('Voice note, beside Speak, records a voice note and puts its words in the question box',{timeout:180000},async t=>{
 const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-key-not-used';
 t.after(()=>{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;});
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t);
 const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID()});
 const server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s));}),origin='http://127.0.0.1:'+server.address().port;
 const browser=await require('playwright').chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));await app.locals.sessionStore.close();});
 const context=await browser.newContext({permissions:['microphone']}),page=await context.newPage();
 await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 // The server's reading is stood in for here; the request the page sends is checked as it is.
 let sent=null;
 await page.route('**/ask/voice',async route=>{const request=route.request();sent={type:request.headers()['content-type'],size:request.postDataBuffer()?.length||0,hasWave:request.postDataBuffer()?.includes(Buffer.from('WAVEfmt '))};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({text:'וויפיל שיך האבן מיר אויף לאגער?',truncated:false})});});
 await page.goto(origin+'/ask');
 const speak=page.locator('[data-voice-note]');
 await speak.waitFor({state:'visible'});
 assert.equal(await page.locator('#ask-question').getAttribute('dir'),'auto','the box follows the direction of what is written');
 assert.equal(await speak.innerText(),'Voice note','a button of its own, named for what it does');
 assert.equal(await page.locator('[data-voice-input][data-voice-note]').count(),0,'Speak (typing as you talk) stays a separate button');
 await speak.click();
 await page.locator('[data-voice-status]').filter({hasText:'Listening'}).waitFor();
 assert.equal(await speak.getAttribute('aria-pressed'),'true');
 await page.waitForTimeout(1200);
 await speak.click();
 await page.waitForFunction(()=>document.querySelector('#ask-question').value.length>0,null,{timeout:20000});
 assert.equal(await page.locator('#ask-question').inputValue(),'וויפיל שיך האבן מיר אויף לאגער?');
 assert.match(sent.type,/multipart\/form-data/);assert.ok(sent.hasWave&&sent.size>16000,'a WAV recording was sent: '+JSON.stringify(sent));
 assert.match(await page.locator('[data-voice-status]').innerText(),/Check the words, then send/);
 assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#ask-question')).direction),'rtl','Yiddish in the box reads right to left');
});

test('on a phone, Voice note shows even when only the worker can read it, as an icon with its message on a line below',{timeout:180000},async t=>{
 const old=process.env.OPENAI_API_KEY;delete process.env.OPENAI_API_KEY;
 t.after(()=>{if(old!==undefined)process.env.OPENAI_API_KEY=old;});
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t);
 const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID()});
 const server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s));}),origin='http://127.0.0.1:'+server.address().port;
 const browser=await require('playwright').chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));await app.locals.sessionStore.close();});
 const page=await (await browser.newContext({viewport:{width:390,height:844},permissions:['microphone']})).newPage();
 await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 await page.goto(origin+'/ask');
 const note=page.locator('[data-voice-note]');await note.waitFor({state:'visible'});
 await page.route('**/ask/voice',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({text:'how many boots do we have',truncated:false})}));
 await note.click();
 await page.locator('[data-voice-status]').filter({hasText:'Listening'}).waitFor();
 assert.equal(await note.getAttribute('aria-pressed'),'true','the web service without a key still records: the worker reads it');
 // On a phone the buttons are icons and the message is a readable line under them.
 const sizes=await page.evaluate(()=>({buttons:[...document.querySelectorAll('.rm-composer__foot > :is(.rm-composer__attach,.rm-composer__voice)')].filter(b=>b.offsetParent).map(b=>Math.round(b.getBoundingClientRect().width)),
  status:Math.round(document.querySelector('[data-voice-status]').getBoundingClientRect().width)}));
 assert.ok(sizes.buttons.length>=2&&sizes.buttons.every(w=>w<=40),'icon buttons on a phone: '+JSON.stringify(sizes));
 assert.ok(sizes.status>=250,'the message reads as a line: '+JSON.stringify(sizes));
 assert.ok((await note.getAttribute('title')).length>0,'the icon keeps its name');
 await page.waitForTimeout(800);await note.click();
 await page.waitForFunction(()=>document.querySelector('#ask-question').value.length>0,null,{timeout:20000});
 assert.equal(await page.locator('#ask-question').inputValue(),'how many boots do we have');
});

// A sound file stands in for the microphone: a spoken stretch then quiet, or quiet only.
function soundFile(path,{speakSeconds,quietSeconds}){
 const rate=16000,total=Math.round((speakSeconds+quietSeconds)*rate),data=Buffer.alloc(total*2);
 for(let i=0;i<speakSeconds*rate;i++){const tone=Math.sin(2*Math.PI*220*i/rate)*0.5+Math.sin(2*Math.PI*660*i/rate)*0.2;data.writeInt16LE(Math.round(tone*12000),i*2);}
 const head=Buffer.alloc(44);head.write('RIFF',0);head.writeUInt32LE(36+data.length,4);head.write('WAVEfmt ',8);head.writeUInt32LE(16,16);head.writeUInt16LE(1,20);head.writeUInt16LE(1,22);
 head.writeUInt32LE(rate,24);head.writeUInt32LE(rate*2,28);head.writeUInt16LE(2,32);head.writeUInt16LE(16,34);head.write('data',36);head.writeUInt32LE(data.length,40);
 require('node:fs').writeFileSync(path,Buffer.concat([head,data]));return path;
}
test('Voice note stops by itself when you stop speaking, and sends nothing when nothing was said',{timeout:240000},async t=>{
 const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-key-not-used';
 t.after(()=>{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;});
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t);
 const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID()});
 const server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s));}),origin='http://127.0.0.1:'+server.address().port;
 const dir=require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'voice-'));
 t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));await app.locals.sessionStore.close();});
 const run=async(sound,expectSent)=>{
  const browser=await require('playwright').chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+sound]});
  try{const page=await (await browser.newContext({permissions:['microphone']})).newPage();
   await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
   await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
   let sent=0;await page.route('**/ask/voice',route=>{sent++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({text:'how many boots',truncated:false})});});
   await page.goto(origin+'/ask');const note=page.locator('[data-voice-note]');await note.waitFor({state:'visible'});
   await note.click();await page.locator('[data-voice-status]').filter({hasText:'Listening'}).waitFor();
   // No second press: it must finish by itself.
   await page.waitForFunction(()=>document.querySelector('[data-voice-note]').getAttribute('aria-pressed')==='false',null,{timeout:20000});
   if(expectSent){await page.waitForFunction(()=>document.querySelector('#ask-question').value.length>0,null,{timeout:20000});assert.equal(sent,1,'the note was sent once');}
   else{await page.locator('[data-voice-status]').filter({hasText:'No speech was heard'}).waitFor({timeout:5000});assert.equal(sent,0,'a silent recording is never sent');}
  }finally{await browser.close();}
 };
 await run(soundFile(dir+'/speech-then-quiet.wav',{speakSeconds:1.5,quietSeconds:4}),true);
 await run(soundFile(dir+'/quiet.wav',{speakSeconds:0,quietSeconds:12}),false);
});
