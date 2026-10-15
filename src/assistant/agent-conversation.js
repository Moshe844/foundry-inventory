'use strict';
const {z}=require('zod'),{createHash}=require('node:crypto');
const text=z.string().trim().min(1).max(20000);
const missing=z.preprocess(value=>typeof value==='string'?[value]:value,z.array(z.string().trim().min(1).max(1000)).min(1).max(30));
const WorkProducts=z.array(z.object({title:z.string().trim().min(1).max(120),content:z.string().min(1).max(12000)})).max(3);
const NextActions=z.array(z.object({label:z.string().trim().min(1).max(80),instruction:z.string().trim().min(1).max(4000)})).max(3);
// One wire contract for all domains. Model reports express intent, never an
// approval, an execution grant, or proof that a business outcome occurred.
const Report=z.discriminatedUnion('status',[
 z.object({version:z.literal(1).optional(),status:z.literal('needs_reasoning'),tier:z.enum(['standard','complex','exceptional']),reason:z.string().trim().min(1).max(1600)}),
 z.object({version:z.literal(1).optional(),status:z.literal('needs_user'),question:text.refine(q=>publicText(q,'')===q),missingInformation:missing}),
 z.object({version:z.literal(1).optional(),status:z.literal('completed'),outcome:z.enum(['answer','navigation']).optional(),answer:text,
  claims:z.array(z.object({evidenceId:z.string(),path:z.string(),value:z.unknown(),historical:z.boolean().optional()})).max(50),
  navigation:z.object({evidenceId:z.string(),path:z.string()}).optional(),workProducts:WorkProducts.optional(),nextActions:NextActions.optional()}),
 z.object({version:z.literal(1).optional(),status:z.literal('blocked'),answer:text})
]);
function parse(raw){
 let value=raw;
 if(typeof raw==='string'){try{value=JSON.parse(raw);}catch{return null;}}
 const result=Report.safeParse(value);return result.success?{version:1,...result.data}:null;
}
const FAILED='I could not finish this request safely. Your goal and recorded work are saved. Any completed operations retain their recorded status.';
function publicText(value,fallback=FAILED){
 if(typeof value!=='string'||!value.trim())return fallback;
 // Protocol envelopes and exception diagnostics are never a customer answer.
 if(/^\s*(?:[\[{]|```(?:json)?\s*[\[{])/i.test(value)||/Outcome not fully verified\. Agent report:|\b(?:Error|Exception|TypeError):|\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){2,}\b|\bat \S+\s*\([^\n]+:\d+:\d+\)/.test(value))return fallback;
 return value.trim().slice(0,20000);
}
function classify({report,answer,verified,current='READY',canonicalVerified=true,progress={}}){
 report=parse(report)||parse(answer);
 // Canonical dependencies outrank a model's view of what stage it reached.
 if(current!=='READY')return {status:current,answer:current==='WAITING_APPROVAL'?'The prepared changes need your approval.':current==='WAITING_EVENT'?'An authorized operation is still awaiting confirmation.':FAILED};
 if(verified&&canonicalVerified)return {status:'COMPLETED',answer:publicText(report?.answer||answer)};
 // A failed host admission is not a missing business choice. Only trusted
 // progress supplies this flag; a model question cannot grant more tools,
 // money or execution authority. An already valid clarification or canonical
 // approval still survives a limit reached after it was prepared.
 if(progress.finalReason&&progress.requiresUserInput===false)return {status:'BLOCKED',answer:FAILED,
  failure:{code:progress.finalReason,requiresUserInput:false}};
 if(report?.status==='needs_user')return {status:'WAITING_USER',answer:publicText(report.question),
  question:{question:publicText(report.question),missingInformation:report.missingInformation}};
 return {status:'BLOCKED',answer:report?.status==='blocked'?publicText(report.answer):FAILED,
  failure:{code:progress.finalReason||'OUTCOME_UNVERIFIED',requiresUserInput:false}};
}
const labels={queued:'Getting started',working:'Working on your request',clarification:'Let’s clarify',approval:'Ready for your approval',
 external_wait:'Waiting for confirmation',navigation:'Ready to open in your browser',verification:'Checking the result',completed:'Completed',
 interrupted:'Work paused',funding:'Spending limit reached',capacity:'Daily work limit reached',service_wait:'AI service temporarily unavailable',failed:'Could not finish',cancelled:'Stopped'};
const ConversationState=z.object({version:z.literal(1),goalId:z.string(),phase:z.enum(Object.keys(labels)),label:z.string(),
 active:z.boolean(),terminal:z.boolean(),message:z.string(),canReply:z.boolean(),revision:z.number().int().nonnegative(),
 input:z.object({id:z.string(),question:z.string(),missingInformation:z.array(z.string())}).nullable(),
 history:z.array(z.object({id:z.string(),role:z.enum(['user','assistant']),text:z.string(),at:z.string(),phase:z.string().optional()})),recovery:z.string().nullable()});
/** @returns {import('zod').output<typeof ConversationState>} */
function state(goal){
 const cp=goal.checkpoint||{},h=cp.harness||{},saved=cp.conversationState;
 const phase=({READY:cp.lifecycleStage==='verification'?'verification':'queued',RUNNING:cp.lifecycleStage==='verification'?'verification':'working',
  WAITING_USER:'clarification',WAITING_APPROVAL:'approval',WAITING_EVENT:['PENDING','DELIVERING'].includes(cp.navigation?.state)?'navigation':'external_wait',COMPLETED:'completed',
  BLOCKED:h.interruption?.code==='SHARED_SPENDING_CEILING'?'funding':h.interruption?.limitKind==='daily_model_attempts'?'capacity':h.interruption?.code==='CODEX_TOKEN_COUNT_UNAVAILABLE'?'service_wait':h.interruption?'interrupted':'failed',CANCELLED:'cancelled'})[goal.status]||'failed';
 const question=goal.status==='WAITING_USER'?(h.userQuestion||saved?.input||{question:goal.answer,missingInformation:['Your decision']}):null;
 const input=question?{id:question.id||createHash('sha256').update(JSON.stringify([goal.id,cp.messages?.length||0,question.question])).digest('hex'),
  question:publicText(question.question,'What would you like me to use?'),missingInformation:missing.safeParse(question.missingInformation).success?missing.parse(question.missingInformation):[]}:null;
 const history=saved?.history||[],questions=new Set();let precedingAssistant=null;
 // Legacy replies carry the durable question ID. Their preceding assistant
 // message is the clarification, without matching any words or domain.
 for(const entry of history){if(entry.role==='assistant')precedingAssistant=entry.id;
  else if(entry.questionId&&precedingAssistant)questions.add(precedingAssistant);}
 const fundingMessage='Your request is saved. The approved spending allowance cannot cover another model request, so paid work has stopped. A separately approved budget increase is required to continue.';
 const capacityMessage='Your business has used today’s AI work allowance. Your request and any completed work are saved. You can continue after the daily allowance resets.';
 const serviceMessage='StockChief’s AI service was temporarily unavailable. Your request and recorded work are saved. No further paid AI request was sent.';
 const partial=['partial_verified_receipt','partial_observation_report'].includes(h.completionSource)?publicText(goal.answer,''):'';
 return ConversationState.parse({version:1,goalId:goal.id,phase,label:labels[phase],active:!['completed','failed','cancelled','interrupted','funding','capacity','service_wait'].includes(phase),
  terminal:['completed','failed','cancelled'].includes(phase),message:['funding','capacity','service_wait'].includes(phase)?[partial,phase==='funding'?fundingMessage:phase==='capacity'?capacityMessage:serviceMessage].filter(Boolean).join('\n\n'):input?.question||publicText(goal.answer,['queued','working','verification'].includes(phase)?'':FAILED),input,
  canReply:phase==='clarification'&&Boolean(input),revision:saved?.revision||0,
  history:history.filter(m=>m.role==='user'||m.phase==='clarification'||!m.phase&&questions.has(m.id))
   .map(m=>({id:m.id,role:m.role,text:publicText(m.text,''),at:m.at,phase:m.phase})),
  recovery:phase==='funding'?'Your goal is saved. Paid work requires a separately approved spending allowance.':phase==='capacity'?'Your goal is saved. Continue after the daily allowance resets.':phase==='service_wait'?'Your request is saved. Continue when the AI service is available.':phase==='interrupted'?'Your goal is saved. Recorded operations must be checked before work resumes.':null});
}
function sync(goal){
 const old=goal.checkpoint.conversationState,next=state(goal);
 const same=old&&old.phase===next.phase&&old.message===next.message&&old.input?.id===next.input?.id;
 next.history=old?.history||[];
 if(!same){next.revision=(old?.revision||0)+1;
  if(next.message&&next.message!==old?.message)next.history=[...next.history,{id:`${goal.id}:assistant:${next.revision}`,role:'assistant',text:next.message,phase:next.phase,at:new Date().toISOString()}];
 }
 if(next.input&&goal.checkpoint.harness)goal.checkpoint.harness.userQuestion={...next.input};
 goal.checkpoint.conversationState=next;return next;
}
const instructions=`\nStockChief conversation contract v1: End a turn with ONE JSON report matching a variant below. This report is consumed by the host, never displayed as JSON.
Clarification: {version:1,status:"needs_user",question:string,missingInformation:string[]}. Ask only the smallest set of genuinely missing user choices needed for the next step. First use authorized records, existing conversation, form defaults and business settings to derive facts safely. Do not ask the user to repeat known information, supply internal IDs, or fill every possible field. Resolve a selected record's prices, currency, contact details and other stored defaults from evidence before asking about absent values. Do not infer a user's choice from multiple possible records. Internal errors, unavailable tools, loops and budget limits are not user questions.
Completion: {version:1,status:"completed",outcome:"answer"|"navigation",answer:string,claims:[{evidenceId:string,path:string,value:any,historical?:boolean}],navigation?:{evidenceId:string,path:string},workProducts?:[{title:string,content:string}],nextActions?:[{label:string,instruction:string}]}. Only the host verifier can mark completion.
When the requested result is something the user can use or edit, deliver its full content as a workProduct, not merely prose describing it. The host durably saves each workProduct and offers a downloadable copy and free-form continuation. Keep answer a short outcome summary; do not repeat the workProduct there. A usable workProduct should include meaningful nextActions rather than leave the user at a dead end: these are natural-language follow-up requests chosen by you, not execution grants or approval. Choose their labels honestly and their instructions precisely; clicking one starts the same governed agent workflow under fresh authority, limits and approvals. Discover applicable operations when needed. Do not invent capabilities, imply a downloadable work product is a canonical business record, or claim a draft was sent. If the requested scope includes an actual business operation, prepare/execute its canonical contract rather than returning a workProduct as a substitute.
Blocked: {version:1,status:"blocked",answer:string}. Use this for refusals, unavailable access and unsupported requests, including when the user explicitly requested a refusal. Keep the useful explanation here instead of reporting a claimless completed business answer. Do not call tools merely to manufacture a citation for a refusal. Describe the limitation in ordinary language without internal error codes, stack traces or protocol data.
Clarification does not complete or abandon the goal. The next human reply continues this same goal with its durable evidence, canonical proposals, limits and original instructions. Human input alone is never approval of a business operation.`;
module.exports={Report,ConversationState,WorkProducts,NextActions,parse,classify,state,sync,publicText,instructions,FAILED};
