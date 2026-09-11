'use strict';

const { inTransaction } = require('../db');
const engine = require('../domain/inventory-engine');
const repo = require('../domain/repository');
const permissions = require('../actions/permissions');
const provenance = require('../provenance/service');
const { ValidationError, NotFoundError } = require('../domain/errors');
const { newId, nowIso, requireText, requireOneOf, trimOrNull } = require('../lib/util');

function nextNumber(db, workspaceId) {
  return Number(db.prepare('SELECT COALESCE(MAX(campaign_number),0)+1 AS n FROM inventory_count_campaigns WHERE workspace_id=?').get(workspaceId).n);
}

function requireCampaign(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM inventory_count_campaigns WHERE workspace_id=? AND id=?').get(workspaceId, id);
  if (!row) throw new NotFoundError('That count campaign could not be found.');
  return row;
}

function requireSession(db, workspaceId, id) {
  const row = db.prepare(`SELECT s.*, c.name AS campaign_name, c.location_id, c.blind_count, c.count_kind
    FROM inventory_count_sessions s JOIN inventory_count_campaigns c ON c.id=s.campaign_id
    WHERE s.workspace_id=? AND s.id=?`).get(workspaceId, id);
  if (!row) throw new NotFoundError('That count session could not be found.');
  row.lines = db.prepare(`SELECT l.*, s.code AS sku_code, i.name AS item_name, s.variant_label,
      loc.name AS location_name FROM inventory_count_lines l
    JOIN skus s ON s.id=l.sku_id JOIN items i ON i.id=s.item_id
    JOIN locations loc ON loc.id=l.location_id WHERE l.session_id=? ORDER BY i.name,s.position`).all(id);
  row.totalVariance = row.lines.reduce((sum, line) => sum + Math.abs(Number(line.variance || 0)), 0);
  return row;
}

function candidateSkus(db, workspaceId, locationId, skuIds, kind) {
  if (skuIds && skuIds.length) {
    return [...new Set(skuIds)].map((id) => repo.requireSku(db, workspaceId, id));
  }
  if (kind !== 'FULL') throw new ValidationError('Choose at least one product for a cycle count.');
  return db.prepare(`SELECT s.* FROM skus s JOIN items i ON i.id=s.item_id
    WHERE s.workspace_id=? AND s.is_active=1 AND i.is_active=1
      AND (EXISTS (SELECT 1 FROM balances b WHERE b.sku_id=s.id AND b.location_id=?)
        OR EXISTS (SELECT 1 FROM movements m WHERE m.sku_id=s.id AND m.location_id=?))
    ORDER BY i.name,s.position`).all(workspaceId, locationId, locationId);
}

function countEntries(db, workspaceId, locationId, skuIds, kind) {
  const entries=[];
  for (const sku of candidateSkus(db,workspaceId,locationId,skuIds,kind)) {
    if (sku.tracking_mode === 'serial') {
      throw new ValidationError(`${sku.code} is serial-tracked. Count it with the scan-first serial count so Foundry can verify every identity; a total alone is not accepted.`);
    }
    if (sku.tracking_mode === 'lot') {
      const lots=db.prepare(`SELECT l.id,l.code,COALESCE(b.quantity,0) AS quantity FROM lots l
        JOIN lot_balances b ON b.lot_id=l.id AND b.workspace_id=l.workspace_id
        WHERE l.workspace_id=? AND l.sku_id=? AND b.location_id=? AND b.quantity<>0 ORDER BY l.code`)
        .all(workspaceId,sku.id,locationId);
      if (!lots.length) continue;
      lots.forEach((lot)=>entries.push({sku,lotId:lot.id,expected:Number(lot.quantity)}));
    } else entries.push({sku,lotId:null,expected:repo.getBalance(db,workspaceId,sku.id,locationId)});
  }
  return entries;
}

