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
 await page.locator('[data-voice-status]').filter({hasText:'Recording'}).waitFor();
 assert.equal(await speak.getAttribute('aria-pressed'),'true');
 await page.waitForTimeout(1200);
 await speak.click();
 await page.waitForFunction(()=>document.querySelector('#ask-question').value.length>0,null,{timeout:20000});
 assert.equal(await page.locator('#ask-question').inputValue(),'וויפיל שיך האבן מיר אויף לאגער?');
 assert.match(sent.type,/multipart\/form-data/);assert.ok(sent.hasWave&&sent.size>16000,'a WAV recording was sent: '+JSON.stringify(sent));
 assert.match(await page.locator('[data-voice-status]').innerText(),/Check the words, then send/);
 assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#ask-question')).direction),'rtl','Yiddish in the box reads right to left');
});

test('without the transcription service, Voice note still shows and says why it cannot record yet',{timeout:180000},async t=>{
 const old=process.env.OPENAI_API_KEY;delete process.env.OPENAI_API_KEY;
 t.after(()=>{if(old!==undefined)process.env.OPENAI_API_KEY=old;});
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t);
 const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID()});
 const server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s));}),origin='http://127.0.0.1:'+server.address().port;
 const browser=await require('playwright').chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));await app.locals.sessionStore.close();});
 const page=await (await browser.newContext({permissions:['microphone']})).newPage();
 await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 await page.goto(origin+'/ask');
 const note=page.locator('[data-voice-note]');await note.waitFor({state:'visible'});
 await note.click();
 assert.match(await page.locator('[data-voice-status]').innerText(),/not switched on/);
 assert.equal(await note.getAttribute('aria-pressed'),'false','nothing was recorded');
});
