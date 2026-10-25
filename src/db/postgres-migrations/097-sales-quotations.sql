CREATE TABLE sales_quotations (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),customer_id text NOT NULL REFERENCES customers(id),
 quote_number text NOT NULL,input jsonb NOT NULL,pricing jsonb NOT NULL,pricing_hash text NOT NULL,line_labels jsonb NOT NULL,
 valid_until date NOT NULL,status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','ACCEPTED','DECLINED')),
 supersedes_id text REFERENCES sales_quotations(id),sales_order_id text REFERENCES sales_orders(id),
 request_key text NOT NULL,created_by_user_id text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 decided_at timestamptz,UNIQUE(workspace_id,quote_number),UNIQUE(workspace_id,request_key)
);
CREATE INDEX sales_quotations_workspace ON sales_quotations(workspace_id,created_at DESC,id);
CREATE FUNCTION protect_quotation_content() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.workspace_id,NEW.customer_id,NEW.quote_number,NEW.input,NEW.pricing,NEW.pricing_hash,NEW.line_labels,NEW.valid_until,NEW.supersedes_id,NEW.request_key,NEW.created_by_user_id,NEW.created_at)
 IS DISTINCT FROM (OLD.workspace_id,OLD.customer_id,OLD.quote_number,OLD.input,OLD.pricing,OLD.pricing_hash,OLD.line_labels,OLD.valid_until,OLD.supersedes_id,OLD.request_key,OLD.created_by_user_id,OLD.created_at)
 THEN RAISE EXCEPTION 'Quotation terms are immutable; create a revised quotation';END IF;RETURN NEW;END $$;
CREATE TRIGGER sales_quotation_content BEFORE UPDATE ON sales_quotations FOR EACH ROW EXECUTE FUNCTION protect_quotation_content();
