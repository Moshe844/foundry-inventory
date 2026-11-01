CREATE INDEX IF NOT EXISTS ix_webhook_active_workspace ON outbound_webhook_subscriptions(workspace_id) WHERE status='ACTIVE';
ALTER TABLE outbound_webhook_deliveries ADD COLUMN payload JSONB;
CREATE INDEX ix_webhook_delivery_workspace_recent ON outbound_webhook_deliveries(workspace_id,created_at DESC,id DESC);

CREATE FUNCTION stockchief_capture_webhook_events(events JSONB) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 WITH incoming AS MATERIALIZED(SELECT * FROM jsonb_to_recordset(events) x(id text,workspace_id text,event_type text,payload jsonb,created_at text)),
 saved AS(INSERT INTO domain_events(id,workspace_id,event_type,payload,source,idempotency_key,status,result,created_at,processed_at)
 SELECT id,workspace_id,event_type,payload::text,'stockchief.webhooks',id,'PROCESSED','{}',created_at,created_at FROM incoming ON CONFLICT DO NOTHING RETURNING *),
 deliveries AS(INSERT INTO outbound_webhook_deliveries(id,workspace_id,subscription_id,domain_event_id,event_type,payload_hash,payload,created_at)
 SELECT 'whdel_'||md5(s.id||':'||e.id),e.workspace_id,s.id,e.id,e.event_type,md5(e.payload),jsonb_build_object('id',e.id,'type',e.event_type,'workspaceId',e.workspace_id,'occurredAt',e.created_at,'data',e.payload::jsonb),e.created_at
 FROM saved e JOIN outbound_webhook_subscriptions s ON s.workspace_id=e.workspace_id AND s.status='ACTIVE' AND s.event_types::jsonb ? e.event_type
 ON CONFLICT(subscription_id,domain_event_id) DO NOTHING RETURNING *)
 INSERT INTO stockchief_runtime.jobs(id,workspace_id,kind,payload,priority,max_attempts,available_at,idempotency_key,created_at,updated_at)
 SELECT 'whjob_'||d.id,d.workspace_id,'webhook.deliver',jsonb_build_object('deliveryId',d.id),80,12,floor(extract(epoch FROM clock_timestamp())*1000)::bigint,d.id,now(),now() FROM deliveries d ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION stockchief_capture_stock_webhooks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- One indexed subscription check per statement, with no event copies for inventories without subscribers.
 IF NOT EXISTS(SELECT 1 FROM webhook_stock_rows r JOIN outbound_webhook_subscriptions s ON s.workspace_id=r.workspace_id AND s.status='ACTIVE' AND s.event_types::jsonb ? 'stock.changed') THEN RETURN NULL; END IF;
 PERFORM stockchief_capture_webhook_events(jsonb_agg(jsonb_build_object('id','whevt_'||md5('movement:'||r.id),'workspace_id',r.workspace_id,'event_type','stock.changed','created_at',r.occurred_at,'payload',jsonb_build_object('movementId',r.id,'skuId',r.sku_id,'itemId',r.item_id,'locationId',r.location_id,'quantityDelta',r.quantity_delta::text,'onHand',r.balance_after::text,'operation',r.operation))))
 FROM webhook_stock_rows r WHERE EXISTS(SELECT 1 FROM outbound_webhook_subscriptions s WHERE s.workspace_id=r.workspace_id AND s.status='ACTIVE' AND s.event_types::jsonb ? 'stock.changed');
 RETURN NULL;
END $$;
CREATE TRIGGER capture_stock_webhooks AFTER INSERT ON movements REFERENCING NEW TABLE AS webhook_stock_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_capture_stock_webhooks();

CREATE FUNCTION stockchief_capture_order_webhooks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; data jsonb;
BEGIN
 IF TG_TABLE_NAME='sales_order_events' THEN
  IF NEW.event_type<>'created' THEN RETURN NEW; END IF;
  kind:='order.created';data:=jsonb_build_object('orderId',NEW.sales_order_id,'detail',NEW.detail::jsonb);
 ELSE
  IF NEW.event<>'received' THEN RETURN NEW; END IF;
  kind:='purchase_order.received';data:=jsonb_build_object('purchaseOrderId',NEW.purchase_order_id,'detail',NEW.detail::jsonb);
 END IF;
 IF EXISTS(SELECT 1 FROM outbound_webhook_subscriptions s WHERE s.workspace_id=NEW.workspace_id AND s.status='ACTIVE' AND s.event_types::jsonb ? kind) THEN
  PERFORM stockchief_capture_webhook_events(jsonb_build_array(jsonb_build_object('id','whevt_'||md5(TG_TABLE_NAME||':'||NEW.id),'workspace_id',NEW.workspace_id,'event_type',kind,'created_at',NEW.created_at,'payload',data)));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_sales_webhooks AFTER INSERT ON sales_order_events FOR EACH ROW EXECUTE FUNCTION stockchief_capture_order_webhooks();
CREATE TRIGGER capture_purchase_webhooks AFTER INSERT ON purchase_order_events FOR EACH ROW EXECUTE FUNCTION stockchief_capture_order_webhooks();
