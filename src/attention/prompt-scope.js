'use strict';

/**
 * What the planner needs to see for one question.
 *
 * The semantic planner was shown everything on every question: sixty-two
 * intents with their descriptions, eighteen datasets with their fields, the
 * whole product contract — about 13,000 tokens to plan "how many gloves do
 * we have". Most of it was never relevant to the question asked.
 *
 * This decides, in code, which areas a question touches — stock, purchasing,
 * sales and shipping, money, forecasting, connections, StockChief itself —
 * from the words in it, and hands the planner the intents and datasets of
 * those areas plus a core that is always there. A question that names no
 * area at all gets everything, as before, so nothing is lost on the vague
 * ones; a question that names an area gets a prompt about a third the size.
 * The previous turn's dataset and intent are always kept, so a follow-up
 * can continue what it was about.
 */

const AREAS = {
  stock: {
    words: /\b(?:how\s+many|how\s+much|stock|stocked|on\s+hand|in\s+stock|available|units?|left|where\s+(?:is|are)|held|warehouse|store|shop|van|location|locations|count(?:ed)?|quantity|quantities|expir\w*|batch|batches|lot|lots|variant|variants|product|products|sku|skus|item|items|moved|moving|movement|movements|received|issued|adjust(?:ed|ment)?|kit|bom|archived|active|low|short|out\s+of|anything|everything|nothing|something)\b/i,
    intents: ['stock_coverage', 'reorder_settings_review', 'what_to_order'],
    datasets: ['reorder_settings'],
  },
  purchasing: {
    words: /\b(?:supplier|suppliers|vendor|vendors|purchase|purchases|purchasing|po\b|pos\b|po-\d+|order(?:ed|s)?\s+from|on\s+order|reorder|restock|replenish|lead\s+time|deliver(?:y|ies|ed)?|arriv(?:e|ed|ing|al)|incoming|due\s+(?:in|to\s+arrive)|late\s+orders?|cheapest|cost\s+price|last\s+(?:paid|cost)|what\s+(?:we|i)\s+pa(?:y|id)|acknowledg\w*|buy\s+from|bought\s+from|pack\s+size|case\s+of|price\s+list)\b/i,
    intents: ['on_order', 'late_orders', 'open_purchase_orders', 'supplier_order_status', 'supplier_document_changes', 'supplier_price_changes', 'last_cost',
      'suppliers_for_item', 'replenishment', 'what_to_order', 'reorder_settings_review', 'supplier_risk', 'supplier_spend', 'most_reliable_supplier', 'bills_due', 'payables_aging'],
    datasets: ['purchase_orders', 'purchase_order_lines', 'suppliers', 'supplier_items', 'bills', 'payments', 'reorder_settings'],
  },
  sales: {
    words: /\b(?:customer|customers|client|clients|sales?\b|sold|sell|selling|so-\d+|shipment|shipments|shipped|shipping|ship\b|parcel|tracking|carrier|deliver(?:ed|y)\s+to|returned|returns?|refund|invoice|invoices|owes?\s+us|owed\s+to\s+us|receivable|best\s+(?:customer|seller)|top\s+(?:customer|seller)|order(?:s|ed)?\s+(?:from|by)\s+[A-Z]|bought|buy|purchases?\s+(?:from\s+us|by))\b/i,
    intents: ['top_customers', 'selling_price', 'sales_summary', 'shipment_status', 'shipping_exceptions', 'shipping_costs', 'carrier_performance',
      'customer_orders_at_risk', 'stock_coverage', 'customer_payments', 'receivables_aging', 'sale_profit_and_payment', 'top_moving'],
    datasets: ['sales_orders', 'sales_order_lines', 'customers', 'invoices', 'payments', 'shipments', 'returns'],
  },
  money: {
    words: /\b(?:money|cash|bank|profit|profits|loss|losses|margin|margins|revenue|turnover|income|expense|expenses|cogs|cost\s+of\s+goods|owe|owed|owes|owing|debt|bill|bills|invoice|invoices|payable|payables|receivable|receivables|paid|pay|payment|payments|tax|vat|gst|books|ledger|accounting|balance\s+sheet|assets?|liabilit\w*|equity|valuation|worth|in\s+dollars|\$|€|£|financial|finances|spend|spent|spending|budget)\b/i,
    intents: ['financial_summary', 'business_health', 'cash_pressure', 'books_health', 'profit_and_loss', 'balance_sheet', 'cash_position', 'receivables_aging',
      'payables_aging', 'inventory_valuation', 'inventory_selling_value', 'stock_worth', 'sales_tax_summary', 'bills_due', 'customer_payments', 'period_profit_and_customer_cash',
      'sale_profit_and_payment', 'supplier_spend', 'product_profitability', 'location_profitability', 'financial_comparison', 'slow_inventory_value', 'last_cost', 'selling_price'],
    datasets: ['bills', 'invoices', 'payments', 'purchase_orders', 'sales_orders', 'suppliers', 'customers'],
  },
  forecasting: {
    words: /\b(?:forecast|forecasts|predict|prediction|expect(?:ed)?\s+(?:to\s+)?(?:sell|demand|need)|demand|enough\s+(?:for|to)|run\s+out|running\s+out|last\s+(?:until|through)|how\s+long\s+will|will\s+we\s+have|next\s+(?:month|quarter|year|week)|season|winter|summer|christmas|coverage|safety\s+stock|days\s+of\s+stock)\b/i,
    intents: ['demand_forecast', 'stock_coverage', 'why_low', 'replenishment', 'what_to_order', 'most_reliable_supplier', 'idle_stock', 'slow_inventory_value', 'never_stocked', 'out_of_stock'],
    datasets: ['reorder_settings', 'purchase_orders', 'sales_order_lines'],
  },
  connections: {
    words: /\b(?:connection|connections|integration|integrations|connected|sync|synced|syncing|shopify|square|clover|quickbooks|xero|woocommerce|amazon|ebay|etsy|mapping|mappings|unmapped|webhook|feed|last\s+event|api)\b/i,
    intents: ['connection_summary', 'connection_last_event', 'connection_mapping_issues', 'connection_diagnostics', 'capability_status'],
    datasets: [],
  },
  stockchief: {
    words: /\b(?:you|your|yourself|stockchief|foundry|automatic(?:ally)?|autopilot|did\s+you|have\s+you|what\s+have\s+you|why\s+did\s+you|stop\s+(?:doing|moving|ordering)|rules?\b|instruction)\b/i,
    intents: ['foundry_activity', 'foundry_why', 'stop_automation', 'capability_status', 'attention_summary', 'next_attention'],
    datasets: [],
  },
};

