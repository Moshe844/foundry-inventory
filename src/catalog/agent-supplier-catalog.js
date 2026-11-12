'use strict';

// Job 127: creates products from a supplier catalog or price list.
//
// The file is read by the native import readers (CSV, spreadsheets, PDF
// tables) and its columns by job 133. Every line becomes one of:
//  - NEW: a product to create, with its SKU, name, options, pack, cost and a
//    link to the supplier. New products are created by the native import
//    worker from an import of exactly those lines.
//  - LINK: a product that already exists, found with job 126's duplicate
//    rules (same barcode, same supplier code, the same SKU apart from capitals
//    and spaces). It is linked to the supplier, never created twice, and its
//    own purchase cost and selling price are not changed.
//  - SAME: already linked to this supplier with the same terms.
//  - UNCLEAR: missing or conflicting facts, a match on name alone, a changed
//    supplier price or terms. A person decides; StockChief never guesses.
//
// Starter cannot use it. Growth drafts the product list for approval. Pro and
// Custom create the exact lines on their own, outside the first 14 days, Watch
// only, a pause, Ask me first or with routine work off; unclear lines wait.
// Everything is audited, replays safely and can be undone.

const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');
const {newId,nowIso}=require('../lib/util');

const JOB=127,ACTION='import.supplier_catalog',kind='agent.supplier-catalog.v1',path='/autopilot/supplier-catalogs';
const catalogs='stockchief_runtime.agent_supplier_catalogs',lines='stockchief_runtime.agent_supplier_catalog_rows';
const PACK=/^(?:pack(?:\s*(?:size|qty|quantity))?|case(?:\s*(?:pack|qty|quantity|size))?|inner(?:\s*pack)?|carton\s*(?:qty|quantity)|(?:units?|qty|quantity)\s*per\s*(?:case|pack|box|carton|inner)|per\s*(?:case|pack|box|carton))$/;
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const clean=v=>String(v??'').trim();
const norm=v=>clean(v).toLowerCase();

async function owner(db,ctx){
  const user=(await db.query(`SELECT u.* FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner'`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!user)throw new AuthorizationError('Only the inventory owner can create products from a supplier catalog.');
  return user;
}
async function ownerId(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}

// Whether StockChief may create exact lines without a person now; if not, why.
async function power(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {allowed:false,automatic:false,account};
  if(!policy.permits(account.plan,JOB,'automatic'))return {allowed:true,automatic:false,account,reason:'On Growth you approve the product list before anything is created.'};
  const stopped=await policy.stopped(db,workspaceId,account,ACTION,true);
  if(stopped)return {allowed:true,automatic:false,account,reason:stopped};
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
    return {allowed:true,automatic:false,account,reason:'Handle routine work is off for this inventory, so you approve the product list.'};
  return {allowed:true,automatic:true,account};
}
async function access(db,ctx,{decide=false}={}){
  const user=await owner(db,ctx);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  if(decide){const stopped=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);if(stopped)throw new ValidationError(stopped);}
  return {user,state};
}

// ---- Reading the file ---------------------------------------------------------

function packColumn(columns,mappings){
  const fields=require('../imports/fields'),taken=new Map(Object.entries(mappings).map(([f,i])=>[i,f]));
  return columns.find(c=>PACK.test(fields.normalise(c.name))&&(!taken.has(c.index)||fields.VARIANT_FIELDS.includes(taken.get(c.index))))||null;
}
function purchaseUnit(header,pack){
  if(!pack||Number(pack)===1)return 'unit';
  const h=String(header||'').toLowerCase();
  return /case/.test(h)?'case':/box/.test(h)?'box':/carton/.test(h)?'carton':/inner/.test(h)?'inner pack':'pack';
}

// Reads the file with the import readers. A pack column the heading rules
// would read as an option is kept out of the options and read as the pack.
async function read(db,ctx,{buffer,filename}){
  if(!Buffer.isBuffer(buffer)||!buffer.length)throw new ValidationError('Choose the supplier catalog file.');
  const imports=require('../imports/postgres-service'),fields=require('../imports/fields');
  const isPdf=buffer.subarray(0,5).toString('ascii')==='%PDF-';
  if(require('../imports/image-table').isImage(buffer))throw new ValidationError('Use the supplier’s spreadsheet, CSV or PDF catalog. Photos are read through the stock import.');
  const book=isPdf?await require('../imports/pdf-table').parse(buffer):require('../imports/parser').parse({buffer,filename,indexed:true});
  const sheet=book.sheets[book.primarySheet];
  if(!sheet?.rows.length)throw new ValidationError('That catalog has no product lines.');
  const guess=fields.guessMappings(sheet.columns,sheet.rows),pack=packColumn(sheet.columns,guess.mappings);
  if(!pack||!Object.values(guess.mappings).includes(pack.index))
    return {plan:await imports.analyse(db,ctx,{buffer,filename,allowModel:false}),pack};
  const variants=fields.VARIANT_FIELDS.map(f=>guess.mappings[f]).filter(i=>i!==undefined&&i!==pack.index);
  const mappings=Object.fromEntries(Object.entries(guess.mappings).filter(([f])=>!fields.VARIANT_FIELDS.includes(f)));
  variants.forEach((index,n)=>{mappings[fields.VARIANT_FIELDS[n]]=index;});
  return {plan:await imports.analyse(db,ctx,{buffer,filename,allowModel:false,mappings,reviewColumns:true}),pack};
}

// ---- Sorting the lines --------------------------------------------------------

function readPack(value){
  const text=clean(value).replace(/,/g,'');if(!text)return {pack:null};
  if(!/^\d+(?:\.\d{1,6})?$/.test(text)||Number(text)<=0||Number(text)>100000)return {pack:null,problem:'The pack size “'+clean(value)+'” is not a number of units.'};
  return {pack:text};
}

