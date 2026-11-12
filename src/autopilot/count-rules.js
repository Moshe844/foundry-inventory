'use strict';

const plan = require('../commercial/agent-plan');
const money = require('../domain/currency');
const {ValidationError, AuthorizationError} = require('../domain/errors');
const audit = require('../operations/postgres-security-audit');

async function settings(db, ctx) {
  const state = await plan.accountState(db, ctx.workspaceId);
  const enabled = plan.usesAgentTerms(state) && plan.permits(state.plan, 8, 'automatic');
  const rule = (await db.query('SELECT * FROM stockchief_runtime.agent_count_rules WHERE workspace_id=$1', [ctx.workspaceId])).rows[0];
  return {enabled, rule};
}

async function configure(db, ctx, input) {
  return db.transaction(async client => {
    const {rows: [owner]} = await client.query("SELECT id FROM users WHERE id=$1 AND workspace_id=$2 AND role='owner'", [ctx.actorId, ctx.workspaceId]);
    if (!owner) throw new AuthorizationError('Only the owner can set the stock count limit.');
    if (!['off', 'recount', 'automatic'].includes(input.mode)) throw new ValidationError('Choose a stock count mode.');
    if (input.mode === 'off') {
      await client.query('DELETE FROM stockchief_runtime.agent_count_rules WHERE workspace_id=$1', [ctx.workspaceId]);
    } else {
      const state = await plan.accountState(client, ctx.workspaceId);
      plan.requireJob(plan.usesAgentTerms(state) ? state.plan : null, input.mode === 'automatic' ? 6 : 8, 'automatic');
      const {rows: [books]} = await client.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1', [ctx.workspaceId]);
      if (!books) throw new ValidationError('Set up the inventory currency first.');
      const limit = money.userToMinor(input.limit, books.base_currency);
      if (limit <= 0) throw new ValidationError('Enter a positive limit for the whole count.');
      const present=await client.query('SELECT 1 FROM stockchief_runtime.agent_count_rules WHERE workspace_id=$1',[ctx.workspaceId]);
      await require('../manager/postgres-operating-instructions').checkRuleLimit(client,ctx,[],present.rowCount?0:1);
      await client.query(`INSERT INTO stockchief_runtime.agent_count_rules(workspace_id,authorized_by,currency,limit_minor,automatic)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id) DO UPDATE SET authorized_by=EXCLUDED.authorized_by,
        currency=EXCLUDED.currency,limit_minor=EXCLUDED.limit_minor,automatic=EXCLUDED.automatic,updated_at=now()`,
        [ctx.workspaceId,ctx.actorId,books.base_currency,limit,input.mode === 'automatic']);
    }
    await audit.record(client, ctx, {action:'Stock count rule changed', after:{mode:input.mode, limit:input.mode === 'off' ? null : input.limit}});
  }, {isolation:'SERIALIZABLE', retrySafe:true});
}

async function evaluate(client, ctx, payload, supplied) {
  const {rows:[rule]} = await client.query(`SELECT r.* FROM stockchief_runtime.agent_count_rules r
    JOIN workspaces w ON w.id=r.workspace_id AND w.deletion_requested_at IS NULL
    JOIN users u ON u.id=r.authorized_by AND u.workspace_id=w.id AND u.account_id=w.owner_account_id AND u.role='owner'
    WHERE r.workspace_id=$1 AND r.currency=$2
      AND NOT EXISTS (SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)
    FOR SHARE OF r,w,u`, [ctx.workspaceId,payload.currency]);
  if (!rule || !payload.lines.some(line => line.delta !== 0)) return null;
  const account = await plan.accountState(client, ctx.workspaceId);
  if (!plan.usesAgentTerms(account) || !plan.permits(account.plan,8,'automatic')) return null;
  if (account.shadow) {
    // Job 198: StockChief only watches for its first 14 days. It records whether it
    // would have posted this count under the limit or asked for a recount.
    const exposure = money.sum(payload.lines.map(line => Math.abs(line.costDeltaMinor || 0)));
    const priced = !supplied.some(line => String(line.unitCost ?? '').trim()) && !payload.lines.some(line => line.delta && !line.costDeltaMinor);
    const action = exposure > Number(rule.limit_minor) ? 'recount' : rule.automatic && plan.permits(account.plan,6,'automatic') && priced ? 'post' : null;
    await require('./shadow-mode').fromCount(client, ctx.workspaceId, account, rule, payload, exposure, action);
    return null;
  }
  const state = await require('./postgres-service').getState(client, ctx.workspaceId);
  if (state.paused || state.suspended || state.mode === 'OBSERVE' || account.shadow) return null;
  const exposure = money.sum(payload.lines.map(line => Math.abs(line.costDeltaMinor)));
  const evidence = {owner:rule.authorized_by, currency:rule.currency, limitMinor:Number(rule.limit_minor), exposureMinor:exposure};
  if (exposure > Number(rule.limit_minor)) {
    if(await require('./job-modes').restriction(client,ctx.workspaceId,8,true))return null;
    return {...evidence, action:'recount'};
  }
  if (!rule.automatic || state.mode !== 'POLICY_AUTOMATED' || !plan.permits(account.plan,6,'automatic')) return null;
  if(await require('./job-modes').restriction(client,ctx.workspaceId,6,true))return null;
  // A counter cannot bring an adjustment below the ceiling by entering a lower price.
  if (supplied.some(line => String(line.unitCost ?? '').trim()) || payload.lines.some(line => line.delta && !line.costDeltaMinor)) return null;
  // Job 199: how sure StockChief is about posting this count. Below the owner's level it asks.
  const confidence = require('./confidence'), sure = await confidence.forCount(client, ctx.workspaceId, payload, supplied);
  const unsure = await confidence.stop(client, ctx.workspaceId, sure);
  if (unsure) {
    await audit.record(client, ctx, {action:'Count left for a person: StockChief was not sure enough', reference:payload.location?.id || null,
      after:{level:sure.level, reasons:sure.missing, exposureMinor:exposure, currency:rule.currency}});
    return {...evidence, action:'review', reason:unsure, confidence:sure};
  }
  return {...evidence, action:'post', confidence:sure};
}

module.exports = {settings, configure, evaluate};
