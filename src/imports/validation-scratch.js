'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Database=require('better-sqlite3');

// Exact cross-page duplicate/conflict checks must outlive individual batches.
// A disposable indexed scratch file bounds RAM without sampling away conflicts.
// It is never the system of record: approved inputs and business writes stay in
// PostgreSQL, and every analysis removes this file on success or failure.
function create(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-import-validation-'));
 let db;
 try{
  db=new Database(path.join(directory,'checks.sqlite'));
  db.pragma('journal_mode = OFF');db.pragma('synchronous = OFF');db.pragma('cache_size = -16384');db.pragma('mmap_size = 0');
  db.exec('CREATE TABLE checks (scope TEXT NOT NULL,key TEXT NOT NULL,value TEXT,PRIMARY KEY(scope,key)) WITHOUT ROWID');
  db.exec('BEGIN');
  const find=db.prepare('SELECT value FROM checks WHERE scope=? AND key=?'),has=db.prepare('SELECT 1 FROM checks WHERE scope=? AND key=?');
  const put=db.prepare('INSERT INTO checks(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value');
  const entries=db.prepare('SELECT key,value FROM checks WHERE scope=? ORDER BY key');
  const map=scope=>({has:key=>Boolean(has.get(scope,key)),get:key=>{const row=find.get(scope,key);return row?JSON.parse(row.value):undefined;},set(key,value){put.run(scope,key,JSON.stringify(value));return this;},add(key){put.run(scope,key,'true');return this;},*[Symbol.iterator](){for(const row of entries.iterate(scope))yield [row.key,JSON.parse(row.value)];}});
  return {map,state:{serials:map('serial'),prices:map('price'),positions:map('position'),reorders:map('reorder'),quantityTotal:0},close(){db.close();fs.rmSync(directory,{recursive:true,force:true});}};
 }catch(error){db?.close();fs.rmSync(directory,{recursive:true,force:true});throw error;}
}
module.exports={create};
