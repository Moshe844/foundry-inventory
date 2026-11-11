CREATE UNIQUE INDEX agent_po_amendment_original_mail
  ON stockchief_runtime.supplier_link_submissions(workspace_id,(amendment->'mail'->>'id'))
  WHERE kind='amendment' AND amendment ? 'mail';
