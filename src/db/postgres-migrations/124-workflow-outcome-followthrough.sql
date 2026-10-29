-- Outcome metadata only. No stock, orders, communications or books are changed.
-- Create the index before inserts queue any deferred foreign-key checks.
CREATE INDEX IF NOT EXISTS idx_workflow_followthrough_due ON work_items(due_at,id)
 WHERE execution_status='EXECUTING' AND source IN('postgres_autopilot','postgres_workflow_owner');
-- The old executor called approval/email delivery "complete". Preserve that
-- historical event and resume supervision of still-open canonical records.
WITH stale AS (
 SELECT w.id,w.workspace_id,w.outcome,w.completed_at FROM work_items w
 WHERE w.source='postgres_autopilot' AND w.execution_status='COMPLETED'
 AND (
  ((w.outcome::jsonb)->>'kind'='purchase' AND EXISTS(
   SELECT 1 FROM purchase_orders p WHERE p.workspace_id=w.workspace_id
    AND p.id=(w.outcome::jsonb)->>'purchaseOrderId' AND p.status NOT IN('RECEIVED','CANCELLED')))
  OR ((w.outcome::jsonb)->>'kind'='transfer' AND EXISTS(
   SELECT 1 FROM inventory_transfers t WHERE t.workspace_id=w.workspace_id
    AND t.id=(w.outcome::jsonb)->>'transferId' AND t.status NOT IN('RECEIVED','CANCELLED')))
 )
), recorded AS (
 INSERT INTO work_item_events(id,workspace_id,work_item_id,event,detail,created_at)
 SELECT 'outcome-followthrough-124:'||id,workspace_id,id,'completion_reopened_for_canonical_outcome',
  jsonb_build_object('priorCompletedAt',completed_at,'priorOutcome',outcome::jsonb,
   'reason','Approval or email delivery did not finish physical receipt and reconciliation.')::text,now()::text
 FROM stale RETURNING work_item_id
)
UPDATE work_items w SET execution_status='EXECUTING',verification_status='PENDING',completed_at=NULL,due_at=now()::text,
 outcome=(w.outcome::jsonb||jsonb_build_object('verified',false,'previousPreparationCompletedAt',w.completed_at,
  'phase','OUTCOME_CHECK_QUEUED','nextAction','Check the current order, physical receipt and reconciliation evidence.'))::text
WHERE w.id IN(SELECT work_item_id FROM recorded);
UPDATE work_items SET due_at=now()::text WHERE source='postgres_autopilot' AND execution_status='EXECUTING' AND due_at IS NULL;
-- Existing open records need the same durable supervision as newly saved ones.
-- This creates monitoring metadata only, and never implies new action authority.
WITH records AS (
 SELECT p.workspace_id,p.id,'purchase' AS kind,p.po_number AS reference,
  'Receive and reconcile the supplier order' AS title,'/purchasing/orders/'||p.id AS href
 FROM purchase_orders p WHERE p.status NOT IN('RECEIVED','CANCELLED')
  AND NOT EXISTS(SELECT 1 FROM work_items a WHERE a.workspace_id=p.workspace_id AND a.source='postgres_autopilot' AND a.outcome::jsonb->>'purchaseOrderId'=p.id)
 UNION ALL
 SELECT b.workspace_id,b.id,'supplier_invoice',b.bill_number,
  'Resolve the supplier invoice and track its payable','/accounting/payables/'||b.id
 FROM accounting_supplier_bills b WHERE b.status NOT IN('PAID','VOID')
 UNION ALL
 SELECT s.workspace_id,s.id,'customer_order',s.order_number,
  'Deliver the customer order and reconcile its payment','/orders/'||s.id
 FROM sales_orders s WHERE s.status<>'CANCELLED'
), adopted AS (
 INSERT INTO work_items(id,workspace_id,category,source,source_evidence,affected_entities,recommended_action,
  confidence,approval_requirement,execution_status,verification_status,idempotency_key,outcome,created_at,due_at)
 SELECT 'workflow-124:'||r.kind||':'||r.id,r.workspace_id,'business_follow_through','postgres_workflow_owner',
  jsonb_build_array(jsonb_build_object('fact','canonical_record','kind',r.kind,'id',r.id))::text,
  jsonb_build_object('kind',r.kind,'recordId',r.id)::text,
  jsonb_build_object('type',r.kind,'recordId',r.id,'displayName',r.reference,'title',r.title,'href',r.href)::text,
  'high','NONE','EXECUTING','PENDING','business-outcome:'||r.kind||':'||r.id,
  jsonb_build_object('kind',r.kind,'recordId',r.id,'ownerActorId',owner.id,'requestedOutcome',r.title,
   'phase','CHECK_QUEUED','nextAction','Check the saved business records','startedAt',now(),
   'nextCheckAt',now(),'adoptedExistingRecord',true)::text,now()::text,now()::text
 FROM records r JOIN workspaces w ON w.id=r.workspace_id AND w.deletion_requested_at IS NULL
 JOIN LATERAL(SELECT u.id FROM users u WHERE u.workspace_id=w.id AND u.account_id=w.owner_account_id AND u.role='owner' ORDER BY u.id LIMIT 1) owner ON true
 ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING id,workspace_id
)
INSERT INTO work_item_events(id,workspace_id,work_item_id,event,detail,created_at)
 SELECT 'adopt-outcome-124:'||id,workspace_id,id,'existing_record_supervision_started',
  '{"migration":124,"businessRecordsChanged":false,"newActionAuthority":false}',now()::text FROM adopted;
