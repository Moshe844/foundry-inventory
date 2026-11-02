'use strict';
// Resolve matching plans once, then seek their source rows by import identity.
// The generic plan used by large imports must not scan every historical row
// in an inventory for each 500-row page. Keep every read inventory-scoped.
async function read(database,workspaceId,sourceHash,rowNumbers=null){
 if(!sourceHash)return [];
 const scopedRows=rowNumbers===null?'':' AND r.row_number=ANY($3::bigint[])';
 return (await database.query(`SELECT r.row_number,r.raw FROM import_rows r
  WHERE r.workspace_id=$1 AND r.import_id=ANY(ARRAY(
   SELECT p.id FROM import_plans p WHERE p.workspace_id=$1 AND p.source_hash=$2))
  AND r.status='IMPORTED'${scopedRows}`,
 rowNumbers===null?[workspaceId,sourceHash]:[workspaceId,sourceHash,rowNumbers])).rows;
}
module.exports={read};
