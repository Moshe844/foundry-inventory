'use strict';
// Unverified work is not a request for human input. A wait needs a concrete,
// structured question; pending business approvals remain canonical dependencies.
function classify({report,answer,verified,current='READY',canonicalVerified=true,progress={}}){
 return require('../../src/assistant/agent-conversation').classify({report,answer,verified,current,canonicalVerified,progress});
}
function failed(result){return Boolean(result&&(result.error||result.failure||['BLOCKED','INFRASTRUCTURE_FAILURE'].includes(result.status)));}
module.exports={classify,failed};
