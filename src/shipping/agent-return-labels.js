'use strict';
// Job 112: once a return is authorized, StockChief prepares the return parcel
// from the customer's address (the address the order was delivered to, as
// cleared by the job 69 address check) back to the warehouse, buys the
// cheapest current label through the connected carrier account within the
// job 59 label limits, then emails the customer the label and instructions
// through the connected mailbox (agent-return-instructions).
//
// Growth prepares each one for a tap until the owner teaches a rule from an
// approved, provider-confirmed send. Pro and Custom act alone, within the
// owner's $ per label and any lower rule. Pause, Watch only, Ask me first and
// the first 14 days leave the label for one tap. Missing or mismatched facts
// (no carrier shipment, an unconfirmed address, no parcel weight, no rates,
// no single sending mailbox) stop and ask in Needs you.
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');
const money=require('../domain/currency');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {newId}=require('../lib/util');

const JOB=112,KIND='agent.return-labels.v1',action='customer_return.send_label';
const runs='stockchief_runtime.agent_label_runs',FRESH_MS=30*60_000,RETRY_MS=60*60_000;
const LABEL_BUSY=['PURCHASED','PENDING','REVIEW','VOID_PENDING'];
const shipping=()=>require('./postgres-service'),parcels=()=>require('./postgres-return-parcels'),instructions=()=>require('./agent-return-instructions');
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
const expected=e=>e instanceof ValidationError||['validation_error','entitlement_required','forbidden'].includes(e?.code)||[400,402,403,404,422].includes(e?.status);
const installed=db=>require('../db/schema-installed').has(db,runs);
const routeKey=(locationId,connectorId)=>'return-route:'+encodeURIComponent(locationId)+':'+encodeURIComponent(connectorId);

async function ownerUser(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL ORDER BY u.created_at,u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}
async function requireOwner(db,ctx){
  const found=await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId]);
  if(!found.rowCount)throw new AuthorizationError('Only the inventory owner can approve return labels.');
}

// The owner's saved rule: returns to one location, sent from one mailbox, up
// to a goods value. Growth needs it to act alone; on Pro and Custom it only
// names the mailbox and lowers the limit.
async function routeRule(db,workspaceId){
  const row=(await db.query(`SELECT r.* FROM stockchief_runtime.agent_draft_rules r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.role='owner'
    WHERE r.workspace_id=$1 AND r.action_type=$2 AND r.scope_key LIKE 'return-route:%' ORDER BY r.scope_key LIMIT 1`,[workspaceId,action])).rows[0];
  if(!row)return null;
  const [,location,connector]=row.scope_key.split(':');
  return {...row,locationId:decodeURIComponent(location),connectorId:decodeURIComponent(connector),maximum:Number(row.maximum_minor)};
}
async function senders(db,workspaceId){
  return (await db.query(`SELECT id,display_name FROM workspace_connectors WHERE workspace_id=$1 AND status='connected' AND paused_at IS NULL
    AND setup_status IS DISTINCT FROM 'REAUTHORIZATION_REQUIRED' AND provider_type IN ('gmail','microsoft365') AND provider_account_id IS NOT NULL
    AND capabilities::jsonb ?| array['MAIL_SEND','mail:send'] ORDER BY display_name,id LIMIT 25`,[workspaceId])).rows;
}
function mailboxFor(list,route){
  if(route&&list.some(m=>m.id===route.connectorId))return route.connectorId;
  return list.length===1?list[0].id:null;
}

// How far StockChief may go right now for return labels, or why a person taps.
async function authority(db,workspaceId){
  const account=await policy.accountState(db,workspaceId),plan=policy.usesAgentTerms(account)?account.plan:null;
  if(!plan||!policy.permits(plan,JOB,'draft'))return {plan:null,account};
  const route=await routeRule(db,workspaceId);
  let hold=null;
  if(!policy.permits(plan,JOB,'automatic',{trained:Boolean(route)}))hold='Approve this label. After you approve one and the email is sent, you can let StockChief send return labels on its own.';
  hold=hold||await policy.stopped(db,workspaceId,account,action,true);
  if(!hold&&!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)hold='Routine work is off. Approve this label, or choose Handle routine work in StockChief AI.';
  if(!hold&&!policy.permits(plan,59,'automatic'))hold='Your plan does not buy labels on its own. Approve this label.';
  if(!hold)hold=await policy.stopped(db,workspaceId,account,'shipping.label',true);
  if(!hold&&plan!=='growth'&&(await require('./postgres-purchase-policy').get(db,workspaceId))?.per_label_minor==null)
    hold='Set your $ per label in Shipping settings so StockChief can buy return labels on its own. Until then, approve each one.';
  return {plan,account,route,hold};
}

