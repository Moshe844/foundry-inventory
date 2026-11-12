'use strict';

const { ValidationError, AuthorizationError, NotFoundError } = require('../domain/errors');
const { newId } = require('../lib/util');
const { hash } = require('../pricing/postgres-promotions');
const exact = require('../domain/exact-quantity');
const { MAX_QUANTITY } = require('../domain/physical-stock-input');
const { product, cmp } = require('../transfers/agent-transfer-balance-source');
const policy = require('../commercial/agent-plan');
const audit = require('../operations/postgres-security-audit');
const storage = require('../commercial/storage-capacity');
const time = require('../lib/business-time');
const { addDays } = require('../accounting/customer-money');
const transfers = require('../transfers/postgres-transfer-service');
const source = require('./warehouse-slotting-source');

const path = '/autopilot/warehouse-slotting';
const kind = 'planning.warehouse-slotting.v1';
const action = 'inventory.plan_warehouse_slotting';
const schedules = 'stockchief_runtime.agent_slotting_schedules';
const plans = 'stockchief_runtime.agent_slotting_plans';
const moves = 'stockchief_runtime.agent_slotting_moves';
const tx = (db,fn) => db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const expected = error => error instanceof ValidationError||error instanceof AuthorizationError||error instanceof NotFoundError||error?.code==='entitlement_required';
const summary = 'Busy products from the last 90 days of picks, each matched to a closer empty bin in the same warehouse. Nothing moves until a move is approved.';

