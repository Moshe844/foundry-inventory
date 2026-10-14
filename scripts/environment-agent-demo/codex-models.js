'use strict';
// Host-approved profiles. Models may request a stronger reasoning tier; only
// the host policy selects a profile, and every request is counted and funded.
const source='https://developers.openai.com/api/docs/pricing';
const nativePolicy=Object.freeze({maxInputTokens:180000,maxOutputTokens:3000,requestCeilingMicroUsd:300000,compactionHeadroom:.7});
function compactionTokenLimit(profile){return Math.floor(nativePolicy.compactionHeadroom*Math.min(nativePolicy.maxInputTokens,
 Math.floor((nativePolicy.requestCeilingMicroUsd-nativePolicy.maxOutputTokens*profile.prices.output)/profile.prices.input)));}
const profiles=Object.freeze({
 'luna-low-fast':Object.freeze({id:'luna-low-fast',model:'gpt-6-luna',effort:'low',serviceTier:'fast',providerVersion:'responses-fast-2026-10-13',verificationProfile:'sol-low-fast',
  prices:Object.freeze({input:.25,output:1}),
  rates:Object.freeze({model_input:.2,model_output:1,cache_write_5m:.25,cache_write_1h:.25,cache_read:.02})}),
 'sol-low':Object.freeze({id:'sol-low',model:'gpt-6.1-sol',effort:'low',
  prices:Object.freeze({input:2.5,output:10}),
  rates:Object.freeze({model_input:2,model_output:10,cache_write_5m:2.5,cache_write_1h:2.5,cache_read:.1})}),
 'sol-medium':Object.freeze({id:'sol-medium',model:'gpt-6.1-sol',effort:'medium',
  prices:Object.freeze({input:2.5,output:10}),
  rates:Object.freeze({model_input:2,model_output:10,cache_write_5m:2.5,cache_write_1h:2.5,cache_read:.1})}),
 'sol-high':Object.freeze({id:'sol-high',model:'gpt-6.1-sol',effort:'high',
  prices:Object.freeze({input:2.5,output:10}),
  rates:Object.freeze({model_input:2,model_output:10,cache_write_5m:2.5,cache_write_1h:2.5,cache_read:.1})}),
 'sol-low-fast':Object.freeze({id:'sol-low-fast',model:'gpt-6.1-sol',effort:'low',serviceTier:'fast',providerVersion:'responses-fast-2026-10-13',
  prices:Object.freeze({input:5,output:20}),
  rates:Object.freeze({model_input:4,model_output:20,cache_write_5m:5,cache_write_1h:5,cache_read:.2})}),
 'astra-high':Object.freeze({id:'astra-high',model:'gpt-6-astra',effort:'high',
  prices:Object.freeze({input:12.5,output:50}),
  rates:Object.freeze({model_input:10,model_output:50,cache_write_5m:12.5,cache_write_1h:12.5,cache_read:1})}),
 'astra-max':Object.freeze({id:'astra-max',model:'gpt-6-astra',effort:'max',
  prices:Object.freeze({input:12.5,output:50}),
  rates:Object.freeze({model_input:10,model_output:50,cache_write_5m:12.5,cache_write_1h:12.5,cache_read:1})})
});
function getProfile(id){if(!Object.hasOwn(profiles,id))throw Error('UNAPPROVED_CODEX_PROFILE');return profiles[id];}
module.exports={profiles,getProfile,source,nativePolicy,compactionTokenLimit};
