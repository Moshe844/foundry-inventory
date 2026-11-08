'use strict';

const {randomUUID} = require('node:crypto');
const request = require('supertest');
const csrf = html => /name="_csrf" value="([^"]+)"/.exec(html)[1];

async function fixture(t, options) {
  const f = await require('./postgres-shipping-fixture').fixture(t, options);
  const app = require('../../src/postgres-app').createPostgresApp({database:f.db, env:'test', sessionSecret:randomUUID()});
  f.cleanup(() => app.locals.sessionStore.close());
  const browser = request.agent(app);
  const login = await browser.get('/login');
  await browser.post('/login').type('form').send({_csrf:csrf(login.text), email:f.email, password:f.password});
  async function subscribe(tier) {
    await f.db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status)
      VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE'),'ACTIVE')
      ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id`,
      [randomUUID(),f.owner.accountId,tier]);
  }
  return {...f, browser, subscribe, csrf};
}
module.exports = {fixture};
