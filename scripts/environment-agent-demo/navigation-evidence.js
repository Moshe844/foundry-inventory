'use strict';
// Host-side scoring only. Never supplied to the agent or used to choose actions.
function score(trace,requirement=null){
 let previous=null,pending=null;const transitions=[],interactions=[],screens=[];
 const pathname=screen=>{try{return new URL(screen.url).pathname;}catch{return null;}};
 for(const event of trace){
  if(event.kind==='agent_tool_started')pending=event.name==='environment_browser'&&event.sdkToolCallId?event:null;
  if(event.kind==='browser_observation'){
   const screen=event.screen,route=pathname(screen),valid=route&&screen.httpStatus>=200&&screen.httpStatus<400;
   const input=pending?.input,control=previous?.controls?.find(c=>c.ref===input?.ref);
   if(valid&&pending&&control&&!control.disabled){
    if(['click','press'].includes(input.action)&&pathname(previous)!==route)
     transitions.push({callId:pending.sdkToolCallId,from:pathname(previous),to:route,label:control.label,at:event.at});
    if(['fill','select'].includes(input.action)&&['input','textarea','select'].includes(control.tag)){
     const current=screen.controls?.find(c=>c.name&&c.name===control.name&&c.tag===control.tag);
     if(current&&String(current.value)===String(input.value)&&String(control.value)!==String(current.value))
      interactions.push({callId:pending.sdkToolCallId,route,name:control.name,action:input.action,at:event.at});
    }
   }
   if(valid&&pending)screens.push({route,screen,callId:pending.sdkToolCallId,at:event.at});
   previous=valid?screen:null;
  }
  if(['agent_tool_failed','agent_tool_completed'].includes(event.kind))pending=null;
 }
 if(!requirement)return {required:false,passed:true,transitions,interactions};
 const target=new RegExp(requirement.route),visited=screens.filter(s=>target.test(s.route));
 const arrived=transitions.some(t=>target.test(t.to));
 const formVisible=visited.some(s=>s.screen.controls?.some(c=>['input','textarea','select'].includes(c.tag)&&c.type!=='hidden'&&
  c.name&&!['q','search','_csrf'].includes(c.name)));
 const relevant=visited.some(s=>(requirement.text||[]).every(text=>s.screen.text?.toLowerCase().includes(text.toLowerCase())));
 const edited=!requirement.edit||interactions.some(i=>target.test(i.route)&&
  (!requirement.editFields||new RegExp(requirement.editFields).test(i.name)));
 return {required:true,passed:arrived&&relevant&&(!requirement.form||formVisible)&&edited,
  arrived,relevant,formVisible,edited,transitions,interactions,
  targetScreens:visited.map(s=>({route:s.route,callId:s.callId,at:s.at}))};
}
module.exports={score};
