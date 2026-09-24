'use strict';

const fs=require('node:fs');
const path=require('node:path');
const config=require('../config');
const checkpoints=require('./postgres-checkpoints');
const {newId,nowIso}=require('../lib/util');

function check(key,ok,message,evidence={},required=true){
  return {key,status:ok?'PASS':required?'BLOCKED':'WARN',message,evidence,required};
}

function migrationsExpected(){
  return fs.readdirSync(path.join(__dirname,'../db/postgres-migrations'))
    .filter((name)=>/^\d{3}-[a-z-]+\.(?:sql|js)$/.test(name)).length;
}

async function reconciliation(database,workspaceId){
  const row=(await database.query(`WITH movement AS (
      SELECT sku_id,location_id,SUM(quantity_delta) AS quantity FROM movements WHERE workspace_id=$1 GROUP BY sku_id,location_id
    ), balance_difference AS (
      SELECT COALESCE(balance.sku_id,movement.sku_id) AS sku_id,
        COALESCE(balance.location_id,movement.location_id) AS location_id
      FROM balances balance FULL JOIN movement ON movement.sku_id=balance.sku_id AND movement.location_id=balance.location_id
      WHERE COALESCE(balance.workspace_id,$1)=$1 AND COALESCE(balance.on_hand,0)<>COALESCE(movement.quantity,0)
    ), negative AS (
      SELECT balance.sku_id FROM balances balance JOIN skus sku ON sku.id=balance.sku_id JOIN items item ON item.id=sku.item_id
      WHERE balance.workspace_id=$1 AND balance.on_hand<0 AND item.allow_negative=0
    ), journal_difference AS (
      SELECT entry.id FROM accounting_journal_entries entry JOIN accounting_journal_lines line ON line.entry_id=entry.id
      WHERE entry.workspace_id=$1 GROUP BY entry.id HAVING SUM(line.debit_minor)<>SUM(line.credit_minor)
    ), serial_difference AS (
      SELECT sku.id FROM skus sku JOIN items item ON item.id=sku.item_id
      WHERE sku.workspace_id=$1 AND item.tracking_mode='serial' AND
        COALESCE((SELECT SUM(on_hand) FROM balances WHERE workspace_id=$1 AND sku_id=sku.id),0)<>
        (SELECT COUNT(*) FROM serial_units WHERE workspace_id=$1 AND sku_id=sku.id AND status='in_stock')
    ), lot_difference AS (
      SELECT sku.id FROM skus sku JOIN items item ON item.id=sku.item_id
      WHERE sku.workspace_id=$1 AND item.tracking_mode='lot' AND
        COALESCE((SELECT SUM(on_hand) FROM balances WHERE workspace_id=$1 AND sku_id=sku.id),0)<>
        COALESCE((SELECT SUM(lot_balance.quantity) FROM lot_balances lot_balance
          JOIN lots lot ON lot.id=lot_balance.lot_id WHERE lot_balance.workspace_id=$1 AND lot.sku_id=sku.id),0)
    ) SELECT
      (SELECT COUNT(*) FROM balance_difference) AS balance_differences,
      (SELECT COUNT(*) FROM negative) AS prohibited_negative,
      (SELECT COUNT(*) FROM journal_difference) AS unbalanced_journals,
      (SELECT COUNT(*) FROM serial_difference) AS serial_differences,
      (SELECT COUNT(*) FROM lot_difference) AS lot_differences`,[workspaceId])).rows[0];
  const result=Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Number(value)]));
  return {...result,ok:Object.values(result).every((value)=>value===0)};
}

