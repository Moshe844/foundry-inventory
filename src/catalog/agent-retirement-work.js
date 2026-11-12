'use strict';

// Job 132: retires discontinued products and points staff to the replacement.
//
// A product (one SKU) is discontinued when a checked supplier notice says so,
// when the owner marks it, or when the owner's dead-stock rule finds stock that
// has not sold for the rule's number of days. Retiring it:
//  - stops reordering at once. Planning gives it no reorder point, target or
//    safety stock, so no reorder list, Autopilot purchase order or transfer
//    suggestion asks for more of it;
//  - sells down the stock left. When the owner saved a clearance markdown it
//    prepares a job 86 clearance plan, and a person still approves every price
//    (plan spec, page 13). Stock that stops selling waits in Needs you: a
//    person decides a return or a write-off (page 13), never StockChief;
//  - once there is no stock and no open order, transfer or production needs
//    it, archives it the record-removal way: archived, never erased, so its
//    history and replacement guidance stay. Every sales channel that takes
//    stock from StockChief is set to zero through the normal channel delivery;
//  - records the replacement, shown on the product page, in order entry, on
//    the order page and pick lists, and in Ask's agent review.
// An open purchase order, a kit or production recipe that uses the product, a
// replacement that is itself discontinued or in different units, or books that
// show stock the shelf does not have stop the work and ask a person.
//
// Pro drafts dead-stock retirements until the owner has completed a retirement
// themselves and saved the rule with it; Custom retires inside the rule's daily
// limit without training. A person marking or approving one acts at once.
// Automatic work respects shadow mode, pause, watch mode, Watch only and Ask
// me first. Everything is audited and can be undone.

const {ValidationError,AuthorizationError,NotFoundError,DomainError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');
const exact=require('../domain/exact-quantity');
const {has}=require('../db/schema-installed');
const {hash}=require('../pricing/postgres-promotions');
const {newId,nowIso}=require('../lib/util');

const JOB=132,ACTION='catalog.retire_discontinued',kind='agent.product-retirements.v1',path='/autopilot/discontinued-products';
const work='stockchief_runtime.agent_product_retirements',rules='stockchief_runtime.agent_product_retirement_rules',links='stockchief_runtime.agent_product_replacements';
const OPEN="('DRAFT','SELLING_DOWN','RETIRED')",STALLED_DAYS=30,SCAN=100;
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const expected=error=>error instanceof DomainError&&[400,402,403,404,409,422].includes(error.status);
const sources={SUPPLIER:'Supplier notice',OWNER:'Marked by you',DEAD_STOCK:'Dead stock rule'};
const statusLabels={DRAFT:'Waiting for you',SELLING_DOWN:'Selling down',RETIRED:'Retired',DISMISSED:'Kept selling',UNDONE:'Undone'};

async function owner(db,ctx,{lock=false}={}){
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  const allowed=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!allowed)throw new AuthorizationError('Only the current inventory owner can retire discontinued products.');
}
async function access(db,ctx,{lock=false,stop=false}={}){
  await owner(db,ctx,{lock});
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  if(stop){
    if(lock)await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
    const reason=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
    if(reason)throw new ValidationError(reason);
  }
  return state;
}

// ---- Facts about the products ---------------------------------------------------

// Everything retirement checks, for many SKUs in one read.
async function factRows(c,ctx,skuIds){
  if(!skuIds.length)return new Map();
  const rows=(await c.query(`SELECT s.id,s.code,s.item_id,s.is_active AS sku_active,s.variant_label,i.name,i.is_active AS item_active,
      i.unit_label,i.tracking_mode,i.quantity_precision,i.quantity_increment::text AS quantity_increment,i.secondary_unit_label,i.secondary_precision,i.secondary_increment::text AS secondary_increment,
      trim_scale(coalesce((SELECT sum(b.on_hand) FROM balances b WHERE b.workspace_id=s.workspace_id AND b.sku_id=s.id),0)::numeric)::text AS on_hand,
      EXISTS(SELECT 1 FROM balances b WHERE b.workspace_id=s.workspace_id AND b.sku_id=s.id AND coalesce(b.secondary_on_hand,0)<>0) AS secondary_stock,
      EXISTS(SELECT 1 FROM accounting_inventory_cost_balances x WHERE x.workspace_id=s.workspace_id AND x.sku_id=s.id
        AND (x.quantity_units<>0 OR coalesce(x.secondary_quantity_units,0)<>0 OR x.total_cost_minor<>0)) AS book_stock,
      (SELECT o.po_number FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
        WHERE l.workspace_id=s.workspace_id AND l.sku_id=s.id AND o.status NOT IN ('RECEIVED','CANCELLED','COMPLETED','CLOSED') ORDER BY o.po_number LIMIT 1) AS purchase,
      EXISTS(SELECT 1 FROM kit_components k WHERE k.workspace_id=s.workspace_id AND (k.kit_sku_id=s.id OR k.component_sku_id=s.id)) AS kit,
      EXISTS(SELECT 1 FROM manufacturing_boms b WHERE b.workspace_id=s.workspace_id AND b.status<>'RETIRED'
        AND (b.output_sku_id=s.id OR b.definition @> jsonb_build_object('components',jsonb_build_array(jsonb_build_object('skuId',s.id))))) AS production,
      (SELECT w.id FROM ${work} w WHERE w.workspace_id=s.workspace_id AND w.sku_id=s.id AND w.status IN ${OPEN}) AS open_id,
      (SELECT w.status FROM ${work} w WHERE w.workspace_id=s.workspace_id AND w.sku_id=s.id AND w.status IN ${OPEN}) AS open_status,
      EXISTS(SELECT 1 FROM ${work} w WHERE w.workspace_id=s.workspace_id AND w.replacement_sku_id=s.id AND w.status IN ('SELLING_DOWN','RETIRED')) AS used_replacement
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])`,[ctx.workspaceId,[...new Set(skuIds)]])).rows;
  return new Map(rows.map(r=>[r.id,{...r,stocked:Number(r.on_hand)!==0||r.secondary_stock}]));
}
function sameUnits(a,b){
  return a.unit_label===b.unit_label&&a.tracking_mode===b.tracking_mode&&a.quantity_precision===b.quantity_precision&&a.quantity_increment===b.quantity_increment&&
    a.secondary_unit_label===b.secondary_unit_label&&(!a.secondary_unit_label||a.secondary_precision===b.secondary_precision&&a.secondary_increment===b.secondary_increment);
}
const active=f=>f&&Number(f.sku_active)&&Number(f.item_active);
// Why this SKU cannot be retired now, or null.
function problem(f,replacement,{draftId=null}={}){
  if(!active(f))return 'Choose an active product to retire.';
  if(f.open_id&&f.open_id!==draftId)return f.code+' is already discontinued.';
  if(f.purchase)return f.code+' has an unfinished order to buy more ('+f.purchase+'). Receive or cancel that purchase order first.';
  if(f.kit||f.production)return f.code+' is used by a kit or production recipe. Change that first.';
  if(f.used_replacement)return f.code+' is the saved replacement for another discontinued product. Review that first.';
  if(!f.stocked&&f.book_stock)return f.code+' still has stock value in the books but none on the shelf. Correct the stock cost before retiring it.';
  if(Number(f.on_hand)<0)return f.code+' shows negative stock. Count it before retiring it.';
  if(replacement===undefined)return null;
  if(!active(replacement))return 'The replacement must be an active product.';
  if(replacement.id===f.id)return 'A product cannot replace itself.';
  if(!sameUnits(f,replacement))return f.code+' and its replacement '+replacement.code+' use different stock units or tracking. Review the replacement yourself.';
  if(replacement.open_status&&replacement.open_status!=='DRAFT')return 'The replacement '+replacement.code+' is itself discontinued.';
  return null;
}

