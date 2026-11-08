'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
test('slow request evidence is bounded and excludes URL, SQL literals and bind values',async()=>{
 const metrics=require('../../src/commercial/resource-metrics'),lines=[],prior=console.info,db={query:async()=>({rows:[]})};console.info=(...args)=>lines.push(args);
 try{await new Promise((resolve,reject)=>{const res=new EventEmitter();Object.assign(res,{statusCode:200,writableFinished:true});const req={path:'/private-id',method:'GET',route:{path:'/inventory/:id'},query:{token:'never-record'}};
  metrics.middleware(db)(req,res,()=>{for(let n=0;n<12;n++)metrics.queryFinished(process.hrtime.bigint()-100000000n,"SELECT id FROM work_items WHERE title='private title' AND notes=$body$secret text$body$ AND id=$1 LIMIT 123");setTimeout(()=>{try{res.emit('finish');resolve();}catch(e){reject(e);}},510);});});
  assert.equal(lines.length,1);assert.equal(lines[0][0],'STOCKCHIEF_SLOW_REQUEST');const row=JSON.parse(lines[0][1]);assert.equal(row.route,'GET /inventory/:id');assert.equal(row.queries,12);assert.equal(row.slowQueries.length,5);assert(row.elapsedMs>=500);assert.doesNotMatch(JSON.stringify(row),/private title|secret text|123|never-record|private-id/);assert.match(row.slowQueries[0].sql,/work_items/);
 }finally{console.info=prior;}
});
