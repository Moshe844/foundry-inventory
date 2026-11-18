'use strict';
// Actual Shopify managed-pricing contract cancellation against the one
// approved development store, with all StockChief writes in disposable PG.
// A no-charge test can prove cancellation; it cannot prove a cash refund.
const assert=require('node:assert/strict'),fs=require('node:fs');
async function main(){
 assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.STOCKCHIEF_CERTIFY_SHOPIFY_MANAGED_TEST,'1','Explicit development certification opt-in is required');
 assert.notEqual(process.env.STOCKCHIEF_RUNTIME_ENV,'production');
 for(const key of ['FOUNDRY_DATABASE_URL','DATABASE_URL','STRIPE_SECRET_KEY','STOCKCHIEF_BILLING_STRIPE_SECRET_KEY'])assert(!process.env[key],'Production database and Stripe credentials are forbidden');
 const billing=require('../src/commercial/shopify-billing'),shop='foundry-test-sotre.myshopify.com';
 assert.equal(billing.configuration().appId,'gid://shopify/App/448446889985');assert(process.env.SHOPIFY_CLIENT_ID&&process.env.SHOPIFY_CLIENT_SECRET,'The separate existing test-app identity grant is required');
 const oauth=await fetch('https://'+shop+'/admin/oauth/access_token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.SHOPIFY_CLIENT_ID,client_secret:process.env.SHOPIFY_CLIENT_SECRET,grant_type:'client_credentials'}),signal:AbortSignal.timeout(20000)});
 const grant=await oauth.json();assert(oauth.ok&&grant.access_token,'The separate test-app grant could not be verified');
 const identityResponse=await fetch('https://'+shop+'/admin/api/2026-07/graphql.json',{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':grant.access_token},body:JSON.stringify({query:'query StockChiefTestStoreIdentity { shop { id myshopifyDomain plan { partnerDevelopment } } }'}),signal:AbortSignal.timeout(20000)});
 const identityBody=await identityResponse.json();assert(identityResponse.ok&&!identityBody.errors?.length);const store=identityBody.data?.shop;
 assert.equal(store?.myshopifyDomain,shop);assert.equal(store.id,'gid://shopify/Shop/78881980568');assert.equal(store.plan.partnerDevelopment,true,'A paid production store must never be used');
 const owner={shop,shopId:store.id,appId:billing.configuration().appId,appHandle:'stockchief',developmentStore:true};
 const before=await billing.active(owner);assert(before,'Select a development-store plan before certification');assert.equal(before.amountMinor,0,'No real paid contract may be cancelled by this test');
 const history=await billing.history(owner),selected=new Set(history.filter(e=>['SUBSCRIPTION_CREATED','SUBSCRIPTION_UPDATED'].includes(e.eventType)).map(e=>e.plan?.handle));
 for(const plan of ['starter','growth','pro'])assert(selected.has(plan),'Each plan must have actually been selected in Shopify: '+plan);
 assert(history.filter(e=>e.eventType==='CHARGE_RECURRING').every(e=>billing.money(e.amount.amount)===0),'A paid charge is outside this certification scope');
 const cluster=await require('../tests/helpers/postgres-cluster').startCluster();assert(['localhost','127.0.0.1','::1','[::1]'].includes(new URL(cluster.connectionString).hostname));
 const db=require('../src/db/postgres').openPostgres(cluster.connectionString,{applicationName:'shopify-disposable-certification'});
 try{
  await require('../src/db/migrate-postgres').migratePostgres(db);
  const auth=require('../src/domain/postgres-auth-service'),service=require('../src/commercial/postgres-shopify-billing');
  let account=await auth.createPendingAccount(db,{name:'Development certification',email:'shopify-certification@example.test',password:'ShopifyDevelopmentFixture!42',businessName:'Disposable Shopify certification',planId:before.planId});await db.query('UPDATE accounts SET email_verified_at=now() WHERE id=$1',[account.id]);account=await auth.getAccount(db,account.id);
  await service.reserve(db,account,owner);const activated=await service.apply(db,account.id,owner,before,history);assert(activated.active);
  const q=await service.quote(db,account.id);assert(q.eligible,'The current actual test subscription must be in its verified 14-day window');
  const request=await service.requestRefund(db,account.id);
  const guarded={history:billing.history,active:async o=>{const r=await billing.active(o);if(r)assert.equal(r.amountMinor,0);return r;},cancel:async(o,input)=>{assert.equal(o.shop,shop);assert.equal(o.shopId,store.id);const current=await billing.active(o);assert(current&&current.amountMinor===0&&o.developmentStore);return billing.cancel(o,input);}};
  const result=await service.processGuarantee(db,{payload:{accountId:account.id,requestId:request.id}},{provider:guarded});assert.equal(result.status,'NO_CHARGE');assert.equal(result.refundConfirmed,false);assert.equal(await billing.active(owner),null,'Shopify must confirm that the actual test contract ended');
  const proof={checkedAt:new Date().toISOString(),store:shop,developmentStoreVerified:true,actualPlanSelections:[...selected].filter(p=>Object.hasOwn(billing.PRICES,p)),activePlanBeforeCancellation:before.planId,actualEffectivePriceMinor:before.amountMinor,verified14DayWindow:true,cancellationConfirmed:true,refundState:result.status,cashRefundTested:false,productionDatabaseWrites:0,stripeCalls:0,customerNotifications:0};
  fs.mkdirSync('output',{recursive:true});fs.writeFileSync('output/shopify-managed-development-certification.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
 }finally{await db.close();await cluster.stop();}
}
main().catch(error=>{console.error('SHOPIFY_DEVELOPMENT_CERTIFICATION_FAILED '+String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g,'[private database]'));process.exitCode=1;});
