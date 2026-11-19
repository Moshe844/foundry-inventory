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
   await operation();
   throw rollback;
  });
 }catch(error){if(error!==rollback)throw error;}
 finally{database.query=originalQuery;database.transaction=originalTransaction;}
}
module.exports={reviewedChangeWithoutCommit};
