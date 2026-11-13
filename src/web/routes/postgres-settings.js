'use strict';

const express=require('express');
const permissions=require('../../actions/permissions');
const autopilot=require('../../autopilot/postgres-service');
const connections=require('../../connections/postgres-service');
const operatingInstructions=require('../../manager/postgres-operating-instructions');
const entitlements=require('../../entitlements/postgres-service');
const commercialControl=require('../../commercial/control-service');
const passwordAuth=require('../../domain/auth-service');
const accountLifecycle=require('../../domain/postgres-account-lifecycle');
const {ROLE_IDS}=require('../../domain/constants');
const config=require('../../config');
const { requireAuth,requireOwner,asyncRoute }=require('../middleware');
const { ValidationError }=require('../../domain/errors');
const {newId,nowIso}=require('../../lib/util');

function instructionFrom(row){return {id:row.id,statedAs:row.stated_as,summary:row.summary,status:row.status,approvalHistory:true,linkLabel:'Review',
  approvedAt:row.approved_at,createdAt:row.created_at,href:`/operating-instructions/${row.id}`};}

function authorityFrom(policy){return {id:policy.id,name:policy.name,description:policy.description,
  allowedActionTypes:policy.actions,maximumValue:policy.maximumValue,dailyLimit:policy.dailyLimit,
  enabled:policy.enabled,isApproved:Boolean(policy.approvedAt),href:'/autopilot'};}

function connectionFrom(row){return {id:row.id,name:row.display_name||row.provider_type,
  doing:row.provides.length?row.provides.join(', ').replaceAll('_',' '):'connected, and not carrying anything yet',
  state:row.publicStatus==='Connected'?'healthy':row.publicStatus==='Needs attention'?'needs you':'disconnected',
  healthy:row.publicStatus==='Connected'};}

const sections=[
  {title:'Customer orders',why:'An order is one story, and it is the page. These are the working surfaces underneath it.',links:[
    {href:'/orders',label:'All customer orders'},{href:'/orders/new',label:'Write an order'},
    {href:'/fulfilment',label:'Picking and packing queue'},{href:'/sales/customers/new',label:'Add a customer'},
    {href:'/sales/pricing',label:'Pricing and promotions'}]},
  {title:'Buying and suppliers',why:'A purchase is one story too. StockChief prepares these; the queue is here for when you want to work through them yourself.',links:[
    {href:'/purchasing',label:'What needs buying'},{href:'/purchasing/orders',label:'All purchase orders'},
    {href:'/purchasing/orders/new',label:'Write a purchase order'},{href:'/purchasing/receive',label:'Book in a delivery'},
    {href:'/suppliers',label:'Suppliers and their terms'},{href:'/purchasing/setup',label:'Reorder points and targets'}]},
  {title:'Stock, in detail',why:'What you hold answers the question in six lines. This is the database underneath it, for when six lines is not enough.',links:[
    {href:'/inventory/table',label:'Full stock table'},{href:'/inventory/new',label:'Add a product'},
    {href:'/locations',label:'Locations'},{href:'/warehouse',label:'Warehouse tasks and scanning'},
    {href:'/transfers',label:'Transfers and in-transit stock'},{href:'/planning',label:'What StockChief expects to go wrong'},
    {href:'/pricing/new',label:'Change selling prices'},{href:'/imports',label:'File imports and results'}]},
  {title:'Books and accounting',why:'Money says how the business is doing. This is the ledger, for your accountant — you should not be operating it during ordinary work.',links:[
    {href:'/accounting/books',label:'Books dashboard'},{href:'/accounting/transactions',label:'Every transaction'},
    {href:'/accounting/chart',label:'Chart of accounts'},{href:'/accounting/receivables',label:'What customers owe'},
    {href:'/accounting/payables',label:'What you owe'},{href:'/accounting/banking',label:'Banking and reconciliation'},
    {href:'/accounting/periods',label:'Closing a period'},{href:'/accounting/tax',label:'Tax rates'},
    {href:'/reports',label:'Custom reports and scheduled delivery'},
    {href:'/accounting/reports/profit-and-loss',label:'Profit and loss'},
    {href:'/accounting/reports/balance-sheet',label:'Balance sheet'}]},
  {title:'Messages',why:'StockChief is not an email client. Supplier mail lives on the purchase, customer mail on the order, and anything waiting on a reply is on the desk. This is the whole mailbox, for when you want to look through it.',links:[
    {href:'/mail',label:'All conversations'},{href:'/activity',label:'Recent operational activity'}]},
  {title:'What StockChief may do on its own',why:'Authority is two choices: ask me first, or handle routine work inside limits you approve. The exact limits are here.',links:[
    {href:'/autopilot',label:'Standing authority'},{href:'/autopilot',label:'Limits and preferences'},
    {href:'/autopilot/history',label:'Everything it did on its own'},{href:'/actions',label:'Changes prepared for approval'},
    {href:'/repairs',label:'Governed repairs'}]},
  {title:'Connections',why:'Mailbox, shop, payments and carrier. Mapping and credentials are technical, so they sit inside each connection rather than on the main path.',links:[
    {href:'/settings/connections',label:'All connections'},{href:'/settings/shipping',label:'Shipping and carriers'}]},
  {title:'This inventory',why:'Set once, changed rarely.',links:[
    {href:'/search',label:'Search every record'},{href:'/settings',label:'Settings, people and plan'},
    {href:'/what-you-told-me',label:'How this inventory is configured'},{href:'/inventories',label:'Your other inventories'},
    {href:'/settings/export',label:'Export this inventory'},{href:'/audit',label:'Audit trail'},{href:'/guide',label:'How to use StockChief'},
    {href:'/support',label:'Support'}]},
];


