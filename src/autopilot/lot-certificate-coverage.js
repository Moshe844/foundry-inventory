'use strict';

const evidence=require('./lot-certificate-evidence');
const policy=require('../commercial/agent-plan');
const time=require('../lib/business-time');
const currentDocument=`LEFT JOIN LATERAL (
  SELECT certificate.* FROM (
    SELECT l.id,l.expires_on,src.filename,l.linked_at AS recorded_at,NULL::text AS document_url
    FROM ${evidence.links} l JOIN ${evidence.sources} src ON src.workspace_id=l.workspace_id AND src.id=l.source_id
    WHERE l.workspace_id=lot.workspace_id AND l.lot_id=lot.id AND l.kind=r.kind AND l.state='LINKED'
    UNION ALL
    SELECT NULL::text,c.expires_on,NULL::text,c.recorded_at,c.document_url FROM stockchief_runtime.lot_certificates c
    WHERE c.workspace_id=lot.workspace_id AND c.lot_id=lot.id AND c.kind=r.kind
  ) certificate ORDER BY (certificate.expires_on IS NULL OR certificate.expires_on>=$3::date) DESC,
    certificate.recorded_at DESC,certificate.id DESC NULLS LAST LIMIT 1
) document ON true`;
const stock=`(
  EXISTS(SELECT 1 FROM lot_balances b WHERE b.workspace_id=lot.workspace_id AND b.lot_id=lot.id AND b.quantity>0)
  OR EXISTS(SELECT 1 FROM serial_units u WHERE u.workspace_id=lot.workspace_id AND u.lot_id=lot.id AND u.status='in_stock')
  OR EXISTS(SELECT 1 FROM stockchief_runtime.agent_direct_lots l
    JOIN stockchief_runtime.agent_direct_dispatch_lines line ON line.workspace_id=l.workspace_id AND line.id=l.dispatch_line_id
    JOIN stockchief_runtime.agent_direct_dispatches d ON d.workspace_id=line.workspace_id AND d.id=line.dispatch_id AND d.state='APPLIED'
    WHERE l.workspace_id=lot.workspace_id AND l.lot_id=lot.id)
  OR EXISTS(SELECT 1 FROM serial_units u JOIN stockchief_runtime.agent_direct_serial_units x ON x.workspace_id=u.workspace_id AND x.serial_unit_id=u.id
    JOIN stockchief_runtime.agent_direct_dispatch_lines line ON line.workspace_id=x.workspace_id AND line.id=x.dispatch_line_id
    JOIN stockchief_runtime.agent_direct_dispatches d ON d.workspace_id=line.workspace_id AND d.id=line.dispatch_id AND d.state='APPLIED'
    WHERE u.workspace_id=lot.workspace_id AND u.lot_id=lot.id)
)`;
const status="CASE WHEN document.recorded_at IS NULL THEN 'Missing' WHEN document.expires_on<$3::date THEN 'Expired' ELSE 'On file' END";
const base=`FROM ${evidence.requirements} r JOIN skus sku ON sku.workspace_id=r.workspace_id AND sku.id=r.sku_id
 JOIN lots lot ON lot.workspace_id=r.workspace_id AND lot.sku_id=r.sku_id ${currentDocument}
 WHERE r.workspace_id=$1`;

async function rows(db,ctx,{filter='',page=1,today}={}){
  await evidence.owner(db,ctx);
  today ||=await time.today(db,ctx.workspaceId);
  const result=(await db.query(`SELECT sku.code AS "SKU",lot.code AS "Lot",r.kind AS "Document",document.filename AS "Original",document.expires_on::text AS "Expires",${status} AS "Status"
    ${base} AND ($2='' OR lower(lot.code)=lower($2) OR lower(sku.code)=lower($2)) AND ${stock}
    ORDER BY (${status}='On file'),sku.code,lot.code,r.kind,lot.id LIMIT 101 OFFSET $4`,[ctx.workspaceId,filter,today,(page-1)*100])).rows;
  const pageRows=result.slice(0,100).map(row=>({...row,link:'/autopilot/lots?'+new URLSearchParams({sku:row.SKU,lot:row.Lot})}));
  return {rows:pageRows,more:result.length>100,summary:'Required certificates for stocked and recorded direct lots. Missing and expired originals appear first. Open a lot to inspect its sources or prepare a link.'};
}

async function forLot(db,ctx,lot){
  const today=await time.today(db,ctx.workspaceId);
  const coverage=(await db.query(`SELECT r.kind,document.id,document.filename,document.document_url,document.expires_on::text,${status} AS status
    ${base} AND lot.id=$2 ORDER BY r.kind`,[ctx.workspaceId,lot.id,today])).rows;
  const history=(await db.query(`SELECT l.id,l.kind,l.state,l.expires_on::text,l.automatic,l.linked_at,l.revoked_at,src.filename
    FROM ${evidence.links} l JOIN ${evidence.sources} src ON src.workspace_id=l.workspace_id AND src.id=l.source_id
    WHERE l.workspace_id=$1 AND l.lot_id=$2 ORDER BY l.created_at DESC,l.id LIMIT 51`,[ctx.workspaceId,lot.id])).rows;
  return {coverage,history:history.slice(0,50),more:history.length>50};
}

