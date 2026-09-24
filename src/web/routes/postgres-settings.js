'use strict';

const express=require('express');
const autopilot=require('../../autopilot/postgres-service');
const connections=require('../../connections/postgres-service');
const operatingInstructions=require('../../manager/postgres-operating-instructions');
const { requireAuth,requireOwner,asyncRoute }=require('../middleware');
const { ValidationError }=require('../../domain/errors');

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
  {title:'Customer orders',why:'Orders, commitments, fulfillment, returns and payments stay linked as one business story.',
    links:[{href:'/orders',label:'Customer orders'}]},
  {title:'Buying and suppliers',why:'Replenishment decisions and supplier orders use the shared PostgreSQL operation record.',
    links:[{href:'/purchasing',label:'Purchasing and suppliers'}]},
  {title:'Stock, in detail',why:'Products, variants, locations and imports are the physical inventory truth.',links:[
    {href:'/inventory',label:'Inventory catalogue'},{href:'/inventory/new',label:'Add a product'},
    {href:'/locations',label:'Locations'},{href:'/imports',label:'Import records'}]},
  {title:'Money and accounting',why:'Reports are calculated from posted journals and source business events.',links:[
    {href:'/money',label:'Money overview'},{href:'/accounting/reports/profit-and-loss',label:'Profit and loss'},
    {href:'/accounting/reports/balance-sheet',label:'Balance sheet'},
    {href:'/accounting/reports/general-ledger',label:'General ledger'}]},
  {title:'Messages',why:'Business mail and the operation timeline remain available without becoming a general email client.',links:[
    {href:'/mail',label:'Business conversations'},{href:'/activity',label:'Activity and audit'}]},
  {title:'What StockChief may do',why:'Automatic work is limited by explicit, reviewable authority.',links:[
    {href:'/autopilot',label:'Authority and automatic work'},{href:'/needs-you',label:'Work needing approval'},
    {href:'/ask',label:'Ask StockChief'},{href:'/planning',label:'What happens next'},
    {href:'/repairs',label:'Governed repairs'}]},
  {title:'Connections',why:'Each inventory owns its mailbox, commerce, accounting and shipping credentials.',links:[
    {href:'/settings/connections',label:'Business connections'},{href:'/settings/shipping',label:'Shipping account'}]},
  {title:'This inventory',why:'Account and inventory-wide choices live here.',links:[
    {href:'/settings',label:'Inventory settings'},{href:'/inventories',label:'Your inventories'},
    {href:'/what-you-told-me',label:"What you've told StockChief"},
    {href:'/settings/operations',label:'Production operations'}]},
];

async function summary(database,workspaceId){const result=await database.query(`SELECT
  (SELECT COUNT(*) FROM items WHERE workspace_id=$1 AND is_active=1) AS products,
  (SELECT COUNT(*) FROM skus WHERE workspace_id=$1 AND is_active=1) AS skus,
  (SELECT COUNT(*) FROM locations WHERE workspace_id=$1 AND is_active=1) AS locations,
  (SELECT COUNT(*) FROM users WHERE workspace_id=$1) AS people,
  (SELECT COUNT(*) FROM workspace_connectors WHERE workspace_id=$1 AND status<>'disconnected') AS connections`,[workspaceId]);
  return Object.fromEntries(Object.entries(result.rows[0]).map(([key,value])=>[key,Number(value)]));}

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
  router.get('/settings',requireAuth,asyncRoute(async(req,res)=>res.page('settings/postgres-settings',{
    title:'Inventory settings',nav:'settings',summary:await summary(database,req.ctx.workspaceId),
  })));
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
  router.get('/support',requireAuth,(req,res)=>res.redirect(303,'/settings'));
  return router;
}

module.exports={createPostgresSettingsRouter,sections};
