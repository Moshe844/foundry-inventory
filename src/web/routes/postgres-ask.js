'use strict';

const express=require('express');
const config=require('../../config');
const assistant=require('../../assistant/postgres-service');
const outboundMail=require('../../connections/postgres-outbound-mail');
const connections=require('../../connections/postgres-service');
const ledger=require('../../assistant/ledger');
const permissions=require('../../actions/permissions');
const { requireAuth,asyncRoute }=require('../middleware');
const entitlements=require('../../entitlements/postgres-service');
const commercialControl=require('../../commercial/control-service');
const {commercialScope}=require('../commercial-middleware');
const {newId}=require('../../lib/util');
const {destinationFor,connectionDestination}=require('../postgres-navigation');

const STATUS={ANSWERED:'answered',PREPARED:'needs_approval',CLARIFY:'clarify',FAILED:'failed'};

function columnsFor(turn){
  const configured=turn.intent?.presentation?.columns;
  if(Array.isArray(configured)&&configured.length)return configured;
  return turn.evidence?.length?Object.keys(turn.evidence[0]).filter((key)=>key!=='href'):[];
}

function provenanceFor(turn){
  const status=STATUS[turn.status]||'answered';
  if(turn.intent?.view==='general_knowledge')return {reads:[],rowCount:0,asOf:turn.created_at,general:true,
    reason:status==='clarify'?turn.intent?.presentation?.reason:undefined};
  const choices=turn.intent?.presentation?.choices||[];
  const researchViews=turn.intent?.presentation?.researchViews||[];
  return {reads:status==='answered'?(researchViews.length?researchViews:[turn.intent?.view||turn.intent?.intent||'lookup'])
    .map((view)=>({intent:view,entity:turn.intent?.search||turn.intent?.sku||null,
      location:turn.intent?.location||null})):[],
  rowCount:status==='answered'?(turn.evidence||[]).length:null,asOf:status==='answered'?turn.created_at:null,
  reason:status==='clarify'?(turn.intent?.presentation?.reason|| (choices.length>1?'ambiguous':'missing')):undefined};
}

function goalFor(turn,index,position=0,emailProposal=null){
  const status=emailProposal&&emailProposal.status!=='PENDING'?'answered':STATUS[turn.status]||'answered';
  const provenance=provenanceFor(turn);const label=ledger.statusLabelFor(status,provenance);
  return {id:turn.id,position,kind:turn.intent?.intent||'lookup',text:turn.message,status,said:turn.answer,
    resultHref:emailProposal?null:turn.intent?.proposalHref||null,resultLabel:turn.intent?.proposalHref?'Review prepared change':null,
    provenance,statusLabel:emailProposal?.status==='EXECUTED'
      ?emailProposal.deliveryStatus==='SENT'?'Sent':emailProposal.deliveryStatus==='FAILED'?'Delivery issue':'Sending'
      :emailProposal?.status==='CANCELLED'?'Discarded':label.label,
    statusTone:label.tone,createdAt:turn.created_at,updatedAt:turn.created_at,index};
}

function transcriptFor(interactions,emailProposal=null){
  const transcript=[];const batches=new Map();
  interactions.forEach((turn,index)=>{
    const batchId=turn.intent?.batchId;
    if(!batchId){transcript.push({id:`turn-${turn.id}`,conversationId:'postgres',channel:'ask',message:turn.message,
      understanding:turn.intent||{},createdAt:turn.created_at,
      goals:[goalFor(turn,index,0,emailProposal?.interactionId===turn.id?emailProposal:null)],referents:[]});return;}
    let batch=batches.get(batchId);
    if(!batch){batch={id:`turn-${batchId}`,conversationId:'postgres',channel:'ask',message:turn.intent.sourceMessage||turn.message,
      understanding:{intent:'multi_request'},createdAt:turn.created_at,goals:[],referents:[]};batches.set(batchId,batch);transcript.push(batch);}
    batch.goals.push(goalFor(turn,index,Math.max(0,Number(turn.intent.requestIndex||1)-1),
      emailProposal?.interactionId===turn.id?emailProposal:null));
    batch.goals.sort((left,right)=>left.position-right.position);
  });
  return transcript;
}

