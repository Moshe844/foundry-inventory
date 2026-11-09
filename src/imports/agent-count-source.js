'use strict';
const {ValidationError}=require('../domain/errors');
async function check(db,ctx,plan){
 if(plan.transformations.importMode!=='set'||plan.fieldMappings.quantity===undefined)throw new ValidationError('Choose set on-hand quantities and map the actual counted quantity first.');
 if(plan.recordsInvalid||!plan.recordsValid||plan.transformations.proposedLocations?.length)throw new ValidationError('Resolve every counted position using existing products and locations before confirmation.');
 if((plan.sourceKind==='image'||plan.transformations.visualSource)&&plan.transformations.imageReadingConfirmed!==true)throw new ValidationError('Compare every code and quantity with the original image and confirm the reading first.');
 if((await db.query(`SELECT 1 FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status<>'EXCLUDED' AND
   (status NOT IN ('VALID','IMPORTED') OR parsed::jsonb->>'existingSkuId' IS NULL OR parsed::jsonb->>'locationId' IS NULL
    OR parsed::jsonb->>'quantity' IS NULL OR parsed::jsonb->>'trackingMode'<>'quantity'
    OR parsed::jsonb->>'sellingPriceMinor' IS NOT NULL OR coalesce(parsed::jsonb->'reorder','{}'::jsonb)<>'{}'::jsonb
    OR coalesce((parsed::jsonb->>'countQuantityDelta')::numeric,0)>0 AND parsed::jsonb->>'unitCostMinor' IS NULL) LIMIT 1`,[ctx.workspaceId,plan.id])).rowCount)
  throw new ValidationError('Use exact existing quantity-stock positions, without selling-price or reorder changes. Additional stock needs its reviewed purchase cost. Tracked stock needs the serial or batch count workflow.');
}
async function review(db,ctx,{page=1}){
 const history=await require('../commercial/agent-history').access(db,ctx.workspaceId);
 const rows=(await db.query(`SELECT p.source_name AS "Count source",p.records_valid AS "Reviewed positions",CASE WHEN p.status='SUCCEEDED' THEN 'Verified' WHEN p.approval_status='APPROVED' THEN 'Approved; check progress' ELSE 'Needs physical confirmation' END AS "Status",'/imports/'||p.id AS link
  FROM import_plans p WHERE p.workspace_id=$1 AND p.transformations::jsonb->>'agentJob'='5' AND ($2::timestamptz IS NULL OR p.created_at::timestamptz>=$2::timestamptz)
  ORDER BY p.created_at DESC,p.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,history.activityAfter,(page-1)*100])).rows;
 return {rows:rows.slice(0,100),more:rows.length>100,summary:'Saved count sources and their import results. Image readings and physical counts require your confirmation. Blank quantities never mean zero.'};
}
module.exports={check,definition:{id:5,key:'count-sources',label:'Count sheets and reviewed shelf labels',readPage:review}};
