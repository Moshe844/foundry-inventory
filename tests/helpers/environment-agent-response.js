'use strict';
// Explicit synthetic provider transport for offline integration tests only.
module.exports=function response(body,turn,name,input,answer){
 const item=name?{id:'fc_'+turn,type:'function_call',call_id:'offline_'+turn,name,arguments:JSON.stringify(input),status:'completed'}:
  {id:'msg_'+turn,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:answer,annotations:[]}]};
 const result={id:'resp_'+turn,object:'response',created_at:1,status:'completed',model:body.model,output:[item],usage:{input_tokens:200,output_tokens:30}};
 const events=[{type:'response.created',response:{...result,status:'in_progress',output:[]}},
  {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',...(name?{arguments:''}:{content:[]})}}];
 if(name)events.push({type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta:item.arguments},
  {type:'response.function_call_arguments.done',output_index:0,item_id:item.id,arguments:item.arguments});
 else events.push({type:'response.content_part.added',output_index:0,content_index:0,item_id:item.id,part:{type:'output_text',text:'',annotations:[]}},
  {type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:answer},
  {type:'response.output_text.done',output_index:0,content_index:0,item_id:item.id,text:answer},
  {type:'response.content_part.done',output_index:0,content_index:0,item_id:item.id,part:item.content[0]});
 events.push({type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:result});
 return new Response(events.map((e,i)=>`event: ${e.type}\ndata: ${JSON.stringify({...e,sequence_number:i})}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
};
