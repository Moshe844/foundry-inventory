'use strict';

const {createHash}=require('node:crypto');
const {AuthorizationError,NotFoundError,ValidationError}=require('../domain/errors');
const {newId,requireText}=require('../lib/util');
const policy=require('../commercial/agent-plan');
const access=require('../operations/postgres-warehouse-access');
const time=require('../lib/business-time');
const measure=require('../domain/physical-measure');
const solver=require('./van-route-plan');
const addresses=require('./address');
const shipping=require('./postgres-service');
const roadService=require('./van-road-times');
const {has}=require('../db/schema-installed');

const path='/autopilot/van-routes',action='shipping.plan_van_routes';
const runs='stockchief_runtime.agent_van_routes',rules='stockchief_runtime.agent_van_route_rules';
const scoped=client=>({query:(...args)=>client.query(...args),transaction:fn=>fn(client)});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const depotKey=value=>[value.id,value.name,value.address];
// Road legs and map pins are remembered by place, so a later run to the same
// addresses can reuse what the owner confirmed: the depot as saved, and each
// delivery address with case and spacing ignored.
const depotPlace=location=>'depot:'+hash(depotKey(location));
const place=address=>'address:'+hash(String(address||'').trim().toLowerCase().replace(/\s+/g,' '));
const audit=(db,ctx,action,run,extra={})=>require('../operations/postgres-security-audit').record(db,ctx,{
  action,reference:run.id,after:{depotId:run.depot_id,date:run.delivery_date,automatic:run.automatic,...extra}
});

async function owner(db,ctx,lock=false){
  const result=await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId]);
  if(!result.rowCount)throw new AuthorizationError('Only the current inventory owner can manage van routes.');
  await access.assertInventoryWide(db,ctx);
}

async function lock(db,ctx){
  await owner(db,ctx,true);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['van-routes:'+ctx.workspaceId]);
  await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
  await db.query('SELECT job_id FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=71 FOR SHARE',[ctx.workspaceId]);
}

async function authorize(db,ctx,operation='draft',trained=false){
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,71,operation,{trained});
  const reason=await policy.stopped(db,ctx.workspaceId,state,action,operation==='automatic');
  if(reason)throw new ValidationError(reason);
  if(operation==='automatic'&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)
    throw new ValidationError('Enable routine work for this inventory before publishing a van route automatically.');
  return state;
}

