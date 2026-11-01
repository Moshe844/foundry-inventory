'use strict';
async function record(db,ctx,{action,reference=null,before={},after={}}){
 await db.query('INSERT INTO security_event_history(id,workspace_id,account_id,actor_id,action,reference,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[require('../lib/util').newId('security'),ctx.workspaceId||null,ctx.accountId||null,ctx.actorId||null,action,reference,before,after]);
}
module.exports={record};
