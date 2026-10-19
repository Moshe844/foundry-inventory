'use strict';
// Host-only coordination for one run's competing checkpoint and progress
// writers. PostgreSQL remains authoritative; no lease, permission, receipt or
// financial decision is cached here. Queue before acquiring any DB client.
function createQueue(){
 let tail=Promise.resolve();
 return operation=>{
  if(typeof operation!=='function')throw new TypeError('A goal write operation is required.');
  const result=tail.then(operation);
  // A failed write must reject its caller and still release later cleanup or
  // progress writes. The entire transaction, including retries, owns the slot.
  tail=result.catch(()=>{});return result;
 };
}
module.exports={createQueue};
