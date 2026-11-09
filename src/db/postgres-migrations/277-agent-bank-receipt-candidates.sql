-- Bounded receipt batches must not scan a complete bank history or catalogue.
CREATE INDEX accounting_bank_receipt_candidates ON accounting_bank_transactions(workspace_id,transaction_date,id)
  WHERE status='UNMATCHED' AND amount_minor>0;
-- Historical invoice numbers are case sensitive. Keep them intact and require
-- individual review when a bank's case-insensitive reference is ambiguous.
CREATE INDEX accounting_customer_invoice_reference ON accounting_customer_invoices(workspace_id,lower(invoice_number));

ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
  'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
  'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase','customer-receipt'));
