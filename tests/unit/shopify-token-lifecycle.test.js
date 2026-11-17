'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),life=require('../../src/connections/shopify-token-lifecycle');
test('nested same-store operations keep one session until all awaited work finishes',async()=>{
 let locks=0;const db={withSessionLock:async(_key,operation)=>{locks++;const session={closed:false};try{return await operation(session);}finally{session.closed=true;}}};
 const result=await life.run(db,'public-app','fixture.myshopify.com',session=>life.run(db,'public-app','fixture.myshopify.com',same=>{assert.equal(same,session);assert.equal(same.closed,false);return 'saved';}));
 assert.equal(result,'saved');assert.equal(locks,1);
});
test('late inherited async work acquires a new session after the original lease closes',async()=>{
 let locks=0,release,late;const later=new Promise(resolve=>{release=resolve;}),db={withSessionLock:async(_key,operation)=>{locks++;const session={closed:false};try{return await operation(session);}finally{session.closed=true;}}};
 await life.run(db,'public-app','fixture.myshopify.com',async()=>{late=later.then(()=>life.run(db,'public-app','fixture.myshopify.com',session=>{assert.equal(session.closed,false);return 'current session';}));});
 release();assert.equal(await late,'current session');assert.equal(locks,2,'An inherited context cannot reuse a released database connection');
});
test('a busy store never runs the operation and remains retryable',async()=>{
 let attempted=false;await assert.rejects(life.run({withSessionLock:async()=>({busy:true})},'public-app','fixture.myshopify.com',()=>{attempted=true;}),error=>error.transient===true&&error.retryable===true&&/finishing/.test(error.message));assert.equal(attempted,false);
});

test('a handle without session locking refuses Shopify token access with a safe diagnostic code',async()=>{
 let attempted=false;await assert.rejects(life.run({query:async()=>{}},'public-app','fixture.myshopify.com',()=>{attempted=true;}),error=>error.code==='SHOPIFY_SESSION_LOCK_UNAVAILABLE'&&error.transient===true&&error.retryable===true);assert.equal(attempted,false);
});
