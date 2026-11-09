'use strict';
const policy=require('../commercial/agent-plan');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const exact=require('../domain/exact-quantity');
const brandFact="lower(trim(coalesce(f.facts::jsonb->>'brand',f.facts::jsonb->>'Brand')))";
const matching=`SELECT w.brand_name AS "Brand",s.code AS "SKU",i.name AS "Product",q.units AS "On hand",
    w.threshold AS "Threshold",CASE WHEN w.inclusive THEN 'At or below' ELSE 'Below' END AS "Alert when",
    '/inventory/'||i.id AS link
  FROM stockchief_runtime.agent_brand_watches w JOIN catalogue_item_facts f ON f.workspace_id=w.workspace_id AND ${brandFact}=w.brand_key
  JOIN items i ON i.id=f.item_id AND i.workspace_id=w.workspace_id AND i.is_active=1
  JOIN skus s ON s.item_id=i.id AND s.workspace_id=w.workspace_id AND s.is_active=1
  CROSS JOIN LATERAL (SELECT coalesce(sum(b.on_hand),0) AS units FROM balances b WHERE b.workspace_id=w.workspace_id AND b.sku_id=s.id) q
  WHERE w.workspace_id=$1 AND ($2='' OR w.brand_key=lower($2) OR lower(s.code)=lower($2))
    AND (q.units<w.threshold OR (w.inclusive AND q.units=w.threshold))
  ORDER BY w.brand_key,s.code,s.id`;

function parse(instruction){
  if(typeof instruction!=='string'||instruction.length>320)throw new ValidationError('Enter a brand, comparison and quantity.');
  const m=/^(?:tell me|notify me|alert me) (?:if|when) any (.{1,100}?) (?:item|product|sku) (?:drops? |falls? |is |has )?(under|below|at or below) (\d+(?:\.\d{1,6})?)(?: units?)?[.!]?$/i.exec(instruction.trim());
  if(!m)throw new ValidationError('Use a rule such as “Tell me if any Nike item drops under 20”.');
  return {brand:m[1].trim(),inclusive:/^at or below$/i.test(m[2]),threshold:exact.safeNumber(m[3],{label:'Alert threshold'})};
}
async function save(db,ctx,input){
  return db.transaction(async c=>{
    await policy.requireWorkspaceJob(c,ctx.workspaceId,167,'automatic');
    const member=await c.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId]);
    if(!member.rowCount)throw new AuthorizationError('Only the owner can change brand watch rules.');
    if(input.remove){
      await c.query('DELETE FROM stockchief_runtime.agent_brand_watches WHERE workspace_id=$1 AND brand_key=lower(trim($2))',[ctx.workspaceId,input.remove]);
    }else{
      const rule=parse(input.instruction);
      const {rows:[fact]}=await c.query(`SELECT trim(coalesce(f.facts::jsonb->>'brand',f.facts::jsonb->>'Brand')) AS name
        FROM catalogue_item_facts f JOIN items i ON i.workspace_id=f.workspace_id AND i.id=f.item_id AND i.is_active=1
        WHERE f.workspace_id=$1 AND ${brandFact}=lower($2) LIMIT 1`,[ctx.workspaceId,rule.brand]);
      if(!fact)throw new ValidationError('No active product has that brand. Check the saved brand on the product first.');
      const present=await c.query('SELECT 1 FROM stockchief_runtime.agent_brand_watches WHERE workspace_id=$1 AND brand_key=lower($2)',[ctx.workspaceId,rule.brand]);
      await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],present.rowCount?0:1);
      await c.query(`INSERT INTO stockchief_runtime.agent_brand_watches(workspace_id,brand_key,brand_name,threshold,inclusive,updated_by)
        VALUES($1,lower($2),$2,$3,$4,$5) ON CONFLICT(workspace_id,brand_key) DO UPDATE SET threshold=excluded.threshold,
        inclusive=excluded.inclusive,updated_by=excluded.updated_by`,[ctx.workspaceId,fact.name,rule.threshold,rule.inclusive,ctx.actorId]);
    }
    await require('./operational-notices').refresh(c,ctx.workspaceId);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function list(db,workspaceId){
  return (await db.query('SELECT brand_name,threshold,inclusive FROM stockchief_runtime.agent_brand_watches WHERE workspace_id=$1 ORDER BY brand_key',[workspaceId])).rows;
}
module.exports={save,list,matching};
