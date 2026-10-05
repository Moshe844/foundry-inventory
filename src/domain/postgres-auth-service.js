'use strict';

const crypto = require('node:crypto');
const auth = require('./auth-service');
const ledger = require('../accounting/postgres-ledger');
const entitlements=require('../entitlements/postgres-service');
const { ValidationError, NotFoundError, RateLimitError } = require('./errors');
const { newId, nowIso, requireText } = require('../lib/util');
const DUMMY_PASSWORD_HASH = auth.hashPassword('stockchief-timing-password');
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_BLOCK_MINUTES = 15;
const LOGIN_LIMITS = { EMAIL:10, IP:40 };

function loginFingerprint(value) {
  return crypto.createHash('sha256').update(String(value || '').trim().toLowerCase()).digest('hex');
}

function loginKeys(emailInput, ip) {
  const keys = [{ scope:'EMAIL', fingerprint:loginFingerprint(emailInput) }];
  if (ip) keys.push({ scope:'IP', fingerprint:loginFingerprint(ip) });
  return keys;
}

async function assertLoginAllowed(database, keys) {
  const blocked = await database.query(`SELECT 1 FROM stockchief_runtime.authentication_attempts
    WHERE (scope,fingerprint) IN (SELECT * FROM unnest($1::text[],$2::text[]))
      AND blocked_until > now() LIMIT 1`, [keys.map((key) => key.scope),keys.map((key) => key.fingerprint)]);
  if (blocked.rows.length) throw new RateLimitError('Too many sign-in attempts. Wait 15 minutes or reset your password.');
}

async function recordLoginFailure(database, keys) {
  for (const key of keys) {
    await database.query(`INSERT INTO stockchief_runtime.authentication_attempts
      (scope,fingerprint,failed_count,window_started_at,blocked_until,updated_at)
      VALUES($1,$2,1,now(),NULL,now())
      ON CONFLICT(scope,fingerprint) DO UPDATE SET
        failed_count=CASE WHEN authentication_attempts.window_started_at < now()-interval '${LOGIN_WINDOW_MINUTES} minutes'
          THEN 1 ELSE authentication_attempts.failed_count+1 END,
        window_started_at=CASE WHEN authentication_attempts.window_started_at < now()-interval '${LOGIN_WINDOW_MINUTES} minutes'
          THEN now() ELSE authentication_attempts.window_started_at END,
        blocked_until=CASE WHEN (CASE WHEN authentication_attempts.window_started_at < now()-interval '${LOGIN_WINDOW_MINUTES} minutes'
          THEN 1 ELSE authentication_attempts.failed_count+1 END) >= $3
          THEN now()+interval '${LOGIN_BLOCK_MINUTES} minutes' ELSE authentication_attempts.blocked_until END,
        updated_at=now()`, [key.scope,key.fingerprint,LOGIN_LIMITS[key.scope]]);
  }
  await database.query(`DELETE FROM stockchief_runtime.authentication_attempts
    WHERE updated_at < now()-interval '7 days'`);
}

async function recordLoginSuccess(database, keys) {
  const emailKey = keys.find((key) => key.scope === 'EMAIL');
  await database.query(`DELETE FROM stockchief_runtime.authentication_attempts
    WHERE scope='EMAIL' AND fingerprint=$1`, [emailKey.fingerprint]);
}

function accountView(row) {
  return row || null;
}

async function getAccount(database, accountId) {
  const result = await database.query('SELECT * FROM accounts WHERE id=$1', [accountId]);
  return accountView(result.rows[0]);
}

async function authenticate(database, emailInput, password, options = {}) {
  const email = String(emailInput || '').trim().toLowerCase();
  const keys = loginKeys(email, options.ip);
  await assertLoginAllowed(database, keys);
  const result = await database.query('SELECT * FROM accounts WHERE email=$1', [email]);
  const account = result.rows[0];
  if (!account) {
    auth.verifyPassword(DUMMY_PASSWORD_HASH, String(password || ''));
    await recordLoginFailure(database, keys);
    return null;
  }
  if (!auth.verifyPassword(account.password_hash, String(password || ''))) {
    await recordLoginFailure(database, keys);
    return null;
  }
  await recordLoginSuccess(database, keys);
  return accountView(account);
}

