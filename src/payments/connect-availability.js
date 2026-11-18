'use strict';
function qualified(options={},ctx={}){
 if(process.env.NODE_ENV==='test'&&options.testMode===true&&options.paymentConnectOptions?.testQualifiedConnection===true)return true;
 if(require('./stripe-live-qualification').allowed(ctx.workspaceId))return true;
 return process.env.STOCKCHIEF_RUNTIME_ENV==='staging'&&process.env.STOCKCHIEF_STRIPE_TEST_CONNECT==='1'
  &&/^sk_test_/.test(process.env.STRIPE_SECRET_KEY||'')&&/^pk_test_/.test(process.env.STRIPE_PUBLISHABLE_KEY||'')
  &&/^ca_/.test(process.env.STRIPE_CONNECT_CLIENT_ID||'');
}
module.exports={qualified};
