'use strict';
// Upgrade tests run today's code on a database migrated only part of the way,
// so shared paths (order confirmation, stock availability) must not name a
// table or column that a later migration adds. Ask here first.
//
// Answers are remembered per connection object (a pool-level database or one
// transaction), never process-wide: one test process can hold both an upgraded
// and an older database. Only "present" is remembered, because migrations only
// ever add, so a database that lacked something may gain it later.
const remembered=new WeakMap();

// has(db,'stockchief_runtime.some_table') or has(db,'some_view','some_column').
async function has(db,table,column=null){
  const key=table+'|'+(column||'');
  let known=remembered.get(db);
  if(known?.has(key))return true;
  const {rows:[row]}=column
    ?await db.query(`SELECT EXISTS(SELECT 1 FROM pg_attribute
        WHERE attrelid=to_regclass($1) AND attname=$2 AND attnum>0 AND NOT attisdropped) AS ok`,[table,column])
    :await db.query('SELECT to_regclass($1) IS NOT NULL AS ok',[table]);
  if(row.ok){if(!known)remembered.set(db,known=new Set());known.add(key);}
  return row.ok;
}

module.exports={has};