async function summary(database,workspaceId){const result=await database.query(`SELECT
  (SELECT COUNT(*) FROM items WHERE workspace_id=$1 AND is_active=1) AS products,
  (SELECT COUNT(*) FROM skus WHERE workspace_id=$1 AND is_active=1) AS skus,
  (SELECT COUNT(*) FROM locations WHERE workspace_id=$1 AND is_active=1) AS locations,
  (SELECT COUNT(*) FROM users WHERE workspace_id=$1) AS people,
  (SELECT COUNT(*) FROM workspace_connectors WHERE workspace_id=$1 AND status<>'disconnected') AS connections`,[workspaceId]);
  return Object.fromEntries(Object.entries(result.rows[0]).map(([key,value])=>[key,Number(value)]));}

async function emailAlertState(database,workspaceId){const [row,owners]=await Promise.all([
  database.query('SELECT * FROM notification_email_settings WHERE workspace_id=$1',[workspaceId]),
  database.query(`SELECT account.email FROM users member JOIN accounts account ON account.id=member.account_id
    WHERE member.workspace_id=$1 AND member.role='owner' ORDER BY member.created_at`,[workspaceId])]);
  const stored=row.rows[0];let recipients=[];try{recipients=JSON.parse(stored?.recipients||'[]');}catch{recipients=[];}
  if(!recipients.length)recipients=owners.rows.map((owner)=>owner.email);
  return {enabled:Boolean(Number(stored?.enabled||0)),minimumSeverity:stored?.minimum_severity||'important',recipients,
    deliveryConfigured:config.email.configured,updatedAt:stored?.updated_at||null};}

