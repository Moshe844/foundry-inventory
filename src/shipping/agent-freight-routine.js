'use strict';
// Job 66 on its own (Custom only). A packed shipment going to a customer you
// already ship pallets to, from the same warehouse, with the same measured
// pallets (to a tenth of an inch and pound), repeats a pickup you reviewed.
// When your saved booking rule covers that exact lane and pallet profile,
// StockChief asks your freight account for quotes and books the lowest one the
// rule covers: that carrier and service, up to its maximum. Pickup is the next
// business day, in the same pickup window.
//
// Anything else stops and asks in Needs you: a quote over the maximum waits
// for the owner's approval, and oversized or hazardous freight, a quote in
// another currency, a changed address, contact or freight account hold the
// shipment with the reason. During the first 14 days, Watch only and pause it
// does nothing. Under Ask me first, or with routine work off, it gets the
// quotes and the owner books.
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');
const money=require('../domain/currency');
const {has}=require('../db/schema-installed');
const {ValidationError,DomainError}=require('../domain/errors');
const freight=require('./agent-freight-pickups');
const adapter=require('./shipengine-freight');
const {hash}=require('../pricing/postgres-promotions');

const JOB=66,KIND='agent.shipping.freight-routine.v1';
const pickups='stockchief_runtime.agent_freight_pickups',holds='stockchief_runtime.agent_freight_holds';
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
// Facts a person can fix stop the one shipment and ask; anything else fails the run.
const expected=error=>error instanceof DomainError&&error.status<500;
const installed=async db=>await has(db,pickups)&&await has(db,holds);

// Packed, unlabelled carrier shipments with no freight request yet, on a lane
// that already has a reviewed pickup. A held shipment is looked at again once
// a day, or as soon as it changes.
const CANDIDATES=`SELECT s.id FROM sales_shipments s JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
 WHERE s.workspace_id=$1 AND s.status='PACKED' AND s.customer_return_id IS NULL AND s.handover='CARRIER'
  AND o.delivery_method='SHIP' AND o.status<>'CANCELLED' AND nullif(s.tracking_number,'') IS NULL
  AND coalesce(s.label_status,'NONE') NOT IN('PURCHASED','PENDING','REVIEW','VOID_PENDING')
  AND NOT EXISTS(SELECT 1 FROM ${pickups} p WHERE p.workspace_id=s.workspace_id AND p.shipment_id=s.id)
  AND NOT EXISTS(SELECT 1 FROM ${holds} h WHERE h.workspace_id=s.workspace_id AND h.shipment_id=s.id
   AND h.checked_at>=greatest(s.updated_at::timestamptz,clock_timestamp()-interval '20 hours'))
  AND EXISTS(SELECT 1 FROM ${pickups} p JOIN sales_shipments t ON t.workspace_id=p.workspace_id AND t.id=p.shipment_id
   JOIN sales_orders q ON q.workspace_id=t.workspace_id AND q.id=t.sales_order_id
   WHERE p.workspace_id=s.workspace_id AND t.ship_from_location_id=s.ship_from_location_id AND q.customer_id=o.customer_id)`;

async function ownerUser(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL ORDER BY u.created_at,u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}

// How far the routine may go now: nothing, quotes for the owner, or booking.
async function authority(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic'))return {skip:'plan'};
  const owner=await ownerUser(db,workspaceId);if(!owner)return {skip:'owner'};
  const watching=await policy.stopped(db,workspaceId,account,freight.action,false);if(watching)return {skip:watching};
  const state=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(state.paused||state.suspended)return {skip:'Automatic work is paused.'};
  const held=await policy.stopped(db,workspaceId,account,freight.action,true)||(state.canAutomate?null:'Routine work is off.');
  return {owner,book:!held,held};
}

// Each pallet as its two floor sides (longest first), height and weight, in
// inches and pounds to a tenth.
const tenth=value=>Math.round(value*10)/10;
function pallet(length,width,height,pounds){
  const [a,b]=[length,width].sort((x,y)=>y-x);return [a,b,height,pounds].map(tenth).join('|');
}
function recorded(handling){
  return handling.flatMap(unit=>Array.from({length:unit.quantity},()=>
    pallet(unit.length,unit.width,unit.height,unit.commodities.reduce((sum,c)=>sum+c.weight,0)))).sort().join(',');
}
function measured(boxes){
  if(!boxes.length||boxes.length>200||boxes.some(b=>b.estimated||!(b.weightGrams>0)||!(b.lengthMm>0)||!(b.widthMm>0)||!(b.heightMm>0)))return null;
  return boxes.map(b=>pallet(b.lengthMm/25.4,b.widthMm/25.4,b.heightMm/25.4,b.weightGrams/453.59237)).sort().join(',');
}

