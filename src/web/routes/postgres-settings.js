'use strict';

const express=require('express');
const autopilot=require('../../autopilot/postgres-service');
const connections=require('../../connections/postgres-service');
const operatingInstructions=require('../../manager/postgres-operating-instructions');
const readiness=require('../../operations/postgres-readiness');
const passwordAuth=require('../../domain/auth-service');
const {ROLE_IDS}=require('../../domain/constants');
const config=require('../../config');
const { requireAuth,requireOwner,asyncRoute }=require('../middleware');
const { ValidationError }=require('../../domain/errors');
const {newId,nowIso}=require('../../lib/util');

function instructionFrom(row){return {id:row.id,statedAs:row.stated_as,summary:row.summary,status:row.status,
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
    {href:'/fulfilment',label:'Picking and packing queue'},{href:'/sales/customers/new',label:'Add a customer'}]},
  {title:'Buying and suppliers',why:'A purchase is one story too. StockChief prepares these; the queue is here for when you want to work through them yourself.',links:[
    {href:'/purchasing',label:'What needs buying'},{href:'/purchasing/orders',label:'All purchase orders'},
    {href:'/purchasing/orders/new',label:'Write a purchase order'},{href:'/purchasing/receive',label:'Book in a delivery'},
    {href:'/suppliers',label:'Suppliers and their terms'},{href:'/purchasing/setup',label:'Reorder points and targets'}]},
  {title:'Stock, in detail',why:'What you hold answers the question in six lines. This is the database underneath it, for when six lines is not enough.',links:[
    {href:'/inventory/table',label:'Full stock table'},{href:'/inventory/new',label:'Add a product'},
    {href:'/locations',label:'Locations'},{href:'/warehouse',label:'Warehouse tasks and scanning'},
    {href:'/transfers',label:'Transfers and in-transit stock'},{href:'/planning',label:'What StockChief expects to go wrong'},
    {href:'/pricing/new',label:'Change selling prices'},{href:'/imports/start',label:'Bring data in from a file'}]},
  {title:'Books and accounting',why:'Money says how the business is doing. This is the ledger, for your accountant — you should not be operating it during ordinary work.',links:[
    {href:'/accounting/books',label:'Books dashboard'},{href:'/accounting/transactions',label:'Every transaction'},
    {href:'/accounting/chart',label:'Chart of accounts'},{href:'/accounting/receivables',label:'What customers owe'},
    {href:'/accounting/payables',label:'What you owe'},{href:'/accounting/banking',label:'Banking and reconciliation'},
    {href:'/accounting/periods',label:'Closing a period'},{href:'/accounting/tax',label:'Tax rates'},
    {href:'/accounting/reports/profit-and-loss',label:'Profit and loss'},
    {href:'/accounting/reports/balance-sheet',label:'Balance sheet'}]},
  {title:'Messages',why:'StockChief is not an email client. Supplier mail lives on the purchase, customer mail on the order, and anything waiting on a reply is on the desk. This is the whole mailbox, for when you want to look through it.',links:[
    {href:'/mail',label:'All conversations'},{href:'/activity',label:'Everything that happened, in order'}]},
  {title:'What StockChief may do on its own',why:'Authority is two choices: ask me first, or handle routine work inside limits you approve. The exact limits are here.',links:[
    {href:'/autopilot',label:'Standing authority'},{href:'/autopilot',label:'Limits and preferences'},
    {href:'/autopilot/history',label:'Everything it did on its own'},{href:'/actions',label:'Changes prepared for approval'},
    {href:'/repairs',label:'Governed repairs'}]},
  {title:'Connections',why:'Mailbox, shop, payments and carrier. Mapping and credentials are technical, so they sit inside each connection rather than on the main path.',links:[
    {href:'/settings/connections',label:'All connections'},{href:'/settings/shipping',label:'Shipping and carriers'}]},
  {title:'This inventory',why:'Set once, changed rarely.',links:[
    {href:'/search',label:'Search every record'},{href:'/settings',label:'Settings, people and plan'},
    {href:'/what-you-told-me',label:'How this inventory is configured'},{href:'/inventories',label:'Your other inventories'},
    {href:'/settings/export',label:'Export everything'},{href:'/guide',label:'How to use StockChief'},
    {href:'/support',label:'Support'}]},
];

