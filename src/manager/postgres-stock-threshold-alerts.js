'use strict';

const {newId,nowIso}=require('../lib/util');

/** Evaluate approved stock-alert rules against physical on-hand balances.
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
    const measured=(await database.query(`SELECT COALESCE(SUM(on_hand),0)::bigint AS on_hand
      FROM balances WHERE workspace_id=$1 AND sku_id=$2
        AND ($3::text IS NULL OR location_id=$3)`,
    [rule.workspace_id,rule.sku_id,rule.location_id])).rows[0];
    const onHand=Number(measured.on_hand),threshold=Number(rule.threshold);
    const fingerprint=`stock-threshold:${rule.id}`;const at=nowIso();
    if(onHand<=threshold&&rule.armed){
      const place=rule.location_name?` at ${rule.location_name}`:'';
      const title=`${rule.item_name}${place} reached ${onHand} on hand`;
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
        `${onHand} on hand; your alert level is ${threshold}.`,
        'An approved stock rule asked StockChief to notify you at or below this level.',
        'Review replenishment; this alert does not place an order.',JSON.stringify([rule.sku_id]),
        rule.item_id,rule.sku_id,JSON.stringify(rule.location_id?[rule.location_id]:[]),
        JSON.stringify([{fact:'on_hand',value:onHand},{fact:'threshold',value:threshold}]),
        JSON.stringify({onHand,threshold}),at]);
      await database.query(`UPDATE stockchief_runtime.stock_threshold_rules SET armed=FALSE,updated_at=$2
        WHERE id=$1 AND armed=TRUE`,[rule.id,at]);alerted+=1;
    }else if(onHand>threshold&&!rule.armed){
      await database.query(`UPDATE stockchief_runtime.stock_threshold_rules SET armed=TRUE,updated_at=$2
        WHERE id=$1 AND armed=FALSE`,[rule.id,at]);
      await database.query(`UPDATE attention_items SET status='RESOLVED',resolution_reason=$3,
        resolved_at=$4,last_evaluated_at=$4 WHERE workspace_id=$1 AND fingerprint=$2
        AND status IN ('OPEN','ACKNOWLEDGED')`,[rule.workspace_id,fingerprint,
        'Stock recovered above the approved alert level.',at]);rearmed+=1;
    }
  }
  return {checked:result.rows.length,alerted,rearmed};
}

module.exports={evaluate};
