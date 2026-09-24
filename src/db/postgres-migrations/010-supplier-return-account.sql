INSERT INTO public.accounting_accounts
  (id,workspace_id,code,name,account_type,subtype,normal_balance,system_key,is_control,active,created_at,updated_at)
SELECT 'acct_supplier_return_' || substr(md5(s.workspace_id),1,20),s.workspace_id,'1410',
  'Supplier returns receivable','ASSET','SUPPLIER_RETURNS','DEBIT','SUPPLIER_CREDITS_RECEIVABLE',1,1,now(),now()
FROM public.accounting_settings s
WHERE s.enabled=1
ON CONFLICT(workspace_id,code) DO NOTHING;