function nextDue(fromDate, frequencyDays) {
  const value=new Date(`${fromDate}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate()+Number(frequencyDays));
  return value.toISOString().slice(0,10);
}

function createPlan(db,ctx,membership,input){
  permissions.assertCan(membership,permissions.APPROVE_COUNT_VARIANCE,'schedule inventory counts');
  return inTransaction(db,()=>{
    const location=repo.requireLocation(db,ctx.workspaceId,requireText(input.locationId,'Count location'));
    const kind=requireOneOf(String(input.countKind||'CYCLE').toUpperCase(),['CYCLE','FULL'],'Count kind');
    const frequency=Number(input.frequencyDays);
    if(!Number.isInteger(frequency)||frequency<1)throw new ValidationError('Count frequency must be at least one day.');
    const skuIds=kind==='FULL'?[]:[...new Set(Array.isArray(input.skuIds)?input.skuIds:[])];
    if(kind==='CYCLE'&&!skuIds.length)throw new ValidationError('Choose at least one product for a cycle-count plan.');
    skuIds.forEach((id)=>repo.requireSku(db,ctx.workspaceId,id));
    const id=newId('cntp'),at=nowIso();
    db.prepare(`INSERT INTO inventory_count_plans
      (id,workspace_id,name,count_kind,location_id,frequency_days,next_due_date,blind_count,active,created_by_user_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,?,?,?)`).run(id,ctx.workspaceId,requireText(input.name,'Plan name'),kind,location.id,frequency,
        trimOrNull(input.nextDueDate)||at.slice(0,10),input.blindCount===false||input.blindCount==='0'?0:1,ctx.actorId,at,at);
    const add=db.prepare('INSERT INTO inventory_count_plan_skus (plan_id,workspace_id,sku_id) VALUES (?,?,?)');
    skuIds.forEach((skuId)=>add.run(id,ctx.workspaceId,skuId));
    return requirePlan(db,ctx.workspaceId,id);
  });
}

function requirePlan(db,workspaceId,id){
  const row=db.prepare(`SELECT p.*,l.name AS location_name FROM inventory_count_plans p JOIN locations l ON l.id=p.location_id
    WHERE p.workspace_id=? AND p.id=?`).get(workspaceId,id);
  if(!row)throw new NotFoundError('That count plan could not be found.');
  row.skuIds=db.prepare('SELECT sku_id FROM inventory_count_plan_skus WHERE workspace_id=? AND plan_id=? ORDER BY sku_id').all(workspaceId,id).map((x)=>x.sku_id);
  return row;
}

function launchPlan(db,ctx,membership,id){
  permissions.assertCan(membership,permissions.COUNT_STOCK,'start a scheduled inventory count');
  return inTransaction(db,()=>{
    const plan=requirePlan(db,ctx.workspaceId,id);
    if(!plan.active)throw new ValidationError('That count plan is paused.');
    const existing=db.prepare("SELECT id FROM inventory_count_campaigns WHERE workspace_id=? AND plan_id=? AND status NOT IN ('COMPLETED','CANCELLED')").get(ctx.workspaceId,id);
    if(existing){const session=db.prepare('SELECT id FROM inventory_count_sessions WHERE campaign_id=? ORDER BY pass_number DESC LIMIT 1').get(existing.id);return requireSession(db,ctx.workspaceId,session.id);}
    const session=createCampaign(db,ctx,membership,{planId:plan.id,name:`${plan.name} · ${nowIso().slice(0,10)}`,countKind:plan.count_kind,
      locationId:plan.location_id,blindCount:Boolean(plan.blind_count),skuIds:plan.count_kind==='FULL'?null:plan.skuIds});
    const anchor=plan.next_due_date&&plan.next_due_date>nowIso().slice(0,10)?plan.next_due_date:nowIso().slice(0,10);
    db.prepare('UPDATE inventory_count_plans SET next_due_date=?,updated_at=? WHERE id=? AND workspace_id=?')
      .run(nextDue(anchor,plan.frequency_days),nowIso(),id,ctx.workspaceId);
    return session;
  });
}

function listPlans(db,workspaceId){return db.prepare(`SELECT p.*,l.name AS location_name,
  (SELECT COUNT(*) FROM inventory_count_plan_skus s WHERE s.plan_id=p.id) AS sku_count
  FROM inventory_count_plans p JOIN locations l ON l.id=p.location_id WHERE p.workspace_id=? ORDER BY p.active DESC,p.next_due_date,p.name`).all(workspaceId);}

function createCampaign(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.COUNT_STOCK, 'start inventory counts');
  return inTransaction(db, () => {
    const location = repo.requireLocation(db, ctx.workspaceId, requireText(input.locationId, 'Count location'));
    const kind = requireOneOf(String(input.countKind || 'CYCLE').toUpperCase(), ['CYCLE','FULL'], 'Count kind');
    const entries = countEntries(db, ctx.workspaceId, location.id, input.skuIds, kind);
    if (!entries.length) throw new ValidationError('There is no recorded inventory to count at that location.');
    const at = nowIso(); const number = nextNumber(db, ctx.workspaceId); const campaignId = newId('cntc');
    db.prepare(`INSERT INTO inventory_count_campaigns
      (id,workspace_id,plan_id,campaign_number,name,count_kind,location_id,status,blind_count,created_by_user_id,created_at)
      VALUES (?,?,?,?,?,?,?,'ACTIVE',?,?,?)`).run(campaignId,ctx.workspaceId,trimOrNull(input.planId),number,
        trimOrNull(input.name)||`${kind==='FULL'?'Full inventory':'Cycle count'} #${number}`,kind,location.id,
        input.blindCount === false || input.blindCount === '0' ? 0 : 1,ctx.actorId,at);
    const sessionId = newId('cnts');
    db.prepare(`INSERT INTO inventory_count_sessions
      (id,workspace_id,campaign_id,pass_number,status,counted_by_user_id,created_at)
      VALUES (?,?,?,1,'OPEN',?,?)`).run(sessionId,ctx.workspaceId,campaignId,ctx.actorId,at);
    const add = db.prepare(`INSERT INTO inventory_count_lines
      (id,workspace_id,session_id,sku_id,location_id,lot_id,expected_quantity,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    provenance.record(db,ctx.workspaceId,{type:'HAS_PART',from:{type:'count_campaign',id:campaignId},to:{type:'count_session',id:sessionId}});
    for (const entry of entries) {
      const lineId=newId('cntl');add.run(lineId,ctx.workspaceId,sessionId,entry.sku.id,location.id,entry.lotId,entry.expected,at);
      provenance.record(db,ctx.workspaceId,{type:'HAS_PART',from:{type:'count_session',id:sessionId},to:{type:'count_line',id:lineId}});
    }
    return requireSession(db,ctx.workspaceId,sessionId);
  });
}

function recordCount(db, ctx, membership, sessionId, lineId, quantity, note = null) {
  permissions.assertCan(membership, permissions.COUNT_STOCK, 'record physical counts');
  const session = requireSession(db,ctx.workspaceId,sessionId);
  if (session.status !== 'OPEN') throw new ValidationError('That count pass has already been submitted.');
  const counted = Number(quantity);
  if (!Number.isInteger(counted) || counted < 0) throw new ValidationError('Counted quantity must be zero or a positive whole number.');
  const line = session.lines.find((candidate) => candidate.id === lineId);
  if (!line) throw new NotFoundError('That product is not in this count.');
  db.prepare(`UPDATE inventory_count_lines SET counted_quantity=?,variance=?-expected_quantity,note=?,updated_at=?
    WHERE workspace_id=? AND id=?`).run(counted,counted,trimOrNull(note),nowIso(),ctx.workspaceId,lineId);
  return requireSession(db,ctx.workspaceId,sessionId);
}

function submit(db, ctx, membership, sessionId) {
  permissions.assertCan(membership, permissions.COUNT_STOCK, 'submit physical counts');
  return inTransaction(db, () => {
    const session = requireSession(db,ctx.workspaceId,sessionId);
    if (session.status !== 'OPEN') return session;
    if (session.lines.some((line) => line.counted_quantity === null)) throw new ValidationError('Count every listed product before submitting this pass.');
    const hasVariance = session.lines.some((line) => Number(line.variance)!==0);
    const status = !hasVariance ? 'COMPLETED' : session.blind_count && session.pass_number===1 ? 'RECOUNT_REQUIRED' : 'AWAITING_APPROVAL';
    const at=nowIso();
    db.prepare('UPDATE inventory_count_sessions SET status=?,submitted_at=? WHERE id=? AND workspace_id=?').run(status,at,session.id,ctx.workspaceId);
    db.prepare('UPDATE inventory_count_campaigns SET status=?,completed_at=? WHERE id=? AND workspace_id=?')
      .run(status,status==='COMPLETED'?at:null,session.campaign_id,ctx.workspaceId);
    return requireSession(db,ctx.workspaceId,sessionId);
  });
}

function startRecount(db, ctx, membership, sessionId) {
  permissions.assertCan(membership, permissions.COUNT_STOCK, 'perform a blind recount');
  return inTransaction(db, () => {
    const prior=requireSession(db,ctx.workspaceId,sessionId);
    if(prior.status!=='RECOUNT_REQUIRED') throw new ValidationError('This count does not require a recount.');
    const existing=db.prepare('SELECT id FROM inventory_count_sessions WHERE parent_session_id=? AND workspace_id=?').get(prior.id,ctx.workspaceId);
    if(existing) return requireSession(db,ctx.workspaceId,existing.id);
    const id=newId('cnts'); const at=nowIso();
    db.prepare(`INSERT INTO inventory_count_sessions
      (id,workspace_id,campaign_id,parent_session_id,pass_number,status,counted_by_user_id,created_at)
      VALUES (?,?,?,?,?,'OPEN',?,?)`).run(id,ctx.workspaceId,prior.campaign_id,prior.id,prior.pass_number+1,ctx.actorId,at);
    const add=db.prepare(`INSERT INTO inventory_count_lines
      (id,workspace_id,session_id,sku_id,location_id,lot_id,expected_quantity,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    provenance.record(db,ctx.workspaceId,{type:'HAS_PART',from:{type:'count_campaign',id:prior.campaign_id},to:{type:'count_session',id}});
    prior.lines.filter((line)=>Number(line.variance)!==0).forEach((line)=>{const lineId=newId('cntl');add.run(lineId,ctx.workspaceId,id,line.sku_id,line.location_id,line.lot_id,Number(line.expected_quantity),at);provenance.record(db,ctx.workspaceId,{type:'HAS_PART',from:{type:'count_session',id},to:{type:'count_line',id:lineId}});});
    db.prepare("UPDATE inventory_count_campaigns SET status='ACTIVE' WHERE id=? AND workspace_id=?").run(prior.campaign_id,ctx.workspaceId);
    return requireSession(db,ctx.workspaceId,id);
  });
}

