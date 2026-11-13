'use strict';

// These are the same stored controls counted when an owner grants new rules.
// A bounded probe also handles a Custom account that later chooses a small plan.
const sources=[
 ['agent_draft_rules'],['agent_quote_companion_rules','enabled'],['agent_customer_checkin_rules','enabled'],['agent_transfer_balance_rules'],['agent_supplier_invoice_settings','enabled'],
 ['agent_supplier_return_rules','enabled'],['agent_supplier_cost_rules','enabled'],['agent_stock_protections','enabled'],['agent_customer_invoice_rules'],['agent_invoice_reminder_rules'],
 ['agent_supplier_forecast_rules','enabled'],['agent_return_email_rules'],['agent_return_disposition_rules','enabled'],['agent_customer_order_pages','enabled'],['agent_customer_page_rules','enabled'],
 ['agent_website_stock_chats','enabled'],['agent_channel_copy_sets','enabled'],['agent_contract_reading_settings','enabled'],['lot_certificate_rules','enabled'],['agent_document_filing_scopes','enabled'],
 ['agent_shelf_photo_rules'],['agent_count_source_rules','enabled'],['agent_open_to_buy_rules','enabled'],['agent_slotting_schedules','enabled'],['agent_backup_supplier_rules','enabled'],
 ['agent_blanket_contracts','enabled'],['agent_supplier_term_settings','enabled'],['agent_supplier_term_rules'],['agent_po_date_settings','enabled'],['agent_po_date_rules'],
 ['agent_container_projects','enabled'],['agent_container_rules'],['agent_inbound_freight','routine'],['agent_van_route_rules','enabled'],['agent_direct_rules','enabled'],
 ['agent_direct_orders','routine AND rule_id IS NULL'],['agent_team_procedure_sets','enabled'],['agent_product_retirement_settings','enabled'],['agent_supplier_shutdowns','enabled'],['agent_promotion_stock','enabled'],
 ['agent_quality_policies','enabled'],['agent_rfq_rules','enabled'],['agent_supplier_claim_rules','enabled'],['agent_supplier_delivery_chase_rules','enabled'],['agent_supplier_confirmation_rules','enabled'],
 ['agent_channel_buffer_recipes','active_members>0'],['agent_bin_correction_rules'],['agent_brand_watches'],['agent_count_rules'],['agent_count_schedules'],
 ['agent_putaway_rules'],['recurring_customer_orders','NOT paused'],['channel_map_rules'],['location_reorder_rules'],['daily_cycle_count_rules'],
 ['agent_freight_combine_rules'],['agent_purchase_split_rules'],['supplier_negotiation_rules'],['agent_overdue_order_rules'],['class_service_levels'],
 ['agent_reorder_refresh_rules','enabled'],['agent_backorder_rules','enabled'],['agent_stock_sharing_rules','enabled'],['agent_slow_stock_rules','enabled'],['agent_annual_stocktake_rules','enabled'],['agent_incoming_rules','enabled'],['agent_warehouse_routing_rules','enabled'],['agent_expiry_warning_rules','enabled'],['agent_compliance_schedules','enabled'],['agent_container_order_rules','enabled'],['agent_landed_cost_rules','enabled'],['agent_fx_alert_rules','enabled'],['agent_supplier_benefit_programs','enabled AND claim_limit_minor IS NOT NULL'],['agent_rfq_competition_rules','enabled'],['agent_invoice_dispute_rules','enabled'],['agent_customer_order_limits','enabled'],['agent_channel_fee_rules','enabled'],['agent_net_margin_rules','enabled'],['agent_pick_release_rules','enabled'],['agent_pick_wave_rules','enabled'],['agent_split_rules','enabled'],['agent_shipping_rate_rules','enabled'],['agent_catalog_fix_rules','enabled'],['agent_board_pack_schedules','enabled'],['agent_watch_rules','enabled'],['agent_product_classification_rules','enabled'],['agent_product_retirement_rules','enabled'],['agent_staff_task_rules','enabled'],['agent_channel_buffer_rules','enabled'],['agent_approval_routes','enabled'],['agent_customer_answer_rules','enabled'],['agent_quote_settings','enabled'],['agent_year_end_settings','enabled'],['agent_supplier_choice_rules','enabled'],['agent_edi_retailers','enabled AND automatic'],['agent_3pl_routes','enabled'],['agent_accounting_document_settings','enabled AND send_alone'],['agent_text_order_rules','enabled'],['agent_voice_paperwork_limits','enabled']
];
const limits={starter:5,growth:50,pro:500};
// A database part-way through an upgrade may not have the newest rule tables yet;
// those hold no rules, so only the tables this database has are counted. A
// connection that has them all is remembered.
const complete=new WeakSet();
async function installed(db){
 if(complete.has(db))return sources;
 const {rows}=await db.query(`SELECT t FROM unnest($1::text[]) t WHERE to_regclass('stockchief_runtime.'||t) IS NOT NULL`,[sources.map(([table])=>table)]);
 const present=new Set(rows.map(r=>r.t)),list=sources.filter(([table])=>present.has(table));
 if(list.length===sources.length)complete.add(db);
 return list;
}
const owned='WITH owned AS MATERIALIZED(SELECT id FROM workspaces WHERE owner_account_id=$1 AND deletion_requested_at IS NULL)';
const term=bounded=>([table,predicate])=>`(SELECT count(*) FROM(SELECT 1 FROM stockchief_runtime.${table} t JOIN owned o ON o.id=t.workspace_id ${predicate?'WHERE '+predicate:''}${bounded?' LIMIT $2::int':''}) counted)`;
async function restriction(db,account){
 const limit=Object.hasOwn(limits,account.plan)?limits[account.plan]:undefined;if(limit===undefined)return null;
 if(!account.accountId)return 'Review the account’s saved-rule allowance before automatic work can resume.';
 const configured=(await installed(db)).map(term(true)).concat('0').join('+');
 const row=(await db.query(`${owned}
  SELECT ${configured}+(SELECT count(*) FROM(SELECT 1 FROM stockchief_runtime.agent_instruction_rule_targets t JOIN owned o ON o.id=t.workspace_id WHERE t.active LIMIT $2::int) bounded) AS used,
  EXISTS(SELECT 1 FROM stockchief_runtime.agent_instruction_rule_targets t JOIN owned o ON o.id=t.workspace_id WHERE t.active AND t.unrecognized LIMIT 1) AS unrecognized`,[account.accountId,limit+1])).rows[0];
 if(!row||!Number.isSafeInteger(Number(row.used)))return 'StockChief could not verify the saved-rule allowance. Automatic work is paused for review.';
 if(row.unrecognized)return 'Some saved operating instructions need review before automatic work can resume.';
 if(Number(row.used)>limit)return `Your current plan allows ${limit} active rules across your inventories. Automatic work is paused while saved rules exceed that allowance. Stop or remove extra rules, or upgrade; saved instructions are preserved.`;
 return null;
}
// Every saved rule an owner's inventories hold in the tables above, used when an
// owner saves a new standing instruction (postgres-operating-instructions.js).
async function count(db,accountId){
 const configured=(await installed(db)).map(term(false)).concat('0').join('+');
 return Number((await db.query(`${owned} SELECT ${configured} AS n`,[accountId])).rows[0].n);
}
module.exports={restriction,count,sources,limits};