async function settingsPage(database,req,res){const [counts,users,instructions,emailAlerts,feedRows,events]=await Promise.all([
  summary(database,req.ctx.workspaceId),database.query(`SELECT member.id,member.name,member.role,member.custom_role_id,member.po_approval_limit_minor,member.po_approval_currency,member.access_revision,member.warehouse_location_ids,account.email
    FROM users member JOIN accounts account ON account.id=member.account_id WHERE member.workspace_id=$1
    ORDER BY CASE member.role WHEN 'owner' THEN 0 ELSE 1 END,lower(member.name)`,[req.ctx.workspaceId]),
  database.query(`SELECT id,stated_as,status FROM operating_instruction_proposals
    WHERE workspace_id=$1 AND status IN ('APPROVED','REMOVED','SUPERSEDED') ORDER BY created_at DESC`,[req.ctx.workspaceId]),
  emailAlertState(database,req.ctx.workspaceId),database.query(`SELECT connector.* FROM workspace_connectors connector
    WHERE workspace_id=$1 AND provider_type='reference_webhook' ORDER BY updated_at DESC LIMIT 1`,[req.ctx.workspaceId]),
  database.query(`SELECT external_event_id,event_type,status,error_message,processed_at FROM connector_feed_events
    WHERE workspace_id=$1 ORDER BY received_at DESC LIMIT 6`,[req.ctx.workspaceId])]);
  const commercialMeters=await Promise.all(['workspaces','members','locations','connections'].map(meter=>require('../../commercial/entitlements').meterState(database,{accountId:req.workspace.owner_account_id,workspaceId:req.ctx.workspaceId},meter,{subscription:res.locals.commercial?.subscription})));
  const integrity=require('../../operations/postgres-integrity-check').current(database,req.ctx.workspaceId);
  const feed=feedRows.rows[0]||null;const problems=Object.entries(integrity.result||{}).filter(([key,value])=>key!=='ok'&&Number(value)>0)
    .map(([kind,value])=>({kind:kind.replaceAll('_',' '),detail:`${value} record${Number(value)===1?'':'s'} do not reconcile.`}));
  const companyProfile=!req.query.section||req.query.section==='general'?await require('../../operations/postgres-company-profile').get(database,req.ctx.workspaceId):null;
  const newFeedToken=req.session.newFeedToken||null;delete req.session.newFeedToken;
  return res.page('settings',{searchableSettingsSections:require('../presentation/search-pages').settingsSections,settingsSectionHashes:require('../presentation/navigation').settingsSectionHashes,title:'Settings',nav:'settings',room:true,postgresMode:true,settingsSection:['general','team','notifications','ai','data','advanced'].includes(req.query.section)?req.query.section:'general',users:users.rows,customRoles:req.query.section==='team'?await require('../../operations/postgres-team-access').list(database,req.ctx.workspaceId):[],teamWarehouses:req.query.section==='team'?(await database.query("SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND kind IN ('warehouse','store') AND parent_location_id IS NULL AND custody_agreement_id IS NULL ORDER BY name,id",[req.ctx.workspaceId])).rows:[],teamPermissionLabels:permissions.LABELS,teamMoney:require('../../domain/currency'),pendingInvitations:(await database.query("SELECT id,name,email,role,expires_at FROM workspace_invitations WHERE workspace_id=$1 AND status='PENDING' AND expires_at>now() ORDER BY created_at",[req.ctx.workspaceId])).rows,workspace:req.workspace,
    companyProfile,integrity:{...integrity,ok:integrity.result?.ok,problems},eventFeed:{configured:Boolean(feed),connected:feed?.status==='connected',
      recentEvents:events.rows.map((event)=>({eventId:event.external_event_id,type:event.event_type,status:event.status,
        error:event.error_message,processedAt:event.processed_at}))},newFeedToken,learnedInstructions:instructions.rows.map(instructionFrom),
    stockGuards:[],emailAlerts,aiUsage:null,answerPreferences:await require('../../assistant/postgres-answer-preferences').read(database,req.ctx),recordAliases:permissions.can(req.user,permissions.ADMIN)?await require('../../assistant/postgres-record-aliases').list(database,req.ctx):[],aiCost:await require('../../commercial/ai-spending-limits').availability(database,req.ctx.workspaceId,req.ctx.actorId),commercialLimitsPooled:true,entitlements:{plan:{label:res.locals.commercial?.subscription?.plan_name||
      (res.locals.commercial?.access?.mode==='DEVELOPMENT'?'Pre-subscription · unlimited':'No paid plan')},
      limits:commercialMeters
        .map((meter)=>({key:meter.meter,used:meter.used,limit:meter.hardLimit??meter.included,
          unlimited:meter.hardLimit===null&&meter.included===null}))}});}

