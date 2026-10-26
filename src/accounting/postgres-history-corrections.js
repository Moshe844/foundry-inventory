'use strict';
const P=require('../actions/permissions'),clock=require('../lib/business-time'),ledger=require('./postgres-ledger'),{ValidationError}=require('../domain/errors'),{newId}=require('../lib/util'),{hash}=require('../pricing/postgres-promotions');
const parse=v=>typeof v==='string'?JSON.parse(v):v||{};
async function authorize(db,ctx){P.assertCan((await db.query('SELECT * FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0],P.MANAGE_ACCOUNTING,'correct historical accounting');}
async function preview(db,ctx,{kinds=['calendar','pending_return_cost'],entryIds=null}={}){
 await authorize(db,ctx);if(!Array.isArray(kinds)||!kinds.length||kinds.some(k=>!['calendar','pending_return_cost'].includes(k)))throw new ValidationError('Choose calendar and/or pending return cost corrections.');
 const calendar=await clock.forWorkspace(db,ctx.workspaceId),start=(await db.query('SELECT accounting_start_date FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.accounting_start_date,entries=(await db.query(`SELECT e.*,m.occurred_at movement_at,r.status return_status,r.resolution,r.receipt_credit_policy,
 EXISTS(SELECT 1 FROM accounting_periods p WHERE p.workspace_id=e.workspace_id AND p.starts_on<=e.posting_date AND p.ends_on>=e.posting_date AND p.status<>'OPEN') original_closed
 FROM accounting_journal_entries e LEFT JOIN movements m ON m.workspace_id=e.workspace_id AND m.id=e.metadata::jsonb->>'movementId'
 LEFT JOIN customer_returns r ON r.workspace_id=e.workspace_id AND e.source_record_type='customer_return' AND r.id=e.source_record_id
 WHERE e.workspace_id=$1 AND e.status='POSTED' AND e.source_type IN ('sale_fulfillment','purchase_receipt','customer_return_receipt','opening_inventory','import_stock_count') AND (e.source_type NOT IN ('opening_inventory','import_stock_count') OR e.source_record_type='import_row')
 AND ((e.posting_date=left(e.created_at,10) AND e.posting_date<>to_char(coalesce(m.occurred_at,e.created_at)::timestamptz AT TIME ZONE $3,'YYYY-MM-DD') AND NOT EXISTS(SELECT 1 FROM accounting_history_corrections h WHERE h.workspace_id=e.workspace_id AND h.source_entry_id=e.id AND h.kind='calendar')) OR (r.receipt_credit_policy IS NULL AND r.resolution='REFUND' AND r.status<>'COMPLETED' AND NOT EXISTS(SELECT 1 FROM accounting_history_corrections h WHERE h.workspace_id=e.workspace_id AND h.source_entry_id=e.id AND h.kind='pending_return_cost') AND EXISTS(SELECT 1 FROM accounting_journal_lines l JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id WHERE l.workspace_id=e.workspace_id AND l.entry_id=e.id AND a.system_key='COST_OF_GOODS_SOLD' AND l.credit_minor>0)))
 AND ($2::text[] IS NULL OR e.id=ANY($2::text[])) ORDER BY e.created_at,e.id LIMIT 501`,[ctx.workspaceId,entryIds,calendar.timeZone])).rows;
 const hasMore=entries.length>500;if(hasMore)entries.length=500;
 const entryIdsSelected=entries.map(e=>e.id),corrected=(await db.query('SELECT source_entry_id,kind FROM accounting_history_corrections WHERE workspace_id=$1 AND source_entry_id=ANY($2::text[])',[ctx.workspaceId,entryIdsSelected])).rows,changes=[],held=[];
 const allLines=(await db.query('SELECT l.*,a.system_key FROM accounting_journal_lines l JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id WHERE l.workspace_id=$1 AND l.entry_id=ANY($2::text[]) ORDER BY l.entry_id,l.line_number',[ctx.workspaceId,entryIdsSelected])).rows,byEntry=new Map();for(const l of allLines){if(!byEntry.has(l.entry_id))byEntry.set(l.entry_id,[]);byEntry.get(l.entry_id).push(l);}
 const closedPeriods=(await db.query("SELECT starts_on,ends_on FROM accounting_periods WHERE workspace_id=$1 AND status<>'OPEN'",[ctx.workspaceId])).rows;
 for(const entry of entries){const lines=byEntry.get(entry.id)||[],metadata=parse(entry.metadata),instant=entry.movement_at|| (['customer_return_receipt','opening_inventory','import_stock_count'].includes(entry.source_type)?entry.created_at:null),targetDate=instant?(/^\d{4}-\d{2}-\d{2}$/.test(instant)?instant:clock.context(calendar.timeZone,new Date(instant)).calendarDate):null;
  const evidence={sourceEntryId:entry.id,sourceType:entry.source_type,sourceRecordId:entry.source_record_id,postingDate:entry.posting_date,instant:instant||null,timeZone:calendar.timeZone,lines:lines.map(l=>({accountId:l.account_id,debitMinor:Number(l.debit_minor),creditMinor:Number(l.credit_minor),currency:l.currency,customerId:l.customer_id,supplierId:l.supplier_id,itemId:l.item_id,skuId:l.sku_id,locationId:l.location_id})),returnStatus:entry.return_status,resolution:entry.resolution,cogsAccountId:lines.find(l=>l.system_key==='COST_OF_GOODS_SOLD')?.account_id||null},fingerprint=hash(evidence);
  const targetClosed=targetDate&&closedPeriods.some(p=>p.starts_on<=targetDate&&p.ends_on>=targetDate);
  if(kinds.includes('calendar')&&!metadata.postingCalendar&&targetDate&&entry.posting_date===entry.created_at.slice(0,10)&&targetDate!==entry.posting_date&&!corrected.some(c=>c.source_entry_id===entry.id&&c.kind==='calendar')){
   if(entry.original_closed||targetClosed||targetDate<start)held.push({entryId:entry.id,kind:'calendar',reason:'The original or corrected date is closed or precedes the accounting start date.'});else changes.push({kind:'calendar',entryId:entry.id,entryNumber:entry.entry_number,sourceRecordId:entry.source_record_id,sourceRecordType:entry.source_record_type,targetDate,originalDate:entry.posting_date,evidence,fingerprint});
  }
  if(kinds.includes('pending_return_cost')&&entry.source_type==='customer_return_receipt'&&entry.resolution==='REFUND'&&!entry.receipt_credit_policy&&entry.return_status!=='COMPLETED'&&!corrected.some(c=>c.source_entry_id===entry.id&&c.kind==='pending_return_cost')){
   const amount=lines.filter(l=>l.system_key==='COST_OF_GOODS_SOLD').reduce((n,l)=>n+Number(l.credit_minor)-Number(l.debit_minor),0);
   if(amount>0){if(entry.original_closed||targetClosed||targetDate<start)held.push({entryId:entry.id,kind:'pending_return_cost',reason:'The original or corrected date is closed or precedes the accounting start date.'});else changes.push({kind:'pending_return_cost',entryId:entry.id,entryNumber:entry.entry_number,sourceRecordId:entry.source_record_id,sourceRecordType:entry.source_record_type,targetDate:targetDate||entry.posting_date,originalDate:entry.posting_date,amountMinor:amount,evidence,fingerprint});}
  }
 }
 const plan={workspaceId:ctx.workspaceId,timeZone:calendar.timeZone,changes,held,hasMore};return {...plan,integrity:hash(plan)};
}
async function applyInTransaction(db,ctx,plan){
 await authorize(db,ctx);// The proposal executor adds its trusted replay key after approval. It is
 // execution metadata, outside the frozen accounting review. All review fields
 // still participate in the integrity check.
 const {integrity,idempotencyKey:executionKey,...body}=plan;if(plan.workspaceId!==ctx.workspaceId||hash(body)!==integrity)throw new ValidationError('This accounting correction review changed.');
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['journal:'+ctx.workspaceId]);
 const allIds=[...new Set(plan.changes.map(c=>c.entryId))],returnIds=[...new Set(plan.changes.filter(c=>c.sourceRecordType==='customer_return').map(c=>c.sourceRecordId))];
 if(returnIds.length)await db.query('SELECT id FROM customer_returns WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[ctx.workspaceId,returnIds]);
 const existing=(await db.query('SELECT id,source_entry_id,kind FROM accounting_history_corrections WHERE workspace_id=$1 AND source_entry_id=ANY($2::text[])',[ctx.workspaceId,allIds])).rows;
 const fresh=await preview(db,ctx,{kinds:[...new Set(plan.changes.map(c=>c.kind))],entryIds:allIds}),pending=[],ids=[],entries=[];
 for(const change of plan.changes){const old=existing.find(c=>c.source_entry_id===change.entryId&&c.kind===change.kind);if(old){ids.push(old.id);continue;}
  const current=fresh.changes.find(c=>c.kind===change.kind&&c.entryId===change.entryId);if(!current||hash(current)!==hash(change))throw new ValidationError('This source journal, return or business calendar changed. Review a new correction.');
  const key='history-correction:'+change.kind+':'+change.entryId,common={currency:change.evidence.lines[0]?.currency,sourceType:'accounting_history_correction',sourceRecordType:change.sourceRecordType,sourceRecordId:change.sourceRecordId,metadata:{originalEntryId:change.entryId,originalSourceType:change.evidence.sourceType,correctionKind:change.kind,reviewHash:integrity}},sourceKeys=[];
  const add=e=>{entries.push(e);sourceKeys.push(e.sourceKey);};
  if(change.kind==='calendar'){add({...common,sourceKey:key+':offset',postingDate:change.originalDate,description:'Offset automatic UTC-day posting for journal '+change.entryNumber,lines:change.evidence.lines.map(l=>({...l,debitMinor:l.creditMinor,creditMinor:l.debitMinor}))});add({...common,sourceKey:key+':business-day',postingDate:change.targetDate,description:'Business-calendar posting for journal '+change.entryNumber,lines:change.evidence.lines});}
  else add({...common,sourceKey:key,postingDate:change.targetDate,description:'Defer returned cost until refund for journal '+change.entryNumber,lines:change.evidence.lines.filter(l=>l.accountId===change.evidence.cogsAccountId&&l.creditMinor>l.debitMinor).flatMap(l=>[{...l,debitMinor:l.creditMinor-l.debitMinor,creditMinor:0},{...l,accountId:undefined,accountKey:'CUSTOMER_RETURN_COST_PENDING',debitMinor:0,creditMinor:l.creditMinor-l.debitMinor}])});
  const id=newId('accountingcorrection');pending.push({id,change,sourceKeys});ids.push(id);
 }
 if(pending.some(p=>p.change.kind==='pending_return_cost'))await ledger.ensureSystemAccountInTransaction(db,ctx,'CUSTOMER_RETURN_COST_PENDING');
 const posted=await ledger.postManyInTransaction(db,ctx,entries),bySource=new Map(posted.map(p=>[p.entry.source_key,p.entry.id]));
 if(pending.length)await db.query('INSERT INTO accounting_history_corrections(id,workspace_id,source_entry_id,kind,target_date,adjustment_entry_ids,evidence,approved_by_user_id) SELECT x.id,$1,x.source_entry_id,x.kind,x.target_date,x.adjustment_entry_ids,x.evidence,$2 FROM jsonb_to_recordset($3::jsonb) x(id text,source_entry_id text,kind text,target_date text,adjustment_entry_ids jsonb,evidence jsonb)',[ctx.workspaceId,ctx.actorId,JSON.stringify(pending.map(({id,change,sourceKeys})=>({id,source_entry_id:change.entryId,kind:change.kind,target_date:change.targetDate,adjustment_entry_ids:sourceKeys.map(k=>bySource.get(k)),evidence:change.evidence})))]);
 return {correctionIds:ids,corrected:ids.length,inventoryMoved:false,paymentCreated:false};
}
module.exports={preview,applyInTransaction};
