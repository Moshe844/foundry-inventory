'use strict';
// Job 174: Needs you is one list of every decision, and similar approvals can
// be approved or declined in one tap. Every plan.
//
// StockChief groups approvals that wait for the same person, are the same
// kind with the same facts (same supplier and currency, same route, same
// location and reason), and are each inside that person's own limits. Only
// kinds whose approve path is idempotent and checks the person itself are
// grouped:
//   purchase orders            (by supplier and currency; approve or cancel)
//   transfers                  (by route; approve or cancel)
//   supplier returns           (by supplier; authorize)
//   customer returns           (by customer and outcome; authorize)
//   prepared changes           (stock counts by location and direction, stock
//                               write-downs, customer credits, return refunds,
//                               delivery costs to stock, purchase cost changes
//                               and transfers; approve or decline)
// Never grouped: anything two people must approve, anything over the person's
// limit, approvals inside an Ask conversation, supplier price-list rows (each
// row is confirmed on its own) and questions or problems to fix. Replenishment
// decisions keep their own approve-all page.
//
// One tap runs each approval through its own service with its own checks.
// One that fails stays in Needs you and the reason is shown. Groups are not
// offered during the first 14 days, in Watch only, or when the owner sets
// this job to Watch only; each approval can still be decided on its own.
const {ValidationError,AuthorizationError}=require('../domain/errors');
const permissions=require('../actions/permissions');
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');

const JOB=174,LIMIT=50;
// Prepared changes that may be grouped, and the facts that must match.
const CHANGES={
  'inventory.adjust':{label:f=>'Stock count corrections at '+(f.location||'one location')+(f.direction==='down'?' that lower stock':' that raise stock'),
    key:(p,f)=>[p.locationId,p.reasonCode||'',f.direction]},
  'inventory.write_down_aged':{label:()=>'Stock write-downs',key:p=>[p.currency,p.locationId]},
  'customer_credit.prepare':{label:()=>'Customer credits and refunds',key:p=>[p.kind,p.currency,(p.parts||[]).some(s=>s.provider)?'provider':'person']},
  'customer_return.refund':{label:()=>'Return refunds',key:p=>[p.currency,p.destination]},
  'landed_cost.apply':{label:()=>'Delivery costs to stock',key:p=>[p.training?.currency,p.source?.method]},
  'catalog.set_purchase_cost':{label:()=>'Purchase cost changes',key:p=>[p.currency]},
  'inventory.transfer':{label:()=>'Prepared transfers',key:p=>[p.sourceLocationId,p.destinationLocationId]},
};
const SOURCES={
  purchase:{label:f=>'Purchase orders from '+f.label,key:f=>[f.supplierId,f.currency],decline:true},
  transfer:{label:f=>'Transfers from '+f.label,key:f=>[f.from,f.to],decline:true},
  supplier_return:{label:f=>'Returns to '+f.label,key:f=>[f.supplierId],decline:false},
  customer_return:{label:f=>'Returns from '+f.label,key:f=>[f.customerId,f.resolution],decline:false},
};

// Why groups are not offered now, or null.
async function held(db,workspaceId,state){
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return 'plan';
  return policy.stopped(db,workspaceId,state,'approval.group',false);
}
// The group an approval belongs to for this person, or null.
function groupFor(request){
  if(request.twoPeople||request.signed?.length)return null;
  if(request.source==='proposal'){
    const spec=CHANGES[request.actionType],p=request.facts.payload||{};
    if(!spec)return null;
    return {key:'change:'+request.actionType+':'+JSON.stringify(spec.key(p,request.facts)),label:spec.label(request.facts),decline:true};
  }
  const spec=SOURCES[request.source];
  return spec?{key:request.source+':'+JSON.stringify(spec.key(request.facts)),label:spec.label(request.facts),decline:spec.decline}:null;
}
// Groups of two or more in this person's list.
function fromItems(items){
  const groups=new Map();
  for(const item of items){const g=item.approvalRequest?.group;if(!g)continue;
    if(!groups.has(g.key))groups.set(g.key,{...g,items:[]});groups.get(g.key).items.push({key:item.approvalRequest.key,title:item.title,href:item.href});}
  return [...groups.values()].filter(g=>g.items.length>=2).map(g=>({...g,items:g.items.slice(0,LIMIT),count:Math.min(g.items.length,LIMIT)}));
}

