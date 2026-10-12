'use strict';
// Validate the supported native wire subset BEFORE reserving or sending a call.
// This is a local contract check, not a claim that a provider accepted a request.
// https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
const fail=reason=>{throw Object.assign(new Error(`PROVIDER_PROTOCOL_INVALID:${reason}`),{code:'PROVIDER_PROTOCOL_INVALID'});};
function validate(provider,body){
 const messages=provider==='anthropic'?body.messages:body.input;
 if(typeof messages==='string'&&provider==='openai')return true;
 if(!Array.isArray(messages)||!messages.length)fail('empty conversation');
 const seen=new Set(),pending=new Set();
 for(let i=0;i<messages.length;i++){
  const m=messages[i],blocks=Array.isArray(m.content)?m.content:[];
  if(provider==='anthropic'){
   if(!['user','assistant','system'].includes(m.role))fail('invalid message role');
   if(typeof m.content!=='string'&&!Array.isArray(m.content))fail('invalid message content');
   if(m.role==='system'){
    let end=i;while(messages[end+1]?.role==='system')end++;
    const content=messages.slice(i,end+1).some(s=>typeof s.content==='string'?s.content.length:s.content?.length);
    if(content&&(messages[i-1]?.role!=='user'||end<messages.length-1&&messages[end+1].role!=='assistant'))fail('system section ordering');
    if(pending.size)fail('system interrupts tool round');
    // These beta features are not admitted by this relay's header policy.
    if(messages.slice(i,end+1).some(s=>s.clear_at||s.output_config))fail('unapproved system-message beta');
    i=end;continue;
   }
   const uses=blocks.filter(b=>b.type==='tool_use'),results=blocks.filter(b=>b.type==='tool_result');
   if(pending.size&&(!results.length||m.role!=='user'))fail('missing adjacent tool results');
   if(uses.length&&m.role!=='assistant'||results.length&&m.role!=='user')fail('tool role');
   if(results.length&&blocks.slice(0,results.length).some(b=>b.type!=='tool_result'))fail('tool results must precede text');
   for(const b of results){if(!pending.delete(b.tool_use_id))fail('orphan or duplicate tool result');}
   if(pending.size)fail('incomplete tool results');
   for(const b of uses){if(!b.id||seen.has(b.id)||typeof b.name!=='string'||!b.input||typeof b.input!=='object'||Array.isArray(b.input))fail('invalid tool use');seen.add(b.id);pending.add(b.id);}
  }else{
   if(m.role&&!['user','assistant','system','developer'].includes(m.role))fail('invalid message role');
   if(m.type==='function_call'||m.type==='custom_tool_call'){
    if(!m.call_id||seen.has(m.call_id)||typeof m.name!=='string')fail('invalid function call');
    if(m.type==='function_call'){try{JSON.parse(m.arguments);}catch{fail('function arguments are not JSON');}}
    else if(typeof m.input!=='string')fail('custom tool input is not text');
    seen.add(m.call_id);pending.add(m.call_id);
   }else if(m.type==='function_call_output'||m.type==='custom_tool_call_output'){if(!pending.delete(m.call_id))fail('orphan or duplicate function result');}
   else if(m.role&&pending.size)fail('message interrupts function round');
  }
 }
 if(provider==='anthropic'&&messages[0].role!=='user')fail('first message must be user');
 if(pending.size)fail('unfinished tool round');
 return true;
}
module.exports={validate};
