ALTER TABLE accounting_settings ADD COLUMN start_date_basis TEXT CHECK(start_date_basis IN ('WORKSPACE_CREATION','USER_CHOSEN'));