async function screen(db,ctx,input={}){
  await evidence.owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId);
  const allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,196,'draft');
  const automatic=allowed&&policy.permits(state.plan,196,'automatic');
  const page=Number(input.page||1);
  if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new (require('../domain/errors').ValidationError)('Choose a valid certificate evidence page.');
  const lot=input.sku&&input.lot?await require('./lot-controls').lookup(db,ctx,input):null;
  const selected=input.id?await evidence.draft(db,ctx,input.id):null;
  const original=input.sourceId?await evidence.load(db,ctx,input.sourceId):null;
  const list=(await db.query(`SELECT l.id,l.state,l.kind,l.expires_on::text,l.automatic,l.created_at,sku.code AS sku,lot.code AS lot,src.filename
    FROM ${evidence.links} l JOIN ${evidence.sources} src ON src.workspace_id=l.workspace_id AND src.id=l.source_id
    JOIN lots lot ON lot.workspace_id=l.workspace_id AND lot.id=l.lot_id JOIN skus sku ON sku.workspace_id=lot.workspace_id AND sku.id=lot.sku_id
    WHERE l.workspace_id=$1 AND ($3::text IS NULL OR l.lot_id=$3) ORDER BY (l.state='DRAFT') DESC,l.created_at DESC,l.id LIMIT 51 OFFSET $2`,[ctx.workspaceId,(page-1)*50,lot?.id||null])).rows;
  const held=(await db.query(`SELECT id,filename,review_reason FROM ${evidence.sources} WHERE workspace_id=$1 AND review_reason IS NOT NULL AND dismissed_at IS NULL
    ORDER BY created_at DESC,id LIMIT 51 OFFSET $2`,[ctx.workspaceId,(page-1)*50])).rows;
  const rules=(await db.query(`SELECT r.id,r.mode,r.enabled,r.revision,r.kinds,sku.code AS sku,s.name AS supplier,c.display_name AS mailbox
    FROM ${evidence.rules} r JOIN skus sku ON sku.workspace_id=r.workspace_id AND sku.id=r.sku_id
    JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id JOIN workspace_connectors c ON c.workspace_id=r.workspace_id AND c.id=r.connector_id
    WHERE r.workspace_id=$1 AND r.enabled AND ($2::text IS NULL OR r.sku_id=$2) ORDER BY sku.code,s.name,r.id LIMIT 51 OFFSET $3`,[ctx.workspaceId,lot?.sku_id||null,(page-1)*50])).rows;
  const suppliers=allowed&&lot?(await db.query(`SELECT s.id,s.name FROM supplier_items si JOIN suppliers s ON s.workspace_id=si.workspace_id AND s.id=si.supplier_id
    WHERE si.workspace_id=$1 AND si.sku_id=$2 AND si.is_active=1 AND s.status='active' AND btrim(s.email)<>'' ORDER BY s.name,s.id`,[ctx.workspaceId,lot.sku_id])).rows:[];
  const mailboxes=allowed&&lot?(await db.query(`SELECT id,display_name FROM workspace_connectors WHERE workspace_id=$1 AND status='connected' AND paused_at IS NULL
    AND provider_type IN('gmail','microsoft365') AND provider_account_id IS NOT NULL ORDER BY display_name,id`,[ctx.workspaceId])).rows:[];
  const stop=allowed?await policy.stopped(db,ctx.workspaceId,state,evidence.action,false):null;
  return {allowed,automatic,stop,lot,selected,original:original&&{id:original.id,filename:original.filename,reason:original.review_reason},
    list:list.slice(0,50),held:held.slice(0,50),rules:rules.slice(0,50),suppliers,mailboxes,page,more:[list,held,rules].some(r=>r.length>50)};
}

async function inbox(db,workspaceId,actorId){
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,196,'draft'))return [];
  const ctx={workspaceId,actorId};
  try{await evidence.owner(db,ctx);}catch(error){if(error.code==='forbidden')return [];throw error;}
  const today=await time.today(db,workspaceId);
  const result=(await db.query(`SELECT
    EXISTS(SELECT 1 FROM ${evidence.links} WHERE workspace_id=$1 AND state='DRAFT') OR
    EXISTS(SELECT 1 FROM ${evidence.sources} WHERE workspace_id=$1 AND review_reason IS NOT NULL AND dismissed_at IS NULL) AS pending,
    EXISTS(SELECT 1 ${base} AND $2::text='' AND (${status})<>'On file' AND ${stock}) AS gap`,[workspaceId,'',today])).rows[0];
  const notices=[];
  if(result.pending)notices.push({kind:'stock',importance:'Needs You',priority:52,title:'Lot certificates need review',happened:'Original documents or prepared lot links are ready to check.',why:'Confirm the exact lot and printed expiry against each original.',actionLabel:'Review certificate originals',href:'/autopilot/lot-certificates',sourceId:'lot-certificate-reviews'});
  if(result.gap)notices.push({kind:'stock',importance:'Needs You',priority:62,title:'Required lot certificates are missing or expired',happened:'At least one recorded lot lacks current required evidence.',why:'Open certificate coverage to find the exact SKU, lot and document type.',actionLabel:'Check lot certificate coverage',href:'/autopilot/reviews/lot-documents',sourceId:'lot-certificate-coverage'});
  return notices;
}

module.exports={rows,forLot,screen,inbox};
