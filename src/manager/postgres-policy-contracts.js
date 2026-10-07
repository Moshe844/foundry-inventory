'use strict';

/**
 * Semantic representation of the standing instructions that the PostgreSQL
 * policy engines actually implement. An unregistered trigger/effect cannot be
 * persisted as if StockChief would later perform it.
 */
const DEFINITIONS=Object.freeze({
  replenishment:{description:'Set a reorder point, target stock, or safety stock for a real SKU. This detects need but grants no purchase authority.',
    trigger:'inventory_position_evaluated',action:'recommend_replenishment',engine:'reorder_policies'},
  supplier_terms:{description:'Store supplier lead time, pack size, minimum quantity, or order multiple for a real supplier and SKU.',
    trigger:'purchase_planning',action:'apply_supplier_terms',engine:'supplier_items'},
  transfer_authority:{description:'Authorize bounded automatic transfers under the existing transfer policy engine.',
    trigger:'autopilot_plan',action:'approve_transfer',engine:'automation_policies'},
  purchase_authority:{description:'Authorize bounded automatic supplier purchase orders under the existing purchasing policy engine.',
    trigger:'autopilot_plan',action:'approve_purchase_order',engine:'automation_policies'},
  operating_preference:{description:'Set the existing target days of stock or transfer-before-purchasing preference.',
    trigger:'planning_evaluation',action:'apply_preference',engine:'operational_preferences'},
  stock_protection:{description:'Block or warn about an outgoing stock issue at a SKU threshold using the existing stock guard.',
    trigger:'inventory_issue_requested',action:'enforce_stock_guard',engine:'operating_guards'},
});
const NAMES=Object.keys(DEFINITIONS);

function compile(change){
  const definition=DEFINITIONS[change?.domain];
  if(!definition)throw new TypeError('Unregistered PostgreSQL policy domain.');
  const removing=change.operation==='remove';
  const scope={skuId:change.skuId||null,supplierId:change.supplierId||null,
    locationId:change.locationId||null,sourceLocationId:change.sourceLocationId||null};
  let condition={};
  if(change.domain==='replenishment')condition={reorderPoint:change.reorderPoint,targetStock:change.targetStock,
    safetyStock:change.safetyStock};
  else if(change.domain==='supplier_terms')condition={leadTimeDays:change.leadTimeDays,
    unitsPerPurchaseUnit:change.unitsPerPurchaseUnit,minimumOrderQuantity:change.minimumOrderQuantity,
    orderMultiple:change.orderMultiple};
  else if(change.domain==='transfer_authority')condition={maximumQuantity:change.maximumQuantity,
    checks:['destination_stockout_risk','source_above_safety','no_conflicting_transfer']};
  else if(change.domain==='purchase_authority')condition={maximumValue:change.maximumValue,
    maximumValuePerWeek:change.weeklyValue,
    checks:['replenishment_evidence','moq_order_multiple_compliant','no_duplicate_incoming_demand','price_within_policy']};
  else if(change.domain==='operating_preference')condition={daysOfStock:change.daysOfStock,
    preferTransferBeforePurchasing:change.preferTransferBeforePurchasing};
  else if(change.domain==='stock_protection')condition={mode:change.guardMode,
    comparator:change.guardComparator,threshold:change.guardThreshold,
    releaseCondition:change.guardReleaseCondition};
  return {version:1,domain:change.domain,trigger:definition.trigger,scope,condition,
    action:definition.action,authority:{approval:'owner_required',automatic:
      ['transfer_authority','purchase_authority'].includes(change.domain)&&!removing},
    notification:{kind:['transfer_authority','purchase_authority'].includes(change.domain)
      ?'existing_work_item':'none'},lifecycle:{state:removing?'revoke_on_approval':'activate_on_approval',
      supersession:'versioned_by_scope'},engine:definition.engine};
}

module.exports={DEFINITIONS,NAMES,compile};