// A return needs a label only when its goods went out with a carrier.
const CANDIDATES=`SELECT r.id FROM customer_returns r WHERE r.workspace_id=$1 AND r.status='AUTHORIZED'
  AND EXISTS(SELECT 1 FROM sales_shipments o WHERE o.workspace_id=r.workspace_id AND o.sales_order_id=r.sales_order_id AND o.customer_return_id IS NULL
    AND o.status IN ('SHIPPED','DELIVERED') AND o.handover='CARRIER')
  AND NOT EXISTS(SELECT 1 FROM sales_shipments s WHERE s.workspace_id=r.workspace_id AND s.customer_return_id=r.id AND s.status<>'CANCELLED'
    AND coalesce(s.label_status,'') IN ('PURCHASED','PENDING','REVIEW','VOID_PENDING'))
  AND NOT EXISTS(SELECT 1 FROM sales_shipments s JOIN ${runs} x ON x.workspace_id=s.workspace_id AND x.shipment_id=s.id
    WHERE s.workspace_id=r.workspace_id AND s.customer_return_id=r.id AND s.status<>'CANCELLED' AND x.status='DECLINED')`;
// Labels StockChief bought (alone or after a tap) whose email has not gone out.
const SENDABLE=`SELECT DISTINCT ON (s.id) s.id shipment_id,s.customer_return_id,x.* FROM sales_shipments s
  JOIN customer_returns r ON r.workspace_id=s.workspace_id AND r.id=s.customer_return_id AND r.status='AUTHORIZED'
  JOIN ${runs} x ON x.workspace_id=s.workspace_id AND x.shipment_id=s.id
  WHERE s.workspace_id=$1 AND s.status='PACKED' AND s.label_status='PURCHASED' AND x.status='QUEUED'
    AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=s.workspace_id AND e.kind='mail.outbound.send'
      AND e.payload->'standingAuthority'->>'kind'='return_label' AND e.payload->'standingAuthority'->>'shipmentId'=s.id AND e.status<>'CANCELLED')
  ORDER BY s.id,x.updated_at DESC`;

// The facts a return label needs before a parcel exists.
async function preflight(db,workspaceId,rma){
  const outbound=(await db.query(`SELECT ship_to_address,handover FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2 AND customer_return_id IS NULL
    AND status IN ('SHIPPED','DELIVERED') ORDER BY shipped_at DESC,id`,[workspaceId,rma.sales_order_id])).rows;
  if(!outbound.some(o=>o.handover==='CARRIER'))return 'No parcel went out with a carrier on this order, so there is no address to collect the return from.';
  if(new Set(outbound.map(o=>o.ship_to_address)).size>1)return 'This order went to more than one address. Prepare the return parcel on the return yourself.';
  return null;
}
// Job 69: the return is collected from the address the goods went to, and that
// address must have passed its address check or been confirmed by a person.
async function addressHold(db,workspaceId,shipment){
  const outbound=(await db.query('SELECT id,ship_to_address,ship_to_address_fields FROM sales_shipments WHERE workspace_id=$1 AND id=$2',[workspaceId,shipment.return_outbound_shipment_id])).rows[0];
  if(!outbound)return 'The original parcel for this return is missing.';
  const sent=require('./address').parse(outbound.ship_to_address,outbound.ship_to_address_fields),origin=shipment.return_origin||{},validation=require('./address-validation');
  if(!origin.complete||!sent.complete)return 'The customer’s address is incomplete. Complete it before a return label is bought.';
  if(validation.key(sent)!==validation.key(origin))return 'The return would be collected from a different address than the order went to. Check the customer’s address.';
  if(await require('../db/schema-installed').has(db,'stockchief_runtime.agent_address_checks')){
    const check=(await db.query(`SELECT hold,hold_reason,decision FROM stockchief_runtime.agent_address_checks WHERE workspace_id=$1 AND shipment_id=$2 AND address=$3
      ORDER BY checked_at DESC LIMIT 1`,[workspaceId,outbound.id,outbound.ship_to_address])).rows[0];
    if(check?.hold&&!['KEPT','ACCEPTED','FORMATTED'].includes(check.decision))return 'The address check flagged the customer’s address and nobody confirmed it. '+check.hold_reason;
  }
  return null;
}
// The return parcel uses the original parcel's measured size and weight: the
// returned goods are some or all of what was in it, so it is never too light.
async function weigh(db,ctx,view){
  const svc=shipping();
  if(view.boxes.length===1&&!view.boxes[0].estimated&&view.boxes[0].weightGrams>0)return null;
  const original=await svc.packagesFor(db,ctx.workspaceId,view.shipment.return_outbound_shipment_id);
  if(original.length!==1||original[0].estimated||!(original[0].weightGrams>0))return 'Enter the weight of the return parcel. The original parcel has no single measured weight to use.';
  const box=original[0];
  await svc.setPackages(db,ctx,view.shipment.id,[{weightGrams:box.weightGrams,lengthMm:box.lengthMm,widthMm:box.widthMm,heightMm:box.heightMm}]);
  await audit.record(db,ctx,{action:'Used the original parcel’s measured weight for a return label',reference:view.shipment.shipment_number,after:{weightGrams:box.weightGrams}});
  return null;
}
async function goods(db,workspaceId,returnId){
  const rows=(await db.query(`SELECT r.quantity_authorized-r.quantity_received AS quantity,o.unit_price_minor FROM customer_return_lines r
    JOIN sales_order_lines o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_line_id WHERE r.workspace_id=$1 AND r.customer_return_id=$2 AND r.quantity_authorized>r.quantity_received`,[workspaceId,returnId])).rows;
  if(!rows.length||rows.some(r=>r.unit_price_minor==null))return null;
  return money.sum(rows.map(r=>require('../domain/exact-quantity').costMinor(Number(r.quantity),Number(r.unit_price_minor))));
}
// Checks for this one return before StockChief buys its label alone.
async function returnHold(db,workspaceId,rma,auth,mailbox){
  if(!mailbox)return 'Several mailboxes can send email. Approve this label and choose the mailbox for the email.';
  const customer=(await db.query(`SELECT c.email,c.record_state,o.contact_email,o.currency FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    WHERE o.workspace_id=$1 AND o.id=$2`,[workspaceId,rma.sales_order_id])).rows[0];
  if(!customer||customer.record_state!=='ACTIVE'||!customer.contact_email||customer.contact_email.toLowerCase()!==String(customer.email||'').toLowerCase())
    return 'Confirm the customer’s current email address before a return label is sent.';
  if(!await instructions().knownRecipient(db,workspaceId,rma.id,customer.contact_email))return 'This would be the first email to this customer’s address. Approve it yourself.';
  const value=await goods(db,workspaceId,rma.id);
  if(!(value>0))return 'An item on this return has no price. Approve this label yourself.';
  if(auth.route&&(auth.route.currency!==customer.currency||value>auth.route.maximum))return 'The returned goods are worth more than the '+money.format(auth.route.maximum,auth.route.currency)+' your rule allows.';
  return null;
}

