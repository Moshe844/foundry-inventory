'use strict';

const express=require('express');
const crypto=require('node:crypto');
const config=require('../../config');
const assistant=require('../../assistant/postgres-service');
const imports=require('../../imports/postgres-service');
const outboundMail=require('../../connections/postgres-outbound-mail');
const ledger=require('../../assistant/ledger');
const permissions=require('../../actions/permissions');
const { requireAuth,asyncRoute }=require('../middleware');
const entitlements=require('../../entitlements/postgres-service');
const commercialControl=require('../../commercial/control-service');
const {registry:capabilities}=require('../../assistant/postgres-capability-registry');
const {commercialScope}=require('../commercial-middleware');
const {newId}=require('../../lib/util');
const {ValidationError}=require('../../domain/errors');

const STATUS={ANSWERED:'answered',PREPARED:'needs_approval',CLARIFY:'clarify',FAILED:'failed'};

function completedSummary(proposal){
  const key=capabilities.get(proposal.actionType)?.resultDisplayReference;
  const reference=key&&proposal.result?.[key];
  return `Completed: ${proposal.summary}${reference?` Reference: ${reference}.`:''}`;
}

function columnsFor(turn){
  const configured=turn.intent?.presentation?.columns;
  if(Array.isArray(configured)&&configured.length)return configured;
  return turn.evidence?.length?Object.keys(turn.evidence[0]).filter((key)=>key!=='href'):[];
}