async function snapshot(database,workspaceId,options={}){
  const production=(options.env||'production')==='production';const now=Date.now();
  const [migrationRows,queue,alerts,evidence,integrity]=await Promise.all([
    database.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name'),
    database.query(`SELECT
      COUNT(*) FILTER(WHERE status='DEAD') AS dead,
      COUNT(*) FILTER(WHERE status='RUNNING' AND lease_expires_at<=$2) AS expired,
      COUNT(*) FILTER(WHERE status IN ('PENDING','RETRY') AND available_at<$2-$3) AS overdue
      FROM stockchief_runtime.jobs WHERE workspace_id=$1`,[workspaceId,now,config.operations.maxQueueLagMs]),
    database.query(`SELECT COUNT(*) AS count FROM operational_alerts WHERE workspace_id=$1
      AND status<>'RESOLVED' AND severity IN ('ERROR','CRITICAL')`,[workspaceId]),
    checkpoints.list(database),reconciliation(database,workspaceId),
  ]);
  const checkpoint=new Map(evidence.map((entry)=>[entry.key,entry]));
  const migrationCount=migrationRows.rows.length;const expected=migrationsExpected();const queueRow=queue.rows[0];
  const release=config.operations.releaseRef;const sameRelease=(entry)=>entry?.detail?.releaseRef===release;
  const restore=checkpoint.get('backup.restore');const rollback=checkpoint.get('deployment.rollback');
  const browser=checkpoint.get('browser.regression');const load=checkpoint.get('load.soak');
  const worker=checkpoint.get('worker.throughput');const adversarial=checkpoint.get('adversarial.runtime');
  const checks=[
    check('database',true,'PostgreSQL answered the readiness transaction.',{engine:'postgresql'}),
    check('database_topology',database.topology?.shared===true&&database.topology?.multiWriter===true,
      'The application uses shared multi-writer PostgreSQL.',database.topology||{}),
    check('schema',migrationCount===expected,`${migrationCount} of ${expected} PostgreSQL migrations are applied.`,{migrationCount,expected}),
    check('release_identity',!production||(release&&release!=='development'),release&&release!=='development'
      ?`Immutable release ${release} is identified.`:'FOUNDRY_RELEASE_REF must identify the deployed release.',{releaseRef:release},production),
    check('durable_jobs',Number(queueRow.dead)===0&&Number(queueRow.expired)===0&&Number(queueRow.overdue)===0,
      `${queueRow.dead} dead, ${queueRow.expired} expired and ${queueRow.overdue} overdue workspace jobs.`,queueRow),
    check('incidents',Number(alerts.rows[0].count)===0,Number(alerts.rows[0].count)
      ?`${alerts.rows[0].count} unresolved serious incident(s) remain.`:'No unresolved serious incidents.',{}),
    check('public_origin',!production||/^https:\/\//.test(config.connections.publicOrigin||''),
      config.connections.publicOrigin?'Public callback origin is configured.':'FOUNDRY_PUBLIC_URL is missing.',{},production),
    check('email',!production||config.email.configured,config.email.configured?'Production email sender is configured.':
      'Production password-recovery email is not configured.',{},production),
    check('alerting',!production||Boolean(config.operations.alertWebhookUrl&&config.operations.alertAckToken),
      config.operations.alertWebhookUrl?'External alert delivery is configured.':'External alert delivery is not configured.',{},production),
    check('restore',!production||(restore?.status==='PASS'&&restore.detail?.productionLike===true&&restore.detail?.hostingVerified===true),
      restore?.detail?.hostingVerified?'Hosting restore evidence is recorded.':'No qualifying hosting restore is recorded.',restore||{},production),
    check('rollback',!production||(rollback?.status==='PASS'&&rollback.detail?.hostingVerified===true),
      rollback?.detail?.hostingVerified?'Hosting rollback evidence is recorded.':'No qualifying hosting rollback is recorded.',rollback||{},production),
    check('browser_regression',!production||(browser?.status==='PASS'&&sameRelease(browser)&&browser.detail?.fullSuite===true
      &&Number(browser.detail?.consecutivePasses)>=2),'Two consecutive browser passes must match this release.',browser||{},production),
    check('load_soak',!production||(load?.status==='PASS'&&sameRelease(load)&&load.detail?.budgetsPassed===true
      &&Number(load.detail?.durationSeconds)>=900),'A 15-minute deployed load/soak must pass for this release.',load||{},production),
    check('worker_throughput',!production||(worker?.status==='PASS'&&sameRelease(worker)&&worker.detail?.budgetPassed===true
      &&Number(worker.detail?.jobs)>=1000),'Durable worker throughput must pass for this release.',worker||{},production),
    check('adversarial',!production||(adversarial?.status==='PASS'&&sameRelease(adversarial)
      &&['tenantIsolation','permissions','concurrency','duplicateDelivery','crashMidAction'].every((key)=>adversarial.detail?.[key]===true)),
      'Tenant, permission, concurrency, duplicate and crash tests must pass for this release.',adversarial||{},production),
    check('reconciliation',integrity.ok,integrity.ok?'Inventory identity and journals reconcile.':
      'Inventory identity or accounting reconciliation has differences.',integrity),
  ];
  return {ok:checks.every((entry)=>!entry.required||entry.status==='PASS'),environment:production?'production':'development',
    checks,blockers:checks.filter((entry)=>entry.required&&entry.status!=='PASS').map((entry)=>entry.key)};
}

async function certify(database,workspaceId,options={}){
  const id=newId('cert');const startedAt=nowIso();const applicationRef=options.applicationRef||config.operations.releaseRef;
  await database.query(`INSERT INTO production_certification_runs
    (id,workspace_id,application_ref,environment,status,started_at,summary)
    VALUES($1,$2,$3,'production','RUNNING',$4,'{}')`,[id,workspaceId,applicationRef,startedAt]);
  const state=await snapshot(database,workspaceId,{env:'production'});
  await database.transaction(async(client)=>{
    for(const item of state.checks)await client.query(`INSERT INTO production_certification_checks
      (id,run_id,check_key,status,evidence,checked_at) VALUES($1,$2,$3,$4,$5,$6)`,
    [newId('certcheck'),id,item.key,item.status==='PASS'?'PASS':item.status==='BLOCKED'?'BLOCKED':'SKIPPED',
      JSON.stringify({message:item.message,...item.evidence}),nowIso()]);
    await client.query(`UPDATE production_certification_runs SET status=$2,completed_at=$3,summary=$4 WHERE id=$1`,
      [id,state.ok?'PASSED':'FAILED',nowIso(),JSON.stringify({blockers:state.blockers,
        pass:state.checks.filter((entry)=>entry.status==='PASS').length,total:state.checks.length})]);
  },{isolation:'READ COMMITTED'});
  return {id,status:state.ok?'PASSED':'FAILED',...state};
}

module.exports={check,reconciliation,snapshot,certify};
