'use strict';

const {newId,nowIso}=require('../lib/util');

/** Evaluate approved stock-alert rules against their exact recorded stock measure.
 * This runs in the PostgreSQL worker, independently of Ask and even while
 * autonomous purchasing is paused. One crossing creates one owner alert. */
async function evaluate(database,{workspaceId=null}={}){
  const result=await database.query(`SELECT r.*,s.code,i.id AS item_id,i.name AS item_name,
      l.name AS location_name
    FROM stockchief_runtime.stock_threshold_rules r
    JOIN skus s ON s.id=r.sku_id AND s.workspace_id=r.workspace_id AND s.is_active=1
    JOIN items i ON i.id=s.item_id AND i.workspace_id=r.workspace_id AND i.is_active=1
    LEFT JOIN locations l ON l.id=r.location_id AND l.workspace_id=r.workspace_id
    WHERE r.is_active=TRUE AND ($1::text IS NULL OR r.workspace_id=$1)
    ORDER BY r.workspace_id,r.id FOR UPDATE OF r SKIP LOCKED`,[workspaceId]);
  let alerted=0,rearmed=0;
  for(const rule of result.rows){
    const measured=(await database.query(`SELECT
      (SELECT COALESCE(SUM(on_hand),0)::bigint FROM balances
        WHERE workspace_id=$1 AND sku_id=$2 AND ($3::text IS NULL OR location_id=$3)) AS on_hand,
      (SELECT COALESCE(SUM(quantity),0)::bigint FROM (
        SELECT a.quantity FROM sales_order_allocations a
          JOIN sales_order_lines line ON line.id=a.sales_order_line_id AND line.workspace_id=a.workspace_id
          JOIN sales_orders orders ON orders.id=line.sales_order_id AND orders.workspace_id=line.workspace_id
          WHERE a.workspace_id=$1 AND line.sku_id=$2 AND ($3::text IS NULL OR a.location_id=$3)
            AND orders.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
        UNION ALL
        SELECT a.quantity FROM sales_order_kit_allocations a
          JOIN sales_order_kit_components component ON component.id=a.kit_component_id
            AND component.workspace_id=a.workspace_id
          JOIN sales_order_lines line ON line.id=component.sales_order_line_id
            AND line.workspace_id=component.workspace_id
          JOIN sales_orders orders ON orders.id=line.sales_order_id AND orders.workspace_id=line.workspace_id
          WHERE a.workspace_id=$1 AND component.component_sku_id=$2
            AND ($3::text IS NULL OR a.location_id=$3)
            AND orders.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
      ) commitments) AS committed`,
    [rule.workspace_id,rule.sku_id,rule.location_id])).rows[0];
    const onHand=Number(measured.on_hand),committed=Number(measured.committed);
    const metric=rule.metric||'on_hand',comparator=rule.comparator||'at_or_below';
    if(!['on_hand','available_to_fulfill'].includes(metric)||!['below','at_or_below'].includes(comparator))
      throw new Error(`Unsupported approved stock-alert measure for rule ${rule.id}`);
    const observed=metric==='available_to_fulfill'?Math.max(0,onHand-committed):onHand;
    const label=metric==='available_to_fulfill'?'available to fulfill':'on hand';
    const threshold=Number(rule.threshold),triggered=comparator==='below'?observed<threshold:observed<=threshold;
    const comparison=comparator==='below'?'below':'at or below';
    const fingerprint=`stock-threshold:${rule.id}`;const at=nowIso();
    if(triggered&&rule.armed){
      const place=rule.location_name?` at ${rule.location_name}`:'';
      const title=`${rule.item_name}${place} reached ${observed} ${label}`;
      await database.query(`INSERT INTO attention_items
        (id,workspace_id,fingerprint,category,severity,priority_score,title,concise_summary,
         explanation,recommendation,affected_entity_type,affected_entity_ids,item_id,sku_id,
         affected_location_ids,evidence_references,evidence,metrics,related_categories,
         confidence,status,detection_rule_version,first_detected_at,last_evaluated_at)
        VALUES($1,$2,$3,'stock_threshold','important',82,$4,$5,$6,$7,'sku',$8,$9,$10,
          $11,'[]',$12,$13,'[]','high','OPEN','owner-stock-threshold-v1',$14,$14)
        ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',title=EXCLUDED.title,
          concise_summary=EXCLUDED.concise_summary,explanation=EXCLUDED.explanation,
          recommendation=EXCLUDED.recommendation,evidence=EXCLUDED.evidence,metrics=EXCLUDED.metrics,
          first_detected_at=EXCLUDED.first_detected_at,last_evaluated_at=EXCLUDED.last_evaluated_at,
          resolved_at=NULL,resolution_reason=NULL`,[newId('att'),rule.workspace_id,fingerprint,title,
        `${observed} ${label}; your alert fires ${comparison} ${threshold}.`,
        `An approved stock rule asked StockChief to notify you when ${label} is ${comparison} ${threshold}.`,
        'Review replenishment; this alert does not place an order.',JSON.stringify([rule.sku_id]),
        rule.item_id,rule.sku_id,JSON.stringify(rule.location_id?[rule.location_id]:[]),
        JSON.stringify([{fact:metric,value:observed},{fact:'on_hand',value:onHand},
          {fact:'committed',value:committed},{fact:'threshold',value:threshold}]),
        JSON.stringify({metric,comparator,observed,onHand,committed,threshold}),at]);
      await database.query(`UPDATE stockchief_runtime.stock_threshold_rules SET armed=FALSE,updated_at=$2
        WHERE id=$1 AND armed=TRUE`,[rule.id,at]);alerted+=1;
    }else if(!triggered&&!rule.armed){
      await database.query(`UPDATE stockchief_runtime.stock_threshold_rules SET armed=TRUE,updated_at=$2
        WHERE id=$1 AND armed=FALSE`,[rule.id,at]);
      await database.query(`UPDATE attention_items SET status='RESOLVED',resolution_reason=$3,
        resolved_at=$4,last_evaluated_at=$4 WHERE workspace_id=$1 AND fingerprint=$2
        AND status IN ('OPEN','ACKNOWLEDGED')`,[rule.workspace_id,fingerprint,
        'Stock recovered beyond the approved alert level.',at]);rearmed+=1;
    }
  }
  return {checked:result.rows.length,alerted,rearmed};
}

module.exports={evaluate};
