'use strict';
// Job 71 on its own. Each fleet rule names a depot, its vans and drivers, the
// time StockChief plans each day, the days the vans go out and the most stops
// one run may take. At that time StockChief plans the next delivery day:
// every packed delivery at the depot going to an address the vans already
// deliver to (from a route the owner published) is placed on the vans with
// the measured loads, that address's delivery window and minutes at the stop,
// and the road times the owner confirmed for those addresses, or the
// connected road router with their saved pins.
//
// Custom publishes a route that fully fits on its own. Pro does the same once
// it is taught: one route of that fleet published by the owner; until then it
// prepares the route for review. Anything else stops and asks in Needs you:
// a delivery without measured weights or known road times, a stop that does
// not fit, more stops than the rule allows, or a depot that changed. Ask me
// first and routine work off prepare the route for review; pause, Watch only
// and the first 14 days do nothing. Each delivery day is planned once.
const policy=require('../commercial/agent-plan');
const jobs=require('../operations/postgres-job-queue');
const time=require('../lib/business-time');
const {addDays}=require('../accounting/customer-money');
const {has}=require('../db/schema-installed');
const {newId}=require('../lib/util');
const {DomainError,ValidationError}=require('../domain/errors');
const vans=require('./agent-van-routes');
const solver=require('./van-route-plan');
const roadService=require('./van-road-times');

const JOB=71,KIND='agent.shipping.van-route-routine.v1';
const {runs,rules,scoped,hash,depotKey,depotPlace,place}=vans.internal;
const expected=error=>error instanceof DomainError&&error.status<500;
const installed=async db=>await has(db,rules,'vans')&&await has(db,runs,'prepared_by_routine');

async function ownerUser(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL ORDER BY u.created_at,u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}

// How far the routine may go now: nothing, routes for review, or publishing.
async function authority(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {skip:'plan'};
  const owner=await ownerUser(db,workspaceId);if(!owner)return {skip:'owner'};
  const watching=await policy.stopped(db,workspaceId,account,vans.action,false);if(watching)return {skip:watching};
  const state=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(state.paused||state.suspended)return {skip:'Automatic work is paused.'};
  const held=await policy.stopped(db,workspaceId,account,vans.action,true)||(state.canAutomate?null:'Routine work is off, so StockChief prepared this route for your review.');
  return {owner,account,held};
}

// The next day after today the fleet delivers (ISO weekdays, Monday is 1).
function nextDeliveryDay(today,days){
  for(let ahead=1;ahead<=7;ahead++){
    const day=addDays(today,ahead),weekday=new Date(day+'T12:00:00Z').getUTCDay()||7;
    if(days.includes(weekday))return day;
  }
  return null;
}

// The rules due now, each with the delivery day it plans.
async function due(db,workspaceId,{now=false}={}){
  const clock=await time.forWorkspace(db,workspaceId),local=time.parts(new Date(clock.instant),clock.timeZone);
  const minute=local.hour*60+local.minute;
  const found=(await db.query(`SELECT r.*,r.planned_for::text AS planned_for FROM ${rules} r
    JOIN users u ON u.id=r.authorized_by AND u.workspace_id=r.workspace_id AND u.role='owner'
    WHERE r.workspace_id=$1 AND r.enabled AND r.vans IS NOT NULL ORDER BY r.depot_id,r.fleet_key`,[workspaceId])).rows;
  return found.map(rule=>({rule,day:nextDeliveryDay(clock.calendarDate,rule.delivery_days.map(Number))}))
    .filter(({rule,day})=>day&&(now||minute>=Number(rule.plan_at))&&!(rule.planned_for&&rule.planned_for>=day));
}

// What the owner already confirmed at this depot, from routes they or the
// rule published: each address's delivery window and minutes at the stop,
// the road legs between places, and map pins for the router.
async function known(db,workspaceId,depotId){
  const published=(await db.query(`SELECT facts FROM ${runs} WHERE workspace_id=$1 AND depot_id=$2 AND status='READY'
    ORDER BY created_at,id`,[workspaceId,depotId])).rows;
  const stops=new Map(),legs=new Map(),pins=new Map();
  for(const {facts} of published){
    for(const stop of facts.stops||[])if(stop.place)stops.set(stop.place,{opens:stop.opens,closes:stop.closes,serviceMinutes:stop.serviceMinutes});
    const points=facts.points||[],seconds=facts.seconds||[];
    if(points.length&&seconds.length===points.length)points.forEach((from,i)=>points.forEach((to,j)=>{
      if(from!==to&&seconds[i]?.[j]!==undefined)legs.set(from+'|'+to,seconds[i][j]);
    }));
    for(const [key,pin] of Object.entries(facts.pins||{}))pins.set(key,pin);
  }
  return {stops,legs,pins};
}

