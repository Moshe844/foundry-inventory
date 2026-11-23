'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),request=require('supertest');
const email=require('../../src/operations/email');
const csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)[1];
const days=value=>Math.round(value/86400000);

test('password sign-in asks for an emailed code unless this browser was remembered',{timeout:240000},async t=>{
  const f=await require('../helpers/postgres-shipping-fixture').fixture(t);
  const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID(),signInCode:true});
  f.cleanup(()=>app.locals.sessionStore.close());
  const latestCode=async()=>{
    const row=(await f.db.query(`SELECT payload,priority FROM stockchief_runtime.jobs WHERE kind='system.email-send'
      AND payload->>'messageType'='sign_in_code' ORDER BY created_at DESC,id DESC LIMIT 1`)).rows[0];
    const message=email.unseal(row.payload);
    assert.equal(message.to,f.email);assert.equal(row.priority,1);
    assert.deepEqual(Object.keys(row.payload).sort(),['accountId','messageType','sealed','signInCodeId'],'the code travels only inside the sealed message');
    return /^(\d{6}) is your StockChief sign-in code$/.exec(message.subject)[1];
  };
  const codesSent=async()=>Number((await f.db.query('SELECT count(*) n FROM sign_in_codes WHERE account_id=$1',[f.owner.accountId])).rows[0].n);
  // Opens the sign-in page, then posts it; .expect(status) and .expect(header,value) check the reply.
  const signIn=(browser,extra={})=>{
    const checks=[],sent=(async()=>{const page=await browser.get('/login');
      return browser.post('/login').type('form').send({_csrf:csrf(page.text),email:f.email,password:f.password,...extra});})();
    const chain={expect(...check){checks.push(check);return chain;},
      then(resolve,reject){return sent.then(response=>{for(const [what,value] of checks){
        if(typeof what==='number')assert.equal(response.status,what);else assert.equal(response.headers[what.toLowerCase()],value);}
      return response;}).then(resolve,reject);}};
    return chain;
  };
  const signedIn=async(browser)=>(await browser.get('/inventory')).status===200;
  const signOut=async(browser)=>{const page=await browser.get('/inventory').expect(200);await browser.post('/logout').type('form').send({_csrf:csrf(page.text)}).expect(302);};
  const deviceCookie=response=>(response.headers['set-cookie']||[]).find(value=>value.startsWith('stockchief.device='));

  await t.test('the sign-in page offers to remember this device for 30 or 60 days',async()=>{
    const page=await request(app).get('/login').expect(200);
    assert.match(page.text,/<input type="checkbox" name="rememberMe" value="1"> Remember this device for<\/label><select name="rememberDays"/);
    assert.match(page.text,/<option value="30" selected>30 days<\/option><option value="60">60 days<\/option>/);
    assert.match(page.text,/We email you a code each time you sign in/);
    assert.doesNotMatch(page.text,/Keep me signed in/);
  });

  await t.test('the password alone does not sign in; the emailed code does, once',async()=>{
    const browser=request.agent(app);
    const sent=await signIn(browser).expect(303).expect('location','/login/code');
    assert.equal(deviceCookie(sent),undefined);
    assert.equal(await signedIn(browser),false);
    const page=await browser.get('/login/code').expect(200);
    assert.equal(page.headers['cache-control'],'private, no-store');
    assert(page.text.includes(f.email));assert.match(page.text,/autocomplete="one-time-code"/);
    const code=await latestCode(),wrong=String((Number(code)+1)%1000000).padStart(6,'0');
    const refused=await browser.post('/login/code').type('form').send({_csrf:csrf(page.text),code:wrong}).expect(400);
    assert.match(refused.text,/That code is not right\. Check the newest email and try again \(4 tries left\)\./);
    const done=await browser.post('/login/code').type('form').send({_csrf:csrf(refused.text),code:code.slice(0,3)+' '+code.slice(3)}).expect(302);
    assert.equal(deviceCookie(done),undefined,'an unticked box remembers nothing');
    assert(!/Expires=/i.test(done.headers['set-cookie'].find(value=>value.startsWith('foundry.sid='))),'without remembering, the sign-in ends with the browser');
    assert.equal(await signedIn(browser),true);
    await signOut(browser);
    const again=await signIn(browser).expect(303).expect('location','/login/code');
    const reused=await browser.post('/login/code').type('form').send({_csrf:csrf((await browser.get('/login/code')).text),code}).expect(400);
    assert.match(reused.text,/That code is not right/,'a used code does not work for the next sign-in');void again;
  });

  await t.test('a remembered browser skips the code for the days chosen; other browsers still get one',async()=>{
    const browser=request.agent(app);
    await signIn(browser,{rememberMe:'1',rememberDays:'60'}).expect(303).expect('location','/login/code');
    const page=await browser.get('/login/code').expect(200);
    assert.match(page.text,/name="rememberMe" value="1" checked>/);assert.match(page.text,/<option value="60" selected>60 days/);
    const done=await browser.post('/login/code').type('form').send({_csrf:csrf(page.text),code:await latestCode(),rememberMe:'1',rememberDays:'60'}).expect(302);
    const cookie=deviceCookie(done);assert.match(cookie,/HttpOnly/i);assert.match(cookie,/SameSite=Lax/i);
    const session=done.headers['set-cookie'].find(value=>value.startsWith('foundry.sid='));
    assert.equal(days(Date.parse(/Expires=([^;]+)/i.exec(session)[1])-Date.now()),60);
    const device=(await f.db.query(`SELECT extract(epoch FROM expires_at-now())*1000 AS left_ms,token_hash,revoked_at FROM trusted_sign_in_devices WHERE account_id=$1`,[f.owner.accountId])).rows;
    assert.equal(device.length,1);assert.equal(days(Number(device[0].left_ms)),60);
    assert(!cookie.includes(device[0].token_hash),'the browser holds a token, never its stored hash');
    await signOut(browser);
    const before=await codesSent();
    await signIn(browser).expect(302);
    assert.equal(await signedIn(browser),true,'no code on the remembered browser');
    assert.equal(await codesSent(),before,'no email was sent');
    await signIn(request.agent(app)).expect(303).expect('location','/login/code');
    assert.equal(await codesSent(),before+1,'another browser still needs a code');
    await f.db.query("UPDATE trusted_sign_in_devices SET expires_at=now()-interval '1 second' WHERE account_id=$1",[f.owner.accountId]);
    await signOut(browser);
    await signIn(browser).expect(303).expect('location','/login/code');
  });

  await t.test('wrong tries end a code; a new code can be sent after 30 seconds',async()=>{
    await f.db.query("UPDATE sign_in_codes SET created_at=created_at-interval '20 minutes' WHERE account_id=$1",[f.owner.accountId]);
    const browser=request.agent(app);
    await signIn(browser,{rememberMe:'1',rememberDays:'30'}).expect(303);
    const first=await latestCode();let page=await browser.get('/login/code');
    for(let attempt=1;attempt<=5;attempt+=1)page=await browser.post('/login/code').type('form').send({_csrf:csrf(page.text),code:'000000'===first?'111111':'000000',rememberMe:'1',rememberDays:'30'}).expect(400);
    assert.match(page.text,/that was the last try\. Send a new code\./);
    page=await browser.post('/login/code').type('form').send({_csrf:csrf(page.text),code:first,rememberMe:'1',rememberDays:'30'}).expect(400);
    assert.match(page.text,/Too many wrong tries\. Send a new code\./);
    const tooSoon=await browser.post('/login/code/resend').type('form').send({_csrf:csrf(page.text)}).expect(303).expect('location','/login/code');void tooSoon;
    page=await browser.get('/login/code');assert.match(page.text,/A code was just sent\. You can ask for another in \d+ seconds\./);
    await f.db.query("UPDATE sign_in_codes SET created_at=created_at-interval '1 minute' WHERE account_id=$1",[f.owner.accountId]);
    await browser.post('/login/code/resend').type('form').send({_csrf:csrf(page.text)}).expect(303);
    page=await browser.get('/login/code');assert.match(page.text,/A new code is on its way\. Use the newest email\./);
    assert.match(page.text,/name="rememberMe" value="1" checked>/,'sending a new code keeps the remember choice');
    const second=await latestCode();assert.notEqual(second,first);
    await browser.post('/login/code').type('form').send({_csrf:csrf(page.text),code:second}).expect(302);
    assert.equal(await signedIn(browser),true);
  });

  await t.test('signing out everywhere and resetting the password forget remembered browsers',async()=>{
    await f.db.query("UPDATE sign_in_codes SET created_at=created_at-interval '20 minutes' WHERE account_id=$1",[f.owner.accountId]);
    const browser=request.agent(app);
    await signIn(browser,{rememberMe:'1'}).expect(303);
    let page=await browser.get('/login/code');
    await browser.post('/login/code').type('form').send({_csrf:csrf(page.text),code:await latestCode(),rememberMe:'1',rememberDays:'30'}).expect(302);
    page=await browser.get('/inventory').expect(200);
    await browser.post('/logout-all').type('form').send({_csrf:csrf(page.text)}).expect(303);
    await signIn(browser).expect(303).expect('location','/login/code');
    const open=async()=>Number((await f.db.query('SELECT count(*) FILTER (WHERE revoked_at IS NULL) open FROM trusted_sign_in_devices WHERE account_id=$1',[f.owner.accountId])).rows[0].open);
    assert.equal(await open(),0);
    page=await browser.get('/login/code');
    await browser.post('/login/code').type('form').send({_csrf:csrf(page.text),code:await latestCode(),rememberMe:'1',rememberDays:'30'}).expect(302);
    assert.equal(await open(),1);
    await require('../../src/domain/postgres-password-recovery').request(f.db,f.email,{origin:'https://app.example.test'});
    const reset=(await f.db.query(`SELECT payload FROM stockchief_runtime.jobs WHERE kind='system.email-send'
      AND payload->>'messageType'='password_reset' ORDER BY created_at DESC,id DESC LIMIT 1`)).rows[0].payload;
    const token=new URL(email.unseal(reset).text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
    const form=await browser.get('/reset-password?token='+encodeURIComponent(token)).expect(200);
    f.password='New!'+randomUUID();
    await browser.post('/reset-password').type('form').send({_csrf:csrf(form.text),token,password:f.password,confirmPassword:f.password}).expect(303);
    assert.equal(await open(),0);
    await signIn(browser).expect(303).expect('location','/login/code');
  });

  await t.test('a sign-in left waiting too long starts again',async()=>{
    await f.db.query("UPDATE sign_in_codes SET created_at=created_at-interval '20 minutes' WHERE account_id=$1",[f.owner.accountId]);
    const browser=request.agent(app);
    await browser.get('/login/code').expect(303).expect('location','/login');
    await signIn(browser).expect(303);
    const realNow=Date.now;Date.now=()=>realNow()+21*60*1000;
    try{await browser.get('/login/code').expect(303).expect('location','/login');}finally{Date.now=realNow;}
    const login=await browser.get('/login').expect(200);assert.match(login.text,/That sign-in took too long\. Sign in again\./);
  });
});

test('sign-in codes stay off where the app cannot email them',()=>{
  const policy=require('../../src/domain/sign-in-code-policy');
  const saved={code:process.env.STOCKCHIEF_SIGN_IN_CODE,resend:process.env.RESEND_API_KEY};
  try{
    delete process.env.STOCKCHIEF_SIGN_IN_CODE;delete process.env.RESEND_API_KEY;
    assert.equal(policy.enabled('production'),false);
    process.env.RESEND_API_KEY='re_test';
    assert.equal(policy.enabled('production'),true);assert.equal(policy.enabled('development'),true);assert.equal(policy.enabled('test'),false);
    process.env.STOCKCHIEF_SIGN_IN_CODE='off';assert.equal(policy.enabled('production'),false);
    process.env.STOCKCHIEF_SIGN_IN_CODE='on';delete process.env.RESEND_API_KEY;assert.equal(policy.enabled('production'),true);
  }finally{
    for(const [key,value] of [['STOCKCHIEF_SIGN_IN_CODE',saved.code],['RESEND_API_KEY',saved.resend]])if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
});
