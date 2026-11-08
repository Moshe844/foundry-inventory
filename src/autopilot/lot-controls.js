'use strict';

const policy=require('../commercial/agent-plan');
const {ValidationError,NotFoundError}=require('../domain/errors');
const {ownerState}=require('./job-reviews');
const {newId}=require('../lib/util');

async function lookup(db,ctx,input,lock=false){
  const matches=await db.query(`SELECT l.*,s.code AS sku FROM lots l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    WHERE l.workspace_id=$1 AND lower(s.code)=lower($2) AND l.code=$3 `+(lock?'FOR UPDATE OF l':''),[ctx.workspaceId,String(input.sku||'').trim(),String(input.lot||'').trim()]);
  if(matches.rowCount!==1) throw new NotFoundError('Enter the exact item code and lot number for this inventory.');
  return matches.rows[0];
}

async function details(db,ctx,input){
  const state=await ownerState(db,ctx);
  policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,193,'suggest');
  const lot=await lookup(db,ctx,input);
  const history=(await db.query('SELECT e.held,e.reason,e.occurred_at,u.name FROM stockchief_runtime.lot_recall_events e JOIN users u ON u.id=e.actor_id WHERE e.workspace_id=$1 AND e.lot_id=$2 ORDER BY e.revision DESC',[ctx.workspaceId,lot.id])).rows;
  const certificates=policy.permits(state.plan,196,'draft')?(await db.query(`SELECT r.kind,c.document_url,c.expires_on::text FROM stockchief_runtime.lot_certificate_requirements r
    LEFT JOIN stockchief_runtime.lot_certificates c ON c.workspace_id=r.workspace_id AND c.lot_id=$3 AND c.kind=r.kind
    WHERE r.workspace_id=$1 AND r.sku_id=$2 ORDER BY r.kind`,[ctx.workspaceId,lot.sku_id,lot.id])).rows:[];
  return {lot,history,certificates,canRecall:policy.permits(state.plan,194,'draft'),canCertify:policy.permits(state.plan,196,'draft')};
}

async function recall(db,ctx,input){
  return db.transaction(async c=>{
    const state=await ownerState(c,ctx),lot=await lookup(c,ctx,input,true),reason=String(input.reason||'').trim();
    if(!['hold','release'].includes(input.action)||reason.length<3||reason.length>1000)throw new ValidationError('Choose a recall decision and record its reason.');
    const held=input.action==='hold';
    if(held || !lot.recalled_at)policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,194,'draft');
    else if(!state.plan)throw new ValidationError('An active plan is required to release stock.');
    const revision=Number(input.revision);
    if(!Number.isSafeInteger(revision)||String(revision)!==String(input.revision)||revision!==lot.recall_revision)
      throw new ValidationError('The recall changed. Open this lot again before deciding.');
    if(Boolean(lot.recalled_at)===held)throw new ValidationError('The lot already has this recall status.');
    await c.query('UPDATE lots SET recalled_at=CASE WHEN $3 THEN now() END,recall_revision=recall_revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,lot.id,held]);
    await c.query(`INSERT INTO stockchief_runtime.lot_recall_events(id,workspace_id,lot_id,actor_id,revision,held,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[newId('recall'),ctx.workspaceId,lot.id,ctx.actorId,revision+1,held,reason]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function certificate(db,ctx,input){
  return db.transaction(async c=>{
    const state=await ownerState(c,ctx);
    policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,196,'draft');
    const lot=await lookup(c,ctx,input,true),kind=input.kind;
    if(!['CoA','Safety sheet'].includes(kind))throw new ValidationError('Choose a certificate type.');
    let link;
    if(input.documentUrl){
      try{link=new URL(input.documentUrl);}catch{throw new ValidationError('Enter a valid HTTPS document link.');}
      if(link.protocol!=='https:'||link.username||link.password||link.href.length>2048)throw new ValidationError('Enter an HTTPS document link without a password.');
      if(input.expiresOn)require('../accounting/customer-money').dates({from:input.expiresOn,to:input.expiresOn},'');
    }
    await c.query('INSERT INTO stockchief_runtime.lot_certificate_requirements(workspace_id,sku_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ctx.workspaceId,lot.sku_id,kind]);
    if(link)await c.query(`INSERT INTO stockchief_runtime.lot_certificates(workspace_id,lot_id,kind,document_url,expires_on,recorded_by)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,lot_id,kind) DO UPDATE SET document_url=excluded.document_url,
      expires_on=excluded.expires_on,recorded_by=excluded.recorded_by,recorded_at=now()`,[ctx.workspaceId,lot.id,kind,link.href,input.expiresOn||null,ctx.actorId]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={details,recall,certificate};
