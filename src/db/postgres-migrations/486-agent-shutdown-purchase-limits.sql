-- Job 147 on Pro and Custom: the owner's limit for the one purchase draft
-- StockChief prepares on its own for a supplier shutdown. Empty means it
-- only keeps the plan current and every draft waits for the owner.
ALTER TABLE stockchief_runtime.agent_supplier_shutdowns ADD COLUMN maximum_minor bigint CHECK(maximum_minor IS NULL OR maximum_minor>=0);