async function createBusiness(database, input) {
  const name = requireText(input.name, 'Your name', { max: 120 });
  const businessName = requireText(input.businessName, 'Business name', { max: 120 });
  const email = auth.normaliseEmail(input.email);
  const password = auth.checkPasswordStrength(input.password);
  const accountId = newId('acc');
  const workspaceId = newId('wsp');
  const userId = newId('usr');
  const at = input.now || nowIso();
  try {
    return await database.transaction(async (client) => {
      await client.query(`INSERT INTO accounts(id,email,name,password_hash,plan,last_workspace_id,email_verified_at,created_at)
        VALUES($1,$2,$3,$4,'free',$5,$6::timestamptz,$6::text)`,
      [accountId,email,name,auth.hashPassword(password),workspaceId,at]);
      await client.query(`INSERT INTO workspaces(id,name,owner_account_id,data_mode,created_at)
        VALUES($1,$2,$3,'production',$4)`, [workspaceId,businessName,accountId,at]);
      await client.query(`INSERT INTO account_inventory_onboarding(account_id,first_inventory_created_at)
        VALUES($1,$2) ON CONFLICT(account_id) DO NOTHING`, [accountId,at]);
      await client.query(`INSERT INTO users(id,workspace_id,account_id,name,role,created_at)
        VALUES($1,$2,$3,$4,'owner',$5)`, [userId,workspaceId,accountId,name,at]);
      await ledger.configureInTransaction(client, { workspaceId, actorId:userId }, {
        startDate:at.slice(0,10), currency:'USD',
      });
      return { accountId,workspaceId,userId,email,name,businessName };
    }, { isolation:'SERIALIZABLE' });
  } catch (error) {
    if (error.code === '23505' && (error.constraint || '').includes('accounts_email')) {
      throw new ValidationError('An account already uses that email address.', { field:'email' });
    }
    throw error;
  }
}

async function createPendingAccount(database,input){
  const name=requireText(input.name,'Your name',{max:120});
  const businessName=requireText(input.businessName,'Business name',{max:120});
  const email=auth.normaliseEmail(input.email);const password=auth.checkPasswordStrength(input.password);
  const accountId=newId('acc');const at=input.now||nowIso();
  try{const result=await database.query(`INSERT INTO accounts
    (id,email,name,password_hash,plan,pending_business_name,pending_commercial_plan_id,pending_billing_interval,pending_promo_code,created_at)
    VALUES($1,$2,$3,$4,'commercial_pending',$5,$6,$7,NULLIF($8,''),$9) RETURNING *`,[accountId,email,name,auth.hashPassword(password),
    businessName,input.planId||null,input.planId?(input.interval==='annual'?'ANNUAL':'MONTHLY'):null,
    input.planId?String(input.promoCode||'').trim().toUpperCase():'',at]);
    return result.rows[0];}
  catch(error){if(error.code==='23505'&&(error.constraint||'').includes('accounts_email'))
    throw new ValidationError('An account already uses that email address.',{field:'email'});throw error;}
}

async function provisionFirstWorkspace(database,accountId,input={}){
  const account=await getAccount(database,accountId);if(!account)throw new NotFoundError('That account could not be found.');
  const existing=await defaultWorkspaceFor(database,accountId);if(existing)return {workspaceId:existing,created:false};
  const created=await createWorkspace(database,accountId,{name:input.businessName||account.pending_business_name||`${account.name}'s inventory`});
  await database.query(`UPDATE accounts SET pending_business_name=NULL,pending_commercial_plan_id=NULL,
    pending_billing_interval=NULL,pending_promo_code=NULL,plan='paid',last_workspace_id=$2 WHERE id=$1`,[accountId,created.workspaceId]);
  return {...created,created:true};
}

