'use strict';

// A clarification belongs to the saved preview. Counts cover the complete
// source, including rows outside the current page and repeated locations.
async function read(database,workspaceId,plan){
 const mappings=plan.fieldMappings||{};
 if(mappings.serialTracked===undefined&&mappings.lotTracked===undefined)return null;
 const result=(await database.query(`WITH source AS (
  SELECT COALESCE(NULLIF(parsed::jsonb->>'code',''),NULLIF(parsed::jsonb->>'name',''),id) AS sku,
   lower(trim(COALESCE(raw::jsonb->>$3::int,''))) IN ('yes','true','1') AS serial_required,
   lower(trim(COALESCE(raw::jsonb->>$4::int,''))) IN ('yes','true','1') AS lot_required,
   problems::jsonb @> '[{"code":"missing_serial"}]'::jsonb OR problems::jsonb @> '[{"code":"serial_quantity"}]'::jsonb AS missing_serial,
   problems::jsonb @> '[{"code":"missing_lot"}]'::jsonb AS missing_lot
  FROM import_rows WHERE workspace_id=$1 AND import_id=$2)
  SELECT count(DISTINCT sku) FILTER (WHERE serial_required)::int serial_skus,
   count(DISTINCT sku) FILTER (WHERE lot_required)::int lot_skus,
   count(DISTINCT sku) FILTER (WHERE missing_serial)::int missing_serial_skus,
   count(DISTINCT sku) FILTER (WHERE missing_lot)::int missing_lot_skus
  FROM source`,[workspaceId,plan.id,mappings.serialTracked??null,mappings.lotTracked??null])).rows[0];
 const answer=plan.transformations?.trackingReview;
 const groups=[['serial','Serial-number',mappings.serialTracked,mappings.serial],['lot','Lot / batch',mappings.lotTracked,mappings.lotCode]]
  .filter(([mode,,index])=>index!==undefined&&result[mode+'_skus']>0)
  .map(([mode,label,,identifier])=>({mode,label,sourceSkus:Number(result[mode+'_skus']),missingSkus:Number(result['missing_'+mode+'_skus']),
   decision:answer?.[mode]||'source',canUseQuantity:identifier===undefined}));
 return groups.length?{kind:'tracking_requirements',state:groups.some(g=>g.missingSkus>0)?'needs_input':answer?'answered':'complete',groups,confirmedAt:answer?.confirmedAt||null}:null;
}
module.exports={read};
