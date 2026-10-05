'use strict';
const {newId}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const CATEGORIES=new Set(['ai_work_credits','connected_operations']);
const CATEGORY_FOR=Object.freeze({intelligent_operations:'ai_work_credits',document_pages:'ai_work_credits',processing_units:'ai_work_credits',
 business_communications:'connected_operations',external_events:'connected_operations',shipments_managed:'connected_operations',
 automatic_actions:'connected_operations',accounting_syncs:'connected_operations',api_events:'connected_operations'});
function normalize(input){const category=CATEGORY_FOR[input.meter]||input.meter;
 const units=Number(input.units??1);if(!Number.isSafeInteger(units)||units<1)throw new ValidationError('Usage units must be a positive whole number.');
 if(!input.idempotencyKey||typeof input.idempotencyKey!=='string')throw new ValidationError('Usage requires a stable idempotency key.');
 return {...input,id:input.id||newId('usage'),meter:category,units,
 idempotencyKey:CATEGORY_FOR[input.meter]?`${input.meter}:${input.idempotencyKey}`:input.idempotencyKey,
 detail:{...input.detail,operation:input.detail?.operation||input.meter}};}
async function assertScope(database,scope){if(!scope.accountId)throw new ValidationError('Usage requires its commercial account.');
 if(scope.workspaceId){const found=(await database.query('SELECT 1 FROM workspaces WHERE id=$1 AND owner_account_id=$2',
 [scope.workspaceId,scope.accountId])).rows.length;if(!found)throw new ValidationError('This usage workspace belongs to another commercial account.');}}
async function lock(database,scope,category){await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
 [`commercial-wallet:${scope.accountId}:${category}`]);}
async function balances(database,scope,category,bounds,at=new Date()){
 const totals=(await database.query(`SELECT COALESCE(SUM(a.units) FILTER(WHERE e.status='COMMITTED'),0) AS used,
 COALESCE(SUM(a.units) FILTER(WHERE e.status='RESERVED'),0) AS reserved FROM commercial_usage_allocations a
 JOIN commercial_usage_events e ON e.id=a.event_id WHERE e.account_id=$1 AND e.meter=$2 AND a.grant_id IS NULL
 AND e.occurred_at>=$3 AND e.occurred_at<$4`,[scope.accountId,category,bounds.start,bounds.end])).rows[0];
 const grants=(await database.query(`SELECT g.*,GREATEST(0,g.units-g.revoked_units-g.dispute_hold_units-COALESCE((SELECT SUM(a.units)
 FROM commercial_usage_allocations a JOIN commercial_usage_events e ON e.id=a.event_id
 WHERE a.grant_id=g.id AND e.status IN ('RESERVED','COMMITTED')),0)) AS remaining
 FROM commercial_usage_grants g WHERE g.account_id=$1 AND g.workspace_id=$2 AND g.category=$3
 AND g.expires_at>$4 ORDER BY g.expires_at,g.created_at,g.id`,[scope.accountId,scope.workspaceId||null,category,at])).rows;
 return {includedUsed:Number(totals.used),includedReserved:Number(totals.reserved),grants,
 purchasedRemaining:grants.reduce((sum,g)=>sum+Number(g.remaining),0)};
}
async function allocate(client,event,state){let remaining=Number(event.units);
 const included=Math.min(remaining,state.includedRemaining);if(included>0){await client.query(
 'INSERT INTO commercial_usage_allocations(id,event_id,units) VALUES($1,$2,$3)',[newId('alloc'),event.id,included]);remaining-=included;}
 for(const grant of state.grants||[]){const units=Math.min(remaining,Number(grant.remaining));if(units<=0)continue;
 await client.query('INSERT INTO commercial_usage_allocations(id,event_id,grant_id,units) VALUES($1,$2,$3,$4)',
 [newId('alloc'),event.id,grant.id,units]);remaining-=units;}
 if(remaining)throw new ValidationError('The usage reservation could not be fully funded.');
}
module.exports={CATEGORIES,CATEGORY_FOR,normalize,assertScope,lock,balances,allocate};
