'use strict';
// Acceptance is an observed maximum, not a percentile that can hide slow pages.
function verdict(routes){
 const target=1500,paths=[...new Set(['/','/money','/reports',...Object.keys(routes).filter(path=>!path.startsWith('/api/'))])];
 const failed=paths.filter(path=>!Number.isFinite(routes[path]?.maxMs)||routes[path].maxMs<0||routes[path].maxMs>=target||!(routes[path].requests>0));
 return {pageLatencyStatistic:'maximum',pageLatencyTargetMs:target,pageLatencyPassed:failed.length===0,pageLatencyFailures:failed};
}
module.exports={verdict};