const guideTopics=[
  {title:'Set up inventory',path:'Choose the setup path that matches where your records live, then approve the products, variants and locations StockChief found.',tell:'“We are starting from scratch” or attach your existing file.',href:'/onboarding?add=1',action:'Choose a source'},
  {title:'Record a sale',path:'Tell StockChief what sold, how many, and where. Check the preview, then approve it.',tell:'“We sold 1 item at Main Warehouse.”',href:'/ask',action:'Record a sale'},
  {title:'Receive stock',path:'Tell StockChief what arrived and where. If it belongs to a PO, name the PO number.',tell:'“We received 10 units at Main Warehouse.”',href:'/ask',action:'Receive stock'},
  {title:'Move stock',path:'Name the item, quantity, source and destination. StockChief verifies that totals stay unchanged.',tell:'“Move 5 units from Main Warehouse to Overflow.”',href:'/transfers/new',action:'Move stock'},
  {title:'Fix a count',path:'Report the physical count. If it disagrees with the ledger, StockChief opens one investigation and does not silently change stock.',tell:'“I counted 12 units at Main Warehouse.”',href:'/ask',action:'Report a count'},
  {title:'Set low-stock and reorder rules',path:'Open planning to review evidence-based reorder points, targets and supplier choices.',tell:'“Set a reorder point for this product.”',href:'/planning',action:'Review planning'},
  {title:'Set up suppliers and purchase orders',path:'Add the supplier, then record price, pack size, minimum and lead time before StockChief prepares a PO.',tell:'“Help me add a supplier.”',href:'/suppliers',action:'Set up purchasing'},
  {title:'Receive a purchase order',path:'Open the placed purchase order, count what arrived, and record only what physically arrived.',tell:'“The purchase order arrived.”',href:'/purchasing',action:'View purchase orders'},
  {title:'Control automatic work',path:'Choose Ask me first or explicitly enable bounded routine transfers and purchasing.',tell:'“Automatically transfer up to 5 units at a time.”',href:'/autopilot',action:'Choose automatic work'},
  {title:'Find what needs attention',path:'Needs you is the inbox for real decisions and physical facts.',tell:'“What needs my attention?”',href:'/needs-you',action:'Open Needs you'},
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

async function settingsPage(database,req,res){const [counts,users,integrity,instructions,emailAlerts,feedRows,events]=await Promise.all([
  summary(database,req.ctx.workspaceId),database.query(`SELECT member.id,member.name,member.role,account.email
    FROM users member JOIN accounts account ON account.id=member.account_id WHERE member.workspace_id=$1
    ORDER BY CASE member.role WHEN 'owner' THEN 0 ELSE 1 END,lower(member.name)`,[req.ctx.workspaceId]),
  readiness.reconciliation(database,req.ctx.workspaceId),database.query(`SELECT id,stated_as,status FROM operating_instruction_proposals
    WHERE workspace_id=$1 AND status IN ('APPROVED','REMOVED','SUPERSEDED') ORDER BY created_at DESC`,[req.ctx.workspaceId]),
  emailAlertState(database,req.ctx.workspaceId),database.query(`SELECT connector.* FROM workspace_connectors connector
    WHERE workspace_id=$1 AND provider_type='reference_webhook' ORDER BY updated_at DESC LIMIT 1`,[req.ctx.workspaceId]),
  database.query(`SELECT external_event_id,event_type,status,error_message,processed_at FROM connector_feed_events
    WHERE workspace_id=$1 ORDER BY received_at DESC LIMIT 6`,[req.ctx.workspaceId])]);
  const feed=feedRows.rows[0]||null;const problems=Object.entries(integrity).filter(([key,value])=>key!=='ok'&&Number(value)>0)
    .map(([kind,value])=>({kind:kind.replaceAll('_',' '),detail:`${value} record${Number(value)===1?'':'s'} do not reconcile.`}));
  const newFeedToken=req.session.newFeedToken||null;delete req.session.newFeedToken;
  return res.page('settings',{title:'Settings',nav:'settings',room:true,users:users.rows,workspace:req.workspace,
    integrity:{ok:integrity.ok,problems},eventFeed:{configured:Boolean(feed),connected:feed?.status==='connected',
      recentEvents:events.rows.map((event)=>({eventId:event.external_event_id,type:event.event_type,status:event.status,
        error:event.error_message,processedAt:event.processed_at}))},newFeedToken,learnedInstructions:instructions.rows.map(instructionFrom),
    stockGuards:[],emailAlerts,aiUsage:null,entitlements:{plan:{label:'Pre-subscription · unlimited'},limits:[
      {key:'workspaces',used:res.locals.workspaces.length,unlimited:true},{key:'members',used:counts.people,unlimited:true},
      {key:'locations',used:counts.locations,unlimited:true},{key:'skus',used:counts.skus,unlimited:true}]}});}

function createPostgresSettingsRouter(database,options={}){const router=express.Router();
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
  router.get('/operating-instructions/:id',requireAuth,asyncRoute(async(req,res)=>{const proposal=await operatingInstructions.get(
    database,req.ctx.workspaceId,req.params.id);return res.page('settings/postgres-operating-instruction',{
      title:'Review standing instruction',nav:'settings',room:true,backTo:{href:'/what-you-told-me',label:"What you've told me"},
      proposal,descriptions:proposal.resolvedChanges.map(operatingInstructions.describe)});}));
  router.post('/operating-instructions/:id/answer',requireOwner,asyncRoute(async(req,res)=>{const replacement=await operatingInstructions.answer(
    database,req.ctx,req.params.id,req.body.answer,{provider:options.provider});req.flash('success','The same instruction was read again with your answer.');
    return res.redirect(303,`/operating-instructions/${replacement.id}`);}));
  router.post('/operating-instructions/:id/approve',requireOwner,asyncRoute(async(req,res)=>{const result=await operatingInstructions.approve(
    database,req.ctx,req.params.id,req.body.integrityHash);req.flash('success',result.replayed?'That rule was already in force.':
      'Standing rule approved. Its exact settings and authority limits are now in force.');
    return res.redirect(303,`/operating-instructions/${req.params.id}`);}));
  router.post('/operating-instructions/:id/cancel',requireOwner,asyncRoute(async(req,res)=>{await operatingInstructions.cancel(
    database,req.ctx,req.params.id);req.flash('success','Discarded. That standing rule never took effect.');
    return res.redirect(303,'/what-you-told-me');}));
  router.post('/settings/workspace',requireOwner,asyncRoute(async(req,res)=>{const name=String(req.body.name||'').trim();
    if(!name||name.length>120)throw new ValidationError('Inventory name must be between 1 and 120 characters.');
    await database.query('UPDATE workspaces SET name=$3 WHERE id=$1 AND owner_account_id=$2',
      [req.ctx.workspaceId,req.account.id,name]);req.flash('success','Inventory name updated.');
    return res.redirect(303,'/settings');
  }));
  router.post('/settings/people',requireOwner,asyncRoute(async(req,res)=>{const name=String(req.body.name||'').trim();
    const email=passwordAuth.normaliseEmail(req.body.email);const role=String(req.body.role||'staff');
    if(!name||name.length>120)throw new ValidationError('Enter a name up to 120 characters.');
    if(!ROLE_IDS.includes(role))throw new ValidationError('Choose a valid role.');
    const password=passwordAuth.checkPasswordStrength(req.body.password);const at=nowIso();
    await database.transaction(async(client)=>{let account=(await client.query('SELECT * FROM accounts WHERE email=$1 FOR UPDATE',[email])).rows[0];
      if(!account){account={id:newId('acc')};await client.query(`INSERT INTO accounts(id,email,name,password_hash,plan,last_workspace_id,created_at)
        VALUES($1,$2,$3,$4,'free',$5,$6)`,[account.id,email,name,passwordAuth.hashPassword(password),req.ctx.workspaceId,at]);}
      const existing=await client.query('SELECT 1 FROM users WHERE workspace_id=$1 AND account_id=$2',[req.ctx.workspaceId,account.id]);
      if(existing.rows.length)throw new ValidationError('That email already belongs to a person in this inventory.');
      await client.query(`INSERT INTO users(id,workspace_id,account_id,name,role,created_at)
        VALUES($1,$2,$3,$4,$5,$6)`,[newId('usr'),req.ctx.workspaceId,account.id,name,role,at]);},
    {isolation:'SERIALIZABLE',retrySafe:true});req.flash('success',`${name} can now use this inventory.`);return res.redirect(303,'/settings');
  }));
  router.post('/settings/email-alerts',requireOwner,asyncRoute(async(req,res)=>{const enabled=req.body.enabled==='1';
    const minimum=['critical','important','all'].includes(req.body.minimumSeverity)?req.body.minimumSeverity:'important';
    const recipients=[...new Set(String(req.body.recipients||'').split(/[\s,;]+/).map((value)=>value.trim().toLowerCase()).filter(Boolean))];
    if(recipients.some((email)=>!/^\S+@\S+\.\S+$/.test(email)))throw new ValidationError('Enter valid alert email addresses.');
    const at=nowIso();await database.query(`INSERT INTO notification_email_settings
      (workspace_id,enabled,minimum_severity,recipients,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)
      ON CONFLICT(workspace_id) DO UPDATE SET enabled=EXCLUDED.enabled,minimum_severity=EXCLUDED.minimum_severity,
      recipients=EXCLUDED.recipients,updated_at=EXCLUDED.updated_at`,[req.ctx.workspaceId,enabled?1:0,minimum,JSON.stringify(recipients),at]);
    req.flash(enabled&&!config.email.configured?'warn':'success',enabled&&!config.email.configured
      ?'Alert preferences are saved. Server email delivery still needs a verified sender.'
      :enabled?'Automatic email alerts are on.':'Automatic email alerts are off.');return res.redirect(303,'/settings#email-alerts');
  }));
  router.post('/settings/email-alerts/test',requireOwner,asyncRoute(async(req,res)=>{req.flash('warn',config.email.configured
      ?'Test delivery is queued by the notification worker when a new actionable item opens.'
      :'This server does not yet have a verified email sender. No test email was sent.');return res.redirect(303,'/settings#email-alerts');}));
  router.post('/settings/event-feed/enable',requireOwner,asyncRoute(async(req,res)=>{const existing=(await database.query(`SELECT id FROM workspace_connectors
      WHERE workspace_id=$1 AND provider_type='reference_webhook' ORDER BY updated_at DESC LIMIT 1`,[req.ctx.workspaceId])).rows[0];
    if(existing)await connections.disconnect(database,req.ctx.workspaceId,existing.id);const created=await connections.createFeed(database,req.ctx,{displayName:'Live operating feed'});
    req.session.newFeedToken=created.token;req.flash('success','The live operating feed is connected. Copy its token now.');
    return req.session.save(()=>res.redirect(303,'/settings#live-event-feed'));
  }));
  router.post('/settings/event-feed/disconnect',requireOwner,asyncRoute(async(req,res)=>{const existing=(await database.query(`SELECT id FROM workspace_connectors
      WHERE workspace_id=$1 AND provider_type='reference_webhook' AND status<>'disconnected' ORDER BY updated_at DESC LIMIT 1`,[req.ctx.workspaceId])).rows[0];
    if(existing)await connections.disconnect(database,req.ctx.workspaceId,existing.id);req.flash('success','The live feed is disconnected and its token was revoked.');return res.redirect(303,'/settings#live-event-feed');
  }));
  router.get('/guide',requireAuth,asyncRoute(async(req,res)=>{const counts=await summary(database,req.ctx.workspaceId);
    const next=counts.products?{title:'Keep the operation current',recommendation:'Use Ask StockChief for ordinary work and Needs you for genuine exceptions.',href:'/ask',action:'Ask StockChief'}:
      {title:'Bring in the first inventory records',recommendation:'Choose the source that already contains your products and quantities.',href:'/onboarding?add=1',action:'Choose a source'};
    return res.page('guide',{title:'How to use StockChief',nav:'guide',guidance:{checklistActive:false,steps:[],next},topics:guideTopics});
  }));
  router.get('/support',requireAuth,asyncRoute(async(req,res)=>res.page('support',{
    title:'Help and support',nav:null,supportEmail:config.supportEmail,
  })));
  router.get('/foundry',requireAuth,(req,res)=>res.redirect(302,'/what-you-told-me'));
  router.get('/settings/export',requireOwner,asyncRoute(async(req,res)=>{const tables=['users','locations','items','skus',
    'balances','movements','suppliers','supplier_items','purchase_orders','purchase_order_lines','customers','sales_orders',
    'sales_order_lines','sales_order_allocations','sales_shipments','accounting_accounts','accounting_journal_entries',
    'accounting_journal_lines','workspace_connectors'];const payload={exportedAt:new Date().toISOString(),workspaceId:req.ctx.workspaceId,tables:{}};
    const workspace=(await database.query('SELECT * FROM workspaces WHERE id=$1',[req.ctx.workspaceId])).rows[0];
    payload.tables.workspaces=workspace?[workspace]:[];
    for(const table of tables)payload.tables[table]=(await database.query(`SELECT * FROM ${table} WHERE workspace_id=$1`,[req.ctx.workspaceId])).rows;
    const safeName=String(workspace?.name||'stockchief-inventory').replace(/[^a-z0-9_-]+/gi,'-').replace(/^-+|-+$/g,'').toLowerCase()||'stockchief-inventory';
    res.set('Content-Type','application/json; charset=utf-8');res.set('Content-Disposition',`attachment; filename="${safeName}-${new Date().toISOString().slice(0,10)}.json"`);
    return res.send(`${JSON.stringify(payload,null,2)}\n`);
  }));
  return router;
}

module.exports={createPostgresSettingsRouter,sections};
