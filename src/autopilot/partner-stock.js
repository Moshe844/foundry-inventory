'use strict';

// Job 123: stock held by fulfilment partners (3PLs) and consignment partners.
//
// A partner location is one of your StockChief locations that a partner holds:
// a 3PL warehouse, or the partner site of a consignment agreement. Its
// partner's own counts arrive on their own:
//  - ShipBob: each saved ShipBob reading (the job 186 connection and its
//    hourly reads) is compared as soon as it is saved;
//  - any other partner: a private feed link their system posts JSON or CSV to,
//    or a CSV file the owner uploads from the partner's export.
// Each count is kept exactly as the partner reported it, with its time, and
// compared with what StockChief's own records held at that location at that
// moment (today's balance less any later stock moves there). A difference
// larger than the owner's tolerance is flagged on the partner page, the
// product page and in Needs you, until a later count agrees or the owner
// explains it.
//
// Partner counts never change stock, ownership or value: correcting stock is
// a count or adjustment a person makes. Planning uses the lower of
// StockChief's records and a partner's count, and never adds a partner's
// count to stock you own. Reading and comparing only record, so they carry on
// through pause, Watch only and the first 14 days.
const {createHash,randomBytes}=require('node:crypto');
const policy=require('../commercial/agent-plan');
const installed=require('../db/schema-installed');
const exact=require('../domain/exact-quantity');
const {ValidationError,NotFoundError}=require('../domain/errors');
const {newId}=require('../lib/util');

const JOB=123,path='/autopilot/partner-stock',feedPath='/partner-stock/feed',MAX_LINES=5000;
const partners='stockchief_runtime.agent_partner_locations',reports='stockchief_runtime.agent_partner_stock_reports';
const positions='stockchief_runtime.agent_partner_stock_positions';
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
const audit=(c,ctx,action,reference,after={})=>require('../operations/postgres-security-audit').record(c,ctx,{action,reference,after});
const abs=value=>String(value).replace(/^-/,'');
const atMost=(a,b)=>{const d=exact.subtract(a,b);return d==='0'||d.startsWith('-');};
const kinds={three_pl:'Fulfilment partner (3PL)',consignment:'Consignment partner'};

async function permitted(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  return policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'automatic');
}
async function ownerAccess(db,ctx){
  await require('./job-reviews').ownerState(db,ctx);
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
  return policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'automatic');
}

// What StockChief's records held at a location (and the places inside it) at
// a moment: today's balance less every later stock move there.
async function expectedAt(c,workspaceId,locationId,skuIds,observedAt){
  if(!skuIds.length)return new Map();
  const rows=(await c.query(`WITH RECURSIVE scope AS (SELECT id FROM locations WHERE workspace_id=$1 AND id=$2
      UNION SELECT l.id FROM locations l JOIN scope s ON l.parent_location_id=s.id WHERE l.workspace_id=$1)
    SELECT s.id sku_id,(coalesce((SELECT sum(b.on_hand) FROM balances b WHERE b.workspace_id=$1 AND b.sku_id=s.id AND b.location_id IN (SELECT id FROM scope)),0)
      -coalesce((SELECT sum(m.quantity_delta) FROM movements m WHERE m.workspace_id=$1 AND m.sku_id=s.id AND m.location_id IN (SELECT id FROM scope)
        AND m.occurred_at::timestamptz>$4::timestamptz),0))::text expected
    FROM skus s WHERE s.workspace_id=$1 AND s.id=ANY($3::text[])`,[workspaceId,locationId,skuIds,observedAt])).rows;
  return new Map(rows.map(r=>[r.sku_id,exact.canonical(r.expected,{signed:true})]));
}
async function heldSkus(c,workspaceId,locationId){
  return (await c.query(`WITH RECURSIVE scope AS (SELECT id FROM locations WHERE workspace_id=$1 AND id=$2
      UNION SELECT l.id FROM locations l JOIN scope s ON l.parent_location_id=s.id WHERE l.workspace_id=$1)
    SELECT DISTINCT b.sku_id,s.code FROM balances b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id
    WHERE b.workspace_id=$1 AND b.location_id IN (SELECT id FROM scope) AND b.on_hand<>0 LIMIT ${MAX_LINES+1}`,[workspaceId,locationId])).rows;
}

