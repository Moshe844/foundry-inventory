-- Job 71: the fleet rule now carries what StockChief needs to plan on its own:
-- the vans and drivers it covers, the time of day it plans and the days the
-- vans go out. planned_for claims each delivery day once.
ALTER TABLE stockchief_runtime.agent_van_route_rules
  ADD COLUMN vans jsonb,
  ADD COLUMN plan_at smallint NOT NULL DEFAULT 900 CHECK (plan_at BETWEEN 0 AND 1439),
  ADD COLUMN delivery_days smallint[] NOT NULL DEFAULT '{1,2,3,4,5}'
    CHECK (cardinality(delivery_days) BETWEEN 1 AND 7 AND delivery_days <@ '{1,2,3,4,5,6,7}'::smallint[]),
  ADD COLUMN planned_for date;

-- Rules saved before this change take the vans of the latest route planned
-- for the same depot and fleet.
UPDATE stockchief_runtime.agent_van_route_rules r SET vans=x.facts->'vans'
FROM (SELECT DISTINCT ON (workspace_id,depot_id,fleet_key) workspace_id,depot_id,fleet_key,facts
  FROM stockchief_runtime.agent_van_routes ORDER BY workspace_id,depot_id,fleet_key,created_at DESC,id DESC) x
WHERE x.workspace_id=r.workspace_id AND x.depot_id=r.depot_id AND x.fleet_key=r.fleet_key;

-- A route the routine prepared but did not publish waits in Needs you with the reason.
ALTER TABLE stockchief_runtime.agent_van_routes
  ADD COLUMN prepared_by_routine boolean NOT NULL DEFAULT false,
  ADD COLUMN waiting_reason text;
CREATE INDEX agent_van_routes_waiting ON stockchief_runtime.agent_van_routes(workspace_id,delivery_date)
  WHERE status='DRAFT' AND prepared_by_routine;
