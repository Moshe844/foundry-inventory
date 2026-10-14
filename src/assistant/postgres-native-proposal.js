'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors');
// Detail pages must use the same durable native approval as the chat.
async function find(db,ctx,proposalId){
 const row=(await db.query(`SELECT g.id,g.actor_user_id,g.status,d.key AS delivery_id,d.value AS card
  FROM stockchief_runtime.assistant_goals g CROSS JOIN LATERAL jsonb_each(COALESCE(g.checkpoint#>'{harness,approvalDeliveries}','{}'::jsonb)) d
  WHERE g.workspace_id=$1 AND g.checkpoint->>'runtime'='codex-staging' AND d.value->>'proposalId'=$2 LIMIT 1`,[ctx.workspaceId,proposalId])).rows[0];
 if(row&&row.actor_user_id!==ctx.actorId)throw new AuthorizationError('This agent request belongs to another authorized user.');
 return row||null;
}
async function decide(db,ctx,proposalId,hash,approved,reference){
 const native=await find(db,ctx,proposalId);if(!native)return null;
 const entitlements=require('../commercial/entitlements');
 await entitlements.assertCapability(db,await entitlements.ownerScopeForWorkspace(db,ctx.workspaceId),'ask.prepare_actions');
 if(['COMPLETED','CANCELLED','BLOCKED'].includes(native.status))throw new ValidationError('This agent request is stopped. Return to Ask to review or continue its saved work.');
 const proposal=await require('../manager/postgres-operating-instructions').get(db,ctx.workspaceId,proposalId);
 if(proposal.integrityHash!==hash)throw new ValidationError('The prepared rule changed. Review the current approval card before approving.');
 await require('./postgres-codex-pilot').decide(db,ctx,native.id,native.delivery_id,native.card.sha256,approved,{responseReference:reference});
 return {goalId:native.id};
}
module.exports={find,decide};