async function approveOne(db,ctx,request,token){
  const key='needs-group:'+token+':'+request.key;
  if(request.source==='purchase')return require('../operations/postgres-business-workflows').approvePurchaseOrder(db,ctx,request.id,{idempotencyKey:key});
  if(request.source==='transfer')return require('../transfers/postgres-transfer-service').approve(db,ctx,request.id,{idempotencyKey:key});
  if(request.source==='supplier_return')return require('../operations/postgres-returns').authorizeSupplierReturn(db,ctx,request.id,{idempotencyKey:key});
  if(request.source==='customer_return')return require('../operations/postgres-returns').authorizeCustomerReturn(db,ctx,request.id,{idempotencyKey:key});
  if(request.source==='proposal'){
    const result=await require('./two-person-approval').approve(db,ctx,request.id);
    if(result.required&&result.status!=='READY')throw new ValidationError('Two people must approve this one.');
    return result;
  }
  throw new ValidationError('This approval cannot be approved with others.');
}
async function declineOne(db,ctx,request,token){
  const key='needs-group:'+token+':'+request.key+':decline',reason='Declined in Needs you';
  if(request.source==='purchase')return require('../operations/postgres-business-workflows').cancelPurchaseOrder(db,ctx,request.id,{idempotencyKey:key,reason});
  if(request.source==='transfer')return require('../transfers/postgres-transfer-service').cancel(db,ctx,request.id,{idempotencyKey:key,reason});
  if(request.source==='proposal'){
    // Declining is checked like approving: the change's own permission.
    const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
    permissions.assertCan(actor,request.permission,'decline this change');
    if(request.ownerOnly&&actor.role!=='owner')throw new AuthorizationError('Only the owner can decline this change.');
    return require('../assistant/postgres-service').cancelProposal(db,ctx,request.id);
  }
  throw new ValidationError('This approval cannot be declined with others. Open it to decide.');
}

// Approve or decline a whole group. Only approvals still in the person's own
// group, and that they saw, are decided; each one through its own service.
async function decide(db,ctx,input={}){
  const action=input.decision==='decline'?'decline':input.decision==='approve'?'approve':null;
  if(!action)throw new ValidationError('Choose approve all or decline all.');
  const token=String(input.token||'');
  if(!/^[A-Za-z0-9_-]{8,80}$/.test(token))throw new ValidationError('Reload Needs you and try again.');
  const seen=new Set([].concat(input.keys||[]).map(String).slice(0,LIMIT));
  const items=await require('../projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);
  const group=fromItems(items).find(g=>g.key===String(input.group||''));
  const requests=group?(await require('./approval-desk').desk(db,ctx.workspaceId)).rows.filter(r=>r.person?.id===ctx.actorId&&group.items.some(i=>i.key===r.key)&&seen.has(r.key)):[];
  const gone=[...seen].filter(key=>!requests.some(r=>r.key===key));
  if(!requests.length)return {done:[],failed:[],gone,action};
  if(action==='decline'&&!group.decline)throw new ValidationError('These approvals cannot be declined together. Open each one to decide.');
  const done=[],failed=[];
  for(const request of requests){
    try{await (action==='approve'?approveOne:declineOne)(db,ctx,request,token);done.push(request);}
    catch(error){if(!error.status&&!error.code)throw error;failed.push({request,reason:error.message});}
  }
  await audit.record(db,ctx,{action:(action==='approve'?'Approved':'Declined')+' a group in Needs you',reference:group.label.slice(0,200),
    after:{done:done.map(r=>r.title),failed:failed.map(f=>({approval:f.request.title,reason:f.reason})),noLongerWaiting:gone.length}});
  return {done,failed,gone,action,label:group.label};
}
module.exports={JOB,CHANGES,SOURCES,held,groupFor,fromItems,decide};
