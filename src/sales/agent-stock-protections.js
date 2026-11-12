'use strict';

// Job 12: keep stock reserved for big customers and upcoming orders.
//
// The owner says which customers count as big, or which upcoming order to
// protect (an expected order on a date, or a repeating order pattern). Each
// reservation row is a sales commitment like an order allocation: it is read
// through the sales_stock_commitments view, so orders, channels, reorder and
// stock pages all see it as not available. Nothing physical moves.
//
// Taking stock (a new hold or a top-up) follows the plan mode: Pro proposes
// until the owner has taught it through a saved rule ("reserve on its own") or
// an individually approved example; Custom acts on its own. Both respect
// shadow, Watch only, pause, routine authority and "Ask me first".
// Giving stock back follows the owner's own dates and the physical truth:
// an expired reservation stops holding at its end time (inside the view),
// and a reservation is cut back when the stock behind it is physically gone.
// When the protected customer's order is confirmed, that order uses the
// reserved stock first, and a one-time reservation ends there.
// Every change is written to the change log and the security audit, and every
// change except stock already handed to an order can be undone.

const {newId,nowIso}=require('../lib/util');
const {ValidationError,NotFoundError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const stock=require('../domain/postgres-stock-availability');
const businessTime=require('../lib/business-time');

const JOB=12,ACTION='inventory.protect_stock',KIND='agent.stock-protection.v1',href='/autopilot/protected-stock';
const P='stockchief_runtime.agent_stock_protections',R='stockchief_runtime.agent_stock_reservations',C='stockchief_runtime.agent_stock_reservation_changes';
const MAX_LINES=50,MAX_UNITS=1000000,LOWERED='The owner lowered the protected amount.';
const PROTECTION_COLUMNS=`p.id,p.workspace_id,p.customer_id,p.location_id,p.kind,p.lines,p.next_on::text AS next_on,p.every_days,p.lead_days,
 p.grace_days,p.ends_on::text AS ends_on,p.routine,p.example_id,p.enabled,p.problem,p.revision,p.authorized_by,p.request_key,p.checked_at,p.created_at,p.updated_at`;
// Reservation changes read stock positions after locking them, so they run at
// READ COMMITTED like order confirmation and see every committed allocation.
const tx=(db,fn)=>db.transaction(fn,{isolation:'READ COMMITTED',retrySafe:true});
const expected=error=>['validation_error','entitlement_required','forbidden','not_found'].includes(error?.code);
const words={held:'Reserved stock for a customer',topped_up:'Topped up a customer reservation',trimmed:'Cut a reservation to the stock on hand',
 released:'Released a customer reservation',expired:'Released an expired customer reservation',order_arrived:'Passed reserved stock to the customer’s order',
 undone:'Undid a protected stock change',removed:'Released stock no longer protected',plan:'Released protected stock outside the current plan'};

function text(value,label,max=200){
  const clean=String(value??'').trim();
  if(!clean||clean.length>max||/[\u0000-\u001f\u007f]/u.test(clean))throw new ValidationError('Enter '+label+'.');
  return clean;
}
function whole(value,label,{min=0,max=MAX_UNITS}={}){
  const clean=String(value??'').trim();
  if(!/^\d{1,9}$/.test(clean))throw new ValidationError(label+' must be a whole number.');
  const n=Number(clean);
  if(n<min||n>max)throw new ValidationError(label+' must be from '+min+' to '+max+'.');
  return n;
}
function day(value,label){
  const clean=String(value??'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(clean)||!Number.isFinite(Date.parse(clean+'T00:00:00Z'))||
    new Date(clean+'T00:00:00Z').toISOString().slice(0,10)!==clean)throw new ValidationError('Choose a real date for '+label+'.');
  return clean;
}
function addDays(date,count){return new Date(Date.parse(date+'T00:00:00Z')+count*86400000).toISOString().slice(0,10);}

async function owner(db,ctx){
  const row=(await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the business owner can protect stock for customers.');
}
async function currentOwner(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}
async function protection(db,ctx,id,{lock=false}={}){
  const row=(await db.query(`SELECT ${PROTECTION_COLUMNS} FROM ${P} p WHERE p.workspace_id=$1 AND p.id=$2`+(lock?' FOR UPDATE':''),
    [ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That stock protection is not in this inventory.');
  return row;
}
async function reservation(db,ctx,id,{lock=false}={}){
  const row=(await db.query(`SELECT * FROM ${R} WHERE workspace_id=$1 AND id=$2`+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That reservation is not in this inventory.');
  return row;
}

// Only plain whole-unit goods can be protected here. Lots, serials, weights and
// kits keep their own exact reservation workflows.
async function products(db,ctx,{ids=null,codes=null}){
  return (await db.query(`SELECT s.id,s.code,i.name,i.unit_label,i.tracking_mode,i.quantity_precision,i.secondary_unit_label,
      s.is_active=1 AND i.is_active=1 AS active,
      EXISTS(SELECT 1 FROM kit_components k WHERE k.workspace_id=s.workspace_id AND k.kit_sku_id=s.id) AS kit
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND (($2::text[] IS NOT NULL AND s.id=ANY($2::text[])) OR ($3::text[] IS NOT NULL AND lower(s.code)=ANY($3::text[])))`,
  [ctx.workspaceId,ids,codes&&codes.map(c=>c.toLowerCase())])).rows;
}
function unsupported(product){
  if(!product.active)return product.code+' is no longer active.';
  if(product.kit)return product.code+' is a kit. Protect its parts instead.';
  if(product.tracking_mode!=='quantity'||Number(product.quantity_precision)!==0||product.secondary_unit_label)
    return product.code+' is tracked by lot, serial or weight. Reserve it on its order instead.';
  return null;
}
// When facts are missing or don't match, nothing new is reserved and the owner is asked.
async function facts(db,ctx,p){
  const customer=(await db.query('SELECT id,name,record_state FROM customers WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.customer_id])).rows[0];
  if(!customer||customer.record_state!=='ACTIVE')return {problem:'This customer is no longer active. Review the protection.'};
  const location=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',
    [ctx.workspaceId,p.location_id])).rows[0];
  if(!location)return {problem:'This location is no longer an active location you own. Review the protection.'};
  const found=await products(db,ctx,{ids:p.lines.map(l=>l.skuId)});
  for(const line of p.lines){
    const product=found.find(s=>s.id===line.skuId);
    if(!product)return {problem:'A protected product was removed. Review the protection.'};
    const reason=unsupported(product);
    if(reason)return {problem:reason};
  }
  return {customer,location,products:found};
}

async function established(db,ctx,customerId){
  return (await db.query(`SELECT 1 FROM sales_orders WHERE workspace_id=$1 AND customer_id=$2 AND confirmed_at IS NOT NULL
    AND status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED') LIMIT 1`,[ctx.workspaceId,customerId])).rowCount>0;
}
// Pro is taught by the owner's saved rule on this protection, or by one reservation
// of this protection the owner individually approved that is still in force.
async function taught(db,ctx,p){
  if(p.routine)return true;
  if(!p.example_id)return false;
  return (await db.query(`SELECT 1 FROM ${C} c JOIN ${R} r ON r.workspace_id=c.workspace_id AND r.id=c.reservation_id
    WHERE c.workspace_id=$1 AND r.protection_id=$2 AND c.authority='INDIVIDUAL' AND c.kind IN ('held','topped_up') AND c.undone_at IS NULL LIMIT 1`,
  [ctx.workspaceId,p.id])).rowCount>0;
}
async function authority(db,ctx,p,state=null){
  state=state||await policy.accountState(db,ctx.workspaceId);
  const plan=policy.usesAgentTerms(state)?state.plan:null;
  if(!policy.permits(plan,JOB,'draft'))return {mode:'excluded',reason:'Protected stock needs the Pro or Custom plan.',state};
  const watch=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
  if(watch)return {mode:'watch',reason:watch,state};
  const pro=policy.allowance(plan,JOB)==='trained';
  const learned=pro?await taught(db,ctx,p):true;
  if(!policy.permits(plan,JOB,'automatic',{trained:learned}))
    return {mode:'draft',reason:'StockChief suggests each reservation until you approve one, or let it reserve this on its own.',state};
  if(!await established(db,ctx,p.customer_id))
    return {mode:'draft',reason:'This customer has no confirmed orders yet, so you approve the first reservation.',state};
  const stop=await policy.stopped(db,ctx.workspaceId,state,ACTION,true);
  if(stop)return {mode:'draft',reason:stop,state};
  if(!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)
    return {mode:'draft',reason:'Routine work is not turned on, so StockChief asks you first.',state};
  return {mode:'auto',kind:pro?'TRAINED':'CUSTOM',state};
}

// Confirmed orders still waiting for this product here come before any reservation.
async function waiting(db,workspaceId,skuId,locationId){
  const row=(await db.query(`SELECT coalesce(sum(greatest(need,0)),0)::text AS n FROM (
    SELECT l.quantity_ordered-l.quantity_fulfilled-coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0)
      -coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id),0) AS need
    FROM sales_order_lines l JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
    WHERE l.workspace_id=$1 AND l.sku_id=$2 AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED') AND o.confirmed_at IS NOT NULL
      AND (o.fulfillment_location_id=$3 OR o.fulfillment_location_id IS NULL)
      AND NOT EXISTS(SELECT 1 FROM sales_order_kit_components k WHERE k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id)
    UNION ALL
    SELECT k.quantity_required-k.quantity_fulfilled
      -coalesce((SELECT sum(a.quantity) FROM sales_order_kit_allocations a WHERE a.workspace_id=k.workspace_id AND a.kit_component_id=k.id),0)
    FROM sales_order_kit_components k JOIN sales_order_lines l ON l.workspace_id=k.workspace_id AND l.id=k.sales_order_line_id
    JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
    WHERE k.workspace_id=$1 AND k.component_sku_id=$2 AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED') AND o.confirmed_at IS NOT NULL
      AND (o.fulfillment_location_id=$3 OR o.fulfillment_location_id IS NULL)) waiting`,[workspaceId,skuId,locationId])).rows[0];
  const n=Number(row.n);
  if(!Number.isSafeInteger(n))throw new ValidationError('Waiting orders for this product need an exact quantity review.');
  return n;
}
// What this reservation can hold: stock not promised to anything else, read as
// if this reservation were not there, and what is still free beyond it.
async function room(db,ctx,r){
  const position=(await stock.readMany(db,ctx.workspaceId,[{skuId:r.sku_id,locationId:r.location_id}],{reservationId:r.id}))
    .get(stock.key(r.sku_id,r.location_id))||{available:0};
  const queued=await waiting(db,ctx.workspaceId,r.sku_id,r.location_id),available=Number(position.available);
  if(!Number.isSafeInteger(available))throw new ValidationError('This stock position needs an exact quantity review.');
  return {available,waiting:queued,free:Math.max(0,available-Number(r.held)-queued)};
}
async function lockPositions(db,ctx,skuIds,locationId){
  await db.query('SELECT sku_id FROM balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND location_id=$3 ORDER BY sku_id,location_id FOR UPDATE',
    [ctx.workspaceId,[...new Set(skuIds)].sort(),locationId]);
}

async function record(db,ctx,r,{kind,delta,heldAfter,authority:who,orderId=null,undoes=null,requestKey=null,handedOver=0,reason=null}){
  const id=newId('stock-change');
  await db.query(`INSERT INTO ${C}(id,workspace_id,reservation_id,kind,delta,held_after,handed_over,authority,actor_id,sales_order_id,undoes,request_key,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
  [id,ctx.workspaceId,r.id,kind,delta,heldAfter,handedOver,who,ctx.actorId||null,orderId,undoes,requestKey,reason]);
  await audit.record(db,ctx,{action:words[kind],reference:r.id,before:{held:heldAfter-delta},
    after:{held:heldAfter,change:delta,customerId:r.customer_id,skuId:r.sku_id,locationId:r.location_id,authority:who,orderId,changeId:id}});
  return id;
}
async function setHeld(db,ctx,r,held,{kind,authority:who,reason=null,requestKey=null,undoes=null,target=r.target,kept=r.kept,expiresAt=r.expires_at}){
  const delta=held-Number(r.held);
  const updated=(await db.query(`UPDATE ${R} SET held=$3::int,proposed=least(proposed,$4::int-$3::int),target=$4::int,kept=$5::boolean,expires_at=$6::timestamptz,status='OPEN',release_reason=NULL,
      released_at=NULL,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *`,
  [ctx.workspaceId,r.id,held,target,kept,expiresAt])).rows[0];
  if(delta)await record(db,ctx,r,{kind,delta,heldAfter:held,authority:who,reason,requestKey,undoes});
  return updated;
}
async function close(db,ctx,r,reasonCode,{kind,authority:who,orderId=null,requestKey=null,handedOver=0,undoes=null}){
  const before=Number(r.held);
  const updated=(await db.query(`UPDATE ${R} SET held=0,proposed=0,status='RELEASED',release_reason=$3,released_at=now(),
      sales_order_id=coalesce($4,sales_order_id),revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *`,
  [ctx.workspaceId,r.id,reasonCode,orderId])).rows[0];
  if(before)await record(db,ctx,r,{kind,delta:-before,heldAfter:0,authority:who,orderId,requestKey,handedOver,undoes});
  return updated;
}

// The reservation this protection should have today, or none.
function cycle(p,today,timeZone){
  const key=date=>date+'#'+p.revision;
  if(p.kind==='customer'){
    if(p.ends_on&&today>p.ends_on)return {open:false,key:key('standing')};
    return {open:true,key:key('standing'),oneTime:false,expiresAt:p.ends_on?businessTime.dayBoundary(p.ends_on,timeZone,{nextDay:true}):null};
  }
  const last=addDays(p.next_on,p.grace_days),start=addDays(p.next_on,-p.lead_days);
  return {open:today>=start&&today<=last,key:key(p.next_on),oneTime:true,start,last,passed:today>last,
    expiresAt:businessTime.dayBoundary(last,timeZone,{nextDay:true})};
}
// A repeating order moves to its next date once its current order has arrived
// or its window has passed.
async function advance(db,ctx,p,today){
  if(p.kind!=='recurring')return p;
  for(let guard=0;guard<400;guard++){
    const last=addDays(p.next_on,p.grace_days),key=p.next_on+'#'+p.revision;
    const rows=(await db.query(`SELECT status FROM ${R} WHERE workspace_id=$1 AND protection_id=$2 AND cycle=$3`,[ctx.workspaceId,p.id,key])).rows;
    const finished=rows.length===p.lines.length&&rows.every(r=>r.status==='RELEASED');
    if(today<=last&&!finished)return p;
    p=(await db.query(`UPDATE ${P} p SET next_on=next_on+every_days,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING ${PROTECTION_COLUMNS}`,
      [ctx.workspaceId,p.id])).rows[0];
  }
  throw new ValidationError('This repeating order pattern needs a review of its dates.');
}

// Upkeep gives stock back on the owner's own dates and to physical truth. It
// never takes stock, so it is not stopped by Watch only, pause or Ask me first.
async function upkeep(db,ctx,p,current,{plan}){
  const open=(await db.query(`SELECT * FROM ${R} WHERE workspace_id=$1 AND protection_id=$2 AND status='OPEN' ORDER BY sku_id,id FOR UPDATE`,
    [ctx.workspaceId,p.id])).rows;
  let released=0;
  for(const r of open){
    const listed=p.lines.some(l=>l.skuId===r.sku_id);
    const ended=r.expires_at&&new Date(r.expires_at)<=new Date();
    let reason=null;
    if(plan)reason='plan';
    else if(!p.enabled)reason='removed';
    else if(r.kept)continue;// the owner put it back and keeps it until they release it
    else if(!listed)reason='removed';
    else if(ended)reason='expired';
    else if(r.cycle!==current.key)reason=current.passed?'expired':'removed';
    if(!reason)continue;
    await close(db,ctx,r,reason,{kind:reason,authority:'UPKEEP'});
    released++;
  }
  return released;
}

// Bring one protection up to date. Returns what changed.
async function reconcile(db,ctx,p,{state=null}={}){
  const auth=await authority(db,ctx,p,state);
  const {timeZone,calendarDate:today}=await businessTime.forWorkspace(db,ctx.workspaceId);
  const result={mode:auth.mode,reason:auth.reason||null,held:0,proposed:0,released:0,trimmed:0,problem:null};
  if(p.enabled&&auth.mode!=='excluded')p=await advance(db,ctx,p,today);
  // Lock order everywhere is protection, then stock positions, then
  // reservations, matching order confirmation (positions, then reservations).
  const openSkus=(await db.query(`SELECT DISTINCT sku_id FROM ${R} WHERE workspace_id=$1 AND protection_id=$2 AND status='OPEN'`,
    [ctx.workspaceId,p.id])).rows.map(r=>r.sku_id);
  await lockPositions(db,ctx,[...openSkus,...p.lines.map(l=>l.skuId)],p.location_id);
  if(auth.mode==='excluded'){result.released=await upkeep(db,ctx,p,{key:null},{plan:true});return result;}
  const current=cycle(p,today,timeZone);
  result.released=await upkeep(db,ctx,p,current,{plan:false});
  if(!p.enabled||!current.open)return result;
  const known=await facts(db,ctx,p);
  if(known.problem){
    result.problem=known.problem;
    await db.query(`UPDATE ${P} SET problem=$3,checked_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,p.id,known.problem]);
    return result;
  }
  const lines=[...p.lines].sort((a,b)=>a.skuId.localeCompare(b.skuId));
  for(const line of lines){
    await db.query(`INSERT INTO ${R}(id,workspace_id,protection_id,cycle,customer_id,sku_id,location_id,target,one_time,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,protection_id,cycle,sku_id) DO NOTHING`,
    [newId('stock-reservation'),ctx.workspaceId,p.id,current.key,p.customer_id,line.skuId,p.location_id,line.quantity,current.oneTime,current.expiresAt]);
    let r=(await db.query(`SELECT * FROM ${R} WHERE workspace_id=$1 AND protection_id=$2 AND cycle=$3 AND sku_id=$4 FOR UPDATE`,
      [ctx.workspaceId,p.id,current.key,line.skuId])).rows[0];
    if(r.status!=='OPEN')continue;
    if(!r.kept&&Number(r.target)!==line.quantity){
      const held=Math.min(Number(r.held),line.quantity);
      r=await setHeld(db,ctx,r,held,{kind:'trimmed',authority:'UPKEEP',reason:LOWERED,target:line.quantity});
    }
    // Never hold more than is physically there after everything already promised.
    const space=await room(db,ctx,r);
    if(Number(r.held)>space.available){
      result.trimmed+=Number(r.held)-space.available;
      r=await setHeld(db,ctx,r,space.available,{kind:'trimmed',authority:'UPKEEP',reason:'Less stock is on hand than was reserved.'});
    }
    const want=r.kept?0:Math.min(Number(r.target)-Number(r.held),space.free);
    let proposed=0;
    if(want>0&&auth.mode==='auto'){
      r=await setHeld(db,ctx,r,Number(r.held)+want,{kind:Number(r.held)?'topped_up':'held',authority:auth.kind});
      result.held+=want;
    }else if(auth.mode==='draft')proposed=Math.max(0,want);
    if(proposed!==Number(r.proposed))
      await db.query(`UPDATE ${R} SET proposed=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id,proposed]);
    result.proposed+=proposed;
  }
  await db.query(`UPDATE ${P} SET problem=NULL,checked_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,p.id]);
  return result;
}

// Called inside order confirmation and transfer-peg allocation, after the
// order took stock. The protected customer's own order uses its reservation
// first; a one-time reservation (expected or repeating order) then ends.
async function handOver(c,ctx,order,allocations){
  const wanted=new Map();
  for(const a of allocations||[]){
    const quantity=Number(a.quantity);
    if(!(quantity>0)||!a.skuId||!a.locationId)continue;
    const key=a.skuId+'|'+a.locationId;
    wanted.set(key,(wanted.get(key)||0)+quantity);
  }
  if(!wanted.size||!order?.customer_id)return [];
  const rows=(await c.query(`SELECT * FROM ${R} WHERE workspace_id=$1 AND customer_id=$2 AND status='OPEN' AND held>0
      AND (expires_at IS NULL OR expires_at>now()) AND (sku_id||'|'||location_id)=ANY($3::text[])
    ORDER BY one_time DESC,expires_at NULLS LAST,created_at,id FOR UPDATE`,[ctx.workspaceId,order.customer_id,[...wanted.keys()]])).rows;
  const used=[];
  for(const r of rows){
    const key=r.sku_id+'|'+r.location_id,left=wanted.get(key)||0,take=Math.min(left,Number(r.held));
    if(!take)continue;
    wanted.set(key,left-take);
    if(r.one_time){
      await close(c,ctx,r,'order_arrived',{kind:'order_arrived',authority:'ORDER',orderId:order.id,handedOver:take});
    }else{
      const held=Number(r.held)-take;
      await c.query(`UPDATE ${R} SET held=$3::int,proposed=least(proposed,target-$3::int),sales_order_id=$4,revision=revision+1,updated_at=now()
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id,held,order.id]);
      await record(c,ctx,r,{kind:'order_arrived',delta:-take,heldAfter:held,authority:'ORDER',orderId:order.id,handedOver:take});
    }
    used.push({reservationId:r.id,skuId:r.sku_id,locationId:r.location_id,quantity:take,ended:r.one_time});
  }
  if(used.length){
    await c.query(`INSERT INTO sales_order_events(id,workspace_id,sales_order_id,event_type,detail,actor_user_id,idempotency_key,created_at)
      VALUES($1,$2,$3,'protected_stock_used',$4,$5,$6,$7)`,
    [newId('soe'),ctx.workspaceId,order.id,JSON.stringify({reservations:used}),ctx.actorId||null,'protected-stock:'+newId('use'),nowIso()]);
  }
  return used;
}

function parseLines(input){
  const raw=Array.isArray(input)?input:String(input??'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(row=>{
    const match=/^(.+?)\s*[,;\t]\s*(\d{1,9})$/.exec(row);
    if(!match)throw new ValidationError('Write each product as its SKU code, a comma, then the units to keep, like ABC-1, 10.');
    return {code:match[1].trim(),quantity:match[2]};
  });
  if(!raw.length||raw.length>MAX_LINES)throw new ValidationError('Protect from 1 to '+MAX_LINES+' products.');
  return raw.map(l=>({code:text(l.code,'each SKU code',120),quantity:whole(l.quantity,'Units to keep',{min:1})}));
}
async function resolveLines(db,ctx,input){
  const wanted=parseLines(input),found=await products(db,ctx,{codes:wanted.map(l=>l.code)}),lines=[];
  for(const line of wanted){
    const matches=found.filter(s=>s.code.toLowerCase()===line.code.toLowerCase());
    if(matches.length!==1)throw new ValidationError('No single product has the SKU code '+line.code+'.');
    const reason=unsupported(matches[0]);
    if(reason)throw new ValidationError(reason);
    if(lines.some(l=>l.skuId===matches[0].id))throw new ValidationError(line.code+' is listed twice.');
    lines.push({skuId:matches[0].id,quantity:line.quantity});
  }
  return lines;
}
async function resolveCustomer(db,ctx,input){
  const name=text(input.customer,'the customer name',200);
  const rows=(await db.query(`SELECT id,name,record_state FROM customers WHERE workspace_id=$1 AND (id=$2 OR lower(name)=lower($2))`,
    [ctx.workspaceId,name])).rows;
  if(rows.length!==1)throw new ValidationError('No single customer is named '+name+'.');
  if(rows[0].record_state!=='ACTIVE')throw new ValidationError(rows[0].name+' is not an active customer.');
  return rows[0];
}

// Save the owner's instruction: create a protection or change one.
async function save(database,ctx,input){
  return tx(database,async db=>{
    await owner(db,ctx);
    // Saving the instruction is allowed while StockChief only watches; the
    // routine then shows what it would reserve without taking any stock.
    const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
    const requestKey=text(input.requestKey,'the form key',240);
    const id=input.id?text(input.id,'the protection',120):null;
    if(!id){
      const prior=(await db.query(`SELECT id FROM ${P} WHERE workspace_id=$1 AND request_key=$2`,[ctx.workspaceId,requestKey])).rows[0];
      if(prior)return {id:prior.id,replayed:true};
    }
    const before=id?await protection(db,ctx,id,{lock:true}):null;
    if(before&&(!before.enabled||Number(input.revision)!==Number(before.revision))){
      if(before.request_key===requestKey)return {id,replayed:true};
      throw new ValidationError('This protection changed. Open it again before saving.');
    }
    const kind=before?.kind||String(input.kind||'');
    if(!['customer','expected','recurring'].includes(kind))throw new ValidationError('Choose a big customer, an expected order or a repeating order.');
    const customer=before?{id:before.customer_id}:await resolveCustomer(db,ctx,input);
    const locationId=before?.location_id||text(input.locationId,'the location',120);
    if(!before&&!(await db.query('SELECT 1 FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',
      [ctx.workspaceId,locationId])).rowCount)throw new ValidationError('Choose an active location you own.');
    const lines=await resolveLines(db,ctx,input.lines);
    const today=await businessTime.today(db,ctx.workspaceId);
    let nextOn=null,everyDays=null,leadDays=0,graceDays=0,endsOn=null;
    if(kind==='customer'){
      endsOn=String(input.endsOn||'').trim()?day(input.endsOn,'the last day'):null;
      if(endsOn&&endsOn<today)throw new ValidationError('The last day can’t be in the past.');
    }else{
      nextOn=day(input.nextOn,'the expected order');
      if(nextOn<today)throw new ValidationError('The expected order date can’t be in the past.');
      leadDays=whole(input.leadDays??0,'Days to start holding before',{max:90});
      graceDays=whole(input.graceDays??0,'Days to wait after the expected date',{max:30});
      if(kind==='recurring'){
        everyDays=whole(input.everyDays,'Days between orders',{min:1,max:365});
        if(leadDays>=everyDays)throw new ValidationError('Start holding fewer days ahead than the days between orders.');
      }
    }
    const routine=input.routine==='yes';
    if(!before)await require('../manager/postgres-operating-instructions').checkRuleLimit(db,ctx,[],1);
    const protectionId=id||newId('stock-protection');
    await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'stock-protection:'+protectionId+':'+((before?.revision||0)+1),
      8192+lines.length*4096,{finished:true});
    let p;
    if(before){
      p=(await db.query(`UPDATE ${P} p SET lines=$3::jsonb,next_on=$4,every_days=$5,lead_days=$6,grace_days=$7,ends_on=$8,routine=$9,
          example_id=NULL,problem=NULL,revision=revision+1,authorized_by=$10,request_key=$11,updated_at=now()
        WHERE workspace_id=$1 AND id=$2 RETURNING ${PROTECTION_COLUMNS}`,
      [ctx.workspaceId,id,JSON.stringify(lines),nextOn,everyDays,leadDays,graceDays,endsOn,routine,ctx.actorId,requestKey])).rows[0];
      // Open reservations carry over to the changed instruction instead of
      // dropping stock that is already protected.
      const {timeZone}=await businessTime.forWorkspace(db,ctx.workspaceId),next=cycle(p,today,timeZone);
      const openSkus=(await db.query(`SELECT DISTINCT sku_id FROM ${R} WHERE workspace_id=$1 AND protection_id=$2 AND status='OPEN'`,
        [ctx.workspaceId,id])).rows.map(r=>r.sku_id);
      await lockPositions(db,ctx,[...openSkus,...lines.map(l=>l.skuId)],locationId);
      if(next.open)await db.query(`UPDATE ${R} SET cycle=$3,expires_at=$4::timestamptz,revision=revision+1,updated_at=now()
        WHERE workspace_id=$1 AND protection_id=$2 AND status='OPEN' AND NOT kept AND sku_id=ANY($5::text[])
          AND (expires_at IS NULL OR expires_at>now())`,
      [ctx.workspaceId,id,next.key,next.expiresAt,lines.map(l=>l.skuId)]);
    }else{
      p=(await db.query(`INSERT INTO ${P}(id,workspace_id,customer_id,location_id,kind,lines,next_on,every_days,lead_days,grace_days,ends_on,routine,authorized_by,request_key)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${PROTECTION_COLUMNS.replace(/\bp\./g,'')}`,
      [protectionId,ctx.workspaceId,customer.id,locationId,kind,JSON.stringify(lines),nextOn,everyDays,leadDays,graceDays,endsOn,routine,ctx.actorId,requestKey])).rows[0];
    }
    await audit.record(db,ctx,{action:before?'Changed protected stock':'Set up protected stock',reference:protectionId,
      before:before?{lines:before.lines,nextOn:before.next_on,everyDays:before.every_days,endsOn:before.ends_on,routine:before.routine}:{},
      after:{customerId:customer.id,locationId,kind,lines,nextOn,everyDays,leadDays,graceDays,endsOn,routine}});
    const outcome=await reconcile(db,ctx,p,{state});
    return {id:protectionId,...outcome};
  });
}

async function stop(database,ctx,id,input={}){
  return tx(database,async db=>{
    await owner(db,ctx);
    const p=await protection(db,ctx,id,{lock:true});
    if(!p.enabled)return {id,replayed:true};
    if(Number(input.revision)!==Number(p.revision))throw new ValidationError('This protection changed. Open it again before stopping it.');
    await db.query(`UPDATE ${P} SET enabled=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
    const open=(await db.query(`SELECT * FROM ${R} WHERE workspace_id=$1 AND protection_id=$2 AND status='OPEN' ORDER BY sku_id,id FOR UPDATE`,
      [ctx.workspaceId,id])).rows;
    for(const r of open)await close(db,ctx,r,'removed',{kind:'removed',authority:'INDIVIDUAL'});
    await audit.record(db,ctx,{action:'Stopped protecting stock',reference:id,before:{enabled:true},after:{enabled:false,released:open.length}});
    return {id,released:open.length};
  });
}

async function individual(db,ctx){
  await owner(db,ctx);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  const stopped=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
  if(stopped)throw new ValidationError(stopped);
  return state;
}
async function replayed(db,ctx,input){
  const requestKey=text(input.requestKey,'the form key',240);
  const prior=(await db.query(`SELECT id FROM ${C} WHERE workspace_id=$1 AND request_key=$2`,[ctx.workspaceId,requestKey])).rows[0];
  return {requestKey,prior};
}

// The owner approves one suggested reservation exactly as shown.
async function approve(database,ctx,id,input){
  return tx(database,async db=>{
    const state=await individual(db,ctx);
    const {requestKey,prior}=await replayed(db,ctx,input);
    if(prior)return {id,replayed:true};
    const first=await reservation(db,ctx,id);
    const p=await protection(db,ctx,first.protection_id,{lock:true});
    await lockPositions(db,ctx,[first.sku_id],first.location_id);
    const r=await reservation(db,ctx,id,{lock:true});
    const quantity=whole(input.quantity,'Units to reserve',{min:1});
    if(!p.enabled||r.status!=='OPEN'||Number(input.revision)!==Number(r.revision)||quantity!==Number(r.proposed))
      throw new ValidationError('This suggestion changed. Review the current amount.');
    if(r.expires_at&&new Date(r.expires_at)<=new Date())throw new ValidationError('This reservation has ended.');
    const known=await facts(db,ctx,p);
    if(known.problem)throw new ValidationError(known.problem);
    const space=await room(db,ctx,r);
    if(space.free<quantity)throw new ValidationError('Only '+space.free+' units are free now. Review the updated suggestion.');
    await setHeld(db,ctx,r,Number(r.held)+quantity,{kind:Number(r.held)?'topped_up':'held',authority:'INDIVIDUAL',requestKey});
    if(policy.allowance(state.plan,JOB)==='trained'&&!p.example_id)
      await db.query(`UPDATE ${P} SET example_id=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,p.id,r.id]);
    return {id,held:Number(r.held)+quantity};
  });
}

// The owner gives one reservation back now.
async function release(database,ctx,id,input){
  return tx(database,async db=>{
    await owner(db,ctx);
    const {requestKey,prior}=await replayed(db,ctx,input);
    if(prior)return {id,replayed:true};
    const first=await reservation(db,ctx,id);
    await protection(db,ctx,first.protection_id,{lock:true});
    const r=await reservation(db,ctx,id,{lock:true});
    if(r.status!=='OPEN'||Number(input.revision)!==Number(r.revision))throw new ValidationError('This reservation changed. Review it again.');
    await close(db,ctx,r,'released',{kind:'released',authority:'INDIVIDUAL',requestKey});
    return {id,released:Number(r.held)};
  });
}

// Undo one change. Holds give their stock back; releases take it back only if
// it is still free. Stock already passed to an order stays with that order.
async function undo(database,ctx,changeId,input){
  return tx(database,async db=>{
    await individual(db,ctx);
    const {requestKey,prior}=await replayed(db,ctx,input);
    if(prior)return {id:changeId,replayed:true};
    const change=(await db.query(`SELECT * FROM ${C} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,changeId])).rows[0];
    if(!change)throw new NotFoundError('That change is not in this inventory.');
    if(change.undone_at)return {id:changeId,replayed:true};
    if(change.kind==='undone')throw new ValidationError('An undo can’t be undone. Change the protection instead.');
    if(change.kind==='order_arrived')throw new ValidationError('This stock is now on the customer’s order. Change that order instead.');
    if(change.reason===LOWERED)throw new ValidationError('You lowered this amount. Raise it on the protection instead.');
    const first=await reservation(db,ctx,change.reservation_id);
    const p=await protection(db,ctx,first.protection_id,{lock:true});
    await lockPositions(db,ctx,[first.sku_id],first.location_id);
    let r=await reservation(db,ctx,change.reservation_id,{lock:true});
    const marked=await db.query(`UPDATE ${C} SET undone_at=now() WHERE workspace_id=$1 AND id=$2 AND undone_at IS NULL`,[ctx.workspaceId,changeId]);
    if(!marked.rowCount)return {id:changeId,replayed:true};
    if(Number(change.delta)>0){
      const back=Math.min(Number(change.delta),Number(r.held));
      if(r.status!=='OPEN'||back<=0)throw new ValidationError('None of this reserved stock is still held.');
      const held=Number(r.held)-back;
      if(held===0)await close(db,ctx,r,'undone',{kind:'undone',authority:'INDIVIDUAL',requestKey,undoes:changeId});
      else await setHeld(db,ctx,r,held,{kind:'undone',authority:'INDIVIDUAL',requestKey,undoes:changeId,target:held});
      return {id:changeId,released:back};
    }
    if(!p.enabled)throw new ValidationError('Turn this protection on again before putting stock back.');
    const known=await facts(db,ctx,p);
    if(known.problem)throw new ValidationError(known.problem);
    const need=-Number(change.delta);
    if(r.status==='RELEASED'){
      r=(await db.query(`UPDATE ${R} SET status='OPEN',release_reason=NULL,released_at=NULL WHERE workspace_id=$1 AND id=$2 RETURNING *`,
        [ctx.workspaceId,r.id])).rows[0];
    }
    const space=await room(db,ctx,r);
    if(space.free<need)throw new ValidationError('Only '+space.free+' units are free now, so this can’t be put back.');
    const held=Number(r.held)+need;
    // Stock put back after its end date, or no longer in the current
    // instruction, is kept until the owner releases it; the routine leaves it.
    const {timeZone,calendarDate:today}=await businessTime.forWorkspace(db,ctx.workspaceId);
    const ended=change.kind==='expired'||Boolean(r.expires_at&&new Date(r.expires_at)<=new Date());
    const keep=r.kept||ended||change.kind==='removed'||r.cycle!==cycle(p,today,timeZone).key||!p.lines.some(l=>l.skuId===r.sku_id);
    await setHeld(db,ctx,r,held,{kind:'undone',authority:'INDIVIDUAL',requestKey,undoes:changeId,target:Math.max(Number(r.target),held),
      kept:keep,expiresAt:ended?null:r.expires_at});
    return {id:changeId,held};
  });
}

async function schedule(db,workspaceId){
  const actorId=await currentOwner(db,workspaceId);
  if(!actorId)return {queued:0};
  // Outside the plan only open reservations need the routine, to give them back.
  const state=await policy.accountState(db,workspaceId),included=policy.permits(policy.usesAgentTerms(state)?state.plan:null,JOB,'draft');
  const due=(await db.query(`SELECT p.id,p.revision FROM ${P} p WHERE p.workspace_id=$1
      AND ((p.enabled AND $2) OR EXISTS(SELECT 1 FROM ${R} r WHERE r.workspace_id=p.workspace_id AND r.protection_id=p.id AND r.status='OPEN'))
    ORDER BY p.checked_at NULLS FIRST,p.id LIMIT 200`,[workspaceId,included])).rows;
  const queue=require('../operations/postgres-job-queue'),slot=Math.floor(Date.now()/900000);
  let queued=0;
  for(const p of due){
    const job=await queue.enqueue(db,{workspaceId,kind:KIND,priority:60,maxAttempts:5,
      idempotencyKey:'stock-protection:'+p.id+':'+p.revision+':'+slot,payload:{protectionId:p.id,actorId}});
    if(job.created)queued++;
  }
  return {queued};
}
// Worker: reconcile one protection. A refused step is recorded on the protection.
async function run(database,workspaceId,payload){
  return tx(database,async db=>{
    const actorId=await currentOwner(db,workspaceId);
    if(!actorId)return {skipped:'owner_unavailable'};
    const ctx={workspaceId,actorId};
    const found=(await db.query(`SELECT ${PROTECTION_COLUMNS} FROM ${P} p WHERE p.workspace_id=$1 AND p.id=$2 FOR UPDATE`,
      [workspaceId,payload.protectionId])).rows[0];
    if(!found)return {skipped:'missing'};
    await db.query('SAVEPOINT stock_protection');
    try{
      const result=await reconcile(db,ctx,found);
      await db.query('RELEASE SAVEPOINT stock_protection');
      return result;
    }catch(error){
      if(!expected(error))throw error;
      await db.query('ROLLBACK TO SAVEPOINT stock_protection');
      await db.query(`UPDATE ${P} SET problem=$3,checked_at=now() WHERE workspace_id=$1 AND id=$2`,[workspaceId,found.id,error.message]);
      return {problem:error.message};
    }
  });
}

// Read-only preview for the page: what StockChief would reserve now.
async function preview(db,ctx,p,rows,today,timeZone){
  if(!p.enabled)return [];
  const current=cycle(p,today,timeZone);
  if(!current.open)return [];
  const out=[];
  for(const line of p.lines){
    const r=rows.find(x=>x.sku_id===line.skuId&&x.status==='OPEN'&&x.cycle===current.key)||
      {id:'',sku_id:line.skuId,location_id:p.location_id,held:0,target:line.quantity};
    const space=await room(db,ctx,r);
    out.push({skuId:line.skuId,want:Math.max(0,Math.min(line.quantity-Number(r.held),space.free)),free:space.free});
  }
  return out;
}
async function page(db,ctx){
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId);
  const {timeZone,calendarDate:today}=await businessTime.forWorkspace(db,ctx.workspaceId);
  const protections=(await db.query(`SELECT ${PROTECTION_COLUMNS},c.name AS customer_name,l.name AS location_name FROM ${P} p
    JOIN customers c ON c.workspace_id=p.workspace_id AND c.id=p.customer_id JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
    WHERE p.workspace_id=$1 AND p.enabled ORDER BY c.name,p.created_at,p.id LIMIT 101`,[ctx.workspaceId])).rows;
  const ids=protections.slice(0,100).map(p=>p.id);
  const rows=(await db.query(`SELECT r.*,s.code,i.name AS product,i.unit_label FROM ${R} r JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE r.workspace_id=$1 AND r.protection_id=ANY($2::text[]) AND r.status='OPEN'
    ORDER BY s.code,r.id`,[ctx.workspaceId,ids])).rows;
  for(const r of rows)r.until=r.kept||!r.expires_at?null:businessTime.context(timeZone,new Date(new Date(r.expires_at).getTime()-1)).calendarDate;
  const codes=await products(db,ctx,{ids:[...new Set(protections.flatMap(p=>p.lines.map(l=>l.skuId)))]});
  const list=[];
  for(const p of protections.slice(0,100)){
    const auth=await authority(db,ctx,p,state),own=rows.filter(r=>r.protection_id===p.id);
    list.push({...p,auth,rows:own,lineText:p.lines.map(l=>(codes.find(s=>s.id===l.skuId)?.code||'?')+', '+l.quantity).join('\n'),
      preview:['watch','draft'].includes(auth.mode)?await preview(db,ctx,p,own,today,timeZone):[],
      codes:Object.fromEntries(codes.map(s=>[s.id,s.code])),
      cycle:cycle(p,today,timeZone),taught:await taught(db,ctx,p)});
  }
  const changes=(await db.query(`SELECT c.*,s.code,cu.name AS customer_name,u.name AS actor_name FROM ${C} c
    JOIN ${R} r ON r.workspace_id=c.workspace_id AND r.id=c.reservation_id JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id
    JOIN customers cu ON cu.workspace_id=r.workspace_id AND cu.id=r.customer_id LEFT JOIN users u ON u.workspace_id=c.workspace_id AND u.id=c.actor_id
    WHERE c.workspace_id=$1 ORDER BY c.created_at DESC,c.id DESC LIMIT 30`,[ctx.workspaceId])).rows;
  const locations=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL ORDER BY name,id LIMIT 200',
    [ctx.workspaceId])).rows;
  const customers=(await db.query(`SELECT name FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' ORDER BY name LIMIT 500`,[ctx.workspaceId])).rows;
  const plan=policy.usesAgentTerms(state)?state.plan:null;
  return {protections:list,more:protections.length>100,changes,locations,customers,today,timeZone,pro:policy.allowance(plan,JOB)==='trained',
    custom:policy.allowance(plan,JOB)==='alone',requestKey:newId('protect-form')};
}

const definition={id:JOB,key:'protected-stock',label:'Keep stock reserved for big customers and upcoming orders',
  readPage:async(db,ctx)=>{
    const rows=(await db.query(`SELECT c.name AS "Customer",s.code AS "SKU",l.name AS "Location",r.held AS "Reserved",r.target AS "Kept for them",
        r.proposed AS "Waiting for your approval",'${href}' AS link
      FROM ${R} r JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id
      JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id
      WHERE r.workspace_id=$1 AND r.status='OPEN' ORDER BY c.name,s.code,r.id LIMIT 101`,[ctx.workspaceId])).rows;
    return {rows:rows.length?rows.slice(0,100):[{Action:'Open protected stock',link:href}],more:rows.length>100,
      summary:'Stock kept for big customers and upcoming orders. Other orders and channels can’t take it; the customer’s own order uses it first.'};
  }};

module.exports={JOB,ACTION,KIND,href,save,stop,approve,release,undo,reconcile,handOver,schedule,run,page,definition,cycle,authority};