async function current(db,workspaceId,shipmentId,fingerprint,lock=false){
  return (await db.query(`SELECT * FROM ${runs} WHERE workspace_id=$1 AND shipment_id=$2 AND fingerprint=$3${lock?' FOR UPDATE':''}`,[workspaceId,shipmentId,fingerprint])).rows[0]||null;
}
async function latest(db,workspaceId,shipmentId){
  return (await db.query(`SELECT * FROM ${runs} WHERE workspace_id=$1 AND shipment_id=$2 ORDER BY updated_at DESC,id DESC LIMIT 1`,[workspaceId,shipmentId])).rows[0]||null;
}
// One row per return parcel as quoted; a queued or declined choice is never rewritten.
async function save(db,ctx,view,fingerprint,fields){
  return tx(db,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['agent-label:'+view.shipment.id]);
    const before=await current(c,ctx.workspaceId,view.shipment.id,fingerprint,true);
    if(before&&['QUEUED','DECLINED'].includes(before.status))return before;
    const pick=fields.pick;
    const row=(await c.query(`INSERT INTO ${runs}(id,workspace_id,shipment_id,fingerprint,status,mode,rate_id,carrier,service,amount_minor,currency,arrival_date,guaranteed,hold,reason,label_reason,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
      ON CONFLICT(workspace_id,shipment_id,fingerprint) DO UPDATE SET status=EXCLUDED.status,mode=EXCLUDED.mode,rate_id=EXCLUDED.rate_id,carrier=EXCLUDED.carrier,service=EXCLUDED.service,
        amount_minor=EXCLUDED.amount_minor,currency=EXCLUDED.currency,arrival_date=EXCLUDED.arrival_date,guaranteed=EXCLUDED.guaranteed,hold=EXCLUDED.hold,reason=EXCLUDED.reason,label_reason=EXCLUDED.label_reason,updated_at=now()
      RETURNING *`,[newId('labelrun'),ctx.workspaceId,view.shipment.id,fingerprint,fields.status,fields.mode,pick?.id||null,pick?.carrier||null,pick?.service||null,
      pick?Number(pick.amount_minor):null,pick?.currency||null,pick?.delivery_date||null,pick?Boolean(pick.guaranteed):null,fields.hold||null,fields.reason||null,fields.labelReason||null])).rows[0];
    if(!before||before.status!==row.status||before.rate_id!==row.rate_id||before.reason!==row.reason||before.label_reason!==row.label_reason)
      await audit.record(c,ctx,{action:row.status==='HELD'?'Held a return label':row.status==='CHOSEN'?'Chose a return label within your limits':'Prepared a return label for approval',
        reference:view.shipment.shipment_number,before:before?{status:before.status}:{},after:{status:row.status,mode:row.mode,carrier:row.carrier,service:row.service,amountMinor:row.amount_minor,currency:row.currency,reason:row.reason||row.label_reason}});
    return row;
  });
}
const held=(db,ctx,view,fingerprint,mode,hold,reason)=>save(db,ctx,view,fingerprint,{status:'HELD',mode,hold,reason});
function cheapest(view,fingerprint){
  return view.rates.filter(r=>r.parcel_fingerprint===fingerprint&&r.currency===view.shipment.currency&&Date.now()-Date.parse(r.quoted_at)<=FRESH_MS)
    .sort((a,b)=>Number(a.amount_minor)-Number(b.amount_minor)||(a.delivery_days??99)-(b.delivery_days??99)||String(a.id).localeCompare(String(b.id)))[0]||null;
}