function resultFor(turn,emailProposal=null){
  if(!turn)return null;const columns=columnsFor(turn);const rows=turn.evidence||[];
  const proposalHref=turn.intent?.proposalHref||null;const storedHandoff=turn.intent?.presentation?.handoff||null;
  let answer=turn.answer;
  if(emailProposal?.status==='EXECUTED')answer=emailProposal.deliveryStatus==='SENT'
    ?`Email sent to ${emailProposal.payload.recipientEmail}. The mailbox confirmed delivery.`
    :emailProposal.deliveryStatus==='FAILED'
      ?'The mailbox did not confirm this email. Check its delivery status before trying again.'
      :`Approved. StockChief queued the email to ${emailProposal.payload.recipientEmail} and is checking delivery.`;
  if(emailProposal?.status==='CANCELLED')answer='Draft discarded. No email was sent and no contact was added.';
  return {question:turn.message,answer,spoken:null,progressiveDisclosure:false,rows,columns,
    rowCount:rows.length,totalMatches:rows.length,sections:[],supported:turn.status!=='CLARIFY',
    general:turn.intent?.view==='general_knowledge',answerReason:turn.intent?.presentation?.reason||null,isAction:false,
    needsClarification:turn.status==='CLARIFY'&&!['unverified','unavailable'].includes(turn.intent?.presentation?.reason),
    choices:turn.intent?.presentation?.choices||[],emailFlow:turn.intent?.presentation?.emailFlow||null,
    emailProposal,
    handoff:emailProposal?null:proposalHref?{href:proposalHref,label:'Review prepared change'}:storedHandoff,
    plan:{intent:turn.intent?.intent||'lookup',entityQuery:turn.intent?.search||turn.intent?.sku||'',
    locationQuery:turn.intent?.location||''},interpretation:(turn.intent?.presentation?.researchViews||[]).join(', ')||
      turn.intent?.view||turn.intent?.action||turn.intent?.intent||'business request',
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
  async function navigationDestination(req){
    const destination=destinationFor(req.body.message);
    return destination?.providerType?connectionDestination(destination,
      await connections.list(database,req.ctx.workspaceId)):destination;
  }
  router.use(['/ask','/actions'],requireAuth);
  router.get('/ask',asyncRoute(async(req,res)=>{
    const startedAt=req.session.postgresAskStartedAt||null;
    const interactions=(await assistant.listInteractions(database,req.ctx.workspaceId,100))
      .filter((turn)=>!startedAt||String(turn.created_at)>=startedAt);
    const visible=interactions.slice(-12);const latest=visible.at(-1)||null;
    let emailProposal=null;
    if(latest?.intent?.proposalId&&latest.intent.proposalHref?.startsWith('/actions/')){
      const proposal=await assistant.getProposal(database,req.ctx.workspaceId,latest.intent.proposalId);
      if(proposal.action_type==='communication.send_email'){
        let deliveryStatus=null;
        if(proposal.status==='EXECUTED'&&proposal.result?.communicationId){
          const delivered=await outboundMail.get(database,req.ctx.workspaceId,
            proposal.result.communicationKind,proposal.result.communicationId);
          deliveryStatus=delivered.status;
        }
        emailProposal={id:proposal.id,interactionId:latest.id,payload:proposal.payload,
          status:proposal.status,result:proposal.result||null,deliveryStatus};
      }
    }
    const transcript=transcriptFor(visible,emailProposal);const rules=await instructionLists(database,req.ctx.workspaceId);
    return res.page('attention/ask',{title:'Ask StockChief',nav:'ask',room:true,suppressBack:true,postgresAsk:true,...rules,
      about:String(req.query.about||'').slice(0,2000),question:latest?.message||'',result:resultFor(latest,emailProposal),error:null,
      conversation:null,transcript,currentGoalId:latest?.id||null,conversationId:`postgres:${req.ctx.workspaceId}`,
      aiConfigured:Boolean(options.provider||config.ai.configured),usageKey:newId('askusage'),
      examples:await askExamples(database,req.ctx.workspaceId)});
  }));
  router.post('/ask/new',(req,res)=>{
    req.session.postgresAskStartedAt=new Date().toISOString();
    req.flash('success','New conversation started. Earlier conversations remain in the audit history.');
    return res.redirect(303,'/ask');
  });
  async function runAsk(req){
    const scope=commercialScope(req);await entitlements.assertCapability(database,scope,'ask.lookup');
    const context=await assistant.pendingClarification(database,req.ctx,req.session.postgresAskStartedAt||null);
    return assistant.ask(database,req.ctx,req.body.message,{provider:options.provider,
      usageKey:String(req.body.usageKey||newId('askusage')),context,
      startedAt:req.session.postgresAskStartedAt||null});
  }
  router.post('/ask',asyncRoute(async(req,res)=>{
    const destination=await navigationDestination(req);
    if(destination){req.flash('success',`Opened ${destination.label}.`);return res.redirect(303,destination.href);}
    await runAsk(req);
    return res.redirect(303,'/ask#latest');
  }));
  router.post('/ask/email/continue',asyncRoute(async(req,res)=>{
    await assistant.continueEmail(database,req.ctx,req.body,{provider:options.provider,
      usageKey:String(req.body.usageKey||newId('askusage')),startedAt:req.session.postgresAskStartedAt||null});
    return res.redirect(303,'/ask#latest');
  }));
  async function emailProposalFor(req){
    const proposal=await assistant.getProposal(database,req.ctx.workspaceId,req.params.id);
    if(proposal.action_type!=='communication.send_email'||proposal.actor_user_id!==req.ctx.actorId)
      throw new (require('../../domain/errors').ValidationError)('That email draft is not yours to change.');
    return proposal;
  }
  router.post('/ask/email/:id/revise',asyncRoute(async(req,res)=>{
    await emailProposalFor(req);await assistant.reviseEmailProposal(database,req.ctx,req.params.id,req.body);
    return res.redirect(303,'/ask#latest');
  }));
  router.post('/ask/email/:id/approve',asyncRoute(async(req,res)=>{
    await emailProposalFor(req);
    await entitlements.assertCapability(database,commercialScope(req),'ask.prepare_actions');
    await assistant.executeProposal(database,req.ctx,req.params.id);
    return res.redirect(303,'/ask#latest');
  }));
  router.post('/ask/email/:id/cancel',asyncRoute(async(req,res)=>{
    await emailProposalFor(req);await assistant.cancelProposal(database,req.ctx,req.params.id);
    return res.redirect(303,'/ask#latest');
  }));
  router.post('/foundry/tell',requireAuth,asyncRoute(async(req,res)=>{
    const destination=await navigationDestination(req);
    if(destination){req.flash('success',`Opened ${destination.label}.`);return res.redirect(303,destination.href);}
    await runAsk(req);
    return res.redirect(303,'/ask#latest');
  }));
  router.post('/ask/leave-the-rest',asyncRoute(async(req,res)=>{
    delete req.session.assistantQueue;
    const back=typeof req.body.back==='string'&&req.body.back.startsWith('/')&&!req.body.back.startsWith('//')
      ?req.body.back:'/ask';
    return res.redirect(303,back);
  }));
  router.get('/actions',requireAuth,asyncRoute(async(req,res)=>{
    const rows=(await database.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50`,[req.ctx.workspaceId])).rows;
    const present=(proposal)=>({proposalId:proposal.id,oneLine:proposal.summary,
      safetyLevel:/payment|purchase|send_email/.test(proposal.action_type)?'HIGH':'MEDIUM',sourceType:'ASK',
      status:proposal.status==='EXECUTED'?'SUCCEEDED':proposal.status,rows:[],warnings:[],
      createdAt:proposal.created_at,completedAt:proposal.executed_at||proposal.cancelled_at||null,unverified:false});
    return res.page('actions/list',{title:'StockChief actions',nav:'actions',pending:rows.filter((row)=>row.status==='PENDING').map(present),
      recent:rows.filter((row)=>row.status!=='PENDING').map(present),canOperate:permissions.can(req.user,permissions.OPERATE),
      aiConfigured:Boolean(options.provider||config.ai.configured),instruction:String(req.query.q||'').slice(0,500),
      examples:await askExamples(database,req.ctx.workspaceId),question:null,unsupported:null,assistantGoal:null,where:null,
      blocked:null,physicalEventId:null,choices:null,continuationId:null,questionTone:null});
  }));
  router.get('/actions/:id',asyncRoute(async(req,res)=>res.page('attention/postgres-proposal',{
    title:'Review prepared change',nav:'ask',proposal:await assistant.getProposal(database,req.ctx.workspaceId,req.params.id),
  })));
  router.post('/actions/:id/approve',asyncRoute(async(req,res)=>{
    await entitlements.assertCapability(database,commercialScope(req),'ask.prepare_actions');
    const result=await assistant.executeProposal(database,req.ctx,req.params.id);
    req.flash('success',result.replayed?'That change had already been completed.':'The approved change was completed.');
    return res.redirect(303,`/actions/${req.params.id}`);
  }));
  router.post('/actions/:id/cancel',asyncRoute(async(req,res)=>{
    await assistant.cancelProposal(database,req.ctx,req.params.id);
    req.flash('success','The prepared change was discarded. Nothing changed.');
    return res.redirect(303,'/actions');
  }));
  return router;
}

module.exports={createPostgresAskRouter};
