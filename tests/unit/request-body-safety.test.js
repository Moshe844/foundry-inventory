'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),{fork}=require('node:child_process');
test('compressed JSON, forms and raw bodies remain usable; trailing bytes cannot crash the request parser',{timeout:15000},async t=>{
 const child=fork(path.join(__dirname,'../helpers/compressed-body-probe-server.js'),[],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']}),tails=new Map();let errors='';child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-2000);});child.stdout.resume();
 let exit;const exited=new Promise(r=>child.once('exit',(code,signal)=>{exit={code,signal};r();}));
 t.after(async()=>{if(exit)return;if(child.connected)child.send('stop');let timer;await Promise.race([exited,new Promise(r=>{timer=setTimeout(r,500);})]);clearTimeout(timer);if(!exit){child.kill();await exited;}});
 const ready=await new Promise((resolve,reject)=>{child.on('message',m=>{if(m.kind==='ready')resolve(m);if(m.kind==='parsed')tails.get(m.id)?.();});child.once('error',reject);child.once('exit',()=>reject(Error('Parser server exited before readiness')));});
 function post(encoding,body,{type='application/json',tail=null,id=''}={}){return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:ready.port,path:'/probe',method:'POST',agent:false,headers:{'content-type':type,'content-encoding':encoding,'content-length':body.length+(tail?.length||0),...(tail?{'x-delayed-tail':id}:{})}},res=>{let data='';res.setEncoding('utf8');res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));});
  req.setTimeout(3000,()=>req.destroy(Error('Parser did not finish the request')));req.once('error',error=>{error.message+='; isolated parser stderr: '+errors;reject(error);});
  if(tail){tails.set(id,()=>{tails.delete(id);req.end(tail);});req.write(body);}else req.end(body);
 });}
 for(const [type,text]of [['application/json','{"value":"kept"}'],['application/x-www-form-urlencoded','value=kept'],['application/octet-stream','kept']]){
  const response=await post('gzip',zlib.gzipSync(text),{type});assert.equal(response.status,200);assert.equal(response.body.value,'kept');assert.equal(response.body.pid,ready.pid);
 }
 // The decoder can finish before the HTTP body ends. Deliver the tail only
 // after downstream middleware has observed the parsed first frame.
 for(const [n,type]of ['application/json','application/x-www-form-urlencoded','application/octet-stream'].entries()){
  const text=n===0?'{"value":"kept"}':n===1?'value=kept':'kept',first=Buffer.concat([zlib.deflateSync(text),Buffer.from([0])]),tail=Buffer.alloc(8192,0x58);
  const response=await post('deflate',first,{type,tail,id:'tail-'+n});assert.equal(response.status,200);assert.equal(response.body.value,'kept');assert.equal(response.body.pid,ready.pid);assert.equal(response.body.wireHash,crypto.createHash('sha256').update(first).update(tail).digest('hex'));
 }
 const gzipWithTrailingBytes=Buffer.concat([zlib.gzipSync('{"value":"kept"}'),Buffer.from([0]),Buffer.alloc(100*1024,0x58)]);
 const trailing=await post('gzip',gzipWithTrailingBytes);assert.equal(trailing.status,200);assert.equal(trailing.body.value,'kept');
 assert.equal((await post('gzip',Buffer.from('invalid compressed data'))).status,400);assert.equal((await post('gzip',zlib.gzipSync('"'+'.'.repeat(300*1024)+'"'))).status,413);
 await new Promise(r=>setTimeout(r,100));assert.equal(exit,undefined,'Malformed bodies terminated the isolated server: '+errors);const health=await(await fetch('http://127.0.0.1:'+ready.port+'/health')).json();assert.equal(health.pid,ready.pid);assert(health.ok);
});