function approve(db, ctx, membership, sessionId) {
  permissions.assertCan(membership, permissions.APPROVE_COUNT_VARIANCE, 'approve count variances');
  return inTransaction(db, () => {
    const session=requireSession(db,ctx.workspaceId,sessionId);
    if(session.status==='COMPLETED') return session;
    if(session.status!=='AWAITING_APPROVAL') throw new ValidationError('This count is not waiting for variance approval.');
    for(const line of session.lines){
      const current=line.lot_id?repo.getLotBalance(db,ctx.workspaceId,line.lot_id,line.location_id):repo.getBalance(db,ctx.workspaceId,line.sku_id,line.location_id);
      if(current!==Number(line.expected_quantity)) throw new ValidationError(`${line.item_name} changed after the count began. Start a fresh count; Foundry will not overwrite newer stock activity.`);
      if(Number(line.variance)===0) continue;
      const result=engine.adjust(db,ctx,{skuId:line.sku_id,locationId:line.location_id,lotId:line.lot_id||undefined,countedQty:Number(line.counted_quantity),reasonCode:'physical_count',reference:`Count ${session.campaign_name}`});
      db.prepare('UPDATE inventory_count_lines SET adjustment_movement_id=?,updated_at=? WHERE id=?').run(result.movementIds[0],nowIso(),line.id);
      result.movementIds.forEach((movementId)=>provenance.record(db,ctx.workspaceId,{type:'CAUSED_MOVEMENT',from:{type:'count_line',id:line.id},to:{type:'inventory_movement',id:movementId}}));
    }
    const integrity=engine.verifyIntegrity(db,ctx.workspaceId);
    if(!integrity.ok) throw new ValidationError('The count was not completed because post-count inventory verification failed.');
    const at=nowIso();
    db.prepare("UPDATE inventory_count_sessions SET status='COMPLETED',approved_by_user_id=?,approved_at=? WHERE id=?").run(ctx.actorId,at,session.id);
    db.prepare("UPDATE inventory_count_campaigns SET status='COMPLETED',approved_by_user_id=?,completed_at=? WHERE id=?").run(ctx.actorId,at,session.campaign_id);
    return requireSession(db,ctx.workspaceId,sessionId);
  });
}

function list(db,workspaceId){return db.prepare(`SELECT c.*,l.name AS location_name,
  (SELECT id FROM inventory_count_sessions s WHERE s.campaign_id=c.id ORDER BY pass_number DESC LIMIT 1) AS current_session_id
  FROM inventory_count_campaigns c JOIN locations l ON l.id=c.location_id WHERE c.workspace_id=? ORDER BY c.created_at DESC`).all(workspaceId);}

function analytics(db,workspaceId){return db.prepare(`SELECT s.code AS sku_code,i.name AS item_name,l.expected_quantity,l.counted_quantity,l.variance,c.completed_at
  FROM inventory_count_lines l JOIN inventory_count_sessions se ON se.id=l.session_id
  JOIN inventory_count_campaigns c ON c.id=se.campaign_id JOIN skus s ON s.id=l.sku_id JOIN items i ON i.id=s.item_id
  WHERE l.workspace_id=? AND se.status='COMPLETED' AND l.variance IS NOT NULL AND l.variance<>0 ORDER BY c.completed_at DESC LIMIT 100`).all(workspaceId);}

module.exports={createPlan,requirePlan,launchPlan,listPlans,createCampaign,recordCount,submit,startRecount,approve,requireSession,requireCampaign,list,analytics};
