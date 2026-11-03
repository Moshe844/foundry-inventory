'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),request=require('supertest');
test('a database deadline returns a friendly 503, hides SQL details and leaves the server healthy',async t=>{
 t.mock.method(console,'error',()=>{});const app=express();app.use((req,res,next)=>{res.page=(view,data)=>res.json({view,...data});next();});
 app.get(['/inventory','/api/inventory'],(req,res,next)=>next(Object.assign(new Error('SELECT internal secret query failed'),{code:'57014'})));
 app.get('/healthz',(req,res)=>res.json({ok:true}));app.use(require('../../src/web/middleware').errorHandler(false));
 for(const path of ['/inventory','/api/inventory']){const page=await request(app).get(path).set('Accept',path.startsWith('/api/')?'application/json':'text/html');assert.equal(page.status,503);assert.doesNotMatch(page.text,/internal|SELECT|57014|Something went wrong/);assert.match(page.text,/request took too long/);}
 assert.equal((await request(app).get('/healthz')).status,200);
});
