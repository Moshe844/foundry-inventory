
CREATE TABLE stockchief_runtime.quote_buyer_links (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 quote_id text NOT NULL UNIQUE REFERENCES sales_quotations(id) ON DELETE CASCADE,
 customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 published_by text REFERENCES users(id) ON DELETE SET NULL,
 token_hash text NOT NULL UNIQUE,
 token_cipher jsonb NOT NULL,
 offer_hash text NOT NULL,
 offer jsonb NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 routine boolean NOT NULL DEFAULT false,
 maximum_minor bigint CHECK(maximum_minor>0),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 published_at timestamptz NOT NULL DEFAULT now(),
 CHECK(NOT routine OR maximum_minor IS NOT NULL)
);
CREATE INDEX quote_buyer_links_workspace ON stockchief_runtime.quote_buyer_links(workspace_id,published_at);
CREATE INDEX quote_buyer_links_owner ON stockchief_runtime.quote_buyer_links(published_by) WHERE published_by IS NOT NULL;
CREATE INDEX quote_buyer_links_customer ON stockchief_runtime.quote_buyer_links(customer_id);

CREATE TABLE stockchief_runtime.quote_buyer_acceptances (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 quote_id text NOT NULL UNIQUE REFERENCES sales_quotations(id) ON DELETE CASCADE,
 link_id text NOT NULL REFERENCES stockchief_runtime.quote_buyer_links(id) ON DELETE CASCADE,
 link_revision integer NOT NULL,
 offer_hash text NOT NULL,
 buyer_name text NOT NULL,
 buyer_email text NOT NULL,
 acceptance_hash text NOT NULL,
 accepted_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL DEFAULT 'RECEIVED' CHECK(state IN('RECEIVED','HELD','WITHDRAWN','DRAFTED')),
 order_id text UNIQUE REFERENCES sales_orders(id) DEFERRABLE INITIALLY DEFERRED,
 authorized_by text REFERENCES users(id) ON DELETE SET NULL,
 approved_mode text CHECK(approved_mode IN('INDIVIDUAL','ROUTINE')),
 payment_terms jsonb NOT NULL,
 problem text,
 processed_at timestamptz,
 CHECK((state='DRAFTED')=(order_id IS NOT NULL))
);
CREATE INDEX quote_buyer_acceptance_workspace ON stockchief_runtime.quote_buyer_acceptances(workspace_id,accepted_at);
CREATE INDEX quote_buyer_acceptance_link ON stockchief_runtime.quote_buyer_acceptances(link_id);
CREATE INDEX quote_buyer_acceptance_approver ON stockchief_runtime.quote_buyer_acceptances(authorized_by) WHERE authorized_by IS NOT NULL;
CREATE INDEX sales_quotations_successor ON sales_quotations(workspace_id,supersedes_id) WHERE supersedes_id IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.quote_buyer_links'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.quote_buyer_acceptances'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.quote_buyer_links'::regclass,'stockchief_runtime.quote_buyer_acceptances'::regclass);
