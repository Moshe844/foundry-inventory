'use strict';
const wire=require('./codex-wire');
// Canonical engines may need structured interpretation or effect-fit checks.
// They use the SAME native preflight, funded goal, period ledger and request
// counter as the SDK. No credentials, direct provider transport or retry here.
function preferredFits(request,preferred,policy){
 if(!preferred)return false;
 // Only processing speed may differ. A faster check must retain the chosen
 // verification model and reasoning strength. Large packets use the existing
 // transport; the relay still counts exact tokens and reserves every dollar.
 if(preferred.policy.MODEL!==policy.MODEL||preferred.policy.EFFORT!==policy.EFFORT)throw Error('HELPER_VERIFICATION_STRENGTH_MISMATCH');
 const bytes=Buffer.byteLength(String(request.system||''))+Buffer.byteLength(String(request.prompt||''))+
  Buffer.byteLength(JSON.stringify(request.schema||{}))+8192;
 const output=Math.min(request.maxOutputTokens||3000,3000);
 return Math.ceil(bytes*preferred.policy.PRICES.input+output*preferred.policy.PRICES.output)<=preferred.policy.REQUEST_CEILING_MICRO_USD;
}
function create({transport,policy=wire,preferred=null}){
 return require('../../src/commercial/relay-provider').register({name:'openai',model:policy.MODEL,
  async complete(request){
   const selected=preferredFits(request,preferred,policy)?preferred:{transport,policy},chosen=selected.policy;
   const schema=require('../../src/foundry/schema-tools').toWireSchema(request.schema);
   const response=await fetch(selected.transport.openaiBaseURL+'/responses',{method:'POST',
    headers:{authorization:'Bearer '+selected.transport.token,'content-type':'application/json'},
    body:JSON.stringify({model:chosen.MODEL,reasoning:{effort:chosen.EFFORT},store:false,stream:false,
     max_output_tokens:Math.min(request.maxOutputTokens||3000,3000),
     instructions:request.system,input:[{role:'user',content:request.prompt}],
     text:{format:{type:'json_schema',name:request.schemaName||'canonical_result',strict:true,schema}}})});
   if(!response.ok)throw Object.assign(new Error('The governed model request was stopped before a rule could be prepared.'),
    {code:selected.transport.lastBlock()?.code||'GOVERNED_HELPER_STOPPED'});
   const body=await response.json();
   const text=(body.output||[]).filter(item=>item.type==='message').flatMap(item=>item.content||[])
    .filter(item=>item.type==='output_text').map(item=>item.text).join('');
   if(body.status!=='completed'||!text)throw Object.assign(new Error('The governed model returned no complete structured result.'),{code:'HELPER_RESULT_INCOMPLETE'});
   let data;try{data=JSON.parse(text);}catch{throw Object.assign(new Error('The governed model returned invalid structured output.'),{code:'HELPER_RESULT_INVALID'});}
   return {data}; // The relay already persisted the exact provider usage.
  }
 });
}
module.exports={create,preferredFits};