function addBusinessDays(day,count){
  const d=new Date(day+'T12:00:00Z');let left=count;
  while(left>0){d.setUTCDate(d.getUTCDate()+1);if(![0,6].includes(d.getUTCDay()))left--;}
  return d.toISOString().slice(0,10);
}

// The reviewed pickup this shipment repeats, and the request it makes, or
// null when nothing authorized matches. `held` carries a stop-and-ask reason.
async function repeat(db,ctx,shipmentId){
  let current;
  try{current=await freight.source(db,ctx,shipmentId);}catch(error){if(expected(error))return null;throw error;}
  const packed=measured(await require('./postgres-service').packagesFor(db,ctx.workspaceId,shipmentId));
  if(!packed)return null;
  const templates=(await db.query(`SELECT p.* FROM ${pickups} p JOIN sales_shipments t ON t.workspace_id=p.workspace_id AND t.id=p.shipment_id
    JOIN sales_orders q ON q.workspace_id=t.workspace_id AND q.id=t.sales_order_id
    JOIN sales_shipments s ON s.workspace_id=p.workspace_id AND s.id=$2 JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
    WHERE p.workspace_id=$1 AND p.shipment_id<>$2 AND t.ship_from_location_id=s.ship_from_location_id AND q.customer_id=o.customer_id
    ORDER BY p.created_at DESC,p.id DESC LIMIT 5`,[ctx.workspaceId,shipmentId])).rows;
  const pickupDate=addBusinessDays(await require('../lib/business-time').today(db,ctx.workspaceId),1);
  for(const template of templates){
    const f=template.facts;
    if(recorded(f.handling)!==packed)continue;
    // Only exact lanes and pallet profiles the owner authorized are repeated.
    const keys=template.offers.map(offer=>freight.scope(template,offer));
    const authorized=(await db.query(`SELECT 1 FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2
      AND scope_key=ANY($3::text[]) LIMIT 1`,[ctx.workspaceId,freight.action,keys])).rowCount;
    if(!authorized)continue;
    const input={shipmentId,sourceFingerprint:current.fingerprint,connectorId:template.connector_id,accountId:f.accountId,
      fromType:f.shipFrom.location_type,toType:f.shipTo.location_type,pickupDate,readyTime:f.pickup.ready_time,closeTime:f.pickup.close_time,
      confirmed:'yes',nonHazardous:'yes',accessorials:Object.keys(f.services||{}),
      pallets:f.handling.map(unit=>({quantity:String(unit.quantity),length:String(unit.length),width:String(unit.width),height:String(unit.height),
        stackable:unit.stackable===true,commodities:unit.commodities.map(c=>({description:c.description,quantity:String(c.quantity),
          weight:String(c.weight),freightClass:c.freight_class,nmfcCode:c.nmfc_code||''}))}))};
    if(f.oversize)return {template,input,held:'This pallet profile is over the standard LTL limits. Check with the carrier and book it yourself.'};
    let facts;
    try{facts=adapter.build({...input,from:{...current.origin,locationType:input.fromType},to:{...current.destination,locationType:input.toType}});}
    catch(error){if(!expected(error))throw error;return {template,input,held:error.message};}
    if(hash([facts.shipFrom,facts.shipTo])!==hash([f.shipFrom,f.shipTo]))
      return {template,input,held:'The pickup or delivery address or contact changed since the pickup you authorized. Review this shipment and request quotes.'};
    return {template,input};
  }
  return null;
}

