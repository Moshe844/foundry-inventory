'use strict';
// Job 208 adapters for customer, shipping and returns jobs. Each one reads its
// job's own approvals and teaches through that job's own rule or example path.
const {T,largest,maximum,whole,amount,token,row,hash,money}=require('./common');
const window_=`now()-make_interval(days=>$3)`;
const CONFIRMED=['CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED'];
const CLAIM_RECEIPTS=['submitted','in_review','approved','approved_partial','needs_action'];

// Job 63: carrier claims the owner approved for the same account, claim type,
// place and recipient. Claims filed on a carrier's own page always need a person.
const carrierClaims={kind:'job:63',jobs:[63],label:'Carrier claims',tables:[T('agent_carrier_claims')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT c.id,c.scope_key,c.facts,c.route,c.receipt,e.created_at at,e.status effect_status,e.result->>'id' effect_reference
   FROM ${T('agent_carrier_claims')} c JOIN ${T('provider_effects')} e ON e.workspace_id=c.workspace_id AND e.id=c.effect_id AND e.kind='shipping.carrier_claim'
   WHERE c.workspace_id=$1 AND c.automatic=false AND e.requested_by_user_id=$2 AND e.created_at>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   .map(r=>row(r.id,r.scope_key,r.at,{needsPerson:r.route==='portal',value:r.facts?.amountMinor,data:{...r,
    confirmed:r.effect_status==='SUCCEEDED'&&r.receipt?.id&&r.receipt.id===r.effect_reference&&CLAIM_RECEIPTS.includes(r.receipt.status)}}));
 },
 async offer(db,ctx,{run}){
  if((await db.query(`SELECT 1 FROM ${T('agent_draft_rules')} WHERE workspace_id=$1 AND action_type='shipping.carrier_claim' AND scope_key=$2`,[ctx.workspaceId,run.scope])).rowCount)return null;
  // A rule is taught from a claim the carrier confirmed, up to its amount and insurance.
  const example=largest(run.rows.filter(r=>r.data.confirmed),r=>r.value);if(!example)return null;
  const f=example.data.facts,limit=Math.min(Number(f.amountMinor),Number(f.coverageMinor));
  if(!whole(limit))return null;
  const input={revision:0,confirmed:'yes',maximum:money.fromMinor(limit,'USD')};
  return {limitValue:limit,label:'EasyPost '+f.type+' claims like '+f.number,limit:'up to '+amount(limit,'USD')+' a claim',runMaximum:amount(maximum(run.rows,r=>r.value)||0,'USD'),
   capped:limit<maximum(run.rows,r=>r.value)?'the largest claim the carrier has confirmed':null,href:'/shipping/carrier-claims/'+example.id,token:token({id:example.id,input}),teach:{id:example.id,input}};
 },
 async teach(s,ctx,offer){await require('../../shipping/agent-carrier-claims').saveRule(s,ctx,offer.teach.id,offer.teach.input);}
};

