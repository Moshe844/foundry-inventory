'use strict';

const square={
 basis:'NO_INCREMENTAL_SQUARE_API_REQUEST_FEE',
 source:'https://developer.squareup.com/us/en/online-payment-apis; hosted Square Checkout and seller transaction fees are separate',
};
const graph={
 basis:'MICROSOFT_GRAPH_STANDARD_MAIL_API_INCLUDED_IN_USER_LICENSE',
 source:'https://learn.microsoft.com/en-us/graph/metered-api-overview; https://learn.microsoft.com/en-us/graph/metered-api-list',
};
const entra={
 basis:'MICROSOFT_ENTRA_WORKFORCE_OAUTH_INCLUDED_IN_USER_LICENSE',
 source:'https://www.microsoft.com/en-us/security/business/microsoft-entra-pricing; delegated workforce authentication',
};
const shopify={
 basis:'NO_INCREMENTAL_SHOPIFY_ADMIN_API_REQUEST_FEE',
 source:'https://shopify.dev/docs/api/usage/limits; https://shopify.dev/docs/apps/launch/distribution/revenue-share; merchant subscriptions and app platform/revenue-share charges remain separate',
};

function classify(def, url, method='GET'){
 if(!url)return null;
 const {origin,pathname}=new URL(url);
 const verb=String(method).toUpperCase();
 const target=new URL(url);
 if(def.provider==='shopify'&&origin===`https://${target.hostname}`&&/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(target.hostname)){
  if(def.version==='2026-07'&&verb==='POST'&&pathname==='/admin/api/2026-07/graphql.json')return shopify;
  if(def.version==='unversioned'&&((verb==='POST'&&pathname==='/admin/oauth/access_token')||
    (verb==='GET'&&pathname==='/admin/oauth/access_scopes.json')))return shopify;
 }
 if(def.provider==='square'&&def.version==='2026-08-19'&&origin==='https://connect.squareup.com'){
  if(verb==='GET'&&/^\/v2\/(?:merchants\/me|locations|catalog\/list|orders\/[^/]+|webhooks\/subscriptions(?:\/[^/]+)?)$/.test(pathname))return square;
  if(verb==='POST'&&/^\/(?:oauth2\/token(?:\/status)?|v2\/(?:inventory\/counts\/batch-retrieve|orders\/search|online-checkout\/payment-links|webhooks\/subscriptions))$/.test(pathname))return square;
  if(verb==='PUT'&&/^\/v2\/webhooks\/subscriptions\/[^/]+$/.test(pathname))return square;
 }
 if(def.provider==='microsoft365'&&def.version==='v1.0'&&origin==='https://graph.microsoft.com'){
  if(verb==='GET'&&/^\/v1\.0\/me(?:\/mailFolders\/(?:inbox|archive|junkemail|sentitems)\/messages|\/messages\/[^/]+(?:\/attachments)?)?$/i.test(pathname))return graph;
  if(verb==='POST'&&/^\/v1\.0\/(?:subscriptions|me\/(?:sendMail|messages\/[^/]+\/reply))$/i.test(pathname))return graph;
  if(verb==='PATCH'&&/^\/v1\.0\/subscriptions\/[^/]+$/.test(pathname))return graph;
 }
 if(def.provider==='login.microsoftonline.com'&&def.version==='v2.0'&&origin==='https://login.microsoftonline.com'&&
   verb==='POST'&&/^\/(?:organizations|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/oauth2\/v2\.0\/token$/i.test(pathname))return entra;
 return null;
}

module.exports={classify};
