'use strict';
const {ValidationError}=require('./errors'),exact=require('./exact-quantity');
const state=r=>r?{id:r.id,reorderPoint:r.reorder_point,targetStock:r.target_stock,updatedAt:r.updated_at}:null;
async function prepare(c,ctx,skus,input){
 const locationId=input.locationId||null;if(locationId&&!(await c.query('SELECT 1 FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1',[ctx.workspaceId,locationId])).rows.length)throw new ValidationError('Choose a location in this inventory.');
 if(input.reorderPoint==null||String(input.reorderPoint).trim()==='')throw new ValidationError('Enter the reorder point.');const point=exact.safeNumber(input.reorderPoint,{label:'Reorder point'}),target=input.targetStock==null||String(input.targetStock).trim()===''?null:exact.safeNumber(input.targetStock,{label:'Target stock'});if(point<0||point>1000000000||target!==null&&(target<point||target>1000000000))throw new ValidationError('Use a non-negative reorder point and a target at least that large.');
 const policies=(await c.query('SELECT * FROM reorder_policies WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND location_id IS NOT DISTINCT FROM $3',[ctx.workspaceId,skus.map(s=>s.id),locationId])).rows;const changes=[];
 for(const sku of skus){const before=policies.find(p=>p.sku_id===sku.id),nextTarget=target??(before?.target_stock==null?null:Number(before.target_stock));for(const n of [point,nextTarget].filter(n=>n!==null))require('./stock-quantity').validate(sku,n,{positive:false,total:true});if(nextTarget!==null&&nextTarget<point)throw new ValidationError('The existing target for '+sku.code+' is below the new reorder point. Enter a higher target.');
 changes.push({skuId:sku.id,name:sku.name,code:sku.code,locationId,expectedPolicy:state(before),reorderPoint:point,targetStock:nextTarget,before:'Reorder at '+(before?.reorder_point??'not set')+'; target '+(before?.target_stock??'not set'),after:'Reorder at '+point+'; target '+(nextTarget??'not set')});}
 return changes;
}
async function approve(c,ctx,changes){
 const current=(await c.query('SELECT * FROM reorder_policies WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND location_id IS NOT DISTINCT FROM $3 FOR UPDATE',[ctx.workspaceId,changes.map(r=>r.skuId),changes[0].locationId])).rows;
 for(const change of changes){const prior=current.find(p=>p.sku_id===change.skuId);if(Boolean(prior)!==Boolean(change.expectedPolicy)||prior&&Object.entries(state(prior)).some(([key,value])=>value!==change.expectedPolicy[key]))throw new ValidationError('Reorder settings changed after this review. Prepare the changes again.');}
 await require('../operations/postgres-reorder-policies').setManyInTransaction(c,ctx,changes.map(r=>({skuId:r.skuId,locationId:r.locationId,reorderPoint:r.reorderPoint,targetStock:r.targetStock,notes:current.find(p=>p.sku_id===r.skuId)?.notes||null,source:'manual'})));
}
module.exports={prepare,approve};
