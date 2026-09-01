'use strict';

// A configurable starting chart, not business-specific data. `systemKey` is
// the stable semantic identity used by deterministic posting rules even when
// an accountant changes the visible code or name.
const DEFAULT_ACCOUNTS = Object.freeze([
  { code: '1000', name: 'Cash', type: 'ASSET', subtype: 'CASH', normal: 'DEBIT', systemKey: 'CASH', control: true },
  { code: '1100', name: 'Accounts receivable', type: 'ASSET', subtype: 'RECEIVABLE', normal: 'DEBIT', systemKey: 'ACCOUNTS_RECEIVABLE', control: true },
  { code: '1200', name: 'Inventory asset', type: 'ASSET', subtype: 'INVENTORY', normal: 'DEBIT', systemKey: 'INVENTORY_ASSET', control: true },
  { code: '1210', name: 'Inventory in transit', type: 'ASSET', subtype: 'INVENTORY_IN_TRANSIT', normal: 'DEBIT', systemKey: 'INVENTORY_IN_TRANSIT', control: true },
  { code: '1300', name: 'Sales tax recoverable', type: 'ASSET', subtype: 'TAX', normal: 'DEBIT', systemKey: 'SALES_TAX_RECOVERABLE', control: true },
  { code: '2000', name: 'Accounts payable', type: 'LIABILITY', subtype: 'PAYABLE', normal: 'CREDIT', systemKey: 'ACCOUNTS_PAYABLE', control: true },
  { code: '2050', name: 'Received, not yet invoiced', type: 'LIABILITY', subtype: 'RECEIVED_NOT_INVOICED', normal: 'CREDIT', systemKey: 'RECEIVED_NOT_INVOICED', control: true },
  { code: '2100', name: 'Sales tax payable', type: 'LIABILITY', subtype: 'TAX', normal: 'CREDIT', systemKey: 'SALES_TAX_PAYABLE', control: true },
  { code: '2200', name: 'Credit cards payable', type: 'LIABILITY', subtype: 'CREDIT_CARD', normal: 'CREDIT', systemKey: 'CREDIT_CARD_PAYABLE', control: true },
  { code: '2300', name: 'Customer deposits', type: 'LIABILITY', subtype: 'CUSTOMER_DEPOSITS', normal: 'CREDIT', systemKey: 'CUSTOMER_DEPOSITS', control: true },
  { code: '1400', name: 'Supplier advances', type: 'ASSET', subtype: 'SUPPLIER_ADVANCES', normal: 'DEBIT', systemKey: 'SUPPLIER_ADVANCES', control: true },
  { code: '3000', name: "Owner's equity", type: 'EQUITY', subtype: 'OWNER_EQUITY', normal: 'CREDIT', systemKey: 'OWNERS_EQUITY', control: false },
  { code: '3100', name: 'Retained earnings', type: 'EQUITY', subtype: 'RETAINED_EARNINGS', normal: 'CREDIT', systemKey: 'RETAINED_EARNINGS', control: true },
  { code: '4000', name: 'Sales revenue', type: 'INCOME', subtype: 'OPERATING_REVENUE', normal: 'CREDIT', systemKey: 'SALES_REVENUE', control: false },
  { code: '4100', name: 'Sales returns and discounts', type: 'INCOME', subtype: 'CONTRA_REVENUE', normal: 'DEBIT', systemKey: 'SALES_RETURNS', control: false },
  { code: '5000', name: 'Cost of goods sold', type: 'COGS', subtype: 'COST_OF_SALES', normal: 'DEBIT', systemKey: 'COST_OF_GOODS_SOLD', control: false },
  { code: '6000', name: 'General operating expense', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', normal: 'DEBIT', systemKey: 'OPERATING_EXPENSE', control: false },
  { code: '6100', name: 'Rent expense', type: 'EXPENSE', subtype: 'RENT', normal: 'DEBIT', systemKey: 'RENT_EXPENSE', control: false },
  { code: '6110', name: 'Utilities', type: 'EXPENSE', subtype: 'UTILITIES', normal: 'DEBIT', systemKey: 'UTILITIES_EXPENSE', control: false },
  { code: '6120', name: 'Payroll', type: 'EXPENSE', subtype: 'PAYROLL', normal: 'DEBIT', systemKey: 'PAYROLL_EXPENSE', control: false },
  { code: '6130', name: 'Shipping and delivery', type: 'EXPENSE', subtype: 'SHIPPING', normal: 'DEBIT', systemKey: 'SHIPPING_EXPENSE', control: false },
  { code: '6140', name: 'Advertising and marketing', type: 'EXPENSE', subtype: 'ADVERTISING', normal: 'DEBIT', systemKey: 'ADVERTISING_EXPENSE', control: false },
  { code: '6150', name: 'Insurance', type: 'EXPENSE', subtype: 'INSURANCE', normal: 'DEBIT', systemKey: 'INSURANCE_EXPENSE', control: false },
  { code: '6160', name: 'Office expenses', type: 'EXPENSE', subtype: 'OFFICE', normal: 'DEBIT', systemKey: 'OFFICE_EXPENSE', control: false },
  { code: '6170', name: 'Professional services', type: 'EXPENSE', subtype: 'PROFESSIONAL_SERVICES', normal: 'DEBIT', systemKey: 'PROFESSIONAL_SERVICES_EXPENSE', control: false },
  { code: '6180', name: 'Taxes and licenses', type: 'EXPENSE', subtype: 'TAXES', normal: 'DEBIT', systemKey: 'TAX_EXPENSE', control: false },
  { code: '6200', name: 'Payment processing fees', type: 'EXPENSE', subtype: 'PROCESSING_FEES', normal: 'DEBIT', systemKey: 'PAYMENT_FEES', control: false },
  { code: '6300', name: 'Inventory adjustments', type: 'EXPENSE', subtype: 'INVENTORY_ADJUSTMENTS', normal: 'DEBIT', systemKey: 'INVENTORY_ADJUSTMENTS', control: false },
  { code: '6400', name: 'Purchase price variance', type: 'EXPENSE', subtype: 'PURCHASE_PRICE_VARIANCE', normal: 'DEBIT', systemKey: 'PURCHASE_PRICE_VARIANCE', control: false },
  { code: '9990', name: 'Opening balance equity', type: 'EQUITY', subtype: 'OPENING_BALANCE', normal: 'CREDIT', systemKey: 'OPENING_BALANCE_EQUITY', control: true },
]);

module.exports = { DEFAULT_ACCOUNTS };