function provenanceFor(turn){
  const status=STATUS[turn.status]||'answered';
  if(turn.intent?.intent==='navigation')return {reads:[],rowCount:null,asOf:null};
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

function goalFor(turn,index,position=0,proposal=null){
  const status=proposal&&proposal.status!=='PENDING'?'answered':STATUS[turn.status]||'answered';
  const provenance=provenanceFor(turn);const label=ledger.statusLabelFor(status,provenance);
  const said=proposal?.status==='PENDING'&&turn.status==='PREPARED'
    ?`${proposal.summary} Nothing has changed yet.`:
    proposal?.status==='APPROVED'?`Rule in force: ${proposal.summary}`:
    proposal?.status==='EXECUTED'?proposal.actionType==='communication.send_email'
      ?`Email approved for ${proposal.payload.recipientEmail}; check delivery status.`:completedSummary(proposal):
      ['CANCELLED','SUPERSEDED'].includes(proposal?.status)?'This proposal was discarded.':turn.answer;
  return {id:turn.id,position,kind:turn.intent?.intent||'lookup',text:turn.message,status,said,
    resultHref:proposal?.status==='PENDING'?turn.intent?.proposalHref||null:null,
    resultLabel:proposal?.status==='PENDING'?'Review prepared change':null,
    provenance,statusLabel:proposal?.status==='APPROVED'?'In force':proposal?.status==='EXECUTED'
      ?proposal.actionType==='communication.send_email'
        ?proposal.deliveryStatus==='SENT'?'Sent':proposal.deliveryStatus==='FAILED'?'Delivery issue':'Sending'
        :'Completed'
      :['CANCELLED','SUPERSEDED'].includes(proposal?.status)?'Discarded':label.label,
    statusTone:label.tone,createdAt:turn.created_at,updatedAt:turn.created_at,index};
}

function transcriptFor(interactions,proposals=new Map()){
  const transcript=[];const batches=new Map();
  interactions.forEach((turn,index)=>{
    const batchId=turn.intent?.batchId;
    if(!batchId){transcript.push({id:`turn-${turn.id}`,conversationId:'postgres',channel:'ask',message:turn.message,
      understanding:turn.intent||{},createdAt:turn.created_at,
      goals:[goalFor(turn,index,0,proposals.get(turn.intent?.proposalId))],referents:[]});return;}
    let batch=batches.get(batchId);
    if(!batch){batch={id:`turn-${batchId}`,conversationId:'postgres',channel:'ask',message:turn.intent.sourceMessage||turn.message,
      coveragePendingStatuses:['pending','needs_approval','clarify'],
      understanding:{intent:'multi_request'},createdAt:turn.created_at,goals:[],referents:[]};batches.set(batchId,batch);transcript.push(batch);}
    batch.goals.push(goalFor(turn,index,Math.max(0,Number(turn.intent.requestIndex||1)-1),
      proposals.get(turn.intent?.proposalId)));
    batch.goals.sort((left,right)=>left.position-right.position);
  });
  for(const batch of batches.values())batch.goals.forEach((goal,position)=>{goal.position=position;});
  return transcript;
}

function resultFor(turn,proposal=null){
  if(!turn)return null;const columns=columnsFor(turn);const rows=turn.evidence||[];
  const proposalHref=turn.intent?.proposalHref||null;const storedHandoff=turn.intent?.presentation?.handoff||null;
  const emailProposal=proposal?.actionType==='communication.send_email'?proposal:null;
  let answer=turn.answer;
  if(proposal?.status==='PENDING'&&turn.status==='PREPARED')answer=`${proposal.summary} Nothing has changed yet.`;
  if(proposal?.status==='EXECUTED'&&!emailProposal)answer=completedSummary(proposal);
  if(proposal?.status==='APPROVED')answer=`Rule in force: ${proposal.summary}`;
  if(['CANCELLED','SUPERSEDED'].includes(proposal?.status))answer='Discarded. Nothing was changed by this proposal.';
  if(emailProposal?.status==='EXECUTED')answer=emailProposal.deliveryStatus==='SENT'
    ?`Email sent to ${emailProposal.payload.recipientEmail}. The mailbox confirmed delivery.`
    :emailProposal.deliveryStatus==='FAILED'
      ?'The mailbox did not confirm this email. Check its delivery status before trying again.'
      :`Approved. StockChief queued the email to ${emailProposal.payload.recipientEmail} and is checking delivery.`;
  if(emailProposal?.status==='CANCELLED')answer='Draft discarded. No email was sent and no contact was added.';
  return {question:turn.message,answer,spoken:null,progressiveDisclosure:false,rows,columns,
    reportConfig:turn.intent?.reportConfig||null,
    comparisonSafe:turn.intent?.comparisonSafe!==false,
    rowCount:rows.length,totalMatches:rows.length,sections:[],supported:turn.status!=='CLARIFY',
    general:turn.intent?.view==='general_knowledge',answerReason:turn.intent?.presentation?.reason||null,isAction:false,
    needsClarification:turn.status==='CLARIFY'&&
      !['unverified','unavailable','unsupported','daily_safety_limit'].includes(turn.intent?.presentation?.reason),
    choices:turn.intent?.presentation?.choices||[],emailFlow:turn.intent?.presentation?.emailFlow||null,
    emailProposal,
    handoff:proposal&&proposal.status!=='PENDING'?null:emailProposal?null:
      proposalHref?{href:proposalHref,label:'Review prepared change'}:storedHandoff,
    plan:{intent:turn.intent?.intent||'lookup',entityQuery:turn.intent?.search||turn.intent?.sku||'',
    locationQuery:turn.intent?.location||''},interpretation:(turn.intent?.presentation?.researchViews||[]).join(', ')||
      turn.intent?.view||turn.intent?.action||turn.intent?.intent||'business request',
    semanticPlan:null};
}

async function askExamples(database,ctx,page=null){
  return require('../../assistant/postgres-discovery').suggestions(database,ctx,4,page);
}

async function instructionLists(database,workspaceId){
  const rows=(await database.query(`SELECT id,stated_as,summary,questions,status,approved_at,created_at
    FROM operating_instruction_proposals WHERE workspace_id=$1 AND status IN ('PENDING','APPROVED')
    ORDER BY created_at DESC LIMIT 20`,[workspaceId])).rows.map((row)=>({id:row.id,statedAs:row.stated_as,
      summary:row.summary,questions:Array.isArray(row.questions)?row.questions:[],status:row.status,
      approvedAt:row.approved_at,createdAt:row.created_at}));
  return {recentRules:rows.filter((row)=>row.status==='APPROVED'),pendingRules:rows.filter((row)=>row.status==='PENDING')};
}

async function proposalStates(database,workspaceId,interactions){
  const ids=[...new Set(interactions.map((turn)=>turn.intent?.proposalId).filter(Boolean))];
  const states=new Map();if(!ids.length)return states;
  const [actions,instructions]=await Promise.all([
    database.query(`SELECT id,status,action_type,summary,payload,result FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 AND id=ANY($2::text[])`,[workspaceId,ids]),
    database.query(`SELECT id,status,summary FROM operating_instruction_proposals
      WHERE workspace_id=$1 AND id=ANY($2::text[])`,[workspaceId,ids]),
  ]);
  for(const row of actions.rows)states.set(row.id,{id:row.id,status:row.status,actionType:row.action_type,
    summary:row.summary,payload:row.payload,result:row.result});
  for(const row of instructions.rows)states.set(row.id,{id:row.id,status:row.status,
    actionType:'operating.instruction',summary:row.summary});
  return states;
}

function createPostgresAskRouter(database,options={}){
  const router=express.Router();
  router.use(['/ask','/actions'],requireAuth);
  router.get('/ask/capabilities',asyncRoute(async(req,res)=>{
    const entries=await require('../../assistant/postgres-discovery').available(database,req.ctx);
    const query=String(req.query.q||'').trim().slice(0,120).toLowerCase();
    const visible=query?entries.filter((entry)=>
      `${entry.label} ${entry.description} ${entry.name}`.toLowerCase().includes(query)):entries;
    const groups=[
      {kind:'read',title:'Understand your business'},
      {kind:'mutation',title:'Prepare changes for approval'},
      {kind:'policy',title:'Set standing instructions'},
      {kind:'navigation',title:'Open the right place'},
    ].map((group)=>({...group,entries:visible.filter((entry)=>entry.kind===group.kind)}));
    return res.page('attention/ask-capabilities',{title:'What Ask StockChief can do',nav:'ask',room:true,
      query,groups,total:entries.length,visibleCount:visible.length});
  }));
  router.get('/ask',asyncRoute(async(req,res)=>{
    const remembered=req.session.postgresAskPageContext;
    const requestedPath=req.query.from===undefined&&remembered?.workspaceId===req.ctx.workspaceId
      ?remembered.path:req.query.from;
    const sourcePage=await require('../../assistant/postgres-page-context').load(
      database,req.ctx.workspaceId,requestedPath);
    if(req.query.from!==undefined)req.session.postgresAskPageContext=sourcePage
      ?{workspaceId:req.ctx.workspaceId,path:sourcePage.path}:null;
    const startedAt=req.session.postgresAskStartedAt||null;
    const interactions=await assistant.listInteractions(database,req.ctx.workspaceId,100,
      {actorId:req.ctx.actorId,startedAt});
    const visible=interactions.slice(-12);const latest=visible.at(-1)||null;
    const proposals=await proposalStates(database,req.ctx.workspaceId,visible);
    const latestProposal=proposals.get(latest?.intent?.proposalId);
    if(latestProposal?.actionType==='communication.send_email'){
      const proposal=latestProposal;
        let deliveryStatus=null;
        if(proposal.status==='EXECUTED'&&proposal.result?.communicationId){
          const delivered=await outboundMail.get(database,req.ctx.workspaceId,
            proposal.result.communicationKind,proposal.result.communicationId);
          deliveryStatus=delivered.status;
        }
        proposal.deliveryStatus=deliveryStatus;
    }
    const transcript=transcriptFor(visible,proposals);const rules=await instructionLists(database,req.ctx.workspaceId);
    return res.page('attention/ask',{title:'Ask StockChief',nav:'ask',room:true,suppressBack:true,postgresAsk:true,...rules,
      about:String(req.query.about||'').slice(0,2000),question:latest?.message||'',result:resultFor(latest,latestProposal),error:null,
      prefill:String(req.query.q||'').slice(0,2000),
      conversation:null,transcript,currentGoalId:latest?.id||null,conversationId:`postgres:${req.ctx.workspaceId}`,
      aiConfigured:Boolean(options.provider||config.ai.configured),usageKey:newId('askusage'),
      sourcePath:sourcePage?.path||null,examples:await askExamples(database,req.ctx,sourcePage)});
  }));
  router.post('/ask/new',asyncRoute(async(req,res)=>{
    // Use the database clock that timestamps interactions, then persist the
    // boundary before redirecting so the next GET cannot resurrect old turns.
    const boundary=(await database.query('SELECT clock_timestamp()::text AS started_at')).rows[0].started_at;
    req.session.postgresAskStartedAt=boundary;
    req.session.postgresAskPageContext=null;
    req.flash('success','New conversation started. Earlier conversations remain in the audit history.');
    await new Promise((resolve,reject)=>req.session.save((error)=>error?reject(error):resolve()));
    return res.redirect(303,'/ask');
  }));
  async function runAsk(req){
    const scope=commercialScope(req);await entitlements.assertCapability(database,scope,'ask.lookup');
    const files=(req.files||[]).filter((entry)=>entry.field==='file'&&entry.size>0);
    if(files.length){
      if(files.length!==1)throw new ValidationError('Attach one inventory file at a time so its preview can be checked.');
      const file=files[0];
      if(!/\.(csv|tsv|txt|xlsx|pdf)$/i.test(file.filename||''))
        throw new ValidationError('Ask can preview inventory CSV, TSV, Excel and text-layer PDF files here. This file type was not imported.');
      await entitlements.assertCapability(database,scope,'imports.spreadsheet');
      const hash=crypto.createHash('sha256').update(file.buffer).digest('hex');
      const plan=await imports.analyse(database,req.ctx,{buffer:file.buffer,filename:file.filename,
        provider:options.provider,usageKey:require('../../imports/usage-key').analysisUsageKey(hash,req.body.usageKey)});
      return {navigation:{href:`/imports/${plan.id}`}};
    }
    const remembered=req.session.postgresAskPageContext;
    const page=await require('../../assistant/postgres-page-context').load(database,req.ctx.workspaceId,
      req.body.sourcePath||(remembered?.workspaceId===req.ctx.workspaceId?remembered.path:null));
    return assistant.ask(database,req.ctx,req.body.message,{provider:options.provider,
      usageKey:String(req.body.usageKey||newId('askusage')),
      page,startedAt:req.session.postgresAskStartedAt||null});
  }
  router.post('/ask',asyncRoute(async(req,res)=>{
    const result=await runAsk(req);
    return res.redirect(303,result.navigation?.href||'/ask#latest');
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
    const result=await runAsk(req);
    return res.redirect(303,result.navigation?.href||'/ask#latest');
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
      examples:await askExamples(database,req.ctx),question:null,unsupported:null,assistantGoal:null,where:null,
      blocked:null,physicalEventId:null,choices:null,continuationId:null,questionTone:null});
  }));
  router.get('/actions/:id',asyncRoute(async(req,res)=>{
    const proposal=await assistant.getProposal(database,req.ctx.workspaceId,req.params.id);
    const resuming=(await database.query(`SELECT 1 FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 AND actor_user_id=$2 AND status='ADVANCING'
        AND steps @> $3::jsonb LIMIT 1`,[req.ctx.workspaceId,req.ctx.actorId,
      JSON.stringify([{proposalId:proposal.id}])])).rows.length>0;
    return res.page('attention/postgres-proposal',{title:'Review prepared change',nav:'ask',proposal,
      resumeAvailable:proposal.status==='EXECUTED'&&resuming});
  }));
  router.post('/actions/:id/approve',asyncRoute(async(req,res)=>{
    await entitlements.assertCapability(database,commercialScope(req),'ask.prepare_actions');
    const result=await assistant.executeProposal(database,req.ctx,req.params.id);
    if(result.continuationError)req.flash('error',
      'The approved change completed, but StockChief could not continue the remaining steps. Nothing further was approved.');
    else req.flash('success',result.replayed?'That change had already been completed.':
      result.continued?.length?'The approved change completed. Review the next part of your request.':
        'The approved change was completed.');
    const opened=result.continued?.findLast((part)=>part.navigation?.href)?.navigation;
    if(opened?.href?.startsWith('/')&&!opened.href.startsWith('//'))return res.redirect(303,opened.href);
    if(result.continued?.length)return res.redirect(303,'/ask#latest');
    return res.redirect(303,`/actions/${req.params.id}`);
  }));
  router.post('/actions/:id/cancel',asyncRoute(async(req,res)=>{
    await assistant.cancelProposal(database,req.ctx,req.params.id);
    req.flash('success','The prepared change was discarded. Nothing changed.');
    // The review originated in the owner's Ask conversation. Keep the same
    // conversation visible so the owner can correct or continue the request.
    return res.redirect(303,'/ask#latest');
  }));
  router.post('/actions/:id/continue',asyncRoute(async(req,res)=>{
    const proposal=await assistant.getProposal(database,req.ctx.workspaceId,req.params.id);
    if(proposal.status!=='EXECUTED')throw new (require('../../domain/errors').ValidationError)(
      'Approve the prepared change before continuing its dependent steps.');
    const result=await assistant.executeProposal(database,req.ctx,proposal.id);
    req.flash(result.continuationError?'error':'success',result.continuationError
      ?'The completed change is safe, but the remaining steps still need another try.'
      :'StockChief continued the remaining request from the completed step.');
    const opened=result.continued?.findLast((part)=>part.navigation?.href)?.navigation;
    if(opened?.href?.startsWith('/')&&!opened.href.startsWith('//'))return res.redirect(303,opened.href);
    return res.redirect(303,result.continued?.length?'/ask#latest':`/actions/${proposal.id}`);
  }));
  return router;
}

module.exports={createPostgresAskRouter};
