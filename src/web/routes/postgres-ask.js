'use strict';

const express=require('express');
const config=require('../../config');
const assistant=require('../../assistant/postgres-service');
const ledger=require('../../assistant/ledger');
const { requireAuth,asyncRoute }=require('../middleware');

const STATUS={ANSWERED:'answered',PREPARED:'needs_approval',CLARIFY:'clarify',FAILED:'failed'};

function columnsFor(turn){
  const configured=turn.intent?.presentation?.columns;
  if(Array.isArray(configured)&&configured.length)return configured;
  return turn.evidence?.length?Object.keys(turn.evidence[0]).filter((key)=>key!=='href'):[];
}

function provenanceFor(turn){
  const status=STATUS[turn.status]||'answered';
  const choices=turn.intent?.presentation?.choices||[];
  return {reads:status==='answered'?[{intent:turn.intent?.view||turn.intent?.intent||'lookup',
    entity:turn.intent?.search||turn.intent?.sku||null,location:turn.intent?.location||null}]:[],
  rowCount:status==='answered'?(turn.evidence||[]).length:null,asOf:status==='answered'?turn.created_at:null,
  reason:status==='clarify'?(choices.length>1?'ambiguous':'missing'):undefined};
}

function goalFor(turn,index){
  const status=STATUS[turn.status]||'answered';
  const provenance=provenanceFor(turn);const label=ledger.statusLabelFor(status,provenance);
  return {id:turn.id,position:0,kind:turn.intent?.intent||'lookup',text:turn.message,status,said:turn.answer,
    resultHref:turn.intent?.proposalHref||null,resultLabel:turn.intent?.proposalHref?'Review prepared change':null,
    provenance,statusLabel:label.label,statusTone:label.tone,createdAt:turn.created_at,updatedAt:turn.created_at,index};
}

function transcriptFor(interactions){
  return interactions.map((turn,index)=>({id:`turn-${turn.id}`,conversationId:'postgres',channel:'ask',message:turn.message,
    understanding:turn.intent||{},createdAt:turn.created_at,goals:[goalFor(turn,index)],referents:[]}));
}

function resultFor(turn){
  if(!turn)return null;const columns=columnsFor(turn);const rows=turn.evidence||[];
  const proposalHref=turn.intent?.proposalHref||null;
  return {question:turn.message,answer:turn.answer,spoken:null,progressiveDisclosure:false,rows,columns,
    rowCount:rows.length,totalMatches:rows.length,sections:[],supported:true,general:false,isAction:false,
    needsClarification:turn.status==='CLARIFY',choices:turn.intent?.presentation?.choices||[],
    handoff:proposalHref?{href:proposalHref,label:'Review prepared change'}:null,
    plan:{intent:turn.intent?.intent||'lookup',entityQuery:turn.intent?.search||turn.intent?.sku||'',
      locationQuery:turn.intent?.location||''},interpretation:turn.intent?.view||turn.intent?.action||turn.intent?.intent||'business request',
    semanticPlan:null};
}

async function askExamples(database,workspaceId){
  const [item,location]=await Promise.all([
    database.query('SELECT name FROM items WHERE workspace_id=$1 AND is_active=1 ORDER BY created_at LIMIT 1',[workspaceId]),
    database.query('SELECT name FROM locations WHERE workspace_id=$1 AND is_active=1 ORDER BY created_at LIMIT 1',[workspaceId]),
  ]);
  return [item.rows[0]?`How many ${item.rows[0].name} do we have?`:'How many items are in my inventory?',
    location.rows[0]?`What is held at ${location.rows[0].name}?`:'What is in stock?',
    'What needs my attention?','Did the business make or lose money this month?'];
}

async function instructionLists(database,workspaceId){
  const rows=(await database.query(`SELECT id,stated_as,summary,questions,status,approved_at,created_at
    FROM operating_instruction_proposals WHERE workspace_id=$1 AND status IN ('PENDING','APPROVED')
    ORDER BY created_at DESC LIMIT 20`,[workspaceId])).rows.map((row)=>({id:row.id,statedAs:row.stated_as,
      summary:row.summary,questions:Array.isArray(row.questions)?row.questions:[],status:row.status,
      approvedAt:row.approved_at,createdAt:row.created_at}));
  return {recentRules:rows.filter((row)=>row.status==='APPROVED'),pendingRules:rows.filter((row)=>row.status==='PENDING')};
}

function createPostgresAskRouter(database,options={}){
  const router=express.Router();
  router.use(['/ask','/actions'],requireAuth);
  router.get('/ask',asyncRoute(async(req,res)=>{
    const startedAt=req.session.postgresAskStartedAt||null;
    const interactions=(await assistant.listInteractions(database,req.ctx.workspaceId,100))
      .filter((turn)=>!startedAt||String(turn.created_at)>=startedAt);
    const visible=interactions.slice(-12);const latest=visible.at(-1)||null;
    const transcript=transcriptFor(visible);const rules=await instructionLists(database,req.ctx.workspaceId);
    return res.page('attention/ask',{title:'Ask StockChief',nav:'ask',room:true,suppressBack:true,...rules,
      about:String(req.query.about||'').slice(0,2000),question:latest?.message||'',result:resultFor(latest),error:null,
      conversation:null,transcript,currentGoalId:latest?.id||null,conversationId:`postgres:${req.ctx.workspaceId}`,
      aiConfigured:Boolean(options.provider||config.ai.configured),examples:await askExamples(database,req.ctx.workspaceId)});
  }));
  router.post('/ask/new',(req,res)=>{
    req.session.postgresAskStartedAt=new Date().toISOString();
    req.flash('success','New conversation started. Earlier conversations remain in the audit history.');
    return res.redirect(303,'/ask');
  });
  router.post('/ask',asyncRoute(async(req,res)=>{
    await assistant.ask(database,req.ctx,req.body.message,{provider:options.provider});
    return res.redirect(303,'/ask#latest');
  }));
  router.post('/foundry/tell',requireAuth,asyncRoute(async(req,res)=>{
    await assistant.ask(database,req.ctx,req.body.message,{provider:options.provider});
    return res.redirect(303,'/ask#latest');
  }));
  router.post('/ask/leave-the-rest',asyncRoute(async(req,res)=>{
    delete req.session.assistantQueue;
    const back=typeof req.body.back==='string'&&req.body.back.startsWith('/')&&!req.body.back.startsWith('//')
      ?req.body.back:'/ask';
    return res.redirect(303,back);
  }));
  router.get('/actions',requireAuth,(req,res)=>res.redirect(302,'/ask'));
  router.get('/actions/:id',asyncRoute(async(req,res)=>res.page('attention/postgres-proposal',{
    title:'Review prepared change',nav:'ask',proposal:await assistant.getProposal(database,req.ctx.workspaceId,req.params.id),
  })));
  router.post('/actions/:id/approve',asyncRoute(async(req,res)=>{
    const result=await assistant.executeProposal(database,req.ctx,req.params.id);
    req.flash('success',result.replayed?'That change had already been completed.':'The approved change was completed.');
    return res.redirect(303,`/actions/${req.params.id}`);
  }));
  router.post('/actions/:id/cancel',asyncRoute(async(req,res)=>{
    await assistant.cancelProposal(database,req.ctx,req.params.id);
    req.flash('success','The prepared change was discarded. Nothing changed.');
    return res.redirect(303,'/ask');
  }));
  return router;
}

module.exports={createPostgresAskRouter};
