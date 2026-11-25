'use strict';
// The Ohio services live in the production Blueprint's Production environment (Render links
// the shared settings group only within one environment). They must match the Virginia
// services except where the AWS move requires a change.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const text=fs.readFileSync(path.join(__dirname,'../../render.production-pilot.yaml'),'utf8').replace(/\r\n/g,'\n');
const uncomment=part=>part.split('\n').filter(line=>!line.trim().startsWith('#')).join('\n');
const cut=text.indexOf('# Ohio, next to the AWS database'),virginia=uncomment(text.slice(text.indexOf('        services:'),cut)),ohio=uncomment(text.slice(cut));
const field=(part,key)=>[...part.matchAll(new RegExp('^\\s*'+key+':\\s*(.+)$','gm'))].map(m=>m[1].trim());
test('the Ohio services mirror Virginia in the same environment and use the AWS logins',()=>{
 assert(cut>0,'Ohio services are in the production Blueprint');
 assert.equal((text.match(/^\s+- name: Production$/gm)||[]).length,1,'one Production environment');
 assert.deepEqual(field(ohio,'region'),['ohio','ohio']);assert.deepEqual(field(virginia,'region'),['virginia','virginia']);
 assert.deepEqual(field(ohio,'name'),['stockchief-production-web-ohio','stockchief-production-worker-ohio']);
 assert.doesNotMatch(ohio,/fromDatabase|FINGERPRINT256|databases:/,'never the Render database or its certificate pin');
 for(const key of ['runtime','repo','branch','plan','autoDeployTrigger','buildCommand','preDeployCommand','startCommand','healthCheckPath','maxShutdownDelaySeconds'])
  assert.deepEqual(field(ohio,key),field(virginia,key),key+' matches Virginia');
 assert.equal((ohio.match(/fromGroup: stockchief-production-runtime/g)||[]).length,2,'shared session and encryption keys');
 for(const key of ['FOUNDRY_DATABASE_URL','FOUNDRY_DATABASE_MIGRATION_URL'])assert.equal((ohio.match(new RegExp('key: '+key+'\\n\\s+sync: false','g'))||[]).length,2,key+' is set by hand on both');
 assert.equal((ohio.match(/key: FOUNDRY_DATABASE_RUNTIME_ROLE\n\s+value: stockchief_runtime/g)||[]).length,2);
 assert.match(ohio,/key: FOUNDRY_IMPORT_STOCK_WORKERS\n\s+value: "4"/);
 assert.equal((ohio.match(/key: FOUNDRY_POSTGRES_DISK_GB\n\s+value: "50"/g)||[]).length,2,"the AWS database's disk size for alerts");
});
test('the Ohio worker starts paused so it cannot run jobs before the switch; Virginia is unchanged',()=>{
 assert.match(ohio,/name: stockchief-production-worker-ohio[\s\S]*key: FOUNDRY_WORKER_PAUSED\n\s+value: "true"/);
 assert.equal((ohio.match(/FOUNDRY_WORKER_PAUSED/g)||[]).length,1);
 assert.doesNotMatch(virginia,/FOUNDRY_WORKER_PAUSED|MIGRATION_URL|RUNTIME_ROLE/,'Virginia keeps its Render database settings');
});
