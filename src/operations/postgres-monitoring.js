'use strict';

const crypto=require('node:crypto');
const { newId,nowIso }=require('../lib/util');
const checkpoints=require('./postgres-checkpoints');

function fingerprint(input){
  if(input.fingerprint)return String(input.fingerprint);
  return crypto.createHash('sha256').update(`${input.kind || 'runtime'}\0${input.title || ''}\0${input.detail || ''}`).digest('hex');
}

async function raise(database,input={}){
  const at=nowIso();const fp=fingerprint(input);const workspaceId=input.workspaceId||null;
  const existing=await database.query(`UPDATE operational_alerts SET occurrence_count=occurrence_count+1,
    last_seen_at=$3,detail=$4 WHERE fingerprint=$1 AND workspace_id IS NOT DISTINCT FROM $2
    AND status IN ('OPEN','DELIVERED','ACKNOWLEDGED') RETURNING *`,
  [fp,workspaceId,at,String(input.detail || '')]);
  if(existing.rows.length)return existing.rows[0];
  const result=await database.query(`INSERT INTO operational_alerts(id,workspace_id,severity,kind,title,detail,fingerprint,status,
    occurrence_count,first_seen_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,$7,'OPEN',1,$8,$8) RETURNING *`,
  [newId('alert'),workspaceId,input.severity || 'ERROR',input.kind || 'runtime',String(input.title || 'StockChief operational alert'),
    String(input.detail || ''),fp,at]);
  return result.rows[0];
}

async function acknowledge(database,id,actor){
  const at=nowIso();
  const result=await database.query(`UPDATE operational_alerts SET status='ACKNOWLEDGED',
    acknowledged_at=$2,acknowledged_by=$3 WHERE id=$1 AND status IN ('OPEN','DELIVERED') RETURNING *`,
  [id,at,String(actor||'external responder')]);
  if(!result.rows.length)return null;
  await checkpoints.record(database,'alert.acknowledged','PASS',{alertId:id,actor:String(actor||'external responder')});
  return result.rows[0];
}

module.exports={fingerprint,raise,acknowledge};
