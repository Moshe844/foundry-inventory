'use strict';

// Every runtime must stop accepting work before we wait for any slow drain.
// Otherwise a retiring worker can claim another job while telemetry or the
// scheduler is still finishing, then disappear with that job in progress.
async function stopRuntimes(runtimes){
 const pending=runtimes.filter(Boolean).map(runtime=>{
  try{return Promise.resolve(runtime.stop());}catch(error){return Promise.reject(error);}
 });
 const outcomes=await Promise.allSettled(pending),errors=outcomes.filter(r=>r.status==='rejected').map(r=>r.reason);
 if(errors.length)throw new AggregateError(errors,'One or more runtimes could not finish shutdown.');
}
module.exports={stopRuntimes};
