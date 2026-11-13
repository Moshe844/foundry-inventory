'use strict';
// Job 188: one way to answer a question asked in Slack, Teams or WhatsApp.
// It only reads, as the person who asked: questions about records go through
// the bounded business read (the same report contracts as Ask, so a role that
// may not see costs or margins never gets them, job 203), and the owner can
// read an agent review through Ask's own read.agent_review capability. A
// request to change something is never carried out here; it links back to
// the app. No new Ask capability is added.
const bounded=require('../assistant/bounded-business-read');
const permissions=require('../actions/permissions');

function link(path){
  const origin=require('../config').connections.publicOrigin;
  try{return origin?new URL(path,origin).href:path;}catch{return path;}
}
const HELP=/^(?:help|\?|what can you do\??)$/i;
const LIST=/^(?:reviews|review)$|^reviews\s+(.+)$/is,ONE=/^review\s+(\S+)\s*(.*)$/is;

function cell(value){
  if(value==null||value==='')return null;
  if(typeof value==='object')return null;
  const text=String(value).replace(/\s+/g,' ').trim();
  return text.length>160?text.slice(0,157)+'…':text;
}
function renderReview(label,key,result){
  const rows=(result.rows||[]).slice(0,10).map(row=>'• '+Object.entries(row).filter(([name])=>!/^(link|href|id)$/i.test(name))
    .map(([name,value])=>[name,cell(value)]).filter(([,value])=>value!==null).map(([name,value])=>name+': '+value).join(' · ')).filter(line=>line.length>2);
  return [label,result.summary||'',rows.length?rows.join('\n'):'Nothing to review right now.',
    (result.rows||[]).length>10||result.coverage?String(result.coverage||'Open the review for the remaining results.'):'',
    'Open the review: '+link('/autopilot/reviews/'+encodeURIComponent(key))].filter(Boolean).join('\n\n');
}

// "reviews [word]" lists the agent reviews the owner's plan includes, matching
// the word; "review <name> [filter]" reads one through read.agent_review, with
// its own owner and plan checks.
async function review(db,ctx,actor,{list,name,rest}){
  const contract=require('../assistant/postgres-capability-registry').registry.get('read.agent_review');
  if(!contract||!permissions.can(actor,contract.permission)||contract.ownerOnly&&actor.role!=='owner')
    return {text:'Agent reviews are for the inventory owner. Ask a question about your records instead.',outcome:'review_refused'};
  const reviews=require('../autopilot/job-reviews'),state=await reviews.ownerState(db,ctx);
  const offered=reviews.offers(state).filter(o=>o.mode&&o.mode!=='excluded');
  if(list){
    const words=String(rest||'').toLowerCase().split(/\s+/).filter(Boolean);
    const found=offered.filter(o=>words.every(w=>(o.key+' '+o.label).toLowerCase().includes(w)));
    return {outcome:'review_list',text:(found.length?'Reviews you can read here: '+found.slice(0,40).map(o=>o.key+' ('+o.label+')').join('; ')+'.':'No review on your plan matches that.')+
      (found.length>40?'\n\nSend “reviews” and a word to narrow the list.':'')+'\n\nSend “review” and one of these names, for example “review '+(found[0]||offered[0])?.key+'”.'};
  }
  const chosen=offered.find(o=>o.key===String(name).toLowerCase());
  if(!chosen)return {text:'Your plan has no review called “'+String(name).slice(0,60)+'”. Send “reviews” and a word to find one.',outcome:'review_unknown'};
  const filter=String(rest||'').trim().slice(0,150);
  const result=await contract.prepare(null,db,ctx,filter,{agentJob:chosen.key,...(filter?{search:filter}:{})});
  return {text:renderReview(chosen.label,chosen.key,result),outcome:'review'};
}

// Returns {text,outcome}. `provider` is the model to use (tests pass a fake);
// `key` names this question's AI credit use, so a failed delivery can refund it.
async function answer(db,ctx,actor,text,{provider=null,key}={}){
  const question=String(text||'').trim();
  if(HELP.test(question))return {outcome:'help',text:'Ask about your records, for example “How many of each product is in stock?”. '+
    (actor.role==='owner'?'Send “reviews” for your agent reviews. ':'')+'StockChief changes nothing from here. To make a change, open '+link('/ask')+'.'};
  const listed=LIST.exec(question),one=!listed&&ONE.exec(question);
  if(listed||one)return review(db,ctx,actor,listed?{list:true,rest:listed[1]}:{name:one[1],rest:one[2]});
  if(!bounded.selected(question))return {outcome:'change_refused',
    text:'StockChief answers questions here and changes nothing. Open StockChief to prepare or approve changes: '+link('/ask')};
  const config=require('../config');
  const raw=provider||(config.ai.configured?require('../ai/provider').createProviderUnobserved(config.ai.provider,config.ai.tier('fast')):null);
  if(!raw)return {outcome:'unavailable',text:'The answer service is unavailable. Open StockChief to check your records.'};
  const clock=await bounded.businessClock(db,ctx.workspaceId),metered=require('../commercial/model').wrap(db,ctx,raw,'ask',key,{deferCustomerCommit:true});
  const datasets=bounded.contracts(actor).map(({dataset,label,fields,metrics})=>({dataset,label,fields,metrics}));
  let result;
  await metered.complete({system:bounded.system,prompt:JSON.stringify({request:question,clock,conversation:[],datasets,
    syntax:require('../reports/postgres-service').querySyntax}),schema:bounded.schema,schemaName:'bounded_business_read',maxOutputTokens:1800,
    onValidated:async value=>{
      const plan=bounded.validate(value,actor);
      result=plan.status==='clarify'?plan.question:bounded.render(await bounded.execute(db,ctx,actor,plan));
    }});
  const credits=(await db.query(`SELECT coalesce(sum(units),0)::text AS used FROM commercial_usage_events
    WHERE workspace_id=$1 AND meter='ai_work_credits' AND idempotency_key=$2 AND status IN ('RESERVED','COMMITTED')`,
    [ctx.workspaceId,ctx.workspaceId+':'+key])).rows[0].used;
  return {outcome:'read',text:result+'\n\nAI credits used '+credits+'.'};
}

// Each answer delivered to a chat is in the audit trail, with who asked, where
// and what kind of answer it was. The question text stays out of the trail.
function audited(db,ctx,{channel,question,outcome}){
  return require('../operations/postgres-security-audit').record(db,ctx,{action:'Chat question answered',reference:question,after:{channel,outcome}});
}

module.exports={answer,audited,link};
