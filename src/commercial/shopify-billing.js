'use strict';

const {ValidationError}=require('../domain/errors');
const {providerFetch}=require('../lib/provider-http');
const API_VERSION='2026-07';
const PRICES=Object.freeze({starter:19900,growth:49900,pro:99900});
const IDENTITY_QUERY=`query StockChiefBillingIdentity { shop { id myshopifyDomain plan { partnerDevelopment } } currentAppInstallation { app { id handle apiKey } } }`;
const SUBSCRIPTION_QUERY=`query StockChiefManagedSubscription($appId:ID!,$shopId:ID!){activeSubscription(appId:$appId,shopId:$shopId){shop{id myshopifyDomain} billingPeriod cancelAtEndOfCycle trialEndsAt currentBillingCycle{startTime endTime} items{handle price{__typename active currency ... on FlatRatePrice{amount}}} pendingUpdate{billingPeriod items{handle}}}}`;
const HISTORY_QUERY=`query StockChiefBillingHistory($filter:EventFilterInput,$cursor:String){events(filter:$filter,orderBy:OCCURRED_AT_ASC,first:100,after:$cursor){pageInfo{hasNextPage endCursor} edges{node{id occurredAt eventType shop{id myshopifyDomain} subject{... on AppReference{id}} ... on SubscriptionStatus{state plan{handle billingPeriod}} ... on Charge{chargeId planHandle amount{amount currencyCode}} ... on Earning{earningType earningChargeId:chargeId grossAmount{amount currencyCode}}}}}}`;
const CANCEL_MUTATION=`mutation StockChiefCancelManagedSubscription($appId:ID!,$shopId:ID!,$deferCancellation:Boolean!){appSubscriptionCancel(appId:$appId,shopId:$shopId,prorate:false,skipFinalUsageCharge:false,deferCancellation:$deferCancellation){appSubscription{shop{id myshopifyDomain} app{id} cancelledAt cancelAtEndOfCycle} userErrors{field message}}}`;