// Decide one authorized return: prepare its parcel, check it, quote it, and
// buy the label alone or prepare it for one tap.
async function evaluate(database,workspaceId,returnId,{auth,owner,providerResolver}={}){
  const svc=shipping(),ctx={workspaceId,actorId:owner};
  const rma=(await database.query('SELECT * FROM customer_returns WHERE workspace_id=$1 AND id=$2',[workspaceId,returnId])).rows[0];
  if(!rma||rma.status!=='AUTHORIZED')return null;
  let parcel=await parcels().current(database,workspaceId,returnId);
  if(!parcel){
    const problem=await preflight(database,workspaceId,rma);if(problem)return {held:true,reason:problem};
    try{parcel={id:(await parcels().prepare(database,ctx,returnId,auth.route?{locationId:auth.route.locationId}:{})).shipmentId};}
    catch(error){if(!expected(error))throw error;return {held:true,reason:error.message};}
    await audit.record(database,ctx,{action:'Prepared a return parcel from the customer’s address',reference:rma.return_number,after:{shipmentId:parcel.id}});
  }
  let view=await svc.state(database,workspaceId,parcel.id);
  if(view.shipment.status!=='PACKED'||LABEL_BUSY.includes(view.shipment.label_status))return null;
  const mode=auth.hold?'draft':'automatic';
  const weight=await weigh(database,ctx,view);
  if(weight)return held(database,ctx,view,svc.quoteFingerprint(view),mode,'parcel',weight);
  view=await svc.state(database,workspaceId,parcel.id);
  let fingerprint=svc.quoteFingerprint(view),run=await current(database,workspaceId,parcel.id,fingerprint);
  if(run&&['QUEUED','DECLINED'].includes(run.status))return run;
  const address=await addressHold(database,workspaceId,view.shipment);
  if(address)return held(database,ctx,view,fingerprint,mode,'address',address);
  if(!view.ready)return held(database,ctx,view,fingerprint,mode,'parcel',view.blocked.join(' '));
  if(!cheapest(view,fingerprint)){
    if(run?.status==='HELD'&&run.hold==='rates'&&Date.now()-Date.parse(run.updated_at)<RETRY_MS)return run;
    try{await svc.quote(database,ctx,parcel.id,{idempotencyKey:'agent-return-rates:'+parcel.id+':'+newId('quote'),providerResolver});}
    catch(error){if(!expected(error))throw error;return held(database,ctx,view,fingerprint,mode,'rates','Return rates could not be fetched: '+error.message);}
    view=await svc.state(database,workspaceId,parcel.id);fingerprint=svc.quoteFingerprint(view);run=await current(database,workspaceId,parcel.id,fingerprint);
    if(run&&['QUEUED','DECLINED'].includes(run.status))return run;
  }
  const pick=cheapest(view,fingerprint);
  if(!pick)return held(database,ctx,view,fingerprint,mode,'rates','No current carrier rates came back for this return parcel.');
  const mailbox=mailboxFor(await senders(database,workspaceId),auth.route);
  const reason=auth.hold||await returnHold(database,workspaceId,rma,auth,mailbox);
  if(reason)return save(database,ctx,view,fingerprint,{status:'SUGGESTED',mode:'draft',pick,labelReason:reason});
  run=await save(database,ctx,view,fingerprint,{status:'CHOSEN',mode:'automatic',pick});
  if(run.status!=='CHOSEN')return run;
  let queued;
  try{queued=await svc.queueLabelPurchase(database,{...ctx,agentPostageScope:'automatic'},parcel.id,run.rate_id,{idempotencyKey:'agent-return-label:'+run.id});}
  catch(error){
    if(!expected(error))throw error;
    return (await database.query(`UPDATE ${runs} SET status='SUGGESTED',mode='draft',label_reason=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status='CHOSEN' RETURNING *`,
      [workspaceId,run.id,error.message])).rows[0]||run;
  }
  return tx(database,async c=>{
    const row=(await c.query(`UPDATE ${runs} SET status='QUEUED',effect_id=$3,transaction_id=$4,label_reason=NULL,updated_at=now()
      WHERE workspace_id=$1 AND id=$2 AND status='CHOSEN' RETURNING *`,[workspaceId,run.id,queued.effectId||null,queued.transactionId||null])).rows[0]||run;
    await audit.record(c,ctx,{action:'Bought a return label within your limits',reference:rma.return_number,before:{status:'CHOSEN'},
      after:{carrier:run.carrier,service:run.service,amountMinor:Number(run.amount_minor),currency:run.currency,effectId:queued.effectId||null,automatic:true}});
    return row;
  });
}

