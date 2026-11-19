'use strict';

// Exercise the actual individually approved operation while retaining the
// original fixture for its independent after-watch, replay and downgrade checks.
// These services persist reviewed work; provider effects are delivered separately.
async function reviewedChangeWithoutCommit(database,operation){
 const originalQuery=database.query,originalTransaction=database.transaction;
 const rollback=new Error('Reviewed-change fixture rollback');
 try{
  await originalTransaction(async client=>{
   database.query=(...args)=>client.query(...args);
   database.transaction=async work=>work(client);
   const result=await client.query("SELECT u.workspace_id,u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id WHERE u.role='owner' AND w.deletion_requested_at IS NULL ORDER BY u.created_at,u.id LIMIT 1");
   const owner=result.rows[0];
   await require('../../src/commercial/individual-approval').run({workspaceId:owner.workspace_id,actorId:owner.id},operation);
   throw rollback;
  });
 }catch(error){if(error!==rollback)throw error;}
 finally{database.query=originalQuery;database.transaction=originalTransaction;}
}
module.exports={reviewedChangeWithoutCommit};