// Packed deliveries at the depot that no current route holds.
async function waiting(db,workspaceId,depotId){
  return (await db.query(`SELECT s.id,s.ship_to_address FROM sales_shipments s JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
    WHERE s.workspace_id=$1 AND s.ship_from_location_id=$2 AND s.status='PACKED' AND s.customer_return_id IS NULL AND s.return_outbound_shipment_id IS NULL
      AND o.delivery_method='SHIP' AND o.status<>'CANCELLED' AND coalesce(s.label_status,'NONE')='NONE' AND s.provider_shipment_id IS NULL
      AND nullif(s.tracking_number,'') IS NULL
      AND NOT EXISTS(SELECT 1 FROM ${runs} r CROSS JOIN LATERAL jsonb_array_elements(r.facts->'stops') x
        WHERE r.workspace_id=s.workspace_id AND r.depot_id=s.ship_from_location_id AND r.status IN('DRAFT','READY') AND x->>'id'=s.id)
      AND NOT EXISTS(SELECT 1 FROM ${runs} r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.facts->'held','[]'::jsonb)) x
        WHERE r.workspace_id=s.workspace_id AND r.depot_id=s.ship_from_location_id AND r.status='DRAFT' AND x->>'id'=s.id)
    ORDER BY s.created_at,s.id LIMIT 200`,[workspaceId,depotId])).rows;
}

// The rule's vans in the order the owner's own planning saves them, so the
// fleet hashes the same after a round trip through the database.
const fleet=list=>list.map(van=>({id:van.id,driver:van.driver,capacityGrams:van.capacityGrams,start:van.start,end:van.end}));
const leg=(legs,from,to)=>from===to?0:legs.has(from+'|'+to)?legs.get(from+'|'+to):undefined;

// The facts of one run, worked out before anything is written. Road times
// come from legs the owner confirmed, or from the connected router when
// every place has a saved pin.
async function gather(db,ctx,rule){
  const location=await vans.internal.depot(db,ctx,rule.depot_id);
  const remembered=await known(db,ctx.workspaceId,location.id),origin=depotPlace(location);
  const stops=[],held=[];
  for(const row of await waiting(db,ctx.workspaceId,location.id)){
    const window=remembered.stops.get(place(row.ship_to_address));
    if(!window)continue; // Not an address these vans deliver to.
    if(await require('./agent-freight-pickups').currentFreight(db,ctx.workspaceId,row.id))continue;
    try{stops.push({...window,...await vans.internal.shipmentFacts(db,ctx,row.id,location.id)});}
    catch(error){
      if(!expected(error))throw error;
      const shipment=await require('./postgres-service').requireShipment(db,ctx.workspaceId,row.id);
      held.push({id:row.id,number:shipment.shipment_number,customer:shipment.customer_name,reason:error.message});
    }
  }
  const over=stops.length>solver.maximumStops?stops.length:0;
  const candidates=stops.slice(0,solver.maximumStops).sort((a,b)=>a.id.localeCompare(b.id));
  // Take each stop whose legs to the depot and to the stops already taken are known.
  let accepted=[];const missing=[];
  for(const stop of candidates){
    const others=[origin,...accepted.map(s=>s.place)];
    if(others.every(other=>leg(remembered.legs,other,stop.place)!==undefined&&leg(remembered.legs,stop.place,other)!==undefined))accepted.push(stop);
    else missing.push(stop);
  }
  let seconds=null,roadSource='confirmed',pins=null;
  if(missing.length&&roadService.endpoint()&&[origin,...candidates.map(s=>s.place)].every(key=>remembered.pins.has(key))){
    try{
      seconds=await roadService.lookup(db,ctx,[remembered.pins.get(origin),...candidates.map(s=>remembered.pins.get(s.place))]);
      accepted=candidates;missing.length=0;roadSource='router';
      pins=Object.fromEntries([origin,...candidates.map(s=>s.place)].map(key=>[key,remembered.pins.get(key)]));
    }catch(error){
      if(!expected(error))throw error;
      for(const stop of missing)held.push({id:stop.id,number:stop.number,customer:stop.customer,reason:error.message});
      missing.length=0;
    }
  }
  for(const stop of missing)held.push({id:stop.id,number:stop.number,customer:stop.customer,
    reason:'StockChief does not have road times between this address and the other stops. Plan it yourself once with a road-time export or the road router.'});
  if(!seconds){
    const points=[origin,...accepted.map(s=>s.place)];
    seconds=points.map(from=>points.map(to=>leg(remembered.legs,from,to)));
  }
  return {location,stops:accepted,held,over,seconds,roadSource,pins,points:[origin,...accepted.map(s=>s.place)]};
}

