-- Job 31: one purchase-change source for each saved supplier document.
CREATE UNIQUE INDEX agent_po_amendment_original_document
  ON stockchief_runtime.supplier_link_submissions(workspace_id,(amendment->'document'->>'id'))
  WHERE kind='amendment' AND amendment ? 'document';