async function owner(db,ctx,lock=false) {
  const row=(await db.query(`SELECT u.account_id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF w,u':''}`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the current inventory owner can manage warehouse move lists.');
  if(lock)await db.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE',[row.account_id]);
  return row.account_id;
}

// Draft work needs Pro or Custom. Moving stock also respects shadow mode,
// watch-only and the job's own mode; routine moves need Custom and routine work.
async function authority(db,ctx,{lock=false,act=false}={}) {
  await owner(db,ctx,lock);
  if(lock)await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
  const account=await policy.requireWorkspaceJob(db,ctx.workspaceId,122,'draft');
  await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'inventory.core');
  if(act){
    const stop=await policy.stopped(db,ctx.workspaceId,account,action,false);
    if(stop)throw new ValidationError(stop);
  }
  return account;
}

// Why routine work cannot act right now, or null when it can. 'watch' means
// nothing may be prepared; 'ask' means the list waits for a person.
async function routine(db,workspaceId,account) {
  const watch=await policy.stopped(db,workspaceId,account,action,false);
  if(watch)return {watch};
  const state=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(state.paused||state.suspended)return {watch:'Automatic work is paused. Nothing was moved.'};
  if(!state.canAutomate)return {ask:'StockChief is set to Ask me first. These moves wait for your approval.'};
  const ask=await policy.stopped(db,workspaceId,account,action,true);
  return ask?{ask}:{};
}

async function warehouse(db,workspaceId,id) {
  const row=(await db.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2
    AND parent_location_id IS NULL AND kind='warehouse' AND is_active=1 AND custody_agreement_id IS NULL`,[workspaceId,id])).rows[0];
  if(!row)throw new ValidationError('Choose an active warehouse in this inventory.');
  return row;
}

async function findBin(db,ctx,input) {
  const name=String(input.bin||'').trim(),warehouseId=String(input.warehouseId||'');
  if(!name||name.length>150)throw new ValidationError('Choose a bin.');
  const rows=(await db.query(`WITH RECURSIVE ancestors AS (
    SELECT l.id AS bin_id,l.name AS bin_name,l.id,l.parent_location_id,l.kind,ARRAY[l.id] AS path
    FROM locations l WHERE l.workspace_id=$1 AND l.is_active=1 AND l.kind='bin' AND l.custody_agreement_id IS NULL
      AND (l.id=$2 OR lower(l.name)=lower($2))
    UNION ALL
    SELECT a.bin_id,a.bin_name,l.id,l.parent_location_id,l.kind,a.path||l.id
    FROM ancestors a JOIN locations l ON l.workspace_id=$1 AND l.id=a.parent_location_id
    WHERE l.is_active=1 AND l.custody_agreement_id IS NULL AND NOT l.id=ANY(a.path))
    SELECT bin_id AS id,bin_name AS name,ancestors.id AS warehouse_id,path FROM ancestors WHERE parent_location_id IS NULL
      AND kind='warehouse' AND ($3='' OR ancestors.id=$3) LIMIT 2`,[ctx.workspaceId,name,warehouseId])).rows;
  if(rows.length!==1)throw new ValidationError('Choose one active bin in this warehouse.');
  await source.lockBins(db,ctx.workspaceId,rows[0].path);
  return rows[0];
}

async function saveDistance(db,ctx,input) {
  const metres=String(input.metres??'').trim();
  if(!/^\d{1,9}(\.\d{1,2})?$/.test(metres))throw new ValidationError('Enter the walking distance to packing in metres.');
  return tx(db,async c=>{
    await authority(c,ctx,{lock:true});
    const bin=await findBin(c,ctx,input);
    await c.query(`INSERT INTO stockchief_runtime.bin_packing_distances(workspace_id,location_id,metres,updated_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(workspace_id,location_id) DO UPDATE SET metres=EXCLUDED.metres,updated_by=EXCLUDED.updated_by,updated_at=now()
      WHERE bin_packing_distances.metres<>EXCLUDED.metres`,[ctx.workspaceId,bin.id,metres,ctx.actorId]);
    await audit.record(c,ctx,{action:'Recorded bin distance to packing',reference:bin.name,after:{metres}});
    return bin;
  });
}

async function saveCapacity(db,ctx,input) {
  return tx(db,async c=>{
    await authority(c,ctx,{lock:true});
    const bin=await findBin(c,ctx,input),sku=await product(c,ctx,input.sku);
    const key=[ctx.workspaceId,bin.id,sku.sku_id];
    const prior=(await c.query(`SELECT revision FROM ${source.capacities} WHERE workspace_id=$1 AND location_id=$2 AND sku_id=$3 FOR UPDATE`,key)).rows[0];
    if(input.remove==='yes'){
      if(!prior||prior.revision!==input.revision)throw new ValidationError('Open the current bin fit before removing it.');
      await c.query(`DELETE FROM ${source.capacities} WHERE workspace_id=$1 AND location_id=$2 AND sku_id=$3`,key);
      await audit.record(c,ctx,{action:'Removed a checked bin fit',reference:bin.name,after:{sku:sku.code}});
      return bin;
    }
    if(input.confirmed!=='yes')throw new ValidationError('Confirm you checked that this product fits this bin safely.');
    const {primary,secondary}=source.limits(sku,input);
    if(!prior)await storage.reserve(c,ctx.workspaceId,'slot-capacity:'+bin.id+':'+sku.sku_id,4096,{finished:true});
    await c.query(`INSERT INTO ${source.capacities}(workspace_id,location_id,sku_id,primary_limit,secondary_limit,profile_hash,revision,recorded_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,location_id,sku_id) DO UPDATE SET
        primary_limit=EXCLUDED.primary_limit,secondary_limit=EXCLUDED.secondary_limit,profile_hash=EXCLUDED.profile_hash,
        revision=EXCLUDED.revision,recorded_by=EXCLUDED.recorded_by
      WHERE (agent_slotting_capacities.primary_limit,agent_slotting_capacities.secondary_limit,agent_slotting_capacities.profile_hash)
        IS DISTINCT FROM (EXCLUDED.primary_limit,EXCLUDED.secondary_limit,EXCLUDED.profile_hash)`,
    [...key,primary,secondary,source.profileHash(sku),newId('slot-capacity'),ctx.actorId]);
    await audit.record(c,ctx,{action:'Recorded a checked bin fit',reference:bin.name,after:{sku:sku.code,primary,secondary}});
    return bin;
  });
}

function options(input) {
  const maximumMoves=Number(input.maximumMoves??50),minimumVisits=Number(input.minimumVisits??1);
  if(!Number.isSafeInteger(maximumMoves)||maximumMoves<1||maximumMoves>250||
    !Number.isSafeInteger(minimumVisits)||minimumVisits<1||minimumVisits>1000000)
    throw new ValidationError('Choose 1 to 250 moves and at least 1 pick.');
  return {maximumMoves,minimumVisits};
}

function unitLimit(value) {
  let limit;
  try{limit=exact.canonical(String(value??'').trim(),{label:'Most units in one move'});}
  catch{throw new ValidationError('Enter the most units StockChief may move in one move on its own.');}
  if(cmp(limit,'0')<=0||cmp(limit,String(MAX_QUANTITY))>0)throw new ValidationError('Enter the most units StockChief may move in one move on its own.');
  return limit;
}

async function configure(db,ctx,input) {
  return tx(db,async c=>{
    await owner(c,ctx,true);
    const id=String(input.warehouseId||'');
    const current=(await c.query(`SELECT * FROM ${schedules} WHERE workspace_id=$1 AND warehouse_id=$2 FOR UPDATE`,[ctx.workspaceId,id])).rows[0];
    if((current?.revision||'')!==(input.revision||''))throw new ValidationError('Open the current warehouse schedule before changing it.');
    // Anyone can stop routine work, on any plan. Starting it needs Custom.
    if(input.stop==='yes'){
      if(current?.enabled){
        await c.query(`UPDATE ${schedules} SET enabled=false,revision=$3 WHERE workspace_id=$1 AND warehouse_id=$2`,[ctx.workspaceId,id,newId('slot-schedule')]);
        await audit.record(c,ctx,{action:'Stopped routine warehouse re-slots',reference:id});
      }
      return {stopped:true};
    }
    await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
    const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,122,'automatic');
    await require('../commercial/enforcement').workspace(c,ctx.workspaceId,'inventory.core');
    const stop=await policy.stopped(c,ctx.workspaceId,account,action,false);
    if(stop)throw new ValidationError(stop);
    const site=await warehouse(c,ctx.workspaceId,id),cadenceDays=Number(input.cadenceDays),scope=options(input),maximumUnits=unitLimit(input.maximumUnits);
    if(input.confirmed!=='yes'||![1,7].includes(cadenceDays))throw new ValidationError('Confirm this warehouse, how often, and your limits.');
    if(!current?.enabled)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    if(!current)await storage.reserve(c,ctx.workspaceId,'slot-schedule:'+id,4096,{finished:true});
    const today=await time.today(c,ctx.workspaceId),revision=newId('slot-schedule');
    await c.query(`INSERT INTO ${schedules}(workspace_id,warehouse_id,authorized_by,revision,cadence_days,maximum_moves,maximum_units,minimum_visits,next_on,enabled)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true) ON CONFLICT(workspace_id,warehouse_id) DO UPDATE SET
        authorized_by=EXCLUDED.authorized_by,revision=EXCLUDED.revision,cadence_days=EXCLUDED.cadence_days,maximum_moves=EXCLUDED.maximum_moves,
        maximum_units=EXCLUDED.maximum_units,minimum_visits=EXCLUDED.minimum_visits,next_on=EXCLUDED.next_on,enabled=true`,
    [ctx.workspaceId,id,ctx.actorId,revision,cadenceDays,scope.maximumMoves,maximumUnits,scope.minimumVisits,today]);
    await audit.record(c,ctx,{action:'Authorized routine warehouse re-slots',reference:site.name,after:{...scope,maximumUnits,cadenceDays}});
    return {revision,enabled:true};
  });
}

async function savePlan(db,ctx,snapshot,automatic) {
  const fingerprint=hash([ctx.actorId,automatic,snapshot]),keys=[ctx.workspaceId,snapshot.warehouse.id,fingerprint];
  const find=async()=>(await db.query(`SELECT * FROM ${plans} WHERE workspace_id=$1 AND warehouse_id=$2 AND evidence_hash=$3`,keys)).rows[0];
  const prior=await find();
  if(prior)return {saved:prior,replayed:true};
  const id=newId('slot-plan');
  await storage.reserve(db,ctx.workspaceId,'slot-plan:'+id,4096+Buffer.byteLength(JSON.stringify(snapshot))*2,{finished:true});
  const saved=(await db.query(`INSERT INTO ${plans}(workspace_id,warehouse_id,evidence_hash,id,prepared_by,automatic,snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[...keys,id,ctx.actorId,automatic,snapshot])).rows[0];
  return {saved,replayed:false};
}

async function prepare(db,ctx,input) {
  return tx(db,async c=>{
    await authority(c,ctx,{lock:true});
    const site=await warehouse(c,ctx.workspaceId,input.warehouseId);
    const result=await savePlan(c,ctx,await source.snapshot(c,ctx,site,options(input)),false);
    if(!result.replayed)await audit.record(c,ctx,{action:'Prepared a warehouse move list',reference:site.name,
      after:{planId:result.saved.id,moves:result.saved.snapshot.moves.length}});
    return {id:result.saved.id,replayed:result.replayed};
  });
}

async function load(db,workspaceId,id,{lock=false}={}) {
  const saved=(await db.query(`SELECT * FROM ${plans} WHERE workspace_id=$1 AND id=$2 ${lock?'FOR UPDATE':''}`,[workspaceId,id])).rows[0];
  if(!saved)throw new NotFoundError('That warehouse move list is not in this inventory.');
  return saved;
}

const unchecked=move=>'Record that this product fits '+move.to.name+' before StockChief moves it on its own.';

function routineBlocker(move,schedule) {
  if(move.protections.length)return source.reasons[move.protections[0]]+' A person must approve this move.';
  if(!move.checked)return unchecked(move);
  if(cmp(move.quantity,schedule.maximum_units)>0)
    return 'Over your limit: this move is '+move.quantity+' and you allow '+exact.canonical(String(schedule.maximum_units))+' in one move.';
  return null;
}

// Reserves and approves one move through the ordinary transfer workflow, after
// checking the live stock, bins and bin fit still match what was approved.
// Staff then pick, move and receive it like any other transfer.
async function carryOut(c,ctx,saved,move,{automatic=false,schedule=null}={}) {
  const key=[ctx.workspaceId,saved.id,move.fingerprint];
  const existing=(await c.query(`SELECT m.transfer_id,t.transfer_number FROM ${moves} m JOIN inventory_transfers t ON t.workspace_id=m.workspace_id AND t.id=m.transfer_id
    WHERE m.workspace_id=$1 AND m.plan_id=$2 AND m.move_hash=$3`,key)).rows[0];
  if(existing)return {transferId:existing.transfer_id,transferNumber:existing.transfer_number,replayed:true};
  await source.lockBins(c,ctx.workspaceId,[...new Set([...move.from.path,...move.to.path])]);
  await c.query('SELECT location_id FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE',[ctx.workspaceId,move.skuId,move.from.id]);
  const fresh=await source.currentMove(c,ctx,saved.warehouse_id,move,saved.snapshot.minimumVisits);
  if(!fresh||fresh.fingerprint!==move.fingerprint||cmp(fresh.quantity,move.quantity)<0)
    throw new ValidationError('The stock, the bins or the checked bin fit changed since this list was made. Prepare a fresh list.');
  if(automatic){
    const blocker=routineBlocker({...fresh,quantity:move.quantity},schedule);
    if(blocker)throw new ValidationError(blocker);
  }else{
    const added=fresh.protections.find(p=>!move.protections.includes(p));
    if(added)throw new ValidationError(source.reasons[added]+' This changed after the list was made. Prepare a fresh list.');
  }
  const reference='warehouse-slotting:'+saved.id+':'+move.fingerprint;
  const transfer=await transfers.requestInTransaction(c,ctx,{fromLocationId:move.from.id,toLocationId:move.to.id,
    idempotencyKey:reference,reason:'Warehouse re-slot',reference:saved.id,skipDefaultDemandPegs:true,lines:move.lines,
    notes:move.visits+' picks in 90 days. '+move.to.name+' is '+move.metresSaved+' m closer to packing.',
    decisionDetail:{kind:'agent_slotting_move',planId:saved.id,moveHash:move.fingerprint,automatic}});
  const approved=await transfers.approveInTransaction(c,ctx,transfer.id,{idempotencyKey:reference+':approve'});
  await storage.reserve(c,ctx.workspaceId,'slot-move:'+transfer.id,4096,{finished:true});
  await c.query(`INSERT INTO ${moves}(workspace_id,plan_id,move_hash,transfer_id,approved_by,automatic) VALUES($1,$2,$3,$4,$5,$6)`,
    [...key,transfer.id,ctx.actorId,automatic]);
  await c.query(`UPDATE ${plans} SET problems=problems-$3::text WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,saved.id,move.fingerprint]);
  await audit.record(c,ctx,{action:automatic?'Approved a warehouse re-slot move on its own':'Approved a warehouse re-slot move',
    reference:approved.transfer_number,after:{planId:saved.id,sku:move.code,from:move.from.name,to:move.to.name,
      quantity:move.quantity,secondaryQuantity:move.secondaryQuantity,automatic,...(schedule?{limit:String(schedule.maximum_units)}:{})}});
  return {transferId:transfer.id,transferNumber:approved.transfer_number,replayed:false};
}

// Tries each move on its own, so one changed bin never blocks the rest, and
// records why any move was held.
async function carryOutEach(c,ctx,saved,selected,options) {
  const done=[],problems={};
  for(const move of selected){
    await c.query('SAVEPOINT warehouse_slotting_move');
    try{
      done.push(await carryOut(c,ctx,saved,move,options));
      await c.query('RELEASE SAVEPOINT warehouse_slotting_move');
    }catch(error){
      if(!expected(error))throw error;
      await c.query('ROLLBACK TO SAVEPOINT warehouse_slotting_move');
      problems[move.fingerprint]=error.message;
    }
  }
  if(Object.keys(problems).length)await c.query(`UPDATE ${plans} SET problems=problems||$3::jsonb WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,saved.id,JSON.stringify(problems)]);
  return {done,problems};
}

