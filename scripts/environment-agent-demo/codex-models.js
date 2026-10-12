'use strict';
// Host-selected evaluation profiles only. Never selected by a browser page,
// model tool argument or fallback. This does not change customer-facing Ask.
const source='https://developers.openai.com/api/docs/pricing';
const nativePolicy=Object.freeze({maxInputTokens:180000,maxOutputTokens:3000,requestCeilingMicroUsd:300000,compactionHeadroom:.7});
function compactionTokenLimit(profile){return Math.floor(nativePolicy.compactionHeadroom*Math.min(nativePolicy.maxInputTokens,
 Math.floor((nativePolicy.requestCeilingMicroUsd-nativePolicy.maxOutputTokens*profile.prices.output)/profile.prices.input)));}
const profiles=Object.freeze({
 'sol-high':Object.freeze({id:'sol-high',model:'gpt-6.1-sol',effort:'high',
  prices:Object.freeze({input:2.5,output:10}),
  rates:Object.freeze({model_input:2,model_output:10,cache_write_5m:2.5,cache_write_1h:2.5,cache_read:.1})}),
 'astra-max':Object.freeze({id:'astra-max',model:'gpt-6-astra',effort:'max',
  prices:Object.freeze({input:12.5,output:50}),
  rates:Object.freeze({model_input:10,model_output:50,cache_write_5m:12.5,cache_write_1h:12.5,cache_read:1})})
});
function getProfile(id){if(!Object.hasOwn(profiles,id))throw Error('UNAPPROVED_CODEX_PROFILE');return profiles[id];}
module.exports={profiles,getProfile,source,nativePolicy,compactionTokenLimit};