async function createWorkspace(database,accountId,input={}){
  const businessName=requireText(input.name,'Inventory name',{max:120});
  const workspaceId=newId('wsp');const userId=newId('usr');const at=input.now||nowIso();
  return database.transaction(async(client)=>{
    const account=(await client.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[accountId])).rows[0];
    if(!account)throw new NotFoundError('That account could not be found.');
    await entitlements.assertMeterCapacity(client,{accountId,workspaceId:null},'workspaces',1);
    await client.query(`INSERT INTO workspaces(id,name,owner_account_id,data_mode,created_at)
      VALUES($1,$2,$3,'production',$4)`,[workspaceId,businessName,accountId,at]);
    await client.query(`INSERT INTO users(id,workspace_id,account_id,name,role,created_at)
      VALUES($1,$2,$3,$4,'owner',$5)`,[userId,workspaceId,accountId,account.name,at]);
    await ledger.configureInTransaction(client,{workspaceId,actorId:userId},{startDate:at.slice(0,10),currency:'USD'});
    await client.query('UPDATE accounts SET last_workspace_id=$2 WHERE id=$1',[accountId,workspaceId]);
    return {workspaceId,userId,businessName};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function getMembership(database, workspaceId, accountId) {
  const result = await database.query('SELECT * FROM users WHERE workspace_id=$1 AND account_id=$2',
    [workspaceId,accountId]);
  return result.rows[0] || null;
}

async function getWorkspace(database, workspaceId) {
  const result = await database.query(`SELECT * FROM workspaces
    WHERE id=$1 AND deletion_requested_at IS NULL`, [workspaceId]);
  return result.rows[0] || null;
}

async function resolveForAccount(database, accountId, workspaceId) {
  if (!accountId || !workspaceId) return null;
  const result = await database.query(`SELECT w.*,u.id AS membership_id,u.name AS membership_name,
      u.role AS membership_role,u.permissions AS membership_permissions,u.created_at AS membership_created_at
    FROM users u JOIN workspaces w ON w.id=u.workspace_id
    WHERE u.account_id=$1 AND w.id=$2 AND w.deletion_requested_at IS NULL`, [accountId,workspaceId]);
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return { workspace: {
    id:row.id,name:row.name,owner_account_id:row.owner_account_id,data_mode:row.data_mode,
    deletion_requested_at:row.deletion_requested_at,created_at:row.created_at,
  }, membership: {
    id:row.membership_id,workspace_id:row.id,account_id:accountId,name:row.membership_name,
    role:row.membership_role,permissions:row.membership_permissions,created_at:row.membership_created_at,
  } };
}

async function listWorkspacesForAccount(database, accountId) {
  const result = await database.query(`SELECT w.id,w.name,w.created_at,w.owner_account_id,w.data_mode,
      u.id AS membership_id,u.role,
      (SELECT COUNT(*) FROM items i WHERE i.workspace_id=w.id AND i.is_active=1) AS item_count,
      (SELECT COUNT(*) FROM locations l WHERE l.workspace_id=w.id AND l.is_active=1) AS location_count,
      (SELECT COALESCE(SUM(b.on_hand),0) FROM balances b WHERE b.workspace_id=w.id) AS units_on_hand,
      (SELECT COUNT(*) FROM users members WHERE members.workspace_id=w.id) AS member_count
    FROM users u JOIN workspaces w ON w.id=u.workspace_id
    WHERE u.account_id=$1 AND w.deletion_requested_at IS NULL ORDER BY w.created_at,w.name`, [accountId]);
  return result.rows;
}

async function defaultWorkspaceFor(database, accountId) {
  const result = await database.query(`SELECT w.id FROM accounts a
    JOIN users u ON u.account_id=a.id JOIN workspaces w ON w.id=u.workspace_id
    WHERE a.id=$1 AND w.deletion_requested_at IS NULL
    ORDER BY CASE WHEN w.id=a.last_workspace_id THEN 0 ELSE 1 END,w.created_at,w.name LIMIT 1`, [accountId]);
  return result.rows[0]?.id || null;
}

async function rememberWorkspace(database, accountId, workspaceId) {
  const result = await database.query(`UPDATE accounts a SET last_workspace_id=$2 WHERE a.id=$1
    AND EXISTS(SELECT 1 FROM users u WHERE u.account_id=a.id AND u.workspace_id=$2)
    RETURNING id`, [accountId,workspaceId]);
  if (!result.rows.length) throw new NotFoundError('That inventory could not be found.');
  return workspaceId;
}

async function renameWorkspace(database, ctx, nameInput) {
  const name = requireText(nameInput, 'Inventory name', { max:120 });
  const result = await database.query(`UPDATE workspaces w SET name=$3 WHERE w.id=$1
    AND EXISTS(SELECT 1 FROM users u WHERE u.id=$2 AND u.workspace_id=w.id AND u.role='owner') RETURNING *`,
  [ctx.workspaceId,ctx.actorId,name]);
  if(!result.rows.length)throw new NotFoundError('That inventory could not be renamed.');
  return result.rows[0];
}

module.exports = { authenticate,createBusiness,createPendingAccount,provisionFirstWorkspace,createWorkspace,getAccount,getMembership,getWorkspace,resolveForAccount,
  listWorkspacesForAccount,defaultWorkspaceFor,rememberWorkspace,renameWorkspace };