async function pending(c,workspaceId,saved) {
  const taken=new Set((await c.query(`SELECT move_hash FROM ${moves} WHERE workspace_id=$1 AND plan_id=$2`,[workspaceId,saved.id])).rows.map(r=>r.move_hash));
  return saved.snapshot.moves.filter(m=>!taken.has(m.fingerprint));
}

async function approve(db,ctx,id,input) {
  return tx(db,async c=>{
    await authority(c,ctx,{lock:true,act:true});
    const saved=await load(c,ctx.workspaceId,id,{lock:true});
    if(input.confirmed!=='yes')throw new ValidationError('Confirm you checked these moves.');
    if(input.move==='all'){
      const selected=await pending(c,ctx.workspaceId,saved);
      if(!selected.length)throw new ValidationError('Every move on this list has already been approved.');
      const result=await carryOutEach(c,ctx,saved,selected,{automatic:false});
      return {approved:result.done.length,held:Object.keys(result.problems).length};
    }
    const move=saved.snapshot.moves.find(m=>m.fingerprint===input.move);
    if(!move)throw new ValidationError('Choose a move from this list.');
    const result=await carryOut(c,ctx,saved,move,{automatic:false});
    return {...result,approved:1,held:0};
  });
}

async function undo(db,ctx,id,input) {
  return tx(db,async c=>{
    await owner(c,ctx,true);
    const row=(await c.query(`SELECT * FROM ${moves} WHERE workspace_id=$1 AND plan_id=$2 AND move_hash=$3 FOR UPDATE`,
      [ctx.workspaceId,id,String(input.move||'')])).rows[0];
    if(!row)throw new NotFoundError('That approved move is not on this list.');
    if(row.undone_at)return {transferId:row.transfer_id,replayed:true};
    const transfer=await transfers.get(c,ctx.workspaceId,row.transfer_id,{lock:true});
    if(transfer.status!=='APPROVED')throw new ValidationError(transfer.status==='CANCELLED'
      ?'This move was already cancelled.':'Staff have started this move. Finish or cancel it from its transfer.');
    await transfers.cancelInTransaction(c,ctx,transfer.id,{idempotencyKey:'warehouse-slotting-undo:'+transfer.id,reason:'The owner undid this re-slot move.'});
    await c.query(`UPDATE ${moves} SET undone_at=clock_timestamp(),undone_by=$4 WHERE workspace_id=$1 AND plan_id=$2 AND move_hash=$3`,
      [ctx.workspaceId,id,row.move_hash,ctx.actorId]);
    await audit.record(c,ctx,{action:'Undid a warehouse re-slot move',reference:transfer.transfer_number,after:{planId:id,automatic:row.automatic}});
    return {transferId:transfer.id,replayed:false};
  });
}

