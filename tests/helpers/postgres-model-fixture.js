'use strict';
// Expand legacy test shorthand into the actual production request schema. This
// helper is test-only; production model output must pass validation unchanged.
function part(value,message){return {requestText:message,continuesPrevious:false,clarifyingQuestion:'',intent:'clarify',view:null,action:null,search:null,sku:null,skuReference:'',
 location:null,fromLocation:null,toLocation:null,quantity:null,countedQuantity:null,amount:null,currency:null,reason:null,
 reference:null,recipient:'',recipientKind:'',subject:'',body:'',mailbox:'',customer:'',supplier:'',deliveryMethod:'',
 shipToAddress:'',neededBy:'',purchaseOrder:'',supplierBill:'',receiptReference:'',paymentMethod:'',paymentDate:'',
 readQueries:[],...value};}
const PRICED_MODEL='claude-haiku-4-5-20251001';
function pricedUsage(usage={}){return {...usage,provider:'anthropic',model:PRICED_MODEL,
 providerVersion:'2023-06-01',inputTokens:usage.inputTokens??20,outputTokens:usage.outputTokens??10};}
const ACTION_NAMES={receive:'inventory.receive',issue:'inventory.issue',transfer:'inventory.transfer',
 adjust:'inventory.adjust',create_item:'catalog.create_item',create_location:'location.create',
 set_price:'catalog.set_price',set_purchase_cost:'catalog.set_purchase_cost',send_email:'communication.send_email',
 create_sales_order:'sales_order.create',create_purchase_order:'purchase_order.create',
 receive_purchase_order:'purchase_order.receive',record_supplier_payment:'supplier_payment.record'};
function contractStep(capability,fields,view=null){
 const allowed=view?['search','timeframe']:['search','sku','skuScope','location','fromLocation','toLocation',
  'quantity','countedQuantity','amount','currency','reason','reference','recipient','recipientKind','subject','body',
  'mailbox','customer','supplier','deliveryMethod','shipToAddress','neededBy','purchaseOrder','supplierBill',
  'receiptReference','paymentMethod','paymentDate'];
 const args={...fields};if(fields.skuReference==='stocked')args.skuScope='currently_stocked';
 return {capability,arguments:allowed.filter((key)=>args[key]!==null&&args[key]!==undefined&&args[key]!=='')
   .map((name)=>({name,value:String(args[name])})),dependsOn:[],
   continuesPending:fields.continuesPrevious===true};
}
function contractPlan(result,message){
 const parts=result.data.parts||[result.data];const steps=[];
 for(const raw of parts){const value=part(raw,message);
  if(raw.navigate){steps.push(contractStep(`navigate.${raw.navigate}`,{}));continue;}
  if(value.intent==='instruction'){steps.push(contractStep('policy.propose',{}));continue;}
  if(value.intent==='action'&&ACTION_NAMES[value.action]){
   steps.push(contractStep(ACTION_NAMES[value.action],value));continue;}
  if(value.intent==='lookup'){
   const queries=value.readQueries?.length?value.readQueries:[{view:value.view,search:value.search,
     timeframe:value.timeframe||'all_time'}];
   for(const query of queries)if(query.view)steps.push(contractStep(`read.${query.view}`,query,true));
  }
 }
 return {steps,clarifyingQuestion:steps.length?'':String(parts[0]?.clarifyingQuestion||'What should I check?')};
}
function fixture(provider){return {...provider,name:'anthropic',model:PRICED_MODEL,async complete(request){
 if(request.schemaName==='stockchief_capability_plan'){
  const payload=JSON.parse(request.prompt);const legacy={...request,schemaName:'stockchief_postgres_request',
   prompt:JSON.stringify({message:payload.message,history:payload.conversation||[]})};
  const result=await provider.complete(legacy);return {data:contractPlan(result,payload.message),usage:pricedUsage(result.usage||{})};
 }
 if(request.schemaName==='stockchief_capability_answer'){
  const payload=JSON.parse(request.prompt);const evidence=payload.evidence||[];
  let result=null;
  try{result=await provider.complete({...request,schemaName:'stockchief_postgres_research_answer',
   prompt:JSON.stringify({question:payload.question,evidence:evidence.map((entry)=>({
    query:{view:entry.capability.replace(/^read\./,''),timeframe:entry.arguments?.timeframe||'all_time'},
    result:{rows:entry.rows,answer:entry.recordedAnswer}}))})});}catch{}
  if(result?.data?.supported!==undefined){return {data:{answer:result.data.answer,
   supported:result.data.supported,usedSteps:(result.data.usedViews||[]).map((view)=>
    evidence.findIndex((entry)=>entry.capability===`read.${view}`)).filter((index)=>index>=0)},
   usage:pricedUsage(result.usage||{})};}
  return {data:{answer:evidence.map((entry)=>entry.recordedAnswer).join(' '),supported:true,
   usedSteps:evidence.map((_,index)=>index)},usage:pricedUsage()};
 }
 let result;try{result=await provider.complete(request);}catch(error){
  error.usage=pricedUsage(error.usage||{});throw error;}
 if(request.schemaName==='stockchief_postgres_request'){
  const message=JSON.parse(request.prompt).message;
  result.data={parts:(result.data.parts||[result.data]).map(value=>part(value,message))};}
 return {...result,usage:pricedUsage(result.usage||{})};}};}
module.exports={fixture,part,pricedUsage,PRICED_MODEL};