async function skuByCode(c,ctx,code,label='product'){
  const text=String(code||'').trim();
  if(!text||text.length>160)throw new ValidationError('Enter the exact SKU of the '+label+'.');
  const rows=(await c.query(`SELECT s.id,s.code FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND (s.id=$2 OR lower(s.code)=lower($2)) AND s.is_active=1 AND i.is_active=1 ORDER BY s.id LIMIT 2`,[ctx.workspaceId,text])).rows;
  if(rows.length!==1)throw new ValidationError('No single active product has the SKU '+text+'.');
  return rows[0];
}

// The owner's clearance markdown, from the request or the saved rule.
function clearanceOf(input,rule){
  const plans=require('../pricing/agent-clearance-plans');
  const markdown=String(input?.markdown??'').trim(),days=String(input?.stepDays??'').trim();
  if(markdown||days){
    if(!markdown||!days)throw new ValidationError('Enter both a clearance markdown and how many days each step runs, or neither.');
    return {points:plans.markdownPoints(markdown),stepDays:plans.stepLength(days)};
  }
  return rule?.markdown_points?{points:rule.markdown_points,stepDays:rule.step_days}:null;
}
async function loadRule(db,workspaceId,{lock=false}={}){
  return (await db.query(`SELECT r.*,EXISTS(SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
      WHERE u.id=r.authorized_by AND w.id=r.workspace_id AND u.role='owner') AS current
    FROM ${rules} r WHERE r.workspace_id=$1${lock?' FOR SHARE OF r':''}`,[workspaceId])).rows[0]||null;
}

// ---- Retiring -------------------------------------------------------------------