async function due(db,workspaceId) {
  const today=await time.today(db,workspaceId);
  return (await db.query(`SELECT warehouse_id,authorized_by,revision,next_on::text AS due_on FROM ${schedules}
    WHERE workspace_id=$1 AND enabled AND next_on<=$2 AND authorized_by IS NOT NULL ORDER BY next_on,warehouse_id`,[workspaceId,today])).rows;
}

async function enqueue(db,workspaceId,cycleId) {
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,122,'automatic'))return;
  if((await routine(db,workspaceId,account)).watch)return;
  for(const r of await due(db,workspaceId))await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind,
    idempotencyKey:'slot-plan:'+r.revision+':'+r.due_on+':'+cycleId,priority:64,maxAttempts:3,
    payload:{warehouseId:r.warehouse_id,actorId:r.authorized_by,revision:r.revision,dueOn:r.due_on}});
}

// Custom: prepares the list on the owner's schedule and approves the moves
// that sit inside the owner's limits. Anything protected, unchecked or over
// a limit waits for a person. Under Ask me first the whole list waits.
async function run(job,c) {
  const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId};
  try{
    await owner(c,ctx,true);
    await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
    const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,122,'automatic');
    await require('../commercial/enforcement').workspace(c,ctx.workspaceId,'inventory.core');
    const mode=await routine(c,ctx.workspaceId,account);
    if(mode.watch)return {held:mode.watch};
    const r=(await c.query(`SELECT *,next_on::text AS due_on FROM ${schedules} WHERE workspace_id=$1 AND warehouse_id=$2 FOR UPDATE`,
      [ctx.workspaceId,job.payload.warehouseId])).rows[0];
    const today=await time.today(c,ctx.workspaceId);
    if(!r?.enabled||r.authorized_by!==ctx.actorId||r.revision!==job.payload.revision||r.due_on!==job.payload.dueOn||r.due_on>today)
      return {held:'This warehouse schedule is no longer due, or its limits changed.'};
    const site=await warehouse(c,ctx.workspaceId,r.warehouse_id);
    const {saved}=await savePlan(c,ctx,await source.snapshot(c,ctx,site,{maximumMoves:r.maximum_moves,minimumVisits:r.minimum_visits}),true);
    let result={done:[],problems:{}};
    if(mode.ask){
      const waiting=Object.fromEntries((await pending(c,ctx.workspaceId,saved)).map(m=>[m.fingerprint,mode.ask]));
      if(Object.keys(waiting).length)await c.query(`UPDATE ${plans} SET problems=problems||$3::jsonb WHERE workspace_id=$1 AND id=$2`,
        [ctx.workspaceId,saved.id,JSON.stringify(waiting)]);
      result.problems=waiting;
    }else result=await carryOutEach(c,ctx,saved,await pending(c,ctx.workspaceId,saved),{automatic:true,schedule:r});
    await c.query(`UPDATE ${schedules} SET next_on=$3 WHERE workspace_id=$1 AND warehouse_id=$2`,
      [ctx.workspaceId,r.warehouse_id,addDays(today,r.cadence_days)]);
    await audit.record(c,ctx,{action:'Ran routine warehouse re-slot',reference:site.name,
      after:{planId:saved.id,approved:result.done.filter(d=>!d.replayed).length,waiting:Object.keys(result.problems).length,askFirst:Boolean(mode.ask)}});
    return {planId:saved.id,approved:result.done.filter(d=>!d.replayed).length,waiting:Object.keys(result.problems).length};
  }catch(error){
    if(expected(error))return {held:error.message};
    throw error;
  }
}

