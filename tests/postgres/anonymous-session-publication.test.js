'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),session=require('express-session');

test('new form sessions reach PostgreSQL before any response headers can publish their cookie',{timeout:60000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString),store=new(require('../../src/web/postgres-session-store').PostgresSessionStore)(db);
 let release,announce;const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{announce=resolve;});
 const original=store.set.bind(store);let first=true;
 store.set=(sid,value,done)=>{if(first&&value.csrfToken){first=false;announce();held.then(()=>original(sid,value,done));return;}return original(sid,value,done);};
 const app=express();app.use(session({secret:'isolated-initial-form-session',store,resave:false,saveUninitialized:false,rolling:true}));app.use(require('../../src/web/middleware').csrf);
 app.get('/register',(req,res)=>res.type('html').send('<form><input name="_csrf" value="'+res.locals.csrfToken+'"></form>'+ ' '.repeat(32768)));
 app.get('/background',(req,res)=>res.json({csrf:res.locals.csrfToken}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),base='http://127.0.0.1:'+server.address().port;
 let responseArrived=false;const request=fetch(base+'/register').then(response=>{responseArrived=true;return response;});
 t.after(async()=>{release();await request.catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await store.close();await db.close();await cluster.stop();});
 await started;await new Promise(resolve=>setTimeout(resolve,150));
 assert.equal(responseArrived,false,'An unfinished initial session save must not publish form HTML or Set-Cookie headers');
 release();const response=await request,html=await response.text(),cookie=response.headers.getSetCookie()[0].split(';')[0],csrf=/name="_csrf" value="([^"]+)"/.exec(html)[1];
 assert.equal(response.status,200);const background=await fetch(base+'/background',{headers:{cookie}});assert.equal((await background.json()).csrf,csrf,'A concurrent background read must resolve the same persisted form session');
 t.diagnostic(JSON.stringify({initialFormCookieWaitsForPersistence:true,backgroundTokenMatches:true,realPostgreSQL:true,browserUsed:false}));
});

test('a failed initial CSRF session save cannot publish a usable form',{timeout:60000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString),store=new(require('../../src/web/postgres-session-store').PostgresSessionStore)(db);
 store.set=(sid,value,done)=>setImmediate(()=>done(Object.assign(Error('Synthetic session failure'),{code:'FIXTURE_SESSION_FAILURE'})));
 const app=express();app.use(session({secret:'isolated-failed-form-session',store,resave:false,saveUninitialized:false}));app.use(require('../../src/web/middleware').csrf);let rendered=false;
 app.get('/register',(req,res)=>{rendered=true;res.send('<form>Must not be published</form>');});app.use((error,req,res,next)=>{res.status(503).send('Please try again shortly.');});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await store.close();await db.close();await cluster.stop();});
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/register'),body=await response.text();assert.equal(response.status,503);assert.equal(rendered,false);assert(!body.includes('<form>'));assert.equal(response.headers.get('set-cookie'),null);
});
