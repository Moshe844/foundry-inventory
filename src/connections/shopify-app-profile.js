'use strict';
const {AuthenticationError,ValidationError}=require('../domain/errors');
const config=require('../config');
function initialProfile(){return process.env.SHOPIFY_PUBLIC_CLIENT_ID&&process.env.SHOPIFY_PUBLIC_CLIENT_SECRET?'public':'legacy';}
function available(){return initialProfile()==='public'||config.connections.shopify.configured;}

// The profile is retained with the grant. Never try both application secrets:
// a valid signature for one Shopify app must not authorize the other app.
function profile(value='legacy'){
 if(!['legacy','public'].includes(value))throw new AuthenticationError('This Shopify application is not recognized.');
 const clientId=value==='public'?process.env.SHOPIFY_PUBLIC_CLIENT_ID:config.connections.shopify.clientId;
 const clientSecret=value==='public'?process.env.SHOPIFY_PUBLIC_CLIENT_SECRET:config.connections.shopify.clientSecret;
 if(!clientId||!clientSecret)throw Object.assign(new ValidationError('StockChief’s Shopify application configuration needs attention. Your existing connection has been preserved.'),{code:'PROVIDER_CONFIGURATION_REQUIRED'});
 return {name:value,clientId,clientSecret};
}
function forGrant(credentials={},connection={}){
 const value=credentials.shopifyProfile||connection.config?.shopifyProfile||'legacy',app=profile(value);
 const bound=credentials.shopifyClientId||connection.config?.shopifyClientId;
 if(bound&&bound!==app.clientId)throw Object.assign(new AuthenticationError('This Shopify authorization belongs to a different application. Contact StockChief support.'),{code:'PROVIDER_CONFIGURATION_REQUIRED'});
 return app;
}
module.exports={profile,forGrant,initialProfile,available};