// Once the label is bought, email it. A label StockChief bought alone is sent
// alone; one a person approved is sent on that person's approval.
async function deliver(database,workspaceId,row,{owner,auth,connectorId=null,actorId=null}={}){
  const automatic=!row.decided_by&&!actorId,actor=actorId||row.decided_by||owner,ctx={workspaceId,actorId:actor};
  const mailbox=connectorId||mailboxFor(await senders(database,workspaceId),auth?.route||await routeRule(database,workspaceId));
  const note=reason=>database.query(`UPDATE ${runs} SET reason=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status='QUEUED' AND reason IS DISTINCT FROM $3`,[workspaceId,row.id,reason]);
  if(!mailbox){await note('Choose the mailbox that sends this return label.');return {held:true};}
  try{
    const p=await instructions().facts(database,ctx,row.customer_return_id,mailbox);
    const sent=await tx(database,async c=>{
      const result=await instructions().execute(c,{...ctx,agentReturnLabelScope:automatic?'automatic':'individual'},p);
      await c.query(`UPDATE ${runs} SET reason=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2`,[workspaceId,row.id]);
      if(!result.replayed)await audit.record(c,ctx,{action:automatic?'Emailed the return label and instructions on its own':'Emailed the return label and instructions after approval',
        reference:p.returnNumber,after:{recipient:p.recipient,communicationId:result.communicationId,tracking:p.tracking,automatic}});
      return result;
    });
    return sent;
  }catch(error){if(!expected(error))throw error;await note(String(error.message).slice(0,500));return {held:true,reason:error.message};}
}

async function run(database,job,options={}){
  const workspaceId=job.workspaceId;
  if(!await installed(database))return {skipped:'not_installed'};
  const auth=await authority(database,workspaceId);if(!auth.plan)return {skipped:'plan'};
  const owner=await ownerUser(database,workspaceId);if(!owner)return {skipped:'owner'};
  const result={checked:0,held:0,suggested:0,queued:0,sent:0};
  for(const {id} of (await database.query(CANDIDATES+' ORDER BY r.authorized_at,r.id LIMIT 25',[workspaceId])).rows){
    let row;try{row=await evaluate(database,workspaceId,id,{auth,owner,providerResolver:options.providerResolver});}
    catch(error){if(!expected(error))throw error;result.held++;continue;}
    if(!row)continue;result.checked++;
    if(row.held||row.status==='HELD')result.held++;else if(row.status==='SUGGESTED')result.suggested++;else if(row.status==='QUEUED')result.queued++;
  }
  for(const row of (await database.query(SENDABLE+' LIMIT 25',[workspaceId])).rows){
    const sent=await deliver(database,workspaceId,row,{owner,auth});if(sent?.communicationId)result.sent++;
  }
  return result;
}
async function schedule(c,workspaceId,cycleId){
  if(!await installed(c))return {queued:false};
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {queued:false};
  if(!(await c.query(`SELECT 1 FROM (SELECT 1 FROM (${CANDIDATES}) a UNION ALL SELECT 1 FROM (${SENDABLE}) b) waiting LIMIT 1`,[workspaceId])).rowCount)return {queued:false};
  await jobs.enqueue(scoped(c),{workspaceId,kind:KIND,idempotencyKey:'return-labels:cycle:'+cycleId,payload:{cycleId},priority:45,maxAttempts:3});
  return {queued:true};
}
// A new authorized return is looked at straight away rather than next cycle.
async function kick(c,workspaceId,returnId){
  if(!await installed(c))return {queued:false};
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {queued:false};
  await jobs.enqueue(scoped(c),{workspaceId,kind:KIND,idempotencyKey:'return-labels:return:'+returnId,payload:{returnId},priority:45,maxAttempts:3});
  return {queued:true};
}

