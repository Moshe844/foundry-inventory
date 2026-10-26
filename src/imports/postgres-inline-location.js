'use strict';
const {ValidationError}=require('../domain/errors'),P=require('../actions/permissions');
async function create(db,ctx,id,input){return db.transaction(async c=>{
 const actor=(await c.query('SELECT * FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];P.assertCan(actor,P.ADMIN,'create a stock location');
 const plan=(await c.query('SELECT * FROM import_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
 if(!plan||plan.status!=='READY'||plan.approval_status!=='AWAITING_APPROVAL'||plan.integrity_hash!==input.expectedHash)throw new ValidationError('This preview changed. Review it before adding a location.');
 const location=await require('../domain/postgres-location-service').createLocationInTransaction(c,ctx,{name:input.name,kind:input.kind||'warehouse'});
 const scoped={query:c.query.bind(c),transaction:fn=>fn(c)};
 const revision=await require('./postgres-preview-revisions').queue(scoped,ctx,id,{expectedHash:input.expectedHash,defaultLocationId:location.id});
 return {location,revision};
 },{isolation:'SERIALIZABLE',retrySafe:true});}
module.exports={create};
