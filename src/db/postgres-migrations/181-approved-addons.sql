-- Snapshot the allocation scope at purchase. Prior workspace-specific grants
-- remain unchanged; only newly accepted account-wide packs are shared.
ALTER TABLE commercial_usage_packs ADD COLUMN allocation_scope text NOT NULL DEFAULT 'INVENTORY' CHECK(allocation_scope IN('ACCOUNT','INVENTORY'));
ALTER TABLE commercial_usage_purchases ADD COLUMN allocation_scope text NOT NULL DEFAULT 'INVENTORY' CHECK(allocation_scope IN('ACCOUNT','INVENTORY'));
ALTER TABLE commercial_usage_grants ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE commercial_model_grant_budgets ALTER COLUMN workspace_id DROP NOT NULL;
INSERT INTO commercial_usage_packs(id,category,version,units,amount_minor,currency,status,expires_months,
 provider_cost_budget_minor,conservative_cost_per_credit_minor,cost_model_key,cost_budget_source,approved_model_rate_ceiling,max_provider_cost_share,credit_unit_scale,allocation_scope)
SELECT replace(id,'-v3','-v4'),category,4,units,amount_minor,currency,'APPROVED',expires_months,
 provider_cost_budget_minor*1.1,conservative_cost_per_credit_minor,cost_model_key,cost_budget_source||' Approved v4 adds a 10 percent provider failure reserve without charging credits for failed AI work.',approved_model_rate_ceiling,max_provider_cost_share,credit_unit_scale,'ACCOUNT'
FROM commercial_usage_packs WHERE id IN('ai-2500-v3','ai-10000-v3');
INSERT INTO commercial_usage_packs(id,category,version,units,amount_minor,status,allocation_scope) VALUES
 ('incoming-10000-v4','incoming_emails',4,10000,1500,'APPROVED','ACCOUNT'),
 ('emails-10000-v4','emails_sent',4,10000,1500,'APPROVED','ACCOUNT'),
 ('ops-100000-v4','connected_operations',4,100000,9900,'APPROVED','ACCOUNT');
-- Price IDs remain unset until independently verified in the matching Stripe
-- mode. Approval never enables live checkout or finances real staging AI.
UPDATE commercial_capacity_products SET entitlements='{"members":1}' WHERE id='extra-user';
UPDATE commercial_capacity_products SET label='Extra inventory: 1,000 products, 5,000 SKUs and 1 GB storage',entitlements='{"workspaces":1,"products":1000,"active_skus":5000,"storage_bytes":1000000000}' WHERE id='extra-inventory';
UPDATE commercial_capacity_products SET label='10 extra warehouses and 500 bins in one inventory',entitlements='{"locations":10,"sublocations":500}',capacity_scope='INVENTORY' WHERE id='extra-locations';
INSERT INTO commercial_capacity_products(id,label,meter,units_per_pack,monthly_amount_minor,display_order,entitlements) VALUES
 ('extra-connections','5 extra connections','connections',5,2900,4,'{"connections":5}'),
 ('extra-storage','10 GB extra stored business data','storage_bytes',1000000000,900,5,'{"storage_bytes":10000000000}');
