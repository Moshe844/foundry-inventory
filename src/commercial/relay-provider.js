'use strict';
// Host-only identity, never a model-supplied flag. Registered providers already
// reserve and settle each HTTP request through the canonical native cost relay.
const providers=new WeakSet();
function register(provider){providers.add(provider);return provider;}
function ownsAccounting(provider){return providers.has(provider);}
module.exports={register,ownsAccounting};