function configuration(){
 const partnerId=String(process.env.SHOPIFY_PARTNER_ID||''),appId=String(process.env.SHOPIFY_PUBLIC_APP_ID||'').replace(/^gid:\/\/shopify\/App\//,'');
 const token=process.env.SHOPIFY_PARTNER_ACCESS_TOKEN;
 if(!/^\d{1,30}$/.test(partnerId)||!/^\d{1,30}$/.test(appId)||!token||!process.env.SHOPIFY_PUBLIC_CLIENT_ID)
   throw new ValidationError('Shopify subscription verification is not configured. Your existing billing has been preserved.');
 return {partnerId,appId:'gid://shopify/App/'+appId,clientId:process.env.SHOPIFY_PUBLIC_CLIENT_ID,token};
}
function configured(){try{configuration();return true;}catch{return false;}}
function requestEvidence(url,method){
 const u=new URL(url);
 if(String(method||'GET').toUpperCase()!=='POST'||u.protocol!=='https:'||u.port||u.username||u.password||u.search||u.hash)return null;
 const admin=/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(u.hostname)&&['/admin/api/'+API_VERSION+'/graphql.json','/admin/oauth/access_token'].includes(u.pathname);
 const partner=/^\d{1,30}$/.test(String(process.env.SHOPIFY_PARTNER_ID||''))&&u.hostname==='partners.shopify.com'&&u.pathname==='/'+process.env.SHOPIFY_PARTNER_ID+'/api/'+API_VERSION+'/graphql.json';
 if(!admin&&!partner)return null;
 return {provider:'shopify_billing',basis:'NO_INCREMENTAL_SHOPIFY_BILLING_API_REQUEST_FEE',
  source:'https://shopify.dev/docs/api/usage/limits; https://shopify.dev/docs/apps/launch/distribution/revenue-share',
  resourcePattern:partner?'Partner API '+API_VERSION:u.pathname==='/admin/oauth/access_token'?'Shopify OAuth token exchange':'Admin GraphQL '+API_VERSION};
}
function money(value){
 const m=String(value).match(/^(\d{1,12})(?:\.(\d{1,2}))?$/);
 if(!m)throw new ValidationError('Shopify returned an invalid subscription price.');
 const result=BigInt(m[1])*100n+BigInt((m[2]||'').padEnd(2,'0')||'0');
 if(result>BigInt(Number.MAX_SAFE_INTEGER))throw new ValidationError('Shopify returned an invalid subscription price.');return Number(result);
}
function shopDomain(value){const shop=String(value||'');if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop))throw new ValidationError('Shopify did not identify a valid store.');return shop;}
function identity(data,expectedShop){
 const c=configuration(),shop=data?.shop,app=data?.currentAppInstallation?.app;
 const checks={domainMatches:shop?.myshopifyDomain===shopDomain(expectedShop),validShopId:/^gid:\/\/shopify\/Shop\/\d+$/.test(shop?.id||''),
   appMatches:app?.id===c.appId,clientMatches:app?.apiKey===c.clientId,validHandle:/^[-a-z0-9]+$/.test(app?.handle||'')};
 if(Object.values(checks).some(value=>!value))
   throw Object.assign(new ValidationError('Shopify billing belongs to another app or store. No subscription was changed.'),{shopifyInstallationReason:'IDENTITY_MISMATCH',shopifyIdentityChecks:checks});
 return {shopId:shop.id,shop:shop.myshopifyDomain,appId:c.appId,appHandle:app.handle,developmentStore:shop.plan?.partnerDevelopment===true};
}
function selectionUrl(value){return 'https://admin.shopify.com/store/'+shopDomain(value.shop).slice(0,-'.myshopify.com'.length)+'/charges/'+encodeURIComponent(value.appHandle)+'/pricing_plans';}
function recoveryUrl(shop){const handle=process.env.SHOPIFY_PUBLIC_APP_HANDLE||'stockchief';if(!/^[a-z0-9-]+$/.test(handle))throw new ValidationError('The Shopify application handle needs attention.');return 'https://admin.shopify.com/store/'+shopDomain(shop).slice(0,-'.myshopify.com'.length)+'/apps/'+handle;}
async function readIdentity(credentials,expectedShop){
 if(credentials?.shopifyProfile!=='public'||credentials.shopifyClientId!==configuration().clientId||credentials.shop!==shopDomain(expectedShop))throw new ValidationError('The Shopify billing authorization belongs to another app or store.');
 if(Date.parse(credentials.accessTokenExpiresAt||'')<=Date.now()+60000)throw new ValidationError('Reconnect Shopify before starting a new billing selection.');
 const response=await providerFetch('https://'+shopDomain(expectedShop)+'/admin/api/'+API_VERSION+'/graphql.json',{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':credentials.accessToken},body:JSON.stringify({query:IDENTITY_QUERY})},{provider:'StockChief Billing',retries:0});
 const body=await response.json();if(!response.ok||body.errors?.length)throw Object.assign(new ValidationError('Shopify could not verify this billing installation.'),{shopifyInstallationReason:'IDENTITY_QUERY_REJECTED'});
 return identity(body.data,expectedShop);
}
function contract(value,owner,{now=Date.now()}={}){
 if(!value)return null;
 if(value.shop?.id!==owner.shopId||value.shop?.myshopifyDomain!==owner.shop)throw new ValidationError('Shopify returned a subscription for another store.');
 if(value.billingPeriod!=='EVERY_30_DAYS'||value.items?.length!==1)throw new ValidationError('This Shopify billing interval or usage plan is not supported by StockChief.');
 const item=value.items[0],price=item.price,planId=item.handle;
 if(!Object.hasOwn(PRICES,planId)||price?.__typename!=='FlatRatePrice'||typeof price.active!=='boolean'||price.currency!=='USD')throw new ValidationError('The Shopify plan could not be matched to StockChief.');
 const amountMinor=money(price.amount);
 // Shopify's no-charge development contracts return inactive, zero-valued
 // prices. The store's development status comes from its authenticated Admin
 // identity read. A production store must still have an active paid price.
 if(!price.active&&!(owner.developmentStore&&amountMinor===0))throw new ValidationError('Shopify has not confirmed an active paid price.');
 if(amountMinor!==PRICES[planId]&&!(owner.developmentStore&&amountMinor===0))throw new ValidationError('The Shopify price differs from the published StockChief plan.');
 const start=Date.parse(value.currentBillingCycle?.startTime),end=Date.parse(value.currentBillingCycle?.endTime),trialEnd=Date.parse(value.trialEndsAt);
 const trial=Number.isFinite(trialEnd)&&trialEnd>now;
 if(!trial&&(!Number.isFinite(start)||!Number.isFinite(end)||start>now+300000||end<=now||end<=start||end-start>32*86400000))throw new ValidationError('Shopify has not confirmed a current subscription period.');
 return {planId,amountMinor,status:trial?'TRIALING':'ACTIVE',periodStart:new Date(trial?now:start).toISOString(),periodEnd:new Date(trial?trialEnd:end).toISOString(),trialEndsAt:trial?new Date(trialEnd).toISOString():null,cancelAtPeriodEnd:value.cancelAtEndOfCycle===true,developmentStore:owner.developmentStore,providerState:value};
}
async function call(query,variables){
 const c=configuration();
 const response=await providerFetch('https://partners.shopify.com/'+c.partnerId+'/api/'+API_VERSION+'/graphql.json',{
   method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':c.token},body:JSON.stringify({query,variables})
 },{provider:'StockChief Billing',retries:0});
 const body=await response.json();
 if(!response.ok||body.errors?.length||!body.data)throw new ValidationError('Shopify subscription verification could not be completed. Existing billing is preserved.');
 return body.data;
}
async function active(owner){return contract((await call(SUBSCRIPTION_QUERY,{appId:owner.appId,shopId:owner.shopId})).activeSubscription,owner);}
async function history(owner,{since,until=new Date().toISOString()}={}){
 const events=[];let cursor=null;
 const min=since||new Date(Date.now()-364*86400000).toISOString();
 for(let page=0;page<30;page++){
  const data=await call(HISTORY_QUERY,{filter:{subjectId:owner.appId,subjectType:'APP',shopId:owner.shopId,occurredAtMin:min,occurredAtMax:until},cursor});
  const result=data.events;if(!result?.pageInfo||!Array.isArray(result.edges))throw new ValidationError('Shopify billing history is incomplete.');
  for(const {node:e} of result.edges){if(e.shop?.id!==owner.shopId||e.shop?.myshopifyDomain!==owner.shop||e.subject?.id!==owner.appId)throw new ValidationError('Shopify billing history belongs to another store or app.');events.push(e);}
  if(!result.pageInfo.hasNextPage)return events;
  if(!result.pageInfo.endCursor||result.pageInfo.endCursor===cursor)break;cursor=result.pageInfo.endCursor;
 }
 throw new ValidationError('Shopify billing history is too large to verify safely. Support must review this subscription.');
}
async function cancel(owner,{defer=true}={}){
 const data=await call(CANCEL_MUTATION,{appId:owner.appId,shopId:owner.shopId,deferCancellation:defer});
 const r=data.appSubscriptionCancel,s=r?.appSubscription;
 if(r?.userErrors?.length||s?.app?.id!==owner.appId||s?.shop?.id!==owner.shopId||s?.shop?.myshopifyDomain!==owner.shop||defer&&s.cancelAtEndOfCycle!==true||!defer&&!s.cancelledAt)
   throw new ValidationError('Shopify did not confirm this subscription cancellation. Support can check the saved request.');
 return s;
}
module.exports={API_VERSION,PRICES,IDENTITY_QUERY,SUBSCRIPTION_QUERY,HISTORY_QUERY,CANCEL_MUTATION,configuration,configured,requestEvidence,money,identity,readIdentity,contract,selectionUrl,recoveryUrl,active,history,cancel};
