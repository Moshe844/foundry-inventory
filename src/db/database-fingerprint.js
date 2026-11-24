'use strict';
// A fingerprint of a StockChief database: for every table in the app's schemas, its exact
// row count and a checksum of every row's full contents, plus the migration list. Two
// databases with equal fingerprints hold the same records. Used to prove a restored copy
// equals its source (taken while saving is paused) before customers are switched over.
// Settings that change how values print (time zone, dates, floats) are fixed first, so the
// same rows give the same checksum on any server.
// stockchief_restore holds only the restore's own marker, which the source never has.
const SKIP=new Set(['pg_catalog','information_schema','stockchief_restore']);

async function take(database,{schemas=null}={}){
  return database.transaction(async client=>{
    await client.query("SET LOCAL TimeZone='UTC'");await client.query("SET LOCAL DateStyle='ISO, YMD'");
    await client.query("SET LOCAL IntervalStyle='postgres'");await client.query('SET LOCAL extra_float_digits=3');
    await client.query("SET LOCAL bytea_output='hex'");
    const tables=(await client.query(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND n.nspname NOT LIKE 'pg\\_%' ORDER BY 1,2`)).rows
      .filter(t=>!SKIP.has(t.schema)&&(!schemas||schemas.includes(t.schema)));
    const result={tables:{},migrations:null};
    for(const t of tables){
      const id='"'+t.schema.replaceAll('"','""')+'"."'+t.name.replaceAll('"','""')+'"';
      // Order-independent: the sum of a 64-bit hash of each row's text form.
      const row=(await client.query(`SELECT count(*)::text AS rows,coalesce(sum(hashtextextended(x::text,0)),0)::text AS checksum FROM ${id} x`)).rows[0];
      result.tables[t.schema+'.'+t.name]={rows:Number(row.rows),checksum:row.checksum};
    }
    const migrations=result.tables['public.stockchief_postgres_migrations']?(await client.query('SELECT name FROM stockchief_postgres_migrations ORDER BY name')).rows.map(r=>r.name):[];
    result.migrations={count:migrations.length,last:migrations.at(-1)||null};
    result.totalRows=Object.values(result.tables).reduce((n,t)=>n+t.rows,0);
    return result;
  },{isolation:'REPEATABLE READ',readOnly:true,statementTimeoutMs:3600000});
}

// Differences between a source and a copy; an empty list means the copy is exact.
function compare(source,copy){
  const problems=[];
  for(const [name,t]of Object.entries(source.tables)){const c=copy.tables[name];
    if(!c)problems.push({table:name,problem:'missing in copy'});
    else if(c.rows!==t.rows)problems.push({table:name,problem:'row count',source:t.rows,copy:c.rows});
    else if(c.checksum!==t.checksum)problems.push({table:name,problem:'contents differ',rows:t.rows});}
  for(const name of Object.keys(copy.tables))if(!source.tables[name])problems.push({table:name,problem:'only in copy'});
  if(source.migrations?.last!==copy.migrations?.last||source.migrations?.count!==copy.migrations?.count)problems.push({table:'migrations',problem:'migration list differs',source:source.migrations,copy:copy.migrations});
  return problems;
}

module.exports={take,compare};
