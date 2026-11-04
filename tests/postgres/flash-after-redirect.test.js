'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),session=require('express-session');

test('a message queued before a redirect is shown on the page the browser lands on, even with a slow session store',{timeout:60000},async t=>{
  const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
  const store=new(require('../../src/web/postgres-session-store').PostgresSessionStore)(db);
  t.after(async()=>{await store.close();await db.close();await cluster.stop();});await store.ready;
  // Simulate a busy database: every session write takes a while to land.
  const set=store.set.bind(store);store.set=(sid,value,callback)=>setTimeout(()=>set(sid,value,callback),300);
  const app=express();
  app.use(session({name:'sid',secret:'test-secret',store,resave:false,saveUninitialized:false,rolling:true}));
  app.use(require('../../src/web/middleware').flash);
  app.get('/start',(req,res)=>{req.session.accountId='owner';res.send('ok');});
  app.post('/save',(req,res)=>{req.flash('success','Draft saved.');res.redirect('/done');});
  app.get('/done',(req,res)=>{const shown=res.locals.flash.map(m=>m.message);req.session.flash=[];res.json(shown);});
  const server=app.listen(0);t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
  const started=await fetch(`${base}/start`),cookie=started.headers.get('set-cookie').split(';')[0];
  // Cookie headers can arrive before this initial session exists in the store.
  // Establish the test session before exercising immediate redirect following.
  assert.equal(await started.text(),'ok');
  for(let round=0;round<3;round++){
    const landed=await fetch(`${base}/save`,{method:'POST',headers:{cookie}});
    assert.deepEqual(await landed.json(),['Draft saved.']);
  }
});
