'use strict';
async function startConsole(app,db){const owner=require('../../src/platform-owner/app').createOwnerConsole({database:db,store:app.locals.sessionStore,env:'test',sessionSecret:'private-console-regression-fixture'});const server=await new Promise(r=>{const s=owner.listen(0,'127.0.0.1',()=>r(s));});return {server,base:'http://127.0.0.1:'+server.address().port};}
async function signIn(browser,base,actor,password,onError=()=>{}){
 const assert=require('node:assert/strict'),ctx=await browser.newContext(),page=await ctx.newPage();
 page.setDefaultTimeout(15000);page.on('pageerror',onError);await page.goto(base+'/login');
 await page.getByLabel('Owner email',{exact:true}).fill(actor.email);await page.getByLabel('Password',{exact:true}).fill(password);
 const [response]=await Promise.all([page.waitForResponse(r=>r.url()===base+'/login'&&r.request().method()==='POST'),page.getByRole('button',{name:'Continue to MFA'}).click()]);
 assert.equal(response.status(),303,'Owner password submission: '+await page.locator('main').innerText());assert.equal(response.headers().location,'/verify');
 await page.waitForURL(base+'/verify');const secret=await page.locator('.setup-key').innerText();
 await page.getByLabel('Six-digit authenticator code').fill(require('../../src/platform-owner/auth').codeAt(secret,Math.floor(Date.now()/30000)));
 const [verification]=await Promise.all([page.waitForResponse(r=>r.url()===base+'/verify'&&r.request().method()==='POST'),page.getByRole('button',{name:'Enable MFA and sign in'}).click()]);
 assert.equal(verification.status(),303,'MFA submission must succeed');assert.equal(verification.headers().location,'/');
 await page.waitForURL(url=>url.origin===base&&['/','/support'].includes(url.pathname));return {ctx,page};
}
module.exports={startConsole,signIn};
