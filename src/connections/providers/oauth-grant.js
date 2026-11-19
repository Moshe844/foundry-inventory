'use strict';

const {ValidationError}=require('../../domain/errors');

// A successful HTTP status does not prove that a rotating grant was returned.
// Validate the complete response before the credential store can replace it.
function read(provider,body,{absolute=false,now=Date.now()}={}){
 const invalid=()=>Object.assign(new ValidationError(provider+' did not return complete, usable authorization. Saved access was preserved; try again later.'),
  {code:'PROVIDER_REFRESH_UNCONFIRMED',status:503,transient:true});
 const token=value=>typeof value==='string'&&value.length>0&&!/\s/.test(value);
 if(!body||body.error||!token(body.access_token)||!token(body.refresh_token))throw invalid();
 const seconds=Number(absolute?body.access_token_expiration:body.expires_in);
 if(!Number.isSafeInteger(seconds)||seconds<=0)throw invalid();
 const expires=absolute?seconds*1000:now+seconds*1000;
 if(!Number.isSafeInteger(expires)||!Number.isFinite(new Date(expires).getTime()))throw invalid();
 if(absolute){
  const refreshSeconds=Number(body.refresh_token_expiration);
  if(!Number.isSafeInteger(refreshSeconds)||refreshSeconds<=seconds||!Number.isFinite(new Date(refreshSeconds*1000).getTime()))throw invalid();
 }
 return {accessToken:body.access_token,refreshToken:body.refresh_token,expiresAt:new Date(expires).toISOString(),
  ...(absolute?{accessTokenExpiration:seconds,refreshTokenExpiration:Number(body.refresh_token_expiration)}:{})};
}

module.exports={read};
