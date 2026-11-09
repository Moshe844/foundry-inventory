ALTER TABLE supplier_communications ADD COLUMN invoice_dispute_bill_id text REFERENCES accounting_supplier_bills(id);
CREATE INDEX supplier_invoice_dispute_message ON supplier_communications(workspace_id,invoice_dispute_bill_id) WHERE invoice_dispute_bill_id IS NOT NULL;
CREATE INDEX supplier_invoice_dispute_bill_reference ON supplier_communications(invoice_dispute_bill_id) WHERE invoice_dispute_bill_id IS NOT NULL;
ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase','customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute'));