function date(raw){
  const value=String(raw||''),parsed=new Date(value+'T00:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)
    throw new ValidationError('Enter an exact delivery date.');
  return value;
}

function number(raw,label,maximum){
  const value=Number(raw);
  if(!/^\d+$/.test(String(raw))||!Number.isSafeInteger(value)||value<1||value>maximum)
    throw new ValidationError('Enter a whole number between 1 and '+maximum+' for '+label+'.');
  return value;
}

function fleet(raw){
  const rows=String(raw||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  if(!rows.length||rows.length>solver.maximumVans)throw new ValidationError('Enter up to '+solver.maximumVans+' vans, one per line.');
  return rows.map((line,index)=>{
    const fields=line.split('|').map(value=>value.trim());
    if(fields.length!==5)throw new ValidationError('For each van, enter van name, driver, payload in kg, shift start and shift end.');
    return {id:requireText(fields[0],'Van '+(index+1),{max:50}),driver:requireText(fields[1],'Driver for van '+(index+1),{max:80}),
      capacityGrams:number(fields[2],'van payload in kg',20000)*1000,start:solver.minute(fields[3],'shift start'),end:solver.minute(fields[4],'shift end')};
  }).sort((a,b)=>a.id.localeCompare(b.id));
}

function submittedStops(input){
  const raw=Array.isArray(input.selected)?input.selected:[input.selected];
  if(!raw.length||raw.length>solver.maximumStops||raw.some(id=>typeof id!=='string'||!id||id.length>120)||new Set(raw).size!==raw.length)
    throw new ValidationError('Select up to '+solver.maximumStops+' distinct packed shipments.');
  return raw.map(id=>({id,opens:solver.minute(input.opens?.[id],'delivery window start'),
    closes:solver.minute(input.closes?.[id],'delivery window end'),serviceMinutes:number(input.service?.[id],'minutes at the stop',240)}));
}

async function depot(db,ctx,id,forUpdate=false){
  const row=(await db.query(`SELECT id,name,address FROM locations WHERE workspace_id=$1 AND id=$2
    AND is_active=1 AND custody_agreement_id IS NULL${forUpdate?' FOR SHARE':''}`,[ctx.workspaceId,id])).rows[0];
  if(!row||!String(row.address||'').trim())throw new ValidationError('Choose a dispatch location with a saved depot address.');
  return row;
}

async function shipmentFacts(db,ctx,id,depotId,forUpdate=false){
  const row=await shipping.requireShipment(db,ctx.workspaceId,id,forUpdate);
  if(row.ship_from_location_id!==depotId||row.status!=='PACKED'||row.customer_return_id||row.return_outbound_shipment_id||
    row.label_status&&row.label_status!=='NONE'||row.provider_shipment_id||row.provider_packages?.length||
    !addresses.parse(row.ship_to_address,row.ship_to_address_fields).complete||
    await require('./agent-freight-pickups').currentFreight(db,ctx.workspaceId,id))
    throw new ValidationError('Choose packed shipments from this depot with a complete destination and no carrier booking.');
  const boxes=await shipping.packagesFor(db,ctx.workspaceId,id);
  if(boxes.length!==Number(row.package_count)||boxes.some(box=>box.estimated||!box.weightGrams))
    throw new ValidationError(row.shipment_number+' needs a measured weight for every package before it can be routed.');
  const weightGrams=Math.ceil(measure.sum(boxes.map(box=>box.weightGrams),'Shipment weight',100000000));
  return {id,number:row.shipment_number,order:row.order_number,customer:row.customer_name,address:row.ship_to_address,
    place:place(row.ship_to_address),weightGrams,signature:hash([row.ship_to_address,row.ship_to_address_fields,row.sales_order_id,row.updated_at,boxes])};
}

function roadMatrix(raw,stops){
  let data;
  try{data=JSON.parse(String(raw||''));}catch{throw new ValidationError('Paste the road-time export as JSON.');}
  if(!data||!Array.isArray(data.points)||new Set(data.points).size!==data.points.length||data.points[0]!=='DEPOT'||
    data.points.length!==stops.length+1||stops.some(stop=>!data.points.includes(stop.number)))
    throw new ValidationError('Road times must identify DEPOT and each selected shipment number exactly once.');
  solver.minutes(data.seconds,data.points.length);
  const positions=[0,...stops.map(stop=>data.points.indexOf(stop.number))];
  return positions.map(from=>positions.map(to=>data.seconds[from][to]));
}

async function runFacts(db,ctx,input,forUpdate=false){
  if(input.confirmed!=='yes')throw new ValidationError('Confirm that your fleet will deliver these shipments and that the road data matches their saved addresses.');
  const deliveryDate=date(input.deliveryDate);
  if(deliveryDate<await time.today(db,ctx.workspaceId))throw new ValidationError('Choose today or a future delivery date.');
  const location=await depot(db,ctx,input.depotId,forUpdate),vans=fleet(input.vans),stops=[];
  await departure(db,ctx,deliveryDate,vans);
  for(const stop of submittedStops(input).sort((a,b)=>a.id.localeCompare(b.id))){
    stops.push({...stop,...await shipmentFacts(db,ctx,stop.id,location.id,forUpdate)});
  }
  return {deliveryDate,location,vans,stops};
}

async function departure(db,ctx,deliveryDate,vans){
  const clock=await time.forWorkspace(db,ctx.workspaceId);
  const local=time.parts(new Date(clock.instant),clock.timeZone);
  if(deliveryDate===clock.calendarDate&&vans.some(van=>van.start<=local.hour*60+local.minute))
    throw new ValidationError('Choose a future departure time for today’s run, or plan a later delivery date.');
}

async function routedMatrix(db,ctx,input){
  await owner(db,ctx);
  await authorize(db,ctx);
  const {location,stops}=await runFacts(db,ctx,input);
  const points=[roadService.point(input.depotPin,'the depot'),
    ...stops.map(stop=>roadService.point(input.pins?.[stop.id],stop.number))];
  return {location,signatures:stops.map(stop=>stop.signature),seconds:await roadService.lookup(db,ctx,points),
    pins:Object.fromEntries([[depotPlace(location),points[0]],...stops.map((stop,index)=>[stop.place,points[index+1]])])};
}

async function get(db,ctx,id,forUpdate=false){
  const row=(await db.query(`SELECT *,delivery_date::text AS delivery_date FROM ${runs}
    WHERE workspace_id=$1 AND id=$2${forUpdate?' FOR UPDATE':''}`,[ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That van route could not be found.');
  return row;
}

async function rule(db,ctx,run){
  return (await db.query(`SELECT r.* FROM ${rules} r JOIN users u ON u.id=r.authorized_by AND u.workspace_id=r.workspace_id AND u.role='owner'
    WHERE r.workspace_id=$1 AND r.depot_id=$2 AND r.fleet_key=$3`,[ctx.workspaceId,run.depot_id,run.fleet_key])).rows[0];
}

async function current(db,ctx,run){
  if(run.delivery_date<await time.today(db,ctx.workspaceId))throw new ValidationError('The delivery date has passed. Plan a new route.');
  await departure(db,ctx,run.delivery_date,run.facts.vans);
  if(hash(depotKey(await depot(db,ctx,run.depot_id,true)))!==hash(depotKey(run.facts.depot)))
    throw new ValidationError('The depot changed. Plan a new route with the current address.');
  for(const stop of run.facts.stops){
    if((await shipmentFacts(db,ctx,stop.id,run.depot_id,true)).signature!==stop.signature)
      throw new ValidationError(stop.number+' changed. Plan a new route using its current packages and address.');
  }
  const assigned=(await db.query(`SELECT 1 FROM ${runs} r CROSS JOIN LATERAL jsonb_array_elements(r.facts->'stops') s
    WHERE r.workspace_id=$1 AND r.status='READY' AND r.depot_id=$2 AND r.id<>$3 AND s->>'id'=ANY($4) LIMIT 1`,
    [ctx.workspaceId,run.depot_id,run.id,run.facts.stops.map(stop=>stop.id)])).rowCount;
  if(assigned)throw new ValidationError('A shipment is already on a published route. Stop that route before reassigning it.');
}

async function publish(db,ctx,run,{automatic=false,trained=false}={}){
  if(run.manifest.unassigned.length)throw new ValidationError('Resolve the unassigned stops before publishing this route.');
  if(!run.facts.stops.length)throw new ValidationError('No delivery on this route could be planned. Plan the waiting deliveries yourself.');
  await authorize(scoped(db),ctx,automatic?'automatic':'draft',trained);
  await current(db,ctx,run);
  await db.query(`UPDATE ${runs} SET status='READY',automatic=$3,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,run.id,automatic]);
  await audit(db,ctx,'Van manifest published',{...run,automatic});
}

async function prepare(db,ctx,input){
  const routed=input.roadSource==='router'?await routedMatrix(db,ctx,input):null;
  return db.transaction(async client=>{
    await lock(client,ctx);
    const account=await authorize(scoped(client),ctx);
    const {deliveryDate,location,vans,stops}=await runFacts(client,ctx,input,true);
    if(routed&&(hash(depotKey(routed.location))!==hash(depotKey(location))||hash(routed.signatures)!==hash(stops.map(stop=>stop.signature))))
      throw new ValidationError('A depot or shipment changed while calculating the road times. Review the saved addresses and try again.');
    const seconds=routed?routed.seconds:roadMatrix(input.roadTimes,stops),manifest=solver.plan(stops,vans,seconds);
    const run={id:newId('vanroute'),depot_id:location.id,delivery_date:deliveryDate,
      fleet_key:hash([depotKey(location),vans]),facts:{depot:location,vans,stops,roadSource:routed?'router':'export',
        roadTimeFingerprint:hash(seconds),points:[depotPlace(location),...stops.map(stop=>stop.place)],seconds,...(routed?{pins:routed.pins}:{})},
      manifest,status:'DRAFT',automatic:false};
    const tx=scoped(client);
    await require('../commercial/storage-capacity').reserve(tx,ctx.workspaceId,'van-route:'+run.id,Buffer.byteLength(JSON.stringify(run))+8192,{finished:true});
    await client.query(`INSERT INTO ${runs}(workspace_id,id,depot_id,delivery_date,fleet_key,facts,manifest,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,'DRAFT')`,[ctx.workspaceId,run.id,run.depot_id,run.delivery_date,run.fleet_key,
      JSON.stringify(run.facts),JSON.stringify(manifest)]);
    if(input.routine==='yes'&&!manifest.unassigned.length){
      const control=await rule(client,ctx,run),trained=Boolean(control?.example_id);
      if(control?.enabled&&stops.length<=control.maximum_stops&&policy.permits(account.plan,71,'automatic',{trained})&&
        !await policy.stopped(tx,ctx.workspaceId,account,action,true)&&
        (await require('../autopilot/postgres-service').getState(tx,ctx.workspaceId)).canAutomate){
        await publish(client,ctx,run,{automatic:true,trained});
        return {id:run.id,published:true};
      }
    }
    await audit(client,ctx,'Van manifest prepared',run);
    return {id:run.id,published:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function approve(db,ctx,id,input){
  return db.transaction(async client=>{
    await lock(client,ctx);
    await authorize(scoped(client),ctx);
    const run=await get(client,ctx,id,true);
    if(input.confirmed!=='yes'||Number(input.revision)!==run.revision||run.status!=='DRAFT')
      throw new ValidationError('Review the current manifest before publishing.');
    await publish(client,ctx,run);
    // On Pro, a route the owner publishes is the completed example that
    // teaches a matching fleet rule. After it, the routine publishes alone.
    const taught=await client.query(`UPDATE ${rules} SET example_id=$4,revision=revision+1 WHERE workspace_id=$1 AND depot_id=$2
      AND fleet_key=$3 AND enabled AND example_id IS NULL RETURNING 1`,[ctx.workspaceId,run.depot_id,run.fleet_key,run.id]);
    if(taught.rowCount)await audit(client,ctx,'Van route routine taught',run);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

const weekdays=[[1,'Mon'],[2,'Tue'],[3,'Wed'],[4,'Thu'],[5,'Fri'],[6,'Sat'],[7,'Sun']];
// When the routine plans and for which days. Left out, it plans at 15:00
// for weekday deliveries.
function routineTiming(input){
  const planAt=input.planAt===undefined?900:solver.minute(input.planAt,'the time StockChief plans each day');
  const raw=input.days===undefined?[1,2,3,4,5]:[].concat(input.days);
  const days=[...new Set(raw.map(Number))].sort((a,b)=>a-b);
  if(!days.length||days.length!==raw.length||days.some(day=>!Number.isSafeInteger(day)||day<1||day>7))
    throw new ValidationError('Choose the days your vans deliver.');
  return {planAt,days};
}

async function configure(db,ctx,id,input){
  return db.transaction(async client=>{
    await lock(client,ctx);
    const run=await get(client,ctx,id,true),existing=await rule(client,ctx,run);
    if(Number(input.ruleRevision)!==(existing?.revision||0)||input.confirmed!=='yes')
      throw new ValidationError('Review the current fleet rule before changing it.');
    if(input.stop==='yes'){
      await client.query(`UPDATE ${rules} SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND depot_id=$2 AND fleet_key=$3`,
        [ctx.workspaceId,run.depot_id,run.fleet_key]);
      await audit(client,ctx,'Van route routine stopped',run);
      return;
    }
    // A route the owner published, or a rule already taught by one, is the
    // completed example. On Pro a rule without one only prepares routes for
    // review until the owner publishes one of this fleet's routes.
    const example=run.status==='READY'&&!run.automatic,trained=example||Boolean(existing?.example_id);
    const account=await policy.accountState(client,ctx.workspaceId);
    const draftOnly=policy.usesAgentTerms(account)&&policy.allowance(account.plan,71)==='trained'&&!trained;
    await authorize(scoped(client),ctx,draftOnly?'draft':'automatic',trained);
    if(run.manifest.unassigned.length||run.status==='STOPPED'||!run.facts.stops.length||run.facts.held?.length)
      throw new ValidationError('Resolve all stops on the fleet example before saving this rule.');
    const maximum=number(input.maximumStops,'maximum stops per route run',solver.maximumStops);
    if(maximum<run.facts.stops.length)throw new ValidationError('The rule must cover the example’s stop count.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(client,ctx,[],existing?.enabled?0:1);
    const routine=await has(client,rules,'vans')?routineTiming(input):null;
    const values=[ctx.workspaceId,run.depot_id,run.fleet_key,ctx.actorId,example?run.id:null,maximum];
    if(routine)await client.query(`INSERT INTO ${rules} AS prior(workspace_id,depot_id,fleet_key,authorized_by,example_id,maximum_stops,enabled,vans,plan_at,delivery_days)
      VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$9) ON CONFLICT(workspace_id,depot_id,fleet_key) DO UPDATE SET
      authorized_by=EXCLUDED.authorized_by,example_id=coalesce(EXCLUDED.example_id,prior.example_id),maximum_stops=EXCLUDED.maximum_stops,
      enabled=true,vans=EXCLUDED.vans,plan_at=EXCLUDED.plan_at,delivery_days=EXCLUDED.delivery_days,revision=prior.revision+1`,
    [...values,JSON.stringify(run.facts.vans),routine.planAt,routine.days]);
    else await client.query(`INSERT INTO ${rules} AS prior(workspace_id,depot_id,fleet_key,authorized_by,example_id,maximum_stops,enabled)
      VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT(workspace_id,depot_id,fleet_key) DO UPDATE SET
      authorized_by=EXCLUDED.authorized_by,example_id=coalesce(EXCLUDED.example_id,prior.example_id),maximum_stops=EXCLUDED.maximum_stops,enabled=true,revision=prior.revision+1`,values);
    await audit(client,ctx,'Van route routine authorized',run,{trained,maximumStops:maximum,...(routine?{planAt:solver.clock(routine.planAt),days:routine.days}:{})});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function stop(db,ctx,id,input){
  return db.transaction(async client=>{
    await lock(client,ctx);
    const run=await get(client,ctx,id,true);
    if(input.confirmed!=='yes'||Number(input.revision)!==run.revision||run.status==='STOPPED')
      throw new ValidationError('Confirm the current route before stopping it.');
    await client.query(`UPDATE ${runs} SET status='STOPPED',revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
    await client.query(`UPDATE ${rules} SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND example_id=$2 AND enabled`,[ctx.workspaceId,id]);
    await audit(client,ctx,'Van manifest stopped',run);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Undo from the activity log: a route StockChief published on its own is
// stopped while every delivery on it is still packed at the depot.
async function undo(db,ctx,id){
  return db.transaction(async client=>{
    await lock(client,ctx);
    await authorize(scoped(client),ctx);
    const run=await get(client,ctx,id,true);
    if(run.status==='STOPPED')return {replayed:true};
    if(run.status!=='READY'||!run.automatic)throw new ValidationError('Only a route StockChief published on its own can be undone here.');
    const left=await client.query(`SELECT 1 FROM sales_shipments WHERE workspace_id=$1 AND id=ANY($2::text[]) AND status<>'PACKED' LIMIT 1`,
      [ctx.workspaceId,run.facts.stops.map(stop=>stop.id)]);
    if(left.rowCount)throw new ValidationError('A delivery on this route has already left the depot. Change the route with your drivers.');
    await client.query(`UPDATE ${runs} SET status='STOPPED',revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
    await audit(client,ctx,'Van manifest stopped',run,{undo:true});
    return {stopped:id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function fleetRules(db,ctx){
  const routine=await has(db,rules,'vans');
  return (await db.query(`SELECT r.depot_id,r.fleet_key,r.example_id,r.maximum_stops,r.enabled,r.revision,l.name AS depot,
      ${routine?'r.vans,r.plan_at,r.delivery_days,r.planned_for::text AS planned_for':'NULL::jsonb AS vans,NULL::int AS plan_at,NULL::int[] AS delivery_days,NULL::text AS planned_for'}
    FROM ${rules} r JOIN users u ON u.id=r.authorized_by AND u.workspace_id=r.workspace_id AND u.role='owner'
    LEFT JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.depot_id
    WHERE r.workspace_id=$1 ORDER BY l.name,r.depot_id,r.fleet_key LIMIT 50`,[ctx.workspaceId])).rows;
}
// How a fleet rule acts on this plan, in words for the page.
function ruleState(plan,control){
  if(!control?.enabled)return 'Stopped. StockChief does not plan for this fleet.';
  if(!control.vans)return 'Save this rule again to let StockChief plan each day.';
  const chosen=weekdays.filter(([day])=>control.delivery_days.map(Number).includes(day)).map(([,name])=>name);
  const when='Plans at '+solver.clock(Number(control.plan_at))+' for the next delivery day ('+(chosen.length===7?'every day':chosen.join(', '))+').';
  if(policy.allowance(plan,71)==='trained'&&!control.example_id)
    return when+' Until you publish one of its routes yourself, it prepares each route for your review.';
  return when+' Publishes routes that fully fit on its own, up to '+control.maximum_stops+' stops.';
}

async function page(db,ctx,{id,depotId}={}){
  await owner(db,ctx);
  const account=await policy.requireWorkspaceJob(db,ctx.workspaceId,71,'draft'),allowed=true;
  const routine=await has(db,runs,'prepared_by_routine');
  const rows=(await db.query(`SELECT r.id,r.delivery_date::text,r.status,r.automatic,l.name AS depot,
      ${routine?'r.prepared_by_routine,r.waiting_reason':'false AS prepared_by_routine,NULL::text AS waiting_reason'}
    FROM ${runs} r LEFT JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.depot_id
    WHERE r.workspace_id=$1 ORDER BY r.delivery_date DESC,r.id DESC LIMIT 100`,[ctx.workspaceId])).rows;
  const fleets=(await fleetRules(db,ctx)).map(control=>({...control,state:ruleState(account.plan,control)}));
  if(id){
    const run=await get(db,ctx,id),control=fleets.find(r=>r.depot_id===run.depot_id&&r.fleet_key===run.fleet_key)||null;
    const waiting=routine?(await db.query(`SELECT prepared_by_routine,waiting_reason FROM ${runs} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,run.id])).rows[0]:null;
    return {allowed,rows,fleets,run,control,clock:solver.clock,weekdays,waitingReason:waiting?.waiting_reason||null,
      preparedByRoutine:Boolean(waiting?.prepared_by_routine),
      canTeach:run.status!=='STOPPED'&&!run.manifest.unassigned.length&&run.facts.stops.length>0&&!run.facts.held?.length,
      teachLater:policy.allowance(account.plan,71)==='trained'&&!(run.status==='READY'&&!run.automatic)&&!control?.example_id};
  }
  const depots=(await db.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1
    AND custody_agreement_id IS NULL AND nullif(btrim(address),'') IS NOT NULL ORDER BY name,id`,[ctx.workspaceId])).rows;
  const depot=depots.find(item=>item.id===depotId);
  const shipments=depot?(await db.query(`SELECT s.id,s.shipment_number,s.ship_to_address,c.name AS customer
    FROM sales_shipments s JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
    JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    WHERE s.workspace_id=$1 AND s.ship_from_location_id=$2 AND s.status='PACKED' AND s.customer_return_id IS NULL
      AND coalesce(s.label_status,'NONE')='NONE' AND s.provider_shipment_id IS NULL
    ORDER BY s.created_at,s.id LIMIT 40`,[ctx.workspaceId,depot.id])).rows:[];
  return {allowed,rows,fleets,run:null,depots,depot,shipments,roadServiceAvailable:Boolean(roadService.endpoint()),today:await time.today(db,ctx.workspaceId)};
}

async function review(db,ctx){
  const data=await page(db,ctx);
  return {rows:(data.rows||[]).map(run=>({Date:run.delivery_date,Depot:run.depot,Status:run.status,
    Published:run.automatic?'Routine':'Individual review',link:path+'/'+run.id})),
  action:{label:'Open van routes',href:path},summary:'Assign packed local deliveries to vans using road times, measured loads, delivery windows and driver shifts.'};
}

// What the daily routine (agent-van-route-routine.js) shares with the owner's own planning.
const internal={runs,rules,scoped,hash,depotKey,depotPlace,place,audit,owner,lock,authorize,depot,shipmentFacts,get,publish};
module.exports={path,action,prepare,approve,configure,stop,undo,page,internal,weekdays,definition:{id:71,key:'van-routes',label:'Plan delivery routes for your own vans',readPage:review}};