// Starts retiring these SKUs: no more reordering, the replacement recorded,
// zero-stock products archived and the rest sold down. All or nothing.
async function startMany(c,ctx,entries,{source,noticeId=null,automatic=false,clearance=null}){
  if(!entries.length||entries.length>100)throw new ValidationError('Retire one to 100 products at a time.');
  const ids=entries.map(e=>e.skuId);
  if(new Set(ids).size!==ids.length)throw new ValidationError('List each discontinued product once.');
  if(entries.some(e=>e.replacementSkuId===e.skuId))throw new ValidationError('A product cannot replace itself.');
  if(entries.some(e=>e.replacementSkuId&&ids.includes(e.replacementSkuId)))throw new ValidationError('A replacement cannot be discontinued in the same step.');
  await c.query('SELECT id FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[ctx.workspaceId,ids]);
  const facts=await factRows(c,ctx,[...ids,...entries.map(e=>e.replacementSkuId).filter(Boolean)]);
  const rows=entries.map(e=>{
    const f=facts.get(e.skuId),why=problem(f,e.replacementSkuId?facts.get(e.replacementSkuId)||null:undefined,{draftId:e.id||null});
    if(why)throw new ValidationError(why);
    return {id:e.id||newId('retirement'),sku_id:f.id,item_id:f.item_id,code:f.code,replacement_sku_id:e.replacementSkuId||null,
      replacement_code:e.replacementSkuId?facts.get(e.replacementSkuId).code:null,stocked:f.stocked,on_hand:f.on_hand,
      evidence:e.evidence||{},fingerprint:e.fingerprint||hash({sku:f.id,source,notice:noticeId})};
  });
  await c.query(`INSERT INTO ${work} AS w(id,workspace_id,sku_id,item_id,replacement_sku_id,source,notice_id,status,automatic,evidence,fingerprint,created_by,decided_by,decided_at)
    SELECT x.id,$1,x.sku_id,x.item_id,x.replacement_sku_id,$2,$3,'SELLING_DOWN',$4,x.evidence,x.fingerprint,$5,$5,clock_timestamp()
    FROM jsonb_to_recordset($6::jsonb) x(id text,sku_id text,item_id text,replacement_sku_id text,evidence jsonb,fingerprint text)
    ON CONFLICT(id) DO UPDATE SET status='SELLING_DOWN',replacement_sku_id=EXCLUDED.replacement_sku_id,automatic=EXCLUDED.automatic,
      decided_by=EXCLUDED.decided_by,decided_at=EXCLUDED.decided_at,reason=NULL,checked_at=clock_timestamp()`,
  [ctx.workspaceId,source,noticeId,automatic,ctx.actorId,JSON.stringify(rows)]);
  const linked=rows.filter(r=>r.replacement_sku_id);
  if(linked.length)await c.query(`INSERT INTO ${links}(old_sku_id,workspace_id,replacement_sku_id,notice_id)
    SELECT x.sku_id,$1,x.replacement_sku_id,$2 FROM jsonb_to_recordset($3::jsonb) x(sku_id text,replacement_sku_id text)
    ON CONFLICT(old_sku_id) DO UPDATE SET replacement_sku_id=EXCLUDED.replacement_sku_id,notice_id=EXCLUDED.notice_id`,[ctx.workspaceId,noticeId,JSON.stringify(linked)]);
  const finished=await finishMany(c,ctx,rows.filter(r=>!r.stocked));
  for(const r of rows.filter(r=>r.stocked)){
    const plan=await prepareClearance(c,ctx,r,clearance,automatic);
    await c.query(`UPDATE ${work} SET applied=applied||$3::jsonb WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id,JSON.stringify({clearance:plan,...(plan.planId?{clearancePlanId:plan.planId}:{})})]);
    r.clearance=plan;
  }
  const result=rows.map(r=>({id:r.id,skuId:r.sku_id,itemId:r.item_id,code:r.code,replacementCode:r.replacement_code,
    status:finished.retired.has(r.id)?'RETIRED':'SELLING_DOWN',left:r.stocked?r.on_hand:'0',waiting:finished.waiting.get(r.id)||null,clearance:r.clearance||null}));
  await audit.record(c,ctx,{action:automatic?'Discontinued products retired on their own':'Discontinued products retired',reference:noticeId||rows[0].id,
    after:{source,products:result.map(r=>({code:r.code,replacement:r.replacementCode,status:r.status,left:r.left,clearance:r.clearance?.planId||r.clearance?.problem||null})),
      reorderingStopped:true,stockWrittenOff:false}});
  return {rows:result};
}

// Prepares a job 86 clearance plan for the stock left. A person approves every price.
async function prepareClearance(c,ctx,row,clearance,automatic){
  if(!clearance)return {problem:'No clearance markdown is saved. The stock sells at its current price.'};
  await c.query('SAVEPOINT retirement_clearance');
  try{
    const plan=await require('../pricing/agent-clearance-plans').prepareIn(c,ctx,{requestKey:'retirement:'+row.id,sku:row.sku_id,
      markdown:exact.fromAtoms(clearance.points,2),stepDays:String(clearance.stepDays)},{automatic});
    await c.query('RELEASE SAVEPOINT retirement_clearance');
    return {planId:plan.id};
  }catch(error){
    if(!expected(error))throw error;
    await c.query('ROLLBACK TO SAVEPOINT retirement_clearance');
    return {problem:error.message};
  }
}

// Archives zero-stock discontinued products that nothing still needs, the way
// record removal archives a product with history, and sets their channel stock
// to zero. Returns which retired and which still wait, and why.
async function finishMany(c,ctx,rows){
  const out={retired:new Set(),waiting:new Map(),selling:new Set()};
  if(!rows.length)return out;
  const removal=require('../domain/postgres-record-removal');
  const facts=await factRows(c,ctx,rows.map(r=>r.sku_id)),gone=[];
  let ready=rows.filter(r=>{
    const f=facts.get(r.sku_id);
    if(f&&f.stocked){out.selling.add(r.id);return false;}
    if(f&&f.book_stock){out.waiting.set(r.id,f.code+' still has stock value in the books. Correct the stock cost; StockChief archives it afterwards.');return false;}
    // A person already deleted it and wrote off its stock: it is retired.
    if(!active(f)){gone.push(r);return false;}
    return true;
  });
  if(ready.length&&await removal.openWork(c,ctx,ready.map(r=>r.sku_id))){
    const clear=[];
    for(const r of ready){const open=await removal.openWork(c,ctx,[r.sku_id]);if(open)out.waiting.set(r.id,open.replace(/; nothing was removed\.$/,'. StockChief archives the product afterwards.'));else clear.push(r);}
    ready=clear;
  }
  if(gone.length){
    await c.query(`UPDATE ${work} SET status='RETIRED',retired_at=clock_timestamp(),reason=NULL,checked_at=clock_timestamp(),applied=applied||'{"archived":"person"}'::jsonb
      WHERE workspace_id=$1 AND id=ANY($2::text[])`,[ctx.workspaceId,gone.map(r=>r.id)]);
    for(const r of gone)out.retired.add(r.id);
  }
  if(ready.length){
    const itemIds=[...new Set(ready.map(r=>r.item_id))];
    const live=(await c.query('SELECT id,item_id FROM skus WHERE workspace_id=$1 AND item_id=ANY($2::text[]) AND is_active=1 ORDER BY id FOR UPDATE',[ctx.workspaceId,itemIds])).rows;
    const going=new Set(ready.map(r=>r.sku_id)),whole=itemIds.filter(item=>live.filter(s=>s.item_id===item).every(s=>going.has(s.id)));
    const archived=new Map();
    for(let i=0;i<whole.length;i+=100){
      const chunk=whole.slice(i,i+100);
      await require('../domain/postgres-catalog-service').archiveZeroStockItemsInTransaction(c,ctx,chunk);
      for(const item of chunk)archived.set(item,'item');
    }
    const maintenance=require('../domain/postgres-sku-maintenance');
    for(const r of ready.filter(r=>!archived.has(r.item_id))){
      await c.query('SAVEPOINT retirement_variant');
      try{await maintenance.update(scoped(c),ctx,r.item_id,r.sku_id,{active:false});await c.query('RELEASE SAVEPOINT retirement_variant');}
      catch(error){if(!expected(error))throw error;await c.query('ROLLBACK TO SAVEPOINT retirement_variant');out.waiting.set(r.id,error.message);}
    }
    const done=ready.filter(r=>!out.waiting.has(r.id));
    if(whole.length)await c.query(`UPDATE attention_items SET status='RESOLVED',resolution_reason='The product was discontinued and retired.',resolved_at=$3
      WHERE workspace_id=$1 AND status IN ('OPEN','ACKNOWLEDGED') AND item_id=ANY($2::text[])`,[ctx.workspaceId,whole,nowIso()]);
    if(done.length){
      await c.query(`UPDATE ${work} w SET status='RETIRED',retired_at=clock_timestamp(),reason=NULL,checked_at=clock_timestamp(),
          applied=w.applied||jsonb_build_object('archived',x.archived) FROM jsonb_to_recordset($2::jsonb) x(id text,archived text)
        WHERE w.workspace_id=$1 AND w.id=x.id`,[ctx.workspaceId,JSON.stringify(done.map(r=>({id:r.id,archived:archived.has(r.item_id)?'item':'sku'})))]);
      for(const r of done)out.retired.add(r.id);
      const channels=await require('../connections/postgres-commerce-sync').publishStockInTransaction(c,ctx,done.map(r=>r.sku_id));
      for(const r of done){
        const mine={queued:channels.queued.filter(q=>q.skuId===r.sku_id).length,held:channels.held.filter(h=>h.skuId===r.sku_id).map(h=>h.reason)};
        if(mine.queued||mine.held.length)await c.query(`UPDATE ${work} SET applied=applied||jsonb_build_object('channels',$3::jsonb) WHERE workspace_id=$1 AND id=$2`,
          [ctx.workspaceId,r.id,JSON.stringify(mine)]);
      }
      // A clearance plan nobody approved is no longer needed.
      const drafts=(await c.query(`SELECT w.applied->>'clearancePlanId' AS plan FROM ${work} w JOIN stockchief_runtime.agent_clearance_plans p
          ON p.workspace_id=w.workspace_id AND p.id=w.applied->>'clearancePlanId' AND p.status='DRAFT'
        WHERE w.workspace_id=$1 AND w.id=ANY($2::text[])`,[ctx.workspaceId,done.map(r=>r.id)])).rows;
      for(const d of drafts)await require('../pricing/agent-clearance-plans').cancelDraft(c,ctx,d.plan);
    }
  }
  if(out.selling.size)await c.query(`UPDATE ${work} SET reason=NULL,checked_at=clock_timestamp() WHERE workspace_id=$1 AND id=ANY($2::text[]) AND status='SELLING_DOWN' AND reason IS NOT NULL`,
    [ctx.workspaceId,[...out.selling]]);
  for(const [id,reason] of out.waiting)await c.query(`UPDATE ${work} SET reason=$3,checked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status='SELLING_DOWN'`,
    [ctx.workspaceId,id,reason]);
  return out;
}

// ---- A person's decisions --------------------------------------------------------

async function load(db,ctx,id,{lock=false}={}){
  const row=(await db.query(`SELECT w.*,s.code,i.name FROM ${work} w JOIN skus s ON s.workspace_id=w.workspace_id AND s.id=w.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE w.workspace_id=$1 AND w.id=$2${lock?' FOR UPDATE OF w':''}`,[ctx.workspaceId,String(id||'')])).rows[0];
  if(!row)throw new NotFoundError('That discontinued product is not in this inventory.');
  return row;
}

// The owner marks a product discontinued, with its replacement if there is one.
async function mark(database,ctx,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true,stop:true});
    const sku=await skuByCode(c,ctx,input.sku);
    const open=(await c.query(`SELECT id,status,source FROM ${work} WHERE workspace_id=$1 AND sku_id=$2 AND status IN ${OPEN}`,[ctx.workspaceId,sku.id])).rows[0];
    if(open&&open.status!=='DRAFT')return {replayed:true,id:open.id,status:open.status};
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that this product is discontinued.');
    const replacement=String(input.replacement||'').trim()?await skuByCode(c,ctx,input.replacement,'replacement'):null;
    const result=await startMany(c,ctx,[{id:open?.id,skuId:sku.id,replacementSkuId:replacement?.id||null,evidence:{marked:true}}],
      {source:open?.source||'OWNER',automatic:false,clearance:clearanceOf(input,await loadRule(c,ctx.workspaceId))});
    return result.rows[0];
  });
}

// The owner approves a drafted retirement.
async function approve(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true,stop:true});
    const row=await load(c,ctx,id,{lock:true});
    if(['SELLING_DOWN','RETIRED'].includes(row.status)&&input.fingerprint===row.fingerprint)return {replayed:true,id:row.id,status:row.status};
    if(row.status!=='DRAFT')throw new ValidationError('This retirement is no longer waiting for you.');
    if(input.confirmed!=='yes'||input.fingerprint!==row.fingerprint)throw new ValidationError('Review the current product and confirm its retirement.');
    const replacement=String(input.replacement||'').trim()?await skuByCode(c,ctx,input.replacement,'replacement'):null;
    const result=await startMany(c,ctx,[{id:row.id,skuId:row.sku_id,replacementSkuId:replacement?.id||row.replacement_sku_id||null,evidence:row.evidence,fingerprint:row.fingerprint}],
      {source:row.source,noticeId:row.notice_id,automatic:false,clearance:clearanceOf(input,await loadRule(c,ctx.workspaceId))});
    return result.rows[0];
  });
}

async function dismiss(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true});
    const row=await load(c,ctx,id,{lock:true});
    if(row.status==='DISMISSED')return {replayed:true};
    if(row.status!=='DRAFT')throw new ValidationError('This retirement is no longer waiting for you.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that this product keeps selling.');
    await c.query(`UPDATE ${work} SET status='DISMISSED',reason='You kept this product.',decided_by=$3,decided_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Discontinued product kept',reference:id,after:{sku:row.code,source:row.source}});
    return {dismissed:true};
  });
}

// Undo: the product is active and reordered again, its replacement guidance is
// removed, and a clearance plan nobody approved is cancelled.
async function undo(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true});
    const row=await load(c,ctx,id,{lock:true});
    if(row.status==='UNDONE')return {replayed:true};
    if(!['SELLING_DOWN','RETIRED'].includes(row.status))throw new ValidationError('Only a product being retired can be brought back.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that this product is no longer discontinued.');
    const ws=ctx.workspaceId,sku=(await c.query('SELECT s.id,s.item_id,s.code,s.is_active,i.is_active AS item_active FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=$2 FOR UPDATE OF s,i',[ws,row.sku_id])).rows[0];
    if(row.status==='RETIRED'){
      if(row.applied?.before||row.applied?.archived==='person')throw new ValidationError('This product was archived outside this retirement. Restore it from the product list.');
      if(Number(sku.is_active)&&Number(sku.item_active))throw new ValidationError(sku.code+' was already restored.');
      if((await c.query('SELECT 1 FROM skus WHERE workspace_id=$1 AND id<>$2 AND lower(btrim(code))=lower(btrim($3)) AND is_active=1 LIMIT 1',[ws,sku.id,sku.code])).rowCount)
        throw new ValidationError('Another product now uses '+sku.code+'. Change one SKU before bringing it back.');
      if(!Number(sku.item_active)){
        const entitlements=require('../commercial/entitlements');
        await entitlements.assertMeterCapacity(c,await entitlements.ownerScopeForWorkspace(c,ws),'products',1);
        await c.query('UPDATE items SET is_active=1,updated_at=$3 WHERE workspace_id=$1 AND id=$2',[ws,sku.item_id,nowIso()]);
        await c.query('UPDATE skus SET is_active=1 WHERE workspace_id=$1 AND id=$2',[ws,sku.id]);
      }else await require('../domain/postgres-sku-maintenance').update(scoped(c),ctx,sku.item_id,sku.id,{active:true});
    }
    await c.query(`DELETE FROM ${links} WHERE workspace_id=$1 AND old_sku_id=$2`,[ws,row.sku_id]);
    const plan=row.applied?.clearancePlanId?(await c.query("SELECT id FROM stockchief_runtime.agent_clearance_plans WHERE workspace_id=$1 AND id=$2 AND status='DRAFT'",[ws,row.applied.clearancePlanId])).rows[0]:null;
    if(plan)await require('../pricing/agent-clearance-plans').cancelDraft(c,ctx,plan.id);
    await c.query(`UPDATE ${work} SET status='UNDONE',reason=NULL,decided_by=$3,decided_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ws,id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Discontinued product brought back',reference:id,after:{sku:row.code,was:row.status,automatic:row.automatic,reorderingResumed:true}});
    if(row.status==='RETIRED')await require('../connections/postgres-commerce-sync').publishStockInTransaction(c,ctx,[row.sku_id]);
    return {undone:true,itemId:row.item_id};
  });
}

// The owner's dead-stock rule and clearance markdown.
async function configure(database,ctx,input={}){
  return tx(database,async c=>{
    await owner(c,ctx,{lock:true});
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const prior=(await c.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the page to see the current rule.');
    if(input.stop==='yes'){
      if(prior?.enabled){
        await c.query(`UPDATE ${rules} SET enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1`,[ctx.workspaceId]);
        await audit.record(c,ctx,{action:'Dead stock retirement rule stopped',reference:'discontinued-products'});
      }
      return {stopped:true};
    }
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the rule before saving it.');
    const days=Number(String(input.deadDays??'').trim()),limit=Number(String(input.dailyLimit??'').trim());
    if(!Number.isSafeInteger(days)||days<30||days>1095)throw new ValidationError('Enter how many days without a sale make stock dead, from 30 to 1,095.');
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ValidationError('Enter how many products a day it may retire, from 1 to 100.');
    const clearance=clearanceOf(input,null);
    let example=null;
    if(input.exampleId){
      example=(await c.query(`SELECT id FROM ${work} WHERE workspace_id=$1 AND id=$2 AND NOT automatic AND decided_by=$3 AND status IN ('SELLING_DOWN','RETIRED')`,
        [ctx.workspaceId,String(input.exampleId),ctx.actorId])).rows[0];
      if(!example)throw new ValidationError('Teach the rule from a retirement you completed yourself.');
    }
    const exampleId=example?.id||(prior?.authorized_by===ctx.actorId?prior?.example_id:null)||null;
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await c.query(`INSERT INTO ${rules} AS r(workspace_id,dead_days,daily_limit,markdown_points,step_days,example_id,authorized_by) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(workspace_id) DO UPDATE SET enabled=true,dead_days=excluded.dead_days,daily_limit=excluded.daily_limit,markdown_points=excluded.markdown_points,
      step_days=excluded.step_days,example_id=excluded.example_id,authorized_by=excluded.authorized_by,revision=r.revision+1,updated_at=clock_timestamp()`,
    [ctx.workspaceId,days,limit,clearance?.points??null,clearance?.stepDays??null,exampleId,ctx.actorId]);
    await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,idempotencyKey:'product-retirements:rule:'+((prior?.revision||0)+1),payload:{},priority:55,maxAttempts:3});
    await audit.record(c,ctx,{action:'Dead stock retirement rule saved',reference:'discontinued-products',
      before:prior?{deadDays:prior.dead_days,dailyLimit:prior.daily_limit,enabled:prior.enabled}:{},
      after:{deadDays:days,dailyLimit:limit,markdownPoints:clearance?.points??null,stepDays:clearance?.stepDays??null,example:exampleId,
        onItsOwn:policy.permits(state.plan,JOB,'automatic',{trained:Boolean(exampleId)}),stockWriteOff:false}});
    return {saved:true};
  });
}

// ---- The routine ------------------------------------------------------------------

async function gates(c,workspaceId){
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {draft:false,account};
  const person=(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0];
  if(!person)return {draft:false,account};
  await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[workspaceId]);
  let blocked=await policy.stopped(c,workspaceId,account,ACTION,true);
  if(!blocked&&!(await require('../autopilot/postgres-service').getState(c,workspaceId)).canAutomate)blocked='Handle routine work is off for this inventory.';
  return {draft:true,account,owner:person.id,blocked,workspaceId};
}

// Products whose stock has not sold for the rule's days, and has been held that long.
async function deadStock(c,workspaceId,days){
  return (await c.query(`WITH stock AS (SELECT b.sku_id,sum(b.on_hand) AS on_hand FROM balances b
      JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id AND l.custody_agreement_id IS NULL
      WHERE b.workspace_id=$1 GROUP BY b.sku_id HAVING sum(b.on_hand)>0)
    SELECT s.id,s.code,s.item_id,i.name,trim_scale(st.on_hand::numeric)::text AS on_hand,h.last_sale,h.first_moved,
      (SELECT w.id FROM ${work} w WHERE w.workspace_id=$1 AND w.sku_id=s.id AND w.status='DRAFT') AS draft_id FROM stock st
    JOIN skus s ON s.workspace_id=$1 AND s.id=st.sku_id AND s.is_active=1 JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    CROSS JOIN LATERAL(SELECT max(m.occurred_at::timestamptz) FILTER (WHERE m.operation='issue' AND m.reason_code IN ('sale','sold')) AS last_sale,
      min(m.occurred_at::timestamptz) AS first_moved FROM movements m WHERE m.workspace_id=$1 AND m.sku_id=s.id) h
    WHERE NOT EXISTS(SELECT 1 FROM ${work} w WHERE w.workspace_id=$1 AND w.sku_id=s.id AND w.status IN ('SELLING_DOWN','RETIRED'))
      AND h.first_moved<clock_timestamp()-make_interval(days=>$2) AND (h.last_sale IS NULL OR h.last_sale<clock_timestamp()-make_interval(days=>$2))
    ORDER BY s.code,s.id LIMIT ${SCAN}`,[workspaceId,days])).rows;
}

// Whether a dead-stock retirement may happen without a person now, and if not, why.
async function authority(c,gate,rule){
  const example=rule.example_id?(await c.query(`SELECT 1 FROM ${work} WHERE workspace_id=$1 AND id=$2 AND NOT automatic AND decided_by=$3 AND status IN ('SELLING_DOWN','RETIRED')`,
    [gate.workspaceId,rule.example_id,rule.authorized_by])).rowCount>0:false;
  if(!policy.permits(gate.account.plan,JOB,'automatic',{trained:example}))return 'Retire one product yourself, then save the rule with it to let StockChief retire dead stock on its own.';
  if(!rule.current)return 'The rule was saved by someone who is no longer the owner. Save it again.';
  const made=Number((await c.query(`SELECT count(*) FROM ${work} WHERE workspace_id=$1 AND source='DEAD_STOCK' AND automatic AND status IN ('SELLING_DOWN','RETIRED','UNDONE')
    AND decided_at>clock_timestamp()-interval '1 day'`,[gate.workspaceId])).rows[0].count);
  if(made>=rule.daily_limit)return 'This is over your limit of '+rule.daily_limit+' products retired a day.';
  return gate.blocked||null;
}

async function draft(c,workspaceId,ownerId,candidate,fingerprint,reason,evidence){
  await c.query(`INSERT INTO ${work} AS w(id,workspace_id,sku_id,item_id,source,status,reason,evidence,fingerprint,created_by)
    VALUES($1,$2,$3,$4,'DEAD_STOCK','DRAFT',$5,$6,$7,$8)
    ON CONFLICT(workspace_id,sku_id) WHERE status IN ${OPEN} DO UPDATE SET reason=EXCLUDED.reason,evidence=EXCLUDED.evidence,fingerprint=EXCLUDED.fingerprint,checked_at=clock_timestamp()
      WHERE w.status='DRAFT'`,[newId('retirement'),workspaceId,candidate.id,candidate.item_id,reason,JSON.stringify(evidence),fingerprint,ownerId]);
}

async function run(job,database){
  const workspaceId=job.workspaceId,totals={retired:0,sellingDown:0,drafted:0,finished:0,waiting:0};
  const ok=await tx(database,async c=>{
    const gate=await gates(c,workspaceId);
    if(!gate.draft)return false;
    const ctx={workspaceId,actorId:gate.owner},rule=await loadRule(c,workspaceId,{lock:true});
    if(rule?.enabled){
      for(const candidate of await deadStock(c,workspaceId,rule.dead_days)){
        const evidence={deadDays:rule.dead_days,lastSale:candidate.last_sale,onHand:candidate.on_hand};
        const fingerprint=hash({sku:candidate.id,lastSale:candidate.last_sale,deadDays:rule.dead_days});
        if((await c.query(`SELECT 1 FROM ${work} WHERE workspace_id=$1 AND sku_id=$2 AND fingerprint=$3 AND status IN ('DISMISSED','UNDONE') LIMIT 1`,
          [workspaceId,candidate.id,fingerprint])).rowCount)continue;
        const facts=(await factRows(c,ctx,[candidate.id])).get(candidate.id),stop=problem(facts,undefined,{draftId:candidate.draft_id});
        const why=stop||await authority(c,gate,rule);
        if(why){await draft(c,workspaceId,gate.owner,candidate,fingerprint,why,{...evidence,wouldApply:!stop});totals.drafted++;continue;}
        await c.query('SAVEPOINT dead_stock_retirement');
        try{
          const result=await startMany(c,ctx,[{id:candidate.draft_id||undefined,skuId:candidate.id,evidence,fingerprint}],{source:'DEAD_STOCK',automatic:true,clearance:clearanceOf({},rule)});
          await c.query('RELEASE SAVEPOINT dead_stock_retirement');
          totals[result.rows[0].status==='RETIRED'?'retired':'sellingDown']++;
        }catch(error){
          if(!expected(error))throw error;
          await c.query('ROLLBACK TO SAVEPOINT dead_stock_retirement');
          await draft(c,workspaceId,gate.owner,candidate,fingerprint,error.message,evidence);totals.drafted++;
        }
      }
    }
    // Products selling down finish once their stock is gone and nothing needs them.
    if(!gate.blocked){
      const selling=(await c.query(`SELECT id,sku_id,item_id FROM ${work} WHERE workspace_id=$1 AND status='SELLING_DOWN' ORDER BY created_at,id LIMIT 200`,[workspaceId])).rows;
      const done=await finishMany(c,ctx,selling);
      totals.finished=done.retired.size;totals.waiting=done.waiting.size;
    }
    return true;
  });
  return ok?totals:{skipped:true,...totals};
}

async function enabled(c,workspaceId){
  const account=await policy.accountState(c,workspaceId);
  return policy.usesAgentTerms(account)&&policy.permits(account.plan,JOB,'draft');
}
async function schedule(c,workspaceId,cycleId){
  if(!await has(c,work)||!await enabled(c,workspaceId))return {queued:false};
  const today=await require('../lib/business-time').today(c,workspaceId);
  return {queued:(await jobs.enqueue(scoped(c),{workspaceId,kind,idempotencyKey:'product-retirements:day:'+today,payload:{cycleId},priority:70,maxAttempts:3})).created};
}
async function check(db,ctx){
  return tx(db,async c=>{
    await access(c,ctx,{lock:true});
    return {queued:(await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,idempotencyKey:'product-retirements:check:'+Math.floor(Date.now()/60000),
      payload:{requestedBy:ctx.actorId},priority:55,maxAttempts:3})).created};
  });
}

// ---- Pages, Needs you and Ask -------------------------------------------------------

const listSql=`SELECT w.*,s.code,i.name,t.code AS replacement_code,t.item_id AS replacement_item_id,
    trim_scale(coalesce((SELECT sum(b.on_hand) FROM balances b WHERE b.workspace_id=w.workspace_id AND b.sku_id=w.sku_id),0)::numeric)::text AS on_hand,
    (SELECT max(m.occurred_at::timestamptz) FROM movements m WHERE m.workspace_id=w.workspace_id AND m.sku_id=w.sku_id AND m.operation='issue' AND m.reason_code IN ('sale','sold')) AS last_sale,
    p.status AS clearance_status
  FROM ${work} w JOIN skus s ON s.workspace_id=w.workspace_id AND s.id=w.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  LEFT JOIN skus t ON t.workspace_id=w.workspace_id AND t.id=w.replacement_sku_id
  LEFT JOIN stockchief_runtime.agent_clearance_plans p ON p.workspace_id=w.workspace_id AND p.id=w.applied->>'clearancePlanId'`;
// Stock left that has stopped selling and has no clearance plan running: a
// person decides what happens to it.
const stalled=r=>r.status==='SELLING_DOWN'&&Number(r.on_hand)>0&&!['DRAFT','ACTIVE'].includes(r.clearance_status)&&
  (!r.last_sale||Date.now()-new Date(r.last_sale).getTime()>STALLED_DAYS*86400000)&&Date.now()-new Date(r.decided_at||r.created_at).getTime()>STALLED_DAYS*86400000;
function describe(r){
  const left=Number(r.on_hand)>0?r.on_hand+' left to sell':'none left';
  return {DRAFT:r.reason||'Waiting for your approval.',SELLING_DOWN:'No longer reordered; '+left+'.'+(r.reason?' '+r.reason:''),
    RETIRED:'Archived'+(r.applied?.channels?.queued?' and set to zero on '+r.applied.channels.queued+(r.applied.channels.queued===1?' channel':' channels'):'')+'.',
    DISMISSED:r.reason||'Kept.',UNDONE:'Brought back.'}[r.status];
}
async function screen(db,ctx,{page=1}={}){
  const number=Number(page);
  if(!Number.isSafeInteger(number)||number<1||number>1000000)throw new ValidationError('Choose a valid page.');
  const state=await policy.accountState(db,ctx.workspaceId);
  const rows=(await db.query(listSql+` WHERE w.workspace_id=$1 ORDER BY CASE w.status WHEN 'DRAFT' THEN 0 WHEN 'SELLING_DOWN' THEN 1 ELSE 2 END,w.created_at DESC,w.id LIMIT 51 OFFSET $2`,
    [ctx.workspaceId,(number-1)*50])).rows;
  const rule=await loadRule(db,ctx.workspaceId);
  const examples=(await db.query(`SELECT w.id,s.code FROM ${work} w JOIN skus s ON s.workspace_id=w.workspace_id AND s.id=w.sku_id
    WHERE w.workspace_id=$1 AND NOT w.automatic AND w.decided_by=$2 AND w.status IN ('SELLING_DOWN','RETIRED') ORDER BY w.decided_at DESC,w.id LIMIT 20`,[ctx.workspaceId,ctx.actorId])).rows;
  const trained=Boolean(rule?.example_id&&examples.some(e=>e.id===rule.example_id));
  return {workPage:number,workMore:rows.length>50,rule,examples,trained,
    alone:policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'automatic',{trained}),
    mode:policy.allowance(policy.usesAgentTerms(state)?state.plan:null,JOB),stop:await policy.stopped(db,ctx.workspaceId,state,ACTION,false),
    work:rows.slice(0,50).map(r=>({...r,text:describe(r),label:statusLabels[r.status],sourceLabel:sources[r.source],stalled:stalled(r)}))};
}

async function inbox(db,workspaceId){
  if(!await has(db,work))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const rows=(await db.query(listSql+` WHERE w.workspace_id=$1 AND w.status IN ('DRAFT','SELLING_DOWN') ORDER BY w.created_at,w.id LIMIT 500`,[workspaceId])).rows;
  const drafts=rows.filter(r=>r.status==='DRAFT'),held=rows.filter(r=>r.status==='SELLING_DOWN'&&r.reason&&Number(r.on_hand)===0),left=rows.filter(stalled);
  const out=[];
  if(drafts.length)out.push({kind:'catalog',importance:'Needs You',priority:50,grouped:true,title:'Dead stock to retire',
    happened:drafts.length+(drafts.length===1?' product has':' products have')+' not sold for the days in your rule.',
    why:'Retiring stops reordering, sells the stock down and points staff to a replacement.',recommendation:'Retire them, or keep selling them.',
    href:path,actionLabel:'Review dead stock',sourceId:'product-retirement-drafts',at:drafts[0].created_at,createdAt:drafts[0].created_at});
  if(held.length)out.push({kind:'catalog',importance:'Needs You',priority:55,grouped:true,title:'Discontinued products still on open work',
    happened:held.length+(held.length===1?' discontinued product is':' discontinued products are')+' sold out but still on an open order, transfer or production job.',
    why:held[0].reason,recommendation:'Change those lines to the replacement or finish them. StockChief archives the product afterwards.',
    href:path,actionLabel:'Review discontinued products',sourceId:'product-retirement-held',at:held[0].created_at,createdAt:held[0].created_at});
  if(left.length)out.push({kind:'catalog',importance:'Needs You',priority:52,grouped:true,title:'Discontinued stock is not selling',
    happened:left.length+(left.length===1?' discontinued product still has':' discontinued products still have')+' stock and no sale in '+STALLED_DAYS+' days.',
    why:'StockChief never writes off stock. A person decides.',recommendation:'Build a clearance plan, return it to the supplier, or write it off.',
    href:path,actionLabel:'Decide what to do with the stock',sourceId:'product-retirement-stock',at:left[0].created_at,createdAt:left[0].created_at});
  return out;
}

// The agent review behind the reviews list and Ask: every discontinued product,
// its replacement and the stock left to sell.
async function review(db,ctx,{filter='',page=1}={}){
  if(!await has(db,work))return {rows:[],more:false,summary:'No discontinued products yet.'};
  const rows=(await db.query(listSql+` WHERE w.workspace_id=$1 AND w.status IN ('DRAFT','SELLING_DOWN','RETIRED')
      AND ($2='' OR lower(s.code)=lower($2) OR lower(coalesce(t.code,''))=lower($2) OR lower(i.name)=lower($2))
    ORDER BY w.created_at DESC,w.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,String(filter||''),(page-1)*100])).rows;
  return {more:rows.length>100,summary:'Discontinued products are never reordered. Staff are pointed to the replacement on the product page, order entry, orders and pick lists. Stock left is sold down; a person decides any write-off.',
    rows:rows.slice(0,100).map(r=>({Product:r.name,SKU:r.code,Status:statusLabels[r.status],Replacement:r.replacement_code||'None recorded',
      'Stock left':r.on_hand,Source:sources[r.source],'What happens':describe(r),link:'/inventory/'+r.item_id}))};
}

// The product page offers the owner a way to mark this product discontinued.
async function canRetire(db,workspaceId,skus){
  if(!await has(db,work))return null;
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return null;
  const live=(skus||[]).filter(s=>s.is_active===undefined||Number(s.is_active)),done=await require('./retirement-guidance').discontinued(db,workspaceId,live.map(s=>s.id));
  return live.find(s=>!done.has(s.id))?.code||null;
}

module.exports={canRetire,JOB,ACTION,kind,path,startMany,finishMany,factRows,problem,mark,approve,dismiss,undo,configure,run,schedule,check,screen,inbox,review,load,loadRule};