// One tap: buy the prepared label. A stale quote is fetched again; a dearer or
// different answer is shown instead of bought. The email follows the label.
async function approve(database,ctx,returnId,input={},options={}){
  await requireOwner(database,ctx);
  const state=await policy.requireWorkspaceJob(database,ctx.workspaceId,JOB,'draft'),blocked=await policy.stopped(database,ctx.workspaceId,state,action,false);
  if(blocked)throw new ValidationError(blocked);
  const svc=shipping(),parcel=await parcels().current(database,ctx.workspaceId,returnId);
  if(!parcel)throw new ValidationError('This return has no prepared parcel. Open the return again.');
  let view=await svc.state(database,ctx.workspaceId,parcel.id);
  const run=(await database.query(`SELECT * FROM ${runs} WHERE workspace_id=$1 AND shipment_id=$2 AND id=$3`,[ctx.workspaceId,parcel.id,input.runId])).rows[0];
  if(run?.status==='QUEUED')return {queued:true,replayed:true,run};
  if(input.confirmed!=='yes'||!run||run.fingerprint!==svc.quoteFingerprint(view)||!['SUGGESTED','CHOSEN'].includes(run.status))
    throw new ValidationError('This return label changed. Open the return again to see the current one.');
  let rate=view.rates.find(r=>r.id===run.rate_id);
  if(!rate||Date.now()-Date.parse(rate.quoted_at)>FRESH_MS){
    await svc.quote(database,ctx,parcel.id,{idempotencyKey:'agent-return-rates:'+run.id+':'+newId('quote'),providerResolver:options.providerResolver});
    view=await svc.state(database,ctx.workspaceId,parcel.id);
    if(svc.quoteFingerprint(view)!==run.fingerprint)throw new ValidationError('The return parcel changed. Open the return again.');
    const pick=cheapest(view,run.fingerprint);
    if(!pick||pick.carrier!==run.carrier||pick.service!==run.service||Number(pick.amount_minor)>Number(run.amount_minor)){
      const updated=pick?await save(database,ctx,view,run.fingerprint,{status:'SUGGESTED',mode:run.mode,pick,labelReason:run.label_reason}):await held(database,ctx,view,run.fingerprint,run.mode,'rates','No current carrier rates came back for this return parcel.');
      return {changed:true,run:updated};
    }
    rate=pick;
  }
  const queued=await svc.queueLabelPurchase(database,{...ctx,agentPostageScope:'individual'},parcel.id,rate.id,{idempotencyKey:'agent-return-label:'+run.id});
  const row=await tx(database,async c=>{
    const updated=(await c.query(`UPDATE ${runs} SET status='QUEUED',rate_id=$3,amount_minor=$4,decided_by=$5,decided_at=now(),effect_id=$6,transaction_id=$7,label_reason=NULL,updated_at=now()
      WHERE workspace_id=$1 AND id=$2 RETURNING *`,[ctx.workspaceId,run.id,rate.id,Number(rate.amount_minor),ctx.actorId,queued.effectId||null,queued.transactionId||null])).rows[0];
    await audit.record(c,ctx,{action:'Approved a return label',reference:view.shipment.shipment_number,before:{status:run.status},after:{carrier:updated.carrier,service:updated.service,amountMinor:updated.amount_minor,currency:updated.currency}});
    return updated;
  });
  return {queued:true,replayed:Boolean(queued.replayed),run:row};
}
// One tap: email a bought label that is waiting (for a mailbox choice, pause or approval).
async function send(database,ctx,returnId,input={}){
  await requireOwner(database,ctx);
  if(input.confirmed!=='yes')throw new ValidationError('Confirm sending this return label to the customer.');
  const row=(await database.query(`SELECT * FROM (${SENDABLE}) s WHERE customer_return_id=$2`,[ctx.workspaceId,returnId])).rows[0];
  if(!row)throw new ValidationError('This return label was already emailed, or it is not bought yet.');
  const list=await senders(database,ctx.workspaceId),connectorId=input.connectorId||mailboxFor(list,await routeRule(database,ctx.workspaceId));
  if(!list.some(m=>m.id===connectorId))throw new ValidationError('Choose the mailbox that sends this return label.');
  const result=await deliver(database,ctx.workspaceId,row,{connectorId,actorId:ctx.actorId});
  if(result?.held)throw new ValidationError(result.reason||'The email could not be sent.');
  return result;
}
async function dismiss(database,ctx,returnId,input={}){
  await requireOwner(database,ctx);
  return tx(database,async c=>{
    const row=(await c.query(`UPDATE ${runs} x SET status='DECLINED',decided_by=$3,decided_at=now(),updated_at=now() FROM sales_shipments s
      WHERE x.workspace_id=$1 AND x.id=$4 AND s.workspace_id=x.workspace_id AND s.id=x.shipment_id AND s.customer_return_id=$2 AND x.status IN ('SUGGESTED','CHOSEN','HELD') RETURNING x.*`,
      [ctx.workspaceId,returnId,ctx.actorId,input.runId])).rows[0];
    if(!row)throw new ValidationError('This return label changed. Open the return again.');
    await audit.record(c,ctx,{action:'Declined a return label',reference:returnId,before:{status:'SUGGESTED'},after:{status:'DECLINED'}});
    return row;
  });
}

