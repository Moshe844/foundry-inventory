'use strict';
// Host identity only. A provider/model-supplied property cannot reduce a
// reservation. Registered transports must disable both SDK and outer retries
// whenever the commercial wrapper supplies commercial:true.
const single=new WeakSet();
function registerSingle(provider){single.add(provider);return provider;}
function executions(provider){return single.has(provider)?1:3;}
module.exports={registerSingle,executions};
