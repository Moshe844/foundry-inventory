'use strict';

const permissions=require('../actions/permissions');
const ledger=require('../accounting/postgres-ledger');
const catalog=require('../domain/postgres-catalog-service');
const inventory=require('../domain/postgres-inventory-engine');
const paths=require('./postgres-paths');
const {ValidationError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');

async function state(database,workspaceId,accountId=null){
  const [sample,owned,preferences,empty]=await Promise.all([
    database.query('SELECT * FROM workspace_sample_explorations WHERE workspace_id=$1',[workspaceId]),
    accountId?database.query(`SELECT exploration.workspace_id FROM workspace_sample_explorations exploration
      JOIN workspaces workspace ON workspace.id=exploration.workspace_id
      WHERE exploration.origin_workspace_id=$1 AND exploration.created_by_account_id=$2
        AND workspace.deletion_requested_at IS NULL LIMIT 1`,[workspaceId,accountId]):Promise.resolve({rows:[]}),
    database.query('SELECT * FROM workspace_entry_preferences WHERE workspace_id=$1',[workspaceId]),
    database.query('SELECT 1 FROM items WHERE workspace_id=$1 AND is_active=1 LIMIT 1',[workspaceId]),
  ]);
  const row=sample.rows[0];
  return {empty:!empty.rows.length,sample:Boolean(row),originId:row?.origin_workspace_id || null,
    canClear:Boolean(row && row.created_by_account_id===accountId),dismissed:Boolean(preferences.rows[0]?.sample_dismissed_at),
    sampleId:owned.rows[0]?.workspace_id || null};
}

async function ensurePreference(queryable,workspaceId){
  await queryable.query(`INSERT INTO workspace_entry_preferences(workspace_id) VALUES($1)
    ON CONFLICT(workspace_id) DO NOTHING`,[workspaceId]);
}

async function dismiss(database,workspaceId){
  await ensurePreference(database,workspaceId);
  await database.query('UPDATE workspace_entry_preferences SET sample_dismissed_at=$2 WHERE workspace_id=$1',
    [workspaceId,nowIso()]);
}

async function skip(database,workspaceId){
  await ensurePreference(database,workspaceId);
  await database.query('UPDATE workspace_entry_preferences SET skipped_at=$2 WHERE workspace_id=$1',[workspaceId,nowIso()]);
}

async function load(database,ctx,actor,accountId){
  permissions.assertCan(actor,permissions.ADMIN,'load isolated sample data');
  const current=await state(database,ctx.workspaceId,accountId);
  if(current.sample)return ctx.workspaceId;
  if(current.sampleId)return current.sampleId;
  return database.transaction(async(client)=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`sample:${ctx.workspaceId}:${accountId}`]);
    const existing=(await client.query(`SELECT exploration.workspace_id FROM workspace_sample_explorations exploration
      JOIN workspaces workspace ON workspace.id=exploration.workspace_id
      WHERE exploration.origin_workspace_id=$1 AND exploration.created_by_account_id=$2
        AND workspace.deletion_requested_at IS NULL LIMIT 1`,[ctx.workspaceId,accountId])).rows[0];
    if(existing)return existing.workspace_id;
    await client.query(`DELETE FROM workspace_sample_explorations exploration USING workspaces workspace
      WHERE exploration.workspace_id=workspace.id AND exploration.origin_workspace_id=$1
        AND exploration.created_by_account_id=$2 AND workspace.deletion_requested_at IS NOT NULL`,
    [ctx.workspaceId,accountId]);
    const account=(await client.query('SELECT name FROM accounts WHERE id=$1',[accountId])).rows[0];
    if(!account)throw new ValidationError('Your account could not be found.');
    const workspaceId=newId('wsp');const actorId=newId('usr');const locationId=newId('loc');const at=nowIso();
    await client.query(`INSERT INTO workspaces(id,name,owner_account_id,data_mode,created_at)
      VALUES($1,'Sample inventory',$2,'synthetic',$3)`,[workspaceId,accountId,at]);
    await client.query(`INSERT INTO users(id,workspace_id,account_id,name,role,created_at)
      VALUES($1,$2,$3,$4,'owner',$5)`,[actorId,workspaceId,accountId,account.name,at]);
    await ledger.configureInTransaction(client,{workspaceId,actorId},{startDate:at.slice(0,10),currency:'USD'});
    await client.query(`INSERT INTO locations(id,workspace_id,name,kind,barcode,pick_sequence,is_active,created_at)
      VALUES($1,$2,'Sample warehouse','warehouse','SAMPLE-WAREHOUSE',0,1,$3)`,[locationId,workspaceId,at]);
    const sampleContext={workspaceId,actorId};
    for(const product of [
      {name:'Sample coffee beans',code:'SAMPLE-COFFEE',quantity:40},
      {name:'Sample travel mug',code:'SAMPLE-MUG',quantity:24},
      {name:'Sample gift box',code:'SAMPLE-BOX',quantity:12},
    ]){
      const item=await catalog.createItemInTransaction(client,sampleContext,{name:product.name,baseCode:product.code,
        trackingMode:'quantity',unitLabel:'unit',hasVariants:false});
      await inventory.receiveInTransaction(client,sampleContext,{skuId:item.skuIds[0],locationId,quantity:product.quantity,
        reference:'SAMPLE-OPEN',notes:'Disposable sample data, not business evidence.',idempotencyKey:`sample:${product.code}`});
    }
    await client.query(`INSERT INTO workspace_onboarding(workspace_id,path,status,path_chosen_by,started_at,completed_at,updated_at)
      VALUES($1,'fresh','ready','customer',$2,$2,$2) ON CONFLICT(workspace_id) DO UPDATE
      SET path='fresh',status='ready',completed_at=$2,updated_at=$2`,[workspaceId,at]);
    await client.query(`INSERT INTO workspace_sample_explorations(workspace_id,origin_workspace_id,created_by_account_id)
      VALUES($1,$2,$3)`,[workspaceId,ctx.workspaceId,accountId]);
    return workspaceId;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function clear(database,ctx,actor,accountId){
  permissions.assertCan(actor,permissions.ADMIN,'clear disposable sample inventory');
  return database.transaction(async(client)=>{
    const sample=(await client.query(`SELECT exploration.*,workspace.data_mode,workspace.owner_account_id
      FROM workspace_sample_explorations exploration JOIN workspaces workspace ON workspace.id=exploration.workspace_id
      WHERE exploration.workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
    if(!sample || sample.created_by_account_id!==accountId || sample.data_mode!=='synthetic' || sample.owner_account_id!==accountId){
      throw new ValidationError('Only your isolated sample inventory can be cleared here.');
    }
    const at=nowIso();
    await client.query('UPDATE workspaces SET deletion_requested_at=$2 WHERE id=$1',[ctx.workspaceId,at]);
    await client.query(`UPDATE accounts SET last_workspace_id=$2 WHERE id=$1 AND EXISTS(
      SELECT 1 FROM users JOIN workspaces ON workspaces.id=users.workspace_id
      WHERE users.account_id=$1 AND users.workspace_id=$2 AND workspaces.deletion_requested_at IS NULL)`,
    [accountId,sample.origin_workspace_id]);
    return sample.origin_workspace_id;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

module.exports={state,load,clear,dismiss,skip};
