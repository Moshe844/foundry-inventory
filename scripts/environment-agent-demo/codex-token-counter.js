'use strict';
// Admission uses a local upper bound, not a second provider request. UTF-8
// bytes bound text tokens; protocol, bounded PNGs and opaque reasoning receive
// separate allowances in wire-policy. Actual provider receipts still settle
// the reservation, and an uncertain response retains its full hold.
const wire=require('./wire-policy');
function createTokenCounter(){
 return async body=>{
  const normalized=wire.normalize('openai',{...body,model:wire.MODELS.openai},{nativeTokenPreflight:true});
  return {object:'response.input_tokens',input_tokens:normalized.conservativeInputTokens,basis:'local_conservative_bound'};
 };
}
module.exports={createTokenCounter,policy:Object.freeze({networkRequests:0,basis:'utf8_bytes_plus_protocol_images_and_reasoning'})};
