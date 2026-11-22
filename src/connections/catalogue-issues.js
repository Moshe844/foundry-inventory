'use strict';
// A catalogue choice must have its own still-unmatched source record. An
// unrelated missing SKU on a sale, or a stale issue, remains an actionable issue.
// Both callers use the fixed alias `issue`; this is not user-supplied SQL.
const setupSql=`issue.issue_type IN ('UNKNOWN_SKU','UNKNOWN_LOCATION') AND EXISTS (
 SELECT 1 FROM connection_external_records external
 WHERE external.workspace_id=issue.workspace_id AND external.connector_id=issue.connector_id
 AND external.mapping_status='UNMAPPED'
 AND issue.issue_type='UNKNOWN_'||upper(external.entity_type)
 AND issue.fingerprint IN ('unknown-'||external.entity_type||':'||external.connector_id||':'||external.external_id,
  'UNKNOWN_'||upper(external.entity_type)||':'||external.connector_id||':'||external.external_id))`;
function optionalForAccounting(row){
 return ['xero','quickbooks'].includes(row.provider_type)&&row.accounting_verified===true;
}
module.exports={setupSql,optionalForAccounting};
