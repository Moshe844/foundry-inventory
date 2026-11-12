'use strict';

// Job 191: warns before stock expires and suggests where to sell it first.
//
// A routine checks every batch on hand once a business day, again when the
// owner changes a warning window, and on Check now. A batch is warned about
// when it is inside the owner's warning window: the days chosen for its
// product, else its category, else every product, else 30 days.
//
// Each warning carries a sell-first plan worked out from records:
//  - earliest-expiry-first: the open orders at that location due before the
//    batch expires draw its units, earliest due first, and picking takes the
//    batch with the soonest expiry first when no batch is named;
//  - other locations with orders due before expiry, where it can move;
//  - the sales channels the product is listed on from that location;
//  - a clearance plan (job 86) for what recent sales will not use up.
// Expired batches cannot be sold; the warning says to write them off or send
// them back, which a person does.
//
// Warnings change nothing, so they appear in the app and in Needs you on every
// plan and in every mode. Emailing them through the connected mailbox is work
// StockChief does on its own, so it waits during shadow mode, pause, watch
// mode, Watch only and Ask me first, and says why on the page.

const {ValidationError,AuthorizationError,NotFoundError,DomainError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const exact=require('../domain/exact-quantity');
const audit=require('./postgres-security-audit');
const jobs=require('./postgres-job-queue');
const {hash}=require('../pricing/postgres-promotions');
const {newId}=require('../lib/util');

const JOB=191,ACTION='inventory.expiry_warning',kind='agent.expiry-warnings.v1',path='/autopilot/expiring-stock';
const DEFAULT_DAYS=30,PACE_DAYS=90,MAX_POSITIONS=2000;
const rules='stockchief_runtime.agent_expiry_warning_rules',warnings='stockchief_runtime.agent_expiry_warnings';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const expected=error=>error instanceof DomainError&&[400,402,403,404,409,422].includes(error.status);
const qty=value=>exact.canonical(String(value));
const num=value=>exact.safeNumber(String(value),{signed:true});
const plural=(n,one,many)=>n+' '+(Number(n)===1?one:many);
// Quantity with its stocking unit; plain units read as unit or units.
const amount=(n,label)=>!label||label==='unit'?plural(qty(n),'unit','units'):qty(n)+' '+label;

// The owner's warning window for the item behind `s`: product, then category,
// then every product, else the default. Used by the routine and the review.
const WINDOW_SQL=`coalesce(
  (SELECT r.warning_days FROM ${rules} r WHERE r.workspace_id=s.workspace_id AND r.enabled AND r.scope='ITEM' AND r.item_id=s.item_id),
  (SELECT r.warning_days FROM ${rules} r JOIN catalogue_item_facts f ON f.workspace_id=r.workspace_id AND f.item_id=s.item_id
    WHERE r.workspace_id=s.workspace_id AND r.enabled AND r.scope='CATEGORY' AND r.category=lower(trim(f.category))),
  (SELECT r.warning_days FROM ${rules} r WHERE r.workspace_id=s.workspace_id AND r.enabled AND r.scope='ALL'),
  ${DEFAULT_DAYS})`;
const LONGEST_SQL=`SELECT greatest(${DEFAULT_DAYS},coalesce(max(warning_days),0))::int AS days FROM ${rules} WHERE workspace_id=$1 AND enabled`;

async function owner(db,ctx,{lock=false}={}){
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  const allowed=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!allowed)throw new AuthorizationError('Only the current inventory owner can manage expiry warnings.');
}
async function access(db,ctx,{lock=false}={}){
  await owner(db,ctx,{lock});
  return policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'suggest');
}
async function currentOwner(db,workspaceId){
  return (await db.query(`SELECT u.id,a.email FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    JOIN accounts a ON a.id=u.account_id WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]||null;
}

// Batches on hand inside their warning window, soonest expiry first.
async function candidates(db,workspaceId,today,{filter=null,limit=MAX_POSITIONS}={}){
  const longest=(await db.query(LONGEST_SQL,[workspaceId])).rows[0].days;
  return (await db.query(`SELECT * FROM (
      SELECT lot.id AS lot_id,lot.code AS lot,lot.expires_at::date::text AS expires_on,(lot.expires_at::date-$2::date) AS days_left,
        s.id AS sku_id,s.code AS sku,s.item_id,i.name,i.unit_label,l.id AS location_id,l.name AS location,b.quantity::text AS units,
        ${WINDOW_SQL} AS warning_days
      FROM lots lot JOIN lot_balances b ON b.workspace_id=lot.workspace_id AND b.lot_id=lot.id AND b.quantity>0
      JOIN skus s ON s.workspace_id=lot.workspace_id AND s.id=lot.sku_id
      JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id AND l.is_active=1 AND l.custody_agreement_id IS NULL
      WHERE lot.workspace_id=$1 AND lot.expires_at IS NOT NULL AND lot.recalled_at IS NULL
        AND lot.expires_at::date<=$2::date+$3::int) x
    WHERE x.days_left<=x.warning_days AND ($4::text IS NULL OR lower(x.sku)=lower($4) OR lower(x.lot)=lower($4))
    ORDER BY x.expires_on,x.sku,x.lot,x.location_id LIMIT $5`,[workspaceId,today,longest,filter,limit])).rows;
}

// Where one product's expiring batches at one location should go first.
async function sellFirst(db,workspaceId,today,group){
  const {sku_id:skuId,location_id:locationId}=group[0];
  const latest=group.map(g=>g.expires_on).sort().at(-1);
  // One transaction client runs one query at a time.
  const reads=[
    ()=>db.query(`SELECT o.id,o.order_number,o.needed_by::date::text AS needed_by,c.name AS customer,(ol.quantity_ordered-ol.quantity_fulfilled)::text AS open
      FROM sales_orders o JOIN sales_order_lines ol ON ol.workspace_id=o.workspace_id AND ol.sales_order_id=o.id
      JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
      WHERE o.workspace_id=$1 AND ol.sku_id=$2 AND o.fulfillment_location_id=$3 AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
        AND ol.quantity_ordered>ol.quantity_fulfilled AND o.needed_by IS NOT NULL AND o.needed_by::date<=$4::date
      ORDER BY o.needed_by::date,o.allocation_priority,o.created_at,o.id LIMIT 200`,[workspaceId,skuId,locationId,latest]),
    ()=>db.query(`SELECT r.sales_order_id,o.order_number,r.lot_id,sum(r.quantity)::text AS units FROM stockchief_runtime.sales_rotation_entries r
      JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
      WHERE r.workspace_id=$1 AND r.sku_id=$2 AND r.location_id=$3 AND r.lot_id IS NOT NULL GROUP BY r.sales_order_id,o.order_number,r.lot_id`,[workspaceId,skuId,locationId]),
    ()=>db.query(`SELECT coalesce(sum(-m.quantity_delta),0)::text AS sold FROM movements m WHERE m.workspace_id=$1 AND m.sku_id=$2 AND m.location_id=$3
      AND m.operation='issue' AND m.reason_code IN ('sale','sold') AND m.occurred_at::timestamptz>now()-interval '${PACE_DAYS} days'`,[workspaceId,skuId,locationId]),
    ()=>db.query(`SELECT l.name AS location,o.order_number,o.needed_by::date::text AS needed_by,(ol.quantity_ordered-ol.quantity_fulfilled)::text AS open
      FROM sales_orders o JOIN sales_order_lines ol ON ol.workspace_id=o.workspace_id AND ol.sales_order_id=o.id
      JOIN locations l ON l.workspace_id=o.workspace_id AND l.id=o.fulfillment_location_id AND l.is_active=1
      WHERE o.workspace_id=$1 AND ol.sku_id=$2 AND o.fulfillment_location_id<>$3 AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
        AND ol.quantity_ordered>ol.quantity_fulfilled AND o.needed_by IS NOT NULL AND o.needed_by::date<=$4::date
      ORDER BY o.needed_by::date,o.id LIMIT 3`,[workspaceId,skuId,locationId,latest]),
    ()=>db.query(`SELECT DISTINCT c.display_name FROM connection_commerce_positions p JOIN workspace_connectors c ON c.workspace_id=p.workspace_id AND c.id=p.connector_id
      WHERE p.workspace_id=$1 AND p.sku_id=$2 AND p.location_id=$3 AND p.field='quantity' AND p.mode IN ('outbound','two_way')
        AND c.status='connected' AND c.paused_at IS NULL ORDER BY c.display_name LIMIT 5`,[workspaceId,skuId,locationId])
  ];
  const results=[];for(const read of reads)results.push(await read());
  const [orders,bound,pace,elsewhere,channels]=results;
  const lots=group.map(g=>({...g,free:num(g.units),drawn:[],reserved:[]}));
  for(const b of bound.rows){const lot=lots.find(l=>l.lot_id===b.lot_id);if(lot){lot.free=Math.max(0,lot.free-num(b.units));lot.reserved.push({order:b.order_number,orderId:b.sales_order_id,units:qty(b.units)});}}
  // Units an order has already reserved from exact batches are not drawn again.
  const boundTo=new Map();for(const b of bound.rows)boundTo.set(b.sales_order_id,(boundTo.get(b.sales_order_id)||0)+num(b.units));
  for(const o of orders.rows){
    let need=Math.max(0,num(o.open)-(boundTo.get(o.id)||0));
    for(const lot of lots){
      if(need<=0)break;
      if(lot.days_left<0||lot.expires_on<o.needed_by||lot.free<=0)continue;
      const take=Math.min(need,lot.free);lot.free-=take;need-=take;
      lot.drawn.push({orderId:o.id,order:o.order_number,customer:o.customer,neededBy:o.needed_by,units:qty(take)});
    }
  }
  // Recent sales at this location use the batches up in expiry order.
  const perDay=num(pace.rows[0].sold)/PACE_DAYS;
  let earlier=0;
  for(const lot of lots){
    const willSell=Math.max(0,Math.floor(perDay*Math.max(0,lot.days_left))-earlier);
    lot.left=lot.days_left<0?num(lot.units):Math.max(0,lot.free-willSell);
    lot.salesCover=lot.days_left>=0&&lot.free>0&&lot.left===0;
    earlier+=lot.free;
    lot.plan={orders:lot.drawn,reserved:lot.reserved,unclaimed:qty(lot.free),left:qty(lot.left),salesCover:lot.salesCover,
      soldRecently:qty(pace.rows[0].sold),paceDays:PACE_DAYS,
      elsewhere:lot.left>0?elsewhere.rows.map(r=>({location:r.location,order:r.order_number,neededBy:r.needed_by,units:qty(Math.min(lot.left,num(r.open)))})):[],
      channels:lot.left>0?channels.rows.map(r=>r.display_name):[],clearance:lot.left>0&&lot.days_left>=0,expired:lot.days_left<0};
  }
  return lots;
}

// The plan as short sentences, in the order to act on them.
function lines(w){
  const p=w.plan||w,out=[];
  if(p.expired)return ['It expired on '+w.expires_on+'. It can no longer be sold or shipped. Write it off or send it back to the supplier.'];
  out.push('Pick this batch before fresher stock. Picks take the soonest expiry first.');
  for(const o of p.orders)out.push('Ship '+o.units+' to '+o.order+' for '+o.customer+', due '+o.neededBy+'.');
  for(const r of p.reserved)out.push(r.units+' are already reserved for '+r.order+'.');
  if(p.salesCover)out.push('Recent sales should use up the other '+p.unclaimed+' before it expires.');
  for(const e of p.elsewhere)out.push('Move up to '+e.units+' to '+e.location+' for '+e.order+', due '+e.neededBy+'.');
  if(p.channels.length)out.push('Keep it listed on '+p.channels.join(', ')+'. The listed quantity follows this stock.');
  if(p.clearance)out.push('About '+amount(p.left,w.unit_label)+' will be left when it expires. Discount them with a clearance plan.');
  return out;
}

async function scan(db,workspaceId,today,options={}){
  const found=await candidates(db,workspaceId,today,options);
  const groups=new Map();
  for(const row of found){const key=row.sku_id+'\u0000'+row.location_id;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  const out=[];
  for(const group of groups.values())out.push(...await sellFirst(db,workspaceId,today,group));
  return out.sort((a,b)=>a.expires_on.localeCompare(b.expires_on)||a.sku.localeCompare(b.sku)||a.lot.localeCompare(b.lot)||a.location_id.localeCompare(b.location_id));
}

function canSend(value){try{const grants=typeof value==='string'?JSON.parse(value):value;return Array.isArray(grants)&&grants.some(g=>g==='MAIL_SEND'||g==='mail:send');}catch{return false;}}
// The connected mailbox to send warnings from. With several, only the owner's
// own mailbox is used; otherwise StockChief does not guess.
async function mailbox(db,workspaceId,ownerEmail){
  const boxes=(await db.query(`SELECT id,display_name,provider_type,provider_account_name,provider_account_id,capabilities,setup_status FROM workspace_connectors
    WHERE workspace_id=$1 AND provider_type IN ('gmail','microsoft365') AND status='connected' AND paused_at IS NULL ORDER BY display_name,id`,[workspaceId])).rows
    .filter(b=>b.provider_account_id&&canSend(b.capabilities)&&b.setup_status!=='REAUTHORIZATION_REQUIRED');
  if(!boxes.length)return {none:true};
  if(boxes.length===1)return {box:boxes[0]};
  const own=boxes.filter(b=>String(b.provider_account_name||'').toLowerCase()===String(ownerEmail||'').toLowerCase());
  return own.length===1?{box:own[0]}:{note:'Several mailboxes are connected and none is clearly yours, so no email was sent. The warnings are here and in Needs you.'};
}

function emailText(rows){
  return rows.map(w=>w.sku+' batch '+w.lot+' at '+w.location+': '+amount(w.units,w.unit_label)+
    (w.expired?' expired on '+w.expires_on:' expire on '+w.expires_on)+'.\n'+lines(w).map(l=>'  - '+l).join('\n')).join('\n\n');
}

// Sends one email a day for warnings not emailed yet, when StockChief may act.
async function email(c,workspaceId,account,person){
  const pending=(await c.query(`SELECT w.*,s.code AS sku,lot.code AS lot,l.name AS location,i.unit_label,w.expires_on::text AS expires_on
    FROM ${warnings} w JOIN skus s ON s.workspace_id=w.workspace_id AND s.id=w.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    JOIN lots lot ON lot.workspace_id=w.workspace_id AND lot.id=w.lot_id JOIN locations l ON l.workspace_id=w.workspace_id AND l.id=w.location_id
    WHERE w.workspace_id=$1 AND w.status='OPEN' AND w.email_communication_id IS NULL ORDER BY w.expires_on,s.code,lot.code,w.id LIMIT 200`,[workspaceId])).rows;
  if(!pending.length)return {emailed:0};
  const note=async text=>{await c.query(`UPDATE ${warnings} SET email_note=$3 WHERE workspace_id=$1 AND id=ANY($2::text[])`,[workspaceId,pending.map(w=>w.id),text]);return {emailed:0,note:text};};
  const stop=await policy.stopped(c,workspaceId,account,ACTION,true);
  if(stop)return note('No email was sent. '+stop);
  const found=await mailbox(c,workspaceId,person.email);
  if(found.none)return note(null);
  if(!found.box)return note(found.note);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email||''))return note('Your account has no email address, so no email was sent.');
  const ids=pending.map(w=>w.id),key='expiry-warning-email:'+hash(ids);
  await c.query('SAVEPOINT expiry_warning_email');
  try{
    const queued=await require('../connections/postgres-outbound-mail').queueInTransaction(c,{workspaceId,actorId:person.id},{
      recipientKind:'address',recipientEmail:person.email,connectorId:found.box.id,
      subject:pending.length===1?'Stock expires soon: '+pending[0].sku+' batch '+pending[0].lot:plural(pending.length,'batch expires','batches expire')+' soon',
      body:'StockChief found stock that expires soon. Sell these first.\n\n'+emailText(pending)+'\n\nOpen Expiring stock in StockChief to see every warning.',
      standingAuthority:{kind:'expiry_warning',warningIds:ids}},key);
    await c.query('RELEASE SAVEPOINT expiry_warning_email');
    await c.query(`UPDATE ${warnings} SET email_communication_id=$3,email_note=NULL WHERE workspace_id=$1 AND id=ANY($2::text[])`,[workspaceId,ids,queued.communicationId]);
    await audit.record(c,{workspaceId,actorId:person.id},{action:'Expiry warning email queued',reference:queued.communicationId,
      after:{warnings:ids.length,mailbox:found.box.display_name,to:person.email}});
    return {emailed:ids.length};
  }catch(error){
    if(!expected(error))throw error;
    await c.query('ROLLBACK TO SAVEPOINT expiry_warning_email');
    return note('No email was sent. '+error.message);
  }
}

// Checked again just before the mailbox sends: the job may still act and a
// warning in the email is still open.
async function emailAuthority(db,workspaceId,authority){
  const account=await policy.accountState(db,workspaceId);
  policy.requireJob(policy.usesAgentTerms(account)?account.plan:null,JOB,'automatic');
  const stop=await policy.stopped(db,workspaceId,account,ACTION,true);
  if(stop)throw new ValidationError(stop);
  const open=(await db.query(`SELECT 1 FROM ${warnings} WHERE workspace_id=$1 AND id=ANY($2::text[]) AND status='OPEN' LIMIT 1`,
    [workspaceId,Array.isArray(authority?.warningIds)?authority.warningIds.map(String):[]])).rowCount;
  if(!open)throw new ValidationError('These expiry warnings were handled or cleared, so the email was not sent.');
}

// Worker: refreshes every warning and emails new ones when it may.
async function run(job,database){
  const workspaceId=job.workspaceId;
  return tx(database,async c=>{
    const account=await policy.accountState(c,workspaceId);
    if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'suggest'))return {skipped:true};
    const person=await currentOwner(c,workspaceId);
    if(!person)return {skipped:true};
    const started=(await c.query('SELECT clock_timestamp() AS at')).rows[0].at;
    const today=await require('../lib/business-time').today(c,workspaceId);
    const found=await scan(c,workspaceId,today);
    const raised=[];
    for(const w of found){
      const fingerprint=hash({units:qty(w.units),expiresOn:w.expires_on,days:w.warning_days,plan:w.plan});
      const row=(await c.query(`INSERT INTO ${warnings} AS w(id,workspace_id,lot_id,sku_id,location_id,expires_on,warning_days,units,plan,fingerprint,status,expired)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'OPEN',$11)
        ON CONFLICT(workspace_id,lot_id,location_id,expires_on) DO UPDATE SET units=excluded.units,plan=excluded.plan,fingerprint=excluded.fingerprint,
          warning_days=excluded.warning_days,expired=excluded.expired,checked_at=clock_timestamp(),
          status=CASE WHEN w.status='CLEARED' THEN 'OPEN' ELSE w.status END
        RETURNING id,(xmax=0) AS inserted`,
      [newId('expiry-warning'),workspaceId,w.lot_id,w.sku_id,w.location_id,w.expires_on,w.warning_days,qty(w.units),JSON.stringify(w.plan),fingerprint,w.plan.expired])).rows[0];
      if(row.inserted)raised.push({sku:w.sku,lot:w.lot,location:w.location,expiresOn:w.expires_on,units:qty(w.units)});
    }
    // A warning whose batch was sold, moved, recalled or re-dated is no longer needed.
    const cleared=(await c.query(`UPDATE ${warnings} SET status='CLEARED' WHERE workspace_id=$1 AND status='OPEN' AND checked_at<$2 RETURNING id`,[workspaceId,started])).rowCount;
    if(raised.length)await audit.record(c,{workspaceId,actorId:person.id},{action:'Expiry warnings raised',reference:today,
      after:{count:raised.length,batches:raised.slice(0,50)}});
    const mail=await email(c,workspaceId,account,person);
    return {open:found.length,raised:raised.length,cleared,emailed:mail.emailed,emailNote:mail.note||null};
  });
}

async function schedule(c,workspaceId,cycleId){
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'suggest'))return {queued:false};
  const today=await require('../lib/business-time').today(c,workspaceId);
  return {queued:(await jobs.enqueue(scoped(c),{workspaceId,kind,idempotencyKey:'expiry-warnings:day:'+today,payload:{cycleId},priority:60,maxAttempts:3})).created};
}
async function check(db,ctx){
  return tx(db,async c=>{
    await access(c,ctx,{lock:true});
    return {queued:(await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,idempotencyKey:'expiry-warnings:check:'+Math.floor(Date.now()/60000),
      payload:{requestedBy:ctx.actorId},priority:55,maxAttempts:3})).created};
  });
}

// The owner's warning window for every product, a category or one product.
async function configure(database,ctx,input={}){
  const scope=String(input.scope||'').toUpperCase();
  if(!['ALL','CATEGORY','ITEM'].includes(scope))throw new ValidationError('Choose every product, a category or one product.');
  return tx(database,async c=>{
    await access(c,ctx,{lock:true});
    let itemId=null,category=null,label='Every product';
    if(scope==='ITEM'){
      const found=(await c.query(`SELECT s.item_id,s.code FROM skus s WHERE s.workspace_id=$1 AND lower(s.code)=lower($2) LIMIT 2`,[ctx.workspaceId,String(input.sku||'').trim()])).rows;
      if(found.length!==1)throw new ValidationError('Enter the exact item code.');
      itemId=found[0].item_id;label=found[0].code;
    }else if(scope==='CATEGORY'){
      category=String(input.category||'').trim().toLowerCase();
      if(!category||category.length>160)throw new ValidationError('Enter a category of up to 160 characters.');
      const used=(await c.query('SELECT 1 FROM catalogue_item_facts WHERE workspace_id=$1 AND lower(trim(category))=$2 LIMIT 1',[ctx.workspaceId,category])).rowCount;
      if(!used)throw new ValidationError('No product has that category. Check the spelling.');
      label=category;
    }
    const prior=(await c.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND scope=$2 AND coalesce(item_id,'')=coalesce($3,'') AND coalesce(category,'')=coalesce($4,'') FOR UPDATE`,
      [ctx.workspaceId,scope,itemId,category])).rows[0];
    // Removing names the revision the owner saw; setting days replaces what is there.
    if(input.revision!=null&&input.revision!==''&&Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the page to see the current warning days.');
    if(input.stop==='yes'){
      if(!prior?.enabled)return {stopped:true,replayed:true};
      await c.query(`UPDATE ${rules} SET enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,prior.id]);
      await audit.record(c,ctx,{action:'Expiry warning days removed',reference:prior.id,before:{scope,for:label,days:prior.warning_days}});
      await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,idempotencyKey:'expiry-warnings:rule:'+prior.id+':'+(prior.revision+1),payload:{},priority:55,maxAttempts:3});
      return {stopped:true};
    }
    const days=Number(String(input.days??'').trim());
    if(!Number.isSafeInteger(days)||days<1||days>3650)throw new ValidationError('Enter how many days before expiry to warn, from 1 to 3,650.');
    if(prior?.enabled&&prior.warning_days===days)return {saved:true,replayed:true};
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    const id=prior?.id||newId('expiry-window');
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'expiry-window:'+id+':'+((prior?.revision||0)+1),2048,{finished:true});
    await c.query(`INSERT INTO ${rules} AS r(id,workspace_id,scope,item_id,category,warning_days,authorized_by) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(id) DO UPDATE SET warning_days=excluded.warning_days,enabled=true,authorized_by=excluded.authorized_by,revision=r.revision+1,updated_at=clock_timestamp()`,
    [id,ctx.workspaceId,scope,itemId,category,days,ctx.actorId]);
    await audit.record(c,ctx,{action:'Expiry warning days saved',reference:id,before:prior?{days:prior.warning_days,enabled:prior.enabled}:{},after:{scope,for:label,days}});
    await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,idempotencyKey:'expiry-warnings:rule:'+id+':'+((prior?.revision||0)+1),payload:{},priority:55,maxAttempts:3});
    return {saved:true};
  });
}

// A person says the warning is dealt with. It is not raised again for this
// batch, location and expiry date.
async function handle(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true});
    const w=(await c.query(`SELECT * FROM ${warnings} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,String(id||'')])).rows[0];
    if(!w)throw new NotFoundError('That expiry warning is not in this inventory.');
    if(w.status==='HANDLED')return {replayed:true};
    if(w.status!=='OPEN')throw new ValidationError('This warning is no longer open.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that this batch is dealt with.');
    await c.query(`UPDATE ${warnings} SET status='HANDLED',handled_by=$3,handled_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,w.id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Expiry warning marked handled',reference:w.id,after:{lot:w.lot_id,location:w.location_id,expiresOn:w.expires_on}});
    return {handled:true};
  });
}

function describe(row){return {...row,units:qty(row.units),amount:amount(row.units,row.unit_label),lines:lines(row)};}

async function page(db,ctx,{page:number=1}={}){
  const state=await access(db,ctx);
  number=Number(number);
  if(!Number.isSafeInteger(number)||number<1||number>1000000)throw new ValidationError('Choose a valid page.');
  const select=`SELECT w.*,w.expires_on::text AS expires_on,s.code AS sku,lot.code AS lot,l.name AS location,i.name,i.unit_label,
      m.status AS email_status,(w.expires_on-$2::date) AS days_left
    FROM ${warnings} w JOIN skus s ON s.workspace_id=w.workspace_id AND s.id=w.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    JOIN lots lot ON lot.workspace_id=w.workspace_id AND lot.id=w.lot_id JOIN locations l ON l.workspace_id=w.workspace_id AND l.id=w.location_id
    LEFT JOIN customer_communications m ON m.workspace_id=w.workspace_id AND m.id=w.email_communication_id`;
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  const open=(await db.query(select+` WHERE w.workspace_id=$1 AND w.status='OPEN' ORDER BY w.expires_on,s.code,lot.code,w.id LIMIT 51 OFFSET $3`,
    [ctx.workspaceId,today,(number-1)*50])).rows;
  const handled=(await db.query(select+` WHERE w.workspace_id=$1 AND w.status='HANDLED' ORDER BY w.handled_at DESC,w.id LIMIT 10`,[ctx.workspaceId,today])).rows;
  const windows=(await db.query(`SELECT r.*,s.code AS sku FROM ${rules} r LEFT JOIN LATERAL(SELECT code FROM skus WHERE workspace_id=r.workspace_id AND item_id=r.item_id ORDER BY code LIMIT 1) s ON true
    WHERE r.workspace_id=$1 AND r.enabled ORDER BY array_position(ARRAY['ALL','CATEGORY','ITEM'],r.scope),r.category,s.code`,[ctx.workspaceId])).rows;
  const categories=(await db.query(`SELECT DISTINCT lower(trim(category)) AS category FROM catalogue_item_facts WHERE workspace_id=$1 AND length(trim(coalesce(category,'')))>0
    ORDER BY 1 LIMIT 200`,[ctx.workspaceId])).rows.map(r=>r.category);
  const person=await currentOwner(db,ctx.workspaceId);
  const stop=await policy.stopped(db,ctx.workspaceId,state,ACTION,true);
  const box=person?await mailbox(db,ctx.workspaceId,person.email):{none:true};
  return {page:number,more:open.length>50,open:open.slice(0,50).map(describe),handled:handled.map(describe),windows,categories,defaultDays:DEFAULT_DAYS,
    allWindow:windows.find(w=>w.scope==='ALL')||null,stop,mailbox:box.box?box.box.display_name:null,mailboxNote:box.note||null,plan:state.plan,
    clearance:policy.permits(state.plan,86,'draft')?'/autopilot/clearance-plans/new?sku=':'/autopilot/reviews/clearance-plan?filter='};
}

async function inbox(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'suggest'))return [];
  const row=(await db.query(`SELECT count(*) FILTER(WHERE NOT expired)::int AS soon,count(*) FILTER(WHERE expired)::int AS expired,min(created_at) AS at,
    (min(expires_on) FILTER(WHERE NOT expired))::text AS first FROM ${warnings} WHERE workspace_id=$1 AND status='OPEN'`,[workspaceId])).rows[0];
  if(!row.soon&&!row.expired)return [];
  return [{kind:'inventory',importance:'Needs You',priority:row.expired?65:50,grouped:true,
    title:row.expired?'Expired stock is still on hand':'Stock expires soon',
    happened:[row.soon?plural(row.soon,'batch expires','batches expire')+' inside your warning window. The first expires on '+row.first+'.':null,
      row.expired?plural(row.expired,'batch has','batches have')+' expired and cannot be sold.':null].filter(Boolean).join(' '),
    why:'Stock that expires on the shelf is lost money.',recommendation:'Sell these first, or plan a clearance. Write off what has expired.',
    href:path,actionLabel:'Review expiring stock',sourceId:'expiry-warnings',at:row.at,createdAt:row.at}];
}

// The review lists the same batches, with the first order to sell to.
async function review(db,ctx,{filter='',page=1,today}){
  const found=await scan(db,ctx.workspaceId,today,{filter:filter||null,limit:page*100+1});
  const rows=found.slice((page-1)*100,page*100).map(w=>({SKU:w.sku,Lot:w.lot,Location:w.location,Units:qty(w.units),Expires:w.expires_on,
    'Warn days':w.warning_days,Priority:w.plan.expired?'Expired':w.plan.orders[0]?.order||'No dated order found','Sell first':lines(w).slice(1).join(' ')||lines(w)[0]}));
  return {rows,more:found.length>page*100,summary:'Batches inside your warning window, soonest expiry first, paired with open orders due before they expire. Set the warning days on the Expiring stock page.'};
}

module.exports={JOB,ACTION,kind,path,DEFAULT_DAYS,WINDOW_SQL,scan,lines,run,schedule,check,configure,handle,page,inbox,review,emailAuthority,
  definition:{id:JOB,key:'expiring-lots',label:'Review expiring stock and waiting orders',filterLabel:'SKU or lot',readPage:review}};