// Plan one rule's delivery day: publish it when everything fits and the
// owner's authority allows, otherwise keep it for review with the reason.
async function plan(db,ctx,source,day,auth){
  const rule={...source,vans:fleet(source.vans)},facts=await gather(db,ctx,rule);
  if(!facts.stops.length&&!facts.held.length)return {nothing:true};
  const manifest=facts.stops.length?solver.plan(facts.stops,rule.vans,facts.seconds):{routes:[],unassigned:[]};
  return db.transaction(async client=>{
    await vans.internal.lock(client,ctx);
    const account=await vans.internal.authorize(scoped(client),ctx);
    const claimed=(await client.query(`UPDATE ${rules} SET planned_for=$4 WHERE workspace_id=$1 AND depot_id=$2 AND fleet_key=$3
      AND enabled AND vans IS NOT NULL AND (planned_for IS NULL OR planned_for<$4) RETURNING example_id,maximum_stops`,
      [ctx.workspaceId,rule.depot_id,rule.fleet_key,day])).rows[0];
    if(!claimed)return {replayed:true};
    const location=await vans.internal.depot(client,ctx,rule.depot_id,true);
    if(hash(depotKey(location))!==hash(depotKey(facts.location)))throw Object.assign(new ValidationError('The depot changed while planning.'),{retry:true});
    for(const stop of facts.stops)if((await vans.internal.shipmentFacts(client,ctx,stop.id,location.id,true)).signature!==stop.signature)
      throw Object.assign(new ValidationError(stop.number+' changed while planning.'),{retry:true});
    const fleetKey=hash([depotKey(location),rule.vans]),trained=Boolean(claimed.example_id);
    const reasons=[
      auth.held,
      fleetKey!==rule.fleet_key&&'The depot’s name or address changed since you saved the fleet rule. Check this route, then save the rule again.',
      !policy.permits(account.plan,JOB,'automatic',{trained})&&'Publish one route for this fleet yourself to teach StockChief. Until then it prepares routes for your review.',
      facts.over&&facts.over+' deliveries are packed, more than one run can take. The first '+solver.maximumStops+' are on this route.',
      facts.stops.length>claimed.maximum_stops&&facts.stops.length+' deliveries are packed, more than the '+claimed.maximum_stops+' your rule allows. Check the route before it goes out.',
      facts.held.length&&(facts.held.length===1?'One packed delivery could not be routed.':facts.held.length+' packed deliveries could not be routed.')+' Each shows why.',
      manifest.unassigned.length&&'Some deliveries do not fit the vans, shifts or delivery windows.'
    ].filter(Boolean);
    const run={id:newId('vanroute'),depot_id:location.id,delivery_date:day,fleet_key:fleetKey,status:'DRAFT',automatic:false,manifest,
      facts:{depot:location,vans:rule.vans,stops:facts.stops,held:facts.held,roadSource:facts.roadSource,roadTimeFingerprint:hash(facts.seconds),
        points:facts.points,seconds:facts.seconds,...(facts.pins?{pins:facts.pins}:{}),routine:true}};
    const tx=scoped(client);
    await require('../commercial/storage-capacity').reserve(tx,ctx.workspaceId,'van-route:'+run.id,Buffer.byteLength(JSON.stringify(run))+8192,{finished:true});
    await client.query(`INSERT INTO ${runs}(workspace_id,id,depot_id,delivery_date,fleet_key,facts,manifest,status,prepared_by_routine,waiting_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,'DRAFT',true,$8)`,[ctx.workspaceId,run.id,run.depot_id,day,run.fleet_key,
      JSON.stringify(run.facts),JSON.stringify(manifest),reasons[0]||null]);
    if(!reasons.length){
      await vans.internal.publish(client,ctx,run,{automatic:true,trained});
      return {published:1,held:0,id:run.id};
    }
    await vans.internal.audit(client,ctx,'Van manifest prepared',run,{routine:true,reason:reasons[0]});
    return {drafted:1,held:facts.held.length,id:run.id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// payload.now plans each due rule now, whatever its planning time (for a
// start from another system).
async function run(db,job){
  const workspaceId=job.workspaceId;
  if(!await installed(db))return {skipped:'not_installed'};
  const auth=await authority(db,workspaceId);if(auth.skip)return {skipped:auth.skip};
  const ctx={workspaceId,actorId:auth.owner},result={rules:0,published:0,drafted:0,held:0,routes:[]};
  for(const {rule,day} of await due(db,workspaceId,{now:job.payload?.now===true})){
    result.rules++;
    let outcome;
    try{outcome=await plan(db,ctx,rule,day,auth);}
    catch(error){
      // A delivery or the depot changed while planning: the next check plans again.
      if(error.retry)continue;
      if(!expected(error))throw error;
      outcome=await hold(db,ctx,rule,day,error.message);
    }
    for(const key of ['published','drafted','held'])result[key]+=outcome[key]||0;
    if(outcome.id)result.routes.push(outcome.id);
  }
  return result;
}

// The depot or fleet cannot be planned at all: the day is kept for review
// with the reason, so the owner sees it once.
async function hold(db,ctx,rule,day,reason){
  return db.transaction(async client=>{
    const claimed=(await client.query(`UPDATE ${rules} SET planned_for=$4 WHERE workspace_id=$1 AND depot_id=$2 AND fleet_key=$3
      AND enabled AND (planned_for IS NULL OR planned_for<$4) RETURNING 1`,[ctx.workspaceId,rule.depot_id,rule.fleet_key,day])).rowCount;
    if(!claimed)return {replayed:true};
    const depot=(await client.query('SELECT id,name,address FROM locations WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,rule.depot_id])).rows[0]||{id:rule.depot_id,name:'Depot',address:''};
    const run={id:newId('vanroute'),depot_id:rule.depot_id,delivery_date:day,automatic:false,manifest:{routes:[],unassigned:[]},
      facts:{depot,vans:rule.vans,stops:[],held:[],routine:true}};
    await client.query(`INSERT INTO ${runs}(workspace_id,id,depot_id,delivery_date,fleet_key,facts,manifest,status,prepared_by_routine,waiting_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,'DRAFT',true,$8)`,[ctx.workspaceId,run.id,run.depot_id,day,rule.fleet_key,JSON.stringify(run.facts),
      JSON.stringify(run.manifest),String(reason).slice(0,600)]);
    await vans.internal.audit(client,ctx,'Van manifest prepared',run,{routine:true,reason});
    return {drafted:1,id:run.id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

const scopedClient=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
async function schedule(c,workspaceId,cycleId){
  if(!await installed(c))return {queued:false};
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {queued:false};
  if(!(await due(c,workspaceId)).length)return {queued:false};
  await jobs.enqueue(scopedClient(c),{workspaceId,kind:KIND,idempotencyKey:'van-route-routine:'+cycleId,payload:{cycleId},priority:46,maxAttempts:3});
  return {queued:true};
}

// Needs you: each route the routine prepared but did not publish.
async function inbox(db,workspaceId){
  if(!await has(db,runs,'prepared_by_routine'))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const today=await time.today(db,workspaceId);
  return (await db.query(`SELECT r.id,r.delivery_date::text AS day,r.waiting_reason,r.created_at,l.name AS depot FROM ${runs} r
    LEFT JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.depot_id
    WHERE r.workspace_id=$1 AND r.status='DRAFT' AND r.prepared_by_routine AND r.delivery_date>=$2::date
    ORDER BY r.delivery_date,r.id LIMIT 50`,[workspaceId,today])).rows.map(r=>({kind:'shipping',importance:'Needs You',priority:59,
    title:'Review the van route for '+r.day+(r.depot?' from '+r.depot:''),happened:r.waiting_reason||'The route is ready for your review.',
    why:'StockChief planned it from your fleet rule and stopped before publishing it to the drivers.',actionLabel:'Review van route',
    href:vans.path+'/'+r.id,sourceId:'van-route:'+r.id,createdAt:r.created_at,at:r.created_at}));
}

module.exports={JOB,KIND,kind:KIND,path:vans.path,run,schedule,inbox,due,authority,nextDeliveryDay};
