'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const access=require('../../src/domain/postgres-reviewer-access');
const now=Date.UTC(2026,10,25,18);
const secret='reviewer-token-test-secret-that-is-not-production';
const row={id:'acc_review',email:'review@example.test',workspace_id:'wsp_review',password_hash:'salted-password-hash',revision:0,
  subscription_id:'sub_review',plan_id:'starter',trial_ends_at:new Date(now+40*86400000)};
test('review credential is signed, scoped and bounded to thirty days',()=>{
  const {token,claims}=access.ticket(row,{now,secret});
  assert.equal(claims.e,now+30*86400000);assert.equal(claims.a,row.id);assert.equal(claims.w,row.workspace_id);
  assert.deepEqual(access.decode(token,{now,secret}),claims);assert.ok(!token.includes(row.password_hash));
  assert.throws(()=>access.decode(token.slice(0,-1)+(token.endsWith('A')?'B':'A'),{now,secret}));
  assert.throws(()=>access.decode(token,{now,secret:'a-different-secret-at-least-24-characters'}));
  assert.throws(()=>access.decode(token,{now:claims.e,secret}));
});
test('review credential expires earlier when its trial ends earlier',()=>{
  const expires=now+1000;const {claims}=access.ticket({...row,trial_ends_at:new Date(expires)},{now,secret});
  assert.equal(claims.e,expires);assert.throws(()=>access.ticket({...row,trial_ends_at:new Date(now)},{now,secret}));
});
test('active review session rejects password, account-access, plan and trial changes',async()=>{
  const current={...row,trial_ends_at:new Date(now+86400000)};
  const {claims}=access.ticket(current,{now,secret});
  let returned=current;const db={query:async()=>({rows:returned?[returned]:[]})};
  assert.equal(await access.validateSession(db,claims,row.id,row.workspace_id,{now,secret}),true);
  assert.equal(await access.validateSession(db,claims,'another-account',row.workspace_id,{now,secret}),false);
  assert.equal(await access.validateSession(db,claims,row.id,'another-inventory',{now,secret}),false);
  for(const changed of [{password_hash:'new-password'},{revision:1},{plan_id:'pro'},{subscription_id:'replacement'},
    {subscription_revision:'new-grant-revision'},
    {trial_ends_at:new Date(now+2*86400000)}]){
    returned={...current,...changed};
    assert.equal(await access.validateSession(db,claims,row.id,row.workspace_id,{now,secret}),false);
  }
  returned=null;assert.equal(await access.validateSession(db,claims,row.id,row.workspace_id,{now,secret}),false);
});
test('malformed and oversized review credentials fail closed',()=>{
  for(const token of [undefined,'','sr1.bad.bad','x'.repeat(3000),'https://example.invalid/'])assert.throws(()=>access.decode(token,{now,secret}));
});

test('browser handoff moves the private credential into the form and removes it from history',()=>{
  const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../../src/web/public/reviewer-login.js'),'utf8');
  const run=hash=>{const field={value:''},replaced=[];require('node:vm').runInNewContext(source,{
    document:{getElementById:id=>id==='review-token'?field:null},location:{hash,pathname:'/reviewer-login'},
    URLSearchParams,history:{replaceState:(...args)=>replaced.push(args)}});return{field,replaced};};
  const {token}=access.ticket(row,{now,secret}),result=run('#access='+token);
  assert.equal(result.field.value,token);assert.deepEqual(result.replaced,[[null,'','/reviewer-login']]);
  assert.equal(run('#access='+'a'.repeat(2049)).field.value,'');
  assert.equal(run('').field.value,'','a request without the private fragment cannot invent a credential');
});
