'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
test('migration fingerprints accept proven newline equivalence and never replay SQL or rewrite stored history',async()=>{
 const directory=path.resolve(__dirname,'../../src/db/postgres-migrations'),names=fs.readdirSync(directory).filter(name=>/^\d{3}-[a-z-]+\.(?:sql|js)$/.test(name)).sort(),rows=new Map();
 for(const name of names){const file=path.join(directory,name),sql=name.endsWith('.js')?require(file).render():fs.readFileSync(file,'utf8');rows.set(name,hash(sql.replace(/\r\n/g,'\n')));}
 const statements=[];
 const client={query:async(sql,values=[])=>{statements.push(sql);if(sql.startsWith('SELECT checksum'))return {rows:[{checksum:rows.get(values[0])}]};return {rows:[]};}},db={transaction:fn=>fn(client)};
 assert.deepEqual(await require('../../src/db/migrate-postgres').migratePostgres(db),[]);
 assert.equal(statements.filter(sql=>sql.startsWith('INSERT INTO stockchief_postgres_migrations')).length,0);
 assert.equal(statements.filter(sql=>sql.startsWith('UPDATE stockchief_postgres_migrations')).length,0);
 assert.equal(statements.filter(sql=>sql.includes('CREATE TABLE')&&!sql.startsWith('CREATE TABLE IF NOT EXISTS stockchief_postgres_migrations')).length,0);
 rows.set(names[0],hash('ALTER TABLE balances ADD COLUMN silently_changed integer;'));
 await assert.rejects(require('../../src/db/migrate-postgres').migratePostgres(db),/has changed/,'A different SQL operation cannot be accepted as an EOL repair');
});