async function hold(db,ctx,shipmentId,templateId,reason){
  const why=String(reason||'This shipment needs a person.').slice(0,600);
  await db.transaction(async c=>{
    await c.query(`INSERT INTO ${holds}(workspace_id,shipment_id,template_id,reason) VALUES($1,$2,$3,$4)
      ON CONFLICT(workspace_id,shipment_id) DO UPDATE SET template_id=EXCLUDED.template_id,reason=EXCLUDED.reason,checked_at=clock_timestamp()`,
    [ctx.workspaceId,shipmentId,templateId,why]);
    await audit.record(c,ctx,{action:'Freight pickup held for a person',reference:shipmentId,after:{reason:why}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function run(db,job){
  const workspaceId=job.workspaceId;
  if(!await installed(db))return {skipped:'not_installed'};
  const auth=await authority(db,workspaceId);if(auth.skip)return {skipped:auth.skip};
  const ctx={workspaceId,actorId:auth.owner},result={checked:0,queued:0,quoted:0,held:0};
  const {rows}=await db.query(CANDIDATES+' ORDER BY s.updated_at,s.id LIMIT 10',[workspaceId]);
  for(const {id} of rows){
    const found=await repeat(db,ctx,id);if(!found)continue;
    result.checked++;
    if(found.held){await hold(db,ctx,id,found.template.id,found.held);result.held++;continue;}
    try{
      const outcome=await freight.prepare(db,ctx,{...found.input,useRoutine:auth.book?'yes':''},{routine:true});
      result[outcome.queued?'queued':'quoted']++;
    }catch(error){
      if(!expected(error))throw error;
      await hold(db,ctx,id,found.template.id,error.message);result.held++;
    }
  }
  return result;
}

async function schedule(c,workspaceId,cycleId){
  if(!await installed(c))return {queued:false};
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic'))return {queued:false};
  if(!(await c.query(`SELECT 1 FROM (${CANDIDATES}) waiting LIMIT 1`,[workspaceId])).rowCount)return {queued:false};
  await jobs.enqueue(scoped(c),{workspaceId,kind:KIND,idempotencyKey:'freight-routine:'+cycleId,payload:{cycleId},priority:46,maxAttempts:3});
  return {queued:true};
}

// Needs you: quotes waiting for the owner, bookings to check, and holds.
async function inbox(db,workspaceId){
  if(!await has(db,pickups))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const waiting=(await db.query(`SELECT p.id,p.created_at,s.shipment_number,e.status,e.error_code,
      (SELECT min((o->>'amountMinor')::bigint) FROM jsonb_array_elements(p.offers) o WHERE (o->>'expiresAt')::timestamptz>clock_timestamp()) AS lowest
    FROM ${pickups} p JOIN sales_shipments s ON s.workspace_id=p.workspace_id AND s.id=p.shipment_id
    LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=p.workspace_id AND e.id=p.effect_id
    WHERE p.workspace_id=$1 AND s.status='PACKED' AND p.receipt IS NULL AND (p.effect_id IS NULL OR e.status IN('AMBIGUOUS','FAILED'))
    ORDER BY p.created_at,p.id LIMIT 50`,[workspaceId])).rows;
  const items=waiting.map(r=>!r.status
    ?{kind:'shipping',importance:'Needs You',priority:62,title:'Approve the freight pickup for '+r.shipment_number,
      happened:r.lowest==null?'The carrier quotes expired.':'Carrier quotes are ready. The lowest is '+money.format(Number(r.lowest),'USD')+'.',
      why:'Booking commits money with the carrier. Book a quote, or request fresh quotes.',actionLabel:'Review freight quotes',
      href:freight.path+'/'+r.id,sourceId:'freight-pickup:'+r.id,createdAt:r.created_at,at:r.created_at}
    :{kind:'shipping',importance:'Needs You',priority:60,title:'Check the freight booking for '+r.shipment_number,
      happened:r.status==='AMBIGUOUS'?'The carrier did not confirm the booking.':'The booking did not go through.',
      why:'Check it before booking again, so the pickup is not booked twice.',actionLabel:'Check freight booking',
      href:freight.path+'/'+r.id,sourceId:'freight-pickup:'+r.id,createdAt:r.created_at,at:r.created_at});
  if(await has(db,holds)){
    const held=(await db.query(`SELECT h.shipment_id,h.reason,h.checked_at,s.shipment_number FROM ${holds} h
      JOIN sales_shipments s ON s.workspace_id=h.workspace_id AND s.id=h.shipment_id
      WHERE h.workspace_id=$1 AND s.status='PACKED' AND NOT EXISTS(SELECT 1 FROM ${pickups} p WHERE p.workspace_id=h.workspace_id AND p.shipment_id=h.shipment_id)
      ORDER BY h.checked_at,h.shipment_id LIMIT 50`,[workspaceId])).rows;
    for(const r of held)items.push({kind:'shipping',importance:'Needs You',priority:61,title:'Freight pickup for '+r.shipment_number+' needs you',
      happened:r.reason,why:'StockChief stopped instead of guessing. Check the pallets and quote it yourself, or book it with the carrier.',
      actionLabel:'Open freight pickups',href:freight.path+'?'+new URLSearchParams({shipment:r.shipment_id}),
      sourceId:'freight-hold:'+r.shipment_id,createdAt:r.checked_at,at:r.checked_at});
  }
  return items;
}

module.exports={KIND,run,schedule,inbox,repeat,authority};
