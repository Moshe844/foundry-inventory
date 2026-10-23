'use strict';
// PostgreSQL catalogue grants can conflict even when different short-lived
// roles are being created. Retry only this known, transaction-aborting error
// after the host database wrapper has rolled the entire metadata change back.
// Unknown connection/commit outcomes and business operations are never retried.
const concurrentCatalog=error=>error?.code==='XX000'&&error.message==='tuple concurrently updated';
async function transaction(database,operation,settings){
 for(let attempt=0;;attempt++){
  try{return await database.transaction(operation,settings);}
  catch(error){
   if(!concurrentCatalog(error)||attempt>=7)throw error;
   await new Promise(resolve=>setTimeout(resolve,Math.min(400,15*2**attempt)+Math.floor(Math.random()*20)));
  }
 }
}
module.exports={concurrentCatalog,transaction};