async function schedulePage(db,ctx) {
  await owner(db,ctx);
  const account=await policy.accountState(db,ctx.workspaceId);
  const canSchedule=policy.usesAgentTerms(account)&&policy.permits(account.plan,122,'automatic');
  const rows=(await db.query(`SELECT r.*,r.next_on::text AS due_on,l.name FROM ${schedules} r
    JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.warehouse_id
    WHERE r.workspace_id=$1 AND r.enabled ORDER BY lower(l.name),l.id`,[ctx.workspaceId])).rows;
  return {canSchedule,rows};
}

function status(move,link,problem) {
  if(link?.undone_at)return {label:'Undone',tone:'muted'};
  if(link){
    const labels={APPROVED:['Approved · ready to move','info'],PICKED:['Picked','info'],SHIPPED:['On its way','info'],IN_TRANSIT:['On its way','info'],
      PARTIALLY_RECEIVED:['Partly put away','info'],RECEIVED:['Done','ok'],CANCELLED:['Cancelled','muted']};
    const [label,tone]=labels[link.status]||[link.status,'muted'];
    return {label,tone};
  }
  return problem?{label:'Waiting for you',tone:'warn'}:{label:'Waiting for approval',tone:'warn'};
}

async function page(db,ctx,{id,warehouseId,after=0}={}) {
  const account=await authority(db,ctx);
  const offset=Number(after);
  if(!Number.isSafeInteger(offset)||offset<0||offset>1000000)throw new ValidationError('Choose a valid page.');
  const canSchedule=policy.permits(account.plan,122,'automatic');
  const blocked=await policy.stopped(db,ctx.workspaceId,account,action,false);
  if(id){
    const saved=await load(db,ctx.workspaceId,id);
    const links=(await db.query(`SELECT m.move_hash,m.automatic,m.undone_at,t.id,t.transfer_number,t.status FROM ${moves} m
      JOIN inventory_transfers t ON t.workspace_id=m.workspace_id AND t.id=m.transfer_id
      WHERE m.workspace_id=$1 AND m.plan_id=$2`,[ctx.workspaceId,id])).rows;
    const rows=saved.snapshot.moves.slice(offset,offset+25).map(m=>{
      const link=links.find(l=>l.move_hash===m.fingerprint),problem=link?null:saved.problems?.[m.fingerprint]||null;
      // A routine hold that only repeats a listed warning is not shown twice.
      const repeats=problem&&(m.protections.some(p=>problem.startsWith(source.reasons[p]))||!m.checked&&problem===unchecked(m));
      return {...m,link,problem:repeats?null:problem,status:status(m,link,problem),canUndo:link?.status==='APPROVED'&&!link.undone_at,
        warnings:m.protections.map(p=>source.reasons[p]).concat(m.checked?[]:['Bin fit not checked yet.'])};
    });
    const waiting=saved.snapshot.moves.length-links.length,approved=links.filter(l=>!l.undone_at&&l.status!=='CANCELLED').length;
    return {saved,rows,blocked,waiting,approved,held:saved.snapshot.held.slice(offset,offset+25),
      next:Math.max(saved.snapshot.moves.length,saved.snapshot.held.length)>offset+25?offset+25:null};
  }
  const sites=await source.warehouses(db,ctx.workspaceId);
  const site=warehouseId?await warehouse(db,ctx.workspaceId,warehouseId):sites[0];
  if(!site)return {sites,canSchedule,blocked,recent:[],capacities:[],bins:[]};
  const layout=await source.bins(db,ctx.workspaceId,site.id);
  const [recent,capacity,rule]=await Promise.all([
    db.query(`SELECT p.id,p.created_at,p.automatic,p.snapshot->>'asOf' AS as_of,jsonb_array_length(p.snapshot->'moves') AS moves,
      (SELECT count(*)::int FROM ${moves} m WHERE m.workspace_id=p.workspace_id AND m.plan_id=p.id AND m.undone_at IS NULL) AS approved
      FROM ${plans} p WHERE p.workspace_id=$1 AND p.warehouse_id=$2 ORDER BY p.created_at DESC,p.id DESC LIMIT 26 OFFSET $3`,
    [ctx.workspaceId,site.id,offset]),
    db.query(`SELECT c.*,l.name AS bin,s.code,i.unit_label,i.secondary_unit_label FROM ${source.capacities} c
      JOIN locations l ON l.workspace_id=c.workspace_id AND l.id=c.location_id
      JOIN skus s ON s.workspace_id=c.workspace_id AND s.id=c.sku_id
      JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE c.workspace_id=$1 AND c.location_id=ANY($2::text[]) ORDER BY lower(l.name),s.code,l.id,s.id`,[ctx.workspaceId,layout.map(b=>b.id)]),
    db.query(`SELECT *,next_on::text AS due_on,maximum_units::text AS limit_units FROM ${schedules} WHERE workspace_id=$1 AND warehouse_id=$2`,[ctx.workspaceId,site.id])
  ]);
  return {sites,site,canSchedule,blocked,recent:recent.rows.slice(0,25),next:recent.rows.length>25?offset+25:null,
    capacities:capacity.rows,bins:layout,rule:rule.rows[0]};
}