async function classify(c,ctx,catalog,plan){
  const supplier=(await c.query('SELECT id,name,currency,status FROM suppliers WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,catalog.supplier_id])).rows[0];
  if(!supplier||supplier.status!=='active')throw new ValidationError('Choose an active supplier. A new supplier is added by a person first.');
  const accounting=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.base_currency||null;
  const packHeader=catalog.pack_column===null||catalog.pack_column===undefined?null:plan.sourceColumns.find(col=>col.index===Number(catalog.pack_column))?.name;
  const supplierColumn=plan.fieldMappings.supplierName;
  const seen=new Map(),out=[];let after=-1;
  for(;;){
    const page=(await c.query(`SELECT row_number,status,parsed::jsonb AS parsed,raw::jsonb AS raw,problems::jsonb AS problems FROM import_rows
      WHERE workspace_id=$1 AND import_id=$2 AND row_number>$3 ORDER BY row_number LIMIT 1000`,[ctx.workspaceId,plan.id,after])).rows;
    if(!page.length)break;after=Number(page.at(-1).row_number);
    const batch=[];
    for(const r of page){
      if(r.status==='EXCLUDED')continue;
      const p=r.parsed||{},raw=Array.isArray(r.raw)?r.raw:[];
      const packRead=packHeader?readPack(raw[Number(catalog.pack_column)]):{pack:null};
      const line={row_number:Number(r.row_number),name:p.name||null,code:p.code||null,supplier_code:p.sourceCode||p.code||null,barcode:p.barcode||null,
        options:(p.variants||[]).map(v=>({name:v.name,value:v.value})),unit_label:p.unitLabel||'unit',pack:packRead.pack,
        purchase_unit:purchaseUnit(packHeader,packRead.pack),cost_minor:Number.isSafeInteger(p.unitCostMinor)?p.unitCostMinor:null,currency:p.currency||accounting||supplier.currency,
        kind:'UNCLEAR',target_sku_id:null,reason:null};
      const key=norm(line.code);
      if(r.status==='INVALID')line.reason=(r.problems||[])[0]?.message||'This line needs correction in the file.';
      else if(p.quantity>0)line.reason='This line has a stock quantity. Stock comes in through the stock import.';
      else if(!line.code)line.reason='This line has no SKU.';
      else if(mappingsHasName(plan)&&!line.name)line.reason='This line has no product name.';
      else if(line.cost_minor===null)line.reason='This line has no unit cost.';
      else if(packRead.problem)line.reason=packRead.problem;
      else if(supplierColumn!==undefined&&clean(raw[supplierColumn])&&norm(raw[supplierColumn])!==norm(supplier.name))line.reason='This line is from '+clean(raw[supplierColumn])+', not '+supplier.name+'.';
      else if(supplier.currency&&line.currency&&money.code(line.currency)!==money.code(supplier.currency))line.reason='The price is in '+line.currency+' but '+supplier.name+' bills in '+supplier.currency+'.';
      else if(seen.has(key))line.reason='The SKU '+line.code+' is also on line '+seen.get(key)+'.';
      if(key&&!seen.has(key))seen.set(key,line.row_number);
      out.push(line);if(!line.reason)batch.push(line);
    }
    const matches=await require('./agent-catalog-fixes').matchIncoming(c,ctx.workspaceId,supplier.id,batch.map(l=>({key:String(l.row_number),code:l.supplier_code,
      barcode:l.barcode,name:l.name,options:l.options.map(o=>o.value).join(' / '),unit:l.unit_label})));
    const strongIds=[...new Set([...matches.values()].flat().filter(m=>m.rank<4).map(m=>m.id))];
    const links=new Map((strongIds.length?(await c.query(`SELECT si.*,s.code FROM supplier_items si JOIN skus s ON s.workspace_id=si.workspace_id AND s.id=si.sku_id
      WHERE si.workspace_id=$1 AND si.supplier_id=$2 AND si.sku_id=ANY($3::text[])`,[ctx.workspaceId,supplier.id,strongIds])).rows:[]).map(r=>[r.sku_id,r]));
    for(const line of batch){
      const found=matches.get(String(line.row_number))||[],strong=[...new Map(found.filter(m=>m.rank<4).map(m=>[m.id,m])).values()];
      if(strong.length>1){line.reason='This line matches more than one product: '+strong.map(m=>m.code).slice(0,3).join(', ')+'.';continue;}
      if(strong.length===1){
        const m=strong[0];line.target_sku_id=m.id;
        if(!m.live){line.reason='This line matches '+m.code+', which is archived.';continue;}
        if(line.barcode&&clean(m.barcode)&&norm(m.barcode)!==norm(line.barcode)){line.reason='This line matches '+m.code+' but has a different barcode.';continue;}
        const link=links.get(m.id),pack=String(Number(line.pack||1)),cost=money.fromMinor(line.cost_minor,line.currency);
        if(!link||Number(link.is_active)!==1){line.kind='LINK';continue;}
        const sameCode=norm(link.supplier_sku)===norm(line.supplier_code)||!clean(link.supplier_sku);
        const samePack=String(Number(link.units_per_purchase_unit||1))===pack;
        const sameCost=link.last_unit_cost===null||Number(link.last_unit_cost)===Number(cost);
        if(sameCode&&samePack&&sameCost&&clean(link.supplier_sku)){line.kind='SAME';continue;}
        line.reason=!sameCost?supplier.name+'’s price for '+m.code+' changed from '+money.format(money.toMinor(String(link.last_unit_cost),line.currency),line.currency)+' to '+money.format(line.cost_minor,line.currency)+'. A new price needs a person.':
          'The supplier code or pack for '+m.code+' changed. New terms need a person.';
        continue;
      }
      const named=found.find(m=>m.rank===4);
      if(named){line.target_sku_id=named.live?named.id:null;line.reason='The same name and options as '+named.code+'. Is it the same product?';continue;}
      line.kind='NEW';
    }
  }
  return out;
}
function mappingsHasName(plan){return plan.fieldMappings.name!==undefined;}

async function saveLines(c,ctx,catalogId,rows){
  for(let start=0;start<rows.length;start+=1000){
    await c.query(`INSERT INTO ${lines}(catalog_id,workspace_id,row_number,kind,status,name,code,supplier_code,barcode,options,unit_label,pack,purchase_unit,cost_minor,currency,target_sku_id,reason)
      SELECT $1,$2,x.row_number,x.kind,CASE WHEN x.kind='SAME' THEN 'DONE' ELSE 'PENDING' END,x.name,x.code,x.supplier_code,x.barcode,coalesce(x.options,'[]'::jsonb),x.unit_label,x.pack,x.purchase_unit,x.cost_minor,x.currency,x.target_sku_id,
        CASE WHEN x.kind='SAME' THEN 'Already linked to this supplier with these terms.' ELSE x.reason END
      FROM jsonb_to_recordset($3::jsonb) AS x(row_number bigint,kind text,name text,code text,supplier_code text,barcode text,options jsonb,unit_label text,pack numeric,purchase_unit text,cost_minor bigint,currency text,target_sku_id text,reason text)`,
    [catalogId,ctx.workspaceId,JSON.stringify(rows.slice(start,start+1000))]);
  }
}

// ---- Starting a catalog -------------------------------------------------------

async function start(db,ctx,{buffer,filename,supplierId,importId}={}){
  await access(db,ctx);
  const supplier=(await db.query("SELECT id FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,clean(supplierId)])).rows[0];
  if(!supplier)throw new ValidationError('Choose one of your active suppliers. A new supplier is added by a person first.');
  const imports=require('../imports/postgres-service');
  let plan,pack=null;
  if(importId){plan=await imports.get(db,ctx.workspaceId,clean(importId));const found=packColumn(plan.sourceColumns,plan.fieldMappings);pack=found&&!Object.values(plan.fieldMappings).includes(found.index)?found:null;}
  else ({plan,pack}=await read(db,ctx,{buffer,filename}));
  if(!plan||plan.transformations.dataset==='suppliers')throw new ValidationError('Choose a product catalog, not a list of suppliers.');
  const prior=(await db.query(`SELECT id FROM ${catalogs} WHERE workspace_id=$1 AND source_hash=$2 AND supplier_id=$3 AND status NOT IN ('UNDONE','CANCELLED')`,
    [ctx.workspaceId,plan.sourceHash,supplier.id])).rows[0];
  if(prior){if(!importId&&plan.status==='READY')await imports.cancel(db,ctx,plan.id).catch(()=>{});return {id:prior.id,replayed:true};}
  const id=newId('scat');
  await db.query(`INSERT INTO ${catalogs}(id,workspace_id,import_id,supplier_id,source_name,source_hash,status,pack_column,created_by) VALUES($1,$2,$3,$4,$5,$6,'COLUMNS',$7,$8)`,
    [id,ctx.workspaceId,plan.id,supplier.id,plan.sourceName,plan.sourceHash,pack?pack.index:null,ctx.actorId]);
  await check(db,ctx,id);
  return {id,replayed:false};
}

// Sorts the lines again from the current file preview, then lets the plan
// decide who acts. Run after start and after a column question is answered.
async function check(db,ctx,id){
  await access(db,ctx);
  return tx(db,async c=>{
    const catalog=await load(c,ctx,id,{lock:true});
    if(catalog.status!=='COLUMNS'&&catalog.status!=='WAITING')throw new ValidationError('This catalog is already being created. Open its results.');
    if((await c.query(`SELECT 1 FROM ${lines} WHERE catalog_id=$1 AND status IN ('READY','CREATING','DONE') AND kind<>'SAME' LIMIT 1`,[id])).rowCount)
      throw new ValidationError('Some lines of this catalog are already saved. Decide the waiting lines on this page.');
    const plan=await require('../imports/postgres-service').get(c,ctx.workspaceId,catalog.import_id);
    const question=require('../imports/approval-review').planRequirements(plan).find(r=>!['rows','empty'].includes(r.code));
    await c.query(`DELETE FROM ${lines} WHERE catalog_id=$1`,[id]);
    if(question||plan.status!=='READY'){
      const reason=plan.status!=='READY'?'The file preview is no longer open. Read the catalog again.':question.title+'. '+question.detail;
      await c.query(`UPDATE ${catalogs} SET status='COLUMNS',hold_reason=$2,updated_at=clock_timestamp(),revision=revision+1 WHERE id=$1`,[id,reason]);
      return {status:'COLUMNS',reason};
    }
    if(plan.fieldMappings.quantity!==undefined&&(await c.query("SELECT 1 FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status IN ('VALID','INVALID') AND (parsed::jsonb->>'quantity')::numeric>0 LIMIT 1",[ctx.workspaceId,plan.id])).rowCount){
      const reason='This file has stock quantities. Products from a supplier catalog are created without stock; bring stock in through the stock import.';
      await c.query(`UPDATE ${catalogs} SET status='COLUMNS',hold_reason=$2,updated_at=clock_timestamp(),revision=revision+1 WHERE id=$1`,[id,reason]);
      return {status:'COLUMNS',reason};
    }
    const rows=await classify(c,ctx,catalog,plan);
    await saveLines(c,ctx,id,rows);
    return decide(c,ctx,id);
  });
}

// Pro and Custom hand the exact lines to the worker; everything else waits.
async function decide(c,ctx,id){
  const can=await power(c,ctx.workspaceId);
  const counts=(await c.query(`SELECT count(*) FILTER(WHERE status='PENDING' AND kind IN ('NEW','LINK'))::int AS exact,
    count(*) FILTER(WHERE status='PENDING' AND kind='UNCLEAR' AND decision IS NULL)::int AS unclear FROM ${lines} WHERE catalog_id=$1`,[id])).rows[0];
  if(can.automatic&&counts.exact){
    await c.query(`UPDATE ${lines} SET status='READY',automatic=true WHERE catalog_id=$1 AND status='PENDING' AND kind IN ('NEW','LINK')`,[id]);
    await c.query(`UPDATE ${catalogs} SET status='QUEUED',automatic=true,hold_reason=NULL,updated_at=clock_timestamp(),revision=revision+1 WHERE id=$1`,[id]);
    await queue(c,ctx.workspaceId,id);
    return {status:'QUEUED',automatic:true,unclear:counts.unclear};
  }
  const open=counts.exact+counts.unclear;
  await c.query(`UPDATE ${catalogs} SET status=$2,hold_reason=$3,updated_at=clock_timestamp(),revision=revision+1 WHERE id=$1`,
    [id,open?'WAITING':'DONE',open?can.reason||null:null]);
  return {status:open?'WAITING':'DONE',automatic:false,reason:can.reason,unclear:counts.unclear};
}

async function queue(c,workspaceId,id,suffix=''){
  const revision=(await c.query(`SELECT revision FROM ${catalogs} WHERE id=$1`,[id])).rows[0].revision;
  return jobs.enqueue(scoped(c),{workspaceId,kind,idempotencyKey:'supplier-catalog:'+id+':'+revision+suffix,payload:{catalogId:id},priority:40,maxAttempts:5});
}

async function load(db,ctx,id,{lock=false}={}){
  const row=(await db.query(`SELECT c.*,s.name AS supplier_name,s.currency AS supplier_currency FROM ${catalogs} c JOIN suppliers s ON s.workspace_id=c.workspace_id AND s.id=c.supplier_id
    WHERE c.workspace_id=$1 AND c.id=$2${lock?' FOR UPDATE OF c':''}`,[ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That supplier catalog is not in this inventory.');
  return row;
}

// ---- A person approves --------------------------------------------------------

// decisions: {rowNumber: CREATE|LINK|SKIP} for unclear lines. Approving also
// releases every exact line still waiting (the Growth draft).
async function approve(db,ctx,id,{decisions={},revision}={}){
  const {user}=await access(db,ctx,{decide:true});
  return tx(db,async c=>{
    const catalog=await load(c,ctx,id,{lock:true});
    if(revision!==undefined&&Number(revision)!==Number(catalog.revision))throw new ValidationError('This catalog changed. Review it again before approving.');
    if(!['WAITING','DONE','QUEUED'].includes(catalog.status))throw new ValidationError(catalog.status==='COLUMNS'?'Answer the file question first.':'This catalog is closed.');
    let decided=0;
    for(const [raw,choice] of Object.entries(decisions)){
      if(!choice)continue;
      if(!['CREATE','LINK','SKIP'].includes(choice))throw new ValidationError('Choose create, link or leave out for each line.');
      const line=(await c.query(`SELECT * FROM ${lines} WHERE catalog_id=$1 AND row_number=$2 FOR UPDATE`,[id,Number(raw)])).rows[0];
      if(!line||line.status!=='PENDING'||line.kind!=='UNCLEAR')continue;
      if(choice==='CREATE'&&(!line.code||!line.name||line.cost_minor===null||line.target_sku_id&&!/same name/i.test(line.reason||'')))
        throw new ValidationError('Line '+line.row_number+' cannot be created as it is. Correct the file, link it, or leave it out.');
      if(choice==='CREATE'&&(await c.query("SELECT 1 FROM skus WHERE workspace_id=$1 AND lower(btrim(code))=lower(btrim($2)) LIMIT 1",[ctx.workspaceId,line.code])).rowCount)
        throw new ValidationError('The SKU '+line.code+' is already used. Link line '+line.row_number+' or leave it out.');
      if(choice==='LINK'&&!line.target_sku_id)throw new ValidationError('Line '+line.row_number+' has no product to link to.');
      if(choice==='LINK'&&(line.cost_minor===null||!line.supplier_code))throw new ValidationError('Line '+line.row_number+' needs its supplier code and cost to be linked.');
      await c.query(`UPDATE ${lines} SET decision=$3,status=$4,decided_by=$5 WHERE catalog_id=$1 AND row_number=$2`,
        [id,line.row_number,choice,choice==='SKIP'?'SKIPPED':'READY',ctx.actorId]);
      decided++;
    }
    const released=(await c.query(`UPDATE ${lines} SET status='READY',decided_by=$2 WHERE catalog_id=$1 AND status='PENDING' AND kind IN ('NEW','LINK') RETURNING row_number`,[id,ctx.actorId])).rowCount;
    const ready=(await c.query(`SELECT count(*)::int n FROM ${lines} WHERE catalog_id=$1 AND status='READY'`,[id])).rows[0].n;
    await c.query(`UPDATE ${catalogs} SET status=$2,approved_by=$3,approved_at=clock_timestamp(),hold_reason=NULL,updated_at=clock_timestamp(),revision=revision+1 WHERE id=$1`,
      [id,ready?'QUEUED':await openLines(c,id)?'WAITING':'DONE',ctx.actorId]);
    if(ready)await queue(c,ctx.workspaceId,id);
    await audit.record(c,{...ctx,accountId:user.account_id},{action:'Supplier catalog approved',reference:id,after:{lines:released+decided,ready}});
    return {ready,decided};
  });
}
async function openLines(c,id){return (await c.query(`SELECT 1 FROM ${lines} WHERE catalog_id=$1 AND status IN ('PENDING','READY','CREATING') LIMIT 1`,[id])).rowCount>0;}

// ---- The worker ---------------------------------------------------------------

async function run(job,database){
  const id=job.payload?.catalogId;
  const head=(await database.query(`SELECT * FROM ${catalogs} WHERE workspace_id=$1 AND id=$2`,[job.workspaceId,id])).rows[0];
  if(!head||!['QUEUED','WAITING'].includes(head.status))return {skipped:true};
  const actorId=head.approved_by||await ownerId(database,job.workspaceId);
  const ctx={workspaceId:job.workspaceId,actorId};
  // Plan, pause and job mode are checked again before anything is written.
  const held=await tx(database,async c=>{
    const catalog=await load(c,ctx,id,{lock:true}),can=await power(c,ctx.workspaceId);
    if(!can.allowed){
      await c.query(`UPDATE ${lines} SET status='PENDING' WHERE catalog_id=$1 AND status='READY'`,[id]);
      await c.query(`UPDATE ${catalogs} SET status='WAITING',hold_reason=$2,updated_at=clock_timestamp() WHERE id=$1`,[id,'Creating products from a supplier catalog needs Growth or above.']);
      return true;
    }
    if(!can.automatic){
      const back=await c.query(`UPDATE ${lines} SET status='PENDING',automatic=false WHERE catalog_id=$1 AND status='READY' AND automatic AND decided_by IS NULL`,[id]);
      if(back.rowCount)await c.query(`UPDATE ${catalogs} SET hold_reason=$2,updated_at=clock_timestamp() WHERE id=$1`,[id,can.reason]);
    }
    return catalog.status!=='QUEUED'&&catalog.status!=='WAITING';
  });
  if(held)return {held:true};
  const linked=await linkExisting(database,ctx,id);
  const created=await createNew(database,ctx,id);
  const finished=await finish(database,ctx,id);
  return {linked,created,finished};
}

// Existing products: link the supplier with its code, pack and price.
async function linkExisting(database,ctx,id){
  const commerce=require('../operations/postgres-commerce');let total=0;
  for(;;){
    const done=await tx(database,async c=>{
      const catalog=await load(c,ctx,id,{lock:true});
      const batch=(await c.query(`SELECT * FROM ${lines} WHERE catalog_id=$1 AND status='READY' AND (kind='LINK' OR decision='LINK') ORDER BY row_number LIMIT 500 FOR UPDATE`,[id])).rows;
      if(!batch.length)return 0;
      const prior=new Map((await c.query('SELECT * FROM supplier_items WHERE workspace_id=$1 AND supplier_id=$2 AND sku_id=ANY($3::text[])',
        [ctx.workspaceId,catalog.supplier_id,batch.map(l=>l.target_sku_id)])).rows.map(r=>[r.sku_id,r]));
      const live=new Set((await c.query('SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1',
        [ctx.workspaceId,batch.map(l=>l.target_sku_id)])).rows.map(r=>r.id));
      const write=[],stale=[];
      for(const line of batch){
        const before=prior.get(line.target_sku_id);
        // A link that appeared or changed since the review is asked about again.
        if(!live.has(line.target_sku_id)||line.decision!=='LINK'&&before&&Number(before.is_active)===1){stale.push(line.row_number);continue;}
        write.push({line,before,input:{supplierId:catalog.supplier_id,skuId:line.target_sku_id,supplierSku:line.supplier_code,purchaseUnit:line.purchase_unit||'unit',
          unitsPerPurchaseUnit:String(Number(line.pack||1)),lastUnitCost:money.fromMinor(Number(line.cost_minor),line.currency),
          ...(before?{expectedUpdatedAt:before.updated_at}:{expectAbsent:true})}});
      }
      if(stale.length)await c.query(`UPDATE ${lines} SET status='PENDING',kind='UNCLEAR',automatic=false,reason='The product or its supplier link changed after this list was prepared. Decide again.' WHERE catalog_id=$1 AND row_number=ANY($2::bigint[])`,[id,stale]);
      if(write.length){
        const saved=await commerce.linkSupplierItemsInTransaction(c,ctx,write.map(w=>w.input));
        const byPair=new Map(saved.map(r=>[r.sku_id,r.id]));
        await c.query(`UPDATE ${lines} l SET status='DONE',done_at=clock_timestamp(),link_id=x.link_id,link_before=x.before FROM jsonb_to_recordset($2::jsonb) AS x(row_number bigint,link_id text,before jsonb)
          WHERE l.catalog_id=$1 AND l.row_number=x.row_number`,[id,JSON.stringify(write.map(w=>({row_number:w.line.row_number,link_id:byPair.get(w.line.target_sku_id),before:w.before?{...w.before,_existed:true}:null})))]);
      }
      return write.length+stale.length;
    });
    if(!done)return total;total+=done;
  }
}

// New products: one native import of exactly the approved lines.
async function createNew(database,ctx,id){
  const imports=require('../imports/postgres-service'),fields=require('../imports/fields');
  const catalog=await load(database,ctx,id);
  const ready=(await database.query(`SELECT * FROM ${lines} WHERE catalog_id=$1 AND status='READY' AND (kind='NEW' OR decision='CREATE') ORDER BY row_number`,[id])).rows;
  if(!ready.length)return 0;
  const axes=[...new Set(ready.flatMap(l=>(l.options||[]).map(o=>o.name)))].slice(0,fields.VARIANT_FIELDS.length);
  const cell=v=>{const t=String(v??'');return /[",\n\r]/.test(t)?'"'+t.replace(/"/g,'""')+'"':t;};
  // The note names this catalog, so each catalog's import is its own source.
  const header=['Product','SKU',...axes,'Barcode','Unit cost','Currency','Supplier','Unit','Note'];
  const note='Supplier catalog '+catalog.source_name+' ('+id+')';
  const body=ready.map(l=>[l.name||l.code,l.code,...axes.map(a=>(l.options||[]).find(o=>o.name===a)?.value||''),l.barcode||'',
    money.fromMinor(Number(l.cost_minor),l.currency),l.currency,catalog.supplier_name,l.unit_label||'unit',note].map(cell).join(','));
  const mappings={name:0,code:1};axes.forEach((_,n)=>{mappings[fields.VARIANT_FIELDS[n]]=2+n;});
  Object.assign(mappings,{barcode:2+axes.length,unitCost:3+axes.length,currency:4+axes.length,supplierName:5+axes.length,unitLabel:6+axes.length,notes:7+axes.length});
  const rows=ready.map(l=>l.row_number);
  const plan=await imports.analyse(database,ctx,{text:[header.map(cell).join(','),...body].join('\n'),filename:catalog.source_name+' (new products '+catalog.revision+').csv',
    mappings,allowModel:false,beforeCommit:async(client,derived)=>{
      await client.query("UPDATE import_plans SET transformations=(transformations::jsonb||jsonb_build_object('agentJob',127,'supplierCatalogId',$3::text))::text WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,derived.id,id]);
      await client.query(`UPDATE ${lines} SET status='CREATING',derived_import_id=$3 WHERE catalog_id=$1 AND row_number=ANY($2::bigint[]) AND status='READY'`,[id,rows,derived.id]);
    }});
  // The lines are checked again by the import itself. Anything that no longer
  // reads as a clean new product waits for a person instead.
  const problems=(await database.query(`SELECT parsed::jsonb->>'code' AS code,status,problems::jsonb->0->>'message' AS message,parsed::jsonb->>'existingSkuId' AS existing
    FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND (status<>'VALID' OR parsed::jsonb->>'existingSkuId' IS NOT NULL)`,[ctx.workspaceId,plan.id])).rows;
  if(problems.length){
    await imports.cancel(database,ctx,plan.id);
    await tx(database,async c=>{
      for(const p of problems)await c.query(`UPDATE ${lines} SET status='PENDING',kind='UNCLEAR',automatic=false,decision=NULL,derived_import_id=NULL,reason=$3 WHERE catalog_id=$1 AND derived_import_id=$2 AND lower(code)=lower($4)`,
        [id,plan.id,p.existing?'This SKU now belongs to a product that already exists. Decide again.':p.message||'This line no longer reads as a new product.',p.code]);
      await c.query(`UPDATE ${lines} SET status='READY',derived_import_id=NULL WHERE catalog_id=$1 AND derived_import_id=$2`,[id,plan.id]);
      await c.query(`UPDATE ${catalogs} SET revision=revision+1 WHERE id=$1`,[id]);
      await queue(c,ctx.workspaceId,id);
    });
    return 0;
  }
  await imports.approveAndQueue(database,ctx,plan.id,plan.integrityHash);
  return ready.length;
}

// After the native import: the new products get their supplier code and pack.
async function finish(database,ctx,id){
  return tx(database,async c=>{
    const catalog=await load(c,ctx,id,{lock:true});
    const waiting=(await c.query(`SELECT DISTINCT l.derived_import_id,p.status FROM ${lines} l JOIN import_plans p ON p.workspace_id=$2 AND p.id=l.derived_import_id
      WHERE l.catalog_id=$1 AND l.status='CREATING'`,[id,ctx.workspaceId])).rows;
    let finished=0;
    for(const w of waiting){
      if(w.status==='CANCELLED'||w.status==='FAILED'){
        await c.query(`UPDATE ${lines} SET status='PENDING',kind='UNCLEAR',automatic=false,derived_import_id=NULL,reason='The product import stopped before it finished. Decide again.' WHERE catalog_id=$1 AND derived_import_id=$2`,[id,w.derived_import_id]);
        continue;
      }
      if(w.status!=='SUCCEEDED')continue;
      // One pass over the import's rows, matched by SKU here: a join on the
      // parsed code would read every row once per catalog line.
      const skuByCode=new Map((await c.query(`SELECT parsed::jsonb->>'code' AS code,sku_id FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status='IMPORTED'`,
        [ctx.workspaceId,w.derived_import_id])).rows.map(r=>[norm(r.code),r.sku_id]));
      const made=(await c.query(`SELECT row_number,code,supplier_code,pack,purchase_unit,cost_minor,currency FROM ${lines} WHERE catalog_id=$1 AND derived_import_id=$2 AND status='CREATING'`,
        [id,w.derived_import_id])).rows.map(m=>({...m,sku_id:skuByCode.get(norm(m.code))||null}));
      for(let start=0;start<made.length;start+=1000){
        const part=made.slice(start,start+1000).filter(m=>m.sku_id);
        if(!part.length)continue;
        const saved=await require('../operations/postgres-commerce').linkSupplierItemsInTransaction(c,ctx,part.map(m=>({supplierId:catalog.supplier_id,skuId:m.sku_id,
          supplierSku:m.supplier_code,purchaseUnit:m.purchase_unit||'unit',unitsPerPurchaseUnit:String(Number(m.pack||1)),lastUnitCost:money.fromMinor(Number(m.cost_minor),m.currency)})));
        const byPair=new Map(saved.map(r=>[r.sku_id,r.id]));
        await c.query(`UPDATE ${lines} l SET status='DONE',done_at=clock_timestamp(),created_sku_id=x.sku_id,link_id=x.link_id FROM jsonb_to_recordset($2::jsonb) AS x(row_number bigint,sku_id text,link_id text)
          WHERE l.catalog_id=$1 AND l.row_number=x.row_number`,[id,JSON.stringify(part.map(m=>({row_number:m.row_number,sku_id:m.sku_id,link_id:byPair.get(m.sku_id)})))]);
        finished+=part.length;
      }
    }
    const state=(await c.query(`SELECT count(*) FILTER(WHERE status IN ('READY','CREATING'))::int AS busy,count(*) FILTER(WHERE status='PENDING')::int AS pending,
      count(*) FILTER(WHERE status='DONE' AND kind<>'SAME')::int AS done,count(*) FILTER(WHERE status='DONE' AND automatic AND kind<>'SAME')::int AS alone FROM ${lines} WHERE catalog_id=$1`,[id])).rows[0];
    const status=state.busy?'QUEUED':state.pending?'WAITING':'DONE';
    if(status!==catalog.status||finished)await c.query(`UPDATE ${catalogs} SET status=$2,done_at=CASE WHEN $2='DONE' THEN clock_timestamp() ELSE done_at END,updated_at=clock_timestamp() WHERE id=$1`,[id,status]);
    if(status!=='QUEUED'&&catalog.status==='QUEUED')
      await audit.record(c,ctx,{action:state.alone?'Supplier catalog products created by StockChief':'Supplier catalog products created',reference:id,
        after:{done:state.done,automatic:state.alone,waiting:state.pending,supplier:catalog.supplier_name}});
    return finished;
  });
}

// The native import finished: pick the catalog up again.
async function afterImport(c,workspaceId,importId){
  if(!await require('../db/schema-installed').has(c,lines))return {queued:false};
  const row=(await c.query(`SELECT DISTINCT catalog_id FROM ${lines} WHERE workspace_id=$1 AND derived_import_id=$2 AND status='CREATING' LIMIT 1`,[workspaceId,importId])).rows[0];
  if(!row)return {queued:false};
  return {queued:(await jobs.enqueue(scoped(c),{workspaceId,kind,idempotencyKey:'supplier-catalog:'+row.catalog_id+':import:'+importId,payload:{catalogId:row.catalog_id},priority:40,maxAttempts:5})).created};
}

// ---- Undo ---------------------------------------------------------------------

// Links are put back as they were; products created are removed through the
// import undo, which refuses products that have since been used.
async function undo(db,ctx,id){
  const {user}=await access(db,ctx);
  const catalog=await load(db,ctx,id);
  if(['UNDONE','CANCELLED'].includes(catalog.status))return {replayed:true};
  if(catalog.status==='QUEUED')throw new ValidationError('Wait for this catalog to finish, then undo it.');
  const kept=[];
  await tx(db,async c=>{
    await load(c,ctx,id,{lock:true});
    const linked=(await c.query(`SELECT * FROM ${lines} WHERE catalog_id=$1 AND status='DONE' AND link_id IS NOT NULL AND created_sku_id IS NULL FOR UPDATE`,[id])).rows;
    for(const line of linked){
      const before=line.link_before;
      if(before?._existed){
        await c.query(`UPDATE supplier_items SET supplier_sku=$3,purchase_unit=$4,units_per_purchase_unit=$5,last_unit_cost=$6,last_cost_at=$7,is_active=$8,updated_at=$9 WHERE workspace_id=$1 AND id=$2`,
          [ctx.workspaceId,line.link_id,before.supplier_sku,before.purchase_unit,before.units_per_purchase_unit,before.last_unit_cost,before.last_cost_at,before.is_active,nowIso()]);
      }else await c.query('UPDATE supplier_items SET is_active=0,updated_at=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,line.link_id,nowIso()]);
      await c.query(`UPDATE ${lines} SET status='UNDONE' WHERE catalog_id=$1 AND row_number=$2`,[id,line.row_number]);
    }
  });
  const removal=require('../domain/postgres-record-removal');
  const derived=(await db.query(`SELECT DISTINCT derived_import_id FROM ${lines} WHERE catalog_id=$1 AND status='DONE' AND created_sku_id IS NOT NULL`,[id])).rows.map(r=>r.derived_import_id);
  for(const importId of derived){
    const review=await removal.review(db,ctx,user,'import',importId);
    if(review.blockers.length){kept.push(review.blockers[0]);continue;}
    await removal.remove(db,ctx,user,'import',importId,{expectedHash:review.hash});
    await db.query(`UPDATE ${lines} SET status='UNDONE' WHERE catalog_id=$1 AND derived_import_id=$2 AND status='DONE'`,[id,importId]);
  }
  await tx(db,async c=>{
    await c.query(`UPDATE ${lines} SET status='SKIPPED' WHERE catalog_id=$1 AND status IN ('PENDING','READY')`,[id]);
    const left=(await c.query(`SELECT 1 FROM ${lines} WHERE catalog_id=$1 AND status='DONE' AND kind<>'SAME' LIMIT 1`,[id])).rowCount;
    await c.query(`UPDATE ${catalogs} SET status=$2,undone_by=$3,undone_at=clock_timestamp(),hold_reason=$4,updated_at=clock_timestamp(),revision=revision+1 WHERE id=$1`,
      [id,left?'DONE':'UNDONE',ctx.actorId,kept[0]||null]);
    await audit.record(c,{...ctx,accountId:user.account_id},{action:'Supplier catalog undone',reference:id,after:{kept:kept.length}});
  });
  return {kept};
}

async function cancel(db,ctx,id){
  await access(db,ctx);
  return tx(db,async c=>{
    const catalog=await load(c,ctx,id,{lock:true});
    if(!['COLUMNS','WAITING'].includes(catalog.status))throw new ValidationError('Only a catalog waiting for you can be closed.');
    if((await c.query(`SELECT 1 FROM ${lines} WHERE catalog_id=$1 AND status IN ('DONE','READY','CREATING') AND kind<>'SAME' LIMIT 1`,[id])).rowCount){
      await c.query(`UPDATE ${lines} SET status='SKIPPED' WHERE catalog_id=$1 AND status='PENDING'`,[id]);
      await c.query(`UPDATE ${catalogs} SET status='DONE',updated_at=clock_timestamp() WHERE id=$1`,[id]);return {status:'DONE'};
    }
    await c.query(`UPDATE ${catalogs} SET status='CANCELLED',updated_at=clock_timestamp() WHERE id=$1`,[id]);return {status:'CANCELLED'};
  });
}

// ---- Pages and lists ------------------------------------------------------------

const kindLabels={NEW:'New product',LINK:'Already in your products',SAME:'Already linked',UNCLEAR:'Needs you'};
const statusLabels={COLUMNS:'Waiting for the file question',WAITING:'Waiting for you',QUEUED:'Being created',DONE:'Done',UNDONE:'Undone',CANCELLED:'Closed'};

async function list(db,ctx){
  const {state}=await access(db,ctx);
  const rows=(await db.query(`SELECT c.id,c.source_name,c.status,c.created_at,s.name AS supplier_name,
    (SELECT count(*) FROM ${lines} l WHERE l.catalog_id=c.id AND l.status='PENDING')::int AS waiting,
    (SELECT count(*) FROM ${lines} l WHERE l.catalog_id=c.id AND l.status='DONE' AND l.kind<>'SAME')::int AS done
    FROM ${catalogs} c JOIN suppliers s ON s.workspace_id=c.workspace_id AND s.id=c.supplier_id WHERE c.workspace_id=$1 ORDER BY c.created_at DESC,c.id LIMIT 30`,[ctx.workspaceId])).rows;
  const suppliers=(await db.query("SELECT id,name FROM suppliers WHERE workspace_id=$1 AND status='active' ORDER BY name,id LIMIT 500",[ctx.workspaceId])).rows;
  const can=await power(db,ctx.workspaceId);
  return {catalogs:rows.map(r=>({...r,label:statusLabels[r.status]})),suppliers,mode:policy.allowance(state.plan,JOB),reason:can.reason||null};
}

async function page(db,ctx,id,{page:number=1,show=''}={}){
  await access(db,ctx);
  const catalog=await load(db,ctx,id),n=Math.max(1,Math.min(100000,Number(number)||1));
  const filter=['NEW','LINK','UNCLEAR','DONE'].includes(show)?show:'';
  const counts=(await db.query(`SELECT kind,status,count(*)::int n FROM ${lines} WHERE catalog_id=$1 GROUP BY kind,status`,[id])).rows;
  const rows=(await db.query(`SELECT l.*,s.code AS target_code,i.name AS target_name,i.id AS target_item_id FROM ${lines} l
    LEFT JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=coalesce(l.created_sku_id,l.target_sku_id) LEFT JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE l.catalog_id=$1 AND ($2='' OR ($2='DONE' AND l.status='DONE') OR ($2<>'DONE' AND l.kind=$2 AND l.status<>'DONE'))
    ORDER BY CASE WHEN l.status='PENDING' AND l.kind='UNCLEAR' THEN 0 WHEN l.status='PENDING' THEN 1 ELSE 2 END,l.row_number LIMIT 101 OFFSET $3`,[id,filter,(n-1)*100])).rows;
  const sum=(k,s)=>counts.filter(c=>(!k||c.kind===k)&&(!s||c.status===s)).reduce((a,c)=>a+c.n,0);
  const can=await power(db,ctx.workspaceId);
  return {catalog:{...catalog,label:statusLabels[catalog.status]},rows:rows.slice(0,100).map(r=>({...r,kindLabel:kindLabels[r.kind],
      cost:r.cost_minor===null?null:money.format(Number(r.cost_minor),r.currency)})),more:rows.length>100,page:n,show:filter,
    totals:{lines:sum(),new:sum('NEW'),link:sum('LINK'),same:sum('SAME'),unclear:sum('UNCLEAR','PENDING'),waiting:sum(null,'PENDING'),done:counts.filter(c=>c.status==='DONE'&&c.kind!=='SAME').reduce((a,c)=>a+c.n,0),creating:sum(null,'CREATING')+sum(null,'READY')},
    reason:catalog.hold_reason||can.reason||null,automatic:can.automatic};
}

async function inbox(db,workspaceId){
  if(!await require('../db/schema-installed').has(db,catalogs))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const rows=(await db.query(`SELECT c.id,c.source_name,c.status,c.updated_at,s.name AS supplier_name,(SELECT count(*) FROM ${lines} l WHERE l.catalog_id=c.id AND l.status='PENDING')::int AS waiting
    FROM ${catalogs} c JOIN suppliers s ON s.workspace_id=c.workspace_id AND s.id=c.supplier_id WHERE c.workspace_id=$1 AND c.status IN ('COLUMNS','WAITING')
    ORDER BY c.updated_at,c.id LIMIT 20`,[workspaceId])).rows;
  return rows.map(r=>({kind:'catalog',importance:'Needs You',priority:45,title:'Supplier catalog from '+r.supplier_name+' needs you',
    happened:r.status==='COLUMNS'?'StockChief has a question about '+r.source_name+'.':r.waiting+(r.waiting===1?' line waits':' lines wait')+' for your decision in '+r.source_name+'.',
    why:'StockChief does not guess which products to create or link.',recommendation:'Review the product list and approve it.',
    href:path+'/'+encodeURIComponent(r.id),actionLabel:'Review the catalog',sourceId:'supplier-catalog:'+r.id,at:r.updated_at,createdAt:r.updated_at}));
}

// The agent reviews list.
async function review(db,ctx,{filter='',page:n=1}={}){
  const rows=(await db.query(`SELECT c.id,c.source_name "Catalog",s.name "Supplier",c.status,
    (SELECT count(*) FROM ${lines} l WHERE l.catalog_id=c.id AND l.status='PENDING')::int "Waiting",
    (SELECT count(*) FROM ${lines} l WHERE l.catalog_id=c.id AND l.status='DONE' AND l.kind<>'SAME')::int "Done"
    FROM ${catalogs} c JOIN suppliers s ON s.workspace_id=c.workspace_id AND s.id=c.supplier_id
    WHERE c.workspace_id=$1 AND ($2='' OR lower(c.source_name)=lower($2) OR lower(s.name)=lower($2)) ORDER BY c.created_at DESC,c.id LIMIT 101 OFFSET $3`,
  [ctx.workspaceId,filter,(Number(n)-1)*100])).rows;
  return {summary:'Each supplier catalog lists the new products, the products you already have and the lines waiting for you. Open one to approve or undo it.',
    rows:rows.slice(0,100).map(({id,status,...r})=>({...r,Stage:statusLabels[status],link:path+'/'+encodeURIComponent(id)})),more:rows.length>100};
}

module.exports={JOB,ACTION,kind,path,PACK,power,start,check,approve,run,afterImport,undo,cancel,list,page,inbox,review,classify,
  definition:{id:JOB,key:'supplier-catalogs',label:'Create products from a supplier catalog or price list',filterLabel:'Catalog file or supplier name',readPage:review}};
