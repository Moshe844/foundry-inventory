'use strict';
// The production Blueprint's sync is paused; a Manual Sync applies this file. It must never
// ask for a smaller database than the live one (1 CPU / 2 GB since it was upgraded in the
// dashboard): on 2026-11-24 a sync preview offered to shrink and restart it.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('the production Blueprint keeps the live database size and warns before any sync',()=>{
 const text=fs.readFileSync(path.join(__dirname,'../../render.production-pilot.yaml'),'utf8').replace(/\r\n/g,'\n');
 const database=text.slice(text.indexOf('        databases:'),text.indexOf('        services:'));
 assert.match(database,/name: stockchief-production\n[\s\S]*?plan: 1c-2g/);
 assert.match(text.split('\n')[0],/Do not run a Manual Sync without reviewing every/);
});
