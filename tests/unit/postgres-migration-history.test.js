'use strict';const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
test('previously deployed migration statements stay immutable, including transitive schema templates',()=>{
 const baseline=require('../fixtures/postgres-migration-history.json');assert(Object.hasOwn(baseline,'000-business-schema.js'));
 for(const[name,expected]of Object.entries(baseline)){const file=path.join(__dirname,'../../src/db/postgres-migrations',name),sql=name.endsWith('.js')?require(file).render():fs.readFileSync(file,'utf8');assert.equal(crypto.createHash('sha256').update(sql.replace(/\r\n/g,'\n')).digest('hex'),expected,'Use a new migration instead of changing applied SQL: '+name);}
});
