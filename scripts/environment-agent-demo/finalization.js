'use strict';
// Static host control. No retrieved content is promoted to instruction authority.
const INSTRUCTION='Conclude this run now without tools. Answer the ORIGINAL request from the consolidated observations and canonical receipts already available. Distinguish recorded facts, verified effects, pending approvals and unresolved questions. Cite evidence IDs and explain any missing coverage. Do not claim a prepared action was executed or claim the whole goal complete without evidence. Do not propose another investigation in place of the answer.';
function request(provider,input){
 const body=structuredClone(input);
 if(provider==='openai'){
  body.tool_choice='none';body.instructions=[body.instructions||'',INSTRUCTION].join('\n');
 }else{
  body.tool_choice={type:'none'};
  const system=typeof body.system==='string'?[{type:'text',text:body.system}]:body.system||[];
  body.system=[...system,{type:'text',text:INSTRUCTION}];
 }
 return body;
}
// Inspect visible output metadata only. Never summarize or expose private reasoning.
class ResponseState{
 constructor(provider){this.provider=provider;this.visible=false;this.tool=false;this.terminal=false;this.reason=null;}
 block(block){
  if(['text','output_text','refusal'].includes(block?.type)&&String(block.text||block.refusal||'').trim())this.visible=true;
  if(['tool_use','function_call','custom_tool_call'].includes(block?.type))this.tool=true;
 }
 observe(event){
  if(this.provider==='openai'){
   if(event.type==='response.output_text.delta'&&event.delta?.trim())this.visible=true;
   if(event.type==='response.refusal.delta'&&event.delta?.trim())this.visible=true;
   this.block(event.item);
   const response=event.response||event;
   if(response.object==='response'||['response.completed','response.incomplete'].includes(event.type)){
    for(const item of response.output||[]){this.block(item);for(const b of item.content||[])this.block(b);}
    if(['completed','incomplete','failed'].includes(response.status)){
     this.terminal=true;this.reason=response.incomplete_details?.reason||response.status;
    }
   }
  }else{
   this.block(event.content_block);
   if(event.type==='content_block_delta'&&event.delta?.type==='text_delta'&&event.delta.text?.trim())this.visible=true;
   if(event.type==='message_delta'&&event.delta?.stop_reason)this.reason=event.delta.stop_reason;
   if(event.type==='message_stop')this.terminal=true;
   if(event.type==='message'){
    for(const block of event.content||[])this.block(block);
    if(event.stop_reason){this.reason=event.stop_reason;this.terminal=true;}
   }
  }
 }
 result(){return {terminal:this.terminal,visible:this.visible,tool:this.tool,stopReason:this.reason,
  empty:this.terminal&&!this.visible&&!this.tool};}
}
const EMPTY_MESSAGE='The provider ended without a visible final answer. Its usage was recorded. No automatic paid continuation is allowed; StockChief will verify existing evidence and report the result or the remaining gap.';
module.exports={request,INSTRUCTION,ResponseState,EMPTY_MESSAGE};
