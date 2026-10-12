'use strict';
// Offline-only wire fixture for the actual Codex programmatic tool runtime.
module.exports=function(body,turn,program){
 const item={id:'ct_'+turn,type:'custom_tool_call',namespace:'functions',name:'exec',call_id:'offline_'+turn,input:program,status:'completed'};
 const response={id:'resp_'+turn,object:'response',status:'completed',model:body.model,output:[item],usage:{input_tokens:200,output_tokens:40,total_tokens:240}};
 const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},
  {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',input:''}},
  {type:'response.custom_tool_call_input.delta',item_id:item.id,output_index:0,delta:program},
  {type:'response.custom_tool_call_input.done',item_id:item.id,output_index:0,input:program},
  {type:'response.output_item.done',item,output_index:0},{type:'response.completed',response}];
 return new Response(events.map((e,i)=>`event: ${e.type}\ndata: ${JSON.stringify({...e,sequence_number:i})}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
};
module.exports.final=async(body,turn,answer)=>{
 const old=require('./environment-agent-response')(body,turn,null,null,answer);
 const raw=await old.text();
 return new Response(raw.replaceAll('"output_tokens":30','"output_tokens":30,"total_tokens":230'),{headers:{'content-type':'text/event-stream'}});
};
