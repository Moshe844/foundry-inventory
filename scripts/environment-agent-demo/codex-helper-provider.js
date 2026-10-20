'use strict';
const wire=require('./codex-wire');
// Canonical engines may need structured interpretation or effect-fit checks.
// They use the SAME native preflight, funded goal, period ledger and request
// counter as the SDK. No credentials, direct provider transport or retry here.
function create({transport,policy=wire}){
 return require('../../src/commercial/relay-provider').register({name:'openai',model:policy.MODEL,
  async complete(request){
   const schema=require('../../src/foundry/schema-tools').toWireSchema(request.schema);
   const response=await fetch(transport.openaiBaseURL+'/responses',{method:'POST',
    headers:{authorization:'Bearer '+transport.token,'content-type':'application/json'},
    body:JSON.stringify({model:policy.MODEL,reasoning:{effort:policy.EFFORT},store:false,stream:false,
     max_output_tokens:Math.min(request.maxOutputTokens||3000,3000),
     instructions:request.system,input:[{role:'user',content:request.prompt}],
     text:{format:{type:'json_schema',name:request.schemaName||'canonical_result',strict:true,schema}}})});
   if(!response.ok)throw Object.assign(new Error('The governed model request was stopped before a rule could be prepared.'),
    {code:transport.lastBlock()?.code||'GOVERNED_HELPER_STOPPED'});
   const body=await response.json();
   const text=(body.output||[]).filter(item=>item.type==='message').flatMap(item=>item.content||[])
    .filter(item=>item.type==='output_text').map(item=>item.text).join('');
   if(body.status!=='completed'||!text)throw Object.assign(new Error('The governed model returned no complete structured result.'),{code:'HELPER_RESULT_INCOMPLETE'});
   let data;try{data=JSON.parse(text);}catch{throw Object.assign(new Error('The governed model returned invalid structured output.'),{code:'HELPER_RESULT_INVALID'});}
   return {data}; // The relay already persisted the exact provider usage.
  }
 });
}
module.exports={create};