function createPostgresSettingsRouter(database,options={}){const router=express.Router();
  router.get('/audit',requireAuth,requireOwner,asyncRoute(async(req,res)=>{const audit=await require('../../operations/postgres-audit').page(database,req.ctx.workspaceId,req.query),users=(await database.query('SELECT id,name FROM users WHERE workspace_id=$1 ORDER BY name,id',[req.ctx.workspaceId])).rows;return res.page('activity/audit',{title:'Audit trail',nav:'history',...audit,users});}));
  router.get('/audit/export',requireAuth,requireOwner,asyncRoute((req,res)=>require('../../operations/postgres-audit').download(database,req.ctx.workspaceId,res,req.query)));
  router.get('/what-you-told-me',requireAuth,asyncRoute(async(req,res)=>{const [instructionRows,policies,connectorRows]=await Promise.all([
    database.query(`SELECT id,stated_as,summary,status,approved_at,created_at FROM operating_instruction_proposals
      WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC`,[req.ctx.workspaceId]),
    autopilot.listPolicies(database,req.ctx.workspaceId),connections.list(database,req.ctx.workspaceId)]);
    return res.page('settings/told',{title:"What you've told me",nav:'settings',room:true,
      rules:instructionRows.rows.map(instructionFrom),policies:policies.map(authorityFrom),
      connections:connectorRows.map(connectionFrom),preferences:[]});
  }));
  router.get('/everything',requireAuth,asyncRoute(async(req,res)=>res.page('settings/everything',{
    title:'Everything else',nav:'settings',room:true,sections,
  })));
  router.get('/settings',requireAuth,asyncRoute(async(req,res)=>settingsPage(database,req,res)));
  router.post('/settings/ask-preferences',requireOwner,asyncRoute(async(req,res)=>{await require('../../assistant/postgres-answer-preferences').save(database,req.ctx,req.body);req.flash('success','Ask language, style and business time zone saved. Historical accounting corrections are reviewed separately.');return res.redirect(303,'/settings?section=ai#ask-preferences');}));
  router.post('/settings/ai-spending',requireOwner,asyncRoute(async(req,res)=>{await require('../../commercial/ai-spending-limits').save(database,req.ctx,req.body);req.flash('success','Your AI spending limits were saved for this billing period. Credits, provider prices and separate request, goal and test-authority guards were not changed.');return res.redirect(303,'/settings?section=advanced#ai-spending');}));
  router.post('/settings/integrity/check',requireAuth,asyncRoute(async(req,res)=>{
    res.set('Cache-Control','no-store');return res.json(await require('../../operations/postgres-integrity-check').run(database,req.ctx.workspaceId));
  }));
  router.post('/settings/time-zone',requireAuth,asyncRoute(async(req,res)=>{const zone=require('../../lib/business-time').zone(req.body.timeZone);await database.query('UPDATE accounts SET time_zone=$2 WHERE id=$1',[req.account.id,zone]);req.flash('success','Your time zone was saved. Dates and activity times now use this preference across your inventories.');return res.redirect(303,'/settings');}));
  router.post('/settings/test-inventory',requireOwner,asyncRoute(async(req,res)=>{
    const created=await require('../../domain/postgres-auth-service').createWorkspace(database,req.account.id,
      {name:req.body.name,dataMode:'synthetic'});
    req.session.workspaceId=created.workspaceId;
    req.flash('success','Separate test inventory created. Its records will not mix with your real inventory.');
    await new Promise((resolve,reject)=>req.session.save((error)=>error?reject(error):resolve()));
    return res.redirect(303,'/onboarding');
  }));
  router.get('/operating-instructions/:id',requireAuth,asyncRoute(async(req,res)=>{const proposal=await operatingInstructions.get(
    database,req.ctx.workspaceId,req.params.id);
    if(proposal.sopSource){
      if(req.user.role!=='owner')throw new (require('../../domain/errors').AuthorizationError)('Only the inventory owner can review a private procedure clause.');
      const state=await require('../../commercial/agent-plan').accountState(database,req.ctx.workspaceId);
      const policy=require('../../commercial/agent-plan'),included=policy.permits(state.plan,212,'draft');
      if(!included||!policy.usesAgentTerms(state))return res.page('autopilot/agent-plan-locked',{
        title:'Procedure settings',nav:'autopilot',tier:'Pro',reviewTerms:included,
        backTo:{href:'/autopilot/procedure-originals',label:'Procedure originals'}
      });
    }
    const fromAsk=req.query.from==='ask';const nativeGoal=await require('../../assistant/postgres-native-proposal').find(database,req.ctx,req.params.id);const notificationLog=proposal.resolvedChanges.some(c=>c.notificationChannel==='email')?(await database.query(`SELECT d.configuration_hash,r.notification_settings,d.status,d.last_error,d.created_at,d.communication_kind,d.communication_id,coalesce(s.status,c.status) AS message_status,coalesce(s.sent_at,c.sent_at) AS sent_at FROM stockchief_runtime.stock_threshold_deliveries d JOIN stockchief_runtime.stock_threshold_rules r ON r.workspace_id=d.workspace_id AND r.id=d.rule_id LEFT JOIN supplier_communications s ON s.workspace_id=d.workspace_id AND s.id=d.communication_id AND d.communication_kind='supplier' LEFT JOIN customer_communications c ON c.workspace_id=d.workspace_id AND c.id=d.communication_id AND d.communication_kind='customer' WHERE d.workspace_id=$1 AND r.notification_settings->>'approvalId'=$2 ORDER BY d.created_at DESC LIMIT 30`,[req.ctx.workspaceId,proposal.id])).rows.filter(d=>d.configuration_hash===require('../../pricing/postgres-promotions').hash(d.notification_settings)):[];return res.page('settings/postgres-operating-instruction',{
      title:'Review standing instruction',nav:'settings',room:true,
      backTo:proposal.sopSource?{href:'/autopilot/procedure-originals/'+proposal.sopSource.sourceId,label:'Procedure original'}:
        fromAsk?{href:'/ask#latest',label:'Ask StockChief'}:{href:'/what-you-told-me',label:"What you've told me"},
      fromAsk,proposal,nativeGoal,notificationLog,editProposal:req.query.edit==='1',
      // Job 210: a new rule is replayed on past records before it is switched on.
      ruleTest:proposal.status==='PENDING'&&!proposal.questions.length&&!proposal.sopSource?await require('../../autopilot/rule-rehearsal').instruction(database,req.ctx,proposal):null,descriptions:proposal.resolvedChanges.map(operatingInstructions.describe),usageKey:newId('instructionusage')});}));
  router.post('/operating-instructions/:id/answer',requireOwner,asyncRoute(async(req,res)=>{
    const native=await require('../../assistant/postgres-native-proposal').find(database,req.ctx,req.params.id);
    if(native){req.flash('success','Continue this instruction in Ask so its original goal and approvals stay together.');return res.redirect(303,'/ask?goal='+encodeURIComponent(native.id)+'#focused-goal');}
    const scope={accountId:req.workspace.owner_account_id,workspaceId:req.ctx.workspaceId};
    await entitlements.assertCapability(database,scope,'ask.prepare_actions');
    const replacement=await operatingInstructions.answer(database,req.ctx,req.params.id,req.body.answer,
      {provider:options.provider,instructionUsageKey:String(req.body.usageKey||newId('instructionusage'))});
    req.flash('success','The same instruction was read again with your answer.');
    return res.redirect(303,`/operating-instructions/${replacement.id}${req.body.fromAsk==='1'?'?from=ask':''}`);}));
  router.post('/operating-instructions/:id/approve',requireOwner,asyncRoute(async(req,res)=>{
    // Job 210: the past-data test the owner saw is kept with the switch-on.
    const pending=await operatingInstructions.get(database,req.ctx.workspaceId,req.params.id);
    if(pending.status==='PENDING'&&pending.integrityHash===req.body.integrityHash){
      const rehearsal=require('../../autopilot/rule-rehearsal'),tested=await rehearsal.instruction(database,req.ctx,pending);
      if(tested)await require('../../operations/postgres-security-audit').record(database,req.ctx,{action:'Rule tested on past data before it was switched on',reference:pending.id,after:rehearsal.snapshot(tested)});
    }
    const native=await require('../../assistant/postgres-native-proposal').decide(database,req.ctx,req.params.id,req.body.integrityHash,true,`Authenticated rule review by ${req.ctx.actorId}`);
    if(native){req.flash('success','Approved. StockChief is checking the rule and continuing your request.');return res.redirect(303,'/ask?goal='+encodeURIComponent(native.goalId)+'#focused-goal');}
    const result=await operatingInstructions.approve(
    database,req.ctx,req.params.id,req.body.integrityHash);req.flash('success',result.replayed?'That rule was already in force.':
      'Standing rule approved. Its exact settings and authority limits are now in force.');
    return res.redirect(303,req.body.fromAsk==='1'?'/ask#latest':`/operating-instructions/${req.params.id}`);}));
  router.post('/operating-instructions/:id/cancel',requireOwner,asyncRoute(async(req,res)=>{
    const native=await require('../../assistant/postgres-native-proposal').find(database,req.ctx,req.params.id);
    if(native){const proposal=await operatingInstructions.get(database,req.ctx.workspaceId,req.params.id);await require('../../assistant/postgres-native-proposal').decide(database,req.ctx,req.params.id,proposal.integrityHash,false,`Authenticated rule rejection by ${req.ctx.actorId}`);
      req.flash('success','The prepared rule was rejected.');return res.redirect(303,'/ask?goal='+encodeURIComponent(native.id)+'#focused-goal');}
    await operatingInstructions.cancel(
    database,req.ctx,req.params.id);req.flash('success','Discarded. That standing rule never took effect.');
    return res.redirect(303,req.body.fromAsk==='1'?'/ask#latest':'/what-you-told-me');}));
  router.post('/settings/workspace',requireOwner,asyncRoute(async(req,res)=>{const name=String(req.body.name||'').trim();
    if(!name||name.length>120)throw new ValidationError('Inventory name must be between 1 and 120 characters.');
    await require('../../domain/postgres-auth-service').renameWorkspace(database,req.ctx,name);req.flash('success','Inventory name updated.');
    return res.redirect(303,'/settings');
  }));
  router.post('/settings/company',requireOwner,asyncRoute(async(req,res)=>{
    await require('../../operations/postgres-company-profile').save(database,req.ctx,req.body);
    req.flash('success','Company details saved. Invoice documents now use this name and address.');
    return res.redirect(303,'/settings?section=general#company');
  }));
  router.post('/settings/team-roles',requireOwner,asyncRoute(async(req,res)=>{await require('../../operations/postgres-team-access').saveRole(database,req.ctx,req.body);req.flash('success','Role saved. Assigned team members now use these permissions.');return res.redirect(303,'/settings?section=team#team-authority');}));
  router.post('/settings/people/:id/access',requireOwner,asyncRoute(async(req,res)=>{await require('../../operations/postgres-team-access').assign(database,req.ctx,req.params.id,req.body);req.flash('success','Team access and purchase approval limit saved.');return res.redirect(303,'/settings?section=team#team-authority');}));
  router.post('/settings/people',requireOwner,asyncRoute(async(req,res)=>{const name=String(req.body.name||'').trim();
    const email=passwordAuth.normaliseEmail(req.body.email);const role=String(req.body.role||'staff');
    if(!name||name.length>120)throw new ValidationError('Enter a name up to 120 characters.');
    if(!ROLE_IDS.includes(role))throw new ValidationError('Choose a valid role.');
    await accountLifecycle.createInvitation(database,req.ctx,{name,email,role},{origin:config.connections.publicOrigin||res.locals.origin});
    req.flash('success',`Invitation email queued for ${email}. They choose their own password.`);return res.redirect(303,'/settings?section=team');
  }));
  router.post('/settings/people/:id/cancel',requireOwner,asyncRoute(async(req,res)=>{
    await accountLifecycle.cancelInvitation(database,req.ctx,req.params.id);req.flash('success','Invitation cancelled.');return res.redirect(303,'/settings?section=team');
  }));
  router.post('/settings/people/:id/resend',requireOwner,asyncRoute(async(req,res)=>{
    const invite=(await database.query("SELECT name,email,role FROM workspace_invitations WHERE workspace_id=$1 AND id=$2 AND status='PENDING' AND expires_at>now()",[req.ctx.workspaceId,req.params.id])).rows[0];
    if(!invite)throw new ValidationError('This invitation is no longer pending.');
    await accountLifecycle.createInvitation(database,req.ctx,invite,{origin:config.connections.publicOrigin||res.locals.origin});req.flash('success','A new invitation was queued. The old link has expired.');return res.redirect(303,'/settings?section=team');
  }));
  router.post('/settings/email-alerts',requireOwner,asyncRoute(async(req,res)=>{const enabled=req.body.enabled==='1';
    await require('../../commercial/enforcement').workspace(database,req.ctx.workspaceId,'operations.alerts');
    const minimum=['critical','important','all'].includes(req.body.minimumSeverity)?req.body.minimumSeverity:'important';
    const recipients=[...new Set(String(req.body.recipients||'').split(/[\s,;]+/).map((value)=>value.trim().toLowerCase()).filter(Boolean))];
    if(recipients.some((email)=>!/^\S+@\S+\.\S+$/.test(email)))throw new ValidationError('Enter valid alert email addresses.');
    const at=nowIso();await database.transaction(async client=>{const before=(await client.query('SELECT enabled,minimum_severity,recipients FROM notification_email_settings WHERE workspace_id=$1 FOR UPDATE',[req.ctx.workspaceId])).rows[0];await client.query(`INSERT INTO notification_email_settings
      (workspace_id,enabled,minimum_severity,recipients,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)
      ON CONFLICT(workspace_id) DO UPDATE SET enabled=EXCLUDED.enabled,minimum_severity=EXCLUDED.minimum_severity,
      recipients=EXCLUDED.recipients,updated_at=EXCLUDED.updated_at`,[req.ctx.workspaceId,enabled?1:0,minimum,JSON.stringify(recipients),at]);
      await require('../../operations/postgres-security-audit').record(client,req.ctx,{action:'Notification settings changed',before:before?{Enabled:Boolean(Number(before.enabled)),Severity:before.minimum_severity,Recipients:JSON.parse(before.recipients).join(', ')}:{},after:{Enabled:enabled,Severity:minimum,Recipients:recipients.join(', ')}});
    });
    req.flash(enabled&&!config.email.configured?'warn':'success',enabled&&!config.email.configured
      ?'Alert preferences are saved. Server email delivery still needs a verified sender.'
      :enabled?'Automatic email alerts are on.':'Automatic email alerts are off.');return res.redirect(303,'/settings?section=notifications#email-alerts');
  }));
  router.post('/settings/email-alerts/test',requireOwner,asyncRoute(async(req,res)=>{
    if(!config.email.configured){req.flash('warn','This server does not have a verified email sender. No test email was sent.');
      return res.redirect(303,'/settings?section=notifications#email-alerts');}
    const recipient=String(req.account.email||'').trim();
    const sealed=require('../../connections/credentials').encrypt({to:recipient,
      subject:'[StockChief] Email alert delivery test',
      text:'This is a delivery test. No inventory or business record was changed.',
      html:'<p>This is a delivery test. No inventory or business record was changed.</p>'});
    await require('../../operations/postgres-job-queue').enqueue(database,{workspaceId:req.ctx.workspaceId,
      kind:'system.email-send',idempotencyKey:`email-alert-test:${req.ctx.workspaceId}:${req.account.id}:${Math.floor(Date.now()/60000)}`,
      payload:{messageType:'email_alert_test',accountId:req.account.id,sealed},priority:5,maxAttempts:8});
    req.flash('success',`Test email queued for ${recipient}. Delivery may take a moment; check your inbox.`);
    return res.redirect(303,'/settings?section=notifications#email-alerts');
  }));
  router.post('/settings/event-feed/enable',requireOwner,asyncRoute(async(req,res)=>{const existing=(await database.query(`SELECT id FROM workspace_connectors
      WHERE workspace_id=$1 AND provider_type='reference_webhook' ORDER BY updated_at DESC LIMIT 1`,[req.ctx.workspaceId])).rows[0];
    if(existing)await connections.disconnect(database,req.ctx.workspaceId,existing.id);const created=await connections.createFeed(database,req.ctx,{displayName:'Live operating feed'});
    req.session.newFeedToken=created.token;req.flash('success','The live operating feed is connected. Copy its token now.');
    return req.session.save(()=>res.redirect(303,'/settings?section=advanced#live-event-feed'));
  }));
  router.post('/settings/event-feed/disconnect',requireOwner,asyncRoute(async(req,res)=>{const existing=(await database.query(`SELECT id FROM workspace_connectors
      WHERE workspace_id=$1 AND provider_type='reference_webhook' AND status<>'disconnected' ORDER BY updated_at DESC LIMIT 1`,[req.ctx.workspaceId])).rows[0];
    if(existing)await connections.disconnect(database,req.ctx.workspaceId,existing.id);req.flash('success','The live feed is disconnected and its token was revoked.');return res.redirect(303,'/settings?section=advanced#live-event-feed');
  }));
  router.get('/guide',requireAuth,asyncRoute(async(req,res)=>{const [counts,guide]=await Promise.all([summary(database,req.ctx.workspaceId),require('../../assistant/staff-guide').read(database,req.ctx,req.query.q)]);
    const next=counts.products?{title:'Keep the operation current',recommendation:'Use Ask StockChief for ordinary work and Needs you for genuine exceptions.',href:'/ask',action:'Ask StockChief'}:
      {title:'Bring in the first inventory records',recommendation:'Choose the source that already contains your products and quantities.',href:'/onboarding?add=1',action:'Choose a source'};
    return res.page('guide',{title:'How to use StockChief',nav:'guide',guidance:{checklistActive:false,steps:[],next},topics:guide.topics,guideQuery:guide.query});
  }));
  router.get('/support',requireAuth,asyncRoute(async(req,res)=>{const service=require('../../operations/postgres-support-conversations'),requests=await require('../../operations/postgres-support').list(database,req.account.id),access=await service.access(database,{accountId:req.account.id,workspaceId:req.ctx.workspaceId});res.page('support/chat',{title:'Help and support',nav:null,supportAccess:access,supportSourcePath:String(req.query.from||'').split('?')[0],supportRequests:requests,ticket:null,staff:false,messageKey:newId('supportreply'),supportRequestKey:newId('supportform'),presence:await service.online(database)});}));
  router.get('/support/request',requireAuth,asyncRoute(async(req,res)=>res.page('support',{
    title:'Help and support',nav:null,supportEmail:require('../../operations/postgres-support').SUPPORT_EMAIL,
    supportRequestKey:newId('supportform'),supportContactEmail:req.account.email,
    supportRequests:await require('../../operations/postgres-support').list(database,req.account.id),supportSourcePath:String(req.query.from||'').split('?')[0],
    supportAccess:await require('../../operations/postgres-support-conversations').access(database,{accountId:req.account.id,workspaceId:req.ctx.workspaceId}),
  })));
  router.get('/foundry',requireAuth,(req,res)=>res.redirect(302,'/what-you-told-me'));
  router.get('/settings/export',requireOwner,asyncRoute(async(req,res)=>{
    return require('../../operations/postgres-export-stream').download(database,req.ctx.workspaceId,res);
  }));
  return router;
}

module.exports={createPostgresSettingsRouter,sections};
