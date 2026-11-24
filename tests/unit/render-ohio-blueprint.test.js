'use strict';
// The Ohio services must match the Virginia ones except where the AWS move requires a change.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'../..',name),'utf8').replace(/\r\n/g,'\n');
const field=(text,key)=>[...text.matchAll(new RegExp('^\\s*'+key+':\\s*(.+)$','gm'))].map(m=>m[1].trim());
test('the Ohio services mirror Virginia, use the AWS logins, and create no Render database',()=>{
 const ohio=read('render.production-ohio.yaml'),pilot=read('render.production-pilot.yaml');
 const yaml=ohio.split('\n').filter(line=>!line.trim().startsWith('#')).join('\n');
 assert.deepEqual(field(yaml,'region'),['ohio','ohio']);
 assert.deepEqual(field(yaml,'name'),['stockchief-production-web-ohio','stockchief-production-worker-ohio']);
 assert.doesNotMatch(yaml,/^\s*(databases|projects):/m,'no Render database or project is created');
 assert.doesNotMatch(yaml,/fromDatabase|FINGERPRINT256/,'never the Render database or its certificate pin');
 const services=pilot.slice(pilot.indexOf('services:'));
 for(const key of ['runtime','repo','branch','plan','autoDeployTrigger','buildCommand','preDeployCommand','startCommand','healthCheckPath','maxShutdownDelaySeconds'])
  assert.deepEqual(field(yaml,key),field(services,key),key+' matches Virginia');
 assert.equal((yaml.match(/fromGroup: stockchief-production-runtime/g)||[]).length,2,'shared session and encryption keys');
 for(const key of ['FOUNDRY_DATABASE_URL','FOUNDRY_DATABASE_MIGRATION_URL'])assert.equal((yaml.match(new RegExp('key: '+key+'\\n\\s+sync: false','g'))||[]).length,2,key+' is set by hand on both');
 assert.equal((yaml.match(/key: FOUNDRY_DATABASE_RUNTIME_ROLE\n\s+value: stockchief_runtime/g)||[]).length,2);
 assert.match(yaml,/key: FOUNDRY_IMPORT_STOCK_WORKERS\n\s+value: "4"/);
});
test('the Ohio worker starts paused so it cannot run jobs before the switch',()=>{
 const yaml=read('render.production-ohio.yaml');
 assert.match(yaml,/name: stockchief-production-worker-ohio[\s\S]*key: FOUNDRY_WORKER_PAUSED\n\s+value: "true"/);
 assert.equal((yaml.match(/FOUNDRY_WORKER_PAUSED/g)||[]).length,2,'mentioned once in a comment and set once, on the worker only');
});
