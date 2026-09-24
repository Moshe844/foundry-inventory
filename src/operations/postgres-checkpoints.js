'use strict';

const { nowIso }=require('../lib/util');

function object(value){
  if(value&&typeof value==='object')return value;
  try{return JSON.parse(value||'{}');}catch{return {};}
}

async function record(database,key,status,detail={},options={}){
  const checkedAt=options.checkedAt||nowIso();
  await database.query(`INSERT INTO runtime_checkpoints(check_key,status,detail,checked_at)
    VALUES($1,$2,$3,$4) ON CONFLICT(check_key) DO UPDATE SET status=EXCLUDED.status,
    detail=EXCLUDED.detail,checked_at=EXCLUDED.checked_at`,[key,status,JSON.stringify(detail||{}),checkedAt]);
  return get(database,key);
}

async function get(database,key){
  const row=(await database.query('SELECT * FROM runtime_checkpoints WHERE check_key=$1',[key])).rows[0];
  return row?{key:row.check_key,status:row.status,detail:object(row.detail),checkedAt:row.checked_at}:null;
}

async function list(database){
  const rows=(await database.query('SELECT * FROM runtime_checkpoints ORDER BY check_key')).rows;
  return rows.map((row)=>({key:row.check_key,status:row.status,detail:object(row.detail),checkedAt:row.checked_at}));
}

async function merge(database,key,status,detail={},options={}){
  const prior=await get(database,key);
  return record(database,key,status,{...(prior?.detail||{}),...(detail||{})},options);
}

module.exports={record,get,list,merge};
