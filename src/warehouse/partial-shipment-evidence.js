'use strict';

// The same exact physical evidence governs teaching, history and time savings.
function completionSql(alias='p') {
  if (!/^[a-z_]+$/.test(alias)) throw new Error('Invalid internal SQL alias');
  return `${alias}.status='EXECUTED' AND ${alias}.result->>'replayed' IS DISTINCT FROM 'true'
    AND jsonb_array_length(coalesce(${alias}.payload->'partialAllocations','[]'::jsonb))>0
    AND (
      SELECT jsonb_agg(jsonb_build_object('lineId',l.sales_order_line_id,'locationId',l.location_id,'quantity',l.quantity)
        ORDER BY l.sales_order_line_id,l.location_id)
      FROM fulfillment_wave_shipments w
      JOIN sales_shipments s ON s.workspace_id=w.workspace_id AND s.id=w.shipment_id
      JOIN sales_shipment_lines l ON l.workspace_id=s.workspace_id AND l.shipment_id=s.id
      WHERE w.workspace_id=${alias}.workspace_id AND w.wave_id=${alias}.result->>'waveId'
        AND w.sales_order_id=${alias}.payload->>'recordId' AND s.status IN('SHIPPED','DELIVERED') AND s.shipped_at IS NOT NULL
        AND EXISTS(SELECT 1 FROM stockchief_runtime.business_operations o
          WHERE o.workspace_id=s.workspace_id AND o.kind='sales_order.fulfill' AND o.status='COMPLETED'
            AND o.idempotency_key='shipment-handoff:'||s.id)
    )=(SELECT jsonb_agg(v ORDER BY v->>'lineId',v->>'locationId')
       FROM jsonb_array_elements(coalesce(${alias}.payload->'partialAllocations','[]'::jsonb)) v)`;
}

function completedAtSql(alias='p') {
  if (!/^[a-z_]+$/.test(alias)) throw new Error('Invalid internal SQL alias');
  return `(SELECT max(s.shipped_at::timestamptz) FROM fulfillment_wave_shipments w
    JOIN sales_shipments s ON s.workspace_id=w.workspace_id AND s.id=w.shipment_id
    WHERE w.workspace_id=${alias}.workspace_id AND w.wave_id=${alias}.result->>'waveId'
      AND w.sales_order_id=${alias}.payload->>'recordId')`;
}

module.exports={completionSql,completedAtSql};
