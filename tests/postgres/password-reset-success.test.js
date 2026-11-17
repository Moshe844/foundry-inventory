'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('successful password resets show a durable confirmation on every plan and preserve admin routing',{timeout:180000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,browser,subscribe,csrf}=f;
 const savedAdmin=process.env.STOCKCHIEF_COMMERCIAL_ADMIN_EMAILS,savedOrigin=process.env.STOCKCHIEF_OWNER_ORIGIN;t.after(()=>{for(const [key,value]of Object.entries({STOCKCHIEF_COMMERCIAL_ADMIN_EMAILS:savedAdmin,STOCKCHIEF_OWNER_ORIGIN:savedOrigin}))if(value===undefined)delete process.env[key];else process.env[key]=value;});
 await browser.get('/reset-password/success').expect(303).expect('location','/login');let password=f.password;
 for(const plan of ['starter','growth','pro'])await t.test(plan+' signed-in reset confirms success without reviving its old session',async()=>{
  await subscribe(plan);if(plan!=='starter'){const login=await browser.get('/login');await browser.post('/login').type('form').send({_csrf:csrf(login.text),email:f.email,password}).expect(302);}
  if(plan==='pro'){process.env.STOCKCHIEF_COMMERCIAL_ADMIN_EMAILS=f.email;process.env.STOCKCHIEF_OWNER_ORIGIN='https://admin.example.test';}
  const recovery=require('../../src/domain/postgres-password-recovery');await recovery.request(db,f.email,{origin:'https://app.example.test'});
  const payload=(await db.query("SELECT payload FROM stockchief_runtime.jobs WHERE kind='system.email-send' AND payload->>'messageType'='password_reset' ORDER BY created_at DESC,id DESC LIMIT 1")).rows[0].payload;
  const email=require('../../src/operations/email').unseal(payload),token=new URL(email.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token'),form=await browser.get('/reset-password?token='+encodeURIComponent(token));
  password='New!'+randomUUID();await browser.post('/reset-password').type('form').send({_csrf:csrf(form.text),token,password,confirmPassword:password,returnUrl:'https://untrusted.example.test/'}).expect(303).expect('location','/reset-password/success');
  const confirmation=await browser.get('/reset-password/success').expect(200);assert.match(confirmation.text,/Password updated successfully/);assert.match(confirmation.text,/password has been changed/);assert.equal(confirmation.headers['cache-control'],'no-store');assert(!confirmation.text.includes('untrusted.example.test'));assert(!confirmation.text.includes('Continue to secure payment'));
  assert.match(confirmation.text,plan==='pro'?/href="https:\/\/admin\.example\.test\/login"/:/href="\/login"/);
  await browser.get('/reset-password/success').expect(200);assert.equal(await recovery.inspect(db,token),null);assert(await require('../../src/domain/postgres-auth-service').authenticate(db,f.email,password));
  const home=await browser.get('/inventory');assert(home.status>=300&&home.status<400,'The old authenticated customer session must be revoked');
 });
});
