ALTER TABLE stockchief_runtime.assistant_action_proposals
  DROP CONSTRAINT IF EXISTS assistant_action_proposals_action_type_check;

ALTER TABLE stockchief_runtime.assistant_action_proposals
  ADD CONSTRAINT assistant_action_proposals_action_type_check CHECK (action_type IN
    ('inventory.receive','inventory.issue','inventory.transfer','inventory.adjust','catalog.create_item','location.create',
     'catalog.set_price','catalog.set_purchase_cost'));
