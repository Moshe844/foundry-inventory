'use strict';

// A clarification belongs to the saved preview. Counts cover the complete
// source, including rows outside the current page and repeated locations.
function tracker(mappings){
 const groups=Object.fromEntries(['serial','lot'].map(mode=>[mode,{source:new Set(),missing:new Set()}]));
 const flags=[['serial','serialTracked',['missing_serial','serial_quantity']],['lot','lotTracked',['missing_lot']]].filter(([,field])=>mappings[field]!==undefined);let missingLocationRows=0;
 return {add(rows){for(const row of rows){if(['EXCLUDED','SKIPPED'].includes(row.status))continue;const sku=row.parsed.code||row.parsed.name||row.id;
  if(row.problems.some(p=>p.code==='no_location'))missingLocationRows++;
  for(const [mode,field,codes]of flags){
   if(/^(?:yes|true|1)$/i.test(String(row.raw[mappings[field]]??'').trim()))groups[mode].source.add(sku);
   if(row.problems.some(p=>codes.includes(p.code)))groups[mode].missing.add(sku);
  }
 }},finish(plan){return {version:2,sourceHash:plan.sourceHash,planVersion:plan.planVersion,
  missingLocationRows,serial_skus:groups.serial.source.size,lot_skus:groups.lot.source.size,
  missing_serial_skus:groups.serial.missing.size,missing_lot_skus:groups.lot.missing.size};}};
}

function savedSummary(plan){const cached=plan.transformations?.trackingSummary;
 return cached?.version===2&&cached.sourceHash===plan.sourceHash&&cached.planVersion===plan.planVersion&&
  ['serial_skus','lot_skus','missing_serial_skus','missing_lot_skus'].every(key=>Number.isSafeInteger(cached[key])&&cached[key]>=0)?cached:null;
}

async function read(database,workspaceId,plan){
 if(plan.workspaceId!==workspaceId)throw new(require('../domain/errors').NotFoundError)('That import could not be found.');
 const mappings=plan.fieldMappings||{};
 if(mappings.serialTracked===undefined&&mappings.lotTracked===undefined)return null;
 const cached=savedSummary(plan);
 const result=cached|| (await database.query(`WITH source AS (
  SELECT COALESCE(NULLIF(parsed::jsonb->>'code',''),NULLIF(parsed::jsonb->>'name',''),id) AS sku,
   lower(trim(COALESCE(raw::jsonb->>$3::int,''))) IN ('yes','true','1') AS serial_required,
   lower(trim(COALESCE(raw::jsonb->>$4::int,''))) IN ('yes','true','1') AS lot_required,
   problems::jsonb @> '[{"code":"missing_serial"}]'::jsonb OR problems::jsonb @> '[{"code":"serial_quantity"}]'::jsonb AS missing_serial,
   problems::jsonb @> '[{"code":"missing_lot"}]'::jsonb AS missing_lot
  FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status NOT IN ('EXCLUDED','SKIPPED'))
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
module.exports={read,tracker,savedSummary};