// Matches every reported line to exactly one StockChief SKU. Anything that
// does not match stops the whole report: nothing is guessed or half saved.
async function resolve(c,workspaceId,raw){
  if(!Array.isArray(raw)||!raw.length)throw new ValidationError('Send at least one product count.');
  if(raw.length>MAX_LINES)throw new ValidationError('Send at most '+MAX_LINES+' product counts in one report.');
  const codes=raw.map(r=>String(r?.sku??'').trim());
  if(codes.some(code=>!code||code.length>120))throw new ValidationError('Every line needs the product’s exact StockChief SKU code.');
  const lower=codes.map(code=>code.toLowerCase());
  if(new Set(lower).size!==lower.length)throw new ValidationError('A SKU appears more than once. Send one count for each SKU.');
  const found=(await c.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND lower(code)=ANY($2::text[])',[workspaceId,lower])).rows;
  const byCode=new Map();for(const row of found)byCode.set(row.code.toLowerCase(),byCode.has(row.code.toLowerCase())?null:row);
  const unknown=codes.filter(code=>!byCode.get(code.toLowerCase()));
  if(unknown.length)throw new ValidationError('These SKUs do not match one product in StockChief: '+unknown.slice(0,10).join(', ')+
    (unknown.length>10?' and '+(unknown.length-10)+' more':'')+'. Nothing was saved.');
  return raw.map((r,i)=>{
    const sku=byCode.get(lower[i]),quantity=String(r.quantity??'').trim(),available=r.available==null?'':String(r.available).trim();
    return {skuId:sku.id,code:sku.code,reported:exact.canonical(quantity,{label:'Quantity for '+sku.code}),
      available:available===''?null:exact.canonical(available,{label:'Available for '+sku.code})};
  });
}
function instant(value){
  const text=String(value||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(text)||!Number.isFinite(Date.parse(text)))
    throw new ValidationError('Give the time the partner counted, with its time zone, for example 2026-11-13T09:00:00Z.');
  if(Date.parse(text)>Date.now()+5*60000)throw new ValidationError('The count time is in the future.');
  return new Date(text).toISOString();
}
async function localInstant(db,workspaceId,value){
  const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(String(value||'').trim());
  if(!match)throw new ValidationError('Enter the date and time the partner counted.');
  const {timeZone}=await require('../lib/business-time').forWorkspace(db,workspaceId);
  const at=require('../lib/business-time').wall(match[1],Number(match[2]),Number(match[3]),timeZone);
  if(!at)throw new ValidationError('That time does not exist in the business time zone.');
  if(at.getTime()>Date.now()+5*60000)throw new ValidationError('The count time is in the future.');
  return at.toISOString();
}

// One partner count, saved once. Replaying the same reference with the same
// counts changes nothing; the same reference with other counts is refused.
async function save(c,workspaceId,partner,{source,requestKey,observedAt,complete=false,lines,actorId}){
  const contentHash=sha({observedAt,complete,lines:lines.map(l=>[l.skuId,l.reported,l.available])});
  const prior=(await c.query(`SELECT id,content_hash FROM ${reports} WHERE workspace_id=$1 AND location_id=$2 AND request_key=$3`,
    [workspaceId,partner.location_id,requestKey])).rows[0];
  if(prior){
    if(prior.content_hash!==contentHash)throw new ValidationError('This report reference was already used for different counts. Send it with a new reference.');
    return {replayed:true,reportId:prior.id};
  }
  let all=lines;
  if(complete){
    const listed=new Set(lines.map(l=>l.skuId)),held=(await heldSkus(c,workspaceId,partner.location_id)).filter(r=>!listed.has(r.sku_id));
    if(held.length+lines.length>MAX_LINES)throw new ValidationError('This location holds too many products for one complete report.');
    all=lines.concat(held.map(r=>({skuId:r.sku_id,code:r.code,reported:'0',available:null,missing:true})));
  }
  const expected=await expectedAt(c,workspaceId,partner.location_id,all.map(l=>l.skuId),observedAt),id=newId('partner-report');
  const saved=all.map(l=>({...l,expected:expected.get(l.skuId)||'0'}));
  await require('../commercial/storage-capacity').reserve(scoped(c),workspaceId,'partner-stock-report:'+id,Buffer.byteLength(JSON.stringify(saved))*3+4096,{finished:true});
  await c.query(`INSERT INTO ${reports}(workspace_id,id,location_id,source,request_key,content_hash,observed_at,complete,lines,submitted_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,[workspaceId,id,partner.location_id,source,requestKey,contentHash,observedAt,complete,JSON.stringify(saved),actorId]);
  let differences=0;
  for(const l of saved){
    const gap=abs(exact.subtract(l.reported,l.expected)),status=atMost(gap,String(partner.tolerance))?'AGREES':'DIFFERS';
    const written=await c.query(`INSERT INTO ${positions}(workspace_id,location_id,sku_id,report_id,reported,available,expected,observed_at,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,location_id,sku_id) DO UPDATE SET report_id=EXCLUDED.report_id,reported=EXCLUDED.reported,
      available=EXCLUDED.available,expected=EXCLUDED.expected,observed_at=EXCLUDED.observed_at,compared_at=clock_timestamp(),status=EXCLUDED.status,
      explained_by=NULL,explained_note=NULL,explained_at=NULL WHERE agent_partner_stock_positions.observed_at<=EXCLUDED.observed_at`,
    [workspaceId,partner.location_id,l.skuId,id,l.reported,l.available,l.expected,observedAt,status]);
    if(written.rowCount&&status==='DIFFERS')differences++;
  }
  await audit(c,{workspaceId,actorId},'Partner stock count recorded',partner.location_id,{reportId:id,source,lines:saved.length,differences,observedAt});
  return {reportId:id,lines:saved.length,differences};
}

async function partnerFor(c,workspaceId,locationId,lock=false){
  const row=(await c.query(`SELECT p.*,p.tolerance::text tolerance,l.name location_name FROM ${partners} p JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
    WHERE p.workspace_id=$1 AND p.location_id=$2${lock?' FOR UPDATE OF p':''}`,[workspaceId,locationId])).rows[0];
  if(!row)throw new NotFoundError('That partner location is not set up in this inventory.');
  return row;
}

// ---- Setting up a partner location ----
async function savePartner(db,ctx,input){
  return db.transaction(async c=>{
    await ownerAccess(scoped(c),ctx);
    const locationId=String(input.locationId||''),prior=(await c.query(`SELECT revision FROM ${partners} WHERE workspace_id=$1 AND location_id=$2 FOR UPDATE`,
      [ctx.workspaceId,locationId])).rows[0];
    if(Number(input.revision||0)!==(prior?.revision||0))throw new ValidationError('Reload the current partner settings before saving.');
    if(input.remove==='yes'){
      if(!prior||input.confirmed!=='yes')throw new ValidationError('Confirm removing this partner location.');
      await c.query(`DELETE FROM ${partners} WHERE workspace_id=$1 AND location_id=$2`,[ctx.workspaceId,locationId]);
      await audit(c,ctx,'Partner stock location removed',locationId);
      return {removed:true};
    }
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that this partner holds the stock at this location.');
    const kind=input.kind,source=input.source;
    if(!kinds[kind]||!['shipbob','feed'].includes(source))throw new ValidationError('Choose whether this is a 3PL or a consignment partner, and how its counts arrive.');
    const partner=require('../lib/util').requireText(input.partner,'Partner name',{max:150});
    const tolerance=exact.canonical(String(input.tolerance||'0').trim(),{label:'Allowed difference'});
    const place=(await c.query(`SELECT l.id,l.custody_agreement_id,a.kind agreement_kind,a.external_location_id FROM locations l
      LEFT JOIN custody_agreements a ON a.workspace_id=l.workspace_id AND a.id=l.custody_agreement_id
      WHERE l.workspace_id=$1 AND l.id=$2 AND l.is_active=1 FOR SHARE OF l`,[ctx.workspaceId,locationId])).rows[0];
    if(!place)throw new ValidationError('Choose an active location in this inventory.');
    if(kind==='three_pl'&&place.custody_agreement_id)throw new ValidationError('A 3PL holds your own stock. Choose one of your warehouse locations, not a consignment location.');
    if(kind==='consignment'&&(!['CONSIGN_OUT','CONSIGN_IN'].includes(place.agreement_kind)||place.external_location_id!==place.id))
      throw new ValidationError('Choose the partner location of a consignment agreement.');
    if(source==='shipbob'){
      if(kind!=='three_pl')throw new ValidationError('ShipBob counts belong to a 3PL location.');
      const linked=(await c.query("SELECT 1 FROM workspace_connectors WHERE workspace_id=$1 AND connector_key='agent-shipbob-sandbox' AND status='connected' AND paused_at IS NULL",[ctx.workspaceId])).rowCount;
      if(!linked)throw new ValidationError('Connect ShipBob first.');
      if((await c.query(`SELECT 1 FROM ${partners} WHERE workspace_id=$1 AND source='shipbob' AND location_id<>$2`,[ctx.workspaceId,locationId])).rowCount)
        throw new ValidationError('ShipBob counts already go to another location. Change that location first.');
    }
    await c.query(`INSERT INTO ${partners}(workspace_id,location_id,kind,source,partner,tolerance,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(workspace_id,location_id) DO UPDATE SET kind=EXCLUDED.kind,source=EXCLUDED.source,partner=EXCLUDED.partner,tolerance=EXCLUDED.tolerance,
      token_hash=CASE WHEN EXCLUDED.source='feed' THEN agent_partner_locations.token_hash END,
      token_issued_at=CASE WHEN EXCLUDED.source='feed' THEN agent_partner_locations.token_issued_at END,revision=agent_partner_locations.revision+1`,
    [ctx.workspaceId,locationId,kind,source,partner,tolerance,ctx.actorId]);
    await audit(c,ctx,'Partner stock location saved',locationId,{kind,source,partner,tolerance});
    if(source==='shipbob')await compareShipBob(c,ctx.workspaceId);
    return {saved:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function issueFeed(db,ctx,locationId,input){
  if(input.confirmed!=='yes')throw new ValidationError('Confirm replacing the partner’s private feed link.');
  return db.transaction(async c=>{
    await ownerAccess(scoped(c),ctx);
    const partner=await partnerFor(c,ctx.workspaceId,locationId,true);
    if(partner.source!=='feed')throw new ValidationError('This partner’s counts come from ShipBob.');
    const token=randomBytes(32).toString('base64url');
    await c.query(`UPDATE ${partners} SET token_hash=$3,token_issued_at=now() WHERE workspace_id=$1 AND location_id=$2`,[ctx.workspaceId,locationId,sha(token)]);
    await audit(c,ctx,'Partner stock feed link issued',locationId);
    return feedPath+'/'+token;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function stopFeed(db,ctx,locationId){
  return db.transaction(async c=>{
    await require('./job-reviews').ownerState(c,ctx);
    await partnerFor(c,ctx.workspaceId,locationId,true);
    await c.query(`UPDATE ${partners} SET token_hash=NULL,token_issued_at=NULL WHERE workspace_id=$1 AND location_id=$2`,[ctx.workspaceId,locationId]);
    await audit(c,ctx,'Partner stock feed link revoked',locationId);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// ---- Counts arriving ----
// The owner uploads the partner's own export (CSV or a spreadsheet).
async function upload(db,ctx,locationId,file,input){
  if(!file?.buffer?.length)throw new ValidationError('Choose the partner’s stock file.');
  if(input.confirmed!=='yes')throw new ValidationError('Confirm that this file is the partner’s own count.');
  const observedAt=await localInstant(db,ctx.workspaceId,input.observedAt);
  const parsed=require('../imports/parser').parse({buffer:file.buffer,filename:file.filename}),sheet=parsed.sheets[parsed.primarySheet];
  const find=pattern=>sheet.columns.find(column=>pattern.test(column.name.trim()));
  const skuColumn=find(/^(sku|sku code|item code|product code|code)$/i),quantityColumn=find(/^(quantity|qty|on hand|on_hand|units|count|counted)$/i),
    availableColumn=find(/^(available|fulfillable|sellable)$/i);
  if(sheet.headerless||!skuColumn||!quantityColumn)throw new ValidationError('The file needs a SKU column and a quantity column with headings.');
  const raw=sheet.rows.map(row=>({sku:row.cells[skuColumn.index],quantity:row.cells[quantityColumn.index],available:availableColumn?row.cells[availableColumn.index]:null}));
  return db.transaction(async c=>{
    await ownerAccess(scoped(c),ctx);
    const partner=await partnerFor(c,ctx.workspaceId,locationId,true);
    if(partner.source!=='feed')throw new ValidationError('This partner’s counts come from ShipBob.');
    return save(c,ctx.workspaceId,partner,{source:'csv',requestKey:'csv:'+sha(file.buffer),observedAt,complete:input.complete==='yes',
      lines:await resolve(c,ctx.workspaceId,raw),actorId:ctx.actorId});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// A partner's system posts its counts to the private feed link: JSON
// {reference, countedAt, complete, lines:[{sku, quantity, available}]} or CSV
// text with a reference and countedAt in the query.
async function feed(db,token,{body,query={},contentType=''}){
  if(!/^[A-Za-z0-9_-]{43}$/.test(String(token||'')))throw new NotFoundError('This partner stock link is inactive.');
  let input=body;
  if(/csv|text\/plain/i.test(contentType)){
    const sheet=require('../imports/parser').parseText(String(body||'')).sheets[0],table=require('../imports/parser').tabulate(sheet.grid);
    const col=pattern=>table.columns.find(column=>pattern.test(column.name.trim()));
    const skuColumn=col(/^(sku|sku code|item code|product code|code)$/i),quantityColumn=col(/^(quantity|qty|on hand|on_hand|units|count|counted)$/i),availableColumn=col(/^(available|fulfillable|sellable)$/i);
    if(table.headerless||!skuColumn||!quantityColumn)throw new ValidationError('The file needs a SKU column and a quantity column with headings.');
    input={reference:query.reference,countedAt:query.countedAt,complete:query.complete,
      lines:table.rows.map(row=>({sku:row.cells[skuColumn.index],quantity:row.cells[quantityColumn.index],available:availableColumn?row.cells[availableColumn.index]:null}))};
  }
  if(!input||typeof input!=='object')throw new ValidationError('Send the counts as JSON or CSV.');
  const reference=String(input.reference||'').trim();
  if(!/^[A-Za-z0-9._:-]{1,120}$/.test(reference))throw new ValidationError('Give each report a reference of up to 120 letters, digits, dots, colons or dashes.');
  const observedAt=instant(input.countedAt),complete=input.complete===true||input.complete==='true';
  return db.transaction(async c=>{
    const row=(await c.query(`SELECT p.*,p.tolerance::text tolerance FROM ${partners} p JOIN workspaces w ON w.id=p.workspace_id AND w.deletion_requested_at IS NULL
      JOIN users u ON u.id=p.created_by AND u.workspace_id=p.workspace_id AND u.role='owner' AND u.account_id=w.owner_account_id
      WHERE p.token_hash=$1 AND p.source='feed' FOR SHARE OF p`,[sha(token)])).rows[0];
    if(!row||!await permitted(c,row.workspace_id))throw new NotFoundError('This partner stock link is inactive.');
    const result=await save(c,row.workspace_id,row,{source:'api',requestKey:'api:'+reference,observedAt,complete,
      lines:await resolve(c,row.workspace_id,input.lines),actorId:row.created_by});
    return {reference,saved:!result.replayed,replayed:Boolean(result.replayed),lines:result.lines??null,differences:result.differences??null};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Each saved ShipBob reading, compared at the ShipBob partner location. It
// runs inside the transaction that saves the reading, and quietly does
// nothing when no location is set up or the plan does not include the job.
async function compareShipBob(c,workspaceId,skuId=null,{quiet=false}={}){
  if(!await installed.has(c,partners)||!await permitted(c,workspaceId))return {compared:0};
  if(quiet){
    // Saving the reading itself never depends on the comparison.
    await c.query('SAVEPOINT partner_stock_compare');
    try{const result=await compareShipBob(c,workspaceId,skuId);await c.query('RELEASE SAVEPOINT partner_stock_compare');return result;}
    catch(error){await c.query('ROLLBACK TO SAVEPOINT partner_stock_compare');if(['40001','40P01'].includes(error.code))throw error;return {compared:0,problem:error.message};}
  }
  const partner=(await c.query(`SELECT p.*,p.tolerance::text tolerance FROM ${partners} p WHERE p.workspace_id=$1 AND p.source='shipbob'`,[workspaceId])).rows[0];
  if(!partner)return {compared:0};
  const readings=(await c.query(`SELECT b.sku_id,s.code,b.on_hand::text,b.fulfillable::text,b.observed_at FROM stockchief_runtime.shipbob_sandbox_stock b
    JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id WHERE b.workspace_id=$1 AND ($2::text IS NULL OR b.sku_id=$2) ORDER BY s.code LIMIT ${MAX_LINES}`,
  [workspaceId,skuId])).rows;
  let compared=0;
  for(const r of readings){
    const observedAt=new Date(r.observed_at).toISOString();
    const saved=await save(c,workspaceId,partner,{source:'shipbob',requestKey:'shipbob:'+r.sku_id+':'+observedAt,observedAt,
      lines:[{skuId:r.sku_id,code:r.code,reported:r.on_hand,available:r.fulfillable}],actorId:partner.created_by});
    if(!saved.replayed)compared++;
  }
  return {compared};
}

// The owner checked a difference and records why it stands.
async function explain(db,ctx,locationId,input){
  return db.transaction(async c=>{
    await ownerAccess(scoped(c),ctx);
    const note=String(input.note||'').trim();
    if(input.confirmed!=='yes'||!note||note.length>1000)throw new ValidationError('Write what you checked, then confirm. Stock does not change.');
    const row=(await c.query(`SELECT status,report_id FROM ${positions} WHERE workspace_id=$1 AND location_id=$2 AND sku_id=$3 FOR UPDATE`,
      [ctx.workspaceId,locationId,input.skuId])).rows[0];
    if(row?.status==='EXPLAINED'&&row.report_id===input.reportId)return {replayed:true};
    if(!row||row.status!=='DIFFERS'||row.report_id!==input.reportId)throw new ValidationError('A newer partner count arrived. Review it before explaining the difference.');
    await c.query(`UPDATE ${positions} SET status='EXPLAINED',explained_by=$4,explained_note=$5,explained_at=now() WHERE workspace_id=$1 AND location_id=$2 AND sku_id=$3`,
      [ctx.workspaceId,locationId,input.skuId,ctx.actorId,note]);
    await audit(c,ctx,'Partner stock difference explained',locationId,{skuId:input.skuId,reportId:input.reportId,note});
    return {explained:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// ---- What people see ----
async function page(db,ctx){
  await ownerAccess(db,ctx);
  const [list,differences,recent,places,shipbob]=await Promise.all([
    db.query(`SELECT p.location_id,p.kind,p.source,p.partner,p.tolerance::text tolerance,p.revision,p.token_issued_at,l.name location_name,
        (SELECT count(*) FROM ${positions} x WHERE x.workspace_id=p.workspace_id AND x.location_id=p.location_id AND x.status='DIFFERS')::int differences,
        (SELECT max(r.observed_at) FROM ${reports} r WHERE r.workspace_id=p.workspace_id AND r.location_id=p.location_id) last_count
      FROM ${partners} p JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id WHERE p.workspace_id=$1 ORDER BY l.name,p.location_id`,[ctx.workspaceId]),
    db.query(`SELECT x.location_id,x.sku_id,x.report_id,x.reported::text,x.available::text,x.expected::text,x.observed_at,x.status,x.explained_note,
        s.code,i.name item_name,i.id item_id,l.name location_name,p.partner
      FROM ${positions} x JOIN ${partners} p ON p.workspace_id=x.workspace_id AND p.location_id=x.location_id
      JOIN skus s ON s.workspace_id=x.workspace_id AND s.id=x.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      JOIN locations l ON l.workspace_id=x.workspace_id AND l.id=x.location_id
      WHERE x.workspace_id=$1 AND x.status IN ('DIFFERS','EXPLAINED') ORDER BY x.status DESC,x.observed_at DESC,s.code LIMIT 101`,[ctx.workspaceId]),
    db.query(`SELECT r.id,r.location_id,r.source,r.observed_at,r.received_at,jsonb_array_length(r.lines)::int lines,l.name location_name
      FROM ${reports} r JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id WHERE r.workspace_id=$1 ORDER BY r.received_at DESC,r.id DESC LIMIT 10`,[ctx.workspaceId]),
    db.query(`SELECT l.id,l.name,a.kind agreement_kind,a.agreement_number FROM locations l
      LEFT JOIN custody_agreements a ON a.workspace_id=l.workspace_id AND a.id=l.custody_agreement_id
      WHERE l.workspace_id=$1 AND l.is_active=1 AND NOT EXISTS(SELECT 1 FROM ${partners} p WHERE p.workspace_id=l.workspace_id AND p.location_id=l.id)
        AND ((l.custody_agreement_id IS NULL AND l.kind IN ('warehouse','store','stockroom','other')) OR (a.kind IN ('CONSIGN_OUT','CONSIGN_IN') AND a.external_location_id=l.id))
      ORDER BY l.name,l.id LIMIT 200`,[ctx.workspaceId]),
    db.query("SELECT 1 FROM workspace_connectors WHERE workspace_id=$1 AND connector_key='agent-shipbob-sandbox' AND status='connected' AND paused_at IS NULL",[ctx.workspaceId])
  ]);
  const {timeZone}=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId),clock=new Intl.DateTimeFormat('en-US',{timeZone,dateStyle:'medium',timeStyle:'short'});
  const when=value=>value?clock.format(new Date(value)):null;
  return {partners:list.rows.map(r=>({...r,kindLabel:kinds[r.kind],lastCount:when(r.last_count)})),
    differences:differences.rows.slice(0,100).map(r=>({...r,observed:when(r.observed_at),gap:exact.subtract(r.reported,r.expected)})),moreDifferences:differences.rows.length>100,
    reports:recent.rows.map(r=>({...r,observed:when(r.observed_at)})),places:places.rows,shipbobConnected:shipbob.rowCount>0,kinds,feedPath};
}

// The product page: partner counts beside the product's own stock.
async function forItem(db,ctx,skuIds){
  if(!skuIds.length||!await installed.has(db,positions))return [];
  if(!await permitted(db,ctx.workspaceId))return [];
  const rows=(await db.query(`SELECT x.sku_id,s.code,x.reported::text,x.available::text,x.expected::text,x.observed_at,x.status,l.name location_name,p.partner,p.kind
    FROM ${positions} x JOIN ${partners} p ON p.workspace_id=x.workspace_id AND p.location_id=x.location_id
    JOIN skus s ON s.workspace_id=x.workspace_id AND s.id=x.sku_id JOIN locations l ON l.workspace_id=x.workspace_id AND l.id=x.location_id
    WHERE x.workspace_id=$1 AND x.sku_id=ANY($2::text[]) ORDER BY l.name,s.code LIMIT 100`,[ctx.workspaceId,skuIds])).rows;
  const {timeZone}=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId),clock=new Intl.DateTimeFormat('en-US',{timeZone,dateStyle:'medium',timeStyle:'short'});
  return rows.map(r=>({...r,kindLabel:kinds[r.kind],observed:clock.format(new Date(r.observed_at))}));
}

// Planning: a partner that counted fewer units than StockChief records lowers
// the stock a plan may count on there. A partner count above the records is
// never added: it is not stock StockChief can show you own.
async function planningShortfalls(db,workspaceId,skuIds,locationIds){
  const result=new Map();
  if(!skuIds.length||!locationIds.length||!await installed.has(db,positions))return result;
  if(!await permitted(db,workspaceId))return result;
  const rows=(await db.query(`SELECT x.sku_id,x.reported::text,x.expected::text,p.partner,l.name location_name FROM ${positions} x
    JOIN ${partners} p ON p.workspace_id=x.workspace_id AND p.location_id=x.location_id JOIN locations l ON l.workspace_id=x.workspace_id AND l.id=x.location_id
    WHERE x.workspace_id=$1 AND x.sku_id=ANY($2::text[]) AND x.location_id=ANY($3::text[]) AND x.status='DIFFERS' AND x.reported<x.expected`,
  [workspaceId,skuIds,locationIds])).rows;
  for(const r of rows){
    const current=result.get(r.sku_id)||{units:'0',notes:[]};
    current.units=exact.add(current.units,exact.subtract(r.expected,r.reported));
    current.notes.push(r.partner+' counted '+exact.canonical(r.reported)+' at '+r.location_name+' where StockChief expected '+exact.canonical(r.expected,{signed:true}));
    result.set(r.sku_id,current);
  }
  return result;
}

async function inbox(db,workspaceId){
  if(!await installed.has(db,positions)||!await permitted(db,workspaceId))return [];
  const rows=(await db.query(`SELECT x.location_id,x.sku_id,x.reported::text,x.expected::text,x.observed_at,s.code,l.name location_name,p.partner
    FROM ${positions} x JOIN ${partners} p ON p.workspace_id=x.workspace_id AND p.location_id=x.location_id
    JOIN skus s ON s.workspace_id=x.workspace_id AND s.id=x.sku_id JOIN locations l ON l.workspace_id=x.workspace_id AND l.id=x.location_id
    WHERE x.workspace_id=$1 AND x.status='DIFFERS' ORDER BY x.observed_at DESC,s.code LIMIT 25`,[workspaceId])).rows;
  return rows.map(r=>({kind:'inventory',importance:'Needs You',priority:72,title:r.partner+' counted a different amount of '+r.code,
    happened:r.partner+' counted '+exact.canonical(r.reported)+' at '+r.location_name+'. StockChief’s records showed '+exact.canonical(r.expected,{signed:true})+' at that time.',
    why:'Partner counts are compared with your records. Stock does not change on its own.',
    recommendation:'Check with the partner. If they are right, count or adjust the stock on the product page; otherwise note why the records stand.',
    href:path+'#differences',actionLabel:'Review the difference',sourceId:'partner-stock:'+r.location_id+':'+r.sku_id,at:r.observed_at,createdAt:r.observed_at}));
}

module.exports={JOB,path,feedPath,savePartner,issueFeed,stopFeed,upload,feed,compareShipBob,explain,page,forItem,planningShortfalls,inbox};