/** Always present: the shape of stock, what happened, and the two exits. */
const CORE_INTENTS = ['inventory_summary', 'kit_definition', 'stock_level', 'stock_by_location', 'movement_history', 'recent_adjustments', 'expiring_soon',
  'idle_stock', 'top_moving', 'attention_summary', 'never_stocked', 'out_of_stock', 'why_low', 'next_attention', 'business_health', 'foundry_activity', 'action', 'unsupported'];
const CORE_DATASETS = ['products', 'variants', 'positions', 'movements', 'locations'];

/**
 * @param {string} question
 * @param {{allIntents:string[], allDatasets:string[], previous?:{intent?:string, dataset?:string}|null}} options
 * @returns {{full:boolean, areas:string[], intents:string[], datasets:string[]}}
 */
function scopeFor(question, { allIntents = [], allDatasets = [], previous = null } = {}) {
  const text = String(question || '');
  const areas = Object.keys(AREAS).filter((area) => AREAS[area].words.test(text));
  const keep = (list, all) => all.filter((id) => list.includes(id));
  if (!areas.length) return { full: true, areas: [], intents: allIntents.slice(), datasets: allDatasets.slice() };
  const intents = new Set(CORE_INTENTS);
  const datasets = new Set(CORE_DATASETS);
  for (const area of areas) {
    AREAS[area].intents.forEach((id) => intents.add(id));
    AREAS[area].datasets.forEach((id) => datasets.add(id));
  }
  // A dataset or intent the question names outright is in, whatever the area.
  for (const id of allDatasets) if (new RegExp(`\\b${id.replace(/_/g, '\\s*')}s?\\b`, 'i').test(text)) datasets.add(id);
  for (const id of allIntents) if (new RegExp(`\\b${id.replace(/_/g, '\\s*')}\\b`, 'i').test(text)) intents.add(id);
  // What the last turn was about stays available to a follow-up.
  if (previous && previous.intent) intents.add(previous.intent);
  if (previous && previous.dataset) datasets.add(previous.dataset);
  return { full: false, areas, intents: keep([...intents], allIntents), datasets: keep([...datasets], allDatasets) };
}

module.exports = { scopeFor, AREAS, CORE_INTENTS, CORE_DATASETS };
