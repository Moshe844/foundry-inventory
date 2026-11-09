'use strict';

const policy=require('../commercial/agent-plan');
const modes=require('../autopilot/job-modes');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const decision=require('../purchasing/replenishment-decision');
const audit=require('../operations/postgres-security-audit');

async function configure(db,ctx,{skuId,locationId,ceiling,remove}){
  return db.transaction(async c=>{
    const owner=await c.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId]);
    if(!owner.rowCount)throw new AuthorizationError('Only the inventory owner can authorize automatic reorder changes.');
    if(remove==='1'){
      const deleted=await c.query('DELETE FROM stockchief_runtime.location_reorder_rules WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 RETURNING ceiling',[ctx.workspaceId,skuId,locationId]);
      if(deleted.rowCount)await audit.record(c,ctx,{action:'Removed automatic reorder rule',before:{skuId,locationId,ceiling:deleted.rows[0].ceiling},after:{}});
      return;
    }
    await policy.requireWorkspaceJob(c,ctx.workspaceId,120,'automatic',{trained:true});
    const value=Number(ceiling);
    if(!Number.isSafeInteger(value)||value<1||value>2147483647)throw new ValidationError('Enter a positive maximum number of units.');
    const found=(await c.query(`SELECT 1 FROM skus s JOIN locations l ON l.workspace_id=s.workspace_id
      WHERE s.workspace_id=$1 AND s.id=$2 AND s.is_active=1 AND l.id=$3 AND l.is_active=1 AND l.custody_agreement_id IS NULL`,[ctx.workspaceId,skuId,locationId])).rowCount;
    if(!found)throw new ValidationError('Choose an active product and location from this inventory.');
    const present=await c.query('SELECT 1 FROM stockchief_runtime.location_reorder_rules WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,skuId,locationId]);
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],present.rowCount?0:1);
    await c.query(`INSERT INTO stockchief_runtime.location_reorder_rules(workspace_id,sku_id,location_id,authorized_by,ceiling)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,sku_id,location_id) DO UPDATE SET ceiling=EXCLUDED.ceiling,authorized_by=EXCLUDED.authorized_by`,[ctx.workspaceId,skuId,locationId,ctx.actorId,value]);
    await audit.record(c,ctx,{action:'Authorized automatic reorder thresholds',after:{skuId,locationId,ceiling:value}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function runPage(db,workspaceId,skuIds){
  if(!skuIds.length)return;
  await db.transaction(async c=>{
    const rules=(await c.query(`SELECT r.* FROM stockchief_runtime.location_reorder_rules r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by
      AND u.role='owner' JOIN workspace_autopilot a ON a.workspace_id=r.workspace_id AND a.mode='POLICY_AUTOMATED' AND a.paused=0 AND a.suspended=0
      WHERE r.workspace_id=$1 AND r.sku_id=ANY($2::text[]) ORDER BY r.sku_id,r.location_id FOR UPDATE OF r`,[workspaceId,skuIds])).rows;
    const general=(await c.query(`SELECT j.updated_by FROM stockchief_runtime.agent_job_modes j JOIN users u ON u.workspace_id=j.workspace_id AND u.id=j.updated_by AND u.role='owner'
      JOIN workspace_autopilot a ON a.workspace_id=j.workspace_id AND a.mode='POLICY_AUTOMATED' AND a.paused=0 AND a.suspended=0
      WHERE j.workspace_id=$1 AND j.job_id=120 AND j.mode='routine'`,[workspaceId])).rows[0];
    if(!rules.length&&!general)return;
    const account=await policy.accountState(c,workspaceId);
    if(account.shadow||!policy.usesAgentTerms(account)||![21,120].every(id=>policy.permits(account.plan,id,'automatic',{trained:true})))return;
    if(await modes.restriction(c,workspaceId,21,true)||await modes.restriction(c,workspaceId,120,true))return;
    const autonomous=Boolean(general)&&policy.permits(account.plan,120,'automatic');
    const selected=autonomous?skuIds:[...new Set(rules.map(r=>r.sku_id))];
    if(!selected.length)return;
    const current=await require('../purchasing/postgres-replenishment-state').rows(c,workspaceId,{onlySkuIds:selected});
    const key=r=>JSON.stringify([r.sku_id,r.location_id]);
    const authorized=new Map(rules.map(r=>[key(r),r]));
    const sales=(await c.query(`SELECT d.sku_id,d.location_id,count(*) AS events,sum(d.issued) AS units FROM stockchief_runtime.replenishment_demand_events d
      JOIN movements m ON m.workspace_id=d.workspace_id AND m.id=d.movement_id AND m.reason_code IN ('sale','sold')
      WHERE d.workspace_id=$1 AND d.sku_id=ANY($2::text[]) AND d.occurred_at BETWEEN now()-interval '90 days' AND now()
      GROUP BY d.sku_id,d.location_id`,[workspaceId,selected])).rows;
    const byLocation=new Map(sales.map(s=>[key(s),s]));
    for(const row of current){
      if(!row.location_id||row.planning_suppressed||row.tracking_mode!=='quantity'||row.lead_time_assumed)continue;
      const rule=authorized.get(key(row))||(autonomous?{sku_id:row.sku_id,location_id:row.location_id,ceiling:null,authorized_by:general.updated_by}:null);
      if(!rule)continue;
      const recorded=byLocation.get(key(row));
      if(!recorded)continue;
      const demand=decision.derive({...row,issued:recorded.units,issue_events:recorded.events});
      if(demand.inferredReorder===null)continue;
      const minimum=demand.inferredReorder,maximum=Math.max(minimum+demand.safety,Math.ceil(demand.rate*demand.coverDays));
      if(rule.ceiling!==null&&maximum>rule.ceiling||!Number.isSafeInteger(maximum)||maximum>2147483647)continue;
      if(row.reorder_point!=null&&Number(row.reorder_point)===minimum&&row.target_stock!=null&&Number(row.target_stock)===maximum)continue;
      const at=nowIso(),notes='Automatic reorder rule from local sales demand';
      if(row.policy_id){
        await c.query(`UPDATE reorder_policies SET reorder_point=$4,target_stock=$5,source='foundry',notes=$6,updated_at=$7
          WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,[workspaceId,rule.sku_id,rule.location_id,minimum,maximum,notes,at]);
      }else{
        await c.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,notes,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,'foundry',$7,$8,$8)`,[newId('rpol'),workspaceId,rule.sku_id,rule.location_id,minimum,maximum,notes,at]);
      }
      await audit.record(c,{workspaceId,actorId:rule.authorized_by},{action:'Updated location reorder thresholds',before:{minimum:row.reorder_point,maximum:row.target_stock},
        after:{skuId:rule.sku_id,locationId:rule.location_id,minimum,maximum,issued:demand.issued,leadDays:demand.lead,ceiling:rule.ceiling}});
    }
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function review(db,ctx,{filter,page}){
  const catalog=(await db.query(`SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    WHERE s.workspace_id=$1 AND s.is_active=1 AND ($2='' OR lower(s.code)=lower($2)) ORDER BY s.code,s.id LIMIT 51 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*50])).rows;
  const {rows}=await db.query(`SELECT s.id,s.code,i.name,d.location_id,l.name AS location,sum(d.issued) AS sold,count(*) AS events FROM stockchief_runtime.replenishment_demand_events d
    JOIN movements m ON m.workspace_id=d.workspace_id AND m.id=d.movement_id AND m.reason_code IN ('sale','sold')
    JOIN skus s ON s.workspace_id=d.workspace_id AND s.id=d.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    JOIN locations l ON l.workspace_id=d.workspace_id AND l.id=d.location_id AND l.is_active=1 AND l.custody_agreement_id IS NULL
    WHERE d.workspace_id=$1 AND d.occurred_at BETWEEN now()-interval '90 days' AND now() AND d.sku_id=ANY($2::text[])
    GROUP BY s.id,s.code,i.name,d.location_id,l.name HAVING count(*)>=2 ORDER BY s.code,s.id,l.name,d.location_id`,[ctx.workspaceId,catalog.slice(0,50).map(r=>r.id)]);
  const ids=[...new Set(rows.map(r=>r.id))],positions=ids.length?await require('../purchasing/postgres-replenishment-state').rows(db,ctx.workspaceId,{onlySkuIds:ids}):[];
  const details=[],bySku=new Map();
  for(const r of rows){
    const position=positions.find(p=>p.sku_id===r.id&&p.location_id===r.location_id);
    if(!position||position.planning_suppressed)continue;
    const demand=decision.derive({...position,issued:r.sold,issue_events:r.events});
    const item={SKU:r.code,Product:r.name,Location:r.location,'Sold in 90 days':Number(r.sold),'Reorder point':demand.inferredReorder};
    details.push(item);const total=bySku.get(r.id)||{SKU:r.code,'Sold in 90 days':0,'Reorder point':0};
    total['Sold in 90 days']+=Number(r.sold);total['Reorder point']+=demand.inferredReorder;bySku.set(r.id,total);
  }
  const state=await policy.accountState(db,ctx.workspaceId);
  return {rows:state.plan==='starter'?[...bySku.values()]:details,more:catalog.length>50,
    summary:'Reorder points use 90 days of physical sales, lead time and safety stock. Starter sees a product-level suggestion across eligible locations. A location needs at least two sales issues.'};
}
module.exports={configure,runPage,review};
