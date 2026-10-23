'use strict';
const {escapeIdentifier}=require('pg');
// Host-only schema setup. Take the same relation locks that policy installation
// needs without waiting while holding a partial set. A competing native goal
// can otherwise hold its parent row while setup holds its event table.
async function mutate(database,tables,operation){
 const names=[...new Set(tables.map(t=>escapeIdentifier(t.table_schema)+'.'+escapeIdentifier(t.table_name)))].sort();
 if(!names.length||typeof operation!=='function')throw new TypeError('Inspection schema scope required.');
 for(let attempt=0;;attempt++){
  try{return await require('./inspection-metadata').transaction(database,async client=>{
   await client.query('LOCK TABLE '+names.join(',')+' IN ACCESS EXCLUSIVE MODE NOWAIT');
   return operation(client);
  },{isolation:'SERIALIZABLE',retrySafe:true});}
  catch(error){
   // Only an unstarted, rolled-back schema setup may be retried. No model,
   // browser action, business operation or spending reservation is repeated.
   if(error.code!=='55P03'||attempt>=11)throw error;
   await new Promise(resolve=>setTimeout(resolve,Math.min(1000,15*2**Math.min(attempt,6))+Math.floor(Math.random()*15)));
  }
 }
}
module.exports={mutate};
