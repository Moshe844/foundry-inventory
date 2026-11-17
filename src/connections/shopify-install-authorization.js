'use strict';
const context=require('../commercial/context');
const permit=Symbol('validated Shopify installation token exchange');
// Before an owner signs into StockChief there is no customer inventory to
// charge. Permit exactly one public-app code exchange, after the durable
// browser/state/HMAC checks. This never permits an Admin API or business call.
function run(database,row,operation){
 const grant={shop:row.shop,clientId:row.client_id,remaining:1};
 return context.run({database,scope:null,requestId:row.id,[permit]:grant},operation);
}
function admit(current,url,init){
 const grant=current?.[permit];if(!grant)return false;
 const address=new URL(url),form=new URLSearchParams(typeof init.body==='string'?init.body:'');
 if(grant.remaining!==1||address.protocol!=='https:'||address.hostname!==grant.shop||address.port||address.username||address.password||
   address.pathname!=='/admin/oauth/access_token'||address.search||String(init.method).toUpperCase()!=='POST'||
   form.get('client_id')!==grant.clientId||form.get('client_id')!==process.env.SHOPIFY_PUBLIC_CLIENT_ID||
   form.get('client_secret')!==process.env.SHOPIFY_PUBLIC_CLIENT_SECRET||!form.get('code')||form.get('expiring')!=='1'||form.has('grant_type'))return false;
 grant.remaining=0;return true;
}
module.exports={run,admit};