// Job 71: van route manifests the owner published for the same depot and
// fleet. Stopping one is a "no".
const vanRoutes={kind:'job:71',jobs:[71],label:'Van routes',tables:[T('agent_van_routes'),T('agent_van_route_rules')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT r.id,r.depot_id,r.fleet_key,r.status,r.created_at at,jsonb_array_length(coalesce(r.facts->'stops','[]'::jsonb)) stops,
     jsonb_array_length(coalesce(r.manifest->'unassigned','[]'::jsonb)) unassigned,l.name depot
   FROM ${T('agent_van_routes')} r LEFT JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.depot_id
   WHERE r.workspace_id=$1 AND ((r.status='READY' AND NOT r.automatic) OR r.status='STOPPED') AND r.created_at>=now()-make_interval(days=>$2)`,
  [ctx.workspaceId,days])).rows.map(r=>row(r.id,r.depot_id+'|'+r.fleet_key,r.at,{declined:r.status==='STOPPED',needsPerson:r.unassigned>0,value:r.stops,data:r}));
 },
 async offer(db,ctx,{run}){
  const d=run.latest.data;
  if((await db.query(`SELECT 1 FROM ${T('agent_van_route_rules')} WHERE workspace_id=$1 AND depot_id=$2 AND fleet_key=$3`,[ctx.workspaceId,d.depot_id,d.fleet_key])).rowCount)return null;
  // The rule must cover its example's stops, so the example is the longest run.
  const example=largest(run.rows,r=>r.value),stops=Number(example?.value);
  if(!whole(stops))return null;
  const input={ruleRevision:0,confirmed:'yes',maximumStops:String(stops)};
  return {limitValue:stops,label:'Publish van routes from '+(d.depot||'this depot')+' with the same vans',limit:'up to '+stops+' stops a route run',href:'/shipping/van-routes/'+example.id,
   token:token({id:example.id,input}),teach:{id:example.id,input}};
 },
 async teach(s,ctx,offer){await require('../../shipping/agent-van-routes').configure(s,ctx,offer.teach.id,offer.teach.input);}
};

// Job 78: private check-ins the owner approved. One routine for all inactive
// customers; nothing is ever sent.
const checkIns={kind:'job:78',jobs:[78],label:'Customer check-ins',tables:[T('agent_customer_checkin_drafts'),T('agent_customer_checkin_rules')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT id,status,result->>'draftId' draft_id,coalesce(cancelled_at,executed_at,created_at) at FROM ${T('assistant_action_proposals')}
   WHERE workspace_id=$1 AND action_type='customer.check_in' AND actor_user_id=$2 AND created_at>=${window_}
     AND ((status='EXECUTED' AND result->>'automatic' IS DISTINCT FROM 'true') OR status='CANCELLED')`,[ctx.workspaceId,ctx.actorId,days])).rows
   .map(r=>row(r.id,'all',r.at,{declined:r.status==='CANCELLED',data:r}));
 },
 async offer(db,ctx,{run}){
  if((await db.query(`SELECT 1 FROM ${T('agent_customer_checkin_rules')} WHERE workspace_id=$1`,[ctx.workspaceId])).rowCount)return null;
  // The example is the newest of these drafts still unsent and unchanged.
  const ids=run.rows.map(r=>r.data.draft_id).filter(Boolean);
  const draft=(await db.query(`SELECT d.id FROM ${T('agent_customer_checkin_drafts')} d JOIN customer_communications m ON m.workspace_id=d.workspace_id AND m.id=d.id
    WHERE d.workspace_id=$1 AND d.id=ANY($2::text[]) AND d.authority_kind='INDIVIDUAL' AND d.drafted_by=$3 AND m.status='PREPARED' AND m.connector_id IS NULL
    ORDER BY d.created_at DESC,d.id DESC LIMIT 1`,[ctx.workspaceId,ids,ctx.actorId])).rows[0];
  if(!draft)return null;
  const input={revision:'0',confirmed:'yes',exampleId:draft.id};
  return {label:'Private check-ins for customers who stopped buying',limit:'one private draft per customer each time they go quiet, never sent',
   href:'/autopilot/customer-check-ins',token:token(input),teach:input};
 },
 async teach(s,ctx,offer){await require('../../sales/agent-customer-checkins').configure(s,ctx,offer.teach);}
};

