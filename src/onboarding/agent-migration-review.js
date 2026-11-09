'use strict';
const labels=require('./cutover-status');
async function review(db,ctx,{page=1,filter=''}){
 await require('./postgres-cutover').assertAccess(db,ctx);
 await require('../commercial/agent-plan').requireWorkspaceJob(db,ctx.workspaceId,190,'draft');
 const rows=(await db.query(`SELECT source_label "Source",status,staged_count::int "Source records",applied_count::int "Saved records",problem_count::int "Needs review",'/erp-cutovers/'||id link FROM migration_packages WHERE workspace_id=$1 AND postgres_state IS NOT NULL AND ($2='' OR lower(source_label)=lower($2) OR lower(source_namespace)=lower($2)) ORDER BY created_at DESC,id DESC LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 return {summary:'Open the saved source to review its records, problems and current worker progress. Upload a prepared ERP export from File imports. The owner must confirm the source is frozen, approve the opening position and open the inventory after every balance matches. Growth and above can use this workflow; source preparation and unresolved mappings still need review.',rows:rows.slice(0,100).map(({status,...row})=>({...row,Stage:labels[status]||'Needs review'})),more:rows.length>100};
}
module.exports={definition:{id:190,key:'erp-migrations',label:'Move data from another ERP',filterLabel:'Exact source name or source identity',readPage:review}};
