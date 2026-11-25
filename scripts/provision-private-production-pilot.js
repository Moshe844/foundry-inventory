'use strict';

// Run from the private production web service shell using its internal database.
const { randomBytes } = require('node:crypto');
const { parseArgs } = require('node:util');
const config = require('../src/config');
const policy = require('../src/commercial/agent-plan');
const { privateProductionPilot } = require('../src/operations/postgres-production-environment');
const { createPendingAccount, provisionFirstWorkspace } = require('../src/domain/postgres-auth-service');
const { newId, requireText } = require('../src/lib/util');

function assertPilot() {
  if (!privateProductionPilot() || config.commercial.checkoutEnabled || !config.commercial.requirePaidWorkspace) {
    throw new Error('Run this command on the private production pilot with plan enforcement enabled and checkout closed.');
  }
}

async function provision(db, input) {
  assertPilot();
  const plan = String(input.plan || '');
  if (!['starter','growth','pro','enterprise'].includes(plan)) throw new Error('Choose starter, growth, pro, or enterprise.');
  const reason = requireText(input.reason, 'Pilot approval reference', { max: 250 });
  const expiration = new Date(input.expires);
  if (!Number.isFinite(expiration.getTime()) || expiration.getTime() <= Date.now()) {
    throw new Error('Provide a future UTC expiration date and time.');
  }
  const expiry = expiration.toISOString();
  if (input.expires !== expiry && input.expires !== expiry.replace('.000Z','Z')) {
    throw new Error('Use an explicit UTC time, for example 2026-12-31T18:00:00Z.');
  }
  return db.transaction(async client => {
    const version = (await client.query(`SELECT id,configuration FROM commercial_plan_versions WHERE plan_id=$1
      AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1`, [plan])).rows[0];
    if (!version || !policy.usesAgentTerms({ plan,terms:version.configuration })) {
      throw new Error('The selected plan needs an active Agent Plans version.');
    }
    const scoped = { query:client.query.bind(client), transaction:operation=>operation(client) };
    // The owner sets their password through the existing email recovery flow.
    // Nothing is sent by this operator command and the random password is discarded.
    const account = await createPendingAccount(scoped, {
      name:input.name, businessName:input.business, email:input.email,
      password:randomBytes(36).toString('base64url')+'Aa1!', timeZone:input.timezone,
    });
    const subscriptionId = newId('sub');
    await client.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,
      current_period_start,current_period_end,trial_ends_at,source)
      VALUES($1,$2,$3,$4,'TRIALING','CUSTOM',now(),$5::timestamptz,$5::timestamptz,'ADMIN_PRIVATE_PILOT')`,
    [subscriptionId,account.id,plan,version.id,expiry]);
    const { workspaceId } = await provisionFirstWorkspace(scoped,account.id);
    await require('../src/commercial/control-service').audit(client,{
      subjectType:'subscription_grant',subjectId:subscriptionId,action:'created',reason,
      afterState:{accountId:account.id,workspaceId,plan,planVersion:version.id,expiresAt:expiry,source:'ADMIN_PRIVATE_PILOT'},
    });
    return { accountId:account.id,workspaceId,plan,expiresAt:expiry };
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// The live database is Render's stockchief_production or, since the move to AWS, the
// database the move marked live (its marker is readable by the app's logins).
async function liveDatabase(db) {
  const { name } = (await db.query('SELECT current_database() AS name')).rows[0];
  if (name === 'stockchief_production') return true;
  const readable = (await db.query(`SELECT has_schema_privilege(current_user,n.oid,'USAGE')
      AND has_table_privilege(current_user,c.oid,'SELECT') AS ok
    FROM pg_namespace n JOIN pg_class c ON c.relnamespace=n.oid AND c.relname='marker'
    WHERE n.nspname='stockchief_restore'`)).rows[0]?.ok === true;
  return readable && (await db.query("SELECT 1 FROM stockchief_restore.marker WHERE mode='live' LIMIT 1")).rowCount === 1;
}

async function main() {
  assertPilot();
  const options=Object.fromEntries(['name','business','email','plan','expires','timezone','reason'].map(key=>[key,{type:'string'}]));
  const { values } = parseArgs({ options });
  const db = require('../src/db/postgres').openPostgres(process.env.FOUNDRY_DATABASE_URL,{max:1});
  try {
    if (!(await liveDatabase(db))) throw new Error('Use the live production database: Render\'s stockchief_production, or the AWS database marked live after the move.');
    console.log(JSON.stringify(await provision(db,values)));
  } finally {
    await db.close();
  }
}

if (require.main === module) main().catch(error=>{
  console.error(error.code || error.message);
  process.exitCode=1;
});

module.exports = { provision, liveDatabase };
