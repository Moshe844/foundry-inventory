'use strict';

// These are the same stored controls counted when an owner grants new rules.
// A bounded probe also handles a Custom account that later chooses a small plan.
const sources=[
 ['agent_draft_rules'],['agent_quote_companion_rules','enabled'],['agent_customer_checkin_rules','enabled'],['agent_transfer_balance_rules'],['agent_supplier_invoice_settings','enabled'],['agent_customer_invoice_rules'],['agent_invoice_reminder_rules'],['agent_supplier_forecast_rules','enabled'],['agent_return_email_rules'],['agent_return_disposition_rules','enabled'],['agent_customer_order_pages','enabled'],['agent_customer_page_rules','enabled'],['agent_website_stock_chats','enabled'],['agent_channel_copy_sets','enabled'],['agent_contract_reading_settings','enabled'],['lot_certificate_rules','enabled'],['agent_document_filing_scopes','enabled'],['agent_shelf_photo_rules'],['agent_count_source_rules','enabled'],['agent_open_to_buy_rules','enabled'],['agent_supplier_return_rules','enabled'],['agent_backup_supplier_rules','enabled'],['agent_blanket_contracts','enabled'],
 ['agent_supplier_term_settings','enabled'],['agent_supplier_term_rules'],['agent_po_date_settings','enabled'],['agent_po_date_rules'],
 ['agent_container_projects','enabled'],['agent_container_rules'],['agent_inbound_freight','routine'],['agent_van_route_rules','enabled'],
 ['agent_direct_rules','enabled'],['agent_direct_orders','routine AND rule_id IS NULL'],
 ['agent_team_procedure_sets','enabled'],['agent_product_retirement_settings','enabled'],
 ['agent_supplier_shutdowns','enabled'],['agent_promotion_stock','enabled'],['agent_quality_policies','enabled'],['agent_rfq_rules','enabled'],['agent_supplier_claim_rules','enabled'],['agent_supplier_delivery_chase_rules','enabled'],['agent_supplier_confirmation_rules','enabled'],['agent_channel_buffer_recipes','active_members>0'],['agent_bin_correction_rules'],['agent_brand_watches'],['agent_count_rules'],['agent_count_schedules'],['agent_putaway_rules'],
 ['recurring_customer_orders','NOT paused'],['channel_map_rules'],['location_reorder_rules'],['daily_cycle_count_rules'],['agent_freight_combine_rules'],
 ['agent_purchase_split_rules'],['supplier_negotiation_rules'],['agent_overdue_order_rules'],['class_service_levels'],['agent_slotting_schedules','enabled']
];
const limits={starter:5,growth:50,pro:500};
const configured=sources.map(([table,predicate])=>`(SELECT count(*) FROM(SELECT 1 FROM stockchief_runtime.${table} t JOIN owned o ON o.id=t.workspace_id ${predicate?'WHERE '+predicate:''} LIMIT $2::int) bounded)`).join('+');
const sql=`WITH owned AS MATERIALIZED(SELECT id FROM workspaces WHERE owner_account_id=$1 AND deletion_requested_at IS NULL)
 SELECT ${configured}+(SELECT count(*) FROM(SELECT 1 FROM stockchief_runtime.agent_instruction_rule_targets t JOIN owned o ON o.id=t.workspace_id WHERE t.active LIMIT $2::int) bounded) AS used,
 EXISTS(SELECT 1 FROM stockchief_runtime.agent_instruction_rule_targets t JOIN owned o ON o.id=t.workspace_id WHERE t.active AND t.unrecognized LIMIT 1) AS unrecognized`;
async function restriction(db,account){
 const limit=Object.hasOwn(limits,account.plan)?limits[account.plan]:undefined;if(limit===undefined)return null;
 if(!account.accountId)return 'Review the account’s saved-rule allowance before automatic work can resume.';
 const row=(await db.query(sql,[account.accountId,limit+1])).rows[0];
 if(!row||!Number.isSafeInteger(Number(row.used)))return 'StockChief could not verify the saved-rule allowance. Automatic work is paused for review.';
 if(row.unrecognized)return 'Some saved operating instructions need review before automatic work can resume.';
 if(Number(row.used)>limit)return `Your current plan allows ${limit} active rules across your inventories. Automatic work is paused while saved rules exceed that allowance. Stop or remove extra rules, or upgrade; saved instructions are preserved.`;
 return null;
}
module.exports={restriction,sources,limits};