// Growth learns from an approved label whose email the mailbox confirmed sent.
async function example(db,workspaceId,locationId,connectorId){
  return Boolean((await db.query(`SELECT 1 FROM ${runs} r JOIN sales_shipments s ON s.workspace_id=r.workspace_id AND s.id=r.shipment_id AND s.customer_return_id IS NOT NULL
    JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.decided_by AND u.role='owner'
    JOIN stockchief_runtime.provider_effects e ON e.workspace_id=r.workspace_id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
      AND e.payload->'standingAuthority'->>'kind'='return_label' AND e.payload->'standingAuthority'->>'shipmentId'=r.shipment_id
      AND e.payload->'standingAuthority'->>'automatic'='false' AND e.payload->'standingAuthority'->>'connectorId'=$3
    JOIN customer_communications m ON m.workspace_id=e.workspace_id AND m.id=e.aggregate_id AND m.status='SENT' AND m.external_message_id IS NOT NULL
    WHERE r.workspace_id=$1 AND r.status='QUEUED' AND s.ship_from_location_id=$2 LIMIT 1`,[workspaceId,locationId,connectorId])).rowCount);
}
async function configure(database,ctx,input={}){
  return tx(database,async c=>{
    await requireOwner(c,ctx);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft'),prior=await routeRule(c,ctx.workspaceId);
    if(input.remove==='yes'){
      await c.query(`DELETE FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key LIKE 'return-route:%'`,[ctx.workspaceId,action]);
      if(prior)await audit.record(c,ctx,{action:'Return label rule removed',before:{locationId:prior.locationId,connectorId:prior.connectorId,maximumMinor:prior.maximum}});
      return {removed:Boolean(prior)};
    }
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the return location, mailbox and goods limit.');
    if(state.shadow)throw new ValidationError('StockChief is watching during the first 14 days. Save this rule after shadow mode.');
    const location=(await c.query('SELECT id,name,address FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,input.locationId])).rows[0];
    if(!location||!require('./address').parse(location.address).complete)throw new ValidationError('Choose an active location with a full address for returns.');
    if(!(await senders(c,ctx.workspaceId)).some(m=>m.id===input.connectorId))throw new ValidationError('Choose a connected mailbox that can send email.');
    const currency=money.code(input.currency||'USD'),maximum=money.userToMinor(input.maximum,currency,{label:'Goods limit'});
    if(!(maximum>0))throw new ValidationError('Enter a positive goods limit.');
    if(state.plan==='growth'&&!await example(c,ctx.workspaceId,location.id,input.connectorId))
      throw new ValidationError('Approve one return label to this location and wait until its email is sent from this mailbox. Then you can teach this rule.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?0:1);
    await c.query(`DELETE FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key LIKE 'return-route:%'`,[ctx.workspaceId,action]);
    await c.query(`INSERT INTO stockchief_runtime.agent_draft_rules(workspace_id,action_type,scope_key,scope_label,currency,maximum_minor,authorized_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.workspaceId,action,routeKey(location.id,input.connectorId),'Return labels to '+location.name,currency,maximum,ctx.actorId]);
    await audit.record(c,ctx,{action:'Return label rule saved',before:prior?{locationId:prior.locationId,connectorId:prior.connectorId,maximumMinor:prior.maximum}:{},after:{locationId:location.id,connectorId:input.connectorId,maximumMinor:maximum,currency}});
    return {saved:true};
  });
}
// A saved rule matching this exact route and value, for the email authority check.
async function routeFor(db,workspaceId,p){
  const route=await routeRule(db,workspaceId);
  if(!route||route.locationId!==p.returnLocationId||route.connectorId!==p.connectorId)return {route:null,within:false};
  return {route,within:route.currency===p.currency&&p.goodsValueMinor<=route.maximum};
}

// What the return page shows.
async function view(db,workspaceId,returnId){
  if(!await installed(db))return null;
  const account=await policy.accountState(db,workspaceId),plan=policy.usesAgentTerms(account)?account.plan:null;
  if(!plan)return null;
  if(!policy.permits(plan,JOB,'draft'))return {locked:true};
  const rma=(await db.query('SELECT * FROM customer_returns WHERE workspace_id=$1 AND id=$2',[workspaceId,returnId])).rows[0];
  if(!rma)throw new NotFoundError('That customer return is not in this inventory.');
  const parcel=await parcels().current(db,workspaceId,returnId),run=parcel?await latest(db,workspaceId,parcel.id):null,route=await routeRule(db,workspaceId),mailboxes=await senders(db,workspaceId);
  const email=parcel?(await db.query(`SELECT m.status,m.recipient FROM stockchief_runtime.provider_effects e JOIN customer_communications m ON m.workspace_id=e.workspace_id AND m.id=e.aggregate_id
    WHERE e.workspace_id=$1 AND e.kind='mail.outbound.send' AND e.payload->'standingAuthority'->>'kind'='return_label' AND e.payload->'standingAuthority'->>'shipmentId'=$2 AND e.status<>'CANCELLED'
    ORDER BY e.created_at DESC LIMIT 1`,[workspaceId,parcel.id])).rows[0]:null;
  const shipment=parcel?(await db.query('SELECT label_status,ship_from_location_id FROM sales_shipments WHERE workspace_id=$1 AND id=$2',[workspaceId,parcel.id])).rows[0]:null;
  const waiting=rma.status==='AUTHORIZED'&&!parcel?await preflight(db,workspaceId,rma):null;
  const price=run?.amount_minor!=null?money.format(Number(run.amount_minor),run.currency):null;
  const choice=run?.carrier?require('../sales/carriers').displayName(run.carrier)+' '+run.service+(price?' at '+price:''):null;
  const sentFrom=parcel?(await db.query(`SELECT e.payload->'standingAuthority'->>'connectorId' c FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=$1 AND e.kind='mail.outbound.send'
    AND e.payload->'standingAuthority'->>'kind'='return_label' AND e.payload->'standingAuthority'->>'shipmentId'=$2 ORDER BY e.created_at DESC LIMIT 1`,[workspaceId,parcel.id])).rows[0]?.c:null;
  const canTeach=plan!=='starter'&&!route&&Boolean(email?.status==='SENT'&&run?.decided_by&&sentFrom)&&await example(db,workspaceId,shipment.ship_from_location_id,sentFrom);
  return {plan,run,choice,price,email,waiting,route,mailboxes,canTeach,teachLocationId:shipment?.ship_from_location_id||null,
    teachConnectorId:canTeach?sentFrom:null,
    canApprove:Boolean(run&&['SUGGESTED','CHOSEN'].includes(run.status)&&run.mode!=='watch'),
    canSend:Boolean(run&&run.status==='QUEUED'&&shipment?.label_status==='PURCHASED'&&!email&&rma.status==='AUTHORIZED'),
    labelBought:shipment?.label_status==='PURCHASED',alone:plan!=='growth'||Boolean(route),currency:(await db.query('SELECT currency FROM sales_orders WHERE workspace_id=$1 AND id=$2',[workspaceId,rma.sales_order_id])).rows[0]?.currency||'USD'};
}

// Needs you: labels to approve, labels waiting on facts and emails waiting to go.
async function inbox(db,workspaceId){
  if(!await installed(db))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const items=[];
  const rows=(await db.query(`SELECT DISTINCT ON (x.shipment_id) x.*,r.id return_id,r.return_number FROM ${runs} x
    JOIN sales_shipments s ON s.workspace_id=x.workspace_id AND s.id=x.shipment_id AND s.status='PACKED' AND s.customer_return_id IS NOT NULL
    JOIN customer_returns r ON r.workspace_id=s.workspace_id AND r.id=s.customer_return_id AND r.status='AUTHORIZED'
    WHERE x.workspace_id=$1 AND (coalesce(s.label_status,'') NOT IN ('PURCHASED','PENDING','REVIEW','VOID_PENDING') OR x.status='QUEUED')
    ORDER BY x.shipment_id,x.updated_at DESC LIMIT 50`,[workspaceId])).rows;
  for(const r of rows){
    const href='/returns/'+r.return_id+'#return-label',base={kind:'order',importance:'Needs You',sourceId:'return-label:'+r.id,at:r.updated_at,createdAt:r.created_at};
    if(r.status==='HELD')items.push({...base,priority:62,title:'Return label for '+r.return_number+' is waiting',happened:r.reason,why:'StockChief only buys a return label when the parcel, address and rates are clear.',
      recommendation:'Fix what is missing, or prepare the label yourself.',href,actionLabel:'Open the return'});
    else if(['SUGGESTED','CHOSEN'].includes(r.status)&&r.mode!=='watch')items.push({...base,priority:63,title:'Approve the return label for '+r.return_number,
      happened:require('../sales/carriers').displayName(r.carrier)+' '+r.service+' at '+money.format(Number(r.amount_minor),r.currency)+'.',why:r.label_reason||'It is the cheapest current rate for this return.',
      recommendation:'One tap buys the label; the customer is then emailed the label and instructions.',href,actionLabel:'Approve the label'});
    else if(r.status==='QUEUED'&&r.reason)items.push({...base,priority:63,title:'Email the return label for '+r.return_number,happened:r.reason,why:'The label is bought but the customer has not been sent it yet.',
      recommendation:'Send it with one tap.',href,actionLabel:'Send the email'});
  }
  const waiting=(await db.query(`SELECT r.* FROM customer_returns r WHERE r.workspace_id=$1 AND r.status='AUTHORIZED'
    AND NOT EXISTS(SELECT 1 FROM sales_shipments s WHERE s.workspace_id=r.workspace_id AND s.customer_return_id=r.id AND s.status<>'CANCELLED')
    AND EXISTS(SELECT 1 FROM sales_shipments o WHERE o.workspace_id=r.workspace_id AND o.sales_order_id=r.sales_order_id AND o.customer_return_id IS NULL AND o.status IN ('SHIPPED','DELIVERED'))
    ORDER BY r.authorized_at,r.id LIMIT 25`,[workspaceId])).rows;
  for(const rma of waiting){
    const problem=await preflight(db,workspaceId,rma);if(!problem)continue;
    items.push({kind:'order',importance:'Needs You',priority:62,title:'Return label for '+rma.return_number+' is waiting',happened:problem,why:'StockChief only buys a return label when it knows where to collect the goods.',
      recommendation:'Prepare the return parcel on the return yourself.',href:'/returns/'+rma.id+'#return-label',actionLabel:'Open the return',sourceId:'return-label-return:'+rma.id,at:rma.authorized_at,createdAt:rma.authorized_at});
  }
  return items.slice(0,25);
}

module.exports={KIND,action,run,schedule,kick,evaluate,deliver,approve,send,dismiss,configure,routeRule,routeFor,authority,view,inbox,example};
