'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),{randomUUID}=require('node:crypto');

// Any route behind a form: a repeat of a key that went through lands where the
// first one did and does not run again; anything that did not go through stays free.
test('a form key that went through is not run twice, on any route',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Form keys',email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()});
 const runs={ok:0,slow:0,refused:0,render:0,away:0},notes=[];
 const app=express();app.use(express.urlencoded({extended:false}));
 app.use(require('../../src/web/form-request-keys').middleware);
 app.use((req,res,next)=>{req.ctx={workspaceId:owner.workspaceId,actorId:owner.userId};req.flash=(type,message)=>notes.push({type,message});next();});
 app.use(require('../../src/web/form-submission-replay').create(db));
 app.get('/form',(req,res)=>res.send('<form method="post" action="/ok"><button>Save</button></form>'));
 app.post('/ok',(req,res)=>{runs.ok++;res.redirect(303,'/done?n='+runs.ok);});
 app.post('/slow',async(req,res)=>{await new Promise(r=>setTimeout(r,700));runs.slow++;res.redirect(303,'/slow-done?n='+runs.slow);});
 app.post('/refused',(req,res)=>{runs.refused++;req.flash('error','That amount is too large.');res.redirect(303,'/form');});
 app.post('/render',(req,res)=>{runs.render++;res.send('<p>Preview</p>');});
 app.post('/away',(req,res)=>{runs.away++;res.redirect(303,'https://provider.example/connect?state='+runs.away);});
 const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
 t.after(async()=>{await new Promise(r=>server.close(r));await db.close();await cluster.stop();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=(path,key)=>fetch(base+path,{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:key?'idempotencyKey='+key:''})
  .then(r=>({status:r.status,location:r.headers.get('location')}));
 const fresh=()=>'form-'+randomUUID();

 await t.test('the key a page gives its form is the one a repeat is recognised by',async()=>{
  const html=await (await fetch(base+'/form')).text(),key=/name="idempotencyKey" value="([^"]+)"/.exec(html)[1];
  const first=await post('/ok',key),again=await post('/ok',key);
  assert.equal(runs.ok,1,'the second send did not run');
  assert.equal(first.location,'/done?n=1');assert.equal(again.status,303);assert.equal(again.location,'/done?n=1','the repeat lands where the first did');
  assert(notes.some(n=>n.type==='info'&&/Already saved/.test(n.message)));
 });
 await t.test('two taps at once run once',async()=>{
  const key=fresh(),both=await Promise.all([post('/slow',key),post('/slow',key)]);
  assert.equal(runs.slow,1);assert.deepEqual(both.map(r=>r.location),['/slow-done?n=1','/slow-done?n=1']);
 });
 await t.test('a refusal, a page shown in place, or a trip to another site leaves the key free',async()=>{
  const refused=fresh();await post('/refused',refused);await post('/refused',refused);assert.equal(runs.refused,2,'a corrected resend still runs');
  const shown=fresh();await post('/render',shown);await post('/render',shown);assert.equal(runs.render,2);
  const away=fresh(),first=await post('/away',away),second=await post('/away',away);
  assert.equal(runs.away,2,'single-use provider links are never replayed');assert.notEqual(first.location,second.location);
 });
 await t.test('a submission that never finished frees its key; forms without a key are untouched',async()=>{
  const key=fresh();
  await db.query(`INSERT INTO stockchief_runtime.business_operations(id,workspace_id,kind,idempotency_key,created_at) VALUES($1,$2,'web.form_submission',$3,now()-interval '3 minutes')`,['pgop-stale',owner.workspaceId,key]);
  const before=runs.ok;await post('/ok',key);assert.equal(runs.ok,before+1);
  await post('/ok');await post('/ok');assert.equal(runs.ok,before+3);
  await post('/ok','not-a-form-key');await post('/ok','not-a-form-key');assert.equal(runs.ok,before+5,'engine keys are left to the engines');
 });
});
