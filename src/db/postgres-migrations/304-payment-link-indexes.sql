-- Payments are read by the order they were taken for, by the entry that
-- booked them, and by the invoices or bills they paid. The reconciliation
-- checks, deposit refunds and voids all follow those links, so each needs an
-- index; without one every lookup reads every payment in the table.
CREATE INDEX IF NOT EXISTS ix_acc_payments_sales_order ON accounting_payments (workspace_id, sales_order_id) WHERE sales_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_acc_payments_journal_entry ON accounting_payments (journal_entry_id);
CREATE INDEX IF NOT EXISTS ix_acc_payment_allocations_payment ON accounting_payment_allocations (payment_id);
