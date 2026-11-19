'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const approval=new AsyncLocalStorage();

// Authority exists only while trusted server code executes one reviewed user
// decision. Request/model fields cannot create it, and queued jobs do not carry it.
function run(ctx,operation){
 if(typeof ctx?.workspaceId!=='string'||!ctx.workspaceId||typeof ctx?.actorId!=='string'||!ctx.actorId)
  throw new TypeError('An individual approval needs an authenticated inventory and actor.');
 return approval.run(Object.freeze({workspaceId:ctx.workspaceId,actorId:ctx.actorId}),operation);
}
function active(workspaceId){return approval.getStore()?.workspaceId===workspaceId;}
module.exports={run,active};
