'use strict';

const { encrypt,decrypt }=require('./credentials');
const { newId,nowIso }=require('../lib/util');

async function put(queryable,workspaceId,connectorId,kind,value,expiresAt=null){
  const sealed=encrypt(value);
  const now=nowIso();
  await queryable.query(`INSERT INTO connection_credentials
    (id,workspace_id,connector_id,credential_kind,ciphertext,iv,auth_tag,expires_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
    ON CONFLICT(workspace_id,connector_id,credential_kind) DO UPDATE SET
      ciphertext=EXCLUDED.ciphertext,iv=EXCLUDED.iv,auth_tag=EXCLUDED.auth_tag,
      expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at`,
  [newId('ccred'),workspaceId,connectorId,kind,sealed.ciphertext,sealed.iv,sealed.authTag,expiresAt,now]);
}

async function get(queryable,workspaceId,connectorId,kind){
  const result=await queryable.query(`SELECT * FROM connection_credentials
    WHERE workspace_id=$1 AND connector_id=$2 AND credential_kind=$3`,[workspaceId,connectorId,kind]);
  return result.rows[0]?decrypt(result.rows[0]):null;
}

async function remove(queryable,workspaceId,connectorId){
  await queryable.query('DELETE FROM connection_credentials WHERE workspace_id=$1 AND connector_id=$2',
    [workspaceId,connectorId]);
}

module.exports={put,get,remove};