function reviewRows(snapshots,filter='',page=1) {
  const rows=snapshots.flatMap(snapshot=>snapshot.moves.filter(m=>!filter||
    [m.code,m.name,snapshot.warehouse.name,m.from.name,m.to.name].some(s=>s.toLowerCase()===filter.toLowerCase()))
    .map(m=>({SKU:m.code,Product:m.name,Site:snapshot.warehouse.name,From:m.from.name,To:m.to.name,
      'Available units':Number(m.free),'Units to move':Number(m.quantity),'Order picks in 90 days':m.visits,
      'Metres closer to packing':Number(m.metresSaved),'Check first':m.protections.map(p=>source.reasons[p]).join(' ')})));
  return {rows:rows.slice((page-1)*100,page*100),more:rows.length>page*100,summary};
}

async function review(db,ctx,{filter='',page=1}={}) {
  const snapshots=[];
  for(const site of await source.warehouses(db,ctx.workspaceId))
    snapshots.push(await source.snapshot(db,ctx,site,options({maximumMoves:250})));
  return reviewRows(snapshots,filter,page);
}

const definition={id:122,key:'warehouse-slotting',label:'Plan warehouse bin moves',filterLabel:'SKU, product, site or bin',readPage:review};
module.exports={path,kind,saveDistance,saveCapacity,configure,prepare,approve,undo,enqueue,run,page,schedulePage,definition};
