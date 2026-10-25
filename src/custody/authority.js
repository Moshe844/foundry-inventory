'use strict';
// Domain-only grants cannot be forged by copying request fields or IDs.
const grants=new WeakMap();
function context(ctx,agreementId){const scoped={...ctx};grants.set(scoped,agreementId);return scoped;}
function allows(ctx,agreementId){return !agreementId||grants.get(ctx)===agreementId;}
module.exports={context,allows};
