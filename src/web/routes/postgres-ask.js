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
      understanding:{...(turn.intent||{}),...(turn.parent_goal_id?{parentGoalId:turn.parent_goal_id}:{})},createdAt:turn.created_at,
      goals:[goalFor(turn,index,0,proposals.get(turn.intent?.proposalId))],referents:[]});return;}
    let batch=batches.get(batchId);
    if(!batch){batch={id:`turn-${batchId}`,conversationId:'postgres',channel:'ask',message:turn.intent.sourceMessage||turn.message,
      coveragePendingStatuses:['pending','needs_approval','clarify'],
      understanding:{intent:'multi_request',batchId,...(turn.parent_goal_id?{parentGoalId:turn.parent_goal_id}:{})},createdAt:turn.created_at,goals:[],referents:[]};batches.set(batchId,batch);transcript.push(batch);}
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
    columnLabels:turn.intent?.presentation?.columnLabels||{},
    reportConfig:turn.intent?.reportConfig||null,
    comparisonSafe:turn.intent?.comparisonSafe!==false,
    chartAmounts:turn.intent?.presentation?.chartAmounts||null,
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

async function instructionLists(database,ctx,proposalIds){
  const rows=(await database.query(`SELECT id,stated_as,summary,questions,status,approved_at,created_at
    FROM (SELECT * FROM (SELECT * FROM operating_instruction_proposals
        WHERE workspace_id=$1 AND status='APPROVED' ORDER BY created_at DESC,id DESC LIMIT 20) approved
      UNION ALL SELECT * FROM operating_instruction_proposals
        WHERE workspace_id=$1 AND created_by_user_id=$2 AND status='PENDING' AND id=ANY($3::text[])) visible
    ORDER BY created_at DESC,id DESC`,[ctx.workspaceId,ctx.actorId,proposalIds])).rows.map((row)=>({id:row.id,statedAs:row.stated_as,
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
  router.use('/ask',(req,res,next)=>{
    if(req.ctx?.workspaceId){
      const id=req.ctx.workspaceId,previous=req.session.postgresAskWorkspace;
      req.session.postgresAskChats=req.session.postgresAskChats||{};
      if(previous&&previous!==id){req.session.postgresAskChats[previous]={id:req.session.postgresAskConversationId,startedAt:req.session.postgresAskStartedAt};const saved=req.session.postgresAskChats[id]||{};req.session.postgresAskConversationId=saved.id||null;req.session.postgresAskStartedAt=saved.startedAt||null;req.session.postgresAskNavigationGoal=null;}
      req.session.postgresAskWorkspace=id;
    }next();
  });
  const goalStore=require('../../assistant/postgres-goal-store');
  const pilot=require('../../assistant/postgres-codex-pilot');
  const agentNavigation=require('../../assistant/postgres-agent-navigation');
  const conversation=require('../../assistant/agent-conversation');
  const delivery=require('../../assistant/agent-delivery');
  router.use('/ask',(req,res,next)=>{res.locals.agentDelivery=delivery.visible;next();});
  router.use('/ask',(req,res,next)=>{
    res.locals.agentApprovalPresentation=require('../proposal-presentation').cardPresentation;
    next();
  });
  async function deliveredGoal(req,id=req.params.id){
    await pilot.access(database,req.ctx);
    const goal=await goalStore.get(database,req.ctx,id);
    if(goal?.checkpoint.runtime!=='codex-staging'||!delivery.visible(goal))throw new ValidationError('This saved result is not available.');
    await require('../../../scripts/environment-agent-demo/waits').authority(database,req.ctx,goal.checkpoint.harness);
    return goal;
  }
  async function continueWork(req,goal,saved,instruction){
    const message=String(instruction||'').trim();
    if(!message||message.length>12000)throw new ValidationError('Describe what to do next in at most 12,000 characters.');
    if(saved.id!==req.body.deliveryId)throw new ValidationError('The saved result changed. Reload before continuing.');
    if(req.session.postgresAskStartedAt&&new Date(goal.created_at)<=new Date(req.session.postgresAskStartedAt))
      throw new ValidationError('That result belongs to an earlier conversation.');
    const key=crypto.createHash('sha256').update(message).digest('hex');
    const remembered=req.session.postgresAskPageContext;
    const currentPage=remembered?.workspaceId===req.ctx.workspaceId
      ?await require('../../assistant/postgres-page-context').load(database,req.ctx.workspaceId,remembered.path):null;
    const next=await pilot.start(database,req.ctx,message,{usageKey:`next:${goal.id}:${key}`,
      page:currentPage||goal.checkpoint.page,conversationId:req.session.postgresAskConversationId,startedAt:req.session.postgresAskStartedAt||null,
      continuation:{sourceGoalId:goal.id,deliveryId:saved.id,sourcePage:goal.checkpoint.page,workProducts:saved.workProducts}});
    req.session.postgresAskNavigationGoal=next.goalId;return next;
  }
  router.get('/ask/goals/:id/work/:workId',asyncRoute(async(req,res)=>{
    const goal=await deliveredGoal(req),work=delivery.visible(goal).workProducts.find(p=>p.id===req.params.workId);
    if(!work)throw new ValidationError('That work product is not available.');
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Type':'text/plain; charset=utf-8',
      'Content-Disposition':`attachment; filename="stockchief-${work.id.slice(0,16)}.txt"`});
    return res.send(work.content);
  }));
  router.post('/ask/goals/:id/next',asyncRoute(async(req,res)=>{
    const goal=await deliveredGoal(req),saved=delivery.visible(goal);
    const action=saved.nextActions.find(a=>a.id===req.body.actionId);
    if(!action)throw new ValidationError('That next step is not available.');
    // This is a human-selected follow-up, not a tool, planner or approval. The
    // embedded SDK chooses how to perform it under the existing gateway.
    await continueWork(req,goal,saved,action.instruction);
    return res.redirect(303,'/ask#latest');
  }));
  router.post('/ask/goals/:id/navigate',asyncRoute(async(req,res)=>{
    const automatic=req.body.automatic==='1';
    if(automatic&&req.session.postgresAskNavigationGoal!==req.params.id)
      throw new ValidationError('A newer request replaced this page handoff.');
    const pending=await agentNavigation.begin(database,req.ctx,req.params.id,{automatic});
    if(!pending)return res.redirect(303,'/ask#latest');
    req.session.agentNavigation=pending;
    await new Promise((resolve,reject)=>req.session.save(error=>error?reject(error):resolve()));
    return res.redirect(303,pending.href);
  }));
  router.post('/ask/navigation/arrived',asyncRoute(async(req,res)=>{
    const pending=req.session.agentNavigation;
    await agentNavigation.acknowledge(database,req.ctx,pending,String(req.body.token||''));
    if(req.session.postgresAskNavigationGoal===pending.goalId)
      req.session.postgresAskPageContext={workspaceId:req.ctx.workspaceId,path:pending.href};
    return res.json({delivered:true});
  }));
  async function pilotProposalGuard(req,res){
    const native=(await database.query(`SELECT id FROM stockchief_runtime.assistant_goals g WHERE workspace_id=$1
      AND checkpoint->>'runtime'='codex-staging' AND EXISTS(SELECT 1 FROM jsonb_each(COALESCE(checkpoint#>'{harness,approvalDeliveries}','{}'::jsonb)) d
      WHERE d.value->>'proposalId'=$2) LIMIT 1`,[req.ctx.workspaceId,req.params.id])).rows[0];
    if(!native)return false;
    req.flash('error','Review the exact Staging agent approval card in Ask before executing.');res.redirect(303,'/ask');return true;
  }
  router.post('/ask/agent-pilot',asyncRoute(async(req,res)=>{
    if(!['enable','disable'].includes(req.body.mode))throw new ValidationError('Choose enable or disable.');
    await pilot.toggle(database,req.ctx,req.body.mode==='enable');
    req.flash('success',req.body.mode==='enable'?'Staging agent enabled for this test business.':'Staging agent disabled. The existing Ask experience is restored.');
    return res.redirect(303,'/ask');
  }));
  router.post('/ask/goals/:id/approval',asyncRoute(async(req,res)=>{
    if(!['approve','reject'].includes(req.body.decision))throw new ValidationError('Choose approve or reject.');
    await entitlements.assertCapability(database,commercialScope(req),'ask.prepare_actions');
    await pilot.decide(database,req.ctx,req.params.id,String(req.body.deliveryId||''),String(req.body.sha256||''),req.body.decision==='approve',
      {stopOnReject:req.body.returnTo==='/'&&req.body.decision==='reject',responseReference:`Authenticated website ${req.body.decision} by ${req.ctx.actorId} at ${new Date().toISOString()}`,
        missionScope:req.body.scope==='mission'?{kind:'mission',id:String(req.body.missionId||''),sha256:String(req.body.missionHash||'')}:null});
    req.flash('success',req.body.decision==='approve'?'Approved. StockChief is checking the recorded outcome.':'The proposal was rejected.');
    if(req.body.returnTo==='/'&&req.body.decision==='reject'){
      if(req.accepts(['html','json'])==='json')return res.json({dismissed:true});
      return res.redirect(303,'/#suggestions');
    }
    req.session.postgresAskNavigationGoal=req.params.id;
    return res.redirect(303,'/ask?goal='+encodeURIComponent(req.params.id)+'#focused-goal');
  }));
  router.post('/ask/goals/:id/resume',asyncRoute(async(req,res)=>{
    await pilot.resume(database,req.ctx,req.params.id);
    req.session.postgresAskNavigationGoal=req.params.id;
    return res.redirect(303,'/ask?goal='+encodeURIComponent(req.params.id)+'#focused-goal');
  }));
  router.get('/ask/goals/:id',asyncRoute(async(req,res)=>{
    res.set('Cache-Control','no-store');
    let goal=await goalStore.progress(database,req.ctx,req.params.id);
    if(!goal)return res.status(404).json({error:'Goal not found.'});
    const isPilot=goal.checkpoint.runtime==='codex-staging';
    const workerAvailable=isPilot?Boolean(goal.worker_available):null;
    // inbox performs the same fresh pilot/commercial admission. The polling
    // path needs only public progress, never the full native SDK journal.
    // Approval staging still uses its canonical transaction when necessary.
    const approvalInbox=isPilot&&!['COMPLETED','CANCELLED','BLOCKED'].includes(goal.status)
      ?await pilot.inbox(database,req.ctx,goal.id,{progress:true}):null;
    if(isPilot&&!approvalInbox)await pilot.access(database,req.ctx);
    if(approvalInbox)goal=approvalInbox.goal;
    const events=isPilot?(await database.query(`SELECT sequence,kind,detail,created_at FROM stockchief_runtime.assistant_goal_events
      WHERE goal_id=$1 AND kind IN ('agent_activity','approval_ready') ORDER BY sequence DESC LIMIT 20`,[goal.id])).rows:[];
    const navigation=agentNavigation.visible(goal);
    const state=require('../proposal-presentation').conversation(goal,approvalInbox?.approvals);
    const continuation=isPilot&&goal.status==='BLOCKED'?await pilot.continuation(database,req.ctx,goal.id):null;
    const safeEvents=events.map(e=>({sequence:e.sequence,kind:e.kind,created_at:e.created_at,
      detail:{kind:e.detail.kind,tool:typeof e.detail.tool==='string'?e.detail.tool:null,status:e.detail.kind==='runtime_starting'?e.detail.status:null}}));
    return res.json({id:goal.id,status:goal.status,answer:state.message,conversation:state,createdAt:goal.created_at,updatedAt:goal.updated_at,runStartedAt:goal.checkpoint.runStartedAt,turns:goal.turns,tools:goal.tool_calls,events:safeEvents,
      workerAvailable,continuation,approvalIds:(approvalInbox?.approvals||[]).map(card=>card.id),
      delivery:delivery.visible(goal),prerequisiteHandoffs:goal.checkpoint.prerequisiteHandoffs||[],navigation:navigation?{...navigation,automatic:req.session.postgresAskNavigationGoal===goal.id}:null});
  }));
  router.post('/ask/goals/:id/reply',asyncRoute(async(req,res)=>{
    const existing=await goalStore.get(database,req.ctx,req.params.id);
    if(existing?.checkpoint.runtime==='codex-staging')await pilot.access(database,req.ctx,{enabled:true});
    else if(!goalStore.enabled(req.ctx))throw new ValidationError('Adaptive Ask is disabled.');
    const goal=await goalStore.reply(database,req.ctx,req.params.id,req.body.message,{questionId:req.body.questionId||null});
    if(!goal)throw new ValidationError('This goal is not waiting for an answer.');
    if(!goal.replyReplayed)await goalStore.enqueue(database,goal);if(req.body.returnTo==='/needs-you'){req.flash('success','Your answer was saved. StockChief will continue the request.');return res.redirect(303,'/needs-you');}return res.redirect(303,'/ask');
  }));
  router.post('/ask/goals/:id/cancel',asyncRoute(async(req,res)=>{
    await goalStore.cancel(database,req.ctx,req.params.id);return res.redirect(303,'/ask');
  }));
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
  router.get('/ask/history',asyncRoute(async(req,res)=>{
    // Reading an owned saved request is independent of the current chat and
    // spending admission. Never stage approvals, resume or enqueue on a GET.
    res.set('Cache-Control','no-store');
    const history=require('../../assistant/postgres-goal-history');
    let selected=null;
    if(req.query.goal!==undefined){
      if(typeof req.query.goal!=='string'||req.query.goal.length>160)return res.sendStatus(404);
      const goal=await goalStore.get(database,req.ctx,req.query.goal);
      if(!goal)return res.sendStatus(404);
      const recorded=await history.effects(database,req.ctx,[goal.id]);
      const state=conversation.state(goal);
      selected={id:goal.id,request:goal.original_request,label:state.label,createdAt:goal.created_at,
        conversation:{...state,history:(state.history||[]).map(turn=>({...turn,text:conversation.publicText(turn.text)}))},
        delivery:delivery.visible(goal),effects:recorded.get(goal.id)||[],continuation:await pilot.continuation(database,req.ctx,goal.id)};
    }
    if(!selected&&!req.query.status&&!req.query.before)return res.page('attention/conversations',{title:'Your conversations',nav:'ask',requireLabels:history.labels,chats:await require('../../assistant/postgres-chats').list(database,req.ctx,{limit:100})});
    const saved=selected?null:await history.list(database,req.ctx,{before:req.query.before,status:req.query.status==='all'?'':req.query.status||''});
    return res.page('attention/ask-history',{title:'Saved requests',nav:'ask',room:true,selected,saved,
      labels:history.labels,renderAgentAnswer:require('../public/agent-answer').render});
  }));
  router.get('/ask',asyncRoute(async(req,res)=>{
    if(typeof req.query.fresh==='string'&&req.query.fresh.length<=80&&req.session.postgresAskPanelToken!==req.query.fresh){
      req.session.postgresAskStartedAt=(await database.query('SELECT clock_timestamp()::text AS started_at')).rows[0].started_at;req.session.postgresAskConversationId=newId('chat');req.session.postgresAskPanelToken=req.query.fresh;req.session.postgresAskNavigationGoal=null;delete req.session.askSubmission;
    }
    const remembered=req.session.postgresAskPageContext;
    const requestedPath=req.query.from===undefined&&remembered?.workspaceId===req.ctx.workspaceId
      ?remembered.path:req.query.from;
    if(typeof req.query.chat==='string'){const owned=await require('../../assistant/postgres-chats').owned(database,req.ctx,req.query.chat);req.session.postgresAskConversationId=req.query.chat;req.session.postgresAskStartedAt=new Date(new Date(owned.created_at).getTime()-1).toISOString();}
    else if(req.query.chat===undefined&&req.query.fresh===undefined&&typeof req.query.goal==='string'&&req.query.goal.length<=160){
      // A saved-request link explicitly selects that owned conversation.
      // Reading it never resumes work, approves a proposal or starts a goal.
      const selected=await goalStore.conversation(database,req.ctx,req.query.goal);
      if(selected){const chatId=selected.chat_id,owned=await require('../../assistant/postgres-chats').owned(database,req.ctx,chatId);
        req.session.postgresAskConversationId=chatId;req.session.postgresAskStartedAt=new Date(new Date(owned.created_at).getTime()-1).toISOString();}
    }
    if(!req.session.postgresAskConversationId)req.session.postgresAskConversationId=newId('chat');
    req.session.postgresAskChatBoundaries||={};req.session.postgresAskChatBoundaries[req.session.postgresAskConversationId]={workspaceId:req.ctx.workspaceId,actorId:req.ctx.actorId,startedAt:req.session.postgresAskStartedAt||null};for(const key of Object.keys(req.session.postgresAskChatBoundaries).slice(0,-100))delete req.session.postgresAskChatBoundaries[key];
    const startedAt=req.session.postgresAskStartedAt||null;
    const [sourcePage,interactions,nameRows,pilotView]=await Promise.all([
      require('../../assistant/postgres-page-context').load(database,req.ctx.workspaceId,requestedPath),
      assistant.listInteractions(database,req.ctx.workspaceId,500,{actorId:req.ctx.actorId,startedAt,conversationId:req.session.postgresAskConversationId||null}),
      database.query(`SELECT name FROM suppliers WHERE workspace_id=$1 AND name ~ '[0-9]{4,}'
        UNION SELECT name FROM customers WHERE workspace_id=$1 AND name ~ '[0-9]{4,}'
        UNION SELECT name FROM items WHERE workspace_id=$1 AND name ~ '[0-9]{4,}'
        UNION SELECT name FROM locations WHERE workspace_id=$1 AND name ~ '[0-9]{4,}'`,[req.ctx.workspaceId]),
      options.agentInspection?null:pilot.view(database,req.ctx)
    ]);
    if(req.query.from!==undefined)req.session.postgresAskPageContext=sourcePage
      ?{workspaceId:req.ctx.workspaceId,path:sourcePage.path}:null;
    const visible=interactions;const latest=visible.at(-1)||null;
    const emailBodyContinuation=latest?.status==='CLARIFY'
      &&latest.intent?.controlPlane?.capability==='communication.send_email'
      &&latest.intent?.presentation?.awaitingField==='body'
      ?{interactionId:latest.id,recipient:latest.intent.controlPlane.args?.recipient||'this contact'}:null;
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
    let transcript=transcriptFor(visible,proposals);
    const protectedNames=nameRows.rows.map(row=>row.name);
    const focusedGoalId=typeof req.query.goal==='string'&&req.query.goal.length<=160?req.query.goal:null;
    // The restricted renderer must show the actor's real native conversation,
    // even though it cannot select/enqueue the pilot or stage its approvals.
    // Hiding that history made recovery investigations search unrelated pages.
    // Paid execution eligibility and a Staging-only banner are not history
    // permissions. An actor's owned saved conversation remains readable in
    // commercial accounts, after disabling the pilot, and during rollback.
    let recentGoals=await goalStore.recent(database,req.ctx,startedAt,focusedGoalId,req.session.postgresAskConversationId||null);
    // An explicit link to owned earlier work must not silently select the
    // latest conversation. Keep the new chat boundary and open saved history.
    if(focusedGoalId&&!recentGoals.some(goal=>goal.id===focusedGoalId)
        &&await goalStore.get(database,req.ctx,focusedGoalId))
      return res.redirect(303,'/ask/history?goal='+encodeURIComponent(focusedGoalId));
    const hasActiveNative=recentGoals.some(goal=>goal.checkpoint.runtime==='codex-staging'&&!['COMPLETED','CANCELLED','BLOCKED'].includes(goal.status));
    const nativeServiceSelected=!options.agentInspection&&pilot.configured(req.ctx)
      &&Boolean(pilotView?.enabled||await pilot.selected(database,req.ctx).catch(error=>{if(error instanceof ValidationError)return false;throw error;}));
    const nativeInboxAvailable=hasActiveNative&&nativeServiceSelected;
    const canContinue=goal=>['COMPLETED','CANCELLED','BLOCKED'].includes(goal.status)||options.agentInspection
      ||(goal.checkpoint.runtime==='codex-staging'?nativeInboxAvailable:goalStore.enabled(req.ctx));
    // When execution is deliberately disabled, unfinished work is readable in
    // saved requests rather than exposed as a live composer that would fail.
    if(recentGoals.some(goal=>goal.id===focusedGoalId&&!canContinue(goal)))
      return res.redirect(303,'/ask/history?goal='+encodeURIComponent(focusedGoalId));
    recentGoals=recentGoals.filter(canContinue);
    const focusedGoal=recentGoals.find(goal=>goal.id===focusedGoalId);
    const activeGoal=focusedGoal||recentGoals.at(-1)||null;
    for(const goal of recentGoals){
      if(nativeInboxAvailable&&goal.checkpoint.runtime==='codex-staging'&&!['COMPLETED','CANCELLED','BLOCKED'].includes(goal.status)){
        const inbox=await pilot.inbox(database,req.ctx,goal.id);Object.assign(goal,inbox.goal);goal.approvalCards=inbox.approvals;
      }else goal.approvalCards=[];
      goal.conversation=require('../proposal-presentation').conversation(goal,goal.approvalCards);
      goal.continuation=!options.agentInspection&&goal.checkpoint.runtime==='codex-staging'&&goal.status==='BLOCKED'
        ?await pilot.continuation(database,req.ctx,goal.id):null;
    }
    const nativeRuleIds=new Set(recentGoals.flatMap(goal=>(goal.approvalCards||[]).filter(card=>card.kind==='rule').map(card=>card.proposalId)));
    // Conversation replies must come from these visible, actor-owned turns
    // and goals. A workspace-wide pending queue is not a chat transcript.
    // Global pending records retain their original canonical status/access.
    const visibleProposalIds=[...new Set([...visible.map(turn=>turn.intent?.proposalId),
      ...recentGoals.flatMap(goal=>Object.values(goal.checkpoint.harness?.approvalDeliveries||{}).map(card=>card.proposalId))].filter(id=>typeof id==='string'))];
    const rules=await instructionLists(database,req.ctx,visibleProposalIds);
    rules.pendingRules=rules.pendingRules.filter(rule=>!nativeRuleIds.has(rule.id));
    transcript=require('../../assistant/goal-transcript').mergeGoalTranscript(transcript,recentGoals,{focusedGoalId:focusedGoal?.id});
    const continuationGoal=focusedGoal||transcript.at(-1)?.agentGoal;
    const submission=req.session.askSubmission?.workspaceId===req.ctx.workspaceId?req.session.askSubmission:null;
    const recentRequests=await require('../../assistant/postgres-chats').list(database,req.ctx,{limit:10});
    return res.page('attention/ask',{recentRequests,title:'Ask StockChief',nav:'ask',room:true,suppressBack:true,postgresAsk:true,aiCost:require('../../commercial/ai-spending-limits').forAsk(await require('../../commercial/ai-spending-limits').availability(database,req.ctx.workspaceId,req.ctx.actorId)),...rules,
      codexPilot:pilotView,adaptiveGoal:activeGoal,agentInspection:Boolean(options.agentInspection),focusedGoalId:focusedGoal?.id||null,renderAgentAnswer:require('../public/agent-answer').render,
      about:String(req.query.about||'').slice(0,2000),stockActivity:req.query.task==='stock-activity'&&sourcePage?.path==='/inventory',
      question:submission?.draft||latest?.message||'',result:submission?null:resultFor(latest,latestProposal),error:submission?.message||null,submissionError:submission,
      autoSend:req.query.send==='1',prefill:String(req.query.q||'').slice(0,2000),
      conversation:null,transcript,currentGoalId:latest?.id||null,conversationId:`postgres:${req.ctx.workspaceId}`,currentChatId:req.session.postgresAskConversationId,currentChatContext:require('../../assistant/ask-chat-context').issue(options.conversationSecret,{workspaceId:req.ctx.workspaceId,actorId:req.ctx.actorId,sessionId:req.sessionID,chatId:req.session.postgresAskConversationId,startedAt:req.session.postgresAskStartedAt||null}),
      aiConfigured:Boolean(options.provider||config.ai.configured||nativeServiceSelected||options.agentInspection&&activeGoal?.checkpoint.runtime==='codex-staging'),usageKey:newId('askusage'),
      sourcePath:sourcePage?.path||null,emailBodyContinuation,protectedNames,
      continuationGoalId:continuationGoal?.status==='WAITING_USER'?continuationGoal.id:null,
      continuationQuestionId:continuationGoal?.conversation?.input?.id||null,
      examples:await askExamples(database,req.ctx,sourcePage)});
  }));
  router.post('/ask/new',asyncRoute(async(req,res)=>{
    // Use the database clock that timestamps interactions, then persist the
    // boundary before redirecting so the next GET cannot resurrect old turns.
    const boundary=(await database.query('SELECT clock_timestamp()::text AS started_at')).rows[0].started_at;
    req.session.postgresAskStartedAt=boundary;req.session.postgresAskConversationId=newId('chat');
    delete req.session.askSubmission;
    req.session.postgresAskPageContext=null;
    req.session.postgresAskNavigationGoal=null;
    req.flash('success','New conversation started. Earlier conversations remain in the audit history.');
    await new Promise((resolve,reject)=>req.session.save((error)=>error?reject(error):resolve()));
    return res.redirect(303,'/ask');
  }));
  async function runAsk(req){
    if(req.body.chatId){const id=String(req.body.chatId),saved=req.session.postgresAskChatBoundaries?.[id];let boundary;if(req.body.chatContext){boundary=require('../../assistant/ask-chat-context').verify(options.conversationSecret,req.body.chatContext,{workspaceId:req.ctx.workspaceId,actorId:req.ctx.actorId,sessionId:req.sessionID,chatId:id}).startedAt;}else if(saved?.workspaceId===req.ctx.workspaceId&&saved.actorId===req.ctx.actorId)boundary=saved.startedAt;else {const owned=await require('../../assistant/postgres-chats').owned(database,req.ctx,id);boundary=new Date(new Date(owned.created_at).getTime()-1).toISOString();}req.session.postgresAskConversationId=id;req.session.postgresAskStartedAt=boundary;}

    if(!req.session.postgresAskConversationId)req.session.postgresAskConversationId=newId('chat');
    const scope=commercialScope(req);await entitlements.assertCapability(database,scope,'ask.lookup');
    const files=(req.files||[]).filter((entry)=>entry.field==='file'&&entry.size>0);
    if(files.length){
      if(files.length!==1)throw new ValidationError('Attach one inventory file at a time so its preview can be checked.');
      const file=files[0];
      if(!/\.(csv|tsv|txt|xlsx|ods|docx|json|xml|pdf|png|jpe?g|webp|gif|heic|heif|tiff?)$/i.test(file.filename||''))
        throw new ValidationError('Ask can preview inventory tables in CSV, TSV, XLSX, PDF, PNG or JPEG. This file type was not imported.');
      await entitlements.assertCapability(database,scope,'imports.spreadsheet');
      const hash=crypto.createHash('sha256').update(file.buffer).digest('hex');
      const plan=await imports.analyse(database,req.ctx,{buffer:file.buffer,filename:file.filename,
        provider:options.provider,sourceContext:req.body.message,allowModel:!await pilot.selected(database,req.ctx),
        usageKey:require('../../imports/usage-key').analysisUsageKey(hash,req.body.usageKey)});
      return {navigation:{href:`/imports/${plan.id}`}};
    }
    if(require('../../assistant/direct-business-reads').standalone(req.body.message)){req.body.continueGoalId='';req.body.continueInteractionId='';}
    if(req.body.continueGoalId){
      const id=String(req.body.continueGoalId),existing=await goalStore.get(database,req.ctx,id);
      if(existing?.checkpoint.runtime!=='codex-staging')throw new ValidationError('That agent question is no longer available.');
      await pilot.access(database,req.ctx,{enabled:true});
      if(req.session.postgresAskStartedAt&&new Date(existing.created_at)<=new Date(req.session.postgresAskStartedAt))
        throw new ValidationError('That question belongs to an earlier conversation.');
      const continued=await goalStore.reply(database,req.ctx,id,req.body.message,{questionId:req.body.questionId||null});
      if(!continued)throw new ValidationError('That request is no longer waiting for an answer.');
      if(!continued.replyReplayed)await goalStore.enqueue(database,continued);req.session.postgresAskNavigationGoal=id;
      return {goalId:id};
    }
    if(req.body.sourceGoalId){
      const source=await deliveredGoal(req,String(req.body.sourceGoalId));
      return continueWork(req,source,delivery.visible(source),req.body.message);
    }
    const remembered=req.session.postgresAskPageContext;
    const page=await require('../../assistant/postgres-page-context').load(database,req.ctx.workspaceId,
      req.body.sourcePath||(remembered?.workspaceId===req.ctx.workspaceId?remembered.path:null));
    const result=await assistant.ask(database,req.ctx,req.body.message,{provider:options.provider,
      // The native pilot always enqueues its own durable job. Runtime selection
      // and its fresh permission check belong to assistant.ask, once here.
      background:goalStore.enabled(req.ctx),
      usageKey:String(req.body.usageKey||newId('askusage')),
      page,conversationId:req.session.postgresAskConversationId,startedAt:req.session.postgresAskStartedAt||null,
      newRequest:require('../../assistant/direct-business-reads').standalone(req.body.message),continueInteractionId:String(req.body.continueInteractionId||'')});
    req.session.postgresAskNavigationGoal=result.goalId||null;
    return result;
  }
  async function submitAsk(req){
    try{
      const result=await runAsk(req);delete req.session.askSubmission;return result;
    }catch(error){
      if(!['validation_error','rate_limited','entitlement_required'].includes(error.code))throw error;
      req.session.askSubmission={workspaceId:req.ctx.workspaceId,draft:String(req.body.message||'').slice(0,12000),
        message:error.code==='rate_limited'?'Ask has reached its current usage limit. Your message has not run; it is kept below for later.':error.message};
      return null;
    }
  }
  router.post('/ask',asyncRoute(async(req,res)=>{
    const result=await submitAsk(req);
    if(!result)return res.redirect(303,'/ask#submission-problem');
    if(req.get('accept')?.includes('application/json'))return res.json({destination:result.navigation?.href||(result.goalId?'/ask?chat='+encodeURIComponent(req.session.postgresAskConversationId)+'&goal='+encodeURIComponent(result.goalId)+'#focused-goal':'/ask?chat='+encodeURIComponent(req.session.postgresAskConversationId)+'#latest'),navigation:Boolean(result.navigation),interactionId:result.interactionId||null});
    return res.redirect(303,result.navigation?.href||(result.goalId?'/ask?chat='+encodeURIComponent(req.session.postgresAskConversationId)+'&goal='+encodeURIComponent(result.goalId)+'#focused-goal':'/ask?chat='+encodeURIComponent(req.session.postgresAskConversationId)+'#latest'));
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
    const result=await submitAsk(req);
    if(!result)return res.redirect(303,'/ask#submission-problem');
    if(req.get('accept')?.includes('application/json'))return res.json({destination:result.navigation?.href||(result.goalId?'/ask?chat='+encodeURIComponent(req.session.postgresAskConversationId)+'&goal='+encodeURIComponent(result.goalId)+'#focused-goal':'/ask?chat='+encodeURIComponent(req.session.postgresAskConversationId)+'#latest'),navigation:Boolean(result.navigation),interactionId:result.interactionId||null});
    return res.redirect(303,result.navigation?.href||(result.goalId?'/ask?chat='+encodeURIComponent(req.session.postgresAskConversationId)+'&goal='+encodeURIComponent(result.goalId)+'#focused-goal':'/ask?chat='+encodeURIComponent(req.session.postgresAskConversationId)+'#latest'));
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
    const present=(proposal)=>({proposalId:proposal.id,oneLine:require('../proposal-presentation').summary(proposal),
      safetyLevel:/payment|purchase|send_email/.test(proposal.action_type)?'HIGH':'MEDIUM',impactLabel:require('../proposal-presentation').impact(proposal.action_type),sourceType:'ASK',
      status:proposal.status==='EXECUTED'?'SUCCEEDED':proposal.status,rows:[],warnings:[],
      createdAt:proposal.created_at,completedAt:proposal.executed_at||proposal.cancelled_at||null,unverified:false});
    return res.page('actions/list',{title:'StockChief actions',nav:'actions',pending:rows.filter((row)=>row.status==='PENDING').map(present),
      recent:rows.filter((row)=>row.status!=='PENDING').map(present),canOperate:permissions.can(req.user,permissions.OPERATE),
      missionMetrics:await require('../../assistant/postgres-capability-plans').metricsSummary(database,req.ctx.workspaceId),
      aiConfigured:Boolean(options.provider||config.ai.configured),instruction:String(req.query.q||'').slice(0,500),
      examples:await askExamples(database,req.ctx),question:null,unsupported:null,assistantGoal:null,where:null,
      blocked:null,physicalEventId:null,choices:null,continuationId:null,questionTone:null});
  }));
  async function revisePrepared(req,res,kind){const text=String(req.body.message||'').trim();if(!text||text.length>10000)throw new ValidationError('Describe the revised request in at most 10,000 characters.');const rule=kind==='rule',p=rule?await require('../../manager/postgres-operating-instructions').get(database,req.ctx.workspaceId,req.params.id):await assistant.getProposal(database,req.ctx.workspaceId,req.params.id);if(p.status!=='PENDING')throw new ValidationError('Only a change still awaiting approval can be revised.');const owner=rule?p.createdByUserId||p.created_by_user_id:p.actor_user_id;if(owner&&owner!==req.ctx.actorId)throw new ValidationError('This prepared request belongs to another member.');const mission=rule?null:await require('../../assistant/postgres-capability-plans').missionForProposal(database,req.ctx.workspaceId,req.ctx.actorId,p.id);if(mission?.approval_status==='APPROVED')throw new ValidationError('This request is part of an approved workflow. Review that workflow before changing its remaining steps.');const native=await require('../../assistant/postgres-native-proposal').find(database,req.ctx,p.id);if(native){await pilot.decide(database,req.ctx,native.id,native.delivery_id,native.card.sha256,false,{responseReference:'Owner requested a revision from its exact review page.',stopOnReject:true});}else if(rule)await require('../../manager/postgres-operating-instructions').cancel(database,req.ctx,p.id);else await assistant.cancelProposal(database,req.ctx,p.id);const recordPath=(rule?'/operating-instructions/':'/actions/')+encodeURIComponent(p.id);const result=await assistant.ask(database,req.ctx,'Prepare a replacement for the withdrawn request at '+recordPath+'. Revised request: '+text,{provider:options.provider,background:true,usageKey:newId('revision'),conversationId:req.session.postgresAskConversationId,startedAt:req.session.postgresAskStartedAt||null});req.session.postgresAskNavigationGoal=result.goalId||null;return res.redirect(303,result.goalId?'/ask?goal='+encodeURIComponent(result.goalId)+'#focused-goal':'/ask');}
  router.post('/actions/:id/revise',asyncRoute((req,res)=>revisePrepared(req,res,'business')));
  router.post('/operating-instructions/:id/revise',asyncRoute((req,res)=>revisePrepared(req,res,'rule')));
  router.get('/actions/:id',asyncRoute(async(req,res)=>{
    const proposal=await assistant.getProposal(database,req.ctx.workspaceId,req.params.id);
    const mission=await require('../../assistant/postgres-capability-plans').missionForProposal(
      database,req.ctx.workspaceId,req.ctx.actorId,proposal.id);
    const resuming=(await database.query(`SELECT 1 FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 AND actor_user_id=$2 AND status='ADVANCING'
        AND steps @> $3::jsonb LIMIT 1`,[req.ctx.workspaceId,req.ctx.actorId,
      JSON.stringify([{proposalId:proposal.id}])])).rows.length>0;
    const native=(await database.query(`SELECT id,status,expires_at,checkpoint FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2
      AND checkpoint->>'runtime'='codex-staging' AND EXISTS(SELECT 1 FROM jsonb_each(COALESCE(checkpoint#>'{harness,approvalDeliveries}','{}'::jsonb)) d WHERE d.value->>'proposalId'=$3) LIMIT 1`,[req.ctx.workspaceId,req.ctx.actorId,proposal.id])).rows[0];
    const nativeCard=native&&!['COMPLETED','CANCELLED','BLOCKED'].includes(native.status)?(await pilot.inbox(database,req.ctx,native.id)).approvals.find(card=>card.proposalId===proposal.id):null;
    const approvedDelivery=native&&proposal.status==='EXECUTED'&&native.status!=='CANCELLED'&&new Date(native.expires_at)>new Date()
      &&mission?.approval_status==='APPROVED'&&['ADVANCING','BLOCKED'].includes(mission.status)
      ?Object.values(native.checkpoint?.harness?.approvalDeliveries||{}).find(d=>d.proposalId===proposal.id
        &&d.decision?.source==='human_user'&&d.decision.approved===true&&d.decision.scope?.kind==='mission'
        &&d.decision.scope.id===mission.id&&d.decision.scope.sha256===mission.plan_hash):null;
    return res.page('attention/postgres-proposal',{title:mission?'Review operating mission':'Review prepared change',nav:'ask',editProposal:req.query.edit==='1',proposal,presentation:require('../proposal-presentation').present(proposal),mission,nativeApproval:nativeCard?{goalId:native.id,...nativeCard}:null,
      nativeResume:approvedDelivery?{goalId:native.id,id:approvedDelivery.id,sha256:approvedDelivery.sha256}:null,
      missionSteps:(mission?.approved_steps||[]).map((step,index)=>{const contract=capabilities.get(step.capability);return {label:(contract?.legacyAction||step.capability).replace(/[._]/g,' ').replace(/^./,s=>s.toUpperCase()),args:step.args,fields:require('../proposal-presentation').fields(step.args),index:index+1,state:mission.steps[index]?.state||'BLOCKED'};}),
      resumeAvailable:proposal.status==='EXECUTED'&&resuming&&!native});
  }));
  router.post('/actions/:id/approve-mission',asyncRoute(async(req,res)=>{
    if(await pilotProposalGuard(req,res))return;
    await entitlements.assertCapability(database,commercialScope(req),'ask.prepare_actions');
    if(!req.body.missionHash)throw new ValidationError('Review the full prepared mission before approving.');
    const result=await assistant.executeMission(database,req.ctx,req.params.id,{provider:options.provider,missionApproval:{expectedHash:String(req.body.missionHash)}});
    if(result.continuationError)req.flash('error',
      'The first verified step completed, but the mission stopped safely before further work. Review the recorded reason.');
    else req.flash('success',result.continued?.some((part)=>part.status==='PREPARED')
      ?'Mission approved. StockChief completed every currently authorized step and is waiting only where evidence is required.'
      :'Mission approved and completed without another approval.');
    return res.redirect(303,'/ask#latest');
  }));
  router.post('/actions/:id/approve',asyncRoute(async(req,res)=>{
    if(await pilotProposalGuard(req,res))return;
    await entitlements.assertCapability(database,commercialScope(req),'ask.prepare_actions');
    const result=await assistant.executeProposal(database,req.ctx,req.params.id,{provider:options.provider});
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
    if(await pilotProposalGuard(req,res))return;
    const proposal=await assistant.getProposal(database,req.ctx.workspaceId,req.params.id);
    if(proposal.status!=='EXECUTED')throw new (require('../../domain/errors').ValidationError)(
      'Approve the prepared change before continuing its dependent steps.');
    const result=await assistant.executeProposal(database,req.ctx,proposal.id,{provider:options.provider});
    req.flash(result.continuationError?'error':'success',result.continuationError
      ?'The completed change is safe, but the remaining steps still need another try.'
      :'StockChief continued the remaining request from the completed step.');
    const opened=result.continued?.findLast((part)=>part.navigation?.href)?.navigation;
    if(opened?.href?.startsWith('/')&&!opened.href.startsWith('//'))return res.redirect(303,opened.href);
    return res.redirect(303,result.continued?.length?'/ask#latest':`/actions/${proposal.id}`);
  }));
  // Agent protocol/adapter exceptions are diagnostics, not conversation text.
  // Apply this to both the composer and goal endpoints (including polling).
  router.use((error,req,res,next)=>{
    if(!req.path.startsWith('/ask/goals/')&&!['/ask','/foundry/tell'].includes(req.path))return next(error);
    const expected=error instanceof require('../../domain/errors').DomainError;
    const message=expected?conversation.publicText(error.message,'This request cannot continue. Reload Ask to check its current state.'):
      'StockChief could not continue this step. Your conversation is saved; reload Ask to check its current state.';
    if(!expected)console.error('[stockchief agent lifecycle]',error.code||error.name||'Error');
    if(req.method==='GET'&&req.path==='/ask'&&!req.xhr&&req.accepts('html')){
      const status=expected?error.status||400:500;res.status(status);
      return res.page('error',{title:'Ask StockChief needs another try',status,message,detail:null});
    }
    if(req.method==='POST'&&req.session&&!req.xhr&&req.accepts('html')){req.flash('error',message);return res.redirect(303,'/ask#latest');}
    return res.status(expected?error.status||400:500).json({error:{code:'conversation_unavailable',message}});
  });
  return router;
}

module.exports={createPostgresAskRouter};