// Job 83: the same exact order from a private customer order page, drafted
// for the owner and confirmed by them. A stopped request or a cancelled order
// is a "no". Preorder pages keep their own approvals.
const orderPages={kind:'job:83',jobs:[83],label:'Customer order pages',tables:[T('agent_customer_page_requests'),T('agent_customer_page_rules'),T('agent_customer_order_pages')],
 async history(db,ctx,{days}){
  const pages=require('../../sales/agent-customer-order-pages');
  return (await db.query(`SELECT r.id,r.page_id,r.status,r.snapshot,r.source_hash,coalesce(r.processed_at,r.created_at) at,o.status order_status,
     p.customer_id,p.source_hash page_hash,p.location_id,p.delivery_method
   FROM ${T('agent_customer_page_requests')} r JOIN ${T('agent_customer_order_pages')} p ON p.workspace_id=r.workspace_id AND p.id=r.page_id
   LEFT JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
   WHERE r.workspace_id=$1 AND NOT coalesce(p.preorder_enabled,false) AND coalesce(r.processed_at,r.created_at)>=${window_}
     AND ((r.status='DRAFTED' AND NOT r.automatic AND r.processed_by=$2) OR r.status='STOPPED')`,[ctx.workspaceId,ctx.actorId,days])).rows
   .filter(r=>r.status==='STOPPED'||r.order_status==='CANCELLED'||CONFIRMED.includes(r.order_status))
   .map(r=>row(r.id,r.page_id+'|'+(r.snapshot?.quoteHash?hash(pages.scope(r,r)):'none'),r.at,{declined:r.status==='STOPPED'||r.order_status==='CANCELLED',variant:r.source_hash,data:r}));
 },
 async offer(db,ctx,{run}){
  const d=run.latest.data,p=(await db.query(`SELECT p.*,c.name customer FROM ${T('agent_customer_order_pages')} p LEFT JOIN customers c ON c.workspace_id=p.workspace_id AND c.id=p.customer_id
    WHERE p.workspace_id=$1 AND p.id=$2`,[ctx.workspaceId,d.page_id])).rows[0];
  if(!p?.enabled||new Date(p.expires_at).getTime()<=Date.now()||p.source_hash!==d.source_hash||p.authorized_by!==ctx.actorId)return null;
  const scopeHash=hash(require('../../sales/agent-customer-order-pages').scope(d,p));
  if((await db.query(`SELECT 1 FROM ${T('agent_customer_page_rules')} WHERE workspace_id=$1 AND page_id=$2 AND scope_hash=$3`,[ctx.workspaceId,p.id,scopeHash])).rowCount)return null;
  const lines=(d.snapshot?.input?.lines||[]).length;
  return {label:'Order from '+(p.customer||'this customer')+(p.label?' on '+p.label:''),limit:'this exact order ('+lines+(lines===1?' line':' lines')+', same prices and delivery), inside the page’s limits',
   href:'/autopilot/customer-order-pages',token:token({id:run.latest.id,page:p.id,revision:p.revision}),teach:{id:run.latest.id,page:p.id,routine:p.routine_enabled}};
 },
 async teach(s,ctx,offer){
  const pages=require('../../sales/agent-customer-order-pages');
  await pages.teach(s,ctx,offer.teach.id,{confirmed:'yes'});
  if(!offer.teach.routine){
   const page=(await s.query(`SELECT revision FROM ${T('agent_customer_order_pages')} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,offer.teach.page])).rows[0];
   await pages.configure(s,ctx,offer.teach.page,{revision:page.revision,confirmed:'yes'});
  }
 }
};

// Job 101: invoice paperwork the owner prepared for the same customer and
// currency. A declined draft is a "no"; changed customer details start again.
const customerInvoices={kind:'job:101',jobs:[101],label:'Customer invoice paperwork',tables:[T('agent_customer_invoice_documents'),T('agent_customer_invoice_examples'),T('agent_customer_invoice_rules')],
 async history(db,ctx,{days}){
  const kept=(await db.query(`SELECT d.id,d.source_snapshot->'document'->'row'->>'customer_id' customer_id,d.source_snapshot->'document'->'row'->>'currency' currency,
     d.source_snapshot->'document'->'row'->>'total_minor' total,d.source_snapshot->>'customerHash' customer_hash,e.reviewed_at at
   FROM ${T('agent_customer_invoice_documents')} d JOIN ${T('agent_customer_invoice_examples')} e ON e.workspace_id=d.workspace_id AND e.document_id=d.id
   WHERE d.workspace_id=$1 AND e.owner_id=$2 AND NOT d.automatic AND e.reviewed_at>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   .map(r=>row(r.id,r.customer_id+'|'+r.currency,r.at,{variant:r.customer_hash,value:r.total,data:r}));
  const declined=(await db.query(`SELECT p.id,i.customer_id,i.currency,coalesce(p.cancelled_at,p.created_at) at FROM ${T('assistant_action_proposals')} p
    JOIN accounting_customer_invoices i ON i.workspace_id=p.workspace_id AND i.id=p.payload->>'recordId'
   WHERE p.workspace_id=$1 AND p.action_type='customer_invoice.prepare_document' AND p.status='CANCELLED' AND p.actor_user_id=$2 AND p.created_at>=${window_}`,
  [ctx.workspaceId,ctx.actorId,days])).rows.map(r=>row(r.id,r.customer_id+'|'+r.currency,r.at,{declined:true}));
  return kept.concat(declined);
 },
 async offer(db,ctx,{run}){
  const d=run.latest.data;
  if((await db.query(`SELECT 1 FROM ${T('agent_customer_invoice_rules')} WHERE workspace_id=$1 AND customer_id=$2 AND currency=$3`,[ctx.workspaceId,d.customer_id,d.currency])).rowCount)return null;
  const most=maximum(run.rows,r=>r.value);if(!whole(most))return null;
  const customer=(await db.query('SELECT name FROM customers WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,d.customer_id])).rows[0];
  const input={revision:0,customerId:d.customer_id,currency:d.currency,maximum:money.fromMinor(most,d.currency),confirmed:'yes'};
  return {limitValue:most,label:'Invoice paperwork for '+(customer?.name||'this customer')+' ('+d.currency+')',limit:'invoices up to '+amount(most,d.currency),href:'/autopilot/customer-invoices',
   token:token(input),teach:input};
 },
 async teach(s,ctx,offer){await require('../../accounting/agent-customer-invoices').configure(s,ctx,offer.teach);}
};

// Job 111: returns the owner created from customer emails for the same
// customer, mailbox, products, place and resolution. Returns accepted outside
// the owner's return window or value limit always need a person.
const returnEmails={kind:'job:111',jobs:[111],label:'Returns from customer emails',tables:[T('agent_return_email_sources'),T('agent_return_email_rules'),T('agent_return_email_settings')],
 async history(db,ctx,{days}){
  const emails=require('../../sales/agent-customer-return-emails');
  return (await db.query(`SELECT s.message_id id,s.source_snapshot snap,s.created_at at,r.status return_status,
     (SELECT e.after_state->'outsidePolicy' FROM security_event_history e WHERE e.workspace_id=s.workspace_id AND e.reference=r.return_number
       AND e.action='Return created from a customer email after review' ORDER BY e.created_at DESC LIMIT 1) outside
   FROM ${T('agent_return_email_sources')} s JOIN customer_returns r ON r.workspace_id=s.workspace_id AND r.id=s.customer_return_id
   WHERE s.workspace_id=$1 AND NOT s.automatic AND s.processed_by=$2 AND s.source_snapshot IS NOT NULL AND s.created_at>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   .map(r=>row(r.id,hash(emails.bound(r.snap)),r.at,{declined:r.return_status==='CANCELLED',
    needsPerson:(Array.isArray(r.outside)?r.outside:[]).some(x=>!/^Save your return window/.test(x)),value:(r.snap.lines||[]).reduce((n,l)=>n+Number(l.quantity||0),0),data:r}));
 },
 async offer(db,ctx,{run}){
  if((await db.query(`SELECT 1 FROM ${T('agent_return_email_rules')} WHERE workspace_id=$1 AND scope_hash=$2`,[ctx.workspaceId,run.scope])).rowCount)return null;
  const settings=(await db.query(`SELECT * FROM ${T('agent_return_email_settings')} WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0];
  // Without the owner's routine settings a learned scope changes nothing.
  if(!settings?.enabled||settings.authorized_by!==ctx.actorId)return null;
  const most=maximum(run.rows,r=>r.value);if(!whole(most))return null;
  const units=Math.min(most,Number(settings.maximum_units)),p=run.latest.data.snap;
  const input={revision:0,confirmed:'yes',maximumUnits:String(units)};
  return {limitValue:units,label:'Returns from '+(p.customerName||'this customer')+' for '+(p.lines||[]).map(l=>l.code).join(', '),limit:'up to '+units+' units a return',runMaximum:most+' units',
   capped:units<most?'your routine return limit':null,href:'/sales/return-emails/'+encodeURIComponent(run.latest.id),token:token({id:run.latest.id,input}),teach:{id:run.latest.id,input}};
 },
 async teach(s,ctx,offer){await require('../../sales/agent-customer-return-emails').teach(s,ctx,offer.teach.id,offer.teach.input);}
};

// Job 113: restock or repair decisions the owner made by hand for the same
// product and checked condition. Scrap is a write-off and always needs a person.
const returnDecisions={kind:'job:113',jobs:[113],label:'Return restock or repair decisions',tables:[T('agent_return_assessments'),T('agent_return_disposition_rules')],
 async history(db,ctx,{days}){
  const rows=(await db.query(`SELECT a.id,a.status,a.observations,a.proposal,coalesce(a.applied_at,a.created_at) at,r.inspected_by_user_id
   FROM ${T('agent_return_assessments')} a JOIN customer_returns r ON r.workspace_id=a.workspace_id AND r.id=a.return_id
   WHERE a.workspace_id=$1 AND a.created_at>=${window_} AND ((a.status='APPLIED' AND a.applied_by=$2 AND a.proposal->>'automatic'='false'
     AND coalesce(a.proposal->>'byRules','false')='false') OR a.status='STOPPED')`,[ctx.workspaceId,ctx.actorId,days])).rows;
  const out=[];
  for(const a of rows)for(const o of a.observations||[]){
   const line=(a.proposal?.lines||[]).find(l=>l.lineId===o.lineId);
   out.push(row(a.id+'#'+o.lineId,o.skuId+'|'+o.conditionCode,a.at,{declined:a.status==='STOPPED',needsPerson:a.status==='APPLIED'&&(!line||line.outcome==='SCRAP'),
    variant:line?line.outcome+'|'+(line.destinationId||''):null,value:o.quantity,data:{assessmentId:a.id,observation:o,line,inspector:a.inspected_by_user_id}}));
  }
  return out;
 },
 async offer(db,ctx,{run}){
  const o=run.latest.data.observation,line=run.latest.data.line;
  if((await db.query(`SELECT 1 FROM ${T('agent_return_disposition_rules')} WHERE workspace_id=$1 AND sku_id=$2 AND condition_code=$3`,[ctx.workspaceId,o.skuId,o.conditionCode])).rowCount)return null;
  // The rule covers no more units than its example, so the example is the largest.
  const example=largest(run.rows.filter(r=>r.data.inspector===ctx.actorId),r=>r.value),units=Number(example?.value);
  if(!whole(units))return null;
  const place=line.destinationId?(await db.query('SELECT name FROM locations WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,line.destinationId])).rows[0]?.name:null;
  const rule={skuId:o.skuId,conditionCode:o.conditionCode,conditionLabel:o.conditionCode,outcome:line.outcome,destinationId:line.destinationId||'',maximumUnits:String(units),confirmed:'yes'};
  return {limitValue:units,label:(line.outcome==='RESTOCK'?'Restock ':'Repair ')+o.sku+' returned '+o.conditionCode+(place?' to '+place:''),limit:'up to '+units+' units a return',
   href:'/operations/return-dispositions',token:token({rule,example:example.data.assessmentId}),teach:{rule,example:example.data.assessmentId}};
 },
 async teach(s,ctx,offer){
  const returns=require('../../operations/agent-return-disposition'),{id}=await returns.saveRule(s,ctx,offer.teach.rule);
  const rule=(await s.query(`SELECT revision FROM ${T('agent_return_disposition_rules')} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id])).rows[0];
  await returns.configure(s,ctx,id,{revision:rule.revision,exampleId:offer.teach.example,confirmed:'yes'});
 }
};

module.exports=[carrierClaims,vanRoutes,checkIns,orderPages,customerInvoices,returnEmails,returnDecisions];
