'use strict';
const paused=new Set(['CERTIFICATION_WINDOW_CLOSED','CERTIFICATION_SPENDING_CEILING','PAID_TESTING_LOCKED','SHARED_SPENDING_CEILING']);
// Also a refused credit or plan admission: commercial gates raise entitlement
// errors, and the wrapped provider marks its own pre-call refusals as not started.
function admissionPause(error){return error?.modelStarted!==true&&(paused.has(error?.code)||paused.has(error?.message)||error?.code==='entitlement_required'||
  ['rate_limited','validation_error'].includes(error?.code)&&error?.modelStarted===false);}
function message(){return 'The AI column reader is paused or unavailable right now. Your file can still be imported: review the worksheet and map its columns manually below, then recalculate the preview.';}
function fromError(error){return {code:error.limitKind||error.code||(paused.has(error.message)?error.message:'interpretation_unavailable'),message:message(),modelCalled:false};}
module.exports={admissionPause,message,fromError};
