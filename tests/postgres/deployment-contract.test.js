'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { connectionOptions } = require('../../src/db/postgres');

const root = path.resolve(__dirname, '../..');

test('Render staging deploys separate PostgreSQL web and worker processes against the existing private database', () => {
  const blueprint = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
  assert.match(blueprint, /generation:\s+off/);
  assert.match(blueprint, /name:\s+stockchief-staging\b/);
  assert.match(blueprint, /name:\s+stockchief-staging-web\b[\s\S]*startCommand:\s+npm run start:postgres-web/);
  assert.match(blueprint, /name:\s+stockchief-staging-worker\b[\s\S]*startCommand:\s+npm run start:postgres-worker/);
  assert.equal((blueprint.match(/repo:\s+https:\/\/github\.com\/Moshe844\/foundry-inventory/g) || []).length, 2);
  assert.equal((blueprint.match(/property:\s+connectionString/g) || []).length, 2);
  assert.equal((blueprint.match(/fromGroup:\s+stockchief-staging-runtime/g) || []).length, 2);
  assert.equal((blueprint.match(/preDeployCommand:\s+npm run db:apply:postgres/g) || []).length, 2);
  assert.match(blueprint, /healthCheckPath:\s+\/readyz/);
  assert.equal((blueprint.match(/autoDeployTrigger:\s+off/g) || []).length, 2);
  assert.match(blueprint, /key:\s+SESSION_SECRET\s+generateValue:\s+true/);
  assert.match(blueprint, /key:\s+FOUNDRY_CONNECTION_ENCRYPTION_KEY\s+generateValue:\s+true/);
  assert.match(blueprint, /key:\s+FOUNDRY_DATABASE_PRIVATE_NETWORK\s+value:\s+"true"/);
  assert.doesNotMatch(blueprint, /DATABASE_PATH|FOUNDRY_DATA_DIR|better-sqlite3|disk:/);
});

test('PostgreSQL transport is explicit for private networks and fail-closed everywhere else', () => {
  const privateUrl = 'postgresql://stockchief:secret@dpg-private-a/stockchief';
  assert.equal(connectionOptions(privateUrl, { privateNetwork: true }).ssl, false);
  assert.throws(() => connectionOptions(`${privateUrl}?sslmode=disable`), /certificate-verified TLS/);
  assert.deepEqual(connectionOptions(`${privateUrl}?sslmode=require`).ssl, { rejectUnauthorized: false });
  assert.deepEqual(connectionOptions(`${privateUrl}?sslmode=verify-full`, { ca: 'trusted-ca' }).ssl,
    { rejectUnauthorized: true, ca: 'trusted-ca' });
});

test('Render commit identity is accepted as the immutable release reference', () => {
  const configPath = path.join(root, 'src', 'config.js').replaceAll('\\', '\\\\');
  const script = `process.env.RENDER_GIT_COMMIT='render-release-123';delete process.env.FOUNDRY_RELEASE_REF;delete process.env.GIT_COMMIT;process.stdout.write(require('${configPath}').operations.releaseRef);`;
  const { execFileSync } = require('node:child_process');
  const release = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(release, 'render-release-123');
});
